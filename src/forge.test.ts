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

test("mrRefFromText requires the number to be a whole path segment", () => {
  const remote = "https://github.com/o/r.git";
  const url = (tail: string): string => `see https://github.com/o/r/pull/${tail}`;

  // A word character after the digits is a typo or another object — the
  // original blocker: /pull/12O (letter O for zero) must never target 12.
  for (const bad of ["12abc", "12O", "12_foo", "12.5"]) {
    expect(mrRefFromText(url(bad), remote)).toBeNull();
  }
  // Segment boundaries and the MR's own .diff/.patch views resolve.
  for (const good of ["12", "12/files", "12?x=1", "12#discussion", "12.diff", "12.patch", "12,然后发布"]) {
    expect(mrRefFromText(url(good), remote)).toBe("12");
  }
  // A .diff view of something else entirely stays rejected.
  expect(mrRefFromText(url("12.diff.txt"), remote)).toBeNull();

  // Round-6 leak table: none of these are whole-segment MR numbers.
  for (const bad of ["12..diff", "12-foo", "12+foo", "12.diff/files", "12.patch/extra", "12%61bc", "12.patch5"]) {
    expect(mrRefFromText(url(bad), remote)).toBeNull();
  }
});

test("mrRefFromText sees adjacent URLs as separate candidates", () => {
  const remote = "https://github.com/o/r.git";
  const twelve = "https://github.com/o/r/pull/12";
  const thirteen = "https://github.com/o/r/pull/13";

  // Two distinct MRs glued by CJK or ASCII punctuation are ambiguous, never
  // silently resolved to the first number.
  for (const sep of ["\u3001", "\uFF0C", ",", ")"]) {
    expect(mrRefFromText(`${twelve}${sep}${thirteen}`, remote)).toBeNull();
  }
  // The same MR glued twice still dedups to one target.
  expect(mrRefFromText(`${twelve}\u3001${twelve}`, remote)).toBe("12");
  // Markdown link wrapping resolves after trailing punctuation trimming.
  expect(mrRefFromText(`review (${twelve}) today`, remote)).toBe("12");
});

test("mrRefFromText survives malformed and userinfo URLs", () => {
  const remote = "https://github.com/o/r.git";
  // Malformed authority: constructor throws, candidate skipped, no crash.
  expect(mrRefFromText("https://:80/o/r/pull/12", remote)).toBeNull();
  // userinfo before the real host is fine; a lookalike host in userinfo is not.
  expect(mrRefFromText("https://user@github.com/o/r/pull/12", remote)).toBe("12");
  expect(mrRefFromText("https://github.com@evil.com/o/r/pull/12", remote)).toBeNull();
});

test("mrRefFromText only accepts the remote forge's own route", () => {
  // A GitHub-style /pull/ URL on a GitLab host (or vice versa) is not a valid
  // target route, even with matching host and repo path.
  expect(mrRefFromText("https://git.n.xiaomi.com/ai-framework/osbot/pull/12", "git@git.n.xiaomi.com:ai-framework/osbot.git")).toBeNull();
  expect(mrRefFromText("https://github.com/o/r/-/merge_requests/12", "https://github.com/o/r.git")).toBeNull();
});

test("mrRefFromText normalizes scheme, host case, default ports, and clone suffixes", () => {
  const sshRemote = "git@github.com:o/r.git";
  // WHATWG URL drops the default port and lowercases scheme/host.
  expect(mrRefFromText("HTTPS://GitHub.com:443/o/r/pull/12", sshRemote)).toBe("12");
  expect(mrRefFromText("http://github.com/o/r/pull/12", sshRemote)).toBe("12");
  // Uppercase .GIT and a trailing slash on the remote still identify the repo.
  expect(mrRefFromText("https://github.com/o/r/pull/12", "https://github.com/o/r.GIT/")).toBe("12");
  // An explicit non-default port must match on both sides.
  expect(mrRefFromText("https://git.corp:8443/o/r/-/merge_requests/3", "https://git.corp:8443/o/r.git")).toBe("3");
  expect(mrRefFromText("https://git.corp:9999/o/r/-/merge_requests/3", "https://git.corp:8443/o/r.git")).toBeNull();
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
