import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBundle,
  isImportantFile,
  languageForPath,
  parseChangedFiles,
  rankCandidates,
  redactSensitiveText,
  truncateText,
  unique,
} from "./handoff-pro.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function worktree(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "orch-bundle-")));
  tempDirs.push(dir);
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, "package.json"), '{"name":"demo"}\n');
  writeFileSync(join(dir, ".env"), "API_KEY=supersecretvalue1234567890\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "main.ts"), "export const x = 1;\n");
  return dir;
}

test("parseChangedFiles parses git status --short and dedupes", () => {
  const status = ["## main...origin/main", " M src/a.ts", "?? src/b.ts", "R  old.ts -> new.ts", " M src/a.ts"].join("\n");
  expect(parseChangedFiles(status)).toEqual(["src/a.ts", "src/b.ts", "new.ts"]);
});

test("parseChangedFiles ignores git-unavailable and empty input", () => {
  expect(parseChangedFiles("(git unavailable: not a repo)")).toEqual([]);
  expect(parseChangedFiles("")).toEqual([]);
});

test("rankCandidates dedupes, sorts important first, drops own output, caps", () => {
  const ranked = rankCandidates(
    ["src/z.ts", "README.md", "src/z.ts", ".ai-bridge/pro-context.md", "package.json", "src/a.ts"],
    3,
  );
  // README.md + package.json are important → first (alphabetical); output dropped; capped at 3.
  expect(ranked).toEqual(["package.json", "README.md", "src/a.ts"]);
});

test("unique normalizes leading ./ and filters empties", () => {
  expect(unique(["./a.ts", "a.ts", "", "b/c.ts"])).toEqual(["a.ts", "b/c.ts"]);
});

test("languageForPath maps extensions, defaults to text", () => {
  expect(languageForPath("a.ts")).toBe("typescript");
  expect(languageForPath("a.py")).toBe("python");
  expect(languageForPath("a.unknown")).toBe("text");
});

test("isImportantFile matches root names and basenames", () => {
  expect(isImportantFile("package.json")).toBe(true);
  expect(isImportantFile("nested/README.md")).toBe(true);
  expect(isImportantFile("src/main.ts")).toBe(false);
});

test("truncateText caps long text and flags truncation", () => {
  expect(truncateText("hello", 10)).toEqual({ text: "hello", truncated: false });
  const out = truncateText("0123456789", 4);
  expect(out.truncated).toBe(true);
  expect(out.text.startsWith("0123")).toBe(true);
});

test("redactSensitiveText masks inline secrets only", () => {
  expect(redactSensitiveText('api_key = "abcdef1234567890XYZ"')).toBe('api_key = "***REDACTED***"');
  expect(redactSensitiveText("token=ABCDEFGHIJKLMNOPQRST")).toBe("token=***REDACTED***");
  // Short values are left alone.
  expect(redactSensitiveText("password=short")).toBe("password=short");
});

test("buildBundle embeds key files, includes core sections, excludes .env", async () => {
  const root = worktree();
  const result = await buildBundle({ worktree: root });
  expect(result.filesIncluded).toContain("README.md");
  expect(result.filesIncluded).toContain("package.json");
  expect(result.markdown).toContain("## Repository Tree");
  expect(result.markdown).toContain("## Git Status");
  expect(result.markdown).toContain("## File Contents");
  // .env must never leak into the bundle.
  expect(result.markdown).not.toContain("supersecretvalue1234567890");
  expect(result.bytes).toBe(Buffer.byteLength(result.markdown, "utf8"));
});

test("buildBundle honors --path selection and per-file SHA", async () => {
  const root = worktree();
  const result = await buildBundle({
    worktree: root,
    includeImportantFiles: false,
    includeChangedFiles: false,
    includeDiff: false,
    selectedPaths: ["src/main.ts"],
  });
  expect(result.filesIncluded).toEqual(["src/main.ts"]);
  expect(result.markdown).toContain("### src/main.ts");
  expect(result.markdown).toContain("SHA-256:");
});

test("buildBundle skips blocked paths into filesSkipped", async () => {
  const root = worktree();
  const result = await buildBundle({
    worktree: root,
    includeImportantFiles: false,
    includeChangedFiles: false,
    includeDiff: false,
    selectedPaths: [".env"],
  });
  expect(result.filesIncluded).toEqual([]);
  expect(result.filesSkipped.some((entry) => entry.startsWith(".env"))).toBe(true);
});
