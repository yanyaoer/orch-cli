# 多 Agent 编排实现方案（tmux + glab MR 中心化）

> 主控 = 主 Claude（orchestrator）；worker = 跑在常驻 tmux 交互 session 里的原生 CLI（codex / claude / ~~agy~~）。
> 每个任务 1:1 绑定一个 glab MR；MR = 跨会话/跨机的中心状态载体。派发与回报全程**结构化**，禁自由文本随意发挥。

---

## 1. 设计目标

- **主控派发、子 agent 执行**：主 Claude 拆任务、派给 worker、汇总裁决；worker 独立 context 干活。
- **跨厂商对抗**：codex(GPT) / claude / agy(Gemini) 各出一版或互审 —— tmux 路线的唯一不可替代价值。
- **中心化、可恢复**：状态全落 MR，会话/机器重启可纯从 MR 重建，零依赖 /tmp。
- **省资源、可接续**：空闲 worker 自动回收并记录 resume 点，有任务再续跑、不丢上下文。
- **结构化**：任务派发用固定 schema 模板，状态回报用机读事件，避免误判 / 续错 / 解析脆。

---

## 2. 总体架构

```
                ┌─────────────────────────── 主 Claude (orchestrator) ───────────────────────────┐
                │  拆任务 → 填 task-spec → glab mr update 写入 MR 描述 → agent-dispatch.sh 派活      │
                │  读 glab mr note list -F json 折叠 orch-evt → 裁决 → 更新 MR / resolve / 派子任务  │
                └───────────────┬─────────────────────────────────────────────┬──────────────────┘
                                │ send-keys (tmux)                             │ glab (read)
                 ┌──────────────▼───────────────┐               ┌─────────────▼──────────────┐
                 │  tmux session                │               │  glab MR  (中心状态)        │
                 │  mr<id>-<agent>-<tag>         │   orch-evt    │  - 描述 = task-spec(yaml)   │
                 │  worker CLI (yolo, 交互REPL)  │──────────────▶│  - 评论 = orch-evt 事件流    │
                 │  options: @id @task @agent …  │  glab note    │  - discussion 线程 = 人审    │
                 └──────────────┬───────────────┘   create      └─────────────────────────────┘
                                │ 盯防
                 ┌──────────────▼───────────────┐
                 │  agent-watch.sh (每 worker 一) │  done 检测(JSON+jq, 按 run_id) → 通知
                 │                               │  完成后闲置 30min → 发 reaped 事件 + kill
                 └───────────────────────────────┘
```

---

## 3. 角色与分工

| worker | CLI | 擅长 | 状态 |
|---|---|---|---|
| codex | `codex`（GPT-5.x） | 棘手 bug 根因、复杂重构、二次诊断、第二实现 | 启用（yolo） |
| sub-claude | `claude`（独立 Opus） | 并行分担、独立对比方案 | 启用 |
| agy | `agy`（Gemini） | 大上下文跨文件、架构、多模态 | **暂停**：本环境 Antigravity CLI 反复 execution error |

- 难题让多方各出一版或互审，主控汇总裁决。
- **worker 必须是 tmux 里的原生 CLI**，不是 Claude 的 Agent 工具 subagent（禁用 `codex:codex-rescue` 等套壳冒充——那是 Claude/Sonnet 桥接，模型/上下文都不是本体，还烧 token、占槽）。

---

## 4. 绑定模型（task ↔ session ↔ MR）

- 一个 `<slug>` 贯穿：MR 源分支/worktree `task/<slug>`（MR 打 `orch` label）。
- 每个 worker 一个独立 session：**`mr<id>-<agent>-<tag>`**
  - `id` = MR number；`agent` ∈ codex/claude；`tag` = 分身/子任务短标识 `[A-Za-z0-9_.-]{1,32}`
  - 例：`mr3175-codex-dexA`、`mr3175-codex-fixb`（同 MR 多分身靠 `mr<id>-` 前缀聚合、tag 区分，避免撞名）
