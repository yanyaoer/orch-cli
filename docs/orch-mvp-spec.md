# orch v2 MVP — daemonless reconciler 实施 spec

> 替代当前 tmux/glab-MR 中心化实现（见 multi-agent.md 第 1–15 节）。
> 取中线：**worker 进程化 / 状态本地化 / MR 镜像化 / CLI 稳定化**；
> 不 daemon、不 SDK 大一统、不 send-keys。等无人值守/多机/队列真出现，再升级 `orchd`。

## 0. 定位（写死，避免被误解成"没写完的 daemon"）

> **MVP 不引入常驻 daemon。`orch` 是无状态 reconciler**：每次调用只读取本地状态目录、
> Git/MR 当前状态与 run 事件流，执行一次状态推进或派发动作。
> 主控（claude / codex / pi-agent / 人）任选其一，经统一 `orch` CLI 操作外置状态——
> 状态不在任何主控会话里，故换主控不丢上下文。

```
claude / codex / pi / 人  ──▶  orch CLI  ──▶  本地状态目录 + worker 子进程 + MR 镜像
```

## 1. 决策记录（decisions）

- **D1 主控可插拔**：分发+监控由任意 agent 经 `orch` CLI 完成 ⟹ 状态外置、主控无状态。
- **D2 状态目录**：`${XDG_STATE_HOME:-$HOME/.local/state}/orch/<repo_key>/mrs/<mr_iid>/`
  - 配置 → `~/.config/orch/`（profiles/templates/schemas）；状态 → `~/.local/state/orch/`；大日志/临时 → `~/.cache/orch/`。
  - `repo_key = <host>/<namespace>/<project>-<8char_hash(remote_url)>`（repo 名会撞，必须带 hash）。
- **D3 worker = headless 子进程**：`codex exec [--json] resume` / `claude -p --output-format stream-json --resume`（已验证可用）；tmux 仅调试，非传输层。
- **D4 MR = 审计镜像**：实时状态源在本地；MR 只写 task-spec snapshot + decision/review/verify 摘要（经 outbox）。
- **D5 无常驻 daemon**：薄 `orch` CLI + per-run supervisor（生命周期=run）。
- **D6 driver 抽象延后**：先把 codex+claude 两个 headless driver 跑稳；但**从第一天起用统一进程合同**（§8），不让 `orch` 变 provider if-else 泥潭。agy disabled，pi 待验证。
- **D7（实现）语言 = bun + TypeScript**（`Bun.spawn` / `Bun.file` / 内置 test；`bun build --compile` 出单 binary 去运行时依赖）。选 bun 而非 Python 的原因贴核心需求：worker 本质是**消费 streaming JSON**（`for await` 流处理是 JS 主场）、CLI **高频短调用**（bun 冷启动 ~ms）、status/result/events 用 **TS 类型**原生表达 schema、SDK-first 未来对接 `@openai/codex-sdk`/Claude SDK（均 TS 优先）平滑。
  - **两个 posix 命脉点（sub-claude spike 实测，bun 1.3.14 / macOS）**：
    ①**进程组 kill**——⚠ macOS **无 `setsid(1)` 命令**（别用 `Bun.spawn(["setsid",...])`，会 ENOENT）；⚠ 默认 `Bun.spawn` 子进程**与父同进程组**，直接 `kill(-pgid)` 会连 supervisor 一起杀。**正解**：`Bun.spawn(cmd, {detached:true})` → 新进程组、子进程为组长（`pgid == proc.pid`），kill 用 `process.kill(-proc.pid, sig)`（catch ESRCH），worker 退出 **`await proc.exited` 收尸防僵尸**。
    ②**文件锁**——bun/node 无 `flock` 且 macOS 无 `flock(1)`，故用 `O_EXCL` pidfile（`fs.open(...,"wx")`，原子互斥已实测）+ stale 检测；**`pidAlive` 必须区分 `ESRCH`(死→夺锁) vs `EPERM`(存活属他人→不夺)**；锁内写 `{pid, run_id, ts}`，TOCTOU 用 2-attempt 重试收敛、极端抛 `ELOCKRACE` 由调用方退避。
