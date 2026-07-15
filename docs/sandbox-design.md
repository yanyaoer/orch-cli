# orch macOS Sandbox 设计

Status: Implemented (`seatbelt-v1`, 2026-07-14；实现入口 `drivers/sandbox.ts` + `buildProviderExecutionPlan` + host dispatch `src/dispatch.ts`。两轮 review 后已收窄 TMPDIR、provider state、controller dispatch、verifier posture 和 engine 计算边界；证据见 `docs/reviews/`)

本文定义 `orch` 的本地 sandbox 目标设计。它解决的是个人在真实仓库中编排多个高权限 agent 时的误操作半径，不把本机 agent 包装成不可信租户，也不试图替代虚拟机。

## 1. 决策摘要

当配置为 `"sandbox": true` 时，`orch` 在 macOS 上使用一层由自己生成的外层 Seatbelt，统一包住 `claude`、`codex`、`pi` 和 `omp`：

```text
orch supervisor
  └─ driver
      └─ /usr/bin/sandbox-exec -p <orch profile>
          └─ provider CLI
              └─ provider 启动的所有工具和子进程
```

核心决策如下：

- 四个 provider 共用同一种 OS 写边界，不按 provider 决定“有没有真正的 sandbox”。
- provider 自带的 macOS sandbox 在外层 Seatbelt 生效时必须关闭，避免嵌套 `sandbox_apply`。
- Codex 不需要一套 orch 专用 sandbox 实现；它只需要以“已由外部 sandbox 隔离”的官方模式运行。
- 默认允许读取、执行和网络访问，只限制本机文件写入。
- write role 只能写当前 worktree；read-only role 连当前 worktree 也不能写。
- provider 只获得自己的认证/会话状态目录，不获得其他 provider 的目录。
- Git 元数据默认只读。agent 交付未提交 diff，由 supervisor 采集，不要求 agent 自己 commit。
- `sandbox:true` 不能静默降级：平台不支持、profile 无效或 Seatbelt 应用失败都必须让 run 失败。
- v1 不提供任意 `extraWritePaths`，避免一个便利开关逐步掏空边界。

这是一种 macOS 上的防误写机制，不是恶意代码安全边界。需要对抗恶意仓库、隔离读取、限制网络或保护凭据时，应使用独立用户、容器或 microVM。

## 2. 问题本质与边界

### 2.1 要保护什么

主要资产是当前项目之外的用户文件，例如其他仓库、文档、桌面文件和全局配置。需要阻止 agent 或其子进程因错误命令而对这些文件执行：

- 创建、覆盖、追加和截断；
- 删除、移动和重命名；
- chmod、chown、扩展属性等元数据修改；
- 通过 symlink、`..` 或绝对路径绕到允许区域之外写入。

### 2.2 信任假设

- 用户、`orch`、已安装的 provider CLI 和 macOS 本身是可信的。
- task、模型输出和仓库脚本可能出错，但不是主动攻击者。
- agent 需要继续使用本机已有的 OAuth 登录、配置、模型额度和工具链。
- agent 可以读取本机文件，也可以访问网络。

### 2.3 明确不解决

- 不阻止读取 `~/.ssh`、浏览器资料或其他秘密。
- 不阻止通过网络、MCP、`ssh`、`git push`、`glab` 等产生远端副作用。
- 不阻止 agent 删除或破坏当前 worktree 内的内容。
- 不隔离 CPU、内存、进程数、端口和系统调用。
- 不保护允许写入的 provider 状态、orch 状态和临时目录本身。
- 不把 Seatbelt 宣称为可承载敌对代码的长期安全产品；`sandbox-exec` 已被 Apple 标记为 deprecated。

因此，准确承诺是：在列出的本地可写例外和已知 hardlink 限制之外，降低 agent 意外修改当前项目外文件的概率和影响范围。

## 3. 不变量

实现必须保持以下不变量：

