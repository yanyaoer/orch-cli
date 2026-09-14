// Text and markdown rendering of results: terminal summaries, mirror comment bodies, decision bodies (i18n per config language).
import { existsSync } from "node:fs";
import type { ControllerResult, ImplementerResult, ResearcherResult, ReviewerResult, RoleResult, RunStatus, VerifierResult } from "./types.ts";
import { orchLanguage } from "./config.ts";
import type { DecisionRecord } from "./run-store.ts";

function printFindings(label: string, findings: ReviewerResult["non_blocking_findings"]): void {
  process.stdout.write(`\n${label}:\n`);
  if (findings.length === 0) {
    process.stdout.write("  - none\n");
    return;
  }
  for (const finding of findings) {
    const head = [finding.severity, finding.id, finding.file].filter(Boolean).join(" | ");
    process.stdout.write(`  - [${head || "finding"}]\n    ${finding.body.replaceAll("\n", "\n    ")}\n`);
  }
}

export function resultSummary(result: RoleResult): string {
  if ("summary" in result && typeof result.summary === "string") return result.summary;
  const zh = zhComments();
  if (result.schema === "orch.result/reviewer/v1") {
    return zh
      ? `阻断性发现 ${result.blocking_findings.length} 条,非阻断性发现 ${result.non_blocking_findings.length} 条。`
      : `${result.blocking_findings.length} blocking finding(s), ${result.non_blocking_findings.length} non-blocking finding(s).`;
  }
  if (result.schema === "orch.result/verifier/v1") {
    return zh
      ? `命令 ${result.commands.length} 条,验收项 ${result.acceptance.length} 项。`
      : `${result.commands.length} command(s), ${result.acceptance.length} acceptance item(s).`;
  }
  return zh ? "result.json 中无摘要。" : "No summary in result.json.";
}

export function resultVerdict(result: RoleResult): string {
  return "verdict" in result && typeof result.verdict === "string" ? result.verdict : "unknown";
}

export function printResultSummary(result: RoleResult): void {
  process.stdout.write(`schema: ${result.schema}\n`);
  process.stdout.write(`verdict: ${resultVerdict(result)}\n`);
  process.stdout.write(`summary: ${resultSummary(result)}\n`);

  if (result.schema === "orch.result/reviewer/v1") {
    const reviewer = result as ReviewerResult;
    printFindings("blocking_findings", reviewer.blocking_findings);
    printFindings("non_blocking_findings", reviewer.non_blocking_findings);
    process.stdout.write("\nsuggested_tests:\n");
    if (reviewer.suggested_tests.length === 0) {
      process.stdout.write("  - none\n");
    } else {
      for (const test of reviewer.suggested_tests) process.stdout.write(`  - ${test}\n`);
    }
    return;
  }

  if (result.schema === "orch.result/verifier/v1") {
    const verifier = result as VerifierResult;
    process.stdout.write("\ncommands:\n");
    if (verifier.commands.length === 0) {
      process.stdout.write("  - none\n");
    } else {
      for (const command of verifier.commands) {
        process.stdout.write(`  - ${command.cmd} (exit ${command.exit_code}): ${command.summary}\n`);
      }
    }
    process.stdout.write("\nacceptance:\n");
    if (verifier.acceptance.length === 0) {
      process.stdout.write("  - none\n");
    } else {
      for (const item of verifier.acceptance) {
        process.stdout.write(`  - ${item.id}: ${item.status}${item.evidence ? ` — ${item.evidence}` : ""}\n`);
      }
    }
    return;
  }

  if (result.schema === "orch.result/controller/v1") {
    const controller = result as ControllerResult;
    process.stdout.write("\nactions:\n");
    if (controller.actions.length === 0) {
      process.stdout.write("  - none\n");
    } else {
      for (const action of controller.actions) process.stdout.write(`  - ${action}\n`);
    }
    return;
  }

  if (result.schema === "orch.result/researcher/v1") {
    const researcher = result as ResearcherResult;
    process.stdout.write(`\nrecommendation:\n  ${researcher.recommendation.replaceAll("\n", "\n  ")}\n`);
    const sections: Array<[string, string[]]> = [
      ["alternatives", researcher.alternatives],
      ["sources", researcher.sources],
      ["open_questions", researcher.open_questions],
      ["risks", researcher.risks],
    ];
    for (const [label, items] of sections) {
      process.stdout.write(`\n${label}:\n`);
      if (items.length === 0) {
        process.stdout.write("  - none\n");
      } else {
        for (const item of items) process.stdout.write(`  - ${item}\n`);
      }
    }
    return;
  }

  const implementer = result as ImplementerResult;
  process.stdout.write("\nchanged_files:\n");
  if (implementer.changed_files.length === 0) {
    process.stdout.write("  - none\n");
  } else {
    for (const file of implementer.changed_files) process.stdout.write(`  - ${file}\n`);
  }

  process.stdout.write("\ntests:\n");
  if (implementer.tests.length === 0) {
    process.stdout.write("  - none\n");
  } else {
    for (const test of implementer.tests) {
      process.stdout.write(`  - ${test.cmd} (exit ${test.exit_code}): ${test.summary}\n`);
    }
  }
}

function evidencePaths(runDir: string): string[] {
  const artifactsDir = `${runDir}/artifacts`;
  if (!existsSync(`${artifactsDir}/diff.patch`)) return [];
  return ["git-status.txt", "diff.patch", "changed-files.txt"]
    .map((name) => `${artifactsDir}/${name}`)
    .filter((path) => existsSync(path));
}

export function printEvidenceSummary(runDir: string): void {
  const paths = evidencePaths(runDir);
  if (paths.length === 0) return;
  process.stdout.write("\nevidence:\n");
  for (const path of paths) process.stdout.write(`  - ${path}\n`);
}

