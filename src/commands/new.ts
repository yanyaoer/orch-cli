// orch new: one-sentence task -> plan run -> terminal confirmation -> controller execution.
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ResearcherResult, RoleResult, RunStatus } from "../types.ts";
import { claimNewMrDir, getRepoIdentity, mrStateDir } from "../paths.ts";
import { readJsonFile, writeTextAtomic } from "../json.ts";
import { mrRefFromText } from "../forge.ts";
import { collectMrRuns, isTerminal } from "../overview.ts";
import { readMailAgentsConfig, readOrchConfig } from "../config.ts";
import { createInterface, type Interface as ReadlineInterface, type ReadLineOptions } from "node:readline";

import { CliError, assertKnownFlags, flagBool, flagString, printJson, type ParsedArgs } from "../cli.ts";
import { reconcileDispatchWatch } from "../dispatch.ts";
import { classifyNewOpenQuestions, evaluateNewExecution, validateNewPlanMarkdown, type NewExecutionRun } from "../new-flow.ts";
import { orchCommand, scanMrRuns, writeForgeRef } from "../run-store.ts";
import { resultVerdict } from "../render.ts";

const NEW_FLAGS = ["workspace", "worktree", "mr", "model", "timeout-sec", "yes"] as const;

function newMrSlug(description: string, now = new Date()): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  // Non-ASCII descriptions (e.g. Chinese) slug to nothing; fall back to the date.
  return slug || now.toISOString().slice(0, 10).replaceAll("-", "");
}

function newPlanTask(mr: string, description: string): string {
  return [
    "# orch new — planning phase",
    "",
    "Inspect the actual repository and return a self-contained execution plan; change nothing.",
    `Thread/MR for the eventual runs: ${mr}`,
    "",
    "## Task request",
    description,
    "",
    "## Deliverable (orch.result/researcher/v1)",
    "Put the plan in recommendation using exactly this Markdown grammar:",
    "",
    "## Destination",
    "1-2 lines describing the observable finished state.",
    "",
    "## Out of scope",
    "Explicit exclusions, or `None`.",
    "",
    "## Tasks (now)",
    "### kebab-case-task-name",
    "- Role: implementer|reviewer|verifier",
    "- After: none|earlier-task-name[, earlier-task-name]",
    "- Spec: one self-contained paragraph with prerequisites and constraints",
    "- Acceptance:",
    "  - one observable check",
    "",
    "## Later (not yet specified)",
    "Optional follow-up outside this Destination, or `None`. Anything required",
    "to reach Destination must be a Tasks (now) item, even when it has prerequisites.",
    "",
    "Rules:",
    "- Include at least one task. After may name only earlier tasks; use `none`",
    "  for the initial frontier. Order tasks by execution dependency.",
    "- Keep implementation choices open unless the repo or request makes them constraints.",
    "- implementer Specs verify once, scoped to the touched modules, after all edits;",
    "  put repo-wide or full-module test suites in a separate verifier task",
    "  (After: that implementer), never inside the implementer's loop.",
    "- recommendation is the current source of truth: no historical commentary or superseded choices.",
    "- Each open_questions entry must end with either `— recommended: <safe default>`",
    "  or `— blocking: <why execution cannot safely choose>`. Use blocking only when",
    "  no defensible default exists. Leave open_questions empty when unambiguous.",
    "- Put risks and alternatives in their schema fields, not extra recommendation headings.",
  ].join("\n");
}

function newPlanRevisionTask(answer: string, acceptDefaults = false): string {
  return [
    "# orch new — final plan revision",
    "",
    acceptDefaults ? "The human accepted every recommended default below:" : "Human answer / amendment:",
    "",
    answer,
    "",
    "Return a new self-contained orch.result/researcher/v1 result. Integrate these",
    "choices directly into recommendation, remove superseded choices and historical",
    "commentary, and remove every resolved item from open_questions. Keep the exact",
    "Destination / Out of scope / Tasks (now) / Later (not yet specified) grammar",
    "from the planning request. Do not merely append an answers section.",
  ].join("\n");
}

