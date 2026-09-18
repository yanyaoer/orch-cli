import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, posix, resolve } from "node:path";
import GithubSlugger from "github-slugger";
import { marked, Parser, Renderer, TextRenderer, type Tokens } from "marked";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DOCS_ROOT = join(REPO_ROOT, "docs");
const DIST_ROOT = join(REPO_ROOT, "dist");
export const OUTPUT_ROOT = join(DIST_ROOT, "docs-site");

const RENDERED_EXTENSIONS = new Set([".md", ".json", ".txt"]);
// Tracked under docs/ but not published on the site (no page, no raw copy, no
// hub entry): kept in the repo for GitHub readers until there is content
// worth binding a run to. Remove a prefix here to publish it again.
export const UNPUBLISHED_SOURCE_PREFIXES: readonly string[] = ["adr/", "specs/"];
const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);
const GITHUB_URL = "https://github.com/yanyaoer/orch-cli";

export interface BuildPlan {
  sources: string[];
  rendered: Map<string, string>;
  publicTargets: Map<string, string>;
}

export interface SiteOptions {
  sourceRoot: string;
  outputRoot: string;
  sources: string[];
}

function normalizeSourcePath(source: string): string {
  if (!source || source.includes("\0") || source.includes("\\") || posix.isAbsolute(source)) {
    throw new Error(`Unsafe documentation source path: ${JSON.stringify(source)}`);
  }
  const normalized = posix.normalize(source);
  if (normalized === ".." || normalized.startsWith("../") || normalized !== source) {
    throw new Error(`Unsafe documentation source path: ${JSON.stringify(source)}`);
  }
  return normalized;
}

// `<page>.zh.md` is the Chinese companion of `<page>.md`: it is copied raw
// like every source but rendered into its sibling's page behind the same
// EN/中文 toggle the home page uses, never as a page of its own.
export function companionSource(source: string): string {
  return source.replace(/\.md$/, ".zh.md");
}

export function isCompanionSource(source: string): boolean {
  return source.endsWith(".zh.md");
}

export function renderedOutputForSource(source: string): string | undefined {
  const safeSource = normalizeSourcePath(source);
  const extension = extname(safeSource).toLowerCase();
  if (!RENDERED_EXTENSIONS.has(extension)) return undefined;
  if (isCompanionSource(safeSource)) return undefined;
  return `${safeSource.slice(0, -extension.length)}.html`;
}

export function createBuildPlan(inputSources: string[]): BuildPlan {
  const sources = [...new Set(inputSources.map(normalizeSourcePath))].sort();
  if (sources.length !== inputSources.length) {
    throw new Error("Duplicate documentation source path");
  }

  const claims = new Map<string, string>();
  const rendered = new Map<string, string>();
  const publicTargets = new Map<string, string>();
  const claim = (output: string, owner: string) => {
    const previous = claims.get(output);
    if (previous) throw new Error(`Documentation output collision at ${output}: ${previous} and ${owner}`);
    claims.set(output, owner);
  };

  for (const source of sources) {
    claim(source, `raw source ${source}`);
    const output = renderedOutputForSource(source);
    if (output) {
      claim(output, `rendered source ${source}`);
      rendered.set(source, output);
      publicTargets.set(source, output);
    } else {
      publicTargets.set(source, source);
    }
  }
  claim("contents.html", "documentation hub");
  return { sources, rendered, publicTargets };
}

