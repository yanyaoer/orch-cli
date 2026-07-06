import { expect, test } from "bun:test";
import { parseArgs } from "./cli.ts";

test("boolean flag directly before -n stays boolean", () => {
  const args = parseArgs(["events", "tail", "--run", "r1", "--native", "-n", "2"]);
  expect(args.flags.get("native")).toBe(true);
  expect(args.flags.get("n")).toBe("2");
  expect(args.flags.get("run")).toBe("r1");
  expect(args.positionals).toEqual(["events", "tail"]);
});

test("flag values and bare -n keep their existing shapes", () => {
  const args = parseArgs(["--mr", "42", "--json", "-n"]);
  expect(args.flags.get("mr")).toBe("42");
  expect(args.flags.get("json")).toBe(true);
  expect(args.flags.get("n")).toBe(true);
});

test("equals form still passes a literal -n as a flag value", () => {
  const args = parseArgs(["--task=-n", "--mr=42"]);
  expect(args.flags.get("task")).toBe("-n");
  expect(args.flags.get("mr")).toBe("42");
});

test("-f maps to --follow and is never swallowed as a flag value", () => {
  const args = parseArgs(["events", "tail", "--run", "r1", "--native", "-f"]);
  expect(args.flags.get("follow")).toBe(true);
  expect(args.flags.get("native")).toBe(true);
  expect(args.flags.get("run")).toBe("r1");
});
