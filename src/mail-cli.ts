import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { MaildirBus, type BusTaskLease } from "./bus.ts";
import { assertKnownFlags, CliError, collectFlags, flagBool, flagNumber, flagString, printJson, type ParsedArgs } from "./cli.ts";
import {
  mailAgentsConfigPath,
  readMailAgentsConfig,
  readOrchConfig,
  upsertMailAgent,
  writeMailAgentsConfig,
  type MailAgentDefinition,
} from "./config.ts";
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from "./json.ts";
import { sha256 } from "./hash.ts";
import {
  deliverLocalMail,
  ensureMailDirs,
  importMailAuto,
  maildirPath,
  mailEventsPath,
  mailThreadDir,
  pendingLocalMailFiles,
  writeNeomuttConfig,
  type NeomuttMailbox,
  type OrchMailEvent,
  type ResultSubmittedMailEvent,
  type TaskRequestedMailEvent,
} from "./mail.ts";
import { getRepoIdentity, mrStateDir, orchStateRoot } from "./paths.ts";
import type { AgentName, RoleResult, RunRole, RunStatus } from "./types.ts";
import { isResultRole } from "./types.ts";
import { acquirePidfileLockWait, type PidfileLock } from "./locks.ts";

interface LocatedRun {
  mr: string;
  run_id: string;
  run_dir: string;
}

type DecisionVerdict = "accept" | "rework";

interface DecisionRecord {
  verdict: DecisionVerdict;
  run_id: string;
  reason: string | null;
  ts: string;
}

export interface MailCliContext {
  orchCommand: () => string[];
  locateRun: (repoKey: string, runId: string, mr?: string) => LocatedRun;
  readMirrorResult: (runsRoot: string, runId: string) => { result: RoleResult; status: RunStatus | null };
}

export function defaultMailAgents(now: string): MailAgentDefinition[] {
  return [
    {
      id: "orch-router",
      address: "orch-router@local.orch",
      provider: "router",
      roles: ["router"],
      capabilities: ["decompose", "route", "replan"],
      trust: "internal",
      auto_invite: false,
      work_mode: "route",
      provider_session_mode: "ephemeral",
      updated_at: now,
    },
    {
      id: "codex-implementer",
      address: "orch+codex.implementer@local.orch",
      provider: "codex",
      roles: ["implementer", "debugger", "rework"],
      capabilities: ["code-edit", "debug", "tests"],
      trust: "internal",
      auto_invite: true,
      work_mode: "implement",
      provider_session_mode: "fresh_persistent",
      updated_at: now,
    },
    {
      id: "claude-reviewer",
      address: "orch+claude.reviewer@local.orch",
      provider: "claude",
      roles: ["reviewer", "challenger"],
      capabilities: ["architecture", "code-review", "long-context"],
      trust: "internal",
      auto_invite: true,
      work_mode: "review",
      provider_session_mode: "fresh_persistent",
      updated_at: now,
    },
    {
      id: "omp-reviewer",
      address: "orch+omp.reviewer@local.orch",
      provider: "omp",
      roles: ["reviewer"],
      capabilities: ["code-review", "research", "long-context"],
      trust: "internal",
      // Not auto-invited into router followups (keeps gemini out of every review);
      // cross-review / investigate add it explicitly via defaultAgentIds.
      auto_invite: false,
      work_mode: "review",
      provider_session_mode: "ephemeral",
      updated_at: now,
    },
    {
      id: "pi-verifier",
      address: "orch+pi.verifier@local.orch",
      provider: "pi",
      roles: ["verifier"],
      capabilities: ["verification", "test-execution"],
      trust: "internal",
      auto_invite: true,
      work_mode: "verify",
      provider_session_mode: "ephemeral",
      updated_at: now,
    },
  ];
}

function workspaceForMail(id: string | undefined): { id: string; path: string } | null {
  if (!id) return null;
  const workspace = readOrchConfig().workspaces[id];
  if (!workspace) throw new CliError(`unknown workspace: ${id}`);
  return { id: workspace.id, path: workspace.path };
}

function mailWorktree(args: ParsedArgs): string {
  if (args.flags.has("worktree")) return resolve(flagString(args, "worktree"));
  const workspace = workspaceForMail(args.flags.has("workspace") ? flagString(args, "workspace") : undefined);
  return resolve(workspace?.path ?? process.cwd());
}