export async function getTrackedDocsSources(): Promise<string[]> {
  const child = Bun.spawn(["git", "ls-files", "-z", "--", "docs"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ls-files failed: ${stderr.trim()}`);
  const sources = stdout
    .split("\0")
    .filter(Boolean)
    .map((file) => normalizeSourcePath(file.slice("docs/".length)))
    .filter((source) => !UNPUBLISHED_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix)))
    .sort();
  // This asset is part of this change before it can be committed; after commit it is already listed above.
  if (!sources.includes("assets/site.css") && await Bun.file(join(DOCS_ROOT, "assets/site.css")).exists()) {
    sources.push("assets/site.css");
  }
  return sources.sort();
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function splitUrl(value: string): { path: string; suffix: string } {
  const match = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(value);
  if (!match) return { path: value, suffix: "" };
  return { path: match[1] ?? "", suffix: `${match[2] ?? ""}${match[3] ?? ""}` };
}

function validateUrl(value: string, kind: "link" | "image"): "external" | "relative" {
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value) || value.includes("\\")) {
    throw new Error(`Unsafe ${kind} URL: ${JSON.stringify(value)}`);
  }
  if (value.startsWith("//")) return "external";
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (!scheme) return "relative";
  if (!SAFE_SCHEMES.has(scheme) || (kind === "image" && scheme === "mailto")) {
    throw new Error(`Unsafe ${kind} URL scheme: ${scheme}`);
  }
  return "external";
}

function relativeSiteUrl(fromOutput: string, toOutput: string, suffix = ""): string {
  const targetUrl = splitUrl(toOutput);
  const target = posix.relative(posix.dirname(fromOutput), targetUrl.path) || posix.basename(targetUrl.path);
  const encoded = target.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `${encoded}${targetUrl.suffix}${suffix}`;
}

export function rewriteRelativeUrl(
  value: string,
  kind: "link" | "image",
  source: string,
  output: string,
  publicTargets: ReadonlyMap<string, string>,
): string {
  const disposition = validateUrl(value, kind);
  if (disposition === "external" || value.startsWith("#") || value.startsWith("?")) return value;
  if (value.startsWith("/")) {
    throw new Error(`Root-relative ${kind} URL is not project-path safe: ${value}`);
  }

  const { path, suffix } = splitUrl(value);
  if (!path) return value;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    throw new Error(`Invalid encoded ${kind} URL: ${value}`);
  }
  const target = posix.normalize(posix.join(posix.dirname(source), decodedPath));
  if (target === ".." || target.startsWith("../")) {
    throw new Error(`${kind} URL escapes docs/: ${value}`);
  }

  const candidates = [target];
  if (path.endsWith("/")) candidates.unshift(posix.join(target, "README.md"));
  if (!extname(target)) candidates.push(`${target}.md`, posix.join(target, "README.md"));
  const mappedSource = candidates.find((candidate) => publicTargets.has(candidate));
  const targetOutput = mappedSource ? publicTargets.get(mappedSource)! : target;
  return relativeSiteUrl(output, targetOutput, suffix);
}

function plainHeadingText(tokens: Tokens.Generic[]): string {
  return new Parser().parseInline(tokens, new TextRenderer());
}

function firstHeading(markdown: string, fallback: string): string {
  const heading = marked.lexer(markdown, { gfm: true }).find((token) => token.type === "heading") as
    | Tokens.Heading
    | undefined;
  return heading ? plainHeadingText(heading.tokens) : fallback;
}

export function renderMarkdown(
  markdown: string,
  source: string,
  output: string,
  publicTargets: ReadonlyMap<string, string>,
  // One slugger across both languages of a page keeps heading ids unique.
  slugger: GithubSlugger = new GithubSlugger(),
): string {
  const renderer = new Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const plain = this.parser.parseInline(tokens, new TextRenderer());
    const id = slugger.slug(plain);
    return `<h${depth} id="${escapeHtml(id)}">${text}<a class="heading-anchor" href="#${escapeHtml(id)}" aria-label="Link to this heading">#</a></h${depth}>\n`;
  };
  renderer.link = function ({ href, title, tokens }) {
    const safeHref = rewriteRelativeUrl(href, "link", source, output, publicTargets);
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(safeHref)}"${titleAttribute}>${this.parser.parseInline(tokens)}</a>`;
  };
  renderer.image = ({ href, title, text }) => {
    const safeHref = rewriteRelativeUrl(href, "image", source, output, publicTargets);
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}"${titleAttribute}>`;
  };
  return marked.parse(markdown, { renderer, gfm: true, breaks: false, async: false }) as string;
}

function sectionFor(source: string): "docs" | "reviews" | "evidence" {
  if ([".json", ".txt"].includes(extname(source).toLowerCase())) return "evidence";
  if (source.startsWith("reviews/")) return "reviews";
  return "docs";
}

function navLink(output: string, target: string, label: string, current: boolean): string {
  const currentAttributes = current ? ' class="is-current" aria-current="page"' : "";
  return `<a href="${escapeHtml(relativeSiteUrl(output, target))}"${currentAttributes}>${label}</a>`;
}

