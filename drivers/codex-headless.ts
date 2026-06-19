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

async function main(): Promise<number> {
  const args = parseDriverArgs(process.argv.slice(2));
  const spec = readSpec(args.specPath);
  if (await maybeWriteFakeResult(args.runDir, spec, "codex")) return 0;

  const prompt = buildPrompt(spec, "codex");
  const lastMessagePath = `${args.runDir}/last_message.txt`;
  const proc = Bun.spawn(
    ["codex", "exec", "--json", "--cd", args.worktree, "--output-last-message", lastMessagePath, "-"],
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

  const extracted = extractResultFromRunDir(args.runDir, spec);
  writeResult(
    args.runDir,
    spec,
    extracted ?? synthesizeResult(spec, code === 0 ? "codex did not return a valid orch result JSON" : `codex exited ${code}`),
  );
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
