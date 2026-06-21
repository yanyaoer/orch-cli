// WebSocket RPC protocol shared by the Worker BridgeDO and the local ws-agent.
// Pure TypeScript (no Worker/Bun globals) so both sides can import it.

// Read-only tool method names. The MCP tools forward these to the local agent.
export const RPC = {
  openWorkspace: "open_workspace",
  read: "read",
  search: "search",
  showChanges: "show_changes",
} as const;

export type RpcMethod = (typeof RPC)[keyof typeof RPC];

export interface RpcRequest {
  id: string;
  method: string;
  params: unknown;
}

export interface RpcError {
  message: string;
}

export interface RpcResponse {
  id: string;
  result?: unknown;
  error?: RpcError;
}

export function isRpcRequest(value: unknown): value is RpcRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.method === "string" && "params" in v;
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && ("result" in v || "error" in v);
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

// Pairs outbound requests with inbound responses by id. Pure (no timers/IO) so
// the pairing logic is unit-testable; the DO owns id generation and timeouts.
export class PendingRegistry {
  #pending = new Map<string, Pending>();

  get size(): number {
    return this.#pending.size;
  }

  register(id: string, resolve: (result: unknown) => void, reject: (error: Error) => void): void {
    this.#pending.set(id, { resolve, reject });
  }

  // Returns true if the response matched a pending request.
  settle(response: RpcResponse): boolean {
    const pending = this.#pending.get(response.id);
    if (!pending) return false;
    this.#pending.delete(response.id);
    if (response.error) pending.reject(new Error(response.error.message));
    else pending.resolve(response.result);
    return true;
  }

  rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
