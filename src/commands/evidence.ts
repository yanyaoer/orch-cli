// orch evidence dir / list: control-plane evidence (checks the controller runs
// itself: merge checks, break-check logs, device evidence, evidence moved out of
// an old worktree) under ${mrDir}/evidence/<label>/, and a per-MR index of run
// and control-plane evidence. Run evidence itself: src/evidence.ts.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getRepoIdentity, mrStateDir } from "../paths.ts";
import { CliError, assertKnownFlags, flagBool, flagNumber, flagString, printJson, type ParsedArgs } from "../cli.ts";
import { mrIdsForRepo, runInFlight, scanMrRuns } from "../run-store.ts";
import { GZIP_MIN_BYTES_DEFAULT, compactEvidenceDir, type CompactionReport } from "../evidence-compact.ts";
import { buildEvidenceManifest, readEvidenceManifest } from "../evidence.ts";

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function controlEvidenceDir(mrDir: string, label: string): string {
  if (!LABEL.test(label) || label.includes("..")) {
    throw new CliError(`--label must match ${LABEL.source} without "..": ${JSON.stringify(label)}`);
  }
  return `${mrDir}/evidence/${label}`;
}

const EVIDENCE_DIR_FLAGS = ["mr", "label", "worktree", "json"];
const EVIDENCE_LIST_FLAGS = ["mr", "worktree", "json"];

export async function evidenceDirCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "evidence dir", EVIDENCE_DIR_FLAGS);
  const mr = flagString(args, "mr");
  const label = flagString(args, "label");
  const repo = await getRepoIdentity(resolve(flagString(args, "worktree", process.cwd())));
  const mrDir = mrStateDir(repo.repo_key, mr);
  const dir = controlEvidenceDir(mrDir, label);
  const existed = existsSync(dir);
  mkdirSync(`${mrDir}/evidence`, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (flagBool(args, "json")) printJson({ mr, label, evidence_dir: dir, created: !existed });
  else process.stdout.write(`${dir}\n`);
  return 0;
}

interface EvidenceListRow {
  kind: "run" | "control";
  id: string; // run id or label
  role: string | null;
  state: string | null;
  evidence_dir: string;
  file_count: number;
  total_bytes: number;
  manifest: boolean; // false: counted live (run still going, or control-plane dir)
  warnings: string[];
}

export async function evidenceListCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "evidence list", EVIDENCE_LIST_FLAGS);
  const mr = flagString(args, "mr");
  const repo = await getRepoIdentity(resolve(flagString(args, "worktree", process.cwd())));
  const mrDir = mrStateDir(repo.repo_key, mr);
  const rows: EvidenceListRow[] = [];
  for (const record of scanMrRuns(repo.repo_key, mr)) {
    const dir = `${record.run_dir}/evidence`;
    if (!existsSync(dir)) continue;
    const stored = readEvidenceManifest(record.run_dir);
    const manifest = stored ?? buildEvidenceManifest(dir, record.run_id);
    rows.push({
      kind: "run",
      id: record.run_id,
      role: record.status?.role ?? record.spec?.role ?? null,
      state: record.status?.state ?? null,
      evidence_dir: dir,
      file_count: manifest.file_count,
      total_bytes: manifest.total_bytes,
      manifest: stored !== null,
      warnings: manifest.warnings,
    });
  }
  const controlRoot = `${mrDir}/evidence`;
  if (existsSync(controlRoot)) {
    for (const entry of readdirSync(controlRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = `${controlRoot}/${entry.name}`;
      const manifest = buildEvidenceManifest(dir, null);
      rows.push({
        kind: "control",
        id: entry.name,
        role: null,
        state: null,
        evidence_dir: dir,
        file_count: manifest.file_count,
        total_bytes: manifest.total_bytes,
        manifest: false,
        warnings: manifest.warnings,
      });
    }
  }
  if (flagBool(args, "json")) {
    printJson({ mr, mr_dir: mrDir, rows });
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write(`no evidence for MR ${mr} (${mrDir})\n`);
    return 0;
  }
  for (const row of rows) {
    const who = row.kind === "run" ? `run ${row.id} (${row.role ?? "?"}, ${row.state ?? "?"})` : `control ${row.id}`;
    process.stdout.write(`${who}: ${row.file_count} file(s), ${row.total_bytes} bytes${row.manifest ? "" : " (live count)"}  ${row.evidence_dir}\n`);
    for (const warning of row.warnings) process.stdout.write(`  warning: ${warning}\n`);
  }
  return 0;
}

