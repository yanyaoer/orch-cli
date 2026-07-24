import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertKnownFlags, CliError, flagBool, flagString, printJson, readStdinText, type ParsedArgs } from "./cli.ts";
import { randomHex } from "./hash.ts";
import { readJsonFile } from "./json.ts";
import { isTerminal } from "./overview.ts";
import type { ImplementerResult, RoleResult, RunStatus } from "./types.ts";

// orch prewalk — two-phase implementer run on ONE provider session (after
// stencil.so/blog/prewalk). A guide model explores, writes a validated TODO,
// and lands the first meaningful edit; a cheaper executor model then resumes
// the same session — inheriting the guide's full trajectory and prompt cache,
// not a plan document — and finishes the remaining items. The handoff gate is
// judged host-side from persisted evidence (supervisor git/jj status + the
// guide's result), never from the guide's own claim alone; an unmet gate keeps
// the guide model for the continuation instead of forcing the cheap switch.

const PREWALK_FLAGS = [
  "task",
  "executor-model",
  "guide-model",
  "agent",
  "mr",
  "worktree",
  "tag",
  "timeout-sec",
  "allow-dirty",
] as const;

export const PREWALK_TODO_MIN = 3;
export const PREWALK_TODO_MAX = 10;

export interface PrewalkDeps {
  orchCommand: string[];
}

export interface TodoChecklist {
  checked: number;
  unchecked: number;
  total: number;
}

// Markdown checkboxes in the guide's result summary; the summary is part of
// the persisted result contract, so the TODO survives for audit and gating.
export function parseTodoChecklist(summary: string): TodoChecklist {
  let checked = 0;
  let unchecked = 0;
  for (const line of summary.split("\n")) {
    if (/^\s*[-*]\s+\[[xX]\]\s+\S/.test(line)) checked += 1;
    else if (/^\s*[-*]\s+\[ \]\s+\S/.test(line)) unchecked += 1;
  }
  return { checked, unchecked, total: checked + unchecked };
}

// Docs-only or orch-metadata edits do not count as the executor's in-context
// example; the guide must have touched source, test, or config.
export function meaningfulChangedFiles(files: string[]): string[] {
  return files.filter((file) => {
    const path = file.trim();
    if (!path) return false;
    if (/\.(md|markdown|txt)$/i.test(path)) return false;
    if (path === ".orch" || path.startsWith(".orch/")) return false;
    return true;
  });
}

// Changed paths from the supervisor's status artifact. Accepts both formats:
// `git status --porcelain=v1` ("XY path", "?? path", "R  old -> new") and
// `jj status` ("M path" under a "Working copy changes:" header). Untracked
// files matter here — new files a worker creates never appear in
// changed-files.txt (diff vs base), only in the status output.
export function parseStatusPaths(statusText: string): string[] {
  const paths: string[] = [];
  for (const raw of statusText.split("\n")) {
    const line = raw.trimEnd();
    const match = /^(?:[MADRC?!]{1,2}|\?\?)\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const target = match[1]!;
    paths.push(target.includes(" -> ") ? target.split(" -> ").pop()!.trim() : target.trim());
  }
  return paths;
}

export interface HandoffGateInput {
  state: string;
  verdict: string | null;
  todo: TodoChecklist;
  changedFiles: string[];
  resumable: boolean;
}

export interface HandoffGate {
  ok: boolean;
  alreadyComplete: boolean;
  reasons: string[];
}

export function evaluateHandoffGate(input: HandoffGateInput): HandoffGate {
  const reasons: string[] = [];
  if (input.state !== "done") reasons.push(`guide run ended ${input.state}`);
  if (input.verdict !== "completed") reasons.push(`guide verdict ${input.verdict ?? "missing"}`);
  if (input.todo.total < PREWALK_TODO_MIN || input.todo.total > PREWALK_TODO_MAX) {
    reasons.push(`todo checklist has ${input.todo.total} items (need ${PREWALK_TODO_MIN}-${PREWALK_TODO_MAX})`);
  }
  if (input.todo.checked < 1) reasons.push("no todo item is checked off");
  const meaningful = meaningfulChangedFiles(input.changedFiles);
  if (meaningful.length === 0) reasons.push("no meaningful edit (source/test/config) recorded");
  if (!input.resumable) reasons.push("guide run recorded no resumable provider session");
  const alreadyComplete = reasons.length === 0 && input.todo.unchecked === 0;
  return { ok: reasons.length === 0 && !alreadyComplete, alreadyComplete, reasons };
}