function languageToggle(): string {
  return `<div class="lang" aria-label="Language">
        <button type="button" class="active" data-set-lang="en">EN</button>
        <button type="button" data-set-lang="zh">中文</button>
      </div>`;
}

// Same behaviour as the home page: body.en/body.zh gates [data-lang] blocks,
// the choice persists in localStorage under the key the home page uses.
export const LANGUAGE_SCRIPT = `<script>
    const root = document.body;
    const buttons = Array.from(document.querySelectorAll("[data-set-lang]"));
    function setLang(lang) {
      root.classList.toggle("zh", lang === "zh");
      root.classList.toggle("en", lang !== "zh");
      document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
      buttons.forEach((button) => {
        button.classList.toggle("active", button.dataset.setLang === lang);
      });
      localStorage.setItem("orch-lang", lang);
    }
    buttons.forEach((button) => {
      button.addEventListener("click", () => setLang(button.dataset.setLang));
    });
    const saved = localStorage.getItem("orch-lang");
    if (saved === "zh" || saved === "en") setLang(saved);
  </script>`;

// The one header for every page. index.html (a raw source) must carry this
// exact markup for output "index.html" — a docs test enforces it — so the
// landing page and the generated pages can never drift apart. No <details>
// wrapper: a closed <details> hides its content regardless of CSS, which is
// how the desktop nav went missing before; the links simply wrap on phones.
export function siteHeader(output: string, current: ReturnType<typeof sectionFor> | "home", bilingual = false): string {
  return `<header class="site-header">
  <nav class="site-nav site-wrap" aria-label="Primary">
    <a class="site-brand" href="${escapeHtml(relativeSiteUrl(output, "index.html"))}"><span>$</span> orch</a>
    <div class="site-nav-links">
      ${navLink(output, "index.html", "Home", current === "home")}
      ${navLink(output, "contents.html", "Docs", current === "docs" || current === "reviews" || current === "evidence")}
      ${navLink(output, "getting-started.html", "Getting started", false)}
      <a href="${GITHUB_URL}">GitHub</a>
      ${bilingual ? languageToggle() : ""}
    </div>
  </nav>
</header>`;
}

export function siteFooter(): string {
  return `<footer class="site-footer">
  <div class="site-wrap">
    <a href="${GITHUB_URL}">github.com/yanyaoer/orch-cli</a>
    <span>state lives in \${XDG_STATE_HOME:-~/.local/state}/orch</span>
    <span>no daemon · no queue · just files</span>
  </div>
</footer>`;
}

function breadcrumb(output: string, source: string | undefined, title: string): string {
  const crumbs = [
    `<li><a href="${escapeHtml(relativeSiteUrl(output, "index.html"))}">Home</a></li>`,
  ];
  if (output !== "contents.html") {
    crumbs.push(`<li><a href="${escapeHtml(relativeSiteUrl(output, "contents.html"))}">Docs</a></li>`);
  }
  if (source?.startsWith("reviews/")) {
    const anchor = [".json", ".txt"].includes(extname(source)) ? "#evidence" : "#reviews";
    crumbs.push(`<li><a href="${escapeHtml(relativeSiteUrl(output, `contents.html${anchor}`))}">${anchor === "#evidence" ? "Evidence" : "Reviews"}</a></li>`);
  }
  crumbs.push(`<li aria-current="page">${escapeHtml(title)}</li>`);
  return `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>${crumbs.join("")}</ol></nav>`;
}

