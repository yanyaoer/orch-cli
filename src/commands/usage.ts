// orch usage run|thread|daily: token usage aggregated from native.jsonl usage events.
import { resolve } from "node:path";
import type { RunSpec } from "../types.ts";
import { getRepoIdentity } from "../paths.ts";
import { readJsonFile } from "../json.ts";
import { normalizeNativeLine } from "../native-events.ts";
import { CliError, assertKnownFlags, flagBool, flagNumber, flagString, printJson, type ParsedArgs } from "../cli.ts";
import { readTextFile, runLocation, runLocationsForMr, runLocationsForRepo, type RunLocation } from "../run-store.ts";
import { threadMr } from "./status.ts";

type TokenUsageMap = Record<string, number>;

type UsageSummary = {
  has_token_data: boolean;
  usage: TokenUsageMap | null;
  estimated_cost_usd: null;
  unpriced_models: string[];
};

type RunUsageSummary = UsageSummary & {
  mr: string;
  run_id: string;
  usage_events: number;
  source_file: string;
};

function addUsage(target: TokenUsageMap, usage: TokenUsageMap): void {
  for (const [key, value] of Object.entries(usage)) target[key] = (target[key] ?? 0) + value;
}

function sortedUsage(usage: TokenUsageMap): TokenUsageMap {
  return Object.fromEntries(Object.entries(usage).sort(([a], [b]) => a.localeCompare(b)));
}

function tokenUsageOnly(usage: Record<string, number>): TokenUsageMap {
  return Object.fromEntries(Object.entries(usage).filter(([key]) => key.toLowerCase().includes("token")));
}

function addModel(models: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.trim()) models.add(value.trim());
}

function modelsFromNativeLine(line: string): string[] {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) return [];
  const obj = event as Record<string, unknown>;
  const response = obj.response && typeof obj.response === "object" && !Array.isArray(obj.response)
    ? (obj.response as Record<string, unknown>)
    : {};
  const message = obj.message && typeof obj.message === "object" && !Array.isArray(obj.message)
    ? (obj.message as Record<string, unknown>)
    : {};
  return [obj.model, obj.model_name, obj.model_id, response.model, message.model].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

function runUsageSummary(run: RunLocation): RunUsageSummary {
  const usage: TokenUsageMap = {};
  const models = new Set<string>();
  const spec = readJsonFile<Partial<RunSpec> | null>(`${run.run_dir}/spec.json`, null);
  addModel(models, spec?.model);
  const nativePath = `${run.run_dir}/native.jsonl`;
  const native = readTextFile(nativePath);
  let usageEvents = 0;
  if (native !== null) {
    for (const line of native.split(/\r?\n/)) {
      if (!line.trim()) continue;
      for (const model of modelsFromNativeLine(line)) models.add(model);
      for (const event of normalizeNativeLine(line)) {
        if (event.kind !== "usage" || !event.usage) continue;
        const tokenUsage = tokenUsageOnly(event.usage);
        if (Object.keys(tokenUsage).length === 0) continue;
        addUsage(usage, tokenUsage);
        usageEvents += 1;
      }
    }
  }
  const hasTokenData = Object.keys(usage).length > 0;
  return {
    mr: run.mr,
    run_id: run.run_id,
    has_token_data: hasTokenData,
    usage: hasTokenData ? sortedUsage(usage) : null,
    estimated_cost_usd: null,
    unpriced_models: [...models].sort(),
    usage_events: usageEvents,
    source_file: nativePath,
  };
}

