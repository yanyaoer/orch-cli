// Surfaces slated for removal. Usage audit 2026-10-20 (local state, 2026-09-20..10-20):
// none of these had a run or call in that window, while the run/status/result
// path carried the load. They keep working until removed; invoking one prints a
// single stderr notice so stdout (and --json) stays unchanged.
export const DEPRECATED_COMMANDS: Record<string, string> = {
  new: "no runs since 2026-08",
  prewalk: "no calls in the last 30 days",
  fanout: "no runs in the last 30 days; use orch run create per agent",
  investigate: "no runs in the last 30 days; use orch run create --role researcher",
  mail: "only reached through cross-review routing; no direct calls in the last 30 days",
  mailctl: "no controller runs since 2026-08",
  dispatch: "only serves the sandboxed controller (mailctl / orch new)",
  workspace: "only serves mail routing",
  "chatgpt-bridge": "unused since 2026-06",
  "handoff-pro": "no calls in the last 30 days",
};

export const DEPRECATED_SANDBOX_REASON = "config sandbox:true (seatbelt-v1) had no runs in the last 30 days; use the provider's native sandbox";

// Children spawned by a deprecated command (mailctl -> run create, new -> mail)
// inherit this, so one invocation prints one notice.
const WARNED_ENV = "ORCH_DEPRECATION_WARNED";

export function deprecationNotice(subject: string, reason: string): string {
  return `[orch] deprecated: ${subject} is slated for removal (${reason}). See CHANGELOG.md "Deprecated".\n`;
}

export function warnDeprecated(subject: string, reason: string, env: NodeJS.ProcessEnv = process.env, write: (text: string) => void = (text) => process.stderr.write(text)): void {
  if (env[WARNED_ENV] === "1") return;
  env[WARNED_ENV] = "1";
  write(deprecationNotice(subject, reason));
}

export function warnDeprecatedCommand(command: string | undefined, env?: NodeJS.ProcessEnv, write?: (text: string) => void): void {
  if (!command) return;
  const reason = DEPRECATED_COMMANDS[command];
  if (reason) warnDeprecated(`orch ${command}`, reason, env, write);
}
