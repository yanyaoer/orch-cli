import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSafeOutputTarget,
  buildSite,
  checkSite,
  createBuildPlan,
  getTrackedDocsSources,
  hashManifest,
  hubGroupFor,
  LANGUAGE_SCRIPT,
  siteFooter,
  siteHeader,
  renderMarkdown,
  renderedOutputForSource,
  rewriteRelativeUrl,
} from "./docs.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "orch-docs-test-"));
  temporaryRoots.push(root);
  return root;
}

async function fixture(files: Record<string, string | Uint8Array>) {
  const root = await temporaryRoot();
  const sourceRoot = join(root, "docs");
  for (const [file, contents] of Object.entries(files)) {
    const target = join(sourceRoot, file);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
  return {
    sourceRoot,
    outputRoot: join(root, "dist", "docs-site"),
    sources: Object.keys(files).sort(),
  };
}

describe("documentation inventory and mapping", () => {
  test("covers the current 9 Markdown, 1 JSON, and 2 text sources", async () => {
    const sources = await getTrackedDocsSources();
    expect(sources.filter((source) => source.endsWith(".md"))).toHaveLength(9);
    // adr/ and specs/ stay tracked in the repo but are not published on the site.
    expect(sources.some((source) => source.startsWith("adr/") || source.startsWith("specs/"))).toBe(false);
    expect(sources.filter((source) => source.endsWith(".json"))).toHaveLength(1);
    expect(sources.filter((source) => source.endsWith(".txt"))).toHaveLength(2);
    expect(renderedOutputForSource("orch.md")).toBe("orch.html");
    // A Chinese companion is a raw source only; it renders into its sibling's page.
    expect(renderedOutputForSource("getting-started.zh.md")).toBeUndefined();
    expect(renderedOutputForSource("reviews/README.md")).toBe("reviews/README.html");
    expect(renderedOutputForSource("reviews/audit2-claude-review.json")).toBe("reviews/audit2-claude-review.html");
  });

  test("rejects traversal and every raw/generated/hub collision", () => {
    expect(() => createBuildPlan(["../secret.md"])).toThrow("Unsafe");
    expect(() => createBuildPlan(["guide.md", "guide.html"])).toThrow("collision");
    expect(() => createBuildPlan(["contents.md"])).toThrow("collision");
  });
});

describe("Markdown rendering", () => {
  test("uses GitHub CJK duplicate slugs and renders GFM tables and fences", () => {
    const plan = createBuildPlan(["sample.md"]);
    const html = renderMarkdown(
      "# 标题\n\n## 标题\n\n# 标题\n\n| A | B |\n| - | - |\n| x | y |\n\n```ts\nconst x = '<tag>';\n```\n",
      "sample.md",
      "sample.html",
      plan.publicTargets,
    );
    expect(html).toContain('id="标题"');
    expect(html).toContain('id="标题-1"');
    expect(html).toContain('id="标题-2"');
    expect(html).toContain("<table>");
    expect(html).toContain('class="language-ts"');
    expect(html).toContain("&lt;tag&gt;");
  });

  test("escapes raw HTML and rejects executable URL schemes", () => {
    const plan = createBuildPlan(["sample.md"]);
    const html = renderMarkdown(
      "raw </code><script>alert(1)</script> end",
      "sample.md",
      "sample.html",
      plan.publicTargets,
    );
    expect(html).toContain("&lt;/code&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(() => renderMarkdown("[run](javascript:alert(1))", "sample.md", "sample.html", plan.publicTargets)).toThrow("Unsafe link URL scheme");
    expect(() => renderMarkdown("![run](data:text/html,bad)", "sample.md", "sample.html", plan.publicTargets)).toThrow("Unsafe image URL scheme");
    expect(() => rewriteRelativeUrl(" javascript:alert(1)", "link", "sample.md", "sample.html", plan.publicTargets)).toThrow("Unsafe link URL");
    expect(() => rewriteRelativeUrl("%2e%2e%2fsecret.txt", "link", "sample.md", "sample.html", plan.publicTargets)).toThrow("escapes docs");
  });

  test("rewrites nested links through the source map without root-relative URLs", () => {
    const plan = createBuildPlan([
      "reviews/one.md",
      "reviews/two.md",
      "assets/diagram.png",
      "notes/README.md",
    ]);
    const html = renderMarkdown(
      "[notes](../notes/README.md?mode=full#goal) [peer](two.md#next) ![diagram](../assets/diagram.png?v=1#crop)",
      "reviews/one.md",
      "reviews/one.html",
      plan.publicTargets,
    );
    expect(html).toContain('href="../notes/README.html?mode=full#goal"');
    expect(html).toContain('href="two.html#next"');
    expect(html).toContain('src="../assets/diagram.png?v=1#crop"');
    expect(html).not.toContain('href="/');
  });
});

test("atomic rebuild is deterministic, removes stale files, and preserves evidence bytes", async () => {
  const evidence = new TextEncoder().encode("raw </code><script>alert(1)</script>\nsecond line\n");
  const options = await fixture({
    ".nojekyll": "",
    "assets/site.css": ":root { color-scheme: dark light; }\n",
    "getting-started.md": "# Getting started\n",
    "guide.md": "# Guide\n\n[Start](getting-started.md)\n",
    "index.html": '<!doctype html><html><body><main id="main"><a href="contents.html">Docs</a></main></body></html>\n',
    "reviews/evidence.txt": evidence,
  });

  await buildSite(options);
  const firstManifest = await hashManifest(options.outputRoot);
  await writeFile(join(options.outputRoot, "stale.html"), "stale");
  await buildSite(options);
  const secondManifest = await hashManifest(options.outputRoot);
  expect(secondManifest).toEqual(firstManifest);
  expect(await Bun.file(join(options.outputRoot, "stale.html")).exists()).toBe(false);
  expect(await Bun.file(`${options.outputRoot}.backup-${process.pid}`).exists()).toBe(false);
  expect(new Uint8Array(await readFile(join(options.outputRoot, "reviews/evidence.txt")))).toEqual(evidence);
  const evidenceHtml = await readFile(join(options.outputRoot, "reviews/evidence.html"), "utf8");
  expect(evidenceHtml).toContain("&lt;/code&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(evidenceHtml).not.toContain("</code><script>");
  await checkSite(options);

  const guide = join(options.outputRoot, "guide.html");
  await writeFile(guide, `${await readFile(guide, "utf8")}<a href="missing.html">broken</a>`);
  await expect(checkSite(options)).rejects.toThrow("Broken internal URL");
});

test("a .zh.md companion renders into its sibling's page behind the EN/中文 toggle", async () => {
  const options = await fixture({
    "assets/site.css": ":root { color-scheme: dark light; }\n",
    "guide.md": "# Guide\n\n## Setup\n\n[Start](getting-started.md)\n",
    "guide.zh.md": "# 指南\n\n## Setup\n\n[开始](getting-started.md)\n",
    "getting-started.md": "# Getting started\n",
    "index.html": '<!doctype html><html><body><main id="main"><a href="guide.html">Guide</a></main></body></html>\n',
  });
  await buildSite(options);
  await checkSite(options);
  const files = await hashManifest(options.outputRoot);
  expect(files.some((line) => line.endsWith("  guide.zh.md"))).toBe(true);
  expect(files.some((line) => line.endsWith("  guide.zh.html"))).toBe(false);
  const html = await readFile(join(options.outputRoot, "guide.html"), "utf8");
  expect(html).toContain('<body class="docs-page en">');
  expect(html).toContain('data-set-lang="zh"');
  expect(html).toContain('<div data-lang="en">');
  expect(html).toContain('<div data-lang="zh" lang="zh-CN">');
  expect(html).toContain("<h1 id=\"指南\">");
  // One slugger across both languages: the repeated heading gets a distinct id.
  expect(html).toContain('id="setup"');
  expect(html).toContain('id="setup-1"');
  expect(html).toContain('href="getting-started.html"');
  expect(html).toContain("View raw source (中文)");
  expect(html).toContain('localStorage.getItem("orch-lang")');
  // A page without a companion carries neither toggle nor script.
  const plain = await readFile(join(options.outputRoot, "getting-started.html"), "utf8");
  expect(plain).not.toContain("data-set-lang");
  expect(plain).toContain('<body class="docs-page">');
});

test("cleanup guard rejects traversal and symlinks without touching their targets", async () => {
  const root = await temporaryRoot();
  const expected = join(root, "dist", "docs-site");
  await mkdir(join(root, "dist"), { recursive: true });
  await expect(assertSafeOutputTarget(join(expected, "..", "elsewhere"), expected)).rejects.toThrow("unexpected output path");

  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "marker"), "keep");
  await symlink(outside, expected);
  await expect(assertSafeOutputTarget(expected, expected)).rejects.toThrow("Output path is a symlink");
  expect(await readFile(join(outside, "marker"), "utf8")).toBe("keep");
});

test("hand-written pages carry the exact shared header and footer", async () => {
  const docsRoot = join(import.meta.dir, "..", "docs");
  const index = await readFile(join(docsRoot, "index.html"), "utf8");
  expect(index).toContain(siteHeader("index.html", "home", true));
  expect(index).toContain(siteFooter());
  expect(index).toContain(LANGUAGE_SCRIPT);
  expect(index).toContain('<body class="landing en">');
  expect(index).toContain('<link rel="stylesheet" href="assets/site.css">');
  // One stylesheet: no inline styles and no <details> nav on the landing page.
  expect(index).not.toContain("<style");
  expect(index).not.toContain("<details");
  // The diagram page keeps its own tool styles but shares the frame.
  const diagram = await readFile(join(docsRoot, "sandbox-matchlock-flow.html"), "utf8");
  expect(diagram).toContain(siteHeader("sandbox-matchlock-flow.html", "docs"));
  expect(diagram).toContain(siteFooter());
  expect(diagram).toContain('<link rel="stylesheet" href="assets/site.css">');
  expect(diagram).not.toContain('<details class="site-menu">');
  // The shared header renders its links directly (a closed <details> would hide them).
  expect(siteHeader("reviews/one.html", "reviews")).toContain('<a href="../getting-started.html">Getting started</a>');
  expect(siteHeader("reviews/one.html", "reviews")).not.toContain("<details");
});

test("the hub groups pages by the content map and links the README instead of copying it", async () => {
  expect(hubGroupFor("getting-started.md")).toBe("start");
  expect(hubGroupFor("orch.md")).toBe("start");
  expect(hubGroupFor("sandbox-design.md")).toBe("design");
  expect(hubGroupFor("multi-agent.md")).toBe("archive");
  expect(hubGroupFor("orch-mvp-spec.md")).toBe("archive");
  expect(hubGroupFor("reviews/x.md")).toBe("reviews");
  expect(hubGroupFor("reviews/x.json")).toBe("evidence");
  expect(hubGroupFor("flow.html")).toBe("diagrams");
  expect(hubGroupFor("something-new.md")).toBe("docs");

  const options = await fixture({
    "assets/site.css": "",
    "getting-started.md": "# Getting started\n",
    "orch.md": "# orch quick reference\n",
    "multi-agent.md": "# Old design\n",
    "something-new.md": "# New page\n",
    "reviews/round-1.md": "# Round 1\n",
    "index.html": '<!doctype html><html><body><main id="main"><a href="contents.html">Docs</a></main></body></html>\n',
  });
  await buildSite(options);
  await checkSite(options);
  const hub = await readFile(join(options.outputRoot, "contents.html"), "utf8");
  const order = ["Start here", "Reviews", "Docs", "Archive"].map((title) => hub.indexOf(`<h2>${title}</h2>`));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(hub).not.toContain("<h2>Design</h2>"); // empty groups are omitted
  expect(hub).not.toContain("No documents in this section");
  expect(hub).toContain('<span class="hub-lang">EN · 中文</span>');
  expect(hub).toContain("Historical context only.");
  expect(hub).toContain('href="https://github.com/yanyaoer/orch-cli#readme">README (reference)</a>');
  // Section order in the hub: Start here first, Archive last.
  expect(hub.indexOf('id="start"')).toBeLessThan(hub.indexOf('id="archive"'));
});
