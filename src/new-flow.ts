import type { RunRole, RunState } from "./types.ts";

const REQUIRED_HEADINGS = ["Destination", "Out of scope", "Tasks (now)", "Later (not yet specified)"] as const;
const TASK_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ROLES = new Set<RunRole>(["implementer", "reviewer", "verifier"]);

export interface NewPlanTask {
  id: string;
  role: "implementer" | "reviewer" | "verifier";
  depends_on: string[];
  spec: string;
  acceptance: string[];
}

export interface NewPlanValidation {
  ok: boolean;
  errors: string[];
  tasks: NewPlanTask[];
}

interface Heading {
  level: number;
  title: string;
  line: number;
}

export function validateNewPlanMarkdown(markdown: string): NewPlanValidation {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const headings: Heading[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]!);
    if (match) headings.push({ level: match[1]!.length, title: match[2]!, line: index });
  }

  const errors: string[] = [];
  const firstContent = lines.find((line) => line.trim().length > 0)?.trim();
  if (firstContent !== "## Destination") errors.push("recommendation must start with: ## Destination");
  if (lines.some((line) => /^\s*```/.test(line))) errors.push("recommendation must not be wrapped in a Markdown code fence");
  for (const heading of headings.filter((item) => item.level !== 2 && item.level !== 3)) {
    errors.push(`unexpected heading: ${"#".repeat(heading.level)} ${heading.title}`);
  }
  const contractHeadings = headings.filter((heading) => heading.level === 2);
  for (const required of REQUIRED_HEADINGS) {
    const count = contractHeadings.filter((heading) => heading.title === required).length;
    if (count === 0) errors.push(`missing heading: ## ${required}`);
    else if (count > 1) errors.push(`duplicate heading: ## ${required}`);
  }
  const unexpected = contractHeadings.filter((heading) => !REQUIRED_HEADINGS.includes(heading.title as (typeof REQUIRED_HEADINGS)[number]));
  for (const heading of unexpected) errors.push(`unexpected level-2 heading: ## ${heading.title}`);

  if (errors.length === 0) {
    const order = contractHeadings.map((heading) => heading.title);
    if (order.length !== REQUIRED_HEADINGS.length || order.some((title, index) => title !== REQUIRED_HEADINGS[index])) {
      errors.push(`headings must appear exactly in this order: ${REQUIRED_HEADINGS.map((heading) => `## ${heading}`).join(" -> ")}`);
    }
  }

  const destination = contractHeadings.find((heading) => heading.title === "Destination");
  const outOfScope = contractHeadings.find((heading) => heading.title === "Out of scope");
  if (destination && sectionText(lines, destination.line, nextH2Line(contractHeadings, destination.line)).length === 0) {
    errors.push("Destination must not be empty");
  }
  if (outOfScope && sectionText(lines, outOfScope.line, nextH2Line(contractHeadings, outOfScope.line)).length === 0) {
    errors.push("Out of scope must not be empty (use 'None' when intentional)");
  }

  const tasksHeading = contractHeadings.find((heading) => heading.title === "Tasks (now)");
  const laterHeading = contractHeadings.find((heading) => heading.title === "Later (not yet specified)");
  if (laterHeading && sectionText(lines, laterHeading.line, lines.length).length === 0) {
    errors.push("Later (not yet specified) must not be empty (use 'None' when intentional)");
  }
  const tasks: NewPlanTask[] = [];
  if (tasksHeading && laterHeading && laterHeading.line > tasksHeading.line) {
    const taskHeadings = headings.filter(
      (heading) => heading.level === 3 && heading.line > tasksHeading.line && heading.line < laterHeading.line,
    );
    for (const heading of headings.filter((item) => item.level === 3 && !taskHeadings.includes(item))) {
      errors.push(`task heading appears outside Tasks (now): ### ${heading.title}`);
    }
    if (taskHeadings.length === 0) errors.push("Tasks (now) must contain at least one task");
    const seen = new Set<string>();
    for (let index = 0; index < taskHeadings.length; index += 1) {
      const heading = taskHeadings[index]!;
      const end = taskHeadings[index + 1]?.line ?? laterHeading.line;
      const id = heading.title.trim();
      if (!TASK_NAME.test(id)) errors.push(`task "${id}" is not kebab-case`);
      if (seen.has(id)) errors.push(`duplicate task name: ${id}`);
      seen.add(id);

      const body = lines.slice(heading.line + 1, end);
      const roleValues = body.flatMap((line) => {
        const match = /^\s*-\s*Role:\s*(\S.*?)\s*$/i.exec(line);
        return match ? [match[1]!.toLowerCase()] : [];
      });
      if (roleValues.length !== 1) errors.push(`task ${id} must contain exactly one '- Role:' field`);
      const role = roleValues[0] ?? "";
      if (role && !TASK_ROLES.has(role as RunRole)) errors.push(`task ${id} has unsupported role: ${role}`);

      const dependencyValues = body.flatMap((line) => {
        const match = /^\s*-\s*After:\s*(.*?)\s*$/i.exec(line);
        return match ? [match[1]!] : [];
      });
      let dependencies: string[] = [];
      if (dependencyValues.length !== 1 || !dependencyValues[0]?.trim()) {
        errors.push(`task ${id} must contain one non-empty '- After:' field`);
      } else if (dependencyValues[0]!.trim().toLowerCase() !== "none") {
        dependencies = dependencyValues[0]!.split(",").map((value) => value.trim()).filter(Boolean);
        if (dependencies.length === 0 || dependencies.some((dependency) => !TASK_NAME.test(dependency))) {
          errors.push(`task ${id} has invalid After dependencies: ${dependencyValues[0]}`);
        }
        for (const dependency of dependencies) {
          if (!seen.has(dependency) || dependency === id) errors.push(`task ${id} must depend only on an earlier task: ${dependency}`);
        }
      }

      const specValues = body.flatMap((line) => {
        const match = /^\s*-\s*Spec:\s*(.*?)\s*$/i.exec(line);
        return match ? [match[1]!] : [];
      });
      if (specValues.length !== 1 || !specValues[0]?.trim()) errors.push(`task ${id} must contain one non-empty '- Spec:' field`);

      const acceptanceIndex = body.findIndex((line) => /^\s*-\s*Acceptance:\s*$/i.test(line));
      const acceptance: string[] = [];
      if (acceptanceIndex < 0) {
        errors.push(`task ${id} has no '- Acceptance:' section`);
      } else {
        for (const line of body.slice(acceptanceIndex + 1)) {
          const match = /^\s{2,}-\s+(.+?)\s*$/.exec(line);
          if (match) acceptance.push(match[1]!);
          else if (/^\s*-\s*(?:Role|After|Spec|Acceptance):/i.test(line)) break;
        }
        if (acceptance.length === 0) errors.push(`task ${id} has no acceptance checks`);
      }

      if (
        TASK_NAME.test(id) &&
        TASK_ROLES.has(role as RunRole) &&
        dependencyValues.length === 1 &&
        dependencies.every((dependency) => seen.has(dependency) && dependency !== id) &&
        specValues[0]?.trim() &&
        acceptance.length > 0
      ) {
        tasks.push({ id, role: role as NewPlanTask["role"], depends_on: dependencies, spec: specValues[0].trim(), acceptance });
      }
    }
  }

  return { ok: errors.length === 0, errors, tasks };
}

function nextH2Line(headings: Heading[], line: number): number {
  return headings.find((heading) => heading.line > line)?.line ?? Number.POSITIVE_INFINITY;
}

function sectionText(lines: string[], start: number, end: number): string {
  return lines.slice(start + 1, Number.isFinite(end) ? end : lines.length).join("\n").trim();
}

export interface NewQuestionClassification {
  defaults: Array<{ question: string; value: string }>;
  blocking: string[];
}

export function classifyNewOpenQuestions(questions: string[]): NewQuestionClassification {
  const defaults: Array<{ question: string; value: string }> = [];
  const blocking: string[] = [];
  for (const question of questions) {
    const recommended = /\s+—\s*recommended:\s*(.+?)\s*$/i.exec(question);
    if (recommended?.[1]?.trim()) defaults.push({ question, value: recommended[1].trim() });
    else blocking.push(question);
  }
  return { defaults, blocking };
}

export interface NewExecutionRun {
  run_id: string;
  role: string;
  state: RunState;
  stale: boolean;
  verdict: string | null;
  decision: "accept" | "rework" | "close" | null;
}

export interface NewExecutionOutcome {
  ok: boolean;
  total: number;
  handled: string[];
  failed: string[];
  undecided: string[];
  closed: string[];
  rework_pending: string[];
}

function goodWorkerVerdict(run: NewExecutionRun): boolean {
  if (run.role === "implementer") return run.verdict === "completed";
  if (run.role === "reviewer") return run.verdict === "approve";
  if (run.role === "verifier") return run.verdict === "pass";
  return false;
}

export function evaluateNewExecution(controllerOk: boolean, runs: NewExecutionRun[]): NewExecutionOutcome {
  const workers = runs.filter((run) => run.role !== "controller" && run.role !== "researcher");
  const handled: string[] = [];
  const failed: string[] = [];
  const undecided: string[] = [];
  const closed: string[] = [];
  const reworkPending: string[] = [];

  for (let index = 0; index < workers.length; index += 1) {
    const run = workers[index]!;
    if (run.state !== "done" || run.stale || run.verdict === null) {
      failed.push(run.run_id);
      continue;
    }
    if (run.decision === null) {
      undecided.push(run.run_id);
      continue;
    }
    if (run.decision === "close") {
      closed.push(run.run_id);
      continue;
    }
    if (run.decision === "accept") {
      if (goodWorkerVerdict(run)) handled.push(run.run_id);
      else failed.push(run.run_id);
      continue;
    }
    const resolved = workers.slice(index + 1).some(
      (later) =>
        later.role === run.role &&
        later.state === "done" &&
        !later.stale &&
        later.decision === "accept" &&
        goodWorkerVerdict(later),
    );
    if (resolved) handled.push(run.run_id);
    else reworkPending.push(run.run_id);
  }

  return {
    ok:
      controllerOk &&
      workers.length > 0 &&
      failed.length === 0 &&
      undecided.length === 0 &&
      closed.length === 0 &&
      reworkPending.length === 0,
    total: workers.length,
    handled,
    failed,
    undecided,
    closed,
    rework_pending: reworkPending,
  };
}
