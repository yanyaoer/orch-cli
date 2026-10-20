import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// codex turn.completed usage is cumulative per thread, so a resumed run's
// counter includes every earlier turn. The host captures the thread's last
// counter from codex's own rollout file before the resumed run starts; usage
// evidence subtracts it. No rollout or no token_count => no baseline, and the
// run's usage stays "baseline unknown" rather than guessed.
export interface CodexBaseline {
  thread_id: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  source: "codex_rollout";
}

export function codexBaselinePath(runDir: string): string {
  return `${runDir}/codex_baseline.json`;
}

function rolloutFile(sessionsDir: string, threadId: string): string | null {
  if (!existsSync(sessionsDir)) return null;
  const suffix = `-${threadId}.jsonl`;
  // sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl; newest dirs first.
  const walk = (dir: string, depth: number): string | null => {
    let entries: string[];
    try { entries = readdirSync(dir).sort().reverse(); } catch { return null; }
    for (const name of entries) {
      const path = join(dir, name);
      if (depth === 3) {
        if (name.endsWith(suffix)) return path;
        continue;
      }
      const found = walk(path, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(sessionsDir, 0);
}

export function readCodexBaseline(threadId: string, env: NodeJS.ProcessEnv = process.env): CodexBaseline | null {
  const home = env.CODEX_HOME || (env.HOME ? `${env.HOME}/.codex` : null);
  if (!home || !threadId) return null;
  const file = rolloutFile(`${home}/sessions`, threadId);
  if (!file) return null;
  let last: any = null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.includes('"token_count"')) continue;
    try {
      const total = JSON.parse(line)?.payload?.info?.total_token_usage;
      if (total) last = total;
    } catch {
      // A torn trailing line is not evidence.
    }
  }
  const n = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!last || !n(last.input_tokens) || !n(last.cached_input_tokens) || !n(last.output_tokens)) return null;
  return { thread_id: threadId, input_tokens: last.input_tokens, cached_input_tokens: last.cached_input_tokens, output_tokens: last.output_tokens, source: "codex_rollout" };
}