export function buildGuideTask(task: string): string {
  return [
    "## Prewalk: guide phase",
    "You are the GUIDE. A cheaper executor model will RESUME this exact session",
    "to finish the task, inheriting everything you read and did. Therefore:",
    `1. Explore the repo only as far as needed to plan confidently.`,
    `2. Write a TODO checklist of ${PREWALK_TODO_MIN}-${PREWALK_TODO_MAX} items covering the WHOLE task; every`,
    '   item must embed its own validation ("… — validate: <command or check>").',
    "3. Implement ONLY the first item as a real source/test/config edit",
    "   (docs-only edits do not count). Keep it small but complete: it is the",
    "   in-context example the executor will imitate.",
    "4. Stop after the first item. Do not start the remaining items.",
    "Result contract: in the implementer result, `summary` MUST contain the full",
    'checklist as markdown checkboxes — the finished first item as "- [x] …",',
    'every remaining item as "- [ ] …". `changed_files` lists your real edits.',
    "",
    "## Task",
    task,
  ].join("\n");
}

export function buildExecutorTask(task: string, handoff: boolean): string {
  const header = handoff
    ? [
        "## Prewalk: executor phase",
        "You are resuming the guide session. The TODO checklist and the finished",
        "first item are already in this session; that first edit is your example.",
      ]
    : [
        "## Prewalk: continuation (handoff gate not met — same model continues)",
        "Finish the task you started in this session.",
      ];
  return [
    ...header,
    "Continue with the remaining unchecked TODO items IN ORDER:",
    "- run each item's validation before checking it off;",
    "- do not re-plan, re-read files already read, or revert earlier edits",
    "  unless a validation fails;",
    "- if one item's validation fails twice, stop and report verdict \"failed\"",
    "  with what you learned instead of thrashing.",
    "Result contract: `summary` must contain the final checklist state;",
    "`changed_files` must list ALL files changed across both phases.",
    "",
    "## Task (unchanged)",
    task,
  ].join("\n");
}

interface RunHandle {
  run_id: string;
  run_dir: string;
  status_path: string;
  result_path: string;
}

