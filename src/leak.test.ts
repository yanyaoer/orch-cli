import { afterEach, expect, test } from "bun:test";
import { assertNoPrivateLeak, findPrivateLeak, redactPrivatePaths } from "./leak.ts";

const ORIGINAL_ALLOW = process.env.ORCH_MIRROR_ALLOW_PRIVATE;

afterEach(() => {
  if (ORIGINAL_ALLOW === undefined) {
    delete process.env.ORCH_MIRROR_ALLOW_PRIVATE;
  } else {
    process.env.ORCH_MIRROR_ALLOW_PRIVATE = ORIGINAL_ALLOW;
  }
});

test("private leak guard allows safe mirror bodies", () => {
  const body = "### orch run result\n\nSummary:\n\nImplemented safe changes.";
  expect(findPrivateLeak(body)).toBeNull();
  expect(() => assertNoPrivateLeak(body)).not.toThrow();
});

test("private leak guard rejects obvious local paths", () => {
  for (const marker of ["/Users/alice/project", "/home/alice/project", "C:\\Users\\alice\\repo", ".claude/settings.json", ".local/state/orch/repo"]) {
    expect(findPrivateLeak(marker)).not.toBeNull();
    expect(() => assertNoPrivateLeak(marker)).toThrow("ORCH_MIRROR_ALLOW_PRIVATE=1");
  }
});

test("private path redaction removes path-shaped spans without a global bypass", () => {
  const redacted = redactPrivatePaths(
    [
      "mac: /Users/alice/My Secret: project/file.txt and trailing detail",
      "linux: /home/bob/客户资料/file.txt",
      "windows: C:\\Users\\carol\\My Secret\\src",
      "config: .claude/settings.json",
      "state: .local/state/orch/repo",
    ].join("\n"),
  );
  expect(redacted.markers.sort()).toEqual([".claude", ".local/state/orch", "/Users/", "/home/", "C:\\Users\\"].sort());
  expect(findPrivateLeak(redacted.text)).toBeNull();
  expect(redacted.text).not.toContain("alice");
  expect(redacted.text).not.toContain("carol");
  expect(redacted.text).not.toContain("Secret");
  expect(redacted.text).not.toContain("客户资料");
});

test("private leak guard can be bypassed for local testing", () => {
  process.env.ORCH_MIRROR_ALLOW_PRIVATE = "1";
  expect(() => assertNoPrivateLeak("/Users/alice/project")).not.toThrow();
});
