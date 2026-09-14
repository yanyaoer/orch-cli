// orch mailctl CLI glue: transport/context construction and the subcommand dispatcher over src/mailctl.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readMailControlConfig, validateMailControlConfig } from "../config.ts";
import {   type MailCliContext } from "../mail-cli.ts";
import { createMailTransport, mailctlAck, mailctlAttachmentPromote, mailctlAttachmentShow, mailctlAttachments, mailctlDelta, mailctlDraftList, mailctlDraftRelease, mailctlDraftShow, mailctlDraftWithdraw, mailctlGuidance, mailctlInit, mailctlPoll, mailctlReply, mailctlStatus, mailctlSync, mailctlWatch, renderMailctlAttachments, renderMailctlGuidance, renderMailctlStatus, type MailCursor, type MailMessageRef, type MailTransport, type MailctlContext, type ReplyResult } from "../mailctl.ts";

import { CliError, assertKnownFlags, flagBool, flagNumber, flagString, printJson, type ParsedArgs } from "../cli.ts";
import { locateRun, orchCommand, readMirrorResult } from "../run-store.ts";

// The fan-out commands route through the mail layer: the thread carries the mr
// and workspace context, so no --mr is needed. Each derives its role/agents and
// delegates to mailFanout (publish one task per agent → claim+run).
export function mailFanoutContext(): MailCliContext {
  return { orchCommand, locateRun, readMirrorResult };
}

function dryRunMailTransport(): MailTransport {
  return {
    async listNew(_sinceDays: number, _cursor: MailCursor | null): Promise<MailMessageRef[]> {
      return [];
    },
    async fetchRaw(ref: MailMessageRef): Promise<string> {
      throw new Error(`dry-run transport cannot fetch UID ${ref.uid}`);
    },
    async markProcessed(_ref: MailMessageRef): Promise<void> {},
    async sendReply(_rfc822: string): Promise<void> {},
    async idleOnce(_timeoutMs: number, _cursor: MailCursor | null): Promise<void> {},
  };
}

function mailctlContext(context: MailCliContext, transport?: MailTransport): MailctlContext {
  const config = readMailControlConfig();
  try {
    validateMailControlConfig(config);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }
  return {
    config,
    transport: transport ?? createMailTransport(config),
    now: () => Date.now(),
    orch: context,
  };
}

function mailctlBody(args: ParsedArgs): string {
  const hasBody = args.flags.has("body");
  const hasBodyFile = args.flags.has("body-file");
  if (hasBody === hasBodyFile) throw new CliError("mailctl reply requires exactly one of --body or --body-file");
  return hasBody ? flagString(args, "body") : readFileSync(resolve(flagString(args, "body-file")), "utf8");
}

function pollSummary(result: Awaited<ReturnType<typeof mailctlPoll>>, dryRun: boolean): string {
  const reconcile = result.reconciled
    ? ` reconciled_spawned=${result.reconciled.spawned.length} reconciled_live=${result.reconciled.live.length} retried_reports=${result.reconciled.retried_reports}`
    : "";
  return `mailctl poll${dryRun ? " dry-run" : ""}: listed=${result.listed} fetched=${result.fetched} accepted=${result.accepted} rejected=${result.rejected} duplicate=${result.duplicate} errors=${result.errors} skipped=${result.skipped}${reconcile}\n`;
}

