// orch search: regex over run files and mail event diagnostics.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getRepoIdentity, orchStateRoot } from "../paths.ts";

import { CliError, assertKnownFlags, flagBool, flagString, printJson, type ParsedArgs } from "../cli.ts";
import { readTextFile, safeDirEntries, scopedRunLocations, type RunLocation } from "../run-store.ts";

type SearchSource = "run" | "mail";

type SearchFileCandidate = {
  source: SearchSource;
  mr: string | null;
  run_id: string | null;
  thread: string | null;
  file: string;
  path: string;
};

type SearchHit = {
  source: SearchSource;
  mr: string | null;
  run_id: string | null;
  thread: string | null;
  file: string;
  path: string;
  line: number;
  context: string;
};

function searchFilesForRun(run: RunLocation): SearchFileCandidate[] {
  const candidates: SearchFileCandidate[] = ["result.json", "events.jsonl", "native.jsonl"].map((file) => ({
    source: "run",
    mr: run.mr,
    run_id: run.run_id,
    thread: null,
    file,
    path: `${run.run_dir}/${file}`,
  }));

  const artifactsDir = `${run.run_dir}/artifacts`;
  for (const entry of safeDirEntries(artifactsDir)) {
    if (!entry.isFile()) continue;
    if (!/\.(txt|log|patch)$/.test(entry.name)) continue;
    candidates.push({
      source: "run",
      mr: run.mr,
      run_id: run.run_id,
      thread: null,
      file: `artifacts/${entry.name}`,
      path: `${artifactsDir}/${entry.name}`,
    });
  }
  return candidates.filter((candidate) => existsSync(candidate.path));
}

function searchFilesForMail(repoKey: string, args: ParsedArgs): SearchFileCandidate[] {
  // Default search scans repo runs plus repo mail diagnostics. A run/MR scoped
  // search stays run-scoped unless --thread explicitly asks for a mail thread.
  if ((args.flags.has("mr") || args.flags.has("run")) && !args.flags.has("thread")) return [];
  const threadsRoot = `${orchStateRoot()}/${repoKey}/mail/threads`;
  const threadIds = args.flags.has("thread")
    ? [flagString(args, "thread")]
    : safeDirEntries(threadsRoot)
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
  return threadIds
    .map((thread) => ({
      source: "mail" as const,
      mr: null,
      run_id: null,
      thread,
      file: "mail-events.jsonl",
      path: `${threadsRoot}/${thread}/inbox/events/mail-events.jsonl`,
    }))
    .filter((candidate) => existsSync(candidate.path));
}

function compileSearchRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new CliError(`invalid regex: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function searchCandidate(regex: RegExp, candidate: SearchFileCandidate): SearchHit[] {
  const text = readTextFile(candidate.path);
  if (text === null) return [];
  const hits: SearchHit[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!regex.test(line)) return;
    hits.push({
      source: candidate.source,
      mr: candidate.mr,
      run_id: candidate.run_id,
      thread: candidate.thread,
      file: candidate.file,
      path: candidate.path,
      line: index + 1,
      context: line,
    });
  });
  return hits;
}

function renderSearchHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "no matches\n";
  return hits
    .map((hit) => {
      const owner = hit.source === "run" ? `MR ${hit.mr ?? "-"} run ${hit.run_id ?? "-"}` : `thread ${hit.thread ?? "-"}`;
      return `${owner} ${hit.file}:${hit.line}: ${hit.context}`;
    })
    .join("\n") + "\n";
}

export async function searchCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "search", ["json", "worktree", "mr", "run", "thread"]);
  if (args.positionals.length !== 2) throw new CliError("usage: orch search <regex> [--mr <id>] [--run <id>] [--thread <id>] [--worktree <path>] [--json]");
  const pattern = args.positionals[1]!;
  const regex = compileSearchRegex(pattern);
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const runFiles = scopedRunLocations(repo.repo_key, args).flatMap(searchFilesForRun);
  const mailFiles = searchFilesForMail(repo.repo_key, args);
  const files = [...runFiles, ...mailFiles];
  const hits = files.flatMap((candidate) => searchCandidate(regex, candidate));

  if (flagBool(args, "json")) {
    printJson({
      schema: "orch.search/v1",
      repo_key: repo.repo_key,
      worktree: repo.repo_root,
      pattern,
      scope: {
        mr: args.flags.has("mr") ? flagString(args, "mr") : null,
        run_id: args.flags.has("run") ? flagString(args, "run") : null,
        thread: args.flags.has("thread") ? flagString(args, "thread") : null,
      },
      searched_files: files.length,
      hits,
    });
  } else {
    process.stdout.write(renderSearchHits(hits));
  }
  return 0;
}
