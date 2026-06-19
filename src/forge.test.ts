import { expect, test } from "bun:test";
import { detectForge } from "./forge.ts";

test("detectForge classifies github ssh remotes", () => {
  expect(detectForge("git@github.com:o/r.git")).toBe("github");
});

test("detectForge classifies github https remotes", () => {
  expect(detectForge("https://github.com/o/r.git")).toBe("github");
});

test("detectForge classifies gitlab.com remotes", () => {
  expect(detectForge("https://gitlab.com/o/r.git")).toBe("gitlab");
});

test("detectForge classifies self-hosted git remotes as gitlab", () => {
  expect(detectForge("git@git.n.xiaomi.com:o/r.git")).toBe("gitlab");
});

test("detectForge returns none for local paths", () => {
  expect(detectForge("/Users/example/repo")).toBe("none");
});
