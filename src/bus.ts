import { existsSync, readFileSync } from "node:fs";
import { appendJsonLine, readJsonFile, writeJsonAtomic } from "./json.ts";
import { acquirePidfileLock, LockHeldError } from "./locks.ts";
import {
  composeDecisionMail,
  composeResultMail,
  composeTaskMail,
  importMailAuto,
  importMailRaw,
  mailEventsPath,
  type AutoImportMailResult,
  type ComposeDecisionMailArgs,
  type ComposeDecisionMailResult,
  type ComposeResultMailArgs,
  type ComposeTaskMailArgs,
  type ComposeTaskMailResult,
  type ImportMailResult,
  type OrchMailEvent,
  type TaskRequestedMailEvent,
} from "./mail.ts";

export type BusEvent = OrchMailEvent;
export type BusTaskEvent = TaskRequestedMailEvent;

export interface BusTaskLease {
  event: TaskRequestedMailEvent;
  claim_path: string;
  lease_id: string;
  claimed_at: string;
  expires_at: string;
}

export interface BusClaimOptions {
  agent_id: string;
  limit?: number;
  lease_ms?: number;
  now?: Date;
}

export interface OrchBus {
  publishTask(args: Omit<ComposeTaskMailArgs, "threadDir" | "threadId" | "repoKey">): ComposeTaskMailResult;
  publishResult(args: Omit<ComposeResultMailArgs, "threadDir" | "threadId" | "repoKey">): ComposeTaskMailResult;
  publishDecision(args: Omit<ComposeDecisionMailArgs, "threadDir" | "threadId" | "repoKey">): ComposeDecisionMailResult;
  importRaw(raw: string, expectedThreadId?: string, expectedRepoKey?: string): ImportMailResult;
  importAuto(raw: string): AutoImportMailResult;
  listEvents(): OrchMailEvent[];
  claimTasks(options: BusClaimOptions): BusTaskLease[];
  ackTask(lease: BusTaskLease, run: unknown): void;
  nackTask(lease: BusTaskLease, reason: string): void;
}

interface ClaimRecord {
  schema: "orch.bus/claim/v1";
  event_id: string;
  agent_id: string;
  lease_id: string;
  state: "claimed" | "acked" | "nacked";
  claimed_at: string;
  expires_at: string;
  attempts: number;
  run?: unknown;
  reason?: string;
  updated_at: string;
}

const DEFAULT_LEASE_MS = 30 * 60 * 1000;

function claimRecordPath(threadDir: string, eventId: string): string {
  return `${threadDir}/claims/${eventId}.claim.json`;
}

function legacyClaimedPath(threadDir: string): string {
  return `${threadDir}/mail-claimed.json`;
}

function readClaim(path: string): ClaimRecord | null {
  return readJsonFile<ClaimRecord | null>(path, null);
}

function writeClaim(path: string, record: ClaimRecord): void {
  writeJsonAtomic(path, record);
}

function canReplaceClaim(record: ClaimRecord | null, nowMs: number): boolean {
  if (!record) return true;
  if (record.state === "acked") return false;
  if (record.state === "nacked") return true;
  const expires = Date.parse(record.expires_at);
  return Number.isFinite(expires) && expires <= nowMs;
}

export class MaildirBus implements OrchBus {
  constructor(
    public readonly threadDir: string,
    public readonly threadId: string,
    public readonly repoKey: string,
  ) {}

  publishTask(args: Omit<ComposeTaskMailArgs, "threadDir" | "threadId" | "repoKey">): ComposeTaskMailResult {
    return composeTaskMail({ threadDir: this.threadDir, threadId: this.threadId, repoKey: this.repoKey, ...args });
  }

  publishResult(args: Omit<ComposeResultMailArgs, "threadDir" | "threadId" | "repoKey">): ComposeTaskMailResult {
    return composeResultMail({ threadDir: this.threadDir, threadId: this.threadId, repoKey: this.repoKey, ...args });
  }