export async function mailctlCommand(args: ParsedArgs, context: MailCliContext): Promise<number> {
  const mode = args.positionals[1];
  try {
    if (mode === "init") {
      const result = mailctlInit(args);
      if (flagBool(args, "json")) printJson({ mailctl: "init", ...result });
      else {
        process.stdout.write(`${result.config_path}\n`);
        process.stdout.write(`trusted_authserv_id=${result.trusted_authserv_id} (confirm with your mail provider)\n`);
      }
      return 0;
    }

    if (mode === "poll") {
      assertKnownFlags(args, "mailctl poll", ["json", "dry-run"]);
      // Watchdog: poll is a bounded one-shot contract (cron/launchd drive it).
      // Anything that still hangs past the socket timeouts (2026-07-11: a
      // half-open IMAP connection held the ingest lock ~20h and stalled the
      // whole mail pipeline) must terminate so the next poll can take over —
      // a dead pid's pidfile lock is reclaimed on the next acquire.
      const watchdog = setTimeout(() => {
        process.stderr.write("mailctl poll watchdog: still running after 15m; exiting so the next scheduled poll can take over\n");
        process.exit(1);
      }, 15 * 60 * 1000);
      watchdog.unref?.();
      const dryRun = flagBool(args, "dry-run");
      const ctx = mailctlContext(context, dryRun ? dryRunMailTransport() : undefined);
      const result = await mailctlPoll(ctx, { reconcile: !dryRun, sync: !dryRun });
      clearTimeout(watchdog);
      if (flagBool(args, "json")) printJson(result);
      else process.stdout.write(pollSummary(result, dryRun));
      return 0;
    }

    if (mode === "sync") {
      assertKnownFlags(args, "mailctl sync", ["mr", "execute", "json"]);
      const result = await mailctlSync(mailctlContext(context), {
        mr: args.flags.has("mr") ? flagString(args, "mr") : undefined,
        execute: flagBool(args, "execute"),
      });
      if (flagBool(args, "json")) printJson({ mailctl: "sync", ...result });
      else {
        const reportKeys = result.mrs.flatMap((mr) => mr.report_keys);
        const roots = result.mrs.filter((mr) => mr.create_root).map((mr) => mr.mr);
        process.stdout.write(
          [
            `mailctl sync${result.dry_run ? " dry-run" : ""}: skipped=${result.skipped}`,
            `would_create_roots: ${roots.join(", ") || "none"}`,
            `report_keys: ${reportKeys.join(", ") || "none"}`,
            `sent: ${result.sent.length}`,
            `pending: ${result.pending.length}`,
          ].join("\n") + "\n",
        );
      }
      return 0;
    }

    if (mode === "watch") {
      assertKnownFlags(args, "mailctl watch", ["iterations", "json"]);
      const iterations = flagNumber(args, "iterations");
      if (iterations !== undefined && (!Number.isInteger(iterations) || iterations < 0)) {
        throw new CliError("--iterations must be a non-negative integer");
      }
      const result = await mailctlWatch(mailctlContext(context), { iterations });
      if (flagBool(args, "json")) printJson({ mailctl: "watch", ...result });
      else process.stdout.write(`mailctl watch: iterations=${result.iterations} stopped=${result.stopped}\n`);
      return 0;
    }

    if (mode === "status") {
      assertKnownFlags(args, "mailctl status", ["json"]);
      const result = mailctlStatus(mailctlContext(context), { json: flagBool(args, "json") });
      if (flagBool(args, "json")) printJson(result);
      else process.stdout.write(renderMailctlStatus(result));
      return 0;
    }

    if (mode === "reply") {
      assertKnownFlags(args, "mailctl reply", ["thread", "report-key", "body", "body-file", "dry-run", "base-version"]);
      const dryRun = flagBool(args, "dry-run");
      const thread = flagString(args, "thread");
      const reportKey = flagString(args, "report-key");
      const result = await mailctlReply(mailctlContext(context), {
        thread,
        reportKey,
        body: mailctlBody(args),
        dryRun,
        baseVersion: flagNumber(args, "base-version"),
      });
      if (dryRun) {
        process.stdout.write(result.rawMessage ?? "");
        return 0;
      }
      if (result.held) {
        printJson(heldDraftPayload("reply", thread, reportKey, result));
        return 3;
      }
      printJson({
        mailctl: "reply",
        duplicate: result.duplicate,
        sent: result.sent,
        pending: result.pending,
        message_id: result.messageId ?? null,
        next_attempt_at: result.nextAttemptAt ?? null,
      });
      return 0;
    }

    if (mode === "delta") {
      assertKnownFlags(args, "mailctl delta", ["thread", "since", "json"]);
      const result = mailctlDelta({ thread: flagString(args, "thread"), since: flagNumber(args, "since") });
      if (flagBool(args, "json")) printJson(result);
      else {
        const rows = [`mailctl delta ${result.thread}: current_version=${result.current_version} since=${result.since}`];
        for (const event of result.events) rows.push(`  v${event.version} ${event.kind} ${event.ref}: ${event.summary}`);
        process.stdout.write(`${rows.join("\n")}\n`);
      }
      return 0;
    }

    if (mode === "draft") {
      const action = args.positionals[2];
      if (action === "list") {
        assertKnownFlags(args, "mailctl draft list", ["thread", "json"]);
        const result = mailctlDraftList({ thread: args.flags.has("thread") ? flagString(args, "thread") : undefined });
        if (flagBool(args, "json")) printJson(result);
        else {
          const rows = [`mailctl draft list: ${result.drafts.length} held`];
          for (const draft of result.drafts) {
            rows.push(`  ${draft.report_key} thread=${draft.thread} base=v${draft.base_version} held_at=v${draft.held_at_version} now=v${draft.current_version} held=${draft.held_count}x`);
          }
          process.stdout.write(`${rows.join("\n")}\n`);
        }
        return 0;
      }
      if (action === "show") {
        assertKnownFlags(args, "mailctl draft show", ["thread", "report-key", "json"]);
        printJson(mailctlDraftShow({ thread: flagString(args, "thread"), reportKey: flagString(args, "report-key") }));
        return 0;
      }
      if (action === "release") {
        assertKnownFlags(args, "mailctl draft release", ["thread", "report-key", "force", "json"]);
        const thread = flagString(args, "thread");
        const reportKey = flagString(args, "report-key");
        const result = await mailctlDraftRelease(mailctlContext(context), { thread, reportKey, force: flagBool(args, "force") });
        if (result.held) {
          printJson(heldDraftPayload("draft-release", thread, reportKey, result));
          return 3;
        }
        printJson({
          mailctl: "draft-release",
          duplicate: result.duplicate,
          sent: result.sent,
          pending: result.pending,
          message_id: result.messageId ?? null,
          next_attempt_at: result.nextAttemptAt ?? null,
        });
        return 0;
      }
      if (action === "withdraw") {
        assertKnownFlags(args, "mailctl draft withdraw", ["thread", "report-key", "json"]);
        const result = mailctlDraftWithdraw(mailctlContext(context), { thread: flagString(args, "thread"), reportKey: flagString(args, "report-key") });
        if (flagBool(args, "json")) printJson({ mailctl: "draft-withdraw", ...result });
        else process.stdout.write(`mailctl draft withdraw: thread=${result.thread} report_key=${result.report_key} withdrawn=${result.withdrawn}\n`);
        return 0;
      }
      process.stderr.write("usage: orch mailctl draft list|show|release|withdraw --thread em-<id> [--report-key <key>] [--force] [--json]\n");
      return 2;
    }

    if (mode === "ack") {
      assertKnownFlags(args, "mailctl ack", ["thread", "attention", "json"]);
      const result = mailctlAck(mailctlContext(context), { thread: flagString(args, "thread"), attention: flagString(args, "attention") });
      if (flagBool(args, "json")) printJson({ mailctl: "ack", ...result });
      else process.stdout.write(`mailctl ack: thread=${result.thread} attention=${result.attention} done=${result.done} acknowledged=${result.acknowledged}\n`);
      return 0;
    }

    if (mode === "guidance") {
      assertKnownFlags(args, "mailctl guidance", ["thread", "json"]);
      const result = mailctlGuidance(mailctlContext(context), { thread: flagString(args, "thread"), json: flagBool(args, "json") });
      if (flagBool(args, "json")) printJson(result);
      else process.stdout.write(renderMailctlGuidance(result));
      return 0;
    }

    if (mode === "attachments") {
      assertKnownFlags(args, "mailctl attachments", ["thread", "json"]);
      const result = mailctlAttachments({ thread: args.flags.has("thread") ? flagString(args, "thread") : undefined });
      if (flagBool(args, "json")) printJson(result);
      else process.stdout.write(renderMailctlAttachments(result));
      return 0;
    }

    if (mode === "attachment") {
      const action = args.positionals[2];
      if (action === "show") {
        assertKnownFlags(args, "mailctl attachment show", ["id"]);
        process.stdout.write(mailctlAttachmentShow(flagString(args, "id")));
        return 0;
      }
      if (action === "promote") {
        assertKnownFlags(args, "mailctl attachment promote", ["id", "dest", "json"]);
        const result = mailctlAttachmentPromote(mailctlContext(context), {
          id: flagString(args, "id"),
          dest: args.flags.has("dest") ? resolve(flagString(args, "dest")) : undefined,
        });
        if (flagBool(args, "json")) printJson({ mailctl: "attachment-promote", ...result });
        else process.stdout.write(`${result.path}\n`);
        return 0;
      }
      process.stderr.write("usage: orch mailctl attachment show|promote --id att-<id> [--dest <dir>]\n");
      return 2;
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  process.stderr.write("usage: orch mailctl init|poll|watch|status|sync|reply|ack|guidance|delta|draft|attachments|attachment [flags]\n");
  return 2;
}

// Held Draft outcome: externalize the resolution paths as literal commands so
// the submitting agent chooses one instead of inferring the protocol.
function heldDraftPayload(mode: string, thread: string, reportKey: string, result: ReplyResult): Record<string, unknown> {
  return {
    mailctl: mode,
    held: true,
    report_key: reportKey,
    base_version: result.baseVersion ?? null,
    current_version: result.currentVersion ?? null,
    delta: result.delta ?? [],
    options: {
      revise: `orch mailctl reply --thread ${thread} --report-key ${reportKey} --base-version ${result.currentVersion} --body <revised body>`,
      release: `orch mailctl draft release --thread ${thread} --report-key ${reportKey}`,
      withdraw: `orch mailctl draft withdraw --thread ${thread} --report-key ${reportKey}`,
    },
  };
}
