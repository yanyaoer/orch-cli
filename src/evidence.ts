// Run and control-plane evidence (E1–E6 of the evidence-dir design).
//
// A write-role run gets ${runDir}/evidence/ (created by run create, exported as
// ORCH_RUN_EVIDENCE_DIR, granted to the provider with --add-dir / a Seatbelt
// allow). When the run ends the supervisor writes
// artifacts/evidence-manifest.json: a machine-made file list (path, bytes,
// sha256) that carries no meaning of its own — what a check proved lives in the
// files themselves. Nested repositories, node_modules and an oversize total are
// warnings only: more evidence never changes a verdict.
//
// Control-plane evidence and the per-MR index: src/commands/evidence.ts.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { readJsonFile, writeJsonAtomic } from "./json.ts";

export const EVIDENCE_MANIFEST_SCHEMA = "orch.evidence-manifest/v1";
export const EVIDENCE_MANIFEST_FILE = "artifacts/evidence-manifest.json";
export const EVIDENCE_MAX_MB_DEFAULT = 200;

export interface EvidenceFile {
  path: string; // relative to the evidence dir
  bytes: number;
  sha256: string;
}

export interface EvidenceManifest {
  schema: typeof EVIDENCE_MANIFEST_SCHEMA;
  run_id: string | null;
  evidence_dir: string;
  generated_at: string;
  files: EvidenceFile[];
  file_count: number;
  total_bytes: number;
  symlinks: Array<{ path: string; target: string }>; // listed, never followed
  nested_repos: string[]; // dirs holding a .git: fixture repos belong in $TMPDIR
  node_modules: string[];
  errors: string[]; // unreadable entries; the rest is still listed
  warnings: string[];
}

export function evidenceMaxMb(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ORCH_EVIDENCE_MAX_MB);
  return Number.isFinite(raw) && raw > 0 ? raw : EVIDENCE_MAX_MB_DEFAULT;
}

function fileSha256(path: string): string {
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

export function buildEvidenceManifest(dir: string, runId: string | null, maxMb = evidenceMaxMb()): EvidenceManifest {
  const manifest: EvidenceManifest = {
    schema: EVIDENCE_MANIFEST_SCHEMA,
    run_id: runId,
    evidence_dir: dir,
    generated_at: new Date().toISOString(),
    files: [],
    file_count: 0,
    total_bytes: 0,
    symlinks: [],
    nested_repos: [],
    node_modules: [],
    errors: [],
    warnings: [],
  };
  const walk = (rel: string): void => {
    const abs = rel ? `${dir}/${rel}` : dir;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (error) {
      manifest.errors.push(`${rel || "."}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (rel && entries.some((entry) => entry.name === ".git")) manifest.nested_repos.push(rel);
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = `${dir}/${childRel}`;
      try {
        const stat = lstatSync(childAbs);
        if (stat.isSymbolicLink()) {
          manifest.symlinks.push({ path: childRel, target: readlinkSync(childAbs) });
        } else if (stat.isDirectory()) {
          if (entry.name === "node_modules") manifest.node_modules.push(childRel);
          walk(childRel);
        } else if (stat.isFile()) {
          manifest.files.push({ path: childRel, bytes: stat.size, sha256: fileSha256(childAbs) });
          manifest.total_bytes += stat.size;
        }
      } catch (error) {
        manifest.errors.push(`${childRel}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  if (existsSync(dir)) walk("");
  else manifest.errors.push(`${dir}: evidence dir is missing`);
  manifest.file_count = manifest.files.length;
  if (manifest.total_bytes > maxMb * 1024 * 1024) {
    manifest.warnings.push(`evidence is ${manifest.total_bytes} bytes, over ${maxMb} MB (ORCH_EVIDENCE_MAX_MB); keep whole-tree copies in $TMPDIR`);
  }
  if (manifest.nested_repos.length > 0) {
    manifest.warnings.push(`nested git repositories in evidence: ${manifest.nested_repos.join(", ")}; keep fixture repositories in $TMPDIR`);
  }
  if (manifest.node_modules.length > 0) {
    manifest.warnings.push(`node_modules in evidence: ${manifest.node_modules.join(", ")}; keep whole-tree copies in $TMPDIR`);
  }
  return manifest;
}

// Supervisor hook: best effort, never changes the run outcome.
export function writeEvidenceManifest(runDir: string, runId: string | null): EvidenceManifest | null {
  const dir = `${runDir}/evidence`;
  if (!existsSync(dir)) return null;
  const manifest = buildEvidenceManifest(dir, runId);
  mkdirSync(`${runDir}/artifacts`, { recursive: true });
  writeJsonAtomic(`${runDir}/${EVIDENCE_MANIFEST_FILE}`, manifest);
  return manifest;
}

export function readEvidenceManifest(runDir: string): EvidenceManifest | null {
  const manifest = readJsonFile<EvidenceManifest | null>(`${runDir}/${EVIDENCE_MANIFEST_FILE}`, null);
  return manifest && manifest.schema === EVIDENCE_MANIFEST_SCHEMA ? manifest : null;
}

export function evidenceSummaryLines(runDir: string): string[] {
  const manifest = readEvidenceManifest(runDir);
  if (!manifest) {
    return existsSync(`${runDir}/evidence`) ? [`run evidence: ${runDir}/evidence (no manifest yet: the run has not finished)`] : [];
  }
  return [
    `run evidence: ${manifest.file_count} file(s), ${manifest.total_bytes} bytes in ${manifest.evidence_dir} (manifest ${runDir}/${EVIDENCE_MANIFEST_FILE})`,
    ...manifest.warnings.map((warning) => `  warning: ${warning}`),
    ...manifest.errors.map((error) => `  error: ${error}`),
  ];
}
