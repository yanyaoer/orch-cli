// orch mirror and mirror sync: mirror a run result to a PR/MR comment; drain the outbox.
import { mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { acquirePidfileLockWait } from "../locks.ts";
import { ensureStateLayout, getRepoIdentity, mrStateDir } from "../paths.ts";
import { argvForDisplay, createForgeAdapter, detectForge } from "../forge.ts";
import { CliError, flagBool, flagString, printJson, type ParsedArgs } from "../cli.ts";
import { mirrorBody } from "../render.ts";
import { assertMirrorBodySafe, forgeRefFor, invalidOutboxDir, latestRunId, pendingOutboxDir, pendingOutboxFiles, readMirrorResult, readOutboxComment,  sentOutboxDir } from "../run-store.ts";

export async function mirrorCommand(args: ParsedArgs): Promise<number> {
  if (args.positionals[1] === "sync") return mirrorSync(args);

  const mr = flagString(args, "mr");
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const execute = flagBool(args, "execute");
  const repo = await getRepoIdentity(worktree);
  const forge = detectForge(repo.remote_url);
  if (forge === "none") {
    process.stdout.write("本仓库无 github/gitlab remote，跳过 mirror\n");
    return 0;
  }

  const adapter = createForgeAdapter(forge, execute, worktree);
  if (!adapter) throw new CliError(`unsupported forge: ${forge}`);

  const root = mrStateDir(repo.repo_key, mr);
  const runsRoot = `${root}/runs`;
  const runId = args.flags.has("run") ? flagString(args, "run") : latestRunId(runsRoot);
  if (!runId) throw new CliError(`no local runs found for MR ${mr}`);

  const { result, status } = readMirrorResult(runsRoot, runId);
  const body = mirrorBody(mr, runId, result, status);
  assertMirrorBodySafe(body);
  const command = await adapter.postComment(forgeRefFor(root, mr), body);

  printJson({
    mirror: execute ? "executed" : "dry-run",
    forge,
    mr,
    run_id: runId,
    argv: command.argv,
    command: argvForDisplay(command.argv),
    exit_code: command.exit_code,
  });
  if (command.stdout) process.stdout.write(command.stdout);
  if (command.stderr) process.stderr.write(command.stderr);
  return command.exit_code && command.exit_code !== 0 ? command.exit_code : 0;
}

async function mirrorSync(args: ParsedArgs): Promise<number> {
  const mr = flagString(args, "mr");
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const execute = flagBool(args, "execute");
  const repo = await getRepoIdentity(worktree);
  const forge = detectForge(repo.remote_url);
  if (forge === "none") {
    process.stdout.write("本仓库无 github/gitlab remote，跳过 mirror sync\n");
    return 0;
  }

  const adapter = createForgeAdapter(forge, execute, worktree);
  if (!adapter) throw new CliError(`unsupported forge: ${forge}`);

  const mrDir = mrStateDir(repo.repo_key, mr);
  ensureStateLayout(mrDir);
  // Concurrent --execute runs would each send the same pending comment before
  // either renames it into sent/; serialize senders per MR outbox. Dry-run
  // stays lock-free read-only.
  const outboxLock = execute ? await acquirePidfileLockWait(`${mrDir}/locks/outbox.lock`, 10_000) : null;
  try {
    return await mirrorSyncPending(mrDir, adapter, forge, mr, execute);
  } finally {
    outboxLock?.release();
  }
}

async function mirrorSyncPending(
  mrDir: string,
  adapter: NonNullable<ReturnType<typeof createForgeAdapter>>,
  forge: string,
  mr: string,
  execute: boolean,
): Promise<number> {
  const pending = pendingOutboxFiles(mrDir);
  let failed = 0;
  for (const file of pending) {
    const pendingPath = `${pendingOutboxDir(mrDir)}/${file}`;
    const payload = readOutboxComment(pendingPath);
    if (!payload) {
      // Quarantine poison payloads on execute: leaving them pending would make
      // every future mirror sync fail without ever reaching all-clear. Dry-run
      // stays read-only and only reports.
      let outboxPath = pendingPath;
      if (execute) {
        mkdirSync(invalidOutboxDir(mrDir), { recursive: true });
        outboxPath = `${invalidOutboxDir(mrDir)}/${file}`;
        renameSync(pendingPath, outboxPath);
      }
      printJson({
        mirror: execute ? "invalid" : "dry-run",
        forge,
        mr,
        outbox_path: outboxPath,
        error: execute ? "invalid outbox payload; moved to outbox/invalid" : "invalid outbox payload",
      });
      failed += 1;
      continue;
    }

    try {
      assertMirrorBodySafe(payload.body);
    } catch (error) {
      printJson({
        mirror: execute ? "failed" : "dry-run",
        forge,
        mr: payload.mr,
        outbox_path: pendingPath,
        error: error instanceof Error ? error.message : String(error),
      });
      failed += 1;
      continue;
    }
    // Payloads queued before forge_ref existed still carry the local thread
    // id; resolve those at send time. A payload already recording a real ref
    // keeps its destination untouched.
    const target = payload.mr === mr ? forgeRefFor(mrDir, payload.mr) : payload.mr;
    const command = await adapter.postComment(target, payload.body);
    const success = command.exit_code === 0;
    printJson({
      mirror: execute ? (success ? "sent" : "failed") : "dry-run",
      forge,
      mr: target,
      outbox_path: pendingPath,
      argv: command.argv,
      command: argvForDisplay(command.argv),
      exit_code: command.exit_code,
    });
    if (command.stdout) process.stdout.write(command.stdout);
    if (command.stderr) process.stderr.write(command.stderr);

    if (execute && success) {
      renameSync(pendingPath, `${sentOutboxDir(mrDir)}/${file}`);
    } else if (execute) {
      failed += 1;
    }
  }

  if (pending.length === 0) {
    printJson({ mirror: execute ? "sent" : "dry-run", forge, mr, pending: 0 });
  }
  return failed > 0 ? 1 : 0;
}
