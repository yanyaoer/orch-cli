// orch events tail and orch result: follow events.jsonl / native progress, print result.json.
import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { RoleResult, RunStatus } from "../types.ts";
import { getRepoIdentity } from "../paths.ts";
import { createFileFollower, readJsonFile } from "../json.ts";
import { createNativeNormalizer } from "../native-events.ts";
import { collectRepoKeys, mrDirsForRepo } from "../overview.ts";
import { CliError, flagBool, flagNumber, flagString, type ParsedArgs } from "../cli.ts";
import { printEvidenceSummary, printResultSummary } from "../render.ts";
import { locateRun, looksStale, nonTerminalStates, readTextFile, scanMrRuns } from "../run-store.ts";

function parseTailLines(args: ParsedArgs): number | null {
  if (!args.flags.has("n")) return null;
  const rawValue = args.flags.get("n");
  if (typeof rawValue !== "string") throw new CliError("-n <lines> must be a non-negative integer");
  const raw = rawValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new CliError("-n <lines> must be a non-negative integer");
  return value;
}

function tailText(text: string, lines: number | null): string {
  if (lines === null) return text;
  if (lines === 0) return "";
  const parts = text.split(/\r?\n/);
  if (parts[parts.length - 1] === "") parts.pop();
  const selected = parts.slice(-lines);
  return selected.length ? `${selected.join("\n")}\n` : "";
}

const FOLLOW_POLL_MS = 500;

