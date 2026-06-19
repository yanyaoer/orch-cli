import { createHash, randomBytes } from "node:crypto";

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortHash(input: string | Uint8Array, length = 8): string {
  return sha256(input).slice(0, length);
}

export function randomHex(bytes = 3): string {
  return randomBytes(bytes).toString("hex");
}

