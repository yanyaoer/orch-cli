import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileFollower } from "./json.ts";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "orch-json-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("createFileFollower drains appended complete lines exactly once", () => {
  withDir((dir) => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, "a\nb\n");
    const follower = createFileFollower(path);
    expect(follower.drain()).toEqual(["a", "b"]);
    expect(follower.drain()).toEqual([]);
    writeFileSync(path, "a\nb\nc\n");
    expect(follower.drain()).toEqual(["c"]);
  });
});

test("createFileFollower buffers a half-written line until its newline arrives", () => {
  withDir((dir) => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, "a\npart");
    const follower = createFileFollower(path);
    expect(follower.drain()).toEqual(["a"]);
    writeFileSync(path, "a\npartial\n");
    expect(follower.drain()).toEqual(["partial"]);
  });
});

test("createFileFollower starts from the given byte offset", () => {
  withDir((dir) => {
    const path = join(dir, "events.jsonl");
    const head = "a\nb\n";
    writeFileSync(path, `${head}c\n`);
    const follower = createFileFollower(path, Buffer.byteLength(head, "utf8"));
    expect(follower.drain()).toEqual(["c"]);
  });
});

test("createFileFollower tolerates a missing file and reports sawFile", () => {
  withDir((dir) => {
    const path = join(dir, "late.jsonl");
    const follower = createFileFollower(path);
    expect(follower.drain()).toEqual([]);
    expect(follower.sawFile()).toBe(false);
    writeFileSync(path, "x\n");
    expect(follower.drain()).toEqual(["x"]);
    expect(follower.sawFile()).toBe(true);
  });
});

test("createFileFollower re-reads a shrunken file from the top", () => {
  withDir((dir) => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, "a\nb\n");
    const follower = createFileFollower(path);
    expect(follower.drain()).toEqual(["a", "b"]);
    writeFileSync(path, "z\n");
    expect(follower.drain()).toEqual(["z"]);
  });
});