- **D8（并发）review/verify 评 immutable artifact**（commit sha / patch bundle），不评 live worktree ⟹ 只有 write-role 需要 worktree 锁。

## 2. 硬约束（MVP 必须；实现要克制，别上框架）

1. **MR 锁**：`orch run create` 先拿 `locks/mr.lock`（`flock`），再幂等检查。
2. **run 幂等**：`--idempotency-key`（默认 `mr<id>:<tag>:<task_sha>`）；已存在则：running→返回 run_id，done→返回 result，failed→需 `--retry` 才新建。
3. **worktree 写锁**：write-role（implementer/challenger/rework/debugger）拿 `locks/worktree.<sha256(abs)>.lock`，supervisor 持有到 run 结束；reviewer/verifier 评 artifact、**不拿锁**（D8）。
4. **native 归一化**：provider 原生流落 `native.jsonl`，**不直接当 orch 事件**；normalizer 写 `events.jsonl`（MVP 可极简）。
5. **result schema**：`result.json` 必须过 per-role schema 校验（MVP 用 `jq` 查关键字段非空即可）。
6. **MR outbox**：写 MR 先落 `outbox/pending/`，`glab` 成功后移 `outbox/sent/`；写失败不影响 run 完成。

## 3. Acceptance（落地前强制）

- **A1** `run create` 重复执行同一 idempotency_key 不重复派发。
- **A2** 同一 worktree 同时只有一个 write-role run。
- **A3** worker 原生输出必存 `native.jsonl`，不直接作为 orch events。
- **A4** `result.json` 必过 role schema 校验。
- **A5** GitLab/MR 写失败不影响本地 run 完成，失败进 outbox。
- **A6** `status.json` 含 `pid/pgid/started_at/updated_at/exit_code/state/provider_resume_id`。
- **A7** `orch status` 默认只读，不产生 MR 副作用。

## 4. 状态目录布局

```
${XDG_STATE_HOME:-$HOME/.local/state}/orch/<repo_key>/mrs/<mr_iid>/
  ├── task.yml                # 当前 MR task-spec 快照
  ├── state.json              # MR 折叠态（orch status 可重建）
  ├── locks/{mr.lock, worktree.<hash>.lock}
  ├── outbox/{pending/, sent/}
  └── runs/<run_id>/
        ├── spec.yml          # 本 run 输入快照
        ├── spec.sha256
        ├── status.json       # supervisor 写
        ├── events.jsonl      # orch 标准事件
        ├── native.jsonl      # provider 原生流（原样）
        ├── stdout.log / stderr.log
        ├── result.json       # 终态 + artifact 指针
        └── artifacts/
```

`run_id = <tag>-<UTC紧凑时间>-<6char_rand>`（如 `impl-a-20260619T153012-8f3a2c`；纯时间戳同秒会撞）。

## 5. 关键 schema

### status.json（A6）
```json
{ "run_id":"impl-a-...","mr":3175,"role":"implementer","agent":"codex","tag":"impl-a",
  "state":"running","pid":12345,"pgid":12345,
  "started_at":"...","updated_at":"...","exit_code":null,"timeout_sec":14400,
  "last_event_seq":3,"native_event_count":42,
  "provider_resume_id":"optional","worktree":"/abs","base_sha":"abc123","head_sha":null }
```

### result.json — per-role（`schema` 字段标识；MVP 校验关键字段非空）
- **implementer/v1**：`verdict, summary, base_sha, head_sha, changed_files[], tests[{cmd,exit_code,summary}], acceptance[{id,status,evidence}], risks[], rollback`
- **reviewer/v1**：`verdict(approve|request_changes), reviews_run_id, blocking_findings[{id,severity,file,body}], non_blocking_findings[], suggested_tests[]`
- **verifier/v1**：`verdict(pass|fail), verifies_run_id, commands[{cmd,exit_code,summary}], acceptance[{id,status}]`