1. **单一外层边界**：`sandbox:true` 时所有 provider 都由同一版本的 orch Seatbelt policy 约束。
2. **原子生成**：任何关闭 provider 原生 sandbox 的参数，只能由同时生成外层 wrapper 的同一个函数产生。
3. **失败关闭**：不能应用目标 sandbox 时，不启动 provider。
4. **最小写集合**：没有真实运行证据的目录默认不开放。
5. **角色决定项目权限**：provider 不能改变 role 对 worktree 的读写姿态。
6. **一文件一写者**：`native.jsonl`、`stdout.log`、`stderr.log`、`result.json` 等正式 run artifact 仍由 driver/supervisor 拥有。
7. **可审计**：`spec.json`、`status.json`、dry-run 和事件中可以看出实际使用的 sandbox engine 与 posture。
8. **策略版本进入 run identity**：sandbox 语义改变时，旧 run 不能被幂等机制误复用。

## 4. 权限模型

### 4.1 角色权限

| Role | worktree | Git metadata | provider state | run scratch | orch state |
|---|---:|---:|---:|---:|---:|
| `implementer` | 可写 | 只读 | 可写 | 可写 | 只读 |
| `verifier` | 可写 | 只读 | 可写 | 可写 | 只读 |
| `reviewer` | 只读 | 只读 | 可写 | 可写 | 只读 |
| `researcher` | 只读 | 只读 | 可写 | 可写 | 只读 |
| `controller` | 只读 | 只读 | 可写 | 可写 | 仅 `dispatch/pending/<run-id>` |

`verifier` 需要运行会创建构建产物、测试缓存和快照的命令，因此使用 `project-write`。若将来出现纯只读 verifier，再增加显式 role，而不是猜测某条命令是否会写。

`controller` 需要派发任务、记录 decision 和回复 mail，但一个 sandboxed controller 无法直接 spawn 可用的 worker：它 spawn 的任何进程都继承它的只读 Seatbelt，而 macOS 不能嵌套 `sandbox_apply`。因此每个 controller 只获得自己的 **dispatch pending** 目录（`${orchStateRoot}/dispatch/pending/<controller-run-id>`），不获得整个 dispatch 或 orch state root。`pending`、`claims`、`done` 三个 run endpoint 在创建前后都必须解析到 canonical orch state 下的精确 host-owned slot，任一层 alias/symlink、非目录或非当前 uid 目录都拒绝；只有 pending 进入 Seatbelt write allow。`claims/<run-id>` 和 `done/<run-id>` 由 host 独占；controller 不能伪造执行结果。只读 `orch` 命令（`wait`/`result`/`status`）仍在 sandbox 内本地执行，它也没有 Claude `Edit`/`Write` 工具。

Host dispatch 不是任意命令通道。v1 只接受 `run create/cancel`、`fanout`、`cross-review`、`investigate`、`decision accept/rework`、`mailctl reply/ack`；其中 mailctl mutation 还要求 spec 同时符合 host 创建的 mail controller tag/idempotency 身份，普通 controller 即使 MR 名碰巧与 mail thread 相同也不能调用。请求只携带 argv、stdin 和 controller run context；host 从请求文件名生成 id，再用 host-owned `spec.json`/`status.json` 重新绑定 live controller、canonical worktree 和 thread。producer 先把完整 JSON 写到不匹配 queue filter 的临时名，再用 hardlink 以 no-overwrite 语义原子发布最终 `.json`；consumer 在临时 link 尚未删除的极短窗口内保持 pending，发布稳定后才 claim，并保留 claim 后的 hardlink 校验。所有 positionals/flags 都按 operation 精确校验，task 只允许 `--task -`，host 随后重建 argv；请求提供的 cwd、路径选择、未知命令和未知 flag 均不进入 spawn。host 使用的 orch executable/source entrypoint 还必须是 worktree 外的 absolute canonical path，防止在 orch 自身仓库工作时，write-role agent 修改源码后被下一次 unsandboxed dispatch 执行；这种 self-hosted source-mode 必须改用 checkout 外安装的二进制。claim 只在 result 原子持久化后删除；host 若在执行窗口中断，下一次 reconcile 返回 `outcome_unknown`，不盲目重放可能已发生副作用的命令；若结果已经完整写入则恢复时保留原结果，半写文件则原子替换。`orch new` 在 controller 生命周期内运行 reconciler；`mailctl poll` 每次 drain，基础设施错误沿现有 poll failure audit/backoff 暴露；`orch dispatch reconcile --watch` 提供低延迟 companion。

### 4.2 provider 适配

