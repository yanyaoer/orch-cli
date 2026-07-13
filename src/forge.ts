export type ForgeKind = "github" | "gitlab" | "none";

export interface ForgeCommandResult {
  forge: Exclude<ForgeKind, "none">;
  argv: string[];
  execute: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

export interface ForgeAdapter {
  forge: Exclude<ForgeKind, "none">;
  execute: boolean;
  postComment(ref: string, body: string): Promise<ForgeCommandResult>;
  getState(ref: string): Promise<ForgeCommandResult>;
  updateDescription(ref: string, body: string): Promise<ForgeCommandResult>;
}

function hostFromRemote(remoteUrl: string): string | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/, "");
  if (!cleaned) return null;

  const ssh = cleaned.match(/^git@([^:]+):(.+)$/);
  if (ssh?.[1] && ssh[2]) return ssh[1].toLowerCase();

  try {
    const url = new URL(cleaned);
    return url.host ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function detectForge(remoteUrl: string): ForgeKind {
  const host = hostFromRemote(remoteUrl);
  if (!host) return "none";
  // Exact-host match: a substring check would classify github.com.attacker.net
  // as github. GitHub Enterprise (github.mycorp.com) stays gitlab for now.
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  return "gitlab";
}

function repoPathFromRemote(remoteUrl: string): string | null {
  const cleaned = remoteUrl.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const ssh = cleaned.match(/^git@[^:]+:(.+)$/);
  if (ssh?.[1]) return ssh[1].toLowerCase();
  try {
    const url = new URL(cleaned);
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    return path || null;
  } catch {
    return null;
  }
}

// The forge's MR/PR route, anchored over the whole URL pathname (query and
// fragment never reach pathname). The number must be a whole path segment:
// only end-of-path or a `/` may follow it, and the MR's own `.diff`/`.patch`
// views must end the path — `/pull/12abc`, `/pull/12-foo`, `/pull/12..diff`,
// `/pull/12%61bc`, and `/pull/12.diff/files` are typos or other objects,
// never targets.
const MR_ROUTES: Record<Exclude<ForgeKind, "none">, RegExp> = {
  github: /^\/(.+?)\/pull\/(\d+)(?:\.(?:diff|patch)$|(?=\/|$))/,
  gitlab: /^\/(.+?)\/-\/merge_requests\/(\d+)(?:\.(?:diff|patch)$|(?=\/|$))/,
};

// Candidate URLs in free text: each starts at its own `https?://` and may
// never run into the next URL's start (adjacent URLs separated only by CJK
// punctuation are a normal Chinese-text input, and swallowing the second one
// would hide an ambiguity). The candidate then ends at the first character
// outside the RFC 3986 set, and trailing sentence punctuation is trimmed.
function candidateUrls(text: string): string[] {
  const starts = [...text.matchAll(/https?:\/\//gi)].map((match) => match.index!);
  return starts.map((start, index) => {
    const hardEnd = index + 1 < starts.length ? starts[index + 1]! : text.length;
    let candidate = text.slice(start, hardEnd);
    candidate = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*/.exec(candidate)![0];
    return candidate.replace(/[.,;:!?)\]'"]+$/, "");
  });
}

// The MR/PR number a free-text task unambiguously targets. External comments
// must never ride on a guessed destination, so this is deliberately strict:
// only URLs on the worktree's own remote (host + repo path, via WHATWG URL
// normalization) using the remote forge's own route count as targets —
// cross-repo links are references, not targets — and more than one distinct
// same-repo number is ambiguous. Anything else returns null (fail closed).
export function mrRefFromText(text: string, remoteUrl: string): string | null {
  const host = hostFromRemote(remoteUrl);
  const path = repoPathFromRemote(remoteUrl);
  const forge = detectForge(remoteUrl);
  if (!host || !path || forge === "none") return null;
  const route = MR_ROUTES[forge];
  const refs = new Set<string>();
  for (const candidate of candidateUrls(text)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    // URL normalizes scheme/host case and drops default ports; url.host keeps
    // an explicit non-default port, matching hostFromRemote's https handling.
    if (url.host.toLowerCase() !== host) continue;
    const match = url.pathname.match(route);
    if (!match) continue;
    if (match[1]!.replace(/\.git$/i, "").toLowerCase() !== path) continue;
    refs.add(match[2]!);
  }
  return refs.size === 1 ? [...refs][0]! : null;
}

async function runArgv(
  forge: Exclude<ForgeKind, "none">,
  argv: string[],
  execute: boolean,
  cwd?: string,
): Promise<ForgeCommandResult> {
  if (!execute) return { forge, argv, execute, exit_code: null, stdout: "", stderr: "" };

  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { forge, argv, execute, exit_code: exitCode, stdout, stderr };
}

class GitHubAdapter implements ForgeAdapter {
  readonly forge = "github" as const;

  constructor(readonly execute: boolean, readonly cwd?: string) {}

  postComment(ref: string, body: string): Promise<ForgeCommandResult> {
    return runArgv(this.forge, ["gh", "pr", "comment", ref, "--body", body], this.execute, this.cwd);
  }

  getState(ref: string): Promise<ForgeCommandResult> {
    return runArgv(this.forge, ["gh", "pr", "view", ref, "--json", "state,url,title"], this.execute, this.cwd);
  }

  updateDescription(ref: string, body: string): Promise<ForgeCommandResult> {
    return runArgv(this.forge, ["gh", "pr", "edit", ref, "--body", body], this.execute, this.cwd);
  }
}

class GitLabAdapter implements ForgeAdapter {
  readonly forge = "gitlab" as const;

  constructor(readonly execute: boolean, readonly cwd?: string) {}

  postComment(ref: string, body: string): Promise<ForgeCommandResult> {
    return runArgv(
      this.forge,
      ["glab", "mr", "note", "create", ref, "-m", body, "--resolvable=false"],
      this.execute,
      this.cwd,
    );
  }

  getState(ref: string): Promise<ForgeCommandResult> {
    return runArgv(this.forge, ["glab", "mr", "view", ref, "-F", "json"], this.execute, this.cwd);
  }

  updateDescription(ref: string, body: string): Promise<ForgeCommandResult> {
    return runArgv(this.forge, ["glab", "mr", "update", ref, "--description", body], this.execute, this.cwd);
  }
}

export function createForgeAdapter(
  forge: ForgeKind,
  execute: boolean,
  cwd?: string,
): ForgeAdapter | null {
  switch (forge) {
    case "github":
      return new GitHubAdapter(execute, cwd);
    case "gitlab":
      return new GitLabAdapter(execute, cwd);
    case "none":
      return null;
  }
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function argvForDisplay(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}