- **当前子任务挂 tmux option `@task`，不进 session 名**：调度调整 = `tmux set-option @task`（或重调 dispatch），session 名与 send-keys key 不变。
- session options：`@id`(run_id) `@tag` `@agent` `@task` `@mr` `@claude_state`。
- **无独立注册表**：在途任务 = `glab mr list --draft --author=@me -l orch` ∩ `tmux ls`（worker = `mr*` 前缀）。

---

## 5. task-spec 结构化派发模板

任务派发的**唯一**载体（模板：`~/.config/tmux/scripts/task-spec.tmpl.yml`）。
gitlab 工程 → 作为 MR 描述里的一个 ` ```yaml ``` ` 块（机读+人读）；非 gitlab → 落 `/tmp/handoff-<id>.yml`。

```yaml
spec_version: 1
mr: ""                 # MR number；非 gitlab 填 "-"
agent: ""              # codex | claude
tag: ""                # 分身/子任务短标识 [A-Za-z0-9_.-]{1,32}
worktree: ""           # 绝对路径（worker session 的 cwd）
objective: ""          # 一句话目标，产出导向、可校验
context: |             # 自包含背景；完整权威源放 refs，不堆全文

refs: []               # ["feishu:<url>", "decision:<一句话>", "mr:<n>"]
scope:
  in:  []              # 明确「要做」
  out: []              # 明确「不做」（边界，防发挥）
tasklist:              # 可勾子项；done 由主控裁决后改
  - { id: t1, desc: "", done: false }
constraints: []        # 已定决策 / 硬约束
acceptance: []         # 可校验验收条件（逐条）
report:
  channel: ""          # mr-note | file
  events_to: ""        # MR number 或 /tmp/result-<id>.yml
```

- 主控用 `glab mr update <branch> -d -`（heredoc）整体刷新 MR 描述。
- 依赖/阻塞/状态也是结构化字段（`depends_on` / `blocked_by` / `status`），不写散文。

---

## 6. orch-evt 结构化回报协议

worker → 主控，**单行 JSON 事件**（机读），替代 emoji + 自由文本前缀：

```
glab mr note create <mr> -m 'orch-evt: {"type":"progress","id":"<run_id>","seq":1,"body":"<简述>"}' --resolvable=false
```

| 字段 | 含义 |
|---|---|
| `type` | `progress` \| `review` \| `blocked` \| `done`（reaped 由 watcher 发） |
| `id` | 本次 **run_id**（dispatch 经 `@id` 告知 worker）——旧评论/复述因 id 不符不会误触发 |
| `seq` | 单调递增整数 |
| `body` | 简述（人读） |

- 收尾**必发** `type=done`。
- 方案讨论 / 对抗 review 仍可用 discussion 线程（`proposal:` / `review:` 人读）互审；主控发 `decision:` 定稿并 `glab mr note resolve` 收口。
- 非 gitlab：把同样的 `orch-evt: {json}` 行逐行追加到 `report.events_to` 文件。

watcher 读取（**不再 grep emoji/自由文本**）：

```bash
glab mr note list <mr> -F json | jq -r --arg id "$run_id" '
  [ .[].notes[].body
    | select(type=="string" and startswith("orch-evt:"))
    | sub("^orch-evt:[[:space:]]*"; "")
    | (fromjson? // empty)
    | select(.type=="done" and .id==$id) ] | last | (.body // "")'
```

---

## 7. 派发流程 `agent-dispatch.sh`

```
agent-dispatch.sh <agent> <mr-id> <tag> <worktree> <task-desc>
```

1. `session=mr<id>-<agent>-<tag>`；`run_id="<tag>-$(date +%s)"`。
2. **幂等保活 / resume**（`! has-session` 时）：
   - 查 MR 是否有本 tag 的 `reaped` 事件（`-F json` + jq 取 `resume`）：
     - 有 → resume：claude `--resume <id>`（拿不到 id 用 `-c`）；codex `resume --last`；agy `-c`（均带 yolo flag）
     - 无 → fresh：worker 以 **yolo** 启动（`codex --dangerously-bypass-approvals-and-sandbox` / `agy --dangerously-skip-permissions` / `claude`）
   - `sleep 5` 等 REPL settle；claude 发 `S-Tab` 退 plan-mode。
