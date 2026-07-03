# audit3 — 深度设计/实现评审（claude-fable-5）

- 日期：2026-07-03
- 基线：`feat/agy-fanout-role-permissions` @ `1a0ebb3` + 未提交的 `--model` 改动（12 文件，+303/-25）
- 方法：3 路并行探索（核心编排层 / mail+fanout 层 / drivers+diff）→ 关键断言逐一人工验证 → 对照 `docs/orch-mvp-spec.md` 与 `docs/reviews/audit2-claude-review.json`
- 测试基线：`bun test` 83 pass / 0 fail
- 结论：**approve with findings**。架构与 spec 高度吻合（daemonless reconciler、文件状态、O_EXCL 锁、outbox、泄漏防护均落实）；问题集中在新 fanout 路径、agy 权限单点、audit2 遗留债、重复/死代码。

---

## P0 — 安全 / 正确性（已修复于本次批次 1）

### P0-1 agy 权限单点防御
`drivers/driver-common.ts:136`：`readOnly ? "--sandbox" : "--dangerously-skip-permissions"` —— agy 一旦以非 reviewer role 到达 driver 层即获得完全放权。唯一防线是 `src/orch.ts:462 validateRunAgent`，且该防线全套件零测试覆盖。
**修复**：driver 层加第二道防线（agy 非只读直接 throw，删除放权分支）+ 补 `validateRunAgent` 与 argv 构造测试。

### P0-2 mailFanout publish 阶段无锁
`src/mail-cli.ts:584-649` 无锁，而 `mail route` 有 `acquireRouteLock`（`:325-336`）。两个并发 `cross-review`/`fanout` 同 thread 同 task：都 `findTask→null`（事件尚在 outbox 未 import）→ 各自 publish 不同 `event_id` → 不同 run 幂等 key → 重复 run。
**修复**：thread 级 `fanout.lock` 包住 findTask→publish→deliver→import 段。

### P0-3 `--model` 在 fanout 路径静默丢失
`src/mail-cli.ts:472-493` claim 拼 `run create` argv 不透传 `--model`；`orch cross-review --model X` 被无声忽略。叠加 `src/cli.ts:parseArgs` 对未知 flag 全部静默接受，任何拼错的 flag 也无声吞掉。
**修复**：claim argv 透传 `--model`；`run create` + 三个 fanout 命令加 flag 白名单（见 P1-6）。

### P0-4 supervisor 裸读 spec.json
`src/supervisor.ts:152-153`：`JSON.parse(readFileSync(...))` 在 try 块之外。spec 损坏/缺失 → detached supervisor 静默死亡，status 永远停在 `created`，无失败终态、无日志。
**修复**：读取入 try；spec 不可用时以 fallback 写 failed 终态。

### P0-5 detectForge 子串匹配（audit2 NB1/NB2 遗留未修）
`src/forge.ts:38`：`host.includes("github.com")` —— `github.com.attacker.net` 判为 github；GHE（`github.mycorp.com`）判为 gitlab。
**修复**：`host === "github.com" || host.endsWith(".github.com")` + 表驱动测试锁定现状。

### P0-6 agy prompt 走 argv
`drivers/driver-common.ts:133`：`"--print=" + prompt` 把整段任务文本放进命令行。后果：① `ps` 全程可见（私有 repo 内容泄漏到进程列表）；② macOS ARG_MAX（≈1MB）大任务直接 E2BIG。已验证 `agy --help` 无 stdin/文件输入通道。
**修复**：超长 prompt（>512KB）干净报错；help/docs 标注 `ps` 可见性限制。

### P0-7 mr.lock 无等待抢锁使并发 run create 直接失败（新测试暴露，实施中发现）
`src/orch.ts:startRun` 的 `acquirePidfileLock(mr.lock)` 无重试等待；fan-out 场景下两个进程各 claim 一个 agent 的任务后并发 `run create` 同一 MR，慢者立刻 LockHeldError → run create exit 1 → claim 被 nack、整个 fan-out exit 1。mr.lock 只保护毫秒级的幂等 RMW+spawn 临界区。
**修复**：`locks.ts` 新增 `acquirePidfileLockWait`（有界等待，25ms 步进），mr.lock 等 10s；route/fanout 线程锁复用同一助手。由新增的并发 cross-review 测试锁定。