| Provider | 外层 Seatbelt 生效时的启动方式 | 保留的上层限制 |
|---|---|---|
| Codex | 增加 `--dangerously-bypass-approvals-and-sandbox`，由 orch 外层承担文件写边界 | role、模型、web search、session 参数 |
| Claude | 强制 `--settings '{"sandbox":{"enabled":false}}'`，避免内部再次 `sandbox_apply` | `allowedTools`、`permission-mode` 和 controller/researcher 白名单 |
| pi | 直接置于外层 Seatbelt | read-only role 的工具白名单、session 参数 |
| omp | 直接置于外层 Seatbelt | read-only role 的工具白名单、fallback chain、session 参数 |

这里的 Codex “bypass” 不是无约束运行：它和外层 wrapper 是同一个 execution plan 的两个不可分割部分。若外层 plan 构建失败，带 bypass 的 argv 不得被返回或执行。

Claude 关闭的是其内部 OS sandbox，不是 role 工具权限。`dontAsk`、`plan`、`allowedTools` 仍作为意图层的纵深限制，Seatbelt 负责最终的文件系统写边界。

## 5. 不使用 API key 的授权方式

Seatbelt 不是容器，不需要把 home 目录“挂载”进去。provider 直接读取本机已经登录的状态，只对当前 provider 的状态位置开放写权限：

| Provider | 可写状态 |
|---|---|
| Claude | `~/.claude/`、`~/.claude.json`、`~/.claude.json.backup` |
| Codex | `~/.codex/` |
| pi | `~/.pi/` |
| omp | `~/.omp/` |

使用流程是：用户先在普通终端完成官方 CLI 登录，`orch` 再复用这些 OAuth/session 文件。v1 不复制 token，不维护 API key，也不尝试理解各 provider 私有数据库的内部结构。

上表描述的是写权限，不是读权限。由于本方案刻意保留 host read，其他 provider 状态和凭据仍可能被读取；需要 credential secrecy 时必须升级隔离层，不能靠这份 profile。

这会产生可接受但必须公开的副作用：

- provider 可以刷新 token、写历史、创建 session、更新 SQLite/WAL/lock 和修改最近使用时间；
- 同一 provider 的并发 run 共享全局状态，仍可能遇到 provider 自身的锁竞争；
- provider 状态目录若损坏，会影响普通交互式 CLI；
- OS 不能区分“provider 内部状态写入”和“模型工具主动写入该目录”，因此这些目录不在保护承诺内。

不能把 `~/.codex`、`~/.claude`、`~/.omp`、`~/.pi` 全部开放给每个 run。每次只开放所选 provider 的状态；`~/.config`、`~/Library/Application Support`、`~/Library/Preferences` 等通用目录默认不可写。若某个 provider 升级后需要新路径，先用真实 run 证明，再升级 policy 版本。

v1 也不把这些目录复制成每 run 的伪 home。它们的 schema 私有且持续变化，复制会引入 token refresh 回写、数据库/WAL 一致性、Keychain 引用和 session resume 漂移。若 provider 将来提供稳定的“只读凭据 + 独立可写 state”接口，再按 provider 做显式适配；在此之前，共享当前 provider 的真实状态是为了保留本机授权所接受的最小例外。

## 6. 文件系统策略

### 6.1 基础 profile

profile 使用以下形态：

```scheme
(version 1)
(allow default)
(deny file-write*)

; 根据 role 精确添加 file-write* 例外
; 最后再次拒绝 worktree/.git 和其他保护路径
```

`allow default` 保留读取、进程执行和网络能力；`deny file-write*` 建立写入默认拒绝。所有允许项必须由 orch 根据本次 run 计算，不能接受 task 或模型提供的路径。

### 6.2 路径规范化

生成 profile 前：

1. host 创建本次 run scratch，并设为仅当前用户可访问；
2. 对 worktree、run dir、scratch、home、provider state 和 controller state 做绝对路径解析；
3. 目录通过 `realpath` 固定到真实位置，避免 symlink 别名扩大规则；
4. 精确文件路径通过 canonical parent 加 basename 构造；
5. 拒绝 NUL、换行和其他不能安全进入 SBPL string 的控制字符；
6. SBPL 对反斜杠和双引号做专用转义，不能复用 shell quoting；
7. 每一个来自 provider/controller state 的可写 subpath，canonicalize 后必须再过一道窄目录校验：拒绝 `/`、HOME、与 worktree 任一方向重叠、共享系统根、非目录、以及非当前 uid 拥有的目录。provider 顶层状态目录不支持 symlink，即使其目标仍是某个“窄目录”也拒绝；根级 provider state 文件（`~/.claude.json*`）必须保持 HOME 下的精确文件名，并拒绝 symlink、hardlink 和非普通文件；controller queue 的三个 endpoint 还必须保持 canonical state root 下的精确 slot。dry-run 允许这些精确 endpoint 尚不存在，但仍执行所有 lexical/alias 检查且不创建目录。

