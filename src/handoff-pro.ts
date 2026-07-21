// Export a self-contained markdown context bundle for high-context models that
// cannot call MCP tools (e.g. ChatGPT Pro reasoning). Reuses the bridge's
// resolveSafePath/run guards so the bundle can never leak .env, keys, .git, etc.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { resolveSafePath, run } from "../drivers/chatgpt-bridge.ts";
import { sha256 } from "./hash.ts";
import { vcsKind } from "./vcs.ts";

export interface BundleOptions {
  worktree: string;
  title?: string;
  selectedPaths?: string[];
  extraGlobs?: string[];
  includeImportantFiles?: boolean;
  includeChangedFiles?: boolean;
  includeDiff?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  maxDiffBytes?: number;
  maxTotalBytes?: number;
}

export interface BundleResult {
  markdown: string;
  bytes: number;
  filesIncluded: string[];
  filesSkipped: string[];
  truncated: boolean;
}

export const BUNDLE_REL_PATH = ".ai-bridge/pro-context.md";

const DEFAULTS = {
  maxFiles: 24,
  maxFileBytes: 60_000,
  maxDiffBytes: 80_000,
  maxTotalBytes: 700_000,
};

// Root files worth auto-including when present; they orient a reader fast.
const IMPORTANT_ROOT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "bun.lock",
  "deno.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
];

function normalizeRel(value: string): string {
  return value.split("\\").join("/").replace(/^\.\//, "").trim();
}

export function unique(values: string[]): string[] {
  return [...new Set(values.map(normalizeRel).filter(Boolean))];
}

export function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

// Parse `git status --short` output into a deduped list of changed file paths.
export function parseChangedFiles(status: string): string[] {
  const files: string[] = [];
  for (const rawLine of status.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("##") || line.startsWith("fatal:") || line.startsWith("(git unavailable")) continue;
    if (line.length < 4) continue;
    let rel = line.slice(3).trim();
    if (!rel) continue;
    if (rel.includes(" -> ")) rel = rel.split(" -> ").pop() ?? rel; // renames: keep the new path
    if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
    files.push(rel);
  }
  return unique(files);
}

export function languageForPath(relPath: string): string {
  const ext = extname(relPath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".json" || ext === ".jsonc") return "json";
  if (ext === ".md") return "markdown";
  if (ext === ".css") return "css";
  if (ext === ".html") return "html";
  if (ext === ".py") return "python";
  if (ext === ".rs") return "rust";
  if (ext === ".go") return "go";
  if (ext === ".toml") return "toml";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".sh") return "bash";
  return "text";
}

export function isImportantFile(relPath: string): boolean {
  const base = relPath.split("/").pop() ?? relPath;
  return IMPORTANT_ROOT_FILES.includes(relPath) || IMPORTANT_ROOT_FILES.includes(base);
}