function newExecTask(mr: string, worktree: string, plan: string): string {
  return [
    "# orch new — execution controller",
    "",
    "You are HEADLESS and NON-INTERACTIVE. Execute `orch ...` commands directly.",
    "You may inspect files but never edit them; dispatch workers for all changes.",
    `Thread/MR: ${mr}`,
    `Worktree: ${worktree}`,
    "",
    "## Final resolved plan (sole execution authority)",
    plan,
    "",
    "## Protocol",
    "- Dispatch only tasks whose `After` dependencies have accepted results. Later",
    "  is explicitly outside this run's Destination: do not dispatch it.",
    "- Author every worker task inline; workers do not share your context:",
    `    orch fanout --thread ${mr} --role <role> --task - <<'EOF' ... EOF`,
    `    orch cross-review --thread ${mr} --task - <<'EOF' ... EOF`,
    `    orch run create --mr ${mr} --role <role> --agent <codex|claude|pi|omp> --tag <name> --task - <<'EOF' ... EOF`,
    "    orch run create --resume-from <run_id> --tag <name> --task - <<'EOF' ... EOF",
    "- Put the complete Spec, constraints, relevant ADR/spec excerpts, and Acceptance",
    "  checks into each worker task. Tag direct/rework runs with the plan task name;",
    "  fanout/cross-review auto-tag their runs.",
    "- Implementer tasks verify once, scoped to the modules they touch; dispatch",
    "  repo-wide or full-module test suites as a verifier run after the implementer",
    "  result is accepted, never inside the implementer's loop.",
    `- Reconcile persisted evidence: orch wait --thread ${mr}; inspect each result;`,
    `  record orch decision accept|rework --mr ${mr} --run <id> --reason '...'.`,
    "- Use semantic judgment for decisions, but stop after 2 reworks for one task.",
    "- Finish only after every dispatched run is terminal and has a decision. Report",
    "  unresolved blockers instead of claiming success. Return only controller result JSON.",
  ].join("\n");
}

// Terminal Q&A input rides node:readline in terminal mode: per-character line
// editing (CJK/emoji deletes stay atomic, width math is east-asian aware —
// verified identical to Node v24), emacs keybindings (C-a/C-e/C-w/C-u, arrows),
// and history across replan rounds. Bun's process.stdin/stderr typings clash
// with node:readline's stream types; the casts are runtime-safe.
function newReadline(): ReadlineInterface {
  return createInterface({ input: process.stdin, output: process.stderr } as unknown as ReadLineOptions);
}

function newAskLine(rl: ReadlineInterface, promptText: string): Promise<string> {
  return new Promise((resolveAnswer) => rl.question(promptText, resolveAnswer));
}