3. set options：`@mr @tag @agent @id(run_id) @task @claude_state=working`。
4. **send-keys 派活**（结构化指令）：让 worker 读 MR 的 task-spec 执行、按 orch-evt 用 `id=<run_id>` 回报、完成发 `type=done`。
5. 起 watcher（先 `pkill -f "agent-watch.sh <session> "` 杀旧 watcher，避免叠加）。

---

## 8. watcher `agent-watch.sh`：完成检测 + 空闲回收

```
agent-watch.sh <session> <mr-id> <tag> <worktree>     # run_id 从 @id 读
```

- **完成检测**：`glab note list -F json` + jq，按 `(type==done, id==run_id)` 命中 → 翻 `@claude_state=idle` + 通知。
- **空闲回收（reap）**：**收到 done 后**闲置 `@agents_reap_idle`（默认 1800s）→ 发结构化事件
  `orch-evt: {"type":"reaped","id":...,"tag":...,"agent":...,"resume":<id>,"cwd":...}` 到 MR → `kill-session`。
  - **安全铁律**：只回收"已完成后闲置"的；**没发 done（在跑/长编译静默）的绝不杀**。
- **resume id 捕获**：claude 精确——`pwd -P` 解析 worktree realpath → 编码 `/`,`.`→`-` → 取 `~/.claude/projects/<enc>/` 最新 `.jsonl` basename；codex/agy 留空（resume 时续最近）。
- **maxlife**（默认 14400s）：始终没 done → 停止盯防但**不杀**（留给主控）。
- 可调 option：`@agents_watch_interval`(10s) `@agents_reap_idle`(30m) `@agents_watch_maxlife`(4h)。

---

## 9. resume 接续机制（混合精度）

| agent | 精度 | 命令 |
|---|---|---|
| claude | **精确** | `claude --resume <session-id>`（id 按 worktree realpath 定位） |
| codex | 续最近 | `codex --dangerously-bypass-approvals-and-sandbox resume --last` |
| agy | 续最近 | `agy --dangerously-skip-permissions -c` |

- 触发：再派同一 `<agent>/<tag>`，dispatch 读 MR `reaped` 事件自动续跑而非新建。
- **局限**：精确 resume 仅 claude 保证；codex/agy 在同 worktree 同类多分身并行时可能续错。

---

## 10. 状态面板（`alt-g` 切换）

`agents-panel-toggle.sh`（绑 `M-g`）在 window 左侧开：

- **AGENTS**（`agents-monitor.sh`）：列 `claude-*` + `mr*` + 裸 worker session，按 session 名排序（同 MR 聚合），展示状态色（working/done/waiting）+ age + `@task`。
  - 已**批量化**：单次 `tmux list-sessions -F`（一并取 `@claude_state/@claude_state_at/session_activity/pane_current_command/@task`），fork 从 O(5N) 降到 O(2)。
  - `read` 区分超时（continue）与 EOF（break）——pane 关闭即退出，**不再空转 fork**（曾导致 7 孤儿 + fork 风暴）。
  - `--once` 模式打印一帧纯文本（调试/取值）。
- **WORKTREES**（`worktree-monitor.sh`，仅多 worktree repo）：列 worktree，Enter 开新 window。同款 EOF 退出修复。

`prefix+Y`（`bind Y`）= 手动兜底起裸 `codex/agy/sub-claude` session；常规编排走 dispatch。

---

## 11. 中断恢复（零依赖 /tmp）

1. `glab mr list --draft --author=@me -l orch` 列全部在途任务。
2. 每个 `glab mr view task/<slug>`（读 task-spec：tasklist/status/scope）+ `glab mr note list <id> -F json`（折叠 orch-evt 看进度/未决/done）。
3. `glab mr checkout task/<slug>` 恢复 worktree；缺失 session 用 `agent-dispatch.sh …` 重新拉起（含 reaped 自动 resume）。

