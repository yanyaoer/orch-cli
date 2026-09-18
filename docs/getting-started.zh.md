# 上手指南：用你自己的 agent、模型和 provider

orch 把你本机已有的编码 agent CLI（`codex`、`claude`、`pi`、`omp`）跑成可监督、
可审计的本地任务。它自己从不调用模型 API：只是以无头方式拉起 CLI，附上按角色
定制的提示词和权限姿态，把所有过程记录到 `${XDG_STATE_HOME:-~/.local/state}/orch`，
并校验 worker 返回的 JSON 结果。

这一页写给第一次使用、想让 orch 驱动*自己那套* agent + 模型组合的人，包括走自定义
provider（网关、自建 OpenAI 兼容端点、公司代理）的模型。完整命令参考在 README；
flag 以 `orch <cmd> --help` 为准。

## 1. 你需要什么

| 需要什么 | 说明 |
|---|---|
| orch | `curl -fsSL https://raw.githubusercontent.com/yanyaoer/orch-cli/main/install.sh \| sh` |
| 至少一个已登录的 worker CLI | `codex`、`claude`、`pi`、`omp`（任意子集）。每个都先交互式跑一次，让它自己的登录态和状态目录存在。 |
| 一个 git（或 jj）检出 | orch 在 worktree 上跑 worker，并从远端地址推导状态命名空间。 |
| 可选 | `gh` 或 `glab`，用于把决策镜像到 PR/MR。 |

orch 不管理 API key。每个 CLI 保留自己的登录，orch 把你的环境变量原样传给
worker（只剥掉会让嵌套 agent 挂回父工具会话的那几个变量）。

### 第一天就值得装的配套工具

这些都不是跑 worker 的必需品，但每一个都对应一条你第一周内就会用到的命令：

| 工具 | 解锁什么 | 安装（macOS） |
|---|---|---|
| `jq` | 本页所有 `--json` 示例 | `brew install jq` |
| `gh` | GitHub PR 上的 `orch mirror sync --execute` 和 `cross-review --auto` | `brew install gh && gh auth login` |
| `glab` | GitLab MR 上的同款 | `brew install glab && glab auth login` |
| `jina`、`tvly` | claude researcher 的联网调研（它的工具白名单点名了这两个 CLI） | `uv tool install jina-cli tavily-cli` |
| `mbsync`（isync）、`msmtp` | 基于本地 Maildir 的 `orch mailctl`：一个拉取器、一个投递器，不会像长连接 IMAP socket 那样挂死 | `brew install isync msmtp` |
| `pass` 或任意密钥 CLI | `password_cmd` / `!command` 字段，密钥不落在配置文件里 | `brew install pass` |
| `jj` | 可选的 Jujutsu 工作流；orch 原生驱动 colocated 的 `.jj` 检出 | `brew install jj` |
| `wrangler` | `orch chatgpt-bridge`（Cloudflare Worker MCP 桥） | `npm i -g wrangler` |

Linux：同名包走发行版仓库或 `npm`/`uv`；orch 里唯一只在 macOS 可用的部分是可选的
Seatbelt 沙箱。

## 2. 十分钟跑通第一次

```sh
# 1. register the repo you will work in
$ cd ~/src/my-repo
$ orch workspace add --id my-repo --path .

# 2. tell orch which agent handles which role (see section 3)
$ mkdir -p ~/.config/orch && $EDITOR ~/.config/orch/config.json

# 3. seed the roster used by cross-review / investigate / fanout (once)
$ orch mail agent defaults

# 4. see exactly what would be spawned, without spawning it
$ printf 'Role: reviewer\nGoal: review this branch for blocking issues.\n' > review.md
$ orch run create --role reviewer --task review.md --dry-run --json | jq '.provider_plan.argv'

# 5. run it for real and wait for the schema-validated result
$ orch run create --role reviewer --task review.md --json | jq -r .run_id
$ orch result --run <run_id> --wait
```

配置阶段最有用的一条命令就是 `--dry-run`：它打印解析出的 agent、模型、沙箱姿态和
完整的 provider argv，写错的模型 ref 在花任何 token 之前就会暴露。注意 `--task`
相对于你 shell 的当前目录解析，不是相对于 `--worktree`。

## 3. 按角色选 agent 和模型

### 角色