function pageShell(
  output: string,
  title: string,
  current: ReturnType<typeof sectionFor>,
  content: string,
  source?: string,
  companion?: string,
): string {
  const sourceLinks = [source, companion]
    .filter((path): path is string => Boolean(path))
    .map((path) => `<a href="${escapeHtml(relativeSiteUrl(output, path))}">${path === companion ? "View raw source (中文)" : "View raw source"}</a>`);
  const sourceLink = sourceLinks.length ? `<p class="source-link">${sourceLinks.join(" · ")}</p>` : "";
  const bilingual = Boolean(companion);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta name="description" content="orch-cli documentation: ${escapeHtml(title)}">
  <title>${escapeHtml(title)} · orch-cli docs</title>
  <link rel="stylesheet" href="${escapeHtml(relativeSiteUrl(output, "assets/site.css"))}">
</head>
<body class="docs-page${bilingual ? " en" : ""}">
  <a class="skip-link" href="#main">Skip to content</a>
  ${siteHeader(output, current, bilingual)}
  <main id="main" class="site-main site-wrap">
    ${breadcrumb(output, source, title)}
    <article class="doc-content">
${content}
    </article>
    ${sourceLink}
  </main>
  ${siteFooter()}
  ${bilingual ? LANGUAGE_SCRIPT : ""}
</body>
</html>
`;
}

function evidencePage(source: string, output: string, bytes: Uint8Array): string {
  const title = basename(source);
  const decoded = new TextDecoder().decode(bytes);
  const content = `<h1>${escapeHtml(title)}</h1>
<p class="evidence-note">Verbatim evidence. The raw source link is byte-exact.</p>
<pre class="evidence"><code>${escapeHtml(decoded)}</code></pre>`;
  return pageShell(output, title, "evidence", content, source);
}

interface HubItem {
  title: string;
  source: string;
  output: string;
  description?: string;
  lang?: string;
  external?: boolean;
}

// Content map for the root-level docs: which group a page belongs to, what it
// is for, and its language. Pages under reviews/ are grouped by path; a root
// page missing here lands in "Docs" so nothing is ever hidden.
// The same map is written out in prose in README.md ("Documentation map").
export const DOC_MAP: Record<string, { group: "start" | "design" | "archive"; description: string; lang: string }> = {
  "getting-started.md": { group: "start", description: "First run, per-role defaults, custom providers, the author's daily loops.", lang: "EN · 中文" },
  "orch.md": { group: "start", description: "Agent-facing quick reference: intent → command. ~/.agents/orch.md symlinks here.", lang: "EN" },
  "sandbox-design.md": { group: "design", description: "macOS Seatbelt write jail (seatbelt-v1): what is confined, what is not, and why.", lang: "中文" },
  "orch-mvp-spec.md": { group: "archive", description: "The v2 MVP spec this repository implements; kept for the constraints and acceptance list.", lang: "中文" },
  "multi-agent.md": { group: "archive", description: "The earlier tmux + GitLab MR design that orch replaced. Historical context only.", lang: "中文" },
};

export const HUB_GROUPS: Array<{ id: string; title: string }> = [
  { id: "start", title: "Start here" },
  { id: "design", title: "Design" },
  { id: "reviews", title: "Reviews" },
  { id: "evidence", title: "Evidence" },
  { id: "diagrams", title: "Diagrams" },
  { id: "docs", title: "Docs" },
  { id: "archive", title: "Archive" },
];

export function hubGroupFor(source: string): string {
  const mapped = DOC_MAP[source];
  if (mapped) return mapped.group;
  if ([".json", ".txt"].includes(extname(source).toLowerCase())) return "evidence";
  if (source.startsWith("reviews/")) return "reviews";
  if (extname(source).toLowerCase() === ".html") return "diagrams";
  return "docs";
}

function hubSection(output: string, id: string, title: string, items: HubItem[]): string {
  if (items.length === 0) return "";
  const links = items
    .map((item) => {
      const href = item.external ? item.output : relativeSiteUrl(output, item.output);
      const lang = item.lang ? `<span class="hub-lang">${escapeHtml(item.lang)}</span>` : "";
      const description = item.description ? `<p>${escapeHtml(item.description)}</p>` : "";
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(item.title)}</a>${lang}${description}<code>${escapeHtml(item.source)}</code></li>`;
    })
    .join("");
  return `<section class="hub-section" id="${id}"><h2>${title}</h2><ul>${links}</ul></section>`;
}