缺失的 provider 状态目录表示该 provider 尚未完成初始化，run 应提示用户先在普通终端登录，而不是开放整个 home 让 provider 自行寻找落点。

### 6.3 允许写入的位置

每个 run 的最小集合为：

- `project-write` posture：canonical worktree，但排除 Git metadata；
- 当前 provider 的状态路径；
- `${runDir}/scratch/`；
- `/private/tmp/`，用于 Claude 等 CLI 的已验证临时文件；
- 当前进程的 canonical `TMPDIR`，仅当它是真正的 Darwin per-user temp（`/private/var/folders/<hash>/<hash>/T[/...]`）且由当前 uid 拥有时；任意 `$TMPDIR`（`~/Documents`、其他 repo、`/opt/...`）一律拒绝，防止调用者用环境变量把任意目录塞进写白名单；
- 精确的 `/dev/null`；
- controller role 自己的 canonical `${orchStateRoot}/dispatch/pending/<controller-run-id>`；`claims/`、`done/` 和整个 orch state root 均不允许写。

`/private/tmp` 是有意接受的 disposable-state 例外，不应被描述成项目边界的一部分。`/private/var/folders` 整棵树、整个 `/dev`、整个 run dir 都不允许写。

### 6.4 scratch、cache 与环境变量

所有 provider 共用 run-scoped scratch：

```text
<runDir>/
  spec.json                 # provider 只读
  native.jsonl              # driver 写
  stdout.log                # driver/supervisor 写
  stderr.log                # supervisor 写
  result.json               # driver 写
  scratch/                  # provider 可写
    tmp/
    cache/
    last_message.txt
```

启动前至少重定向：

```text
TMPDIR=<runDir>/scratch/tmp
TMP=<runDir>/scratch/tmp
TEMP=<runDir>/scratch/tmp
XDG_CACHE_HOME=<runDir>/scratch/cache
BUN_INSTALL_CACHE_DIR=<runDir>/scratch/cache/bun
```

如 npm 等实际测试证明需要，再把相应 cache 环境变量指向同一 scratch。默认不开放 `~/.cache`、`~/.npm`、`~/.bun`、`~/Library/Caches` 或 `.cargo`。

Codex 的 `--output-last-message` 必须写到 `scratch/last_message.txt`。driver 在 provider 退出后读取它并生成正式 artifact，不能因为这个参数而把整个 run dir 交给 provider。

### 6.5 Git 与 linked worktree

默认策略是“源码可写，Git 元数据只读”：

- 显式拒绝 canonical `${worktree}/.git` 的 literal 和 subtree；
- linked worktree 指向的 common Git dir 也不在任何允许写集合内；
- 设置 `GIT_OPTIONAL_LOCKS=0`，避免 `git status` 为刷新索引尝试获取可选锁；
- `git status`、`git diff`、读取 HEAD 等应工作；
- `git add`、`git commit`、创建 ref、修改 config/hooks 应失败。

真实 linked-worktree probe 已证明：普通文件编辑和 `git status --short` 在此策略下成功，`git add` 因 `index.lock` 被拒绝而失败。因此“不开放 Git common dir”不是 v1 blocker，也符合当前由 supervisor 采集未提交 diff 的工作流。

若以后明确需要 agent commit，新增独立且醒目的 `git-write` posture，并重新评审锁、hooks、config、refs 和跨 worktree 影响；不能悄悄把 Git metadata 加进 `project-write`。

### 6.6 hardlink 预检

Seatbelt 是路径策略。一个在 worktree 中已经存在、但与外部文件共享 inode 的 hardlink，可以经允许路径修改外部内容。这个逃逸已被真实 probe 证实。

v1 在启动任何 sandboxed provider 前遍历 worktree 中的普通文件，排除只读的 `.git`，只要发现 `stat.nlink > 1` 就失败关闭，并列出冲突路径。不能提供忽略开关；需要保留 hardlink 的项目应先复制到不共享 inode 的 worktree 或使用更强隔离。

