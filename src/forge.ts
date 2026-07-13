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

// The forge's MR/PR route inside a URL pathname. The number must be a whole
// path segment: a word character after it (or after a lone dot) means a typo
// or a different object, never a target — `/pull/12abc` and `/pull/12O` must
// not resolve to 12. Explicit `.diff`/`.patch` views of the same MR are fine.
const MR_ROUTES: Record<Exclude<ForgeKind, "none">, RegExp> = {
  github: /^\/(.+?)\/pull\/(\d+)(?:\.(?:diff|patch))?(?!\.?\w)/,
  gitlab: /^\/(.+?)\/-\/merge_requests\/(\d+)(?:\.(?:diff|patch))?(?!\.?\w)/,
};

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
  for (const candidate of text.matchAll(/https?:\/\/\S+/gi)) {
    let url: URL;
    try {
      url = new URL(candidate[0]!);
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