async function spawnRunCreate(deps: PrewalkDeps, argv: string[], worktree: string): Promise<RunHandle> {
  const proc = Bun.spawn([...deps.orchCommand, "run", "create", ...argv, "--json"], {
    cwd: worktree,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new CliError(`orch run create failed: ${(stderr.trim() || stdout.trim()).slice(0, 800)}`);
  const payload = JSON.parse(stdout) as { run_id: string; status_path: string; result_path?: string };
  return {
    run_id: payload.run_id,
    run_dir: dirname(payload.status_path),
    status_path: payload.status_path,
    result_path: payload.result_path ?? `${dirname(payload.status_path)}/result.json`,
  };
}

async function waitRun(handle: RunHandle, label: string): Promise<RunStatus> {
  let lastState = "";
  for (;;) {
    const status = readJsonFile<RunStatus | null>(handle.status_path, null);
    if (status && status.state !== lastState) {
      lastState = status.state;
      process.stderr.write(`[orch prewalk] ${label} ${handle.run_id}: ${status.state}\n`);
    }
    if (status && isTerminal(status.state)) return status;
    await new Promise((resolveTick) => setTimeout(resolveTick, 2000));
  }
}

// Host-side edit evidence: supervisor status artifact first (covers untracked
// files), guide-reported changed_files as fallback when artifacts are absent.
function guideChangedFiles(runDir: string, result: ImplementerResult | null): string[] {
  try {
    const statusText = readFileSync(`${runDir}/artifacts/git-status.txt`, "utf8");
    const paths = parseStatusPaths(statusText);
    if (paths.length > 0) return paths;
  } catch {
    // fall through to the result-reported list
  }
  return result?.changed_files ?? [];
}

function readImplementerResult(path: string): ImplementerResult | null {
  const result = readJsonFile<RoleResult | null>(path, null);
  return result && result.schema === "orch.result/implementer/v1" ? result : null;
}

function utcCompact(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export async function prewalkCommand(args: ParsedArgs, deps: PrewalkDeps): Promise<number> {
  assertKnownFlags(args, "prewalk", PREWALK_FLAGS);
  const taskFlag = flagString(args, "task", "");
  if (!taskFlag) throw new CliError("usage: orch prewalk --task <file|-> --executor-model <ref> [flags]");
  const task = (taskFlag === "-" ? await readStdinText() : readFileSync(taskFlag, "utf8")).trim();
  if (!task) throw new CliError("task text is empty");
  const executorModel = flagString(args, "executor-model", "").trim();
  if (!executorModel) throw new CliError("--executor-model is required: the cheaper model that resumes the guide session");
  const guideModel = args.flags.has("guide-model") ? flagString(args, "guide-model").trim() : null;
  if (guideModel === "") throw new CliError("--guide-model must not be empty");
  const agent = flagString(args, "agent", "codex");
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  if (!existsSync(worktree)) throw new CliError(`worktree not found: ${worktree}`);
  const mr = flagString(args, "mr", `prewalk-${utcCompact()}-${randomHex(3)}`);
  const tag = flagString(args, "tag", "prewalk");
  const timeoutSec = args.flags.has("timeout-sec") ? flagString(args, "timeout-sec") : null;
  const allowDirty = flagBool(args, "allow-dirty");

  const taskDir = mkdtempSync(join(tmpdir(), "orch-prewalk-"));
  const guideTaskPath = join(taskDir, "guide-task.md");
  writeFileSync(guideTaskPath, buildGuideTask(task), "utf8");

  const guideArgv = [
    "--mr", mr,
    "--role", "implementer",
    "--agent", agent,
    // Guide gets the bare tag so the executor's `<tag>-exec` stays in the same
    // tag family: the session-chain guard treats prefix-related tags as the
    // same task and allows the deliberate two-run chain without an override.
    "--tag", tag,
    "--worktree", worktree,
    "--task", guideTaskPath,
    ...(guideModel ? ["--model", guideModel] : []),
    ...(timeoutSec ? ["--timeout-sec", timeoutSec] : []),
    ...(allowDirty ? ["--allow-dirty"] : []),
  ];
  const guide = await spawnRunCreate(deps, guideArgv, worktree);
  const guideStatus = await waitRun(guide, "guide");
  const guideResult = readImplementerResult(guide.result_path);
  if (guideStatus.state !== "done") {
    throw new CliError(
      `guide run ${guide.run_id} ended ${guideStatus.state}; inspect: orch result --mr ${mr} --run ${guide.run_id} --worktree ${worktree}`,
    );
  }

  const todo = parseTodoChecklist(guideResult?.summary ?? "");
  const changedFiles = guideChangedFiles(guide.run_dir, guideResult);
  const gate = evaluateHandoffGate({
    state: guideStatus.state,
    verdict: guideResult?.verdict ?? null,
    todo,
    changedFiles,
    resumable: Boolean(guideStatus.provider_resume_id ?? guideStatus.provider_session_id),
  });
  process.stderr.write(
    gate.ok
      ? `[orch prewalk] handoff gate met: ${todo.checked}/${todo.total} todo done, ${meaningfulChangedFiles(changedFiles).length} meaningful edit(s); executor takes over on ${executorModel}\n`
      : gate.alreadyComplete
        ? "[orch prewalk] guide finished every todo item; no executor phase needed\n"
        : `[orch prewalk] handoff gate NOT met (${gate.reasons.join("; ")}); guide model keeps the session\n`,
  );

  let executor: RunHandle | null = null;
  let executorStatus: RunStatus | null = null;
  if (!gate.alreadyComplete) {
    if (!gate.ok && !(guideStatus.provider_resume_id ?? guideStatus.provider_session_id)) {
      throw new CliError(`guide run ${guide.run_id} is not resumable; cannot continue in either model`);
    }
    const executorTaskPath = join(taskDir, "executor-task.md");
    writeFileSync(executorTaskPath, buildExecutorTask(task, gate.ok), "utf8");
    const executorArgv = [
      "--resume-from", guide.run_id,
      "--mr", mr,
      "--tag", `${tag}-exec`,
      "--worktree", worktree,
      "--task", executorTaskPath,
      // Gate unmet → omit --model: the session's own (guide) model continues.
      ...(gate.ok ? ["--model", executorModel] : []),
      ...(timeoutSec ? ["--timeout-sec", timeoutSec] : []),
      ...(allowDirty ? ["--allow-dirty"] : []),
    ];
    executor = await spawnRunCreate(deps, executorArgv, worktree);
    executorStatus = await waitRun(executor, gate.ok ? "executor" : "continuation");
  }

  const executorResult = executor ? readImplementerResult(executor.result_path) : null;
  const succeeded = gate.alreadyComplete || (executorStatus?.state === "done" && executorResult?.verdict === "completed");
  printJson({
    prewalk: "done",
    mr,
    worktree,
    guide_run: {
      run_id: guide.run_id,
      model: guideModel,
      state: guideStatus.state,
      verdict: guideResult?.verdict ?? null,
      todo,
      changed_files: changedFiles,
    },
    handoff: { ok: gate.ok, already_complete: gate.alreadyComplete, reasons: gate.reasons },
    executor_run: executor
      ? {
          run_id: executor.run_id,
          model: gate.ok ? executorModel : guideModel,
          state: executorStatus?.state ?? null,
          verdict: executorResult?.verdict ?? null,
        }
      : null,
    next: [
      `orch status --mr ${mr} --worktree ${worktree}`,
      ...(executor ? [`orch result --mr ${mr} --run ${executor.run_id} --worktree ${worktree}`] : []),
      `orch decision accept --mr ${mr} --run ${executor?.run_id ?? guide.run_id} --reason "prewalk reviewed"`,
    ],
  });
  return succeeded ? 0 : 1;
}
