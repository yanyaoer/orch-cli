import pkg from "../package.json";
import { runSupervisor } from "./supervisor.ts";

import { HELP_TOPICS, chatgptBridgeHelp, decisionHelp, eventsTailHelp, fanoutHelp, handoffProHelp, mailHelp, mailctlHelp, mirrorHelp, mirrorSyncHelp, newHelp, prewalkHelp, resultCommandHelp, runCancelHelp, runCreateHelp, runHelp, runListHelp, searchHelp, statusHelp, topLevelHelp, topicHelp, trajectoryHelp, unknownTopicHelp, updateHelp, usageHelp, verdictHelp, waitHelp, workspaceHelp, worktreeCloneHelp, worktreeGcHelp, worktreeRemoveHelp, type HelpTopic } from "./help.ts";
import { runCodexDriver } from "../drivers/codex-headless.ts";
import { runClaudeDriver } from "../drivers/claude-headless.ts";
import { runPiDriver } from "../drivers/pi-headless.ts";
import { runOmpDriver } from "../drivers/omp-headless.ts";
import { mail } from "./mail-cli.ts";
import { workspace } from "./workspace-cli.ts";
import { worktreeClone, worktreeGc, worktreeRemove } from "./worktree.ts";
import { CliError, assertKnownFlags, flagBool, flagString, hasHelp, parseArgs, printJson, readStdinText, type ParsedArgs } from "./cli.ts";
import { insideSandbox, proxyToHost, reconcileDispatchOnce, reconcileDispatchWatch, shouldProxyToHost } from "./dispatch.ts";
import { prewalkCommand } from "./prewalk.ts";
import { chatgptBridge, handoffPro } from "./commands/bridge.ts";
import { decisionCommand } from "./commands/decision.ts";
import { eventsTail, resultCommand } from "./commands/events.ts";
import { crossReviewCommand, fanoutCommand, investigateCommand } from "./commands/fanout.ts";
import { mailctlCommand } from "./commands/mailctl.ts";
import { mirrorCommand } from "./commands/mirror.ts";
import { newCommand } from "./commands/new.ts";
import { createRun, runCancel, runList, runReap } from "./commands/run.ts";
import { searchCommand } from "./commands/search.ts";
import { overviewCommand, statusCommand, verdictCommand, waitCommand } from "./commands/status.ts";
import { trajectoryCommand } from "./commands/trajectory.ts";
import { updateCommand } from "./commands/update.ts";
import { usageCommand } from "./commands/usage.ts";
import { locateRun, orchCommand, readMirrorResult } from "./run-store.ts";

// Host-side git probes (vcsDirty at run create, supervisor evidence capture,
// repo-root resolution) run in worktrees the user may be rebasing in at the
// same time; `git status`/`git diff` opportunistically rewrite the index,
// taking short-lived index.lock that races the user's own git. Workers inherit
// this through buildWorkerEnv, covering non-seatbelt sandboxes too.
process.env.GIT_OPTIONAL_LOCKS = "0";

function isHelpTopic(value: string): value is HelpTopic {
  return (HELP_TOPICS as readonly string[]).includes(value);
}

