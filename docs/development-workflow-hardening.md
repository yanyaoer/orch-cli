# 工作流证据与并发加固

任务记录由主控保存在项目的 issue 系统，代码变更与固定版本评审保存在本仓库 PR。

基线：`9744a8faf813a5b1d6ebe6b8ecfc0d9cf1dd76e6`（0.0.13）。Claude 实现，主控执行完整测试、构建和 CLI smoke，Codex 对固定 HEAD 做独立评审；PR 中记录最终 SHA、运行证据、未执行项和评审结论。

## 验收目标

- 历史 run 有明确替代关系；已解决的旧阻塞不污染当前结果，独立的未解决阻塞继续生效。
- 候选 HEAD、幂等复用和评审/验证证据绑定；缺失证据和版本漂移不能自动接受。
- 验证区分通过、失败、预期非零和未运行，禁止矛盾的成功结果；JSON 校验不冒充实际执行证明。
- 同一 checkout 的读角色可并行，写角色与读写角色互斥；路径别名、跨进程竞争和 stale 恢复都有测试。
- 终止事件消费与 accept/rework 分离；指定 run 用阻塞等待，多任务用游标，不新增 HTTP webhook/daemon。
- 先完成全部修订并固定版本，再在独立 checkout 并行进行必要验证和只读评审；返工检查增量与旧问题回归。

## 调度边界

GitLab 新 Issue 发现、main 增量审查属于任务入口。已有 Claude 的 Issue 接单任务与 Codex 的 main 审查建 Issue 任务继续保留。本次只改进已启动 orch worker 的等待，不调整外部定时任务，不引入 webhook，不自动合并或发布 release。

实现后在本文件补充实际 CLI、兼容性边界与故障处理；最终测试/评审证据放在 PR/GitLab，避免为填入被评审 commit SHA 而再次改动该 SHA。

## 实现说明（本变更，未发布）

### 裁决：只用仍然有效的证据

- `orch verdict`、裸 `orch` 概览、`orch wait`、`orch decision accept|sweep`、`orch cross-review --auto` 共用 `src/overview.ts` 的 `assessRun`/`assessThread`，不再各自重述规则。
- 替代关系必须显式记录在 `spec.supersedes`：`orch run create --supersedes <id[,id]>`（只能替代同一 MR 内同角色的 run）、同角色的 `--resume-from`、以及 `--retry` 替换同一幂等键的旧 run。替代 run 状态为 `done` 后，旧 run 才退出汇总；`verdict` 输出 `superseded_by`/`supersedes` 与每个 run 的判定理由。
- 两个独立 reviewer 之间不存在隐式替代：较晚的 approve 不会覆盖另一个 reviewer 未解决的 blocker。`decision` 不改变汇总：`close` 保持原有的纯 ack 契约，只停止提醒，不会消除 blocker、也不让失败 run 退出汇总；旧证据只能由明确且已成功（done）的 supersedes 关系处理。消费通知用 `wait --cursor`，与解决 blocker 分开。
- fail closed：`failed`/`timeout`/`cancelled`/`stale`、无 result、结果校验失败（含语义矛盾，旧版本写下的结果也会在读取时重新校验）一律 `inspect`；`sweep` 不会自动关闭 reviewer/verifier 的失败或未绑定结果，而是列入 `manual`。

### HEAD/内容绑定

- `run create` 由主控代码捕获快照 `spec.snapshot = {vcs, head, dirty, content_sha}`；git 下 dirty 时 `content_sha` 覆盖未提交 diff 与未跟踪文件内容，jj 下以 `@` 的 commit（空 `@` 取其父）绑定。查询失败直接报错，不当作“未变化”。
- 默认幂等键加入实际 HEAD（reviewer/verifier 在 dirty checkout 上再加内容哈希）；显式 `--idempotency-key` 复用时也比较快照，不兼容或旧记录（无快照）一律拒绝，需 `--retry`。
- `--head <rev>` 固定 commit：checkout 必须正处于该 commit，reviewer/verifier 还要求 checkout 干净。它只作用于本地 checkout，不读取也不绑定远端 MR/PR；主控在固定前、接受前都需回读远端 MR source SHA 并与之比对。
- reviewer/verifier 的 supervisor 在拿到锁之后、启动 worker 之前比对快照（与 create 时及固定 head），worker 退出后再比对一次；任何漂移（包括 orch 之外的编辑）使 run 失败并记录 `snapshot_error`。`status.json` 保存 `start_snapshot`/`end_snapshot`。
- `decision accept` 与 `verdict` 以“当前候选”裁决：默认是 `--worktree` 当前快照，或 `--head <rev>`（要求证据快照干净且 head 相同）。旧记录可以查看，但没有主控捕获快照的证据永远不是当前 head 的证明。
- 工作流不变：implementer 不提交、只留 diff，主控提交后对固定 HEAD 发起评审/验证；只读 agent 不需要也不应改 Git。

### 验证结果语义