## P1 — 健壮性 / 一致性（已修复于本次批次 2）

- **P1-1** 幂等记录在 supervisor spawn 之后写（`src/orch.ts:702` vs `:724`），中间失败 → 孤儿 supervisor + 同 key 重复派发。修复：写失败时 kill 已 spawn 的 supervisor 再抛。
- **P1-2** `mailFanout` 丢弃 `bus.importRaw` 返回值（`src/mail-cli.ts:642`）：自签任务被 quarantine 时静默丢任务。修复：imported=false 报 CliError。
- **P1-3** 幂等命中不区分 failed（audit2 NB3/NB4 遗留，`src/orch.ts:651-666`）：failed run 被静默复用，锁竞争失败(75)烧掉幂等 key 且无提示。修复：命中 failed 时输出 `--retry` 提示。
- **P1-4** outbox 毒丸（audit2 NB7 遗留）：非法 pending payload 永不隔离 → `mirror sync` 永远 exit 1。修复：隔离到 `outbox/invalid/`。
- **P1-5** 错误类型不统一：`providerSessionConfig` / `readMirrorResult` / `validateRunAgent` 抛普通 `Error` → 用户看到 stack。修复：统一 CliError。
- **P1-6** 未知 flag 静默接受（`src/cli.ts:9-53`）。修复：`run create` + fanout 三命令加 allowed-flags 白名单。
- **P1-7（记录，不修）** lease 30min < 长 run（`src/bus.ts:82`）：租约过期可被重新 claim，但 run 层幂等 key `mail:<thread>:<event_id>:<agent>` 兜底，重复 claim 只会拿回既有 run。常量处已有注释即可。

## 测试缺口（批次 3 补齐关键项）

- `validateRunAgent` agy 限制零覆盖（最关键安全点）；`buildProviderArgv("agy", …)` 放权分支从未被执行。
- fanout 并发竞态、`--model` 透传、`fanout`/`investigate` 命令、`--to-agent` override 均无用例。
- supervisor 超时(124)/heartbeat/成功路径/spec 损坏无测试。
- forge adapter execute 路径、mirror sync 成功 rename 无测试。
- audit2 建议的 8 条测试大多仍未落地。

## P2 — 简化 / 清账（本次不做，后续批次）

1. 重复代码：`resultVerdict`/`resultSummary` 逐字节重复（`src/mail.ts:258-271` = `src/orch.ts:385-398`）；`gitHead` 双份语义分叉（`src/orch.ts:211` 抛错 vs `src/supervisor.ts:93` 吞错）；dry-run 分支重复构建 spec（`src/orch.ts:491-597` vs `:679-696`）；泄漏防护双套（`src/leak.ts:assertNoPrivateLeak` 生产零调用 vs `src/orch.ts:80 assertMirrorBodySafe`）。
2. 死代码：forge `getState`/`updateDescription`（`src/forge.ts:16-17,72-101`）；`MaildirBus.importAuto`（`src/bus.ts:145-147`）；write-only 的 `mail-claimed.json`（`src/bus.ts:229-232`）；`writeRoles` 不可达角色 challenger/rework/debugger（`types.ts:133` vs `orch.ts:477` 拒绝）；help 示例 run_id 带 Z（audit2 NB5）。
3. bus/mail 双命名收敛：`MaildirBus`/`OrchBus` 已退化为 mail.ts 透传壳，仅 claim 逻辑真实存在。
4. `native_event_count` 每次 `updateStatus` 全文件重算（`src/supervisor.ts:61`，O(n²)）。
5. 4 个 driver 文件纯样板（15 行 ×4，仅函数名与 provider 字符串不同）。
6. chatgpt-bridge：token 在 URL query（CF 日志泄露面）→ 移 Authorization header；`===` 比较 → `timingSafeEqual`；单全局 DO（单用户工具可接受，记录）。
7. D8 落差（audit2 NB9）：reviewer/verifier 评 live worktree 而非 immutable artifact。reviewer 已只读（role 权限落地），风险降级为"移动靶"；彻底修复需按 base_sha 建临时 worktree，defer。
8. `orch.ts:main` 长 if-else 命令派发（1266 行单文件）→ 命令表；`orchCommand()` 依赖 `process.argv[1]` 后缀判断运行形态（`orch.ts:365`）。
9. fanout 幂等口径不一致：`findTask` 只扫已导入日志（`src/bus.ts:164-177`），route 的 `routedRouteKeys` 同时扫 outbox（`src/mail-cli.ts:307-323`）——加锁后实害消除，口径统一留作清账。