async function configuredWorkspaceMailboxes(): Promise<NeomuttMailbox[]> {
  const workspaces = Object.values(readOrchConfig().workspaces).sort((a, b) => a.id.localeCompare(b.id));
  const mailboxes: NeomuttMailbox[] = [];
  for (const workspace of workspaces) {
    const repo = await getRepoIdentity(workspace.path);
    const threadsDir = `${orchStateRoot()}/${repo.repo_key}/mail/threads`;
    if (!existsSync(threadsDir)) continue;
    for (const entry of readdirSync(threadsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      mailboxes.push({
        thread_id: entry.name,
        thread_dir: `${threadsDir}/${entry.name}`,
        worktree: workspace.path,
        workspace_id: workspace.id,
      });
    }
  }
  return mailboxes.sort((a, b) => `${a.workspace_id ?? ""}/${a.thread_id}`.localeCompare(`${b.workspace_id ?? ""}/${b.thread_id}`));
}

async function maybeLaunchNeomutt(args: ParsedArgs, rcPath: string, maildir: string): Promise<number | null> {
  if (flagBool(args, "json")) return null;
  const bin = flagString(args, "neomutt-bin", "neomutt");
  const proc = Bun.spawn([bin, "-F", rcPath, "-f", maildir], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

function mailHeader(raw: string, name: string): string | null {
  const lines = raw.split(/\r?\n/);
  const prefix = `${name.toLowerCase()}:`;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") break;
    if (!line.toLowerCase().startsWith(prefix)) continue;
    const values = [line.slice(prefix.length).trim()];
    for (let j = i + 1; j < lines.length && /^[ \t]/.test(lines[j]!); j += 1) values.push(lines[j]!.trim());
    return values.join(" ");
  }
  return null;
}

function mailBody(raw: string): string {
  const crlf = raw.indexOf("\r\n\r\n");
  if (crlf >= 0) return raw.slice(crlf + 4).trim();
  const lf = raw.indexOf("\n\n");
  return (lf >= 0 ? raw.slice(lf + 2) : raw).trim();
}

function mailAddress(value: string): string {
  const bracketed = value.match(/<([^>]+)>/);
  const address = bracketed ? bracketed[1]! : value.trim().split(/\s+/).pop() ?? value;
  return address.trim().replace(/^["']|["']$/g, "").toLowerCase();
}

function mailRecipients(raw: string, argv: string[]): string[] {
  const headerRecipients = ["To", "Cc", "Bcc"]
    .flatMap((name) => (mailHeader(raw, name) ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const cliRecipients = argv.slice(2).filter((value) => !value.startsWith("--"));
  return [...headerRecipients, ...cliRecipients].map(mailAddress);
}

async function inferMailTarget(args: ParsedArgs, raw: string): Promise<{ thread: string; worktree: string; workspace?: { id: string; path: string } | null }> {
  const headerThread = mailHeader(raw, "X-Orch-Thread-ID");
  const subjectThread = mailHeader(raw, "Subject")?.match(/\[thread:([A-Za-z0-9._-]+)\]/)?.[1] ?? null;
  const requestedThread = args.flags.has("thread") ? flagString(args, "thread") : headerThread ?? subjectThread;
  if (requestedThread) {
    const workspace = workspaceForMail(args.flags.has("workspace") ? flagString(args, "workspace") : undefined);
    return { thread: requestedThread, worktree: mailWorktree(args), workspace };
  }
  const mailboxes = await configuredWorkspaceMailboxes();
  if (mailboxes.length === 1) {
    const only = mailboxes[0]!;
    const workspace = only.workspace_id ? workspaceForMail(only.workspace_id) : null;
    return { thread: only.thread_id, worktree: only.worktree, workspace };
  }
  throw new CliError("mail sendmail needs --thread, X-Orch-Thread-ID, Subject [thread:<id>], or exactly one configured mailbox");
}

function firstAutoInviteAgent(role: string): MailAgentDefinition | null {
  return (
    Object.values(readMailAgentsConfig().agents)
      .filter((agent) => agent.auto_invite && agent.roles.includes(role))
      .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null
  );
}

function parentTaskForResult(events: OrchMailEvent[], result: ResultSubmittedMailEvent): TaskRequestedMailEvent | null {
  if (!result.parent_event_id) return null;
  const parent = events.find((event) => event.type === "task.requested" && event.event_id === result.parent_event_id);
  return parent?.type === "task.requested" ? parent : null;
}

function resultFollowupTask(role: "reviewer" | "verifier", result: ResultSubmittedMailEvent, parentTask: TaskRequestedMailEvent | null): string {
  const action =
    role === "reviewer"
      ? "Cross-review the implementation result below. Focus on blocking correctness, safety, and maintainability issues."
      : "Verify the implementation result below with concrete commands and acceptance evidence.";
  return [
    action,
    "",
    `Source run: ${result.run_id}`,
    `Source agent: ${result.from_agent.id} (${result.from_agent.provider})`,
    `Result schema: ${result.result.schema}`,
    `Result verdict: ${result.result.verdict}`,
    `Result summary: ${result.result.summary}`,
    "",
    "Original task:",
    parentTask?.task.body ?? "(original task event unavailable)",
  ].join("\n");
}

type RouteAssignment = {
  source_event_id: string | undefined;
  role: string;
  agent_id: string;
  address: string;
  eml_path: string;
  meta_path: string;
  event_id: string;
  message_id: string;
  event_sha256: string;
};

function routeKey(parentEventId: string | null | undefined, role: string | null | undefined): string | null {
  if (!parentEventId || !role) return null;
  return `${parentEventId}:${role}`;
}

function addRouteKey(keys: Set<string>, parentEventId: string | null | undefined, role: string | null | undefined): void {
  const key = routeKey(parentEventId, role);
  if (key) keys.add(key);
}

function outboxMailDirs(threadDir: string): string[] {
  return [`${threadDir}/outbox/pending`, `${threadDir}/outbox/sent`];
}

function addRouteKeysFromOutboxMeta(keys: Set<string>, path: string): void {
  try {
    const raw = readFileSync(path, "utf8");
    const meta = JSON.parse(raw) as { parent_event_id?: unknown; role?: unknown };
    addRouteKey(
      keys,
      typeof meta.parent_event_id === "string" ? meta.parent_event_id : null,
      typeof meta.role === "string" ? meta.role : null,
    );
  } catch {
    // Outbox metadata is a local recovery hint. Ignore corrupt or partial files.
  }
}

function addRouteKeysFromOutboxMail(keys: Set<string>, path: string): void {
  try {
    const raw = readFileSync(path, "utf8");
    if (mailHeader(raw, "X-Orch-Event-Type") !== "task.requested") return;
    addRouteKey(keys, mailHeader(raw, "X-Orch-Parent-Event-ID"), mailHeader(raw, "X-Orch-Role"));
  } catch {
    // Ignore corrupt local mail while deriving route idempotency state.
  }
}

function routedRouteKeys(threadDir: string, events: OrchMailEvent[]): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.type !== "task.requested") continue;
    addRouteKey(keys, event.parent_event_id, event.role);
  }
  for (const dir of outboxMailDirs(threadDir)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = `${dir}/${entry.name}`;
      if (entry.name.endsWith(".json")) addRouteKeysFromOutboxMeta(keys, path);
      if (entry.name.endsWith(".eml")) addRouteKeysFromOutboxMail(keys, path);
    }
  }
  return keys;
}

async function acquireThreadLock(threadDir: string, name: string, holder: string): Promise<PidfileLock> {
  return acquirePidfileLockWait(`${threadDir}/${name}`, 5000, process.pid, holder);
}

async function acquireRouteLock(threadDir: string): Promise<PidfileLock> {
  return acquireThreadLock(threadDir, "router-route.lock", "mail-route");
}

async function routeRouterTasks(threadDir: string, thread: string, repoKey: string): Promise<RouteAssignment[]> {
  const lock = await acquireRouteLock(threadDir);
  try {
  const bus = new MaildirBus(threadDir, thread, repoKey);
  const router = agentById("orch-router");
  const events = bus.listEvents();
  const routed = routedRouteKeys(threadDir, events);
  const assigned: RouteAssignment[] = [];

  const routerTasks = events.filter(
    (event): event is TaskRequestedMailEvent => event.type === "task.requested" && event.assigned_agent?.id === router.id && Boolean(event.event_id),
  );
  for (const event of routerTasks) {
    const key = routeKey(event.event_id, "implementer");
    if (!key || routed.has(key)) continue;
    const agent = firstAutoInviteAgent("implementer");
    if (!agent) continue;
    const mail = bus.publishTask({
      from: router.address,
      taskText: `Router implementation task:\n\n${event.task?.body || ""}`,
      role: "implementer",
      parentEventId: event.event_id ?? null,
      mr: event.mr ?? null,
      workspace: event.workspace ?? null,
      agent,
    });
    assigned.push({ source_event_id: event.event_id, role: "implementer", agent_id: agent.id, address: agent.address, ...mail });
    routed.add(key);
  }

  const implementationResults = events.filter(
    (event): event is ResultSubmittedMailEvent =>
      event.type === "result.submitted" && event.result.schema === "orch.result/implementer/v1" && Boolean(event.event_id),
  );
  for (const event of implementationResults) {
    const parentTask = parentTaskForResult(events, event);
    for (const role of ["reviewer", "verifier"] as const) {
      const key = routeKey(event.event_id, role);
      if (!key || routed.has(key)) continue;
      const agent = firstAutoInviteAgent(role);
      if (!agent) continue;
      const mail = bus.publishTask({
        from: router.address,
        taskText: resultFollowupTask(role, event, parentTask),
        role,
        parentEventId: event.event_id,
        mr: event.mr ?? parentTask?.mr ?? null,
        workspace: parentTask?.workspace ?? null,
        agent,
      });
      assigned.push({ source_event_id: event.event_id, role, agent_id: agent.id, address: agent.address, ...mail });
      routed.add(key);
    }
  }

  return assigned;
  } finally {
    lock.release();
  }
}

function agentById(id: string): MailAgentDefinition {
  const agent = readMailAgentsConfig().agents[id];
  if (!agent) throw new CliError(`unknown mail agent: ${id}`);
  return agent;
}

function mailAgentProvider(agent: MailAgentDefinition): AgentName {
  if (
    agent.provider === "codex" ||
    agent.provider === "claude" ||
    agent.provider === "pi" ||
    agent.provider === "omp"
  ) {
    return agent.provider;
  }
  throw new CliError(`mail agent ${agent.id} uses unsupported run provider: ${agent.provider}`);
}

function mailTaskRole(event: TaskRequestedMailEvent): RunRole {
  const role = event.role as RunRole;
  if (!isResultRole(role)) throw new CliError(`mail task role cannot start a run: ${event.role}`);
  return role;
}

async function runCreateFromMail(argv: string[], worktree: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(argv, { cwd: worktree, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function claimMailTasks(
  args: ParsedArgs,
  threadDir: string,
  thread: string,
  fallbackWorktree: string,
  repoKey: string,
  context: MailCliContext,
  opts: { eventIds?: string[] } = {},
): Promise<Array<{ event_id: string; role: string; agent_id: string; mr: string; run: unknown }>> {
  const agent = agentById(flagString(args, "agent"));
  const limit = flagNumber(args, "limit") ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(limit) && limit !== Number.POSITIVE_INFINITY) throw new CliError("--limit must be a number");
  if (limit <= 0) throw new CliError("--limit must be positive");
  const bus = new MaildirBus(threadDir, thread, repoKey);
  const dryRun = flagBool(args, "dry-run");
  const eventIds = opts.eventIds ? new Set(opts.eventIds) : null;
  const leases: Array<BusTaskLease | { event: TaskRequestedMailEvent; claim_path: null; lease_id: null }> = dryRun
    ? bus
        .listEvents()
        .filter(
          (event): event is TaskRequestedMailEvent =>
            event.type === "task.requested" &&
            event.assigned_agent?.id === agent.id &&
            Boolean(event.event_id) &&
            (!eventIds || eventIds.has(event.event_id)),
        )
        .slice(0, limit)
        .map((event) => ({ event, claim_path: null, lease_id: null }))
    : bus.claimTasks({ agent_id: agent.id, limit, event_ids: opts.eventIds });
  const out: Array<{ event_id: string; role: string; agent_id: string; mr: string; run: unknown }> = [];
  for (const lease of leases) {
    try {
      const event = lease.event;
      const role = mailTaskRole(event);
      const provider = mailAgentProvider(agent);
      const worktree = args.flags.has("worktree") ? fallbackWorktree : event.workspace?.path ?? fallbackWorktree;
      const mr = args.flags.has("mr") ? flagString(args, "mr") : event.mr ?? thread;
      const taskPath = `${threadDir}/claims/${event.event_id}.md`;
      writeTextAtomic(taskPath, event.task.body);
      const argv = [
        ...context.orchCommand(),
        "run",
        "create",
        "--mr",
        mr,
        "--role",
        role,
        "--agent",
        provider,
        "--tag",
        `mail-${role}-${agent.id}`,
        "--worktree",
        worktree,
        "--task",
        taskPath,
        "--idempotency-key",
        `mail:${thread}:${event.event_id}:${agent.id}`,
        "--session-mode",
        agent.provider_session_mode,
        "--json",
      ];
      if (args.flags.has("timeout-sec")) argv.push("--timeout-sec", flagString(args, "timeout-sec"));
      if (args.flags.has("model")) argv.push("--model", flagString(args, "model"));
      if (dryRun) argv.push("--dry-run");
      if (flagBool(args, "allow-dirty")) argv.push("--allow-dirty");
      const run = await runCreateFromMail(argv, worktree);
      if (run.exitCode !== 0) {
        throw new CliError(run.stderr.trim() || run.stdout.trim() || "mail claim failed to start run");
      }
      const payload = JSON.parse(run.stdout) as unknown;
      if (!dryRun && lease.claim_path) bus.ackTask(lease as BusTaskLease, payload);
      out.push({ event_id: event.event_id, role, agent_id: agent.id, mr, run: payload });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!dryRun && lease.claim_path) bus.nackTask(lease as BusTaskLease, message);
      throw error instanceof CliError ? error : new CliError(message);
    }
  }
  return out;
}

function autoInviteAgentsForRole(cfg: ReturnType<typeof readMailAgentsConfig>, role: string): MailAgentDefinition[] {
  return Object.values(cfg.agents)
    .filter((agent) => agent.auto_invite && agent.roles.includes(role))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Clones parsed args with --agent overridden so claimMailTasks can run per target agent.
function withAgentFlag(args: ParsedArgs, agentId: string): ParsedArgs {
  const flags = new Map(args.flags);
  flags.set("agent", agentId);
  return { positionals: args.positionals, flags, flagValues: args.flagValues };
}

type FanoutAssignment = Record<string, unknown> & { agent_id: string; event_id: string };

function fanoutAssignment(
  bus: MaildirBus,
  args: {
    agent: MailAgentDefinition;
    from: string;
    taskText: string;
    taskSha: string;
    role: string;
    parentEventId: string | null;
    mr: string | null;
    workspace: { id: string; path: string } | null;
  },
): FanoutAssignment {
  const existing = bus.findTask({
    agent_id: args.agent.id,
    role: args.role,
    task_sha: args.taskSha,
    parent_event_id: args.parentEventId,
    mr: args.mr,
    workspace: args.workspace,
  });
  if (existing) {
    return {
      agent_id: args.agent.id,
      address: args.agent.address,
      idempotent: true,
      event_id: existing.event.event_id,
      task_sha256: existing.event.task.sha256,
      claim_state: existing.claim_state,
    };
  }

  return {
    agent_id: args.agent.id,
    address: args.agent.address,
    idempotent: false,
    ...bus.publishTask({
      from: args.from,
      taskText: args.taskText,
      role: args.role,
      parentEventId: args.parentEventId,
      mr: args.mr,
      workspace: args.workspace,
      agent: args.agent,
    }),
  };
}

export interface MailFanoutOptions {
  command: string;
  // Fixed role for the command; when omitted the role is read from --role (fanout).
  role?: string;
  // Default mail-agent ids when neither --to-agent nor role auto-invite applies.
  defaultAgentIds?: string[];
  // Command-specific flags accepted on top of FANOUT_FLAGS (e.g. cross-review --auto).
  extraFlags?: readonly string[];
}

export interface MailFanoutClaimedRun {
  event_id: string;
  role: string;
  agent_id: string;
  mr: string;
  run: unknown;
}

// mailFanout returns instead of printing: callers own the output, so
// cross-review --auto can fold the fan-out payload into its final report
// rather than emitting two JSON documents from one invocation.
export interface MailFanoutOutcome {
  code: number;
  dry_run: boolean;
  thread: string;
  worktree: string;
  repo_key: string;
  remote_url: string;
  runs: MailFanoutClaimedRun[];
  payload: Record<string, unknown>;
}

const FANOUT_FLAGS = [
  "thread",
  "role",
  "to-agent",
  "task",
  "workspace",
  "worktree",
  "mr",
  "model",
  "from",
  "parent-event",
  "timeout-sec",
  "allow-dirty",
  "limit",
  "dry-run",
  // Harmless no-op: fan-out always prints JSON, but scripts habitually append it.
  "json",
] as const;

// Mail-native fan-out: derive mr/worktree from the thread, publish one task per
// target agent, then claim+run each. Replaces the need for explicit --mr.
export async function mailFanout(args: ParsedArgs, context: MailCliContext, opts: MailFanoutOptions): Promise<MailFanoutOutcome> {
  assertKnownFlags(args, opts.command, [...FANOUT_FLAGS, ...(opts.extraFlags ?? [])]);
  const thread = flagString(args, "thread");
  const worktree = mailWorktree(args);
  const repo = await getRepoIdentity(worktree);
  const threadDir = mailThreadDir(repo.repo_key, thread);
  ensureMailDirs(threadDir);
  const bus = new MaildirBus(threadDir, thread, repo.repo_key);

  const role = opts.role ?? flagString(args, "role");
  if (!isResultRole(role as RunRole)) {
    throw new CliError(`fan-out only supports result-schema roles: implementer, reviewer, verifier (got ${role})`);
  }

  const cfg = readMailAgentsConfig();
  const requested = collectFlags(args, "to-agent");
  const candidates =
    requested.length > 0
      ? requested.map((id) => agentById(id))
      : opts.defaultAgentIds
        ? opts.defaultAgentIds.map((id) => cfg.agents[id]).filter((agent): agent is MailAgentDefinition => Boolean(agent))
        : autoInviteAgentsForRole(cfg, role);

  const seen = new Set<string>();
  const agents = candidates.filter((agent) => (seen.has(agent.id) ? false : (seen.add(agent.id), true)));
  if (agents.length === 0) {
    throw new CliError(
      `no mail agents for role ${role}; run 'orch mail agent defaults' or pass --to-agent <id>`,
    );
  }
  for (const agent of agents) {
    if (!agent.roles.includes(role)) throw new CliError(`mail agent ${agent.id} does not support role ${role}`);
  }

  if (flagBool(args, "dry-run")) {
    return {
      code: 0,
      dry_run: true,
      thread,
      worktree,
      repo_key: repo.repo_key,
      remote_url: repo.remote_url,
      runs: [],
      payload: {
        mail: opts.command,
        thread,
        role,
        worktree,
        dry_run: true,
        agents: agents.map((agent) => ({ agent_id: agent.id, provider: agent.provider })),
      },
    };
  }

  const taskText = readFileSync(resolve(flagString(args, "task")), "utf8");
  const taskSha = sha256(taskText);
  const workspace = workspaceForMail(args.flags.has("workspace") ? flagString(args, "workspace") : undefined);
  const from = flagString(args, "from", "human@local.orch");
  const parentEventId = args.flags.has("parent-event") ? flagString(args, "parent-event") : null;
  const mr = args.flags.has("mr") ? flagString(args, "mr") : null;

  // Serialize the dedup-check → publish → deliver → import window: two concurrent
  // fan-outs would otherwise both miss findTask (events still in outbox) and
  // publish duplicate tasks with distinct event ids. Claiming has per-event locks.
  const fanoutLock = await acquireThreadLock(threadDir, "fanout.lock", `mail-${opts.command}`);
  let assigned: FanoutAssignment[];
  try {
    assigned = agents.map((agent) =>
      fanoutAssignment(bus, { agent, from, taskText, taskSha, role, parentEventId, mr, workspace }),
    );

    // Deliver + import so the freshly published task.requested events are claimable.
    const delivered = deliverLocalMail(threadDir);
    for (const item of delivered) {
      const imported = bus.importRaw(readFileSync(item.to, "utf8"), thread, repo.repo_key);
      if (!imported.imported && imported.reason) {
        throw new CliError(`fan-out mail quarantined (${imported.reason}): ${imported.quarantine_path ?? item.to}`);
      }
    }
  } finally {
    fanoutLock.release();
  }

  const runs: MailFanoutClaimedRun[] = [];
  for (const agent of agents) {
    const eventIds = assigned.filter((item) => item.agent_id === agent.id).map((item) => item.event_id);
    const claimed = await claimMailTasks(withAgentFlag(args, agent.id), threadDir, thread, worktree, repo.repo_key, context, { eventIds });
    runs.push(...claimed);
  }

  return {
    code: 0,
    dry_run: false,
    thread,
    worktree,
    repo_key: repo.repo_key,
    remote_url: repo.remote_url,
    runs,
    payload: { mail: opts.command, thread, role, worktree, assigned, runs },
  };
}

export async function mail(args: ParsedArgs, context: MailCliContext): Promise<number> {
  const mode = args.positionals[1];

  if (mode === "agent") {
    const action = args.positionals[2];
    if (action === "defaults") {
      let cfg = readMailAgentsConfig();
      for (const agent of defaultMailAgents(new Date().toISOString())) cfg = upsertMailAgent(cfg, agent);
      writeMailAgentsConfig(cfg);
      printJson({ mail: "agent-defaults", agents: Object.values(cfg.agents).sort((a, b) => a.id.localeCompare(b.id)) });
      return 0;
    }

    if (action === "bind") {
      const id = flagString(args, "id");
      const address = flagString(args, "address");
      const provider = flagString(args, "provider");
      const trust = flagString(args, "trust", "internal");
      if (trust !== "internal" && trust !== "external") throw new CliError("--trust must be internal or external");
      const roles = collectFlags(args, "role");
      if (roles.length === 0) throw new CliError("mail agent bind requires at least one --role <role>");
      const capabilities = collectFlags(args, "capability");
      const sessionMode = flagString(args, "session-mode", "fresh_persistent");
      if (sessionMode !== "ephemeral" && sessionMode !== "fresh_persistent" && sessionMode !== "resume_exact") {
        throw new CliError("--session-mode must be ephemeral, fresh_persistent, or resume_exact");
      }
      const cfg = upsertMailAgent(readMailAgentsConfig(), {
        id,
        address,
        provider,
        roles,
        capabilities,
        trust,
        auto_invite: flagBool(args, "auto-invite"),
        work_mode: flagString(args, "work-mode", roles[0]!),
        provider_session_mode: sessionMode,
        updated_at: new Date().toISOString(),
      });
      writeMailAgentsConfig(cfg);
      printJson({ mail: "agent-bound", config_path: mailAgentsConfigPath(), agent: cfg.agents[id] });
      return 0;
    }

    if (action === "list") {
      const cfg = readMailAgentsConfig();
      printJson({ mail: "agent-list", agents: Object.values(cfg.agents).sort((a, b) => a.id.localeCompare(b.id)) });
      return 0;
    }

    throw new CliError("usage: orch mail agent defaults|bind|list [flags]");
  }

  if (mode === "import" && !args.flags.has("thread")) {
    const fileFlag = flagString(args, "file");
    const raw = fileFlag === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(fileFlag), "utf8");
    const imported = importMailAuto(raw);
    printJson({ mail: imported.imported ? "imported" : "skipped", ...imported });
    return imported.quarantine_path ? 1 : 0;
  }

  if (mode === "neomutt" && !args.flags.has("thread")) {
    const neomutt = writeNeomuttConfig({
      mailboxes: await configuredWorkspaceMailboxes(),
      command: args.flags.has("command") ? flagString(args, "command") : undefined,
    });
    const launchCode = await maybeLaunchNeomutt(args, neomutt.rc_path, neomutt.maildir);
    if (launchCode !== null) return launchCode;
    printJson({ mail: "neomutt", scope: "all", ...neomutt });
    return 0;
  }

  if (mode === "sendmail") {
    const raw = args.flags.has("file") ? readFileSync(resolve(flagString(args, "file")), "utf8") : readFileSync(0, "utf8");
    const recipients = mailRecipients(raw, args.positionals);
    if (!recipients.some((value) => value === "orch-router@local.orch")) {
      throw new CliError("orch mail sendmail only handles messages addressed exactly to orch-router@local.orch");
    }
    const target = await inferMailTarget(args, raw);
    const repo = await getRepoIdentity(target.worktree);
    const threadDir = mailThreadDir(repo.repo_key, target.thread);
    ensureMailDirs(threadDir);
    const subject = mailHeader(raw, "Subject") ?? "mutt task";
    const body = mailBody(raw);
    const router = agentById("orch-router");
    const targetBus = new MaildirBus(threadDir, target.thread, repo.repo_key);
    const submitted = targetBus.publishTask({
      from: mailHeader(raw, "From") ?? "mutt@local.orch",
      taskText: [`Subject: ${subject}`, "", body || subject].join("\n"),
      role: "router",
      mr: args.flags.has("mr") ? flagString(args, "mr") : mailHeader(raw, "X-Orch-MR"),
      parentEventId: mailHeader(raw, "X-Orch-Parent-Event-ID"),
      workspace: target.workspace ?? null,
      agent: router,
    });
    const routerDelivered = deliverLocalMail(threadDir);
    for (const delivered of routerDelivered) targetBus.importRaw(readFileSync(delivered.to, "utf8"), target.thread, repo.repo_key);
    const assigned = await routeRouterTasks(threadDir, target.thread, repo.repo_key);
    const assignedDelivered = deliverLocalMail(threadDir);
    printJson({ mail: "sent-local", thread: target.thread, router_event_id: submitted.event_id, assigned, delivered: [...routerDelivered, ...assignedDelivered] });
    return 0;
  }

  const thread = flagString(args, "thread");
  const worktree = mailWorktree(args);
  const repo = await getRepoIdentity(worktree);
  const threadDir = mailThreadDir(repo.repo_key, thread);
  ensureMailDirs(threadDir);
  const bus = new MaildirBus(threadDir, thread, repo.repo_key);

  if (mode === "submit") {
    const router = agentById(flagString(args, "to-agent", "orch-router"));
    const taskText = readFileSync(resolve(flagString(args, "task")), "utf8");
    const mailResult = bus.publishTask({
      from: flagString(args, "from", "human@local.orch"),
      taskText,
      role: "router",
      parentEventId: args.flags.has("parent-event") ? flagString(args, "parent-event") : null,
      mr: args.flags.has("mr") ? flagString(args, "mr") : null,
      workspace: workspaceForMail(args.flags.has("workspace") ? flagString(args, "workspace") : undefined),
      agent: router,
    });
    printJson({ mail: "submitted", thread, to_agent: router.id, ...mailResult });
    return 0;
  }

  if (mode === "assign") {
    const role = flagString(args, "role");
    const taskText = readFileSync(resolve(flagString(args, "task")), "utf8");
    const cfg = readMailAgentsConfig();
    const fromAgent = args.flags.has("from-agent") ? cfg.agents[flagString(args, "from-agent")] : null;
    if (args.flags.has("from-agent") && !fromAgent) throw new CliError(`unknown mail agent: ${flagString(args, "from-agent")}`);
    const limit = flagNumber(args, "limit") ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(limit) && limit !== Number.POSITIVE_INFINITY) throw new CliError("--limit must be a number");
    if (limit <= 0) throw new CliError("--limit must be positive");
    const parentEventId = args.flags.has("parent-event") ? flagString(args, "parent-event") : null;
    const workspace = workspaceForMail(args.flags.has("workspace") ? flagString(args, "workspace") : undefined);
    const agents = args.flags.has("to-agent")
      ? [agentById(flagString(args, "to-agent"))]
      : autoInviteAgentsForRole(cfg, role).slice(0, limit);
    if (agents.length === 0) throw new CliError(`no auto-invite mail agents found for role: ${role}`);
    const assigned = agents.map((agent) => ({
      agent_id: agent.id,
      address: agent.address,
      ...bus.publishTask({
        from: fromAgent?.address ?? flagString(args, "from", "orch-router@local.orch"),
        taskText,
        role,
        parentEventId,
        mr: args.flags.has("mr") ? flagString(args, "mr") : null,
        workspace,
        agent,
      }),
    }));
    printJson({ mail: "assigned", thread, role, parent_event_id: parentEventId, assigned });
    return 0;
  }

  if (mode === "route") {
    const assigned = await routeRouterTasks(threadDir, thread, repo.repo_key);
    printJson({ mail: "routed", thread, assigned });
    return 0;
  }

  if (mode === "claim") {
    const claimed = await claimMailTasks(args, threadDir, thread, worktree, repo.repo_key, context);
    printJson({ mail: "claimed", thread, agent: flagString(args, "agent"), claimed });
    return 0;
  }

  if (mode === "reply" && args.positionals[2] === "result") {
    const runId = flagString(args, "run");
    const located = context.locateRun(repo.repo_key, runId);
    const { result } = context.readMirrorResult(`${mrStateDir(repo.repo_key, located.mr)}/runs`, runId);
    const fromAgent = agentById(flagString(args, "from-agent"));
    const toAgent = args.flags.has("to-agent") ? agentById(flagString(args, "to-agent")).address : flagString(args, "to", "orch-router@local.orch");
    const mailResult = bus.publishResult({
      parentEventId: args.flags.has("parent-event") ? flagString(args, "parent-event") : null,
      mr: located.mr,
      from: { id: fromAgent.id, address: fromAgent.address, provider: fromAgent.provider },
      to: toAgent,
      runId,
      result,
    });
    printJson({ mail: "result-replied", thread, run_id: runId, from_agent: fromAgent.id, ...mailResult });
    return 0;
  }

  if (mode === "compose" && args.positionals[2] === "decision") {
    const runId = flagString(args, "run");
    const located = context.locateRun(repo.repo_key, runId);
    const decisionRecord = readJsonFile<DecisionRecord | null>(`${located.run_dir}/decision.json`, null);
    if (!decisionRecord) throw new CliError(`decision.json not found for run: ${runId}`);
    const runsRoot = `${mrStateDir(repo.repo_key, located.mr)}/runs`;
    const { result, status } = context.readMirrorResult(runsRoot, runId);
    const cfg = readMailAgentsConfig();
    const fromAgent = args.flags.has("from-agent") ? cfg.agents[flagString(args, "from-agent")] : null;
    const toAgent = args.flags.has("to-agent") ? cfg.agents[flagString(args, "to-agent")] : null;
    if (args.flags.has("from-agent") && !fromAgent) throw new CliError(`unknown mail agent: ${flagString(args, "from-agent")}`);
    if (args.flags.has("to-agent") && !toAgent) throw new CliError(`unknown mail agent: ${flagString(args, "to-agent")}`);
    const mailResult = bus.publishDecision({
      mr: located.mr,
      runId,
      from: fromAgent?.address ?? flagString(args, "from", "orch-router@local.orch"),
      to: toAgent?.address ?? flagString(args, "to", "orch-agent@local.orch"),
      decision: decisionRecord,
      result,
      status,
      parentEventId: args.flags.has("parent-event") ? flagString(args, "parent-event") : null,
    });
    printJson({ mail: "queued", thread, run_id: runId, from_agent: fromAgent?.id ?? null, to_agent: toAgent?.id ?? null, ...mailResult });
    return 0;
  }

  if (mode === "deliver-local") {
    const delivered = deliverLocalMail(threadDir);
    printJson({ mail: "delivered-local", thread, delivered });
    return 0;
  }
  if (mode === "import") {
    const fileFlag = flagString(args, "file");
    const imported = fileFlag === "-" ? bus.importRaw(readFileSync(0, "utf8"), thread, repo.repo_key) : bus.importRaw(readFileSync(resolve(fileFlag), "utf8"), thread, repo.repo_key);
    printJson({ mail: imported.imported ? "imported" : "skipped", thread, ...imported });
    return imported.quarantine_path ? 1 : 0;
  }

  if (mode === "neomutt") {
    const neomutt = writeNeomuttConfig({
      threadDir,
      threadId: thread,
      worktree,
      command: args.flags.has("command") ? flagString(args, "command") : undefined,
    });
    const launchCode = await maybeLaunchNeomutt(args, neomutt.rc_path, neomutt.maildir);
    if (launchCode !== null) return launchCode;
    printJson({ mail: "neomutt", thread, ...neomutt });
    return 0;
  }
  if (mode === "path") {
    printJson({
      mail: "path",
      thread,
      thread_dir: threadDir,
      maildir: maildirPath(threadDir),
      events_path: mailEventsPath(threadDir),
    });
    return 0;
  }

  if (mode === "list") {
    printJson({ mail: "list", thread, pending: pendingLocalMailFiles(threadDir) });
    return 0;
  }

  throw new CliError("usage: orch mail agent defaults|bind|list or orch mail submit|route|claim|assign|reply result|compose decision|deliver-local|import|list|path|neomutt|sendmail [flags]");
}
