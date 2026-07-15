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
  test("covers the current 10 Markdown, 1 JSON, and 2 text sources", async () => {
    const sources = await getTrackedDocsSources();
    expect(sources.filter((source) => source.endsWith(".md"))).toHaveLength(10);
    expect(sources.filter((source) => source.endsWith(".json"))).toHaveLength(1);
    expect(sources.filter((source) => source.endsWith(".txt"))).toHaveLength(2);
    expect(renderedOutputForSource("orch.md")).toBe("orch.html");
    expect(renderedOutputForSource("adr/README.md")).toBe("adr/index.html");
    expect(renderedOutputForSource("specs/README.md")).toBe("specs/index.html");
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
      "adr/one.md",
      "adr/two.md",
      "assets/diagram.png",
      "specs/README.md",
    ]);
    const html = renderMarkdown(
      "[spec](../specs/README.md?mode=full#goal) [peer](two.md#next) ![diagram](../assets/diagram.png?v=1#crop)",
      "adr/one.md",
      "adr/one.html",
      plan.publicTargets,
    );
    expect(html).toContain('href="../specs/index.html?mode=full#goal"');
    expect(html).toContain('href="two.html#next"');
    expect(html).toContain('src="../assets/diagram.png?v=1#crop"');
    expect(html).not.toContain('href="/');
  });
});

test("atomic rebuild is deterministic, removes stale files, and preserves evidence bytes", async () => {
  const evidence = new TextEncoder().encode("raw </code><script>alert(1)</script>\nsecond line\n");
  const options = await fixture({
    ".nojekyll": "",
    "adr/README.md": "# ADRs\n",
    "assets/site.css": ":root { color-scheme: dark light; }\n",
    "guide.md": "# Guide\n\n[ADRs](adr/README.md)\n",
    "index.html": '<!doctype html><html><body><main id="main"><a href="contents.html">Docs</a></main></body></html>\n',
    "reviews/evidence.txt": evidence,
    "specs/README.md": "# Specs\n",
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