// Unsandboxed host reconciler for the dispatch queue: executes the state
// mutations a sandboxed controller enqueued (run create, decision, mail, …).
// `--watch` is the companion for the mailctl controller (which runs detached);
// orch new drives the same reconcile loop in-process while its controller runs.
async function dispatchCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  if (sub !== "reconcile") {
    process.stderr.write("usage: orch dispatch reconcile [--once|--watch]\n");
    return 2;
  }
  assertKnownFlags(args, "dispatch reconcile", ["once", "watch", "json"]);
  if (flagBool(args, "watch")) {
    process.stderr.write("orch dispatch reconcile --watch: draining sandboxed dispatch requests (Ctrl-C to stop)\n");
    await reconcileDispatchWatch(orchCommand(), () => false);
    return 0;
  }
  const handled = await reconcileDispatchOnce(orchCommand());
  if (flagBool(args, "json")) printJson({ reconciled: handled });
  else process.stdout.write(`dispatch reconcile: handled ${handled} request(s)\n`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const [first, second] = args.positionals;
  if (!first && flagBool(args, "version")) {
    process.stdout.write(`orch v${pkg.version}\n`);
    return 0;
  }
  if (first === "__supervisor") return runSupervisor(flagString(args, "run-dir"), orchCommand());
  if (first === "__driver-codex") return runCodexDriver(process.argv.slice(3));
  if (first === "__driver-claude") return runClaudeDriver(process.argv.slice(3));
  if (first === "__driver-pi") return runPiDriver(process.argv.slice(3));
  if (first === "__driver-omp") return runOmpDriver(process.argv.slice(3));

  // Host-side dispatch boundary: a state-mutating orch command issued from
  // inside a sandbox (a controller's run/decision/mailctl mutation) can't
  // spawn a working worker or touch run artifacts under the jail. Proxy it to
  // the unsandboxed host reconciler and relay its result. Reads run locally.
  if (insideSandbox() && first !== "dispatch" && shouldProxyToHost(args.positionals)) {
    const forwardArgv = process.argv.slice(2);
    // Only drain stdin when the command actually takes it (a `-` marker, e.g.
    // `--task -` / `--task=-`); reading unconditionally could block a
    // stdin-less command (decision/mail) if the shell left stdin open.
    const stdin = !process.stdin.isTTY && args.flags.get("task") === "-" ? await readStdinText() : "";
    const result = await proxyToHost({ argv: forwardArgv, stdin });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.exit_code;
  }
  if (first === "dispatch") return dispatchCommand(args);

  // Bare `orch` is the overview: current state + runnable pending actions.
  // `orch --help` keeps printing the command reference.
  if (!first && !hasHelp(args)) return overviewCommand(args);

  if (!first || hasHelp(args)) {
    if (!first) {
      process.stdout.write(topLevelHelp());
      return 0;
    }
    if (first === "verdict") {
      process.stdout.write(verdictHelp());
      return 0;
    }
    if (first === "wait") {
      process.stdout.write(waitHelp());
      return 0;
    }
    if (first === "new") {
      process.stdout.write(newHelp());
      return 0;
    }
    if (first === "run" && second === "create") {
      process.stdout.write(runCreateHelp());
      return 0;
    }
    if (first === "run" && second === "list") {
      process.stdout.write(runListHelp());
      return 0;
    }
    if (first === "run" && second === "cancel") {
      process.stdout.write(runCancelHelp());
      return 0;
    }
    if (first === "run") {
      process.stdout.write(runHelp());
      return 0;
    }
    if (first === "search") {
      process.stdout.write(searchHelp());
      return 0;
    }
    if (first === "usage") {
      process.stdout.write(usageHelp());
      return 0;
    }
    if (first === "trajectory") {
      process.stdout.write(trajectoryHelp());
      return 0;
    }
    if (first === "cross-review" || first === "fanout" || first === "investigate") {
      process.stdout.write(fanoutHelp());
      return 0;
    }
    if (first === "prewalk") {
      process.stdout.write(prewalkHelp());
      return 0;
    }
    if (first === "events" && second === "tail") {
      process.stdout.write(eventsTailHelp());
      return 0;
    }
    if (first === "result") {
      process.stdout.write(resultCommandHelp());
      return 0;
    }
    if (first === "status") {
      process.stdout.write(statusHelp());
      return 0;
    }
    if (first === "decision") {
      process.stdout.write(decisionHelp());
      return 0;
    }
    if (first === "mail") {
      process.stdout.write(mailHelp());
      return 0;
    }
    if (first === "mailctl") {
      process.stdout.write(mailctlHelp());
      return 0;
    }
    if (first === "workspace") {
      process.stdout.write(workspaceHelp());
      return 0;
    }
    if (first === "worktree") {
      process.stdout.write(second === "gc" ? worktreeGcHelp() : second === "remove" ? worktreeRemoveHelp() : worktreeCloneHelp());
      return 0;
    }
    if (first === "mirror" && second === "sync") {
      process.stdout.write(mirrorSyncHelp());
      return 0;
    }
    if (first === "mirror") {
      process.stdout.write(mirrorHelp());
      return 0;
    }
    if (first === "chatgpt-bridge") {
      process.stdout.write(chatgptBridgeHelp());
      return 0;
    }
    if (first === "handoff-pro") {
      process.stdout.write(handoffProHelp());
      return 0;
    }
    if (first === "update") {
      process.stdout.write(updateHelp());
      return 0;
    }
    if (first === "help") {
      process.stdout.write(second && isHelpTopic(second) ? topicHelp(second) : topLevelHelp());
      return 0;
    }
    process.stdout.write(topLevelHelp());
    return 0;
  }

  if (first === "help") {
    if (!second) {
      process.stdout.write(topLevelHelp());
      return 0;
    }
    if (isHelpTopic(second)) {
      process.stdout.write(topicHelp(second));
      return 0;
    }
    process.stderr.write(unknownTopicHelp(second));
    return 2;
  }

  if (first === "verdict") return verdictCommand(args);
  if (first === "wait") return waitCommand(args);
  if (first === "new") return newCommand(args);
  if (first === "run" && second === "create") return createRun(args);
  if (first === "run" && second === "list") return runList(args);
  if (first === "run" && second === "reap") return runReap(args);
  if (first === "run" && second === "cancel") return runCancel(args);
  if (first === "search") return searchCommand(args);
  if (first === "usage") return usageCommand(args);
  if (first === "trajectory") return trajectoryCommand(args);
  if (first === "cross-review") return crossReviewCommand(args);
  if (first === "fanout") return fanoutCommand(args);
  if (first === "investigate") return investigateCommand(args);
  if (first === "prewalk") return prewalkCommand(args, { orchCommand: orchCommand() });
  if (first === "events" && second === "tail") return eventsTail(args);
  if (first === "result") return resultCommand(args);
  if (first === "status") return statusCommand(args);
  if (first === "decision") return decisionCommand(args);
  if (first === "mirror") return mirrorCommand(args);
  if (first === "mail") return mail(args, { orchCommand, locateRun, readMirrorResult });
  if (first === "mailctl") return mailctlCommand(args, { orchCommand, locateRun, readMirrorResult });
  if (first === "workspace") return workspace(args);
  if (first === "worktree" && second === "clone") return worktreeClone(args);
  if (first === "worktree" && second === "gc") return worktreeGc(args);
  if (first === "worktree" && second === "remove") return worktreeRemove(args);
  if (first === "chatgpt-bridge") return chatgptBridge(args);
  if (first === "handoff-pro") return handoffPro(args);
  if (first === "update") return updateCommand(args);
  process.stderr.write(`unknown command: ${[first, second].filter(Boolean).join(" ")}\n\n`);
  process.stderr.write(topLevelHelp());
  return 2;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      if (error instanceof CliError) {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
      }
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    });
}