implementer 示例：
```json
{ "schema":"orch.result/implementer/v1","run_id":"impl-a-...","verdict":"completed",
  "summary":"修复 dex cache 并发写 partial file","base_sha":"abc123","head_sha":"def456",
  "changed_files":["src/dex/cache.py","tests/test_dex_cache.py"],
  "tests":[{"cmd":"pytest -q","exit_code":0,"summary":"12 passed"}],
  "acceptance":[{"id":"A1","status":"claimed_pass","evidence":"pytest+repro"}],
  "risks":["未覆盖 NFS 锁"],"rollback":"revert def456" }
```

### events.jsonl（MVP 极简，result-driven）
```
{"type":"created","seq":0,"ts":"..."}
{"type":"running","seq":1,"ts":"..."}
{"type":"heartbeat","seq":2,"ts":"..."}
{"type":"done","seq":3,"ts":"..."}        # 或 failed/timeout/cancelled
```
> 实时 `artifact_ready/self_verify/review_done` 等语义事件**留到后面**；MVP 质量 gate 靠主控读 result 裁决。

## 6. `orch run create` 执行流程

```
1 解析 repo_key / mr_iid / task_sha / role / agent / tag
2 flock mr.lock
3 幂等检查（idempotency_key）→ 命中按 §2.2 短路返回
4 检查 git head / dirty / worktree 存在
5 write-role → flock worktree.<hash>.lock（supervisor 持有）
6 创建 run dir，原子写 spec.yml + spec.sha256
7 status.json = created
8 spawn supervisor（os.setsid 新进程组）
9   supervisor spawn worker = drivers/<agent>-headless（§8）
10  native stream → native.jsonl；stdout/stderr → *.log
11  normalizer → events.jsonl（极简）
12  worker 退出 → extractor 写 result.json
13  result schema 校验（A4）
14  status.json = done/failed/timeout；释放 worktree 锁
15  可选：写 MR outbox
返回 {run_id, state, status_path, events_path}
```

## 7. supervisor 边界

**做**：spawn worker、记 pid/pgid、维护 status.json、捕获 native/stdout/stderr、heartbeat、超时标 timeout/stale、退出后提 result、然后**自己退出**。
**不做**：扫所有 MR / 自动派发 / 全局调度 / webhook / agent 选择 / 长期持有 provider session。
> 生命周期 = run 生命周期。它不是 daemon。

## 8. driver 进程合同（统一，但不过度抽象）

```
drivers/<agent>-headless --spec <run_dir>/spec.yml --run-dir <run_dir> --worktree <wt>
# 必须产出：native.jsonl, stdout.log, stderr.log, result.json, exit_code
```
- `codex-headless`：`codex exec --json --cd "$wt" < spec.yml > native.jsonl 2> stderr.log`，从 final message 提 result.json。
- `claude-headless`：`claude -p --output-format stream-json --input-format ... --cd "$wt"`，同上。
- 新增 provider = 新增一个遵守此合同的 driver，`orch` 核心不改。

## 9. orch CLI（agent-agnostic）

```
orch run create --mr <id> --role <r> --agent <a> --tag <t> --worktree <w> --task <f> [--idempotency-key K] [--retry]
orch run list   --mr <id>
orch status     --mr <id> [--json]        # 只读（A7）
orch events tail --run <run_id>
orch result     --run <run_id>
orch attach     --run <run_id>            # = tail native/events/stderr + 打印路径（不接管 stdin）
orch debug shell --run <run_id>           # 开 tmux shell 到 worktree（人接管）
orch decision   accept|rework --mr <id> --run <run_id> [--reason R]
orch mirror sync --mr <id>                # 单独把 state/result/decision 摘要写 MR（经 outbox）
```

## 10. run 状态机（MVP 简单）

```
created → starting → running → done
异常：failed / timeout / cancelled / stale
```
> 不在 run 层做 ack/plan/artifact_ready/review_done 全套；这些是 result 语义，由主控裁决：
> **implementer done ≠ MR accept；reviewer approve + verifier pass + 主控 decision accept 才 accept。**

