import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspace, buildBridgeUrls, parseWorkersUrl, readBridgeConfig, readOrchConfig, readMailAgentsConfig, upsertMailAgent, upsertWorkspace, type BridgeConfig, type MailAgentsConfig } from "./config.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "orch-config-")));
  tempDirs.push(dir);
  return dir;
}

test("parseWorkersUrl extracts the workers.dev URL from wrangler deploy output", () => {
  const stdout = [
    "Total Upload: 12.34 KiB / gzip: 3.45 KiB",
    "Uploaded orch-chatgpt-bridge (1.23 sec)",
    "Deployed orch-chatgpt-bridge triggers (0.45 sec)",
    "  https://orch-chatgpt-bridge.my-acct.workers.dev",
    "Current Version ID: abc-123",
  ].join("\n");
  expect(parseWorkersUrl(stdout)).toBe("https://orch-chatgpt-bridge.my-acct.workers.dev");
  expect(parseWorkersUrl("no url here")).toBeNull();
});

test("buildBridgeUrls derives https mcp (with token) and wss ws (no token)", () => {
  const { mcp_url, ws_url } = buildBridgeUrls("https://orch-chatgpt-bridge.my-acct.workers.dev", "secret123");
  expect(mcp_url).toBe("https://orch-chatgpt-bridge.my-acct.workers.dev/mcp?token=secret123");
  expect(ws_url).toBe("wss://orch-chatgpt-bridge.my-acct.workers.dev/ws");
});

test("buildBridgeUrls maps http base to ws for local dev", () => {
  const { mcp_url, ws_url } = buildBridgeUrls("http://localhost:8787", "test");
  expect(mcp_url).toBe("http://localhost:8787/mcp?token=test");
  expect(ws_url).toBe("ws://localhost:8787/ws");
});

test("addWorkspace appends and dedupes by realpath", () => {
  const dir = tempDir();
  let cfg: BridgeConfig = { workspaces: [] };
  cfg = addWorkspace(cfg, dir, "2026-06-21T00:00:00.000Z");
  expect(cfg.workspaces).toHaveLength(1);
  // Re-adding the same path (via a trailing-slash variant) replaces, not duplicates.
  cfg = addWorkspace(cfg, `${dir}/`, "2026-06-21T01:00:00.000Z");
  expect(cfg.workspaces).toHaveLength(1);
  expect(cfg.workspaces[0]!.added_at).toBe("2026-06-21T01:00:00.000Z");
});

test("readBridgeConfig returns an empty workspace list when no config exists", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempDir();
  try {
    expect(readBridgeConfig()).toEqual({ workspaces: [] });
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("mail agent config records mailbox and capabilities by id", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempDir();
  try {
    const empty = readMailAgentsConfig();
    expect(empty).toEqual({ version: 1, agents: {} });
    const cfg: MailAgentsConfig = upsertMailAgent(empty, {
      id: "codex-review-a",
      address: "orch+codex.review.a@example.com",
      provider: "codex",
      roles: ["reviewer"],
      capabilities: ["tests"],
      max_concurrency: 2,
      trust: "internal",
      auto_invite: true,
      work_mode: "review",
      provider_session_mode: "fresh_persistent",
      updated_at: "2026-06-24T00:00:00.000Z",
    });
    expect(cfg.agents["codex-review-a"]).toMatchObject({
      address: "orch+codex.review.a@example.com",
      provider: "codex",
      roles: ["reviewer"],
      capabilities: ["tests"],
      max_concurrency: 2,
      work_mode: "review",
      provider_session_mode: "fresh_persistent",
    });
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("orch config records project workspaces by id", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  const dir = tempDir();
  process.env.XDG_CONFIG_HOME = tempDir();
  try {
    const empty = readOrchConfig();
    expect(empty).toEqual({ version: 1, workspaces: {} });
    const cfg = upsertWorkspace(empty, "orch-cli", dir, "2026-06-24T00:00:00.000Z");
    expect(cfg.workspaces["orch-cli"]).toMatchObject({
      id: "orch-cli",
      path: dir,
      added_at: "2026-06-24T00:00:00.000Z",
    });
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});