- `tests[]`/`commands[]` 每项有 `status: passed|failed|skipped`；`skipped` 必须 `exit_code: null`，未运行不能写成 0；负向测试用 `expected_exit_code` 表达预期非零退出，`passed` 即 `exit_code == expected_exit_code`。无 `status` 的旧条目按 `exit_code == expected_exit_code(默认 0)` 推导。
- `pass`/`completed` 不能同时含失败检查或 `unmet` 验收；verifier `pass` 还必须至少有一条实际运行并通过的命令，且只有显式标记 `"optional": true` 的命令/验收项可以 `skipped`（全部 skipped 的 pass 被拒绝）；implementer 的 `completed` 表示“编辑完成，可留待主控/verifier 验证”，允许 skipped，不与 verifier 的 pass 混同；验收状态为 `met|unmet|skipped`（常见同义词会映射，无法识别的值在成功结论下被拒绝）。
- implementer 提示词不再无条件禁止必要的较大范围测试：先完成编辑，再跑本次改动需要的检查以及任务明确要求的套件；不能运行的必要检查报告为 `skipped`。
- 这些校验只保证 JSON 自洽，不证明命令真的执行过；原始日志（`native.jsonl`、`stdout.log`）保留，主控仍须独立运行关键验证。orch 不伪造 host-attested 证据。

### worktree 读写锁

- 锁按规范化路径（git/jj 根的 realpath）计算，symlink 与子目录指向同一 checkout 时共用同一把锁。
- `implementer`/`verifier` 是写者（verifier 会产生构建产物），与任何读写者互斥；`reviewer` 为共享读者，可多个并行；`controller`/`researcher` 不加锁，避免长期运行的 controller 阻塞它自己派生的 worker。冲突时 run 以退出码 75 失败。
- 实现：每个持有者在 `<lock>.owners/` 下发布自己唯一命名的记录（临时文件 + rename 到唯一名），然后列出其他记录判断冲突；“先登记后检查”保证任意两个重叠的竞争者中后检查的一方一定看到先登记的一方，不会同时进入（可能双方都退让，短临界区锁带随机抖动重试）。死进程的记录按唯一文件名忽略并删除，删除它不可能影响活的持有者；释放只删自己的唯一文件。不再存在“rename/删除共享路径来打破陈旧锁”的步骤——首轮实现的这一步在确定性交错下可让两个 owner 同时持锁（已由主控复现），现已移除。mr/outbox/mail 等锁同样使用此机制。
- 兼容边界（旧版未加固实现，≤0.0.13 的单一 pidfile）：活的旧 pidfile 会阻止新持有者；新的独占持有者也会原子创建该 pidfile，使旧写者退让。但陈旧的旧 pidfile 只被忽略、不会被删除（删除正是要避免的抢锁窗口），此时旧写者仍会用其旧的竞态逻辑打破它，不能宣称与旧版本混用安全；旧写者不检查新读者，旧 reviewer 不加锁；pid 复用只会让死记录看似存活从而阻塞，不会放入第二个 owner。锁不能阻止非 orch 的外部编辑——由快照校验发现漂移。
- 需要评审与写入/构建并行时，使用固定 commit 的另一个 checkout。

### supervisor 与 provider 生命周期

- `status.pid`/`pgid` 仍指 provider（driver）进程组，cancel/timeout 作用于它；新增 `status.supervisor_pid` 记录 supervisor。provider 退出后 supervisor 仍会收集证据、校验快照、写入结果，这段 finalization 期间 run 不再被判为 stale。
- `looksStale` 优先看 `supervisor_pid`；旧状态文件没有该字段时沿用 provider pid 规则。`result --wait`、概览、`wait`、`events tail -f`、`run reap` 全部经由它。真正的 supervisor 死亡仍会被发现。

### 等待与裁决分离

- `orch result --run <id> --wait`：定向等待单个 run。
- `orch wait --thread <id> --cursor start|now|<cursor>`：wait-any 通知。每个终止或 stale run 在同一 cursor 链上只返回一次，与是否已裁决无关；事件带下一个 cursor；全部已终止且已消费时返回 `settled`；超时报错且 cursor 不变；无效或属于其他 thread 的 cursor 报错。cursor 是无状态的编码（已消费 run id 集合），不写状态文件。
- 不带 `--cursor` 时保持旧行为：decision 即 ack。
- 两者都是本地状态 2 秒轮询，不新增 daemon/webhook。GitLab 新 Issue 发现、main 增量审查属于任务入口（已有定时任务），与本地 run 等待无关。

### 主控验证与评审分工

1. Claude 在隔离 worktree 实现并做定向测试，不提交。
2. 主控提交并固定 HEAD，运行完整测试、构建、文档检查与 CLI smoke，保留原始日志。
3. 固定版本后，在独立 checkout 上用 `--head <sha>` 并行发起只读评审（Codex）与必要验证；返工时用 `--supersedes` 或同角色 `--resume-from` 声明替代关系，评审检查增量与旧问题回归。
4. `orch verdict --head <sha>` 与 `orch decision accept --head <sha>` 只接受绑定该 commit 的证据。

### 故障处理

- `snapshot_error`：checkout 在 create→start 或运行中发生变化；确认变化来源后对新快照重新发起（`--retry` 或新 run 并 `--supersedes`）。
- `refusing to accept ...`：证据与候选不符、结果矛盾或 run 失败；按提示针对当前候选重跑评审/验证（用 `--supersedes` 声明替代），或记录 `rework`；`close` 只是 ack，不会解除阻塞。
- 退出码 75：worktree 锁冲突；等待持有者结束，或改用独立 checkout。
- `idempotent run already exists for a different worktree snapshot`：同一键对应旧快照；用 `--retry` 新建。
