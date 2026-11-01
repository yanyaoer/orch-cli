// Claude Code's interactive mode (TUI) as a headless worker.
//
// Anthropic counts a request by its entrypoint: `claude -p` reports
// `sdk-cli`, which draws on a subscription's allowance at a higher rate than
// the interactive `cli` (anthropics/claude-code#97074; yetone/magpie made its
// Claude bridge interactive by default for this reason). A TUI run is the real
// interactive Claude Code: the same argv minus what only -p takes, started in
// a pseudo-terminal, with the prompt as its initial message. What it does is
// read back from the session transcript
// (`<CLAUDE_CONFIG_DIR>/projects/*/<session>.jsonl`) and written to
// native.jsonl in claude -p's stream-json shapes (assistant / user / result),
// so result extraction, resume-id detection and usage evidence are unchanged.
//
// A run that cannot be interactive is -p, as before (claudeRunMode): the mode
// is set to print (ORCH_CLAUDE_MODE=print or config.json claude.mode), the run
// is sandboxed, or the prompt is too long for one argument. A TUI that never
// takes its prompt (no prompt row within the ready wait, a sign-in screen, a
// folder trust question orch may not answer, an early exit) has done nothing,
// and the driver runs the same turn as -p (`started: false`).

import { closeSync, existsSync, openSync, readdirSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ClaudeMode = "tui" | "print";

export interface ClaudeModeChoice {
  mode: ClaudeMode;
  // Why the run is -p; null for a TUI run.
  why: string | null;
}

// One argv argument carries the prompt; Linux caps a single argument at
// 128 KiB (MAX_ARG_STRLEN), macOS caps the whole exec at 1 MiB.
export const TUI_PROMPT_MAX_BYTES = 120 * 1024;

export function configuredClaudeMode(env: NodeJS.ProcessEnv, configMode: unknown): { mode: ClaudeMode; source: string } {
  const fromEnv = env.ORCH_CLAUDE_MODE?.trim();
  if (fromEnv === "print" || fromEnv === "tui") return { mode: fromEnv, source: "ORCH_CLAUDE_MODE" };
  if (configMode === "print" || configMode === "tui") return { mode: configMode, source: "config.json claude.mode" };
  return { mode: "tui", source: "default" };
}

export function claudeRunMode(input: {
  env: NodeJS.ProcessEnv;
  configMode: unknown;
  sandboxed: boolean;
  prompt: string;
  platform?: NodeJS.Platform;
}): ClaudeModeChoice {
  const { mode, source } = configuredClaudeMode(input.env, input.configMode);
  if (mode === "print") return { mode, why: `${source} is print` };
  const platform = input.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return { mode: "print", why: `no pseudo-terminal support on ${platform}` };
  if (input.sandboxed) return { mode: "print", why: "the run is sandboxed (the interactive mode is not tried under Seatbelt)" };
  const bytes = Buffer.byteLength(input.prompt, "utf8");
  if (bytes > TUI_PROMPT_MAX_BYTES) return { mode: "print", why: `the prompt is ${bytes} bytes, over the ${TUI_PROMPT_MAX_BYTES} one argument carries` };
  return { mode: "tui", why: null };
}

// Flags only -p takes, and how many values each consumes.
const PRINT_ONLY_FLAGS: Record<string, number> = {
  "-p": 0,
  "--print": 0,
  "--verbose": 0,
  "--include-partial-messages": 0,
  "--no-session-persistence": 0,
  "--output-format": 1,
  "--input-format": 1,
  "--json-schema": 1,
};

// Interactive argv from claude's -p argv: the -p-only flags go, a fresh
// session gets the given --session-id (a resumed one keeps --resume), tools
// that wait for a person are not offered, and the prompt is the initial
// message after `--` (several flags take a variable number of values and
// would otherwise swallow it).
export function claudeTuiArgv(printArgv: readonly string[], sessionId: string, prompt: string): string[] {
  if (printArgv[0] !== "claude") throw new Error(`claudeTuiArgv expects a claude argv, got ${printArgv[0]}`);
  const out: string[] = ["claude"];
  let resumed = false;
  for (let i = 1; i < printArgv.length; i++) {
    const arg = printArgv[i]!;
    if (arg in PRINT_ONLY_FLAGS) {
      i += PRINT_ONLY_FLAGS[arg]!;
      continue;
    }
    if (arg === "--resume") resumed = true;
    out.push(arg);
  }
  if (!resumed) out.push("--session-id", sessionId);
  // AskUserQuestion and ExitPlanMode wait for an answer at the terminal that
  // nobody gives; -p has no one to ask either.
  out.push("--disallowedTools", "AskUserQuestion,ExitPlanMode");
  out.push("--", prompt);
  return out;
}

export function resumedSessionId(argv: readonly string[]): string | null {
  const i = argv.indexOf("--resume");
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

export function claudeConfigDir(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
}

export function findTranscript(configDir: string, sessionId: string): string | null {
  const projects = join(configDir, "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const path = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

type Usage = { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number };

function isPrompt(message: any): boolean {
  const content = message?.content;
  if (typeof content === "string") return true;
  if (!Array.isArray(content) || content.length === 0) return false;
  return !content.some((block: any) => block?.type === "tool_result");
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
}

// Transcript rows -> claude -p stream-json lines. Claude Code writes an
// assistant message one row per content block under the message's id; each
// goes on as it comes, as -p tells a message it does not stream. An API error
// is a <synthetic> message, and a turn's end a turn_duration row: both become
// the turn's result envelope. Usage is the run's total, as -p's result has it.
export class TranscriptTranslator {
  started = false;
  turns = 0;
  resultsSeen = 0;
  lastResultError = false;
  inTurn = false;
  private turnFailed = false;
  private usageById = new Map<string, Usage>();
  private texts = new Map<string, string[]>();
  private lastTextId: string | null = null;
  private messagesInTurn = new Set<string>();

  constructor(
    private readonly sessionId: string,
    private readonly emit: (line: Record<string, unknown>) => void,
    private readonly cwd: string,
    // Rows written before the run started (a resumed session's history) are
    // not this run's: they are skipped by timestamp.
    private readonly since: number = 0,
  ) {}

  private usage(): Usage {
    const total: Usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
    for (const u of this.usageById.values()) {
      total.input_tokens += u.input_tokens;
      total.cache_creation_input_tokens += u.cache_creation_input_tokens;
      total.cache_read_input_tokens += u.cache_read_input_tokens;
      total.output_tokens += u.output_tokens;
    }
    return total;
  }

  private beginTurn(): void {
    if (!this.started) {
      this.started = true;
      this.emit({ type: "system", subtype: "init", session_id: this.sessionId, cwd: this.cwd, orch_claude_mode: "tui" });
    }
    this.inTurn = true;
    this.turnFailed = false;
    this.lastTextId = null;
    this.messagesInTurn.clear();
  }

  private endTurn(result: Record<string, unknown>): void {
    this.inTurn = false;
    this.turns++;
    this.resultsSeen++;
    this.lastResultError = result.is_error === true;
    this.emit({ ...result, session_id: this.sessionId, num_turns: this.messagesInTurn.size, usage: this.usage(), orch_claude_mode: "tui" });
  }

  row(line: string): void {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    if (!r || typeof r !== "object" || r.isSidechain) return;
    if (this.since && typeof r.timestamp === "string" && Date.parse(r.timestamp) < this.since) return;
    if (r.type === "user") {
      // Meta rows (system reminders, hook output) are context, not turns.
      if (r.isMeta) return;
      const prompt = isPrompt(r.message);
      if (prompt && !this.inTurn) this.beginTurn();
      if (!this.started) return;
      if (!prompt) this.emit({ type: "user", message: r.message, session_id: this.sessionId, parent_tool_use_id: null });
      return;
    }
    if (!this.started) return;
    if (r.type === "assistant") {
      const m = r.message ?? {};
      this.emit({ type: "assistant", message: m, session_id: this.sessionId, parent_tool_use_id: null });
      if (m.model === "<synthetic>") {
        if (r.isApiErrorMessage) {
          this.turnFailed = true;
          this.endTurn({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: messageText(m.content),
            ...(typeof r.apiErrorStatus === "number" ? { api_error_status: r.apiErrorStatus } : {}),
          });
        }
        return;
      }
      if (typeof m.id === "string" && m.id) {
        this.messagesInTurn.add(m.id);
        const u = m.usage ?? {};
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        this.usageById.set(m.id, {
          input_tokens: n(u.input_tokens),
          cache_creation_input_tokens: n(u.cache_creation_input_tokens),
          cache_read_input_tokens: n(u.cache_read_input_tokens),
          output_tokens: n(u.output_tokens),
        });
        const text = messageText(m.content);
        if (text) {
          if (this.lastTextId !== m.id) this.texts.set(m.id, []);
          this.texts.get(m.id)!.push(text);
          this.lastTextId = m.id;
        }
      }
      return;
    }
    if (r.type === "system" && r.subtype === "turn_duration") {
      if (this.turnFailed || !this.inTurn) {
        this.inTurn = false;
        return;
      }
      const text = this.lastTextId ? (this.texts.get(this.lastTextId) ?? []).join("\n") : "";
      this.endTurn({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: typeof r.durationMs === "number" ? r.durationMs : undefined,
        result: text,
      });
    }
  }

  // The session ended (or was ended) inside a turn: -p would have ended the
  // turn with an error envelope.
  abort(reason: string): void {
    if (this.started && this.inTurn) this.endTurn({ type: "result", subtype: "error_during_execution", is_error: true, result: reason });
  }
}

// --- screen ---------------------------------------------------------------

// What the terminal shows, as plain text with whitespace dropped: escape
// sequences position the words, so "Yes, I trust" arrives as "Yes,Itrust".
export function flatScreen(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\s+/g, "");
}

export type ScreenState = "trust_no" | "trust_yes" | "sign_in" | "other";

// Claude Code asks for a tool's permission with a numbered choice list, the
// selection on "1.", and "Esc to cancel" under it: "Do you want to
// proceed?", "Do you want to make this edit to …?", "Allow this read outside
// the working directories?" (2.1.316, a plan-mode Read of a persisted tool
// output), and wordings to come. The question itself is not matched, only
// the shape of the choice list.
export function permissionQuestion(flat: string): boolean {
  const esc = flat.lastIndexOf("Esctocancel");
  if (esc < 0) return false;
  const before = flat.slice(Math.max(0, esc - 4000), esc);
  const choice = before.lastIndexOf("❯1.");
  return choice >= 0 && /\?/.test(before.slice(0, choice));
}

// What a permission question is answered with: -p has nobody to ask either,
// and denies the call; the turn goes on.
export const PERMISSION_DENIED_MESSAGE =
  "That tool call needed a permission nobody can give: this run is unattended (as with claude -p), so it was denied. Continue the task without it.";

export function screenState(flat: string): ScreenState {
  const trust = flat.lastIndexOf("trustthisfolder");
  if (trust >= 0) {
    const no = flat.lastIndexOf("❯No,exit");
    const yes = flat.lastIndexOf("❯Yes,Itrust");
    if (yes > no) return "trust_yes";
    return "trust_no";
  }
  if (/Selectloginmethod|\/logintosignin|Pleaserun\/login|Notloggedin/i.test(flat)) return "sign_in";
  return "other";
}

// --- run ------------------------------------------------------------------

export interface TuiRunInput {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  sessionId: string;
  resumed: boolean;
  ephemeral: boolean;
  nativePath: string;
  nativeMode: "w" | "a";
  // Answer Claude Code's folder trust question with yes (ORCH_CLAUDE_TUI_TRUST,
  // default on: -p never asks it, so answering keeps -p's behavior).
  trustFolder: boolean;
  readyMs?: number;
  settleMs?: number;
  pollMs?: number;
  onEvent?: (event: Record<string, unknown>) => void;
}

export interface TuiRunResult {
  started: boolean;
  code: number;
  why: string | null;
  transcript: string | null;
}

const SCREEN_KEEP = 64 * 1024;

export async function runClaudeTui(input: TuiRunInput): Promise<TuiRunResult> {
  const readyMs = input.readyMs ?? Number(process.env.ORCH_CLAUDE_TUI_READY_MS ?? 60_000);
  const settleMs = input.settleMs ?? Number(process.env.ORCH_CLAUDE_TUI_SETTLE_MS ?? 3_000);
  const pollMs = input.pollMs ?? 100;
  const configDir = claudeConfigDir(input.env);
  let transcript = input.resumed ? findTranscript(configDir, input.sessionId) : null;
  let offset = transcript ? statSync(transcript).size : 0;
  let pending = "";
  let screen = "";
  // Screen text before this index has been dealt with (a permission
  // question answered); it moves with the trimming below.
  let screenMark = 0;
  const decoder = new TextDecoder();

  let nativeFd: number | null = null;
  const writeNative = (line: Record<string, unknown>) => {
    if (nativeFd === null) nativeFd = openSync(input.nativePath, input.nativeMode);
    writeSync(nativeFd, `${JSON.stringify(line)}\n`);
  };
  // Clock skew between this process and Claude Code's timestamps is nil (same
  // host); the margin only absorbs rounding.
  const translator = new TranscriptTranslator(input.sessionId, writeNative, input.cwd, Date.now() - 1000);

  const proc = Bun.spawn(input.argv, {
    cwd: input.cwd,
    env: input.env,
    terminal: {
      cols: 200,
      rows: 50,
      data(_terminal: unknown, data: Uint8Array) {
        screen += decoder.decode(data, { stream: true });
        if (screen.length > SCREEN_KEEP) {
          const drop = screen.length - SCREEN_KEEP;
          screen = screen.slice(drop);
          screenMark = Math.max(0, screenMark - drop);
        }
      },
    },
  } as any);
  const terminal = (proc as any).terminal as { write(data: string): void; close?(): void } | undefined;
  const send = (data: string) => {
    try {
      terminal?.write(data);
    } catch {}
  };

  // The driver's own signals end the interactive Claude Code too: it runs in
  // a session of its own, outside the process group the supervisor kills.
  const onSignal = (signal: NodeJS.Signals) => {
    try {
      proc.kill("SIGTERM");
    } catch {}
    process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
  };
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, onSignal);

  const readRows = () => {
    if (!transcript) transcript = findTranscript(configDir, input.sessionId);
    if (!transcript) return;
    let size: number;
    try {
      size = statSync(transcript).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const fd = openSync(transcript, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      pending += buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.trim()) translator.row(line);
    }
  };

  const t0 = Date.now();
  let why: string | null = null;
  let trustPressedAt = 0;
  let trustYesSince = 0;
  let trustAnswered = false;
  let settledAt: number | null = null;
  // A permission question seen at (with the transcript at offset), and the
  // steps of answering it: Esc, then the denial pasted, then Enter.
  let askSeenAt = 0;
  let askOffset = -1;
  let denyStep = 0;
  let denyAt = 0;
  const permissionWaitMs = Number(process.env.ORCH_CLAUDE_TUI_PERMISSION_WAIT_MS ?? 2_000);
  let resultsAtSettle = -1;
  let exited = false;
  proc.exited.then(() => {
    exited = true;
  });

  try {
    while (true) {
      await Bun.sleep(pollMs);
      readRows();
      if (!translator.started) {
        if (exited) {
          readRows();
          if (!translator.started) {
            why = `Claude Code exited (${proc.exitCode ?? proc.signalCode}) before it took the prompt`;
            break;
          }
          continue;
        }
        const state = screenState(flatScreen(screen));
        if (state === "sign_in") {
          why = "Claude Code asks to sign in";
          break;
        }
        if (state === "trust_no" || state === "trust_yes") {
          if (!input.trustFolder) {
            why = "Claude Code asks whether to trust the folder and ORCH_CLAUDE_TUI_TRUST=0";
            break;
          }
          // The question opens on "No, exit"; a key sent while it is being
          // drawn can be lost, so move to "Yes" and press Enter only once
          // "Yes" has stayed selected for a moment.
          const now = Date.now();
          if (state === "trust_no") {
            trustYesSince = 0;
            if (now - trustPressedAt > 300) {
              send("\x1b[B");
              trustPressedAt = now;
            }
          } else if (!trustAnswered) {
            if (!trustYesSince) trustYesSince = now;
            else if (now - trustYesSince >= 300) {
              send("\r");
              trustAnswered = true;
              input.onEvent?.({ type: "claude_tui_trust", answered: "yes" });
            }
          }
        }
        if (Date.now() - t0 > readyMs) {
          why = `Claude Code took no prompt in ${readyMs}ms`;
          break;
        }
        continue;
      }
      if (exited) {
        readRows();
        translator.abort(`Claude Code exited (${proc.exitCode ?? proc.signalCode}) before the turn ended`);
        break;
      }
      if (denyStep > 0) {
        const now = Date.now();
        if (denyStep === 1 && now - denyAt >= 1000) {
          send(`\x1b[200~${PERMISSION_DENIED_MESSAGE}\x1b[201~`);
          denyStep = 2;
          denyAt = now;
        } else if (denyStep === 2 && now - denyAt >= 300) {
          send("\r");
          denyStep = 0;
          screenMark = screen.length;
          input.onEvent?.({ type: "claude_tui_permission", answered: "denied" });
        }
        settledAt = null;
        continue;
      }
      if (translator.inTurn) {
        settledAt = null;
        if (permissionQuestion(flatScreen(screen.slice(screenMark)))) {
          // Answered only once it has stayed up with the transcript still:
          // a question being drawn over is not one being asked.
          if (!askSeenAt || askOffset !== offset) {
            askSeenAt = Date.now();
            askOffset = offset;
          } else if (Date.now() - askSeenAt >= permissionWaitMs) {
            send("\x1b");
            denyStep = 1;
            denyAt = Date.now();
            askSeenAt = 0;
            screenMark = screen.length;
          }
        } else askSeenAt = 0;
        continue;
      }
      // A turn ended. A background task's notification or a reminder may
      // start another turn at once, as it would wake a -p session; wait a
      // moment for one before ending the session.
      if (settledAt === null || resultsAtSettle !== translator.resultsSeen) {
        settledAt = Date.now();
        resultsAtSettle = translator.resultsSeen;
        continue;
      }
      if (Date.now() - settledAt >= settleMs) break;
    }
  } finally {
    for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(s, onSignal);
    if (!exited) {
      try {
        proc.kill("SIGTERM");
      } catch {}
      const killed = await Promise.race([proc.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
      if (!killed) {
        try {
          proc.kill("SIGKILL");
        } catch {}
        await proc.exited;
      }
    }
    try {
      terminal?.close?.();
    } catch {}
    if (nativeFd !== null) closeSync(nativeFd);
  }

  if (!translator.started) {
    const tail = flatScreen(screen).slice(-300);
    return { started: false, code: 1, why: `${why ?? "Claude Code did not start"}${tail ? `; screen: ${tail}` : ""}`, transcript };
  }
  // -p's --no-session-persistence leaves no transcript; neither does an
  // ephemeral TUI run, once it has been read.
  if (input.ephemeral && transcript) {
    rmSync(transcript, { force: true });
    rmSync(transcript.replace(/\.jsonl$/, ""), { recursive: true, force: true });
  }
  return { started: true, code: translator.resultsSeen > 0 && !translator.lastResultError ? 0 : 1, why: null, transcript };
}
