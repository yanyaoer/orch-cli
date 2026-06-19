#!/usr/bin/env bun
import {
  buildPrompt,
  extractResultFromRunDir,
  maybeWriteFakeResult,
  parseDriverArgs,
  pipeToFile,
  readSpec,
  synthesizeResult,
  writeExitCode,
  writeResult,
} from "./driver-common.ts";

export async function runClaudeDriver(argv: string[]): Promise<number> {
  const args = parseDriverArgs(argv);
  const spec = readSpec(args.specPath);
  if (await maybeWriteFakeResult(args.runDir, spec, "claude")) return 0;

  const prompt = buildPrompt(spec, "claude");
  const proc = Bun.spawn(
    ["claude", "-p", "--verbose", "--output-format", "stream-json", "--input-format", "text"],
    {
      cwd: args.worktree,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: process.env,
    },
  );
  proc.stdin.write(prompt);
  proc.stdin.end();

  await pipeToFile(proc.stdout, `${args.runDir}/native.jsonl`);
  const code = await proc.exited;
  writeExitCode(args.runDir, code);
  writeResult(
    args.runDir,
    spec,
    extractResultFromRunDir(args.runDir, spec) ??
      synthesizeResult(spec, code === 0 ? "claude did not return a valid orch result JSON" : `claude exited ${code}`),
  );
  return code;
}

if (import.meta.main) {
  runClaudeDriver(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    });
}
