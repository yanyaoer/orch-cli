// orch update: self-update the compiled binary from GitHub releases.
import { chmodSync, realpathSync, renameSync, rmSync } from "node:fs";
import pkg from "../../package.json";
import { CliError, assertKnownFlags, flagBool, printJson, type ParsedArgs } from "../cli.ts";

const GITHUB_REPO = "yanyaoer/orch-cli";

// The compiled single-file binary runs its entry module from bun's virtual
// filesystem; a source checkout (bun run src/orch.ts) does not.
function isCompiledBinary(): boolean {
  return Bun.main.startsWith("/$bunfs/");
}

const UPDATE_FLAGS = ["check", "json"] as const;

// Self-update from the latest GitHub release. `--check` only reports versions.
export async function updateCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "update", UPDATE_FLAGS);
  const current = `v${pkg.version}`;
  const headers: Record<string, string> = { "user-agent": `orch-cli/${pkg.version}`, accept: "application/vnd.github+json" };
  // Unauthenticated GitHub API calls are rate-limited to 60/hour per IP; use
  // ambient credentials when present.
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const api = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { headers });
  if (!api.ok) throw new CliError(`failed to query the latest release: HTTP ${api.status} from api.github.com${api.status === 403 ? " (rate limit? set GH_TOKEN)" : ""}`);
  const release = (await api.json()) as { tag_name?: string };
  const latest = release.tag_name;
  if (!latest) throw new CliError("latest release carries no tag_name");

  if (flagBool(args, "check") || latest === current) {
    printJson({ current, latest, up_to_date: latest === current });
    return 0;
  }
  if (!isCompiledBinary()) {
    throw new CliError("orch update self-replaces the compiled binary; in a source checkout run: git pull && bun run install:local");
  }
  const platform = process.platform;
  const arch = process.arch;
  if ((platform !== "darwin" && platform !== "linux") || (arch !== "arm64" && arch !== "x64")) {
    throw new CliError(`no prebuilt release asset for ${platform}-${arch}; build from source: bun run install:local`);
  }
  const asset = `orch-${platform}-${arch}`;
  const url = `https://github.com/${GITHUB_REPO}/releases/download/${latest}/${asset}`;
  const download = await fetch(url, { headers: { "user-agent": `orch-cli/${pkg.version}` } });
  if (!download.ok) throw new CliError(`failed to download ${url}: HTTP ${download.status}`);
  // Buffer the body explicitly: Bun.write(path, response) can hang on these
  // release downloads, and a starved event loop then exits 0 silently.
  const binary = await download.arrayBuffer();

  // Write next to the real binary so the final rename is atomic on one fs.
  const targetPath = realpathSync(process.execPath);
  const stagedPath = `${targetPath}.update-${process.pid}`;
  try {
    await Bun.write(stagedPath, binary);
    chmodSync(stagedPath, 0o755);
    // The new binary must at least run before it replaces this one.
    const probe = Bun.spawn([stagedPath, "--version"], { stdout: "ignore", stderr: "ignore" });
    if ((await probe.exited) !== 0) throw new CliError(`downloaded ${asset} failed its --version probe; keeping ${current}`);
    renameSync(stagedPath, targetPath);
  } catch (error) {
    rmSync(stagedPath, { force: true });
    throw error;
  }
  printJson({ updated: true, from: current, to: latest, path: targetPath });
  return 0;
}
