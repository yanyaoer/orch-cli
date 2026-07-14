import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchDir,
  insideSandbox,
  proxyToHost,
  reconcileDispatchOnce,
  shouldProxyToHost,
  type DispatchResult,
} from "./dispatch.ts";
import { SEATBELT_ENV_MARKER } from "../drivers/driver-common.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-dispatch-"));
  tempDirs.push(dir);
  return dir;
}

test("shouldProxyToHost proxies mutations, keeps reads local", () => {
  // Mutations / worker spawns → host.
  expect(shouldProxyToHost(["run", "create"])).toBe(true);
  expect(shouldProxyToHost(["run", "cancel"])).toBe(true);
  expect(shouldProxyToHost(["fanout"])).toBe(true);
  expect(shouldProxyToHost(["cross-review"])).toBe(true);
  expect(shouldProxyToHost(["decision"])).toBe(true);
  expect(shouldProxyToHost(["mail"])).toBe(true);
  expect(shouldProxyToHost(["mirror"])).toBe(true);
  // Reads stay in-sandbox.
  expect(shouldProxyToHost(["run", "list"])).toBe(false);
  expect(shouldProxyToHost(["wait"])).toBe(false);
  expect(shouldProxyToHost(["result"])).toBe(false);
  expect(shouldProxyToHost(["status"])).toBe(false);
  expect(shouldProxyToHost(["overview"])).toBe(false);
});

test("insideSandbox reads the seatbelt marker", () => {
  expect(insideSandbox({})).toBe(false);
  expect(insideSandbox({ [SEATBELT_ENV_MARKER]: "seatbelt-v1" })).toBe(true);
});

// The core boundary: a request enqueued from the "sandboxed" side is executed
// by the host reconciler (unsandboxed), and its stdout/stderr/exit are relayed
// back to the blocked caller. The reconciler runs a fake orch that echoes argv
// and stdin so the round-trip is deterministic and needs no real provider.
test("proxyToHost round-trips through reconcileDispatchOnce", async () => {
  const stateRoot = tempDir();
  const fakeOrch = join(stateRoot, "fake-orch.js");
  writeFileSync(
    fakeOrch,
    String.raw`
const argv = process.argv.slice(2);
const stdin = require("node:fs").readFileSync(0, "utf8");
process.stdout.write(JSON.stringify({ argv, stdin }) + "\n");
process.stderr.write("fake-orch stderr\n");
process.exit(argv.includes("--boom") ? 7 : 0);
`,
    "utf8",
  );
  const orchCommand = [process.execPath, fakeOrch];

  const runProxy = (argv: string[], stdin: string) =>
    proxyToHost({ argv, stdin, cwd: stateRoot }, { stateRoot, pollMs: 20 });

  // Drive the reconciler concurrently until both requests are fulfilled.
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      await reconcileDispatchOnce(orchCommand, { stateRoot });
      await new Promise((r) => setTimeout(r, 20));
    }
  })();

  const ok = await runProxy(["run", "create", "--mr", "9"], "task body\n");
  expect(ok.exit_code).toBe(0);
  expect(JSON.parse(ok.stdout.trim())).toEqual({ argv: ["run", "create", "--mr", "9"], stdin: "task body\n" });
  expect(ok.stderr).toContain("fake-orch stderr");

  const boom = await runProxy(["decision", "--boom"], "");
  expect(boom.exit_code).toBe(7);

  stop = true;
  await loop;
  // Queue is drained: no leftover pending/done files.
  const pending = join(dispatchDir(stateRoot), "pending");
  expect(!existsSync(pending) || readdirSync(pending).filter((f) => f.endsWith(".json")).length).toBeFalsy();
});

test("reconcileDispatchOnce strips the sandbox marker so host runs never re-proxy", async () => {
  const stateRoot = tempDir();
  const fakeOrch = join(stateRoot, "fake-orch.js");
  // Echoes whether the marker leaked into the host-run env.
  writeFileSync(
    fakeOrch,
    String.raw`process.stdout.write(JSON.stringify({ marker: process.env[${JSON.stringify(SEATBELT_ENV_MARKER)}] ?? null }));`,
    "utf8",
  );
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      await reconcileDispatchOnce([process.execPath, fakeOrch], { stateRoot, env: { ...process.env, [SEATBELT_ENV_MARKER]: "seatbelt-v1" } });
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  const result: DispatchResult = await proxyToHost({ argv: ["decision"], stdin: "", cwd: stateRoot }, { stateRoot, pollMs: 20 });
  stop = true;
  await loop;
  expect(JSON.parse(result.stdout)).toEqual({ marker: null });
});
