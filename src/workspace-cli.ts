import { resolve } from "node:path";
import { CliError, flagString, printJson, type ParsedArgs } from "./cli.ts";
import { orchConfigPath, readOrchConfig, upsertWorkspace, writeOrchConfig } from "./config.ts";

export async function workspace(args: ParsedArgs): Promise<number> {
  const action = args.positionals[1];
  if (action === "add") {
    const id = flagString(args, "id");
    const path = resolve(flagString(args, "path", process.cwd()));
    const cfg = upsertWorkspace(readOrchConfig(), id, path, new Date().toISOString());
    writeOrchConfig(cfg);
    printJson({ workspace: "added", config_path: orchConfigPath(), entry: cfg.workspaces[id] });
    return 0;
  }
  if (action === "list") {
    const cfg = readOrchConfig();
    printJson({ workspace: "list", workspaces: Object.values(cfg.workspaces).sort((a, b) => a.id.localeCompare(b.id)) });
    return 0;
  }
  throw new CliError("usage: orch workspace add|list [flags]");
}