---

## 12. 兜底模式（非 gitlab 工程）

`git rev-parse` 失败或 remote 非 `git.n.xiaomi.com` 时回退 /tmp：
- 同一份 **task-spec(yaml)** 存 `/tmp/handoff-<id>.yml`；
- worker 把 `orch-evt` 逐行追加到 `report.events_to`（`/tmp/result-<id>.yml`）；
- session 名用裸 `codex|sub-claude`，**不走 dispatch**（它专为 MR 模式）。

---

## 13. 依赖工具与配置

- `glab`（已登录 `git.n.xiaomi.com`）：`mr create/update/view/note(list -F json/create/resolve)/checkout`。注意 `glab mr note` 系列是 **EXPERIMENTAL**。
- `tmux`、`jq`、各 worker CLI（codex/claude/agy，均支持 resume/continue）。
- Claude Code statusline `refreshInterval` 已从 1 调到 5（降低各会话 `git status` 频率）。

---

## 14. 文件清单

| 路径 | 作用 |
|---|---|
| `~/.claude/CLAUDE.md` →「多 Agent 编排」节 | 编排规范（权威源） |
| `…/scripts/task-spec.tmpl.yml` | 任务派发标准模板 |
| `…/scripts/agent-dispatch.sh` | 派活：起/resume session、set options、send-keys、起 watcher |
| `…/scripts/agent-watch.sh` | 完成检测（orch-evt JSON）+ 空闲回收（reaped 事件） |
| `…/scripts/agents-monitor.sh` | AGENTS 状态面板（批量化、EOF 退出、`--once`） |
| `…/scripts/worktree-monitor.sh` | WORKTREES 面板（EOF 退出） |
| `…/tmux.conf` | `prefix+Y` 菜单（兜底）/ `alt-g` 面板绑定 |

> `…` = `/mi/dotfiles/tmux/.config/tmux`（`~/.config/tmux` 软链到此）。

---

## 15. 已知局限与风险（诚实记录）

- **传输层脆性**（根因，未解）：`send-keys` 向交互 REPL 盲发按键不可靠——慢机 `sleep 5` 丢键、各 CLI 交互怪癖（trust/调查/plan-mode）、僵尸 session 仍 send。结构化协议只提升了**状态判定**可靠性，没解决**传输**。
- **agy 不可用**：本环境反复 `execution error`，即便 yolo；A+D 角色暂由 sub-claude/主控顶。
- **glab note EXPERIMENTAL**：子命令未来可能变动；已统一 `-F json` 降低 text 解析脆性，但仍依赖其稳定。
- **codex/agy resume 续错**：同 worktree 同类多分身并行时 `--last` 可能接错历史。
- **watcher 可观测性弱**：退出（maxlife/错误/被 pkill）后无 heartbeat/pidfile，主控不易察觉 unwatched。
- **本质**：这是"在 tmux send-keys 地基上自建的分布式任务状态机"，复杂度偏高、维护成本不低。

---

## 16. 可选演进路径（随时可切）

若维护成本顶不住，**Claude Code 原生**就是标准替代，能省掉绝大部分自制基建：

| 现自制 | 原生替代 |
|---|---|
| tmux 起 worker | **Agent 工具**（`subagent_type`） |
| task-spec 派发 + orch-evt 回收 | Agent prompt + **schema(structured output)**，返回值即结果，零中转 |
| watcher 盯 done/reap | agent 完成即返回；后台 agent 完成自动通知 |
| dispatch resume / 并行 | **SendMessage** 续 agent / **Workflow** pipeline |
| agents-monitor | **FleetView**（已开 `EXPERIMENTAL_AGENT_TEAMS`） |
| 跨厂商第二意见 | 官方 `codex` 插件 subagent（Agent 工具调 codex，不用 tmux） |

> 取舍：原生路线丢掉 tmux 跨厂商并存的灵活，但换来零自制基建、稳定可维护。MR/飞书在任一路线都应**降级为人看的持久归档**，不当 agent 间传输总线。

