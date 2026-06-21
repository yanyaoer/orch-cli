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

export function assertNoPrivateLeak(text: string): void {
  if (privateLeakAllowed()) return;

  const finding = findPrivateLeak(text);
  if (!finding) return;

  throw new Error(privateLeakErrorMessage(finding));
}