已验证 sandbox 内不能新建跨边界 hardlink，symlink 写入和跨边界 rename 也被拒绝。预检仍存在 host 进程在“扫描后、spawn 前”制造 hardlink 的竞态；这在个人防误写威胁模型内接受，在敌对并发模型内不接受。

provider 状态目录和临时目录是明确的可写例外，不递归做 hardlink 保证；Claude 根级状态文件已单独拒绝 hardlink。若要把 provider 状态目录也纳入强保证，应改用独立文件系统或 microVM，而不是继续堆 SBPL 规则。

## 7. 原子 execution plan

当前“先生成 provider argv，再选择性 wrap”的接口容易产生危险的半状态。目标接口应一次返回最终可执行命令：

```ts
type SandboxEngine = "none" | "seatbelt-v1";
type SandboxPosture = "read-only" | "project-write";

interface ProviderExecutionPlan {
  argv: string[];                    // 已包含最终 wrapper
  sandboxEngine: SandboxEngine;
  sandboxPosture: SandboxPosture;
  profileSha256: string | null;
  providerNativeSandbox: boolean;
  env: Record<string, string>;
}

function buildProviderExecutionPlan(context: ExecutionContext): ProviderExecutionPlan;
```

构建顺序必须是：

```text
1. 从 config/spec 与 role 推导 engine/posture
2. 若请求 seatbelt-v1：验证 darwin、sandbox-exec、路径和 hardlink
3. 生成 scratch、环境和 profile
4. 以 externalSandbox=true 生成 provider-specific argv
5. 在同一函数内加上 sandbox-exec wrapper
6. 返回完整 plan；driver 只能 spawn plan.argv
```

`buildProviderArgv` 不得自行读取 `spec.sandbox`，也不能在外部独立调用后再“尽量 wrap”。dry-run 与真实 spawn 必须使用同一个 plan builder；前者只隐藏敏感值，不改变语义。

## 8. 配置、spec、幂等与可观测性

### 8.1 用户配置

用户入口保持简单：

```json
{
  "sandbox": true
}
```

`false` 或缺失表示沿用 provider 当前原生权限行为。v1 不增加 profile DSL、任意路径白名单或“自动兼容”开关。

### 8.2 run 快照

`spec.json` 不只保存模糊 boolean，而是快照策略语义：

```ts
interface RunSpec {
  sandbox_engine?: "seatbelt-v1"; // 缺失表示 none
}
```

posture 由不可变的 role 推导，避免两个字段互相矛盾。策略语义变化时把 engine 升为 `seatbelt-v2`，不能在同名 `v1` 下静默扩权。

`status.json` 和 dry-run 的 `provider_plan` 至少显示：

```json
{
  "sandbox_engine": "seatbelt-v1",
  "sandbox_posture": "project-write",
  "sandbox_profile_sha256": "...",
  "provider_native_sandbox": false
}
```

profile hash 用于诊断和审计，不进入幂等 key，因为 run-scoped scratch 绝对路径会让每次 hash 不同。

### 8.3 幂等兼容性

默认 idempotency fingerprint 必须包含 sandbox engine/version。显式 `--idempotency-key` 命中旧 run 时，也必须校验 engine 和 posture 完全一致；不一致则报错，用户通过 `--retry` 创建新 run。

这条规则至少保证 sandboxed 请求不会复用 unsandboxed 结果，也避免用户关闭 sandbox 后误以为任务重新按新语义执行。任何会改变 provider 执行行为的新字段，都应遵循同一 full-chain 规则：config → spec → dry-run → driver → fingerprint → status。

## 9. 生命周期与失败语义

### 9.1 创建阶段

- `orch run create` 尽早验证 `sandbox:true` 是否可在当前平台实现。
- host 创建 run dir、正式 artifact 和 scratch；provider 不参与这些所有权操作。
- supervisor 获取现有 MR/worktree 锁后再启动 driver。
- driver 构建完整 execution plan，记录 engine/posture/profile hash 后 spawn。

### 9.2 运行阶段

- provider 及其所有后代继承外层 Seatbelt。
- provider stdout 仍由 driver 写入 `native.jsonl`；provider 无权直接改写它。
- timeout/cancel 继续按现有 process-group 语义终止整个 worker tree。
- resume 必须重新构建并应用本次 run 的 execution plan，不能因为 session 已存在而跳过 sandbox。

