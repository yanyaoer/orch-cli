// Evidence compaction: keep what a check proved, drop the bulk.
//
// Two rules, applied to one evidence dir (a run's ${runDir}/evidence or a
// control-plane ${mrDir}/evidence/<label>):
//   - large text (logs, reports, dumps) is gzipped in place: <file> becomes
//     <file>.gz, mtime kept; the original is deleted only after the .gz has
//     been decompressed and its sha256 matched the original;
//   - rebuildable binaries (.apk/.aab/.aar/.jar/.dex) are deleted — they are
//     build outputs of a recorded commit, not evidence of a check.
// Every action is appended to <evidence dir>/.orch-compaction.json with the
// original path, bytes and sha256, so evidence/<path> citations still resolve.
// The run's evidence-manifest.json is never rewritten: it stays the record of
// what the run left. Symlinks are never followed; files younger than
// minFileAgeMs are skipped (something may still be writing them).
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { readJsonFile, writeJsonAtomic } from "./json.ts";
import { randomHex } from "./hash.ts";

export const COMPACTION_LEDGER = ".orch-compaction.json";
export const COMPACTION_SCHEMA = "orch.evidence-compaction/v1";
export const TEXT_EXTENSIONS = [".log", ".txt", ".xml", ".html", ".htm", ".json", ".jsonl", ".md", ".csv", ".out", ".err", ".trace", ".har"];
export const REBUILDABLE_EXTENSIONS = [".apk", ".aab", ".aar", ".jar", ".dex"];
export const GZIP_MIN_BYTES_DEFAULT = 256 * 1024;
// gzipSync holds the file, its compressed copy and the verification copy in
// memory; larger files are reported and left alone.
export const GZIP_MAX_BYTES = 512 * 1024 * 1024;

export interface CompactionAction {
  path: string; // relative to the evidence dir
  action: "gzip" | "drop" | "skip";
  reason: string;
  bytes: number;
  sha256: string | null;
  gz_path?: string;
  gz_bytes?: number;
  applied?: boolean;
  error?: string;
}

export interface CompactionOptions {
  execute: boolean;
  gzipMinBytes?: number;
  minFileAgeMs?: number;
  now?: number;
}

export interface CompactionReport {
  evidence_dir: string;
  actions: CompactionAction[];
  bytes_before: number; // of the files acted on
  bytes_saved: number; // planned, or applied with execute
}