// Dedupe, sort (important files first, then alphabetical), drop the bundle's own
// output, and cap at maxFiles.
export function rankCandidates(files: string[], maxFiles: number): string[] {
  return unique(files)
    .filter((rel) => rel !== BUNDLE_REL_PATH)
    .sort((a, b) => {
      const ai = isImportantFile(a) ? 0 : 1;
      const bi = isImportantFile(b) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return a.localeCompare(b);
    })
    .slice(0, Math.max(0, maxFiles));
}

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n...[truncated to ${maxChars} chars]`, truncated: true };
}

// Best-effort redaction of obvious inline secrets. KISS: only catches
// `key: value` / `key=value` shapes with a long opaque value.
export function redactSensitiveText(text: string): string {
  return text.replace(
    /(api[_-]?key|token|secret|password)(\s*[:=]\s*['"]?)[A-Za-z0-9_\-]{16,}/gi,
    "$1$2***REDACTED***",
  );
}

async function hasCommand(name: string, cwd: string): Promise<boolean> {
  return (await run(["sh", "-c", `command -v ${name}`], cwd)).code === 0;
}

async function repoTree(root: string): Promise<string> {
  if (await hasCommand("tree", root)) {
    const out = await run(["tree", "-L", "3", "-a", "-I", "node_modules|.git|.jj", "--noreport"], root);
    if (out.code === 0 && out.stdout.trim()) return out.stdout.trim();
  }
  const ls =
    vcsKind(root) === "jj"
      ? await run(["jj", "file", "list"], root)
      : await run(["git", "-C", root, "ls-files"], root);
  if (ls.code === 0 && ls.stdout.trim()) {
    const lines = ls.stdout.trim().split("\n");
    const head = lines.slice(0, 300).join("\n");
    return lines.length > 300 ? `${head}\n...[${lines.length - 300} more files]` : head;
  }
  return "(repository tree unavailable)";
}

async function vcsStatus(root: string): Promise<string> {
  if (vcsKind(root) === "jj") {
    const out = await run(["jj", "status"], root);
    return out.code === 0 ? out.stdout.trimEnd() : `(jj unavailable: ${out.stderr.trim()})`;
  }
  const out = await run(["git", "-C", root, "status", "--short"], root);
  return out.code === 0 ? out.stdout.trimEnd() : `(git unavailable: ${out.stderr.trim()})`;
}

// Changed files for auto-include. jj answers directly (its status output is
// prose, not porcelain); git goes through the porcelain parser.
async function changedFilesList(root: string, status: string): Promise<string[]> {
  if (vcsKind(root) !== "jj") return parseChangedFiles(status);
  const out = await run(["jj", "diff", "--name-only"], root);
  return out.code === 0 ? unique(out.stdout.split(/\r?\n/)) : [];
}

async function vcsLog(root: string): Promise<string> {
  if (vcsKind(root) === "jj") {
    const out = await run(["jj", "log", "--no-graph", "-n", "8", "-T", "builtin_log_oneline"], root);
    return out.code === 0 ? out.stdout.trimEnd() : `(jj log unavailable: ${out.stderr.trim()})`;
  }
  const out = await run(["git", "-C", root, "log", "--oneline", "-8"], root);
  return out.code === 0 ? out.stdout.trimEnd() : `(git log unavailable: ${out.stderr.trim()})`;
}

async function vcsDiff(root: string): Promise<string> {
  if (vcsKind(root) === "jj") {
    const out = await run(["jj", "diff", "--git"], root);
    return out.code === 0 ? out.stdout : `(jj diff unavailable: ${out.stderr.trim()})`;
  }
  const out = await run(["git", "-C", root, "diff"], root);
  return out.code === 0 ? out.stdout : `(git diff unavailable: ${out.stderr.trim()})`;
}

async function filesForGlobs(root: string, globs: string[], limit: number): Promise<string[]> {
  const out: string[] = [];
  for (const glob of globs) {
    if (out.length >= limit) break;
    try {
      for await (const match of new Bun.Glob(glob).scan({ cwd: root, dot: false })) {
        out.push(match);
        if (out.length >= limit * 4) break; // headroom; ranked/sliced later
      }
    } catch {
      // Ignore malformed globs.
    }
  }
  return unique(out);
}

function existingImportantFiles(root: string): string[] {
  const found: string[] = [];
  for (const rel of IMPORTANT_ROOT_FILES) {
    try {
      const abs = resolveSafePath(root, rel);
      if (existsSync(abs) && statSync(abs).isFile()) found.push(rel);
    } catch {
      // Blocked or missing: skip.
    }
  }
  return found;
}

function section(heading: string, body: string): string {
  return `## ${heading}\n\n${body.trimEnd()}`;
}

