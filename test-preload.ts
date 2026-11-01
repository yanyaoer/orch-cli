// The fake `claude` binaries in the tests speak claude -p's stream-json on
// stdin/stdout. Claude workers default to the interactive mode (TUI), which
// drivers/claude-tui.test.ts covers with fakes of its own; every other test
// runs claude as -p, whatever the developer's shell sets.
process.env.ORCH_CLAUDE_MODE = "print";
delete process.env.ORCH_CLAUDE_ENTRYPOINT;
