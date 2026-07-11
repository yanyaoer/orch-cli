export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
  flagValues: Map<string, string[]>;
}

export class CliError extends Error {}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  const flagValues = new Map<string, string[]>();
  const addFlagValue = (key: string, value: string): void => {
    flagValues.set(key, [...(flagValues.get(key) ?? []), value]);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-n") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        flags.set("n", true);
      } else {
        flags.set("n", next);
        addFlagValue("n", next);
        i += 1;
      }
      continue;
    }
    if (arg === "-f") {
      flags.set("follow", true);
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      const key = body.slice(0, eq);
      const value = body.slice(eq + 1);
      flags.set(key, value);
      addFlagValue(key, value);
      continue;
    }
    const key = body;
    const next = argv[i + 1];
    // -n and -f are flags of their own (special-cased above), never flag
    // values: without this, a boolean flag right before one swallows it
    // (--native -n 2, --native -f).
    if (!next || next.startsWith("--") || next === "-n" || next === "-f") {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      addFlagValue(key, next);
      i += 1;
    }
  }
  return { positionals, flags, flagValues };
}

export function flagString(args: ParsedArgs, name: string, fallback?: string): string {
  const value = args.flags.get(name);
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new CliError(`missing --${name}`);
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

export function hasHelp(args: ParsedArgs): boolean {
  return args.flags.has("help");
}

export function collectFlags(args: ParsedArgs, name: string): string[] {
  return args.flagValues.get(name) ?? [];
}

// parseArgs accepts any --flag; commands that opt in reject unknown ones so a
// typo (or an unsupported flag like a stray --model) fails loudly instead of
// being silently ignored.
export function assertKnownFlags(args: ParsedArgs, command: string, allowed: Iterable<string>): void {
  const allowedSet = new Set(allowed);
  allowedSet.add("help");
  for (const key of args.flags.keys()) {
    if (!allowedSet.has(key)) {
      throw new CliError(`unknown flag --${key} for ${command}; see: orch ${command} --help`);
    }
  }
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  if (!args.flags.has(name)) return undefined;
  const value = Number(flagString(args, name));
  if (!Number.isFinite(value)) throw new CliError(`--${name} must be a number`);
  return value;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// `--task -` support: read the whole task text from stdin. Lets a controller
// whose Bash is restricted to `orch *` author tasks via heredoc instead of
// needing a Write tool.
export async function readStdinText(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}
