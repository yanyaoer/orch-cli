// orch evidence dir / list: control-plane evidence (checks the controller runs
// itself: merge checks, break-check logs, device evidence, evidence moved out of
// an old worktree) under ${mrDir}/evidence/<label>/, and a per-MR index of run
// and control-plane evidence. Run evidence itself: src/evidence.ts.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getRepoIdentity, mrStateDir } from "../paths.ts";
import { CliError, assertKnownFlags, flagBool, flagString, printJson, type ParsedArgs } from "../cli.ts";
import { scanMrRuns } from "../run-store.ts";
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