| 角色 | 是否写 worktree | 允许的 agent | 典型用途 |
|---|---|---|---|
| `implementer` | 是（持有 worktree 锁） | codex、claude、pi、omp | 落地一个改动；返工用 `--resume-from` |
| `reviewer` | 否 | codex、claude、pi、omp | 给出 approve / request_changes 和 findings |
| `verifier` | 是（要跑测试） | codex、claude、pi、omp | 按验收条件给 pass / fail |
| `researcher` | 否，可联网 | codex、claude、omp（不含 pi） | 给建议，从不写代码 |
| `controller` | 否，可调用 `orch` | 仅 claude | `orch new` 和 `orch mailctl` 驱动它 |

### 配置文件

默认值放在 `~/.config/orch/config.json` 的 `defaults` 下，分三节：

- `agents.<role>`：哪个 agent 负责哪个角色。裸字符串是 `{ "agent": ... }` 的简写；
  对象形式可以再带 `model` 和 `timeout_sec`。
- `models.<agent>`：某个 agent 的默认模型，用该 CLI 自己的 ref 格式。正是这一行让
  自定义 provider 成为该 agent 所有角色（包括 fan-out 派发的 run）的默认。
- `fanout`：`cross-review` 和 `investigate` 派发给 roster 里的哪些 agent（见第 5 节）。

```json
{
  "version": 1,
  "workspaces": {},
  "defaults": {
    "agents": {
      "implementer": "pi",
      "verifier":    { "agent": "pi", "model": "myprov/coder-small", "timeout_sec": 1800 },
      "reviewer":    { "agent": "claude", "model": "opus" },
      "researcher":  "claude"
    },
    "models": {
      "pi":     "myprov/coder-large",
      "claude": "claude-sonnet-5"
    },
    "fanout": {
      "cross-review": ["claude-reviewer", "pi-reviewer"]
    }
  }
}
```

每次 `orch run create` 的模型优先级，先命中者生效：

1. 命令行上的 `--model`。
2. `defaults.agents.<role>.model`，且仅当这次 run 的 agent 就是该条目的 agent。
   模型 ref 是按某一个 CLI 的格式写的，所以它绝不会跟着 `--agent` 覆盖跑到另一个 CLI 上。
3. `defaults.models.<agent>`。
4. 驱动内置的默认值（见下表）。

按上面的例子：`--role implementer` 用 pi 跑 `myprov/coder-large`，`--role verifier`
用 pi 跑 `myprov/coder-small`，`--role reviewer` 用 claude 跑 `opus`，
`--role reviewer --agent pi` 用 pi 跑 `myprov/coder-large`。`--resume-from <run_id>`
从前一个 run 继承 agent、模型和 worktree；只有 `timeout_sec` 仍取自配置。

这个文件每次读取都做形状校验。未知键（`default.agents`、`sandbox_wirte_dirs`）、
用作键名的未知 role 或 agent、无法识别的 `language`/`sandbox` 值，每个进程打印一次告警：

```
[orch] config.json: unknown key sandbox_wirte_dirs is ignored (known: version, workspaces, defaults, language, sandbox, sandbox_write_dirs)
```

已知键放了错误类型的值（非字符串的 model、负数 timeout、作为值的未知 agent 名）
会让命令直接失败，并指出出错的路径。

### 什么都不配时的内置默认

这些是作者自己的 provider，新机器上不会存在。如果你用别的 provider 跑 pi 或 omp，
一行 `defaults.models.pi` 或 `defaults.models.omp` 就能替换所有角色的默认。

| Agent | 无 `--model` 时的模型 | 推理强度 | 备注 |
|---|---|---|---|
| `pi` | `openai-codex/gpt-6-astra` | 始终 `--thinking high` | 无回退链 |
| `omp` | `openai-codex/gpt-6-astra` | 始终 `--thinking=high` | 配额回退 `google-antigravity/gemini-3.1-pro` 通过每次 run 的 overlay 下发；模型不在这条链里就不写 overlay，由 omp 自己 `~/.omp/agent/config.yml` 的 `retry.fallbackChains` 决定 |
| `codex` | `~/.codex/config.toml` 里设的那个 | 取 config.toml，researcher 强制 `high` + 联网搜索 | researcher 固定 `gpt-6-astra`，除非 `--model` |
| `claude` | CLI 自己的默认模型 | 按角色：implementer `medium`、verifier `low`、reviewer `high`、researcher `xhigh`、controller `medium` | reviewer 固定 `--model opus`，researcher 固定 `--model fable`；`--model` 覆盖两者 |

