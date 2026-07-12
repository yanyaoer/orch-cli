export interface PrivateLeakFinding {
  marker: string;
}

const PRIVATE_MARKERS = ["/Users/", "/home/", ".claude", ".local/state/orch"] as const;
const WINDOWS_USERS_PATH = /[A-Za-z]:\\Users\\/;

export function findPrivateLeak(text: string): PrivateLeakFinding | null {
  for (const marker of PRIVATE_MARKERS) {
    if (text.includes(marker)) return { marker };
  }
  return WINDOWS_USERS_PATH.test(text) ? { marker: "C:\\Users\\" } : null;
}

export function privateLeakAllowed(): boolean {
  return process.env.ORCH_MIRROR_ALLOW_PRIVATE === "1";
}

export function privateLeakErrorMessage(finding: PrivateLeakFinding): string {
  return [
    `refusing to mirror comment body: detected private local path marker (${finding.marker})`,
    "Remove private paths from the run result or decision reason before mirroring.",
    "For local testing only, set ORCH_MIRROR_ALLOW_PRIVATE=1 to bypass this guard.",
  ].join("\n");
}

export interface PrivateLeakRedaction {
  text: string;
  markers: string[];
}

// Mail/projector output sometimes discusses the leak guard itself. Redact only
// path-shaped spans, then run the unchanged policy again; callers must never
// treat this as a bypass for secret-pattern checks.
export function redactPrivatePaths(text: string): PrivateLeakRedaction {
  const markers = new Set<string>();
  const replace = (pattern: RegExp, marker: string, replacement: string): void => {
    text = text.replace(pattern, () => {
      markers.add(marker);
      return replacement;
    });
  };
  // Paths can legally contain spaces, colons, Unicode, and shell punctuation.
  // Without a parser for every platform/shell representation, the only safe
  // boundary is the line: redact from the private marker through EOL rather
  // than risk preserving a sensitive suffix after an unfamiliar character.
  replace(/\/Users\/[^\r\n]*/g, "/Users/", "[redacted-local-path]");
  replace(/\/home\/[^\r\n]*/g, "/home/", "[redacted-local-path]");
  replace(/[A-Za-z]:\\Users\\[^\r\n]*/g, "C:\\Users\\", "[redacted-local-path]");
  replace(/\.local\/state\/orch[^\r\n]*/g, ".local/state/orch", "$ORCH_STATE");
  replace(/\.claude[^\r\n]*/g, ".claude", "[redacted-private-config]");
  return { text, markers: [...markers] };
}

export function assertNoPrivateLeak(text: string): void {
  if (privateLeakAllowed()) return;

  const finding = findPrivateLeak(text);
  if (!finding) return;

  throw new Error(privateLeakErrorMessage(finding));
}
