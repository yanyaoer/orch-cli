import { expect, test } from "bun:test";
import { DEPRECATED_COMMANDS, warnDeprecatedCommand } from "./deprecation.ts";
import { topLevelHelp } from "./help.ts";

test("a deprecated command warns once per process tree", () => {
  const env: NodeJS.ProcessEnv = {};
  const out: string[] = [];
  warnDeprecatedCommand("mailctl", env, (t) => out.push(t));
  warnDeprecatedCommand("mail", env, (t) => out.push(t));
  expect(out).toHaveLength(1);
  expect(out[0]).toContain("[orch] deprecated: orch mailctl");
  expect(env.ORCH_DEPRECATION_WARNED).toBe("1");
});

test("core commands never warn", () => {
  const out: string[] = [];
  for (const cmd of ["run", "status", "result", "wait", "verdict", "decision", "mirror", "cross-review", "worktree", undefined]) {
    warnDeprecatedCommand(cmd, {}, (t) => out.push(t));
  }
  expect(out).toEqual([]);
});

test("top-level help tags every deprecated command", () => {
  const help = topLevelHelp();
  for (const cmd of Object.keys(DEPRECATED_COMMANDS)) {
    expect(help).toMatch(new RegExp(`orch ${cmd} +\\[deprecated\\]`));
  }
});
