#!/usr/bin/env bun
import { runProviderDriver } from "./driver-common.ts";

export async function runCodexDriver(argv: string[]): Promise<number> {
  return runProviderDriver("codex", argv);
}

if (import.meta.main) {
  runCodexDriver(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    });
}