// Without --run, -f multiplexes every active run in the repo (or one mr, or
// every repo with --all): existing active runs stream from their current end
// (-n replays that much context first), runs created while following stream
// from the top, and a tail(1)-style "==> mr/run <==" header marks every
// source switch (prefixed with the repo's short name under --all). Runs are
// dropped once terminal or stale; the loop itself runs until Ctrl-C, since
// waiting for runs that don't exist yet is the point.
async function eventsTailAll(args: ParsedArgs, repoKeys: string[]): Promise<number> {
  const lines = parseTailLines(args);
  const fileName = flagBool(args, "native") ? "native.jsonl" : "events.jsonl";
  const mrNamesFor = (repoKey: string): string[] => (args.flags.has("mr") ? [flagString(args, "mr")] : mrDirsForRepo(repoKey));
  const labelPrefix = (repoKey: string): string => (repoKeys.length > 1 ? `${basename(repoKey)}:` : "");

  type Tracked = { label: string; runDir: string; follower: ReturnType<typeof createFileFollower>; render: (line: string) => string };
  const tracked = new Map<string, Tracked>();
  const seen = new Set<string>();
  let currentLabel = "";
  const write = (label: string, out: string): void => {
    if (!out) return;
    if (currentLabel !== label) {
      currentLabel = label;
      process.stdout.write(`==> ${label} <==\n`);
    }
    process.stdout.write(out);
  };
  const makeRender = (): ((line: string) => string) => {
    const normalize = fileName === "native.jsonl" ? createNativeNormalizer() : null;
    return (line) =>
      normalize
        ? normalize(line)
            .map((event) => `${JSON.stringify(event)}\n`)
            .join("")
        : line
          ? `${line}\n`
          : "";
  };

  const track = (label: string, runDir: string, preexisting: boolean): void => {
    const render = makeRender();
    let offset = 0;
    if (preexisting) {
      // Pre-existing active run: skip its history (replay -n lines of it as
      // context), follow from the last complete line.
      const text = readTextFile(`${runDir}/${fileName}`) ?? "";
      const complete = text.slice(0, text.lastIndexOf("\n") + 1);
      offset = Buffer.byteLength(complete, "utf8");
      if (lines !== null) write(label, tailText(complete.split("\n").map(render).join(""), lines));
    }
    tracked.set(runDir, { label, runDir, follower: createFileFollower(`${runDir}/${fileName}`, offset), render });
  };

  const discover = (firstPass: boolean): void => {
    for (const repoKey of repoKeys) {
      for (const mrName of mrNamesFor(repoKey)) {
        for (const { run_dir: runDir, status, stale } of scanMrRuns(repoKey, mrName)) {
          if (seen.has(runDir)) continue;
          // A run mid-creation (directory exists, status.json not yet written)
          // stays out of `seen` so the next pass re-examines it instead of
          // skipping it for its whole lifetime.
          if (status === null) continue;
          seen.add(runDir);
          const active = nonTerminalStates.has(status.state) && !stale;
          // On the first pass terminal runs are history; later they are news.
          if (firstPass && !active) continue;
          track(`${labelPrefix(repoKey)}${mrName}/${runDir.slice(runDir.lastIndexOf("/") + 1)}`, runDir, firstPass);
        }
      }
    }
  };

  let firstPass = true;
  for (;;) {
    discover(firstPass);
    if (firstPass) {
      // Say what is being followed up front: an empty scope otherwise looks
      // like a hang (the classic miss is running this from the wrong repo).
      const scope = repoKeys.length === 1 ? repoKeys[0] : `${repoKeys.length} repos`;
      process.stderr.write(
        `following ${scope} · ${tracked.size} active run(s); waiting for new runs (Ctrl-C to stop${repoKeys.length === 1 ? ", --all for every repo" : ""})\n`,
      );
    }
    firstPass = false;
    for (const t of tracked.values()) {
      const emit = (): void => {
        for (const line of t.follower.drain()) write(t.label, t.render(line));
      };
      emit();
      const status = readJsonFile<RunStatus | null>(`${t.runDir}/status.json`, null);
      if (status && (!nonTerminalStates.has(status.state) || looksStale(status))) {
        emit(); // the worker may flush final lines right before going terminal
        tracked.delete(t.runDir);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
  }
}

export async function eventsTail(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const follow = flagBool(args, "follow");
  if (!args.flags.has("run")) {
    if (!follow) throw new CliError("missing --run (with -f, --run may be omitted to follow every active run)");
    if (flagBool(args, "all")) return eventsTailAll(args, collectRepoKeys());
    const repo = await getRepoIdentity(worktree);
    return eventsTailAll(args, [repo.repo_key]);
  }
  if (flagBool(args, "all")) throw new CliError("--all follows every active run; drop --run to use it");
  const runId = flagString(args, "run");
  const mr = args.flags.has("mr") ? flagString(args, "mr") : undefined;
  const lines = parseTailLines(args);
  const repo = await getRepoIdentity(worktree);
  const located = locateRun(repo.repo_key, runId, mr);

  // --native renders provider-native stream output as normalized progress
  // events (session/assistant/tool_use/tool_result/usage/final/raw) — a
  // read-side view of what the worker is doing; orch lifecycle events stay in
  // events.jsonl and remain the state authority.
  const fileName = flagBool(args, "native") ? "native.jsonl" : "events.jsonl";
  const filePath = `${located.run_dir}/${fileName}`;
  const normalize = fileName === "native.jsonl" ? createNativeNormalizer() : null;
  const renderLine = (line: string): string =>
    normalize
      ? normalize(line)
          .map((event) => `${JSON.stringify(event)}\n`)
          .join("")
      : line
        ? `${line}\n`
        : "";

  const text = readTextFile(filePath);
  if (text === null && !follow) throw new CliError(`${fileName} not found for run: ${runId}`);

  // The snapshot stops at the last newline so a trailing half-written line is
  // not rendered twice; in follow mode it stays buffered until complete.
  const snapshot = follow ? (text ?? "").slice(0, (text ?? "").lastIndexOf("\n") + 1) : (text ?? "");
  process.stdout.write(tailText(snapshot.split("\n").map(renderLine).join(""), lines));
  if (!follow) return 0;

  // -f/--follow: stream lines as the worker appends them, then exit once the
  // run is terminal (or stale: pid gone) and the file is drained.
  const follower = createFileFollower(filePath, Buffer.byteLength(snapshot, "utf8"));
  const emit = (): void => {
    for (const line of follower.drain()) process.stdout.write(renderLine(line));
  };
  for (;;) {
    emit();
    const status = readJsonFile<RunStatus | null>(`${located.run_dir}/status.json`, null);
    if (status && (!nonTerminalStates.has(status.state) || looksStale(status))) {
      emit(); // the worker may flush final lines right before going terminal
      if (text === null && !follower.sawFile()) throw new CliError(`${fileName} not found for run: ${runId}`);
      if (nonTerminalStates.has(status.state)) {
        process.stderr.write(`orch events tail: run ${runId} looks stale (pid ${status.pid} is gone); stopping\n`);
      }
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
  }
}

export async function resultCommand(args: ParsedArgs): Promise<number> {
  const runId = flagString(args, "run");
  const mr = args.flags.has("mr") ? flagString(args, "mr") : undefined;
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const located = locateRun(repo.repo_key, runId, mr);

  // --wait blocks until the run reaches a terminal state, so agent controllers
  // don't have to hand-roll a polling loop between create and result.
  if (flagBool(args, "wait")) {
    const waitSec = flagNumber(args, "wait-sec") ?? 900;
    const deadline = Date.now() + waitSec * 1000;
    for (;;) {
      const status = readJsonFile<RunStatus | null>(`${located.run_dir}/status.json`, null);
      if (status && !nonTerminalStates.has(status.state)) break;
      if (status && looksStale(status)) {
        throw new CliError(`run ${runId} looks stale (pid ${status.pid} is gone); run: orch run reap --mr ${located.mr}`);
      }
      if (Date.now() >= deadline) {
        throw new CliError(`run ${runId} did not reach a terminal state within ${waitSec}s (state: ${status?.state ?? "unknown"})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  const resultPath = `${located.run_dir}/result.json`;
  const raw = readTextFile(resultPath);
  if (raw === null) throw new CliError(`result.json not found for run: ${runId}`);
  if (flagBool(args, "json")) {
    process.stdout.write(raw.endsWith("\n") ? raw : `${raw}\n`);
    return 0;
  }
  let parsed: RoleResult;
  try {
    parsed = JSON.parse(raw) as RoleResult;
  } catch {
    throw new CliError(`result.json is not valid JSON for run: ${runId}`);
  }
  printResultSummary(parsed);
  printEvidenceSummary(located.run_dir);
  return 0;
}