async function documentationHub(plan: BuildPlan, sourceRoot: string): Promise<string> {
  const items: HubItem[] = [];
  for (const [source, output] of plan.rendered) {
    const extension = extname(source).toLowerCase();
    const title = extension === ".md"
      ? firstHeading(await readFile(join(sourceRoot, source), "utf8"), basename(source, extension))
      : basename(source);
    items.push({ title, source, output, ...DOC_MAP[source] });
  }
  for (const source of plan.sources) {
    if (extname(source).toLowerCase() !== ".html" || source === "index.html") continue;
    items.push({ title: source === "sandbox-matchlock-flow.html" ? "matchlock microVM sandbox flow" : basename(source, ".html"), source, output: source });
  }
  // The README is the reference and lives outside docs/: link it, do not copy it.
  items.push({
    title: "README (reference)",
    source: "README.md on GitHub",
    output: `${GITHUB_URL}#readme`,
    external: true,
    description: "Install, commands, mail bus, mailctl, safety model, result contract. The place for details.",
    lang: "EN",
  });
  const sections = HUB_GROUPS.map((group) => {
    const members = items.filter((item) => (item.external ? group.id === "start" : hubGroupFor(item.source) === group.id));
    return hubSection("contents.html", group.id, group.title, members);
  }).filter(Boolean);
  const content = `<header class="hub-intro">
  <p class="eyebrow">Documentation index</p>
  <h1>orch-cli documentation</h1>
  <p>README on GitHub is the reference; this site is the landing page plus every file under docs/ rendered as-is and link-checked. Pages with a Chinese companion carry the EN/中文 toggle.</p>
</header>
<div class="hub-grid">
  ${sections.join("\n  ")}
</div>`;
  return pageShell("contents.html", "Documentation", "docs", content);
}

async function assertRegularSource(sourceRoot: string, source: string): Promise<void> {
  const status = await lstat(join(sourceRoot, source));
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`Documentation source must be a regular file: ${source}`);
  }
}