function aggregateRunUsage(runs: RunUsageSummary[]): UsageSummary & {
  run_count: number;
  runs_with_token_data: number;
  missing_runs: string[];
} {
  const usage: TokenUsageMap = {};
  const models = new Set<string>();
  const missingRuns: string[] = [];
  let runsWithTokenData = 0;
  for (const run of runs) {
    for (const model of run.unpriced_models) models.add(model);
    if (!run.has_token_data || !run.usage) {
      missingRuns.push(run.run_id);
      continue;
    }
    addUsage(usage, run.usage);
    runsWithTokenData += 1;
  }
  const hasTokenData = Object.keys(usage).length > 0;
  return {
    run_count: runs.length,
    runs_with_token_data: runsWithTokenData,
    missing_runs: missingRuns,
    has_token_data: hasTokenData,
    usage: hasTokenData ? sortedUsage(usage) : null,
    estimated_cost_usd: null,
    unpriced_models: [...models].sort(),
  };
}

function renderUsageLine(label: string, summary: UsageSummary): string {
  const usage = summary.has_token_data && summary.usage
    ? Object.entries(summary.usage).map(([key, value]) => `${key}=${value}`).join(" ")
    : "token data missing";
  const models = summary.unpriced_models.length > 0 ? ` unpriced_models=${summary.unpriced_models.join(",")}` : "";
  return `${label}: ${usage} estimated_cost_usd=null${models}\n`;
}

function runUsageDate(run: RunLocation): string | null {
  const raw = run.status?.started_at ?? run.status?.updated_at ?? null;
  if (!raw) return null;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

async function usageRun(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "usage run", ["json", "worktree", "mr", "run"]);
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const run = runLocation(repo.repo_key, flagString(args, "run"), args.flags.has("mr") ? flagString(args, "mr") : undefined);
  const summary = runUsageSummary(run);
  if (flagBool(args, "json")) {
    printJson({ schema: "orch.usage/run/v1", repo_key: repo.repo_key, ...summary });
  } else {
    process.stdout.write(renderUsageLine(`MR ${summary.mr} run ${summary.run_id}`, summary));
  }
  return 0;
}

async function usageThread(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "usage thread", ["json", "worktree", "thread", "mr"]);
  const thread = threadMr(args);
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const runs = runLocationsForMr(repo.repo_key, thread).map(runUsageSummary);
  const aggregate = aggregateRunUsage(runs);
  if (flagBool(args, "json")) {
    printJson({
      schema: "orch.usage/thread/v1",
      repo_key: repo.repo_key,
      thread,
      ...aggregate,
      runs,
    });
  } else {
    process.stdout.write(renderUsageLine(`thread ${thread}`, aggregate));
    for (const run of runs) process.stdout.write(`  ${renderUsageLine(`run ${run.run_id}`, run)}`);
  }
  return 0;
}

async function usageDaily(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "usage daily", ["json", "worktree", "days"]);
  const rawDays = flagNumber(args, "days") ?? 7;
  if (!Number.isInteger(rawDays) || rawDays <= 0) throw new CliError("--days must be a positive integer");
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - (rawDays - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const byDate = new Map<string, RunLocation[]>();
  for (const run of runLocationsForRepo(repo.repo_key)) {
    const date = runUsageDate(run);
    if (!date || date < since || date > today) continue;
    byDate.set(date, [...(byDate.get(date) ?? []), run]);
  }
  const buckets = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, locations]) => {
      const runs = locations.map(runUsageSummary);
      return { date, ...aggregateRunUsage(runs), runs };
    });

  if (flagBool(args, "json")) {
    printJson({
      schema: "orch.usage/daily/v1",
      repo_key: repo.repo_key,
      days: rawDays,
      since,
      until: today,
      buckets,
    });
  } else {
    if (buckets.length === 0) {
      process.stdout.write("no runs in selected window\n");
    } else {
      for (const bucket of buckets) process.stdout.write(renderUsageLine(bucket.date, bucket));
    }
  }
  return 0;
}

export async function usageCommand(args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[1];
  if (subcommand === "run") return usageRun(args);
  if (subcommand === "thread") return usageThread(args);
  if (subcommand === "daily") return usageDaily(args);
  throw new CliError("usage: orch usage run --run <id> | orch usage thread --thread <id> | orch usage daily [--days N]");
}