### 9.3 失败关闭

以下情况必须在未隔离 provider 执行前失败：

- `sandbox:true` 运行在非 Darwin 平台；
- `/usr/bin/sandbox-exec` 不存在或不可执行；
- 路径无法 canonicalize，或包含无法安全编码的字符；
- provider state 未初始化；
- worktree hardlink 预检失败；
- profile 编译/应用失败；
- 外层 Seatbelt 返回典型 `sandbox_apply` 错误，包括 exit code 71。

禁止把这些情况实现成 warning 后继续运行。错误应包含 engine、provider、role 和具体失败阶段，但不能输出 token 或完整 provider 配置。

## 10. 已验证的行为

下表是本方案形成前的真实 macOS probe，不是仅比较 argv 的单元测试：

| Probe | 结果 | 设计结论 |
|---|---|---|
| 外层 Seatbelt + `codex login status` | 成功 | host Codex 登录状态可直接复用 |
| 外层 Seatbelt + Codex 内层 sandbox | exit 71，`sandbox_apply: Operation not permitted` | 不嵌套，使用 external-sandbox mode |
| Codex fresh 模型调用 | 返回 `FRESH_OK` | 外层模式能完成真实推理 |
| Codex 工具写 inside/outside | inside 成功，outside `touch` 被拒，外部文件不存在 | worktree 写边界真实生效 |
| Codex resume CLI 参数 | CLI 接受 bypass 组合 | 仍需补一次真实 resume 模型调用 |
| Codex resume 真实调用 | approval transport 断开，未完成 | 不能把 resume 标为已完全验收 |
| 外层 Seatbelt + Claude 内层 sandbox | Bash `/usr/bin/true` 触发 exit 71 | 必须关闭 Claude 内层 sandbox |
| Claude 内层关闭后的 Write/Bash | inside 成功，outside EPERM；host 复核外部文件不存在 | 外层可同时约束 built-in tool 与子进程 |
| Claude 状态 | `~/.claude.json` mtime 变化 | 根级状态文件必须是精确可写例外 |
| 预存 hardlink | 经 worktree 路径写入会修改外部 inode | v1 必须 hardlink 预检 |
| 新建跨边界 hardlink、symlink 写、rename | 均被拒绝 | 常见路径绕行由 Seatbelt 拦截 |
| linked worktree edit + `git status` | 成功 | Git common dir 无需默认可写 |
| linked worktree `git add` | `index.lock` 被拒 | 与“agent 不 commit”的 v1 contract 一致 |
| 外层 Seatbelt 中完整 `bun test` | 332 pass，2 fail | `.bun` 不是必需写根；需要真实集成测试 |
| 上述两个失败的复核 | nested Seatbelt smoke 符合预期；mail test 隔离运行 1 pass | 测试 harness 要识别已在 sandbox，mail 失败是套件时序噪声 |

当前 repo 的 regular-file 扫描没有发现 `nlink > 1`，但这只能说明当前 worktree 可以通过预检，不能删除通用 hardlink 防护。

## 11. 实现验收矩阵

### 11.1 必须跑真实进程

每个 provider 至少覆盖一次 fresh run；支持精确 resume 的 provider 还要覆盖 `resume_exact`。字符串/profile 快照测试只能补充，不能替代真实进程测试。

| 场景 | 必须观察到 |
|---|---|
| Claude Write/Edit/Bash | write role inside 成功、outside 失败 |
| Claude read-only role | inside 和 outside 写均失败，读取成功 |
| Codex fresh + tools | inside 成功、outside 失败、result 可提取 |
| Codex `resume_exact` | 恢复同一 session，仍受相同 posture 约束 |
| pi fresh/session | 登录与 session state 正常，inside/outside 符合 role |
| omp fresh/resume | fallback/session 正常，inside/outside 符合 role |
| controller | worktree 写失败，`orch` 派发和状态写成功 |
| verifier | 完整 `bun test` 可运行，localhost bind 等现有能力不被误伤 |

### 11.2 边界与失败测试