## 11. attach / resume 语义

- **attach**：headless worker 无交互 stdin；`attach` = `tail -f native.jsonl events.jsonl stderr.log` + 打印 worktree/spec/result 路径。要人接管用 `debug shell`。
- **resume 是优化，不是正确性基础**：run 正确性以 `spec.yml / worktree diff / result.json / events.jsonl` 为准。每个 run 记 `provider_resume_id / base_sha / spec_sha`；provider 没吐稳定 id 就**新建 run / rework run**，不硬续。

## 12. 实施顺序（每步独立产出价值）

- **Phase 0**：bun+ts 工程骨架 + 状态目录 + repo_key/run_id + status/result/events 的 TS 类型 + 3 个 role result schema。**并验证两个 posix 命脉点**：`Bun.spawn` 进程组 kill（`setsid`+`kill -pgid`）、`O_EXCL` pidfile 锁 + stale 检测（各 ~10 行 spike，通过才进 Phase 1）。
- **Phase 1**：codex/claude headless runner —— `orch run create` + supervisor + 落盘 + status/result，**不写 MR**。（含 A1/A2/A3/A4/A6）
- **Phase 2**：`orch status/run list/events tail/result`（只读，A7）。
- **Phase 3**：MR 镜像 —— `orch decision` + outbox + `mirror sync` + MR 摘要/snapshot（A5）。
- **Phase 4**：tmux fallback —— 现有 `agent-dispatch/watch` 包成 `tmux_driver`；`attach`/`debug shell`。
- **Phase 5**：resume/retry —— `provider_resume_id`、`run retry`、stale/timeout policy。

## 13. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 无 daemon 但多主控并发 | MR lock + idempotency key（§2.1/2.2） |
| provider JSON 流不稳定 | native.jsonl 原样存；events/result 用自有 schema |
| headless 进程难人工接管 | attach=tail+debug shell，不承诺接管 stdin |
| 本地状态不跨机 | **MVP 接受同机**；跨机冷恢复依赖 MR 镜像，不保证 native logs 完整。需多机再上 daemon/DB |
| worktree 并发写污染 | write-role worktree 锁（§2.3）+ review/verify 评 artifact 不评 worktree（D8） |
| 6 约束把 MVP 养成平台 | 每条用 flock/jq/文件，禁框架（§2 注） |

## 13b. P1 已知待办（sub-claude Round2 排期项；B1/N1/N6 本轮已让 codex 修）

- **N3（进 D7 前必修）**：`bun build --compile` 单 binary 当前会断——supervisor/driver 以 `execPath` + 外部 `drivers/*.ts` 方式 spawn，编译后旁边没有 .ts。需改成**同一 binary 的 argv-dispatch 子命令**（`orch __supervisor` / `orch __driver-<agent>`），或把 drivers 打进 bundle。P1 从源码 `bun run` 无碍。
- **N2**：`schemas/*.json` 当前是死代码、与手写 TS 校验已漂移 → 接入 JSON schema 作单一权威，或删 JSON 并注明 TS 为 canonical。
- **N4**：`spec.sha256` 应对**落盘字节**求（现对紧凑 JSON 求，与 pretty 落盘不符）。
- **N5**：`spec.yml` 实为 JSON 内容 → 改名 `spec.json` 或真序列化 YAML。
- **N7**：`§6.4` dirty 仅上报不拦 write-role → 至少 dirty 时 warn / `--allow-dirty` 守门。
- **L2**：锁 pid 复用误判 → 锁内带 `ts`/`run_id` sentinel + 超龄阈值兜底。
- **L3**：幂等记录在 spawn 前写 → spawn 失败会使 key 永久指向未启动 run（改 spawn 成功后写）。
- **L4**：`--retry` 覆盖幂等记录致旧 run 指针丢失。

## 14. 一句话

> 不要 daemon 化、不要 SDK 大一统、不要继续 send-keys。先把 worker 进程化、状态本地化、
> MR 镜像化、CLI 稳定化。等无人值守/多机/队列调度真出现，再自然升级 `orchd`。
