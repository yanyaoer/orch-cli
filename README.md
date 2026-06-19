# orch-cli

Daemonless multi-agent orchestrator（v2 MVP）。**权威施工蓝图：`docs/orch-mvp-spec.md`**。

技术栈：**bun + TypeScript**（`bun run src/orch.ts`；`bun build --compile` 出单 binary）。

## 当前里程碑：P0–P3

- **P0**：工程骨架 + 状态目录/`repo_key`/`run_id` + status/result/events 的 TS 类型 + canonical TS result schema；**验证两个 posix 命脉点**——进程组 kill（`setsid`+`kill -pgid`）、`O_EXCL` pidfile 锁 + stale 检测。
- **P1**：`orch run create` + per-run supervisor + `drivers/codex-headless`、`drivers/claude-headless`（headless 子进程，落盘 `native.jsonl`/`events.jsonl`/`result.json`/`status.json`），**不写 MR**。
- **P2/P3**：`run list` / `events tail` / `result` 可观测命令，`decision` + outbox + `mirror` / `mirror sync`。

硬约束见 spec §2（6 条）+ §3（A1–A7）。driver 进程合同见 §8。