`--model` 的值原样透传，所以必须是所选 CLI 认的格式：

| Agent | 模型 ref 格式 | 示例 |
|---|---|---|
| `pi` | `<provider>/<model-id>`，按它 `models.json` 里的声明 | `myprov/coder-large` |
| `omp` | 同 pi，允许模糊匹配 | `myprov/reviewer-xl` |
| `codex` | 裸模型名；provider 来自 config.toml 的 `model_provider` | `gpt-5.5` |
| `claude` | 别名（`sonnet`、`opus`、`fable`）或完整模型 id | `claude-opus-5` |

## 4. 接入你自己的 provider

自定义 provider 配在各个 CLI 里，从不配在 orch 里。只要 CLI 能交互式地连上这个模型，
orch 就能用 `--model` 或 `defaults.agents.<role>.model` 派发给它。

**pi** 读 `~/.pi/agent/models.json`。每个 provider 一条；`api` 是线上协议
（`openai-responses`、`openai-completions`、`anthropic-messages`），`apiKey` 要么是
字面量密钥，要么是 `!<command>`，以命令的 stdout 作为密钥。

```json
{
  "providers": {
    "myprov": {
      "baseUrl": "https://llm.example.com/v1",
      "api": "openai-responses",
      "apiKey": "!pass show llm/myprov",
      "models": [
        { "id": "coder-large", "name": "Coder Large", "reasoning": true,
          "input": ["text"], "contextWindow": 200000, "maxTokens": 32000 }
      ]
    }
  }
}
```

用 `pi --list-models myprov` 检查，再用 `--model myprov/coder-large` 派发。
orch 总会追加 `--thinking high`，所以在把某个模型分配给 pi 或 omp 角色之前，先确认它
接受 thinking 等级。

**omp** 是 pi 的分支，在 `~/.omp/agent/` 下用同样的 `models.json` 布局。先交互式
跑一次 `omp --model myprov/reviewer-xl` 确认 ref。自定义 primary 不会得到 orch 的回退
overlay；想要配额回退，就在 `~/.omp/agent/config.yml` 里声明 `retry.fallbackChains.default`。

**codex** 在 `~/.codex/config.toml` 里声明 provider，并用顶层 `model_provider` 选择
其中一个。orch 只传 `--model`，从不传 `--profile`，所以 provider 的选择必须是全局默认：

```toml
model_provider = "myprov"
model = "coder-large"

[model_providers.myprov]
name = "my gateway"
base_url = "https://llm.example.com/v1"
env_key = "MYPROV_API_KEY"
wire_api = "responses"
```

**claude** 通过自己的环境变量走网关：`ANTHROPIC_BASE_URL` 加 `ANTHROPIC_AUTH_TOKEN`
（或 `ANTHROPIC_API_KEY`），在 shell 里导出，或写进 `~/.claude/settings.json` 的
`env` 块。orch 的角色层级对 reviewer 和 researcher 用的是别名 `opus` 和 `fable`；
如果你的网关不解析别名，把 `defaults.agents.reviewer.model` 和
`defaults.agents.researcher.model` 设成完整 id。

对每个 CLI 都成立的两条规则：

- 密钥只放在 CLI 自己的存储或你的环境变量里。`config.json` 只含 agent 名和模型 ref。
- 开了 `"sandbox": true`（macOS Seatbelt 写隔离，见 README）时，所选 CLI 的状态目录
  必须已经存在（`~/.pi`、`~/.omp`、`~/.codex`、`~/.claude`），否则 run 拒绝启动。

## 5. Fan-out 从 roster 里挑 agent

`orch cross-review`、`orch investigate` 和 `orch fanout` 从
`~/.config/orch/mail-agents.json` 的 mail roster 里挑 agent，roster 由
`orch mail agent defaults` 初始化：

| 命令 | 默认 agent | 角色 |
|---|---|---|
| `cross-review` | `claude-reviewer`、`omp-reviewer`，或 `defaults.fanout.cross-review` | reviewer |
| `investigate` | `omp-researcher`、`claude-researcher`，或 `defaults.fanout.investigate` | researcher |
| `fanout --role <r>` | roster 里该角色所有 `auto_invite` 的条目 | 任意 |