interface CompactionLedger {
  schema: typeof COMPACTION_SCHEMA;
  entries: Array<CompactionAction & { at: string }>;
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

function classify(name: string, bytes: number, gzipMinBytes: number): { action: CompactionAction["action"]; reason: string } | null {
  const ext = extension(name);
  if (REBUILDABLE_EXTENSIONS.includes(ext)) return { action: "drop", reason: `rebuildable build output (${ext})` };
  if (!TEXT_EXTENSIONS.includes(ext) || bytes < gzipMinBytes) return null;
  if (bytes > GZIP_MAX_BYTES) return { action: "skip", reason: `text over ${GZIP_MAX_BYTES} bytes: too large to gzip in memory` };
  return { action: "gzip", reason: `text >= ${gzipMinBytes} bytes` };
}

// Test seam: runs right before the unchanged-check that guards each unlink.
export const compactionTestHooks: { beforeUnlinkCheck?: (abs: string) => void } = {};

interface FileIdentity {
  size: number;
  mtimeMs: number;
  ino: number;
}

function identity(path: string): FileIdentity {
  const stat = lstatSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

// Refuse to delete an original that changed since it was hashed: same size,
// mtime and inode, and the same sha256 again right before the unlink. A writer
// that lands between this check and the unlink is not detectable without a
// lock; the minimum file age (orch evidence compact) and running only after a
// run has ended (supervisor) keep writers away.
function assertUnchanged(abs: string, entry: CompactionAction, before: FileIdentity): void {
  if (!sameIdentity(before, identity(abs)) || sha256File(abs) !== entry.sha256) {
    throw new Error("file changed during compaction (size, mtime, inode or sha256 differ); original kept");
  }
}

function gzipInPlace(abs: string, entry: CompactionAction, before: FileIdentity): void {
  const gzAbs = `${abs}.gz`;
  if (existsSync(gzAbs)) throw new Error(`${entry.path}.gz already exists`);
  const original = readFileSync(abs);
  const compressed = gzipSync(original, { level: 6 });
  const check = createHash("sha256").update(gunzipSync(compressed)).digest("hex");
  if (check !== entry.sha256) throw new Error("gzip round trip does not match the original sha256 (file changed while reading); original kept");
  const stat = lstatSync(abs);
  const tmp = `${gzAbs}.${randomHex(3)}.tmp`;
  writeFileSync(tmp, compressed, { mode: stat.mode & 0o777 });
  utimesSync(tmp, stat.atime, stat.mtime);
  renameSync(tmp, gzAbs);
  try {
    compactionTestHooks.beforeUnlinkCheck?.(abs);
    assertUnchanged(abs, entry, before);
  } catch (error) {
    rmSync(gzAbs, { force: true });
    throw error;
  }
  rmSync(abs);
  entry.gz_path = `${entry.path}.gz`;
  entry.gz_bytes = compressed.length;
}

export function compactEvidenceDir(dir: string, options: CompactionOptions): CompactionReport {
  const gzipMinBytes = options.gzipMinBytes ?? GZIP_MIN_BYTES_DEFAULT;
  const minAge = options.minFileAgeMs ?? 0;
  const now = options.now ?? Date.now();
  const report: CompactionReport = { evidence_dir: dir, actions: [], bytes_before: 0, bytes_saved: 0 };
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(rel ? `${dir}/${rel}` : dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return;
    }
    for (const dirent of entries) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (childRel === COMPACTION_LEDGER) continue;
      const abs = `${dir}/${childRel}`;
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(childRel);
        continue;
      }
      if (!stat.isFile()) continue;
      const kind = classify(dirent.name, stat.size, gzipMinBytes);
      if (!kind) continue;
      const entry: CompactionAction = { path: childRel, action: kind.action, reason: kind.reason, bytes: stat.size, sha256: null };
      if (kind.action !== "skip" && now - stat.mtimeMs < minAge) {
        Object.assign(entry, { action: "skip", reason: `written within the last ${Math.round(minAge / 1000)} s` });
      }
      report.actions.push(entry);
    }
  };
  if (existsSync(dir)) walk("");

  const applied: Array<CompactionAction & { at: string }> = [];
  for (const entry of report.actions) {
    if (entry.action === "skip") continue;
    report.bytes_before += entry.bytes;
    if (!options.execute) {
      // Planned savings: a dropped file frees all of it; gzip is estimated at 90%.
      report.bytes_saved += entry.action === "drop" ? entry.bytes : Math.round(entry.bytes * 0.9);
      continue;
    }
    const abs = `${dir}/${entry.path}`;
    try {
      const before = identity(abs);
      entry.sha256 = sha256File(abs);
      if (entry.action === "drop") {
        compactionTestHooks.beforeUnlinkCheck?.(abs);
        assertUnchanged(abs, entry, before);
        rmSync(abs);
        report.bytes_saved += entry.bytes;
      } else {
        gzipInPlace(abs, entry, before);
        report.bytes_saved += entry.bytes - (entry.gz_bytes ?? entry.bytes);
      }
      entry.applied = true;
      applied.push({ ...entry, at: new Date().toISOString() });
    } catch (error) {
      entry.applied = false;
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
  if (applied.length > 0) {
    const ledgerPath = `${dir}/${COMPACTION_LEDGER}`;
    const ledger = readJsonFile<CompactionLedger | null>(ledgerPath, null);
    const entries = ledger?.schema === COMPACTION_SCHEMA ? ledger.entries : [];
    writeJsonAtomic(ledgerPath, { schema: COMPACTION_SCHEMA, entries: [...entries, ...applied] });
  }
  return report;
}

export function readCompactionLedger(dir: string): CompactionLedger | null {
  const ledger = readJsonFile<CompactionLedger | null>(`${dir}/${COMPACTION_LEDGER}`, null);
  return ledger?.schema === COMPACTION_SCHEMA ? ledger : null;
}

export function evidenceCompactEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORCH_EVIDENCE_COMPACT !== "0";
}
