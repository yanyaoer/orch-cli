// orch chatgpt-bridge and handoff-pro: Cloudflare Worker MCP bridge, tool-less model context bundle.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LockHeldError, acquirePidfileLock } from "../locks.ts";
import { sha256 } from "../hash.ts";
import { getRepoIdentity, orchStateRoot } from "../paths.ts";
import { writeTextAtomic } from "../json.ts";
import { deployWorker, locateBridgeDir, runChatgptBridge } from "../../drivers/chatgpt-bridge.ts";
import { addWorkspace, chatgptBridgeConfigPath, readBridgeConfig, writeBridgeConfig } from "../config.ts";
import { buildBundle, type BundleOptions } from "../handoff-pro.ts";
import { CliError, collectFlags, flagBool, flagNumber, flagString, printJson, type ParsedArgs } from "../cli.ts";
import { utcCompact } from "../run-store.ts";

// Only one local agent may bind a given Worker bridge at a time. A second one
// would fight the first over the singleton BridgeDO ("newest wins" → endless
// reconnect loop). Guard with a pidfile lock keyed by the bridge host; stale
// locks (dead holder) are reclaimed automatically by acquirePidfileLock.
async function connectWithLock(url: string, token: string, worktree: string): Promise<number> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  const lockPath = `${orchStateRoot()}/chatgpt-bridge-locks/${sha256(host)}.lock`;
  let lock;
  try {
    lock = acquirePidfileLock(lockPath);
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new CliError(
        [
          `another orch chatgpt-bridge is already connected to ${host}${error.holderPid ? ` (pid ${error.holderPid})` : ""}.`,
          "Only one local agent may bind a Worker bridge at a time.",
          error.holderPid ? `Stop the other one first:  kill ${error.holderPid}` : "Stop the other instance first.",
        ].join("\n"),
      );
    }
    throw error;
  }
  try {
    return await runChatgptBridge({ url, token, worktree });
  } finally {
    lock.release();
  }
}

export async function chatgptBridge(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const now = new Date().toISOString();

  // Direct mode: explicit --url + --token connect to an already-running Worker
  // (e.g. local `wrangler dev`). We never deploy or overwrite the saved worker.
  if (args.flags.has("url") && args.flags.has("token")) {
    const url = flagString(args, "url");
    const token = flagString(args, "token");
    writeBridgeConfig(addWorkspace(readBridgeConfig(), worktree, now));
    if (flagBool(args, "no-connect")) {
      printJson({ mode: "direct", ws_url: url, worktree, connected: false });
      return 0;
    }
    return connectWithLock(url, token, worktree);
  }

  // Managed mode: deploy the Worker on demand, persist worker + token, reuse next time.
  let cfg = readBridgeConfig();
  if (!cfg.worker || !cfg.token || flagBool(args, "redeploy")) {
    const bridgeDir = locateBridgeDir(args.flags.has("bridge-dir") ? flagString(args, "bridge-dir") : undefined);
    const deployed = await deployWorker(bridgeDir);
    cfg = { ...cfg, worker: deployed.worker, token: deployed.token };
  }
  const worker = cfg.worker!;
  const token = cfg.token!;
  cfg = addWorkspace(cfg, worktree, now);
  writeBridgeConfig(cfg);

  printJson({
    mode: "managed",
    worker: worker.name,
    mcp_url: worker.mcp_url,
    ws_url: worker.ws_url,
    worktree,
    config_path: chatgptBridgeConfigPath(),
    hint: "Paste mcp_url into ChatGPT → Settings → Apps → Developer mode → Create.",
  });

  if (flagBool(args, "no-connect")) return 0;
  return connectWithLock(worker.ws_url, token, worktree);
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["pbcopy"], { stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function handoffPro(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const options: BundleOptions = {
    worktree,
    title: args.flags.has("title") ? flagString(args, "title") : undefined,
    selectedPaths: collectFlags(args, "path"),
    extraGlobs: collectFlags(args, "glob"),
    includeImportantFiles: !flagBool(args, "no-important-files"),
    includeChangedFiles: !flagBool(args, "no-changed-files"),
    includeDiff: !flagBool(args, "no-diff"),
    maxFiles: flagNumber(args, "max-files"),
    maxFileBytes: flagNumber(args, "max-file-bytes"),
    maxDiffBytes: flagNumber(args, "max-diff-bytes"),
    maxTotalBytes: flagNumber(args, "max-total-bytes"),
  };

  const built = await buildBundle(options);
  // Default output lives under XDG_STATE (per-repo), never inside the worktree:
  // the bundle holds full source + diff and must not risk being committed or
  // swept up by project-level sync/share tooling.
  let outPath: string;
  if (args.flags.has("out")) {
    outPath = resolve(flagString(args, "out"));
  } else {
    const repo = await getRepoIdentity(worktree);
    outPath = `${orchStateRoot()}/${repo.repo_key}/handoffs/context-${utcCompact()}.md`;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeTextAtomic(outPath, built.markdown);

  let copied = false;
  if (flagBool(args, "copy")) {
    copied = await copyToClipboard(built.markdown);
    if (!copied) process.stderr.write("warn: clipboard copy failed (pbcopy unavailable); bundle was still written.\n");
  }

  printJson({
    out: outPath,
    bytes: built.bytes,
    files_included: built.filesIncluded.length,
    files_skipped: built.filesSkipped.length,
    truncated: built.truncated,
    copied,
  });
  return 0;
}
