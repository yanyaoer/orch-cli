import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  addWorkspace,
  buildBridgeUrls,
  mailAgentsConfigPath,
  mailControlConfigPath,
  parseWorkersUrl,
  readBridgeConfig,
  readMailControlConfig,
  readOrchConfig,
  readMailAgentsConfig,
  resolveMailPassword,
  upsertMailAgent,
  upsertWorkspace,
  validateMailControlConfig,
  writeMailControlConfig,
  type BridgeConfig,
  type MailAgentsConfig,
  type MailControlConfig,
} from "./config.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "orch-config-")));
  tempDirs.push(dir);
  return dir;
}

function validMailControlConfig(): MailControlConfig {
  return {
    version: 1,
    account: { user: "bot@example.com", password: "secret" },
    imap: { host: "imap.example.com", port: 993 },
    smtp: { host: "smtp.example.com", port: 465, mode: "implicit", from: "bot@example.com" },
    allowed_senders: ["alice@example.com"],
    trusted_authserv_id: "mx.example.com",
    workspace: "orch-cli",
    reconcile_interval_sec: 60,
    subject_token: null,
    require_auth_results: true,
    controller: { agent: "claude", model: null, timeout_sec: 1800, max_spawns_per_hour: 6 },
    reports: { policy: "auto", max_per_hour: 4, max_body_bytes: 16384 },
    notify: { enabled: false, max_per_hour: 30 },
  };
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
      work_mode: "review",
      provider_session_mode: "fresh_persistent",
    });
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("mail agent config loads on-disk JSON that still carries legacy fields", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempDir();
  try {
    const path = mailAgentsConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        agents: {
          "legacy-agent": {
            id: "legacy-agent",
            address: "orch+legacy@example.com",
            provider: "codex",
            roles: ["reviewer"],
            capabilities: ["tests"],
            max_concurrency: 2,
            trust: "internal",
            auto_invite: true,
            work_mode: "review",
            provider_session_mode: "fresh_persistent",
            updated_at: "2026-06-24T00:00:00.000Z",
          },
        },
      }),
    );
    const cfg = readMailAgentsConfig();
    expect(cfg.agents["legacy-agent"]).toMatchObject({
      id: "legacy-agent",
      provider: "codex",
      roles: ["reviewer"],
    });
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("mail control config round-trips with 0600 permissions", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempDir();
  try {
    const cfg = validMailControlConfig();
    writeMailControlConfig(cfg);
    expect(readMailControlConfig()).toEqual(cfg);
    expect(statSync(mailControlConfigPath()).mode & 0o777).toBe(0o600);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("mail control config fills the notify default for legacy files", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempDir();
  try {
    const legacy = validMailControlConfig() as Partial<MailControlConfig>;
    delete legacy.notify;
    mkdirSync(dirname(mailControlConfigPath()), { recursive: true });
    writeFileSync(mailControlConfigPath(), JSON.stringify(legacy));

    const loaded = readMailControlConfig();
    expect(loaded.notify).toEqual({ enabled: false, max_per_hour: 30 });
    expect(() => validateMailControlConfig(loaded)).not.toThrow();
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("mail control config fills missing fields in partial notify objects", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempDir();
  try {
    const partial = { ...validMailControlConfig(), notify: { enabled: true } };
    mkdirSync(dirname(mailControlConfigPath()), { recursive: true });
    writeFileSync(mailControlConfigPath(), JSON.stringify(partial));

    const loaded = readMailControlConfig();
    expect(loaded.notify).toEqual({ enabled: true, max_per_hour: 30 });
    expect(() => validateMailControlConfig(loaded)).not.toThrow();

    writeFileSync(mailControlConfigPath(), JSON.stringify({ ...validMailControlConfig(), notify: { max_per_hour: 7 } }));
    const loadedWithoutEnabled = readMailControlConfig();
    expect(loadedWithoutEnabled.notify).toEqual({ enabled: false, max_per_hour: 7 });
    expect(() => validateMailControlConfig(loadedWithoutEnabled)).not.toThrow();

    writeFileSync(mailControlConfigPath(), JSON.stringify({ ...validMailControlConfig(), notify: "invalid" }));
    expect(() => validateMailControlConfig(readMailControlConfig())).toThrow(/notify.*object/);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("mail control config validation rejects invalid required fields", () => {
  const missing = validMailControlConfig() as Partial<MailControlConfig>;
  delete missing.workspace;
  expect(() => validateMailControlConfig(missing as MailControlConfig)).toThrow(/workspace/);
  expect(() => validateMailControlConfig({ ...validMailControlConfig(), imap: { host: "imap.example.com", port: 0 } })).toThrow(/imap\.port/);
  expect(() => validateMailControlConfig({ ...validMailControlConfig(), imap: { host: "imap.example.com", port: 65536 } })).toThrow(/imap\.port/);
  expect(() =>
    validateMailControlConfig({
      ...validMailControlConfig(),
      smtp: { host: "smtp.example.com", port: 65536, mode: "implicit" },
    }),
  ).toThrow(/smtp\.port/);
  expect(() =>
    validateMailControlConfig({
      ...validMailControlConfig(),
      smtp: { host: "smtp.example.com", port: 1.5, mode: "implicit" },
    }),
  ).toThrow(/smtp\.port/);
  expect(() =>
    validateMailControlConfig({
      ...validMailControlConfig(),
      smtp: { host: "smtp.example.com", port: 587, mode: "plain" as MailControlConfig["smtp"]["mode"] },
    }),
  ).toThrow(/smtp\.mode/);
  expect(() =>
    validateMailControlConfig({
      ...validMailControlConfig(),
      controller: { agent: "codex" as MailControlConfig["controller"]["agent"], model: null, timeout_sec: 1800, max_spawns_per_hour: 6 },
    }),
  ).toThrow(/controller\.agent/);
  expect(() => validateMailControlConfig({ ...validMailControlConfig(), allowed_senders: [] })).toThrow(/allowed_senders/);
  expect(() => validateMailControlConfig({ ...validMailControlConfig(), allowed_senders: ["Alice@example.com"] })).toThrow(/allowed_senders/);
  expect(() => validateMailControlConfig({ ...validMailControlConfig(), allowed_senders: ["<a@b.com>"] })).toThrow(/allowed_senders/);
  expect(() =>
    validateMailControlConfig({
      ...validMailControlConfig(),
      reports: { policy: "sometimes" as MailControlConfig["reports"]["policy"], max_per_hour: 4, max_body_bytes: 16384 },
    }),
  ).toThrow(/reports\.policy/);
  for (const to of ["Owner@example.com", "owner @example.com", "<owner@example.com>"]) {
    expect(() => validateMailControlConfig({ ...validMailControlConfig(), notify: { enabled: true, to, max_per_hour: 30 } })).toThrow(/notify\.to/);
  }
  expect(() =>
    validateMailControlConfig({ ...validMailControlConfig(), notify: { enabled: "yes" as unknown as boolean, max_per_hour: 30 } }),
  ).toThrow(/notify\.enabled/);
  for (const max_per_hour of [0, -1, Number.NaN]) {
    expect(() => validateMailControlConfig({ ...validMailControlConfig(), notify: { enabled: true, max_per_hour } })).toThrow(/notify\.max_per_hour/);
  }
});

test("resolveMailPassword prefers password_cmd argv without shell evaluation", async () => {
  await expect(resolveMailPassword({ ...validMailControlConfig(), account: { user: "bot@example.com", password: "fallback", password_cmd: ["printf", "secret"] } })).resolves.toBe("secret");
  await expect(resolveMailPassword({ ...validMailControlConfig(), account: { user: "bot@example.com", password_cmd: ["printf", "$(printf owned);secret"] } })).resolves.toBe("$(printf owned);secret");
  await expect(resolveMailPassword({ ...validMailControlConfig(), account: { user: "bot@example.com", password: "fallback" } })).resolves.toBe("fallback");
  await expect(resolveMailPassword({ ...validMailControlConfig(), account: { user: "bot@example.com" } })).rejects.toThrow(/password/);
  await expect(resolveMailPassword({ ...validMailControlConfig(), account: { user: "bot@example.com", password_cmd: ["false"] } })).rejects.toThrow(/exit code 1/);
  await expect(resolveMailPassword({ ...validMailControlConfig(), account: { user: "bot@example.com", password_cmd: [] } })).rejects.toThrow(/non-empty argv/);
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

test("mail control notify.to must be a single lower-cased bare address", () => {
  const withTo = (to: string): MailControlConfig => ({
    ...validMailControlConfig(),
    notify: { enabled: true, to, max_per_hour: 5 },
  });
  expect(() => validateMailControlConfig(withTo("owner@example.com"))).not.toThrow();
  for (const bad of ["a@x.com,c@evil.com", "a@x.com;c@evil.com", "nodomain", "a@@x.com", "a@", "@x.com", "Owner@example.com"]) {
    expect(() => validateMailControlConfig(withTo(bad))).toThrow("single lower-cased bare address");
  }
});