// GitHub caps issue comments at 65536 chars; stay under it with room for the
// forge CLI's own wrapping. One pathological finding must not eat the budget.
export const MIRROR_BODY_MAX_CHARS = 60_000;
const MIRROR_FINDING_MAX_CHARS = 4_000;

// Comment-skeleton language, read at assembly time (mirror, decision outbox,
// cross-review --auto). The english branch must stay byte-identical to the
// historical output; only the exact config value 中文 flips the labels.
export function zhComments(): boolean {
  return orchLanguage() === "中文";
}

function mirrorListLines(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return [`${title} (${items.length}):`, "", ...items.map((item) => `- ${item}`), ""];
}

// Findings render as plain paragraphs, not markdown list items: multi-line
// finding bodies (blank lines included) survive GitHub/GitLab rendering intact.
function mirrorFindingLines(title: string, findings: Array<{ id: string; severity?: string; file?: string; body: string }>): string[] {
  if (findings.length === 0) return [];
  const lines = [`${title} (${findings.length}):`, ""];
  for (const finding of findings) {
    const meta = [finding.severity, finding.id, finding.file].filter(Boolean).join(" | ");
    const truncated = zhComments() ? "…(该条发现已截断)" : "…(finding truncated)";
    const body = finding.body.length > MIRROR_FINDING_MAX_CHARS ? `${finding.body.slice(0, MIRROR_FINDING_MAX_CHARS)}${truncated}` : finding.body;
    lines.push(`**[${meta}]**`, body, "");
  }
  return lines;
}

function commandLine(command: { cmd: string; exit_code: number; summary: string }): string {
  return `exit=${command.exit_code} \`${command.cmd}\` — ${command.summary}`;
}

// The comment is the human-facing mirror of result.json: every structured
// field a decision was based on belongs in it, not just the summary line.
function resultDetailLines(result: RoleResult): string[] {
  const zh = zhComments();
  const t = (en: string, cn: string): string => (zh ? cn : en);
  switch (result.schema) {
    case "orch.result/reviewer/v1":
      return [
        ...mirrorFindingLines(t("Blocking findings", "阻断性发现"), result.blocking_findings),
        ...mirrorFindingLines(t("Non-blocking findings", "非阻断性发现"), result.non_blocking_findings),
        ...mirrorListLines(t("Suggested tests", "建议测试"), result.suggested_tests),
      ];
    case "orch.result/verifier/v1":
      return [
        ...mirrorListLines(t("Commands", "命令"), result.commands.map(commandLine)),
        ...mirrorListLines(t("Acceptance", "验收"), result.acceptance.map((item) => `${item.id}: ${item.status}${item.evidence ? ` — ${item.evidence}` : ""}`)),
      ];
    case "orch.result/implementer/v1":
      return [
        ...mirrorListLines(t("Tests", "测试"), result.tests.map(commandLine)),
        ...mirrorListLines(t("Acceptance", "验收"), result.acceptance.map((item) => `${item.id}: ${item.status}${item.evidence ? ` — ${item.evidence}` : ""}`)),
        ...mirrorListLines(t("Risks", "风险"), result.risks),
      ];
    case "orch.result/controller/v1":
      return mirrorListLines(t("Actions", "动作"), result.actions);
    case "orch.result/researcher/v1":
      return [
        t("Recommendation:", "建议方案:"),
        "",
        result.recommendation,
        "",
        ...mirrorListLines(t("Alternatives considered", "备选方案"), result.alternatives),
        ...mirrorListLines(t("Sources", "来源"), result.sources),
        ...mirrorListLines(t("Open questions", "未决问题"), result.open_questions),
        ...mirrorListLines(t("Risks", "风险"), result.risks),
      ];
    default:
      return [];
  }
}

export function mirrorBody(mr: string, runId: string, result: RoleResult, status: RunStatus | null): string {
  const zh = zhComments();
  const lines = [
    zh ? "### orch 运行结果" : "### orch run result",
    "",
    `- MR/PR: ${mr}`,
    `- ${zh ? "运行" : "Run"}: ${runId}`,
    `- ${zh ? "状态" : "State"}: ${status?.state ?? "unknown"}`,
    `- ${zh ? "结论" : "Verdict"}: ${resultVerdict(result)}`,
    "",
    zh ? "摘要:" : "Summary:",
    "",
    resultSummary(result),
  ];
  const detail = resultDetailLines(result);
  if (detail.length > 0) lines.push("", ...detail);
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  if (body.length <= MIRROR_BODY_MAX_CHARS) return body;
  const truncated = zh
    ? `…(评论已截断;完整结果请运行 \`orch result --run ${runId}\` 查看)`
    : `…(comment truncated; run \`orch result --run ${runId}\` for the full result)`;
  return `${body.slice(0, MIRROR_BODY_MAX_CHARS)}\n\n${truncated}`;
}

export function decisionBody(
  mr: string,
  runId: string,
  decision: DecisionRecord,
  result: RoleResult,
  status: RunStatus | null,
): string {
  const zh = zhComments();
  return [
    zh ? "### orch 决策" : "### orch decision",
    "",
    `- MR/PR: ${mr}`,
    `- ${zh ? "运行" : "Run"}: ${runId}`,
    `- ${zh ? "决策" : "Decision"}: ${decision.verdict}`,
    `- ${zh ? "理由" : "Reason"}: ${decision.reason ?? (zh ? "无" : "none")}`,
    `- ${zh ? "创建时间" : "Created"}: ${decision.ts}`,
    "",
    mirrorBody(mr, runId, result, status),
  ].join("\n");
}
