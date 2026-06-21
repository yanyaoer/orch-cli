import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { RPC } from "./protocol.ts";

// Read-only MCP server exposed to ChatGPT over Streamable HTTP. Each tool simply
// forwards to the local ws-agent (via BridgeDO) and returns its JSON result.
export class BridgeMcp extends McpAgent<Env> {
  server = new McpServer(
    { name: "orch-chatgpt-bridge", version: "0.1.0" },
    {
      instructions: [
        "orch-chatgpt-bridge gives read-only access to one local code worktree.",
        "Workflow: 1) call open_workspace first to see the root, AGENTS.md/CLAUDE.md and git status.",
        "2) use read to open files (paths are relative to the worktree root).",
        "3) use search (ripgrep) to find code. 4) use show_changes for uncommitted diffs.",
        "All tools are read-only; there are no write or shell tools.",
      ].join("\n"),
    },
  );

  async init(): Promise<void> {
    // Every tool is a read-only inspection of the local worktree; advertise that
    // via MCP annotations so clients (e.g. ChatGPT) don't flag them as destructive
    // writes and gate/withhold them.
    const readOnly = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    } as const;

    this.server.registerTool(
      "open_workspace",
      {
        description: "Show the local worktree root, AGENTS.md/CLAUDE.md presence + summary, and git status.",
        inputSchema: {},
        annotations: readOnly,
      },
      async () => this.#forward(RPC.openWorkspace, {}),
    );

    this.server.registerTool(
      "read",
      {
        description: "Read a UTF-8 text file inside the worktree. Path is relative to the worktree root.",
        inputSchema: { path: z.string().describe("File path relative to the worktree root") },
        annotations: readOnly,
      },
      async ({ path }) => this.#forward(RPC.read, { path }),
    );

    this.server.registerTool(
      "search",
      {
        description: "Search the worktree with ripgrep (falls back to grep). Returns matching lines.",
        inputSchema: {
          query: z.string().describe("Search pattern"),
          path: z.string().optional().describe("Optional sub-path (relative to the worktree root) to scope the search"),
        },
        annotations: readOnly,
      },
      async ({ query, path }) => this.#forward(RPC.search, { query, path }),
    );

    this.server.registerTool(
      "show_changes",
      {
        description: "Show uncommitted changes: `git status --short` plus `git diff` (large diffs are truncated).",
        inputSchema: {},
        annotations: readOnly,
      },
      async () => this.#forward(RPC.showChanges, {}),
    );
  }

  // Singleton BridgeDO: a single deployment serves one local agent per token,
  // and the HTTP edge has already validated the token before we get here.
  async #forward(method: string, params: unknown) {
    const stub = this.env.BRIDGE_DO.get(this.env.BRIDGE_DO.idFromName("default"));
    try {
      const result = await stub.call(method, params);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text" as const, text: `error: ${message}` }], isError: true };
    }
  }
}