const EVIDENCE_COMPACT_FLAGS = ["mr", "worktree", "execute", "dry-run", "gzip-min-kb", "min-file-age-min"];

// orch evidence compact: apply the compaction rules (src/evidence-compact.ts)
// to the evidence already on disk — every finished run's evidence dir and
// every control-plane label of one MR, or of every MR in the repo. Plan by
// default; --execute applies. Runs in flight are skipped, as are files
// written in the last --min-file-age-min minutes (default 10).
export async function evidenceCompactCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "evidence compact", EVIDENCE_COMPACT_FLAGS);
  const execute = flagBool(args, "execute");
  if (execute && flagBool(args, "dry-run")) throw new CliError("--execute and --dry-run are mutually exclusive");
  const nonNegative = (name: string, fallback: number): number => {
    const value = flagNumber(args, name) ?? fallback;
    if (!Number.isFinite(value) || value < 0) throw new CliError(`--${name} must be a non-negative number`);
    return value;
  };
  const gzipMinBytes = Math.round(nonNegative("gzip-min-kb", GZIP_MIN_BYTES_DEFAULT / 1024) * 1024);
  const minFileAgeMs = nonNegative("min-file-age-min", 10) * 60_000;
  const repo = await getRepoIdentity(resolve(flagString(args, "worktree", process.cwd())));
  const mrs = args.flags.has("mr") ? [flagString(args, "mr")] : mrIdsForRepo(repo.repo_key);
  const dirs: Array<{ mr: string; kind: "run" | "control"; id: string; report: CompactionReport }> = [];
  const skippedRuns: Array<{ mr: string; run_id: string }> = [];
  for (const mr of mrs) {
    const mrDir = mrStateDir(repo.repo_key, mr);
    for (const record of scanMrRuns(repo.repo_key, mr)) {
      const dir = `${record.run_dir}/evidence`;
      if (!existsSync(dir)) continue;
      if (!record.status || runInFlight(record.status)) {
        skippedRuns.push({ mr, run_id: record.run_id });
        continue;
      }
      dirs.push({ mr, kind: "run", id: record.run_id, report: compactEvidenceDir(dir, { execute, gzipMinBytes, minFileAgeMs }) });
    }
    const controlRoot = `${mrDir}/evidence`;
    if (!existsSync(controlRoot)) continue;
    for (const entry of readdirSync(controlRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      dirs.push({ mr, kind: "control", id: entry.name, report: compactEvidenceDir(`${controlRoot}/${entry.name}`, { execute, gzipMinBytes, minFileAgeMs }) });
    }
  }
  const acted = dirs.filter((dir) => dir.report.actions.length > 0);
  const count = (action: string) => acted.reduce((n, dir) => n + dir.report.actions.filter((a) => a.action === action).length, 0);
  const errors = acted.flatMap((dir) => dir.report.actions.filter((a) => a.error).map((a) => ({ dir: dir.report.evidence_dir, path: a.path, error: a.error })));
  printJson({
    evidence: "compact",
    repo_key: repo.repo_key,
    executed: execute,
    gzip_min_bytes: gzipMinBytes,
    summary: {
      dirs_scanned: dirs.length,
      dirs_with_actions: acted.length,
      gzip: count("gzip"),
      drop: count("drop"),
      skip: count("skip"),
      bytes_before: acted.reduce((n, dir) => n + dir.report.bytes_before, 0),
      bytes_saved: acted.reduce((n, dir) => n + dir.report.bytes_saved, 0),
      bytes_saved_is_estimate: !execute,
      errors: errors.length,
      runs_in_flight_skipped: skippedRuns.length,
    },
    errors,
    dirs: acted.map(({ mr, kind, id, report }) => ({ mr, kind, id, ...report })),
    ...(execute || acted.length === 0 ? {} : { execute_with: "orch evidence compact --execute" }),
  });
  return errors.length > 0 ? 1 : 0;
}
