import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertKnownFlags, CliError, flagBool, flagString, printJson, readStdinText, type ParsedArgs } from "./cli.ts";
import { randomHex } from "./hash.ts";
import { readJsonFile } from "./json.ts";
import { isTerminal } from "./overview.ts";
import { vcsKind } from "./vcs.ts";
import type { ImplementerResult, RoleResult, RunSpec, RunStatus } from "./types.ts";

// orch prewalk — two-phase implementer run on ONE provider session (after
// stencil.so/blog/prewalk). A guide model explores, writes a validated TODO,
// and lands the first meaningful edit; a cheaper executor model then resumes
// the same session — inheriting the guide's full trajectory and prompt cache,
// not a plan document — and finishes the remaining items. The handoff gate is
// judged host-side from persisted evidence, never from the guide's claim: the
// edit signal is the VCS status delta against a pre-run baseline, and the
// gate fails closed when that evidence is unavailable. An unmet gate keeps
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

export interface TodoItem {
  checked: boolean;
  text: string;
}

export interface TodoChecklist {
  items: TodoItem[];
  checked: number;
  unchecked: number;
  total: number;
}

// Ordered markdown checkboxes from the guide's result summary; the summary is
// part of the persisted result contract, so the TODO survives for audit and
// gating. Order matters: the gate verifies the FIRST item is the checked one.
export function parseTodoChecklist(summary: string): TodoChecklist {
  const items: TodoItem[] = [];
  for (const line of summary.split("\n")) {
    const match = /^\s*[-*]\s+\[([ xX])\]\s+(\S.*)$/.exec(line);
    if (match) items.push({ checked: match[1] !== " ", text: match[2]!.trim() });
  }
  const checked = items.filter((item) => item.checked).length;
  return { items, checked, unchecked: items.length - checked, total: items.length };
}

// Docs-only or orch-metadata edits do not count as the executor's in-context
// example; the guide must have touched source, test, or config. A bare
// directory entry (git's collapsed untracked-dir form, trailing "/") cannot
// be classified, so it is excluded — erring toward keeping the guide model.
export function meaningfulChangedFiles(files: string[]): string[] {
  return files.filter((file) => {
    const path = file.trim();
    if (!path) return false;
    if (path.endsWith("/")) return false;
    if (/\.(md|markdown|txt)$/i.test(path)) return false;
    if (path === ".orch" || path.startsWith(".orch/")) return false;
    return true;
  });
}

