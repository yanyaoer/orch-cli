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

test("detectForge matches the github host exactly, not as a substring", () => {
  const cases: Array<[string, "github" | "gitlab" | "none"]> = [
    ["git@github.com:o/r.git", "github"],
    ["https://gist.github.com/o/r.git", "github"],
    // Substring lookalikes must not classify as github.
    ["https://github.com.attacker.net/o/r.git", "gitlab"],
    ["git@notgithub.com:o/r.git", "gitlab"],
    // GitHub Enterprise stays gitlab until an explicit forge override exists.
    ["git@github.mycorp.com:o/r.git", "gitlab"],
  ];
  for (const [remote, expected] of cases) {
    expect(detectForge(remote)).toBe(expected);
  }
});
