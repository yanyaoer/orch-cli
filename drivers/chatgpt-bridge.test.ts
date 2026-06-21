import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateBridgeDir, resolveSafePath } from "./chatgpt-bridge.ts";
import { PendingRegistry, type RpcResponse } from "../chatgpt-bridge/src/protocol.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function worktree(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "orch-bridge-")));
  tempDirs.push(dir);
  writeFileSync(join(dir, "AGENTS.md"), "# agents\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "main.ts"), "export const x = 1;\n");
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "config"), "[core]\n");
  return dir;
}

test("resolveSafePath accepts files inside the worktree", () => {
  const root = worktree();
  expect(resolveSafePath(root, "AGENTS.md")).toBe(join(root, "AGENTS.md"));
  expect(resolveSafePath(root, "src/main.ts")).toBe(join(root, "src", "main.ts"));
  // Non-existent but in-scope paths are allowed (the caller reports "not found").
  expect(resolveSafePath(root, "src/new.ts")).toBe(join(root, "src", "new.ts"));
});

test("resolveSafePath rejects traversal and absolute escapes", () => {
  const root = worktree();
  expect(() => resolveSafePath(root, "../outside.txt")).toThrow(/escapes worktree/);
  expect(() => resolveSafePath(root, "src/../../escape")).toThrow(/escapes worktree/);
  expect(() => resolveSafePath(root, "/etc/passwd")).toThrow(/escapes worktree/);
  expect(() => resolveSafePath(root, "")).toThrow(/path is required/);
});

test("resolveSafePath blocks sensitive files and dirs", () => {
  const root = worktree();
  expect(() => resolveSafePath(root, ".env")).toThrow(/blocked/);
  expect(() => resolveSafePath(root, ".env.local")).toThrow(/blocked/);
  expect(() => resolveSafePath(root, ".git/config")).toThrow(/blocked/);
  expect(() => resolveSafePath(root, "node_modules/pkg/index.js")).toThrow(/blocked/);
  expect(() => resolveSafePath(root, "deploy/server.pem")).toThrow(/blocked/);
  expect(() => resolveSafePath(root, ".ssh/id_rsa")).toThrow(/blocked/);
});

test("locateBridgeDir accepts the worker dir or a parent that contains it", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orch-locate-")));
  tempDirs.push(root);
  const workerDir = join(root, "chatgpt-bridge");
  mkdirSync(workerDir);
  writeFileSync(join(workerDir, "wrangler.jsonc"), "{}\n");
  // Pointing at the worker dir itself, or its parent, both resolve to the worker dir.
  expect(locateBridgeDir(workerDir)).toBe(workerDir);
  expect(locateBridgeDir(root)).toBe(workerDir);
  expect(() => locateBridgeDir(join(root, "nope"))).toThrow(/no chatgpt-bridge Worker source/);
});

test("PendingRegistry resolves a matching response", async () => {
  const registry = new PendingRegistry();
  const promise = new Promise<unknown>((resolve, reject) => registry.register("a", resolve, reject));
  expect(registry.size).toBe(1);
  const matched = registry.settle({ id: "a", result: { ok: true } } satisfies RpcResponse);
  expect(matched).toBe(true);
  expect(await promise).toEqual({ ok: true });
  expect(registry.size).toBe(0);
});

test("PendingRegistry rejects on error responses and ignores unknown ids", async () => {
  const registry = new PendingRegistry();
  const promise = new Promise<unknown>((resolve, reject) => registry.register("b", resolve, reject));
  expect(registry.settle({ id: "unknown", result: 1 })).toBe(false);
  expect(registry.settle({ id: "b", error: { message: "boom" } })).toBe(true);
  await expect(promise).rejects.toThrow(/boom/);
});

test("PendingRegistry.rejectAll fails every pending call", async () => {
  const registry = new PendingRegistry();
  const promise = new Promise<unknown>((resolve, reject) => registry.register("c", resolve, reject));
  registry.rejectAll(new Error("disconnected"));
  expect(registry.size).toBe(0);
  await expect(promise).rejects.toThrow(/disconnected/);
});
