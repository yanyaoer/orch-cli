import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSpec } from "./types.ts";
import { evaluateHandoffGate, meaningfulChangedFiles, parseStatusPaths, parseTodoChecklist } from "./prewalk.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-prewalk-test-"));
  tempDirs.push(dir);
  return dir;
}

const GUIDE_SUMMARY = [
  "Prewalk todo:",
  "- [x] Add LruCache skeleton in src/cache.ts — validate: bun test src/cache.test.ts",
  "- [ ] Implement eviction on capacity — validate: bun test src/cache.test.ts",
  "- [ ] Wire cache into resolver — validate: bun test",
  "- [ ] Add eviction edge-case tests — validate: bun test src/cache.test.ts",
].join("\n");

test("parseTodoChecklist counts checked and unchecked checkbox lines", () => {
  expect(parseTodoChecklist(GUIDE_SUMMARY)).toEqual({ checked: 1, unchecked: 3, total: 4 });
  expect(parseTodoChecklist("no checklist here")).toEqual({ checked: 0, unchecked: 0, total: 0 });
  expect(parseTodoChecklist("* [X] star style\n  - [ ] indented")).toEqual({ checked: 1, unchecked: 1, total: 2 });
});

test("parseStatusPaths reads git porcelain and jj status lines, including untracked and renames", () => {
  const git = [" M src/cache.ts", "?? src/cache.test.ts", "R  old.ts -> new.ts", ""].join("\n");
  expect(parseStatusPaths(git)).toEqual(["src/cache.ts", "src/cache.test.ts", "new.ts"]);
  const jj = ["Working copy changes:", "M src/cache.ts", "A src/cache.test.ts", "Working copy : abc123"].join("\n");
  expect(parseStatusPaths(jj)).toEqual(["src/cache.ts", "src/cache.test.ts"]);
});

test("meaningfulChangedFiles drops docs and orch metadata", () => {
  expect(meaningfulChangedFiles(["README.md", "notes.txt", ".orch/state.json", "src/cache.ts"])).toEqual(["src/cache.ts"]);
});

test("evaluateHandoffGate: pass, fail reasons, and already-complete", () => {
  const base = {
    state: "done",
    verdict: "completed" as string | null,
    todo: { checked: 1, unchecked: 3, total: 4 },
    changedFiles: ["src/cache.ts"],
    resumable: true,
  };
  expect(evaluateHandoffGate(base)).toEqual({ ok: true, alreadyComplete: false, reasons: [] });

  const failed = evaluateHandoffGate({
    ...base,
    todo: { checked: 0, unchecked: 2, total: 2 },
    changedFiles: ["README.md"],
    resumable: false,
  });
  expect(failed.ok).toBe(false);
  expect(failed.reasons).toHaveLength(4);

  const complete = evaluateHandoffGate({ ...base, todo: { checked: 4, unchecked: 0, total: 4 } });
  expect(complete).toEqual({ ok: false, alreadyComplete: true, reasons: [] });
});

async function runOrch(
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "src/orch.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function runCmd(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`${args.join(" ")} failed`);
}

async function initRepo(worktree: string): Promise<void> {
  await runCmd(["git", "init"], worktree);
  await runCmd(["git", "remote", "add", "origin", "git@github.com:example/prewalk.git"], worktree);
  await runCmd(
    ["git", "-c", "user.email=orch@example.com", "-c", "user.name=orch", "commit", "--allow-empty", "-m", "init"],
    worktree,
  );
}

function findSpec(stateHome: string, runId: string): RunSpec {
  const matches = [...new Bun.Glob(`**/runs/${runId}/spec.json`).scanSync({ cwd: stateHome })];
  if (matches.length !== 1) throw new Error(`expected one spec for ${runId}, found ${matches.length}`);
  return JSON.parse(readFileSync(join(stateHome, matches[0]!), "utf8")) as RunSpec;
}

interface PrewalkPayload {
  mr: string;
  guide_run: { run_id: string; state: string; verdict: string | null; todo: { total: number } };
  handoff: { ok: boolean; already_complete: boolean; reasons: string[] };
  executor_run: { run_id: string; model: string | null; state: string | null; verdict: string | null } | null;
}

test(
  "prewalk hands the session to the executor model when the gate is met",
  async () => {
    const root = tempDir();
    const stateHome = join(root, "state");
    const worktree = mkdtempSync(join(root, "worktree-"));
    await initRepo(worktree);
    const env = {
      XDG_STATE_HOME: stateHome,
      XDG_CONFIG_HOME: join(root, "config"),
      ORCH_DRIVER_FAKE_RESULT: "1",
      ORCH_DRIVER_FAKE_IMPL_SUMMARY: GUIDE_SUMMARY,
      ORCH_DRIVER_FAKE_IMPL_EDIT: "src/cache.ts",
    };
    const run = await runOrch(
      ["prewalk", "--task", "-", "--worktree", worktree, "--agent", "codex", "--guide-model", "frontier-x", "--executor-model", "cheap-mini"],
      env,
      "Add an LRU cache with eviction tests.",
    );
    expect(run.exitCode).toBe(0);
    const payload = JSON.parse(run.stdout) as PrewalkPayload;
    expect(payload.handoff).toEqual({ ok: true, already_complete: false, reasons: [] });
    expect(payload.guide_run.todo.total).toBe(4);
    expect(payload.executor_run?.verdict).toBe("completed");

    const guideSpec = findSpec(stateHome, payload.guide_run.run_id);
    expect(guideSpec.model).toBe("frontier-x");
    expect(guideSpec.tag).toBe("prewalk");

    const execSpec = findSpec(stateHome, payload.executor_run!.run_id);
    expect(execSpec.model).toBe("cheap-mini");
    expect(execSpec.tag).toBe("prewalk-exec");
    expect(execSpec.provider_session_mode).toBe("resume_exact");
    expect(execSpec.provider_session_id).toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  },
  120000,
);

test(
  "prewalk keeps the guide model when the gate is not met",
  async () => {
    const root = tempDir();
    const stateHome = join(root, "state");
    const worktree = mkdtempSync(join(root, "worktree-"));
    await initRepo(worktree);
    const env = {
      XDG_STATE_HOME: stateHome,
      XDG_CONFIG_HOME: join(root, "config"),
      ORCH_DRIVER_FAKE_RESULT: "1",
      // No checklist and no edit: the gate must refuse the cheap switch.
      ORCH_DRIVER_FAKE_IMPL_SUMMARY: "explored the repo, nothing structured",
    };
    const run = await runOrch(
      ["prewalk", "--task", "-", "--worktree", worktree, "--agent", "codex", "--guide-model", "frontier-x", "--executor-model", "cheap-mini"],
      env,
      "Add an LRU cache with eviction tests.",
    );
    expect(run.exitCode).toBe(0);
    const payload = JSON.parse(run.stdout) as PrewalkPayload;
    expect(payload.handoff.ok).toBe(false);
    expect(payload.handoff.reasons.length).toBeGreaterThan(0);
    expect(payload.executor_run?.model).toBe("frontier-x");

    const execSpec = findSpec(stateHome, payload.executor_run!.run_id);
    // Omitted --model on resume: the session's own model continues.
    expect(execSpec.model).toBe("frontier-x");
    expect(execSpec.provider_session_mode).toBe("resume_exact");
  },
  120000,
);
