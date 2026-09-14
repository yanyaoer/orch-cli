// Golden-fixture harness: every directory under fixtures/ is one contract case
// (see fixtures/README.md). UPDATE_FIXTURES=1 rewrites the expectations.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoleResult, RunSpec } from "./types.ts";
import { extractResultFromText } from "../drivers/driver-common.ts";
import { decisionBody, mirrorBody } from "./render.ts";
import type { DecisionRecord } from "./run-store.ts";

const root = join(import.meta.dir, "..", "fixtures");
const update = process.env.UPDATE_FIXTURES === "1";

function golden(path: string, actual: string): void {
  if (update || !existsSync(path)) {
    writeFileSync(path, actual);
    return;
  }
  expect(actual).toBe(readFileSync(path, "utf8"));
}

function cases(kind: string): Array<[string, string]> {
  return readdirSync(join(root, kind), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => [d.name, join(root, kind, d.name)] as [string, string])
    .sort();
}

function baseSpec(): RunSpec {
  return {
    version: 1,
    run_id: "golden-run",
    mr: "42",
    role: "reviewer",
    agent: "claude",
    model: null,
    tag: "golden",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    idempotency_key: "golden-run",
    repo_key: "local/repo",
    worktree: "/tmp/repo",
    task_path: null,
    task_text: "golden task",
    task_sha: "task-sha",
    base_sha: "base",
    timeout_sec: 60,
    created_at: "2026-06-19T12:00:00.000Z",
  };
}

// Publication language comes from ~/.config/orch/config.json; point XDG at a
// throwaway config for the duration of one case.
function withLanguage<T>(language: string | undefined, fn: () => T): T {
  const prev = process.env.XDG_CONFIG_HOME;
  const dir = mkdtempSync(join(tmpdir(), "orch-golden-config-"));
  mkdirSync(join(dir, "orch"), { recursive: true });
  writeFileSync(join(dir, "orch", "config.json"), JSON.stringify({ version: 1, language: language ?? "english" }));
  process.env.XDG_CONFIG_HOME = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
}

for (const [name, dir] of cases("result-extraction")) {
  test(`golden result-extraction/${name}`, () => {
    const spec = { ...baseSpec(), ...JSON.parse(readFileSync(join(dir, "spec.json"), "utf8")) } as RunSpec;
    const actual = extractResultFromText(readFileSync(join(dir, "output.txt"), "utf8"), spec);
    golden(join(dir, "expected.json"), `${JSON.stringify(actual, null, 2)}\n`);
  });
}

for (const [name, dir] of cases("comments")) {
  test(`golden comments/${name}`, () => {
    const params = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as {
      mr: string;
      run_id: string;
      language?: string;
      decision?: { verdict: DecisionRecord["verdict"]; reason: string | null };
    };
    const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as RoleResult;
    const body = withLanguage(params.language, () =>
      params.decision
        ? decisionBody(params.mr, params.run_id, { ...params.decision, run_id: params.run_id, ts: "2026-06-19T12:00:00.000Z" }, result, null)
        : mirrorBody(params.mr, params.run_id, result, null),
    );
    golden(join(dir, "expected.md"), body.endsWith("\n") ? body : `${body}\n`);
  });
}