- 绝对路径、`..`、symlink、rename、删除和 chmod 越界全部失败；
- 预存 hardlink 让 run 在 provider 启动前失败；
- linked worktree 可 edit/status，不能 `git add` 或修改 common dir；
- `runDir` 正式 artifact 不能由 provider 改写，scratch 可以；
- 其他 provider 状态、`~/.config`、`~/.local/state` 和 broad Library 目录不可写；
- 非 Darwin、缺少 Seatbelt、非法 profile 都失败关闭；
- sandboxed/unsandboxed run 不能被默认或显式幂等 key 交叉复用；
- dry-run、status 和事件显示一致的 engine、posture 与 profile hash；
- sandbox 内运行现有 Seatbelt smoke 时，测试应检测嵌套环境并在外层执行该 case，不能把预期 exit 71 当产品失败。

### 11.3 完成门槛

实现只有在以下证据同时存在时才算完成：

1. 目标单元测试通过；
2. 四个 provider 的真实 smoke 通过，或明确标记未安装/未授权而阻止默认启用；
3. fresh 与 resume 的适用路径均有真实证据；
4. 完整 `bun test` 通过；
5. compiled binary 与 source mode 都通过同一 sandbox smoke；
6. `git diff --check` 通过；
7. README/help 与实际 dry-run 输出一致。

## 12. 当前实现与目标设计的差距

> 2026-07-14：以下差距已在 `seatbelt-v1` 实现中全部消除；本节保留为实现动机记录。

现有试验实现不能作为最终 contract，主要差距是：

- 只对 pi/omp 增加外层 Seatbelt，Codex/Claude 仍依赖各自边界；
- `buildProviderArgv` 与 `wrapWithSandbox` 分离，不能保证 bypass 和 wrapper 原子绑定；
- 整个 run dir、`~/.config`、`~/.local/state`、`Library/Application Support`、`Library/Preferences`、整个 `/dev` 和 `/private/var/folders` 都过宽；
- 缺少 `~/.omp`、Claude 根级状态文件等实际需要的精确路径；
- 非 Darwin 上把 `sandbox:true` 当 no-op，而不是失败关闭；
- Codex `last_message.txt` 写在正式 run dir；
- 缺少 hardlink 预检、策略版本、幂等兼容检查和 effective posture 状态。

实现时应替换这些行为，不在旧 profile 上继续追加白名单。

## 13. 实施顺序

1. **状态 contract**：加入 `sandbox_engine`，补齐 dry-run/status/idempotency compatibility。
2. **路径与 scratch**：canonicalize、run-scoped cache、精确 provider state、Git deny、hardlink preflight。
3. **原子 plan**：以 `buildProviderExecutionPlan` 取代分离的 argv/wrapper 决策，接入四个 provider。
4. **真实验收**：逐 provider 跑 fresh/resume/inside/outside/role matrix，再跑完整套件和 compiled smoke。
5. **文档与启用**：README/help 更新后保持 opt-in；积累日常运行证据后再单独决定是否 default-on。

每一步都应保持 `sandbox:false` 的现有 provider 行为，避免 sandbox 重构同时改变未启用用户的权限模型。

## 14. 将来何时升级到 microVM

以下任一需求出现时，Seatbelt 已不是合适工具：

- 仓库或 agent 被视为主动攻击者；
- 需要阻止读取 host secret；
- 需要限制网络出口或远端副作用；
- 需要隐藏其他进程、端口和设备；
- 不能接受 provider 直接修改 host session state；
- 项目必须保留跨边界 hardlink；
- 需要 Linux/macOS 一致且可证明的隔离 contract。

届时应使用一次性 microVM/容器工作区、单独的可撤销凭据和显式 artifact 回传。`docs/sandbox-matchlock-flow.html` 可作为该方向的流程草案，但不应为了当前“个人多 agent 防误写”目标提前引入 broker、token 搬运和镜像生命周期复杂度。

## 15. 最终取舍

`seatbelt-v1` 选择的是可用性与误操作保护之间的窄解：保留本机 OAuth、工具链、读取和网络能力，只把本地写权限压缩到当前项目及少数必要状态。统一外层 Seatbelt 比让四个 provider 各自解释“只读/可写”更容易审计；关闭内层 sandbox 是已验证的嵌套限制，不是放弃保护。

本方案不追求“看起来最严格”，而追求一条能被真实 provider、真实工具调用、linked worktree、resume 和完整测试反复证实的边界。任何新增可写路径都必须用失败用例证明必要性，并通过新 policy version 公开其语义变化。