每个选中的 agent 都变成一条 `orch run create --role <r> --agent <provider>`，所以
第 3 节的模型优先级对每个 run 单独生效：agent 匹配的角色默认，否则
`defaults.models.<agent>`。两个 provider 上的两个 reviewer 就是这样各自拿到正确的模型，
不需要任何 flag。fan-out 上的 `--model` 会把同一个 ref 传给每个派出的 run，所以只在
所选 agent 共用同一个 provider 时使用：

```sh
$ orch cross-review --thread pr-123 --task review.md --to-agent claude-reviewer --model claude-opus-5
```

要让你自己的组合成为默认，先绑定一条 roster 记录，再写进 `defaults.fanout`；
不在 roster 里的 id 会让命令失败，而不是被悄悄丢掉：

```sh
$ orch mail agent bind --id pi-reviewer --address orch+pi.reviewer@local.orch \
    --provider pi --role reviewer --session-mode ephemeral --auto-invite
$ orch cross-review --thread pr-123 --task review.md --dry-run   # shows who would run
```

`orch new '<一句话>'` 只用 claude：规划阶段跑
`--role researcher --agent claude --model fable`，同一个会话再作为 controller 续跑。
`--model <ref>` 可以换模型；agent 换不了。

## 6. orch 的一天（作者用法，已脱敏）

四个月里约 600 条记录在案的 run，一个开发者，若干个仓库。token 都花在了哪里：

| 角色 | run 占比 | Agent，按使用频率 |
|---|---|---|
| reviewer | 65% | claude（opus 档）、omp、pi |
| implementer | 21% | pi、codex、claude |
| researcher | 7% | claude（fable 档）、codex |
| verifier | 4% | claude、codex、pi |
| controller | 3% | claude（fable） |

十条 run 里有七条是由 fan-out 或 controller 派发，而不是手动敲出来的，这就是为什么
日常使用里第 5 节的 roster 比 `defaults.agents` 更重要。产生这些 run 的几个循环：

```sh
$ orch                                              # morning: every pending action as a runnable line
$ orch new 'add rate limiting to the public API'    # plan (claude fable) -> confirm -> controller dispatches pi
$ orch cross-review --thread pr-123 --task review.md --clone
$ orch cross-review --thread pr-123 --task round2.md --clone --rework   # prior findings + diff range auto-appended
$ orch run create --resume-from <impl-run> --task rework.md              # same provider session, no re-exploration
$ orch fanout --thread pr-123 --role verifier --task verify.md
$ orch investigate --thread design-1 --task question.md                 # two read-only researchers, one recommendation
$ orch decision accept --run <run_id> --reason "reviewed"
$ orch mirror sync --mr 123 --execute
```

背后的配置画像：pi 负责实现（同模型试点里，解决率相同而缓存流量最省），claude 的
opus 档和 omp 作为两个模型家族评审同一份 diff，claude 的 fable 档负责规划和主控，
codex 留在 roster 里供显式 `--to-agent` 使用。显式 `--model` 大约十条 run 里出现一次，
其中大多数还是 `orch new` 自己钉的 fable；剩下的都由 roster 和角色层级承担。

## 7. 依赖它之前要知道的坑

- **内置的 pi/omp 模型 ref 是作者的 provider。** 什么都不配时，pi 和 omp 会去要
  `openai-codex/gpt-6-astra`。一行 `defaults.models.<agent>` 就能修；没有交互式引导。
- **thinking 等级是固定的。** pi 和 omp 永远拿到 `high`；claude 按角色给 effort。
  不接受 thinking 等级的模型目前还不能通过 pi/omp 使用。
- **claude 是唯一的 controller。** `orch new` 和 `orch mailctl` 用 claude 规划和编排；
  `--model` 换的是模型，不是 agent。
- **按 agent 配的 claude 模型会覆盖角色层级。** `defaults.models.claude` 对 reviewer 和
  researcher 同样生效；想保留升档，就在 `defaults.agents` 里按角色把 `opus`/`fable` 钉回去。
- **没有预检。** `orch doctor` 还在路线图上；今天缺 CLI 或写错模型 ref，表现为一条失败的
  run，provider 的 stderr 在 run 目录下的 `stderr.log` 里。`--dry-run` 会先把 argv 打出来。