// `e` at the prompt: multi-line answers go through $VISUAL/$EDITOR on a draft
// file seeded with the open questions (git-commit style; `#` lines stripped).
// Returns null when the editor exits non-zero (vim `:cq`) — caller re-prompts.
async function newEditAnswer(mrDir: string, rl: ReadlineInterface, openQuestions: string[]): Promise<string | null> {
  const draftPath = `${mrDir}/tasks/answer-draft.md`;
  writeTextAtomic(
    draftPath,
    [
      "# orch new — 多行回答/修改意见。# 开头的行会被忽略;保存退出即提交;清空(或只留注释)=按当前方案执行;:cq 退出=放弃本次回答。",
      ...openQuestions.map((question, index) => `# Q${index + 1}. ${question.replaceAll("\n", " ")}`),
      "",
    ].join("\n"),
  );
  const editor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || "vi";
  // Hand the terminal to the editor: drop raw mode while it runs, restore after.
  rl.pause();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const proc = Bun.spawn(["/bin/sh", "-c", `${editor} "$1"`, "orch-new-editor", draftPath], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const code = await proc.exited;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  rl.resume();
  if (code !== 0) {
    process.stderr.write(`[orch new] editor exited ${code}; 本次回答已丢弃\n`);
    return null;
  }
  return readFileSync(draftPath, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}

interface NewRunHandle {
  run_id: string;
  status_path: string;
  result_path: string;
}

// Spawn `orch run create ... --json` as a subprocess (same pattern as mail
// claim) so newCommand's own stdout stays reserved for its final JSON payload.
async function newSpawnRunCreate(argv: string[], worktree: string): Promise<NewRunHandle> {
  const proc = Bun.spawn([...orchCommand(), "run", "create", ...argv, "--json"], {
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
  const payload = JSON.parse(stdout) as { run_id: string; status_path: string; result_path?: string; run_dir?: string };
  return {
    run_id: payload.run_id,
    status_path: payload.status_path,
    result_path: payload.result_path ?? `${payload.run_dir}/result.json`,
  };
}

async function newWaitRun(handle: NewRunHandle, label: string): Promise<RunStatus> {
  let lastState = "";
  for (;;) {
    const status = readJsonFile<RunStatus | null>(handle.status_path, null);
    if (status && status.state !== lastState) {
      lastState = status.state;
      process.stderr.write(`[orch new] ${label} ${handle.run_id}: ${status.state}\n`);
    }
    if (status && isTerminal(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function newReadPlanResult(handle: NewRunHandle, status: RunStatus): ResearcherResult {
  const result = readJsonFile<RoleResult | null>(handle.result_path, null);
  if (status.state !== "done" || !result || result.schema !== "orch.result/researcher/v1" || result.verdict !== "completed") {
    throw new CliError(
      `plan run ${handle.run_id} ended ${status.state}${result ? ` (${resultVerdict(result)})` : ""}; inspect: orch result --mr ${status.mr} --run ${handle.run_id} --worktree ${status.worktree}`,
    );
  }
  const validation = validateNewPlanMarkdown(result.recommendation);
  if (!validation.ok) {
    throw new CliError(
      `plan run ${handle.run_id} returned an invalid orch new plan:\n${validation.errors.map((error) => `- ${error}`).join("\n")}\ninspect: orch result --mr ${status.mr} --run ${handle.run_id} --worktree ${status.worktree}`,
    );
  }
  return result;
}

function newRenderPlan(result: ResearcherResult): void {
  const write = (line: string) => process.stderr.write(`${line}\n`);
  write("");
  write("## Proposed plan");
  write(result.recommendation);
  if (result.open_questions.length > 0) {
    write("");
    write("## Open questions");
    result.open_questions.forEach((question, index) => write(`${index + 1}. ${question}`));
  }
  if (result.risks.length > 0) {
    write("");
    write("## Risks");
    for (const risk of result.risks) write(`- ${risk}`);
  }
  write("");
}

function newRecommendedDefaults(result: ResearcherResult): { text: string; blocking: string[] } {
  const questions = classifyNewOpenQuestions(result.open_questions);
  return {
    text: questions.defaults.map((item, index) => `${index + 1}. ${item.question}\n   Accepted default: ${item.value}`).join("\n"),
    blocking: questions.blocking,
  };
}

function newExecutionRuns(repoKey: string, mr: string, baseline: Set<string>, execRunId: string): NewExecutionRun[] {
  return scanMrRuns(repoKey, mr)
    .filter((record): record is typeof record & { status: RunStatus } => record.status !== null)
    .filter((record) => !baseline.has(record.run_id) && record.run_id !== execRunId)
    .map(({ status, result, decision, stale, run_id }) => ({
      run_id,
      role: status.role,
      state: status.state,
      stale,
      verdict: typeof result?.verdict === "string" ? result.verdict : null,
      decision:
        decision && decision.run_id === run_id && (decision.verdict === "accept" || decision.verdict === "rework" || decision.verdict === "close")
          ? decision.verdict
          : null,
    }));
}

export async function newCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "new", NEW_FLAGS);
  const description = (args.positionals[1] ?? "").trim();
  if (!description) throw new CliError("usage: orch new '<task description>' [--workspace <id>] [flags]");
  const yes = flagBool(args, "yes");
  if (!process.stdin.isTTY && !yes) {
    throw new CliError("orch new is interactive; pass --yes to accept the recommended plan without confirmation");
  }

  let worktree: string;
  if (args.flags.has("worktree")) {
    worktree = resolve(flagString(args, "worktree"));
  } else if (args.flags.has("workspace")) {
    const id = flagString(args, "workspace");
    const workspace = readOrchConfig().workspaces[id];
    if (!workspace) throw new CliError(`unknown workspace: ${id} (register with: orch workspace add --id ${id} --path <path>)`);
    worktree = workspace.path;
  } else {
    worktree = process.cwd();
  }

  const repo = await getRepoIdentity(worktree);
  let mr: string;
  let mrDir: string;
  if (args.flags.has("mr")) {
    // Explicit --mr keeps its reuse semantics and never gets a guessed ref.
    mr = flagString(args, "mr");
    mrDir = mrStateDir(repo.repo_key, mr);
  } else {
    // Exclusive claim: a suffix collision (concurrent orch new or a
    // historical id) must regenerate, never share the other task's state —
    // an inherited forge_ref would publish comments to the other task's MR.
    ({ mr, mrDir } = claimNewMrDir(repo.repo_key, newMrSlug(description)));
    // Pin the forge ref only for the freshly claimed local id, and only when
    // the description names exactly one same-repo MR/PR URL. Mirrored
    // comments are outward side effects; an ambiguous or cross-repo URL
    // fails closed to the plain slug behavior.
    const forgeRef = mrRefFromText(description, repo.remote_url);
    if (forgeRef) writeForgeRef(mrDir, forgeRef);
  }
  mkdirSync(`${mrDir}/tasks`, { recursive: true });

  // The exec controller dispatches through the mail layer; seed the default
  // roster on first use only (a non-empty roster may carry user customization).
  if (Object.keys(readMailAgentsConfig().agents).length === 0) {
    process.stderr.write("[orch new] no mail agents configured; running `orch mail agent defaults`\n");
    const seeded = Bun.spawn([...orchCommand(), "mail", "agent", "defaults"], { cwd: worktree, stdout: "ignore", stderr: "pipe", env: process.env });
    if ((await seeded.exited) !== 0) throw new CliError(`orch mail agent defaults failed: ${await new Response(seeded.stderr).text()}`);
  }

  const passthrough: string[] = ["--model", args.flags.has("model") ? flagString(args, "model") : "fable"];
  if (args.flags.has("timeout-sec")) passthrough.push("--timeout-sec", flagString(args, "timeout-sec"));

  const planTaskPath = `${mrDir}/tasks/plan.md`;
  writeTextAtomic(planTaskPath, newPlanTask(mr, description));
  process.stderr.write(`[orch new] mr ${mr} · worktree ${worktree}\n`);
  let handle = await newSpawnRunCreate(
    ["--mr", mr, "--role", "researcher", "--agent", "claude", "--tag", "plan", "--worktree", worktree, "--task", planTaskPath, ...passthrough],
    worktree,
  );
  process.stderr.write(`[orch new] watch: orch events tail --run ${handle.run_id} --mr ${mr} --native -f\n`);
  const planRuns: string[] = [handle.run_id];
  let plan = newReadPlanResult(handle, await newWaitRun(handle, "plan"));
  newRenderPlan(plan);

  let revision = 1;
  const revisePlan = async (answer: string, acceptDefaults = false): Promise<void> => {
    revision += 1;
    const revisionPath = `${mrDir}/tasks/plan-round-${revision}.md`;
    writeTextAtomic(revisionPath, newPlanRevisionTask(answer, acceptDefaults));
    handle = await newSpawnRunCreate(
      // First-party deliberate chain: replan rounds continue the plan session
      // by design, past any session-chain depth cap.
      ["--resume-from", handle.run_id, "--tag", `plan-r${revision}`, "--task", revisionPath, "--allow-session-chain"],
      worktree,
    );
    planRuns.push(handle.run_id);
    plan = newReadPlanResult(handle, await newWaitRun(handle, "plan"));
    newRenderPlan(plan);
  };

  if (yes) {
    const defaults = newRecommendedDefaults(plan);
    if (defaults.blocking.length > 0) {
      throw new CliError(`orch new --yes cannot answer blocking plan questions:\n${defaults.blocking.map((question) => `- ${question}`).join("\n")}`);
    }
    if (defaults.text) await revisePlan(defaults.text, true);
    if (plan.open_questions.length > 0) {
      throw new CliError(`final plan still has unresolved questions after applying recommended defaults:\n${plan.open_questions.map((question) => `- ${question}`).join("\n")}`);
    }
  } else {
    const rl = newReadline();
    try {
      for (;;) {
        process.stderr.write("回车=按当前方案执行 · 输入回答/修改意见=再规划一轮 · e=编辑器多行回答 · q=放弃\n");
        const raw = (await newAskLine(rl, "> ")).trim();
        if (raw.toLowerCase() === "q") {
          process.stderr.write(`[orch new] aborted; plan run(s) kept for audit under mr ${mr}\n`);
          printJson({ new: mr, worktree, state: "aborted", plan_runs: planRuns });
          return 1;
        }
        const answer = raw.toLowerCase() === "e" ? await newEditAnswer(mrDir, rl, plan.open_questions) : raw;
        if (answer === null) continue;
        if (answer !== "") {
          await revisePlan(answer);
          continue;
        }
        const defaults = newRecommendedDefaults(plan);
        if (defaults.blocking.length > 0) {
          process.stderr.write(`[orch new] execution blocked; answer or amend these questions:\n${defaults.blocking.map((question) => `  - ${question}`).join("\n")}\n`);
          continue;
        }
        if (defaults.text) {
          await revisePlan(defaults.text, true);
          if (plan.open_questions.length > 0) continue;
        }
        break;
      }
    } finally {
      rl.close();
    }
  }

  const execTaskPath = `${mrDir}/tasks/exec.md`;
  writeTextAtomic(execTaskPath, newExecTask(mr, worktree, plan.recommendation));
  const baselineRuns = new Set(collectMrRuns(repo.repo_key, mr).map((run) => run.run_id));
  const execHandle = await newSpawnRunCreate(
    // First-party deliberate chain: the confirmed plan session resumes as the
    // exec controller by design (different tag, same session).
    ["--resume-from", handle.run_id, "--role", "controller", "--tag", "exec", "--task", execTaskPath, "--allow-session-chain"],
    worktree,
  );
  process.stderr.write(`[orch new] executing; follow along: orch wait --thread ${mr} · orch events tail --mr ${mr} -f --native\n`);
  // When config sandbox is on, the controller runs under Seatbelt and cannot
  // spawn workers itself; it enqueues them to the dispatch queue. This
  // unsandboxed parent drains that queue in-process for the controller's whole
  // lifetime, so dispatched workers are spawned host-side with project-write.
  let controllerDone = false;
  const reconcile = reconcileDispatchWatch(orchCommand(), () => controllerDone);
  const execStatus = await newWaitRun(execHandle, "exec").finally(() => {
    controllerDone = true;
  });
  await reconcile;
  const execResult = readJsonFile<RoleResult | null>(execHandle.result_path, null);
  if (execResult && "summary" in execResult) process.stderr.write(`\n[orch new] controller summary: ${execResult.summary}\n`);
  if (execResult && execResult.schema === "orch.result/controller/v1") {
    for (const action of execResult.actions) process.stderr.write(`  - ${action}\n`);
  }

  const controllerOk =
    execStatus.state === "done" &&
    execResult?.schema === "orch.result/controller/v1" &&
    execResult.verdict === "completed";
  const workers = evaluateNewExecution(controllerOk, newExecutionRuns(repo.repo_key, mr, baselineRuns, execHandle.run_id));
  printJson({
    new: mr,
    worktree,
    state: workers.ok ? "completed" : "needs_attention",
    plan_runs: planRuns,
    exec_run: execHandle.run_id,
    exec_state: execStatus.state,
    exec_verdict: execResult ? resultVerdict(execResult) : null,
    workers: {
      total: workers.total,
      handled: workers.handled,
      failed: workers.failed,
      undecided: workers.undecided,
      closed: workers.closed,
      rework_pending: workers.rework_pending,
    },
    follow_up: [`orch verdict --thread ${mr}`, `orch result --mr ${mr} --run ${execHandle.run_id}`, "orch"],
  });
  return workers.ok ? 0 : 1;
}
