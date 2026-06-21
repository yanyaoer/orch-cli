import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { RPC } from "./protocol.ts";

// Read-only MCP server exposed to ChatGPT over Streamable HTTP. Each tool simply
// forwards to the local ws-agent (via BridgeDO) and returns its JSON result.
export class BridgeMcp extends McpAgent<Env> {
  server = new McpServer({ name: "orch-chatgpt-bridge", version: "0.1.0" });

  async init(): Promise<void> {
    this.server.registerTool(
      "open_workspace",
      {
        description: "Show the local worktree root, AGENTS.md/CLAUDE.md presence + summary, and git status.",
        inputSchema: {},
      },
      async () => this.#forward(RPC.openWorkspace, {}),
    );

    this.server.registerTool(
      "read",
      {
        description: "Read a UTF-8 text file inside the worktree. Path is relative to the worktree root.",
        inputSchema: { path: z.string().describe("File path relative to the worktree root") },
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
      },
      async ({ query, path }) => this.#forward(RPC.search, { query, path }),
    );

    this.server.registerTool(
      "show_changes",
      {
        description: "Show uncommitted changes: `git status --short` plus `git diff` (large diffs are truncated).",
        inputSchema: {},
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
