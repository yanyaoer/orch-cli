import { expect, test } from "bun:test";
import { detectForge, mrRefFromText } from "./forge.ts";

test("mrRefFromText only accepts a unique same-repo MR/PR URL", () => {
  const gitlabRemote = "git@git.n.xiaomi.com:ai-framework/osbot.git";
  const githubRemote = "https://github.com/yanyaoer/orch-cli.git";

  // Unique same-repo target resolves, for both remote syntaxes.
  expect(mrRefFromText("crocs-review https://git.n.xiaomi.com/ai-framework/osbot/-/merge_requests/4245", gitlabRemote)).toBe("4245");
  expect(mrRefFromText("review https://github.com/yanyaoer/orch-cli/pull/12 please", githubRemote)).toBe("12");

  // The same target mentioned twice is still unambiguous.
  expect(
    mrRefFromText(
      "https://git.n.xiaomi.com/ai-framework/osbot/-/merge_requests/7 and again https://git.n.xiaomi.com/ai-framework/osbot/-/merge_requests/7",
      gitlabRemote,
    ),
  ).toBe("7");

  // Cross-repo URLs are references, never targets.
  expect(mrRefFromText("处理时参考 https://git.example.com/other/repo/-/merge_requests/123 的实现", gitlabRemote)).toBeNull();
  expect(mrRefFromText("参考 https://git.n.xiaomi.com/other-group/osbot/-/merge_requests/123", gitlabRemote)).toBeNull();

  // Two distinct same-repo numbers are ambiguous -> fail closed.
  expect(
    mrRefFromText(
      "https://git.n.xiaomi.com/ai-framework/osbot/-/merge_requests/1 vs https://git.n.xiaomi.com/ai-framework/osbot/-/merge_requests/2",
      gitlabRemote,
    ),
  ).toBeNull();

  // A same-repo target still wins when a cross-repo reference is also present.
  expect(
    mrRefFromText(
      "评审 https://git.n.xiaomi.com/ai-framework/osbot/-/merge_requests/3440,参考 https://git.example.com/x/y/-/merge_requests/9",
      gitlabRemote,
    ),
  ).toBe("3440");

  // No URL, or a broken remote, resolves nothing.
  expect(mrRefFromText("处理 MR 456", gitlabRemote)).toBeNull();
  expect(mrRefFromText("https://git.n.xiaomi.com/ai-framework/osbot/-/merge_requests/1", "")).toBeNull();
});

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
