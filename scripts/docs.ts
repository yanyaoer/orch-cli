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

export function renderedOutputForSource(source: string): string | undefined {
  const safeSource = normalizeSourcePath(source);
  const extension = extname(safeSource).toLowerCase();
  if (!RENDERED_EXTENSIONS.has(extension)) return undefined;
  if (safeSource === "adr/README.md") return "adr/index.html";
  if (safeSource === "specs/README.md") return "specs/index.html";
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
): string {
  const renderer = new Renderer();
  const slugger = new GithubSlugger();
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

function sectionFor(source: string): "docs" | "adrs" | "specs" | "reviews" | "evidence" {
  if (source.startsWith("adr/")) return "adrs";
  if (source.startsWith("specs/")) return "specs";
  if ([".json", ".txt"].includes(extname(source).toLowerCase())) return "evidence";
  if (source.startsWith("reviews/")) return "reviews";
  return "docs";
}

function navLink(output: string, target: string, label: string, current: boolean): string {
  const currentAttributes = current ? ' class="is-current" aria-current="page"' : "";
  return `<a href="${escapeHtml(relativeSiteUrl(output, target))}"${currentAttributes}>${label}</a>`;
}

function siteNavigation(output: string, current: ReturnType<typeof sectionFor> | "home"): string {
  return `<header class="site-header">
  <nav class="site-nav site-wrap" aria-label="Primary">
    <a class="site-brand" href="${escapeHtml(relativeSiteUrl(output, "index.html"))}"><span>$</span> orch</a>
    <details class="site-menu">
      <summary>Menu</summary>
      <div class="site-nav-links">
        ${navLink(output, "index.html", "Home", current === "home")}
        ${navLink(output, "contents.html", "Docs", current === "docs")}
        ${navLink(output, "adr/index.html", "ADRs", current === "adrs")}
        ${navLink(output, "specs/index.html", "Specs", current === "specs")}
        ${navLink(output, "contents.html#reviews", "Reviews", current === "reviews")}
        ${navLink(output, "contents.html#evidence", "Evidence", current === "evidence")}
        <a href="${GITHUB_URL}">GitHub</a>
      </div>
    </details>
  </nav>
</header>`;
}

function breadcrumb(output: string, source: string | undefined, title: string): string {
  const crumbs = [
    `<li><a href="${escapeHtml(relativeSiteUrl(output, "index.html"))}">Home</a></li>`,
  ];
  if (output !== "contents.html") {
    crumbs.push(`<li><a href="${escapeHtml(relativeSiteUrl(output, "contents.html"))}">Docs</a></li>`);
  }
  if (source?.startsWith("adr/") && output !== "adr/index.html") {
    crumbs.push(`<li><a href="${escapeHtml(relativeSiteUrl(output, "adr/index.html"))}">ADRs</a></li>`);
  } else if (source?.startsWith("specs/") && output !== "specs/index.html") {
    crumbs.push(`<li><a href="${escapeHtml(relativeSiteUrl(output, "specs/index.html"))}">Specs</a></li>`);
  } else if (source?.startsWith("reviews/")) {
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
): string {
  const sourceLink = source
    ? `<p class="source-link"><a href="${escapeHtml(relativeSiteUrl(output, source))}">View raw source</a></p>`
    : "";
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
<body class="docs-page">
  <a class="skip-link" href="#main">Skip to content</a>
  ${siteNavigation(output, current)}
  <main id="main" class="site-main site-wrap">
    ${breadcrumb(output, source, title)}
    <article class="doc-content">
${content}
    </article>
    ${sourceLink}
  </main>
  <footer class="site-footer"><div class="site-wrap">orch-cli · daemonless, file-first orchestration</div></footer>
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
}

function hubSection(output: string, id: string, title: string, items: HubItem[]): string {
  const links = items.length
    ? `<ul>${items
        .map(
          (item) =>
            `<li><a href="${escapeHtml(relativeSiteUrl(output, item.output))}">${escapeHtml(item.title)}</a><code>${escapeHtml(item.source)}</code></li>`,
        )
        .join("")}</ul>`
    : "<p>No documents in this section.</p>";
  return `<section class="hub-section" id="${id}"><h2>${title}</h2>${links}</section>`;
}

async function documentationHub(plan: BuildPlan, sourceRoot: string): Promise<string> {
  const items: HubItem[] = [];
  for (const [source, output] of plan.rendered) {
    const extension = extname(source).toLowerCase();
    const title = extension === ".md"
      ? firstHeading(await readFile(join(sourceRoot, source), "utf8"), basename(source, extension))
      : basename(source);
    items.push({ title, source, output });
  }
  const diagrams = plan.sources
    .filter((source) => extname(source).toLowerCase() === ".html" && source !== "index.html")
    .map((source) => ({ title: source === "sandbox-matchlock-flow.html" ? "matchlock microVM sandbox flow" : basename(source, ".html"), source, output: source }));
  const group = (predicate: (item: HubItem) => boolean) => items.filter(predicate);
  const content = `<header class="hub-intro">
  <p class="eyebrow">Documentation index</p>
  <h1>orch-cli documentation</h1>
  <p>Authored sources stay authoritative; this site provides generated, link-checked HTML views and byte-exact evidence downloads.</p>
</header>
<div class="hub-grid">
  ${hubSection("contents.html", "root-docs", "Root docs", group((item) => posix.dirname(item.source) === "."))}
  ${hubSection("contents.html", "adrs", "Architecture decisions", group((item) => item.source.startsWith("adr/")))}
  ${hubSection("contents.html", "specs", "Specifications", group((item) => item.source.startsWith("specs/")))}
  ${hubSection("contents.html", "reviews", "Reviews", group((item) => item.source.startsWith("reviews/") && extname(item.source) === ".md"))}
  ${hubSection("contents.html", "evidence", "Evidence", group((item) => [".json", ".txt"].includes(extname(item.source))))}
  ${hubSection("contents.html", "diagrams", "Diagrams", diagrams)}
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
        const content = renderMarkdown(markdown, source, output, plan.publicTargets);
        await writeFile(renderedTarget, pageShell(output, title, sectionFor(source), content, source));
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
