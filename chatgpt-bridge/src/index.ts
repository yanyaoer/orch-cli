import { BridgeMcp } from "./mcp.ts";
import { BridgeDO } from "./bridge-do.ts";

// Durable Object classes must be exported from the Worker entrypoint.
export { BridgeMcp, BridgeDO };

function tokenOk(url: URL, env: Env): boolean {
  return Boolean(env.BRIDGE_TOKEN) && url.searchParams.get("token") === env.BRIDGE_TOKEN;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Local agent's outbound WebSocket.
    if (url.pathname === "/ws") {
      if (!tokenOk(url, env)) return new Response("unauthorized", { status: 401 });
      return env.BRIDGE_DO.get(env.BRIDGE_DO.idFromName("default")).fetch(request);
    }

    // ChatGPT MCP connector (Streamable HTTP).
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      if (!tokenOk(url, env)) return new Response("unauthorized", { status: 401 });
      return BridgeMcp.serve("/mcp", { binding: "BRIDGE_MCP" }).fetch(request, env, ctx);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