// Git C-quotes unusual paths in porcelain output (`"docs/read me.md"`, octal
// escapes for non-ASCII bytes). Decode byte-accurately so extension-based
// classification cannot be dodged by a quoted docs path.
export function unquoteGitPath(raw: string): string {
  const s = raw.trim();
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  // Iterate code points, not UTF-16 units: with core.quotePath=false a quoted
  // path can contain literal non-BMP characters, and splitting a surrogate
  // pair through Buffer.from would mangle them.
  const cps = Array.from(s.slice(1, -1));
  const bytes: number[] = [];
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i]!;
    if (ch !== "\\") {
      for (const byte of Buffer.from(ch, "utf8")) bytes.push(byte);
      continue;
    }
    const next = cps[i + 1] ?? "";
    if (/^[0-7]$/.test(next)) {
      bytes.push(parseInt(cps.slice(i + 1, i + 4).join(""), 8));
      i += 3;
      continue;
    }
    const escapes: Record<string, string> = { "\\": "\\", '"': '"', t: "\t", n: "\n", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v" };
    for (const byte of Buffer.from(escapes[next] ?? next, "utf8")) bytes.push(byte);
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

// Rename targets are "old -> new"; the old side may be a C-quoted field that
// itself contains " -> ", so a plain split on the arrow corrupts the
// destination. Scan past a quoted old field first, then split once.
export function renameDestination(target: string): string {
  if (target.startsWith('"')) {
    for (let i = 1; i < target.length; i++) {
      if (target[i] === "\\") {
        i += 1;
      } else if (target[i] === '"') {
        const rest = target.slice(i + 1);
        return rest.startsWith(" -> ") ? rest.slice(4) : target;
      }
    }
    return target;
  }
  const arrow = target.indexOf(" -> ");
  return arrow === -1 ? target : target.slice(arrow + 4);
}

// Changed paths from a VCS status text. Accepts both formats the supervisor
// artifact can contain: `git status --porcelain=v1` ("XY path", "?? path",
// "R  old -> new", conflicts "UU", type changes "T") and `jj status`
// ("M path" under a "Working copy changes:" header). Untracked files matter
// here — new files a worker creates never appear in changed-files.txt (diff
// vs base), only in the status output.
export function parseStatusPaths(statusText: string): string[] {
  const paths: string[] = [];
  for (const raw of statusText.split("\n")) {
    const match = /^(?:[MADRCUT?!]{1,2}|\?\?)\s+(.+)$/.exec(raw.trim());
    if (!match) continue;
    paths.push(unquoteGitPath(renameDestination(match[1]!)));
  }
  return paths;
}

export interface HandoffGateInput {
  state: string;
  verdict: string | null;
  todo: TodoChecklist;
  // Run-scoped edit evidence (status delta vs the pre-run baseline);
  // null = host evidence unavailable, which fails the gate closed.
  changedFiles: string[] | null;
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
  const todo = input.todo;
  if (todo.total < PREWALK_TODO_MIN || todo.total > PREWALK_TODO_MAX) {
    reasons.push(`todo checklist has ${todo.total} items (need ${PREWALK_TODO_MIN}-${PREWALK_TODO_MAX})`);
  }
  // The first item must be the completed one; extra checked items beyond it
  // are wasted guide budget but not a handoff risk, so they do not fail the
  // gate. Items without an embedded validation step break the executor's
  // check-then-tick contract and do.
  if (todo.total > 0 && !todo.items[0]!.checked) reasons.push("first todo item is not checked off");
  // The guide contract demands an explicit "validate: <command or check>"
  // marker per item; a mere mention of the word validation is not a check.
  const unvalidated = todo.items.filter((item) => !/validate:\s*\S/i.test(item.text)).length;
  if (unvalidated > 0) reasons.push(`${unvalidated} todo item(s) lack a "validate:" step`);
  if (input.changedFiles === null) {
    reasons.push("host-side edit evidence unavailable (status artifact missing)");
  } else if (meaningfulChangedFiles(input.changedFiles).length === 0) {
    reasons.push("no meaningful edit (source/test/config) beyond the pre-run baseline");
  }
  // Content completion is independent of resumability: a fully checked
  // checklist needs no second run, so a missing session id must not block it.
  const alreadyComplete = reasons.length === 0 && todo.unchecked === 0;
  if (!alreadyComplete && !input.resumable) reasons.push("guide run recorded no resumable provider session");
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

export function buildExecutorTask(task: string, gate: HandoffGate): string {
  const header = gate.ok
    ? [
        "## Prewalk: executor phase",
        "You are resuming the guide session. The TODO checklist and the finished",
        "first item are already in this session; that first edit is your example.",
      ]
    : [
        "## Prewalk: continuation (handoff gate not met — same model continues)",
        "The host-side gate found these gaps in your previous turn:",
        ...gate.reasons.map((reason) => `- ${reason}`),
        "Repair them first: (re)write the full TODO checklist per the original",
        "contract (3-10 markdown checkbox items, each with an embedded",
        "validation step) into your result summary, and land the first",
        "meaningful source/test/config edit if none exists yet. Then:",
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

export interface PrewalkOutcome {
  mr: string;
  worktree: string;
  tag: string;
  guide: { run_id: string; model: string | null; state: string; verdict: string | null; todo: TodoChecklist; changed_files: string[] | null };
  gate: HandoffGate;
  executor: { run_id: string; model: string | null; state: string | null; verdict: string | null } | null;
  succeeded: boolean;
}

function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Pure payload assembly so the failure shape is unit-testable: a failed
// outcome must never hand the caller an acceptance command.
export function buildPrewalkPayload(outcome: PrewalkOutcome): Record<string, unknown> {
  const finishing = outcome.executor?.run_id ?? outcome.guide.run_id;
  const base = `--mr ${shq(outcome.mr)} --worktree ${shq(outcome.worktree)}`;
  const next = [
    `orch status ${base}`,
    ...(outcome.executor ? [`orch result --run ${shq(outcome.executor.run_id)} ${base}`] : []),
    ...(outcome.succeeded
      ? [`orch decision accept --run ${shq(finishing)} ${base} --reason 'prewalk reviewed'`]
      : [
          `orch result --run ${shq(outcome.guide.run_id)} ${base}`,
          // The rework tag must stay in the session's tag family (-r<N> is
          // stripped by the guard) or the session-chain guard rejects it.
          `orch run create --resume-from ${shq(finishing)} ${base} --tag ${shq(`${outcome.tag}-exec-r2`)} --task rework.md`,
        ]),
  ];
  return {
    prewalk: outcome.succeeded ? "done" : "failed",
    mr: outcome.mr,
    worktree: outcome.worktree,
    guide_run: {
      run_id: outcome.guide.run_id,
      model: outcome.guide.model,
      state: outcome.guide.state,
      verdict: outcome.guide.verdict,
      todo: { checked: outcome.guide.todo.checked, unchecked: outcome.guide.todo.unchecked, total: outcome.guide.todo.total },
      changed_files: outcome.guide.changed_files,
    },
    handoff: { ok: outcome.gate.ok, already_complete: outcome.gate.alreadyComplete, reasons: outcome.gate.reasons },
    executor_run: outcome.executor,
    next,
  };
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

// Pre-run baseline of already-dirty paths: the gate must not credit the guide
// with edits that existed before it ran. A guide edit to an already-dirty file
// is invisible here — that errs toward keeping the guide model, never toward
// a false cheap switch.
// Known limitation: the baseline is captured before the run starts, so a
// concurrent external edit inside the run window would be attributed to the
// guide. prewalk assumes the caller owns the worktree for the duration, the
// same assumption every write-role run already makes.
export function captureBaselinePaths(worktree: string): string[] {
  const argv =
    vcsKind(worktree) === "jj"
      ? ["jj", "status"]
      : ["git", "-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"];
  const proc = Bun.spawnSync(argv, { cwd: worktree, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new CliError(`cannot capture VCS baseline in ${worktree}: ${proc.stderr.toString().trim().slice(0, 300)}`);
  }
  return parseStatusPaths(proc.stdout.toString());
}

// Host-side, run-scoped edit evidence: union of the supervisor's terminal
// status artifact (covers untracked files) and changed-files.txt (covers
// edits a worker committed against policy), minus the pre-run baseline.
// Returns null — failing the gate closed — when the status artifact is
// missing; the guide's self-reported changed_files is never trusted.
export function guideEditEvidence(runDir: string, baseline: string[]): string[] | null {
  let statusPaths: string[];
  try {
    statusPaths = parseStatusPaths(readFileSync(`${runDir}/artifacts/git-status.txt`, "utf8"));
  } catch {
    return null;
  }
  let diffPaths: string[] = [];
  try {
    // `git diff --name-only` C-quotes unusual paths exactly like status
    // output; decode so both sources and the baseline share one canonical
    // representation (a raw quoted docs path must not evade classification).
    diffPaths = readFileSync(`${runDir}/artifacts/changed-files.txt`, "utf8")
      .split("\n")
      .map((line) => unquoteGitPath(line))
      .filter(Boolean);
  } catch {
    // status artifact alone is sufficient evidence
  }
  const before = new Set(baseline);
  return [...new Set([...statusPaths, ...diffPaths])].filter((path) => !before.has(path));
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

  const baseline = captureBaselinePaths(worktree);
  const taskDir = mkdtempSync(join(tmpdir(), "orch-prewalk-"));
  try {
    const guideTaskPath = join(taskDir, "guide-task.md");
    writeFileSync(guideTaskPath, buildGuideTask(task), "utf8");

    const guideArgv = [
      "--mr", mr,
      "--role", "implementer",
      "--agent", agent,
      // Guide gets the bare tag so the executor's `<tag>-exec` stays in the
      // same tag family: the session-chain guard treats prefix-related tags as
      // the same task and allows the deliberate two-run chain.
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
        `guide run ${guide.run_id} ended ${guideStatus.state}; inspect: orch result --mr ${shq(mr)} --run ${guide.run_id} --worktree ${shq(worktree)}`,
      );
    }
    // The effective model comes from the persisted spec: a configured role
    // default fills it even when --guide-model was omitted.
    const guideSpec = readJsonFile<RunSpec | null>(`${guide.run_dir}/spec.json`, null);
    const effectiveGuideModel = guideSpec?.model ?? guideModel;

    const todo = parseTodoChecklist(guideResult?.summary ?? "");
    const changedFiles = guideEditEvidence(guide.run_dir, baseline);
    const gate = evaluateHandoffGate({
      state: guideStatus.state,
      verdict: guideResult?.verdict ?? null,
      todo,
      changedFiles,
      resumable: Boolean(guideStatus.provider_resume_id ?? guideStatus.provider_session_id),
    });
    process.stderr.write(
      gate.ok
        ? `[orch prewalk] handoff gate met: ${todo.checked}/${todo.total} todo done, ${meaningfulChangedFiles(changedFiles ?? []).length} meaningful edit(s); executor takes over on ${executorModel}\n`
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
      writeFileSync(executorTaskPath, buildExecutorTask(task, gate), "utf8");
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
    printJson(
      buildPrewalkPayload({
        mr,
        worktree,
        tag,
        guide: {
          run_id: guide.run_id,
          model: effectiveGuideModel,
          state: guideStatus.state,
          verdict: guideResult?.verdict ?? null,
          todo,
          changed_files: changedFiles,
        },
        gate,
        executor: executor
          ? {
              run_id: executor.run_id,
              model: gate.ok ? executorModel : effectiveGuideModel,
              state: executorStatus?.state ?? null,
              verdict: executorResult?.verdict ?? null,
            }
          : null,
        succeeded,
      }),
    );
    return succeeded ? 0 : 1;
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
}