---

## 17. 演进方案定稿（orch，SDK-first / 去平台化 MVP；随输入迭代）

> 在第 16 节"原生路线"与父王的 `orchd` 提案之间取的中线：**取其方向（worker 进程化、MR 降镜像、driver 解耦、主控可插拔），去其平台（daemon/webhook/DB/capability-matcher 暂不建）**。

### 决策记录（decisions）
- **D1 主控可插拔**：任务分发与监控由 claude / codex / pi-agent **任意一个**当主控完成，统一调 `orch` CLI（后续可加 MCP tools）。⟹ 状态必须**外置**、主控**无状态**，换主控不丢上下文。**化解"交互式主控 vs 自治 daemon"矛盾：reconciler = 任意交互 agent 经 orch 接口操作外置状态，不需要常驻 daemon。**
- **D2 状态目录**：`$HOME/.config/orch/<repo>/<mr>/<run_id>/`（持久、不随 worktree 删、不进业务仓）。
- **D3 worker = headless 子进程**：`codex exec [--json] resume` / `claude -p --output-format stream-json --resume`（已验证可用）；tmux 仅 `attach` 调试/人接管，非传输层。
- **D4 MR = 审计镜像**：实时状态源在本地 `.orch`；MR 只写 task-spec snapshot + decision/review/verify 摘要，供人审与冷恢复。
- **D5 无常驻 daemon（MVP）**：薄 `orch run` 同步/后台 spawn 子进程即可；仅"无人值守 / webhook 触发 / 多机"才升级 daemon。
- **D6 driver 抽象延后**：先把 codex + claude 两个 headless driver 跑稳，抽象自然浮现；capability matcher / 三层 profile / 4-provider layer 暂不建（YAGNI）。agy 仍 disabled，pi 待验证。

### 状态目录布局
```
$HOME/.config/orch/<repo>/<mr>/
  ├── task.yml                # task-spec（派发输入，机读）
  └── runs/<run_id>/
        ├── spec.json         # 本次 run 的 task-spec 快照
        ├── events.jsonl      # orch-evt 事件流（worker 追加，实时状态源）
        ├── result.json       # 终态 + artifact 指针
        └── status            # pid / heartbeat / exit / last_seq / lease
```

### orch CLI（agent-agnostic，任意主控可调）
```
orch run create --mr <id> --role <r> --agent <a> --tag <t> --worktree <w> --task <...>
orch status     --mr <id>            # 折叠 runs/*/status + events
orch events tail --run <run_id>
orch result     --run <run_id>
orch attach     --run <run_id>       # tmux 调试/接管
orch decision   accept|rework --mr <id> --run <run_id>
```

### MVP 落地顺序
1. `orch run create` → spawn `codex exec --json` / `claude -p stream-json`，stdin 喂 `spec.json`，stdout→`events.jsonl`，退出写 `result.json` + `status`。**no daemon / webhook / DB。** → 一步消灭 send-keys / watcher / resume 三大脆性。
2. per-run **轻量 supervisor**（`orch run` 启动时 fork，盯 pid/超时/heartbeat 写 `status`，run 结束即退）——取代现在的全局 watcher，非常驻。
3. 主控（claude/codex/pi）轮询 `orch status` / 读 `result.json`，裁决后 `orch decision` 写 MR 摘要镜像。
4. 现有 `agent-dispatch.sh` / `agent-watch.sh` 包成 `tmux_driver` 作 fallback，渐进不推翻。

### 待办 / 风险
- 验证 `codex exec --json` 与 `claude -p stream-json` 在真任务上的事件流/resume 行为（落地前必做）。
- pi headless（`pi -p --mode json` / RPC）能力待实测后再入 driver。
- supervisor 的 heartbeat/lease 语义保持最简，别又长成 daemon。

> **完整可实施 spec（含 6 条硬约束、A1–A7 acceptance、状态目录/schema/流程/Phase 0–5）见 `/tmp/orch-mvp-spec.md`。** 本节为概览，spec 为施工蓝图。