  publishDecision(args: Omit<ComposeDecisionMailArgs, "threadDir" | "threadId" | "repoKey">): ComposeDecisionMailResult {
    return composeDecisionMail({ threadDir: this.threadDir, threadId: this.threadId, repoKey: this.repoKey, ...args });
  }

  importRaw(raw: string, expectedThreadId = this.threadId, expectedRepoKey = this.repoKey): ImportMailResult {
    return importMailRaw(this.threadDir, raw, expectedThreadId, expectedRepoKey);
  }

  importAuto(raw: string): AutoImportMailResult {
    return importMailAuto(raw);
  }

  listEvents(): OrchMailEvent[] {
    const eventsPath = mailEventsPath(this.threadDir);
    if (!existsSync(eventsPath)) return [];
    const out: OrchMailEvent[] = [];
    for (const line of readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as OrchMailEvent);
      } catch {
        // Ignore corrupt local projection lines; import keeps appending valid events.
      }
    }
    return out;
  }

  claimTasks(options: BusClaimOptions): BusTaskLease[] {
    const now = options.now ?? new Date();
    const nowMs = now.getTime();
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const leaseMs = options.lease_ms ?? DEFAULT_LEASE_MS;
    if (limit <= 0) return [];
    const leases: BusTaskLease[] = [];
    for (const event of this.listEvents()) {
      if (leases.length >= limit) break;
      if (event.type !== "task.requested") continue;
      if (event.assigned_agent?.id !== options.agent_id) continue;
      const path = claimRecordPath(this.threadDir, event.event_id);
      let claimLock;
      try {
        claimLock = acquirePidfileLock(`${path}.lock`, process.pid, `claim:${options.agent_id}`);
      } catch (error) {
        if (error instanceof LockHeldError) continue;
        throw error;
      }
      try {
        const existing = readClaim(path);
        if (!canReplaceClaim(existing, nowMs)) continue;
        const leaseId = `lease_${process.pid}_${nowMs}_${leases.length}`;
        const record: ClaimRecord = {
          schema: "orch.bus/claim/v1",
          event_id: event.event_id,
          agent_id: options.agent_id,
          lease_id: leaseId,
          state: "claimed",
          claimed_at: now.toISOString(),
          expires_at: new Date(nowMs + leaseMs).toISOString(),
          attempts: (existing?.attempts ?? 0) + 1,
          updated_at: now.toISOString(),
        };
        writeClaim(path, record);
        leases.push({ event, claim_path: path, lease_id: leaseId, claimed_at: record.claimed_at, expires_at: record.expires_at });
      } finally {
        claimLock.release();
      }
    }
    return leases;
  }

  ackTask(lease: BusTaskLease, run: unknown): void {
    const record = readClaim(lease.claim_path);
    if (!record || record.lease_id !== lease.lease_id) throw new Error(`claim lease mismatch for event: ${lease.event.event_id}`);
    const updated: ClaimRecord = { ...record, state: "acked", run, updated_at: new Date().toISOString() };
    writeClaim(lease.claim_path, updated);
    const claimedPath = legacyClaimedPath(this.threadDir);
    const claimed = readJsonFile<Record<string, { claimed_at: string; run: unknown }>>(claimedPath, {});
    claimed[lease.event.event_id] = { claimed_at: updated.updated_at, run };
    writeJsonAtomic(claimedPath, claimed);
  }

  nackTask(lease: BusTaskLease, reason: string): void {
    const record = readClaim(lease.claim_path);
    if (!record || record.lease_id !== lease.lease_id) return;
    writeClaim(lease.claim_path, { ...record, state: "nacked", reason, updated_at: new Date().toISOString() });
  }

  appendEventForTest(event: OrchMailEvent): void {
    appendJsonLine(mailEventsPath(this.threadDir), event);
  }
}