## cross-review 复核（2026-07-03，thread audit3-fixes）

对本次全部未提交改动跑了 `orch cross-review`（吃自己的狗粮）：
- **claude（opus/high，run re-review-claude-20260703T071459-540942）：approve**，3 条非阻塞——NB-1 mirror sync 的毒丸隔离在 dry-run 下也会移动文件（违反 dry-run 只读契约，已修：execute 门控）；NB-2 幂等补偿 kill 打不到 detached driver 组（亚毫秒窗口，已按建议注释接受）；NB-3 fanout 白名单误拒此前容忍的 `--json`（已修：加回白名单）。
- **agy：本机 print 模式当前静默失效**（任何 prompt 均 exit 0 零输出，与 orch 无关，疑似需重新登录），其 run 落 fallback。
- **过程中抓到的第 8 个 P0 级问题**：bun 会把沿 cwd 向上的 `node_modules/.bin`（含 `~/node_modules/.bin` 里误装的 claude 1.0.53）前置进子进程 PATH，导致 worker 的 claude 被旧版本劫持（`unknown option '--effort'`）。已修：`buildWorkerEnv` 剥离 PATH 中的 `node_modules/.bin` 段（含测试）。
- **P2 补记**：reviewer 结果提取对 schema 偏差零容忍（claude 把 suggested_tests 写成对象数组即整体落 fallback）——考虑加宽松归一化（对象→字符串 coercion）。

## 使用日志盘点与接口优化（2026-07-03，第二批）

基于 72 个真实 run（2026-06-19 起，3 仓库）的盘点：reviewer 占 81%、result 提取失败率 67%（48/72，其中 40 个有真实产出被丢弃）、mirror --execute 零使用、52/67 手动覆盖 timeout、1 个 pid 死亡 21h 的僵尸 running。据此落地：

- **A 提取宽松化**：coercion（verdict 同义词/对象↔字符串数组项/模型自造 run_id 以 spec 为准）；提取失败时保留 `result.raw.md` + fallback 摘录。历史 49 个 fallback 回放：5 个完整救回、36 个内容变为可达、8 个（agy 静默）转为诚实失败。
- **B 空产出判 failed**：exit 0 + 零输出 → failed 带 auth/session 提示。
- **E reviewer/verifier 渲染**：`orch result` 展开 findings / commands+acceptance（此前只展开 implementer）。
- **C stale**：status/run list 读侧标记 `stale?`（A7 只读）；新增 `orch run reap` 落盘 stale 终态；OrchEvent 增加 stale 类型。
- **D `result --wait/--wait-sec`**：阻塞到终态，省去主控轮询循环；stale 快速失败并提示 reap。
- **F**：reviewer 默认 timeout 3600s；未知命令显式报错；flagString 抛 CliError（全局去 stack）。

## 值得肯定的实现

- posix 两命脉点（detached 进程组 kill、O_EXCL pidfile 锁 + stale 回收 + EPERM/ESRCH 区分）按 spec D7 落实且有 `posix.test.ts` 锁定。
- 幂等/会话指纹、`--retry` 保留 previous[]、脏 worktree warn、outbox 先落盘后发送、镜像泄漏防护、mail 事件 ed25519 签名 + quarantine、路径穿越清洗（`paths.ts`/`mail.ts`）均已实现并大多有测试。
- e2e 测试基建（`observability.test.ts` spawn 真实 CLI + `ORCH_DRIVER_FAKE_RESULT` 假驱动）质量高，扩展成本低。
