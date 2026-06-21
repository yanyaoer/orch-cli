import { DurableObject } from "cloudflare:workers";
import { PendingRegistry, isRpcResponse, type RpcRequest } from "./protocol.ts";

const CALL_TIMEOUT_MS = 30_000;

// Holds the single inbound WebSocket from the local ws-agent and brokers
// request/response RPC between ChatGPT's tool calls (via the MCP agent) and the
// local agent. Uses the hibernatable WebSocket API.
export class BridgeDO extends DurableObject<Env> {
  // In-memory pairing of in-flight calls. An awaited call() keeps the DO alive,
  // so the registry survives for the duration of each request.
  #pending = new PendingRegistry();

  // /ws upgrade from the local agent.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    // Replace any stale connection so the newest local agent wins.
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "replaced by new connection");
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Invoked over DO RPC by the MCP agent. Forwards to the local agent and awaits
  // the matching response, or rejects on timeout / disconnect.
  async call(method: string, params: unknown): Promise<unknown> {
    const ws = this.ctx.getWebSockets()[0];
    if (!ws) throw new Error("local bridge agent is not connected");
    const id = crypto.randomUUID();
    const request: RpcRequest = { id, method, params };
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => this.#pending.settle({ id, error: { message: `rpc timeout after ${CALL_TIMEOUT_MS}ms` } }),
        CALL_TIMEOUT_MS,
      );
      this.#pending.register(
        id,
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
      ws.send(JSON.stringify(request));
    });
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return; // ignore non-JSON frames
    }
    if (isRpcResponse(parsed)) this.#pending.settle(parsed);
  }

  async webSocketClose(): Promise<void> {
    this.#pending.rejectAll(new Error("local bridge disconnected"));
  }

  async webSocketError(): Promise<void> {
    this.#pending.rejectAll(new Error("local bridge socket error"));
  }
}
