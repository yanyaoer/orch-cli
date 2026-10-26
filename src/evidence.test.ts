import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvidenceManifest, evidenceSummaryLines, writeEvidenceManifest } from "./evidence.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-evidence-"));
  dirs.push(dir);
  return dir;
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("manifest lists every file with bytes and sha256, sorted, symlinks listed but not followed", () => {
  const root = temp();
  const dir = join(root, "evidence");
  mkdirSync(join(dir, "break-1"), { recursive: true });
  writeFileSync(join(dir, "break-1", "b.log"), "bbb");
  writeFileSync(join(dir, "a.diff"), "a");
  writeFileSync(join(root, "outside.txt"), "outside");
  symlinkSync(join(root, "outside.txt"), join(dir, "link"));
  const manifest = buildEvidenceManifest(dir, "run-1");
  expect(manifest.files).toEqual([
    { path: "a.diff", bytes: 1, sha256: sha("a") },
    { path: "break-1/b.log", bytes: 3, sha256: sha("bbb") },
  ]);
  expect(manifest.file_count).toBe(2);
  expect(manifest.total_bytes).toBe(4);
  expect(manifest.symlinks).toEqual([{ path: "link", target: join(root, "outside.txt") }]);
  expect(manifest.warnings).toEqual([]);
  expect(manifest.errors).toEqual([]);
});

test("nested repos, node_modules and an oversize total are warnings, an empty dir is an empty manifest", () => {
  const dir = join(temp(), "evidence");
  mkdirSync(join(dir, "fixture", ".git"), { recursive: true });
  writeFileSync(join(dir, "fixture", ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, "combo", "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "combo", "node_modules", "x", "i.js"), "x".repeat(2048));
  const manifest = buildEvidenceManifest(dir, "run-2", 0.001);
  expect(manifest.nested_repos).toEqual(["fixture"]);
  expect(manifest.node_modules).toEqual(["combo/node_modules"]);
  expect(manifest.warnings).toHaveLength(3);
  expect(manifest.warnings.join("\n")).toMatch(/over 0.001 MB[\s\S]*nested git[\s\S]*node_modules/);

  const empty = join(temp(), "evidence");
  mkdirSync(empty);
  expect(buildEvidenceManifest(empty, null)).toMatchObject({ files: [], file_count: 0, total_bytes: 0, warnings: [], errors: [] });
});

test("writeEvidenceManifest writes artifacts/evidence-manifest.json only when the run has an evidence dir", () => {
  const runDir = temp();
  expect(writeEvidenceManifest(runDir, "r")).toBeNull();
  expect(evidenceSummaryLines(runDir)).toEqual([]);
  mkdirSync(join(runDir, "evidence"));
  expect(evidenceSummaryLines(runDir)[0]).toContain("no manifest yet");
  writeFileSync(join(runDir, "evidence", "x.log"), "12345");
  expect(writeEvidenceManifest(runDir, "r")).toMatchObject({ file_count: 1, total_bytes: 5 });
  expect(evidenceSummaryLines(runDir)[0]).toContain("run evidence: 1 file(s), 5 bytes");
});