export async function assertSafeOutputTarget(target: string, expected: string): Promise<void> {
  if (resolve(target) !== resolve(expected) || basename(resolve(target)) !== "docs-site") {
    throw new Error(`Refusing to clean unexpected output path: ${target}`);
  }
  const parent = dirname(resolve(target));
  try {
    if ((await lstat(parent)).isSymbolicLink()) throw new Error(`Output parent is a symlink: ${parent}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error(`Output path is a symlink: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function buildSite(options: SiteOptions): Promise<BuildPlan> {
  const sourceRoot = resolve(options.sourceRoot);
  const outputRoot = resolve(options.outputRoot);
  const plan = createBuildPlan(options.sources);
  await assertSafeOutputTarget(outputRoot, options.outputRoot);
  await mkdir(dirname(outputRoot), { recursive: true });
  const staging = await mkdtemp(join(dirname(outputRoot), `.docs-site-stage-${process.pid}-`));
  try {
    for (const source of plan.sources) {
      await assertRegularSource(sourceRoot, source);
      const bytes = await readFile(join(sourceRoot, source));
      const rawTarget = join(staging, source);
      await mkdir(dirname(rawTarget), { recursive: true });
      await writeFile(rawTarget, bytes);

      const output = plan.rendered.get(source);
      if (!output) continue;
      const renderedTarget = join(staging, output);
      await mkdir(dirname(renderedTarget), { recursive: true });
      if (extname(source).toLowerCase() === ".md") {
        const markdown = new TextDecoder().decode(bytes);
        const title = firstHeading(markdown, basename(source, ".md"));
        const companion = plan.sources.includes(companionSource(source)) ? companionSource(source) : undefined;
        if (companion) {
          await assertRegularSource(sourceRoot, companion);
          const slugger = new GithubSlugger();
          const en = renderMarkdown(markdown, source, output, plan.publicTargets, slugger);
          const zh = renderMarkdown(await readFile(join(sourceRoot, companion), "utf8"), source, output, plan.publicTargets, slugger);
          const content = `<div data-lang="en">\n${en}</div>\n<div data-lang="zh" lang="zh-CN">\n${zh}</div>`;
          await writeFile(renderedTarget, pageShell(output, title, sectionFor(source), content, source, companion));
        } else {
          const content = renderMarkdown(markdown, source, output, plan.publicTargets);
          await writeFile(renderedTarget, pageShell(output, title, sectionFor(source), content, source));
        }
      } else {
        await writeFile(renderedTarget, evidencePage(source, output, bytes));
      }
    }
    await writeFile(join(staging, "contents.html"), await documentationHub(plan, sourceRoot));

    await assertSafeOutputTarget(outputRoot, options.outputRoot);
    const backup = `${outputRoot}.backup-${process.pid}`;
    await rm(backup, { recursive: true, force: true });
    let previousMoved = false;
    try {
      await rename(outputRoot, backup);
      previousMoved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, outputRoot);
    } catch (error) {
      if (previousMoved) await rename(backup, outputRoot);
      throw error;
    }
    if (previousMoved) await rm(backup, { recursive: true, force: true });
    return plan;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

async function filesBelow(root: string, directory = ""): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const child = directory ? posix.join(directory, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Generated artifact contains a symlink: ${child}`);
    if (entry.isDirectory()) result.push(...await filesBelow(root, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

export async function hashManifest(root: string): Promise<string[]> {
  const files = await filesBelow(root);
  return Promise.all(files.map(async (file) => {
    const digest = createHash("sha256").update(await readFile(join(root, file))).digest("hex");
    return `${digest}  ${file}`;
  }));
}

function htmlAttributes(html: string, names: string[]): string[] {
  const pattern = new RegExp(`\\s(?:${names.join("|")})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "gi");
  return [...html.matchAll(/<[^>]+>/gs)].flatMap((tag) =>
    [...tag[0].matchAll(pattern)].map((match) => decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? "")),
  );
}

export async function checkSite(options: SiteOptions): Promise<void> {
  const outputRoot = resolve(options.outputRoot);
  const plan = createBuildPlan(options.sources);
  const files = new Set(await filesBelow(outputRoot));
  if (!files.has("contents.html")) throw new Error("Missing documentation hub: contents.html");
  const expectedFiles = new Set(["contents.html", ...plan.sources, ...plan.rendered.values()]);
  for (const file of files) {
    if (!expectedFiles.has(file)) throw new Error(`Unexpected generated artifact: ${file}`);
  }

  for (const source of plan.sources) {
    if (!files.has(source)) throw new Error(`Missing raw documentation source: ${source}`);
    const output = plan.rendered.get(source);
    if (output && !files.has(output)) throw new Error(`Missing rendered documentation page: ${output}`);
    const [sourceBytes, copiedBytes] = await Promise.all([
      readFile(join(options.sourceRoot, source)),
      readFile(join(outputRoot, source)),
    ]);
    if (!sourceBytes.equals(copiedBytes)) throw new Error(`Raw source copy differs: ${source}`);
  }

  for (const page of [...files].filter((file) => extname(file).toLowerCase() === ".html").sort()) {
    const html = await readFile(join(outputRoot, page), "utf8");
    const ids = new Set(htmlAttributes(html, ["id"]));
    for (const url of htmlAttributes(html, ["href", "src"])) {
      if (!url) continue;
      const disposition = validateUrl(url, url.startsWith("data:") ? "image" : "link");
      if (disposition === "external") continue;
      const { path, suffix } = splitUrl(url);
      const fragment = suffix.includes("#") ? suffix.slice(suffix.indexOf("#") + 1) : "";
      let decodedPath: string;
      let decodedFragment: string;
      try {
        decodedPath = decodeURIComponent(path);
        decodedFragment = decodeURIComponent(fragment);
      } catch {
        throw new Error(`Invalid URL encoding in ${page}: ${url}`);
      }
      let target = path ? posix.normalize(posix.join(posix.dirname(page), decodedPath)) : page;
      if (target === ".." || target.startsWith("../") || posix.isAbsolute(target)) {
        throw new Error(`Internal URL escapes the artifact in ${page}: ${url}`);
      }
      if (files.has(`${target}/index.html`)) target = `${target}/index.html`;
      if (!files.has(target)) throw new Error(`Broken internal URL in ${page}: ${url}`);
      if (fragment && extname(target).toLowerCase() === ".html") {
        const targetHtml = target === page ? html : await readFile(join(outputRoot, target), "utf8");
        const targetIds = target === page ? ids : new Set(htmlAttributes(targetHtml, ["id"]));
        if (!targetIds.has(decodedFragment)) {
          throw new Error(`Broken fragment in ${page}: ${url}`);
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "build";
  const sources = await getTrackedDocsSources();
  const options = { sourceRoot: DOCS_ROOT, outputRoot: OUTPUT_ROOT, sources };
  if (command === "build") {
    const plan = await buildSite(options);
    console.log(`Built ${plan.rendered.size} generated pages plus contents.html in dist/docs-site`);
  } else if (command === "check") {
    await checkSite(options);
    console.log(`Checked ${planCount(sources)} rendered sources and all internal links`);
  } else {
    throw new Error(`Usage: bun run scripts/docs.ts [build|check]`);
  }
}

function planCount(sources: string[]): number {
  return createBuildPlan(sources).rendered.size;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
