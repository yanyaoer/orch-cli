// orch trajectory: normalize a run/thread's provider session into role-based records.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RunStatus } from "../types.ts";
import { getRepoIdentity } from "../paths.ts";
import { readJsonFile, writeTextAtomic } from "../json.ts";
import { CliError, assertKnownFlags, flagBool, flagString, type ParsedArgs } from "../cli.ts";
import { TRAJECTORY_SOURCES, locateSessionFile, normalizeSession, type TrajectoryRecord } from "../trajectory.ts";
import { locateRun, scanMrRuns } from "../run-store.ts";

const TRAJECTORY_FLAGS = ["run", "thread", "mr", "worktree", "jsonl", "archive"] as const;

interface TrajectorySession {
  run_ids: string[];
  source: string;
  session_path: string;
  records: TrajectoryRecord[];
}

// One run's provider session, normalized. Chained (resumed) runs share a
// session, so records cover the whole chain, not just this run.
function trajectoryForStatus(status: RunStatus): TrajectorySession {
  // Adapter support first: pi/omp runs usually also lack a resume id, and
  // the actionable error is the missing adapter, not the missing id.
  if (!(status.agent in TRAJECTORY_SOURCES)) {
    throw new CliError(`agent ${status.agent} has no verified session adapter yet (supported: claude, codex)`);
  }
  const resumeId = status.provider_resume_id ?? status.provider_session_id;
  if (!resumeId) throw new CliError(`run ${status.run_id} recorded no provider session id`);
  const found = locateSessionFile(status.agent, resumeId);
  if (!found) throw new CliError(`no ${status.agent} session file found for id ${resumeId}`);
  const records = normalizeSession(found.source, readFileSync(found.path, "utf8"));
  return { run_ids: [status.run_id], source: found.source, session_path: found.path, records };
}

// Piping to head/grep -m1 closes stdout early; the awaited flush must treat
// that as a normal end of output, not a crash.
async function writeStdoutFlushed(text: string): Promise<void> {
  try {
    await Bun.write(Bun.stdout, text);
  } catch (error) {
    if ((error as { code?: string })?.code === "EPIPE" || String(error).includes("EPIPE")) return;
    throw error;
  }
}

export async function trajectoryCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "trajectory", TRAJECTORY_FLAGS);
  if (args.flags.has("run") && args.flags.has("thread")) {
    throw new CliError("--run conflicts with --thread; pick one selector");
  }
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const jsonl = flagBool(args, "jsonl");

  if (args.flags.has("run")) {
    const runId = flagString(args, "run");
    const located = locateRun(repo.repo_key, runId, args.flags.has("mr") ? flagString(args, "mr") : undefined);
    const status = readJsonFile<RunStatus | null>(`${located.run_dir}/status.json`, null);
    if (!status) throw new CliError(`status.json not found for run: ${runId}`);
    const session = trajectoryForStatus(status);
    if (flagBool(args, "archive")) {
      writeTextAtomic(
        `${located.run_dir}/trajectory.jsonl`,
        session.records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      process.stderr.write(`archived ${session.records.length} records to ${located.run_dir}/trajectory.jsonl\n`);
    }
    // Trajectory payloads run to hundreds of KB; process.exit would truncate
    // pending async stdout writes, so flush through an awaited write.
    const out = jsonl
      ? session.records.map((record) => JSON.stringify(record)).join("\n") + "\n"
      : JSON.stringify(
          {
            trajectory: "run",
            mr: located.mr,
            run_id: runId,
            source: session.source,
            session_path: session.session_path,
            record_count: session.records.length,
            records: session.records,
          },
          null,
          2,
        ) + "\n";
    await writeStdoutFlushed(out);
    return 0;
  }

  if (args.flags.has("thread")) {
    if (flagBool(args, "archive")) throw new CliError("--archive applies to --run only");
    if (args.flags.has("mr")) throw new CliError("--mr applies to --run; --thread already names the thread");
    const mr = flagString(args, "thread");
    const records = scanMrRuns(repo.repo_key, mr);
    if (records.length === 0) throw new CliError(`no runs found for thread ${mr}`);
    // Chained runs share one provider session: dedupe by session path so the
    // thread view lists each transcript once with every run that rode it.
    const sessions = new Map<string, TrajectorySession>();
    const skipped: { run_id: string; reason: string }[] = [];
    for (const { status } of records) {
      if (!status) continue;
      try {
        const session = trajectoryForStatus(status);
        const existing = sessions.get(session.session_path);
        if (existing) existing.run_ids.push(status.run_id);
        else sessions.set(session.session_path, session);
      } catch (error) {
        skipped.push({ run_id: status.run_id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    // Partial exports must be visible in every mode (the JSON payload lists
    // skipped runs, but --jsonl would otherwise drop them silently), and an
    // export with nothing to export is a failure, not an empty success.
    for (const skip of skipped) process.stderr.write(`skip ${skip.run_id}: ${skip.reason}\n`);
    if (sessions.size === 0) {
      throw new CliError(`no exportable session in thread ${mr} (${skipped.length} run(s) skipped)`);
    }
    const out = jsonl
      ? [...sessions.values()]
          .flatMap((session) => session.records.map((record) => JSON.stringify(record)))
          .join("\n") + "\n"
      : JSON.stringify(
          {
            trajectory: "thread",
            mr,
            sessions: [...sessions.values()].map((session) => ({
              run_ids: session.run_ids,
              source: session.source,
              session_path: session.session_path,
              record_count: session.records.length,
              records: session.records,
            })),
            skipped,
          },
          null,
          2,
        ) + "\n";
    await writeStdoutFlushed(out);
    return 0;
  }

  throw new CliError("usage: orch trajectory --run <id> [--mr <id>] [--jsonl] [--archive] | orch trajectory --thread <id> [--jsonl]");
}
