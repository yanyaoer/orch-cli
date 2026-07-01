#!/usr/bin/env bun
import { runProviderDriver } from "./driver-common.ts";

export async function runAgyDriver(argv: string[]): Promise<number> {
  return runProviderDriver("agy", argv);
}

if (import.meta.main) {
  runAgyDriver(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    });
}