export async function buildBundle(options: BundleOptions): Promise<BundleResult> {
  const root = options.worktree;
  const title = options.title?.trim() || "Orch Context Bundle";
  const maxFiles = clamp(options.maxFiles, DEFAULTS.maxFiles, 1, 200);
  const maxFileBytes = clamp(options.maxFileBytes, DEFAULTS.maxFileBytes, 1_000, 500_000);
  const maxDiffBytes = clamp(options.maxDiffBytes, DEFAULTS.maxDiffBytes, 1_000, 1_000_000);
  const maxTotalBytes = clamp(options.maxTotalBytes, DEFAULTS.maxTotalBytes, 20_000, 5_000_000);

  const includeImportant = options.includeImportantFiles !== false;
  const includeChanged = options.includeChangedFiles !== false;
  const includeDiff = options.includeDiff !== false;

  const status = await vcsStatus(root);
  const changedFiles = await changedFilesList(root, status);
  const importantFiles = includeImportant ? existingImportantFiles(root) : [];
  const selectedPaths = unique(options.selectedPaths ?? []);
  const globFiles = await filesForGlobs(root, options.extraGlobs ?? [], maxFiles);
  const candidates = rankCandidates(
    [...importantFiles, ...(includeChanged ? changedFiles : []), ...selectedPaths, ...globFiles],
    maxFiles,
  );

  let truncated = false;
  const filesIncluded: string[] = [];
  const filesSkipped: string[] = [];
  const parts: string[] = [];

  parts.push(`# ${title}`);
  parts.push(
    [
      `Generated: ${new Date().toISOString()}`,
      `Worktree: ${root}`,
      "",
      "Purpose: Paste into a high-context model (e.g. gpt-5.5-pro) that cannot call MCP tools.",
      "Use as repo context; produce a narrow plan; do not invent files/facts not shown.",
    ].join("\n"),
  );

  parts.push(section("Repository Tree", `\`\`\`text\n${await repoTree(root)}\n\`\`\``));
  parts.push(section("Git Status", `\`\`\`text\n${status || "(clean)"}\n\`\`\``));
  parts.push(section("Recent Commits", `\`\`\`text\n${await vcsLog(root)}\n\`\`\``));

  if (includeDiff) {
    const diff = truncateText(await vcsDiff(root), maxDiffBytes);
    truncated ||= diff.truncated;
    parts.push(section("Git Diff", `\`\`\`diff\n${diff.text}\n\`\`\``));
  }

  parts.push(
    section(
      "Selected Files",
      [
        `Changed files detected: ${changedFiles.length ? changedFiles.join(", ") : "none"}`,
        `Auto-include important root files: ${includeImportant ? "yes" : "no"}`,
        `Auto-include changed files: ${includeChanged ? "yes" : "no"}`,
        `Explicit selected paths: ${selectedPaths.length ? selectedPaths.join(", ") : "none"}`,
        `Extra globs: ${(options.extraGlobs ?? []).length ? (options.extraGlobs ?? []).join(", ") : "none"}`,
        `Files included below: ${candidates.length ? candidates.join(", ") : "none"}`,
      ].join("\n"),
    ),
  );

  const fileChunks: string[] = [];
  for (const rel of candidates) {
    try {
      const abs = resolveSafePath(root, rel);
      if (!existsSync(abs)) {
        filesSkipped.push(`${rel} [missing]`);
        continue;
      }
      if (!statSync(abs).isFile()) {
        filesSkipped.push(`${rel} [not a file]`);
        continue;
      }
      const raw = readFileSync(abs, "utf8");
      const bytes = Buffer.byteLength(raw, "utf8");
      const body = truncateText(raw, maxFileBytes);
      truncated ||= body.truncated;
      filesIncluded.push(rel);
      fileChunks.push(
        [
          `### ${rel}`,
          "",
          `Bytes: ${bytes}`,
          `SHA-256: ${sha256(raw)}`,
          "",
          `\`\`\`${languageForPath(rel)}`,
          body.text,
          "```",
        ].join("\n"),
      );
    } catch (error) {
      filesSkipped.push(`${rel} [${error instanceof Error ? error.message : String(error)}]`);
    }
  }

  parts.push(section("File Contents", fileChunks.length ? fileChunks.join("\n\n") : "No file contents selected."));
  parts.push(
    section("Skipped Files", filesSkipped.length ? filesSkipped.map((file) => `- ${file}`).join("\n") : "None."),
  );

  let markdown = redactSensitiveText(`${parts.join("\n\n")}\n`);
  if (Buffer.byteLength(markdown, "utf8") > maxTotalBytes) {
    markdown = truncateText(markdown, maxTotalBytes).text;
    truncated = true;
  }

  return {
    markdown,
    bytes: Buffer.byteLength(markdown, "utf8"),
    filesIncluded,
    filesSkipped,
    truncated,
  };
}
