# Getting started: your own agents, models, and providers

orch runs the coding-agent CLIs you already have (`codex`, `claude`, `pi`, `omp`)
as supervised, auditable local jobs. It never talks to a model API itself: it
spawns the CLI headless with a role-specific prompt and permission posture,
records everything under `${XDG_STATE_HOME:-~/.local/state}/orch`, and
validates the JSON result the worker returns.

This page is for a first-time user who wants orch to drive *their* agent + model
combination, including models served by a custom provider (a gateway, a
self-hosted OpenAI-compatible endpoint, a corporate proxy). The README has the
full command reference; `orch <cmd> --help` is authoritative for flags.

## 1. What you need

| You need | Notes |
|---|---|
| orch | `curl -fsSL https://raw.githubusercontent.com/yanyaoer/orch-cli/main/install.sh \| sh` |
| At least one worker CLI, logged in | `codex`, `claude`, `pi`, `omp` (any subset). Run each one interactively once so its own auth and state directory exist. |
| A git (or jj) checkout | orch runs workers against a worktree and derives its state namespace from the remote. |
| Optional | `gh` or `glab` to mirror decisions to a PR/MR. |

orch does not manage API keys. Each CLI keeps its own login, and orch passes
your environment through to the worker (it only strips variables that would
make a nested agent attach to a parent tool session).

### Companions worth installing on day one

None of these are required to run a worker, but each unlocks a command you
will reach for within the first week:

| Tool | Unlocks | Install (macOS) |
|---|---|---|
| `jq` | every `--json` example on this page | `brew install jq` |
| `gh` | `orch mirror sync --execute` and `cross-review --auto` on GitHub PRs | `brew install gh && gh auth login` |
| `glab` | the same on GitLab MRs | `brew install glab && glab auth login` |
| `jina`, `tvly` | web research for the claude researcher (its tool whitelist names these two CLIs) | `uv tool install jina-cli tavily-cli` |
| `mbsync` (isync), `msmtp` | `orch mailctl` over a local Maildir: a fetcher and a submitter that cannot hang the way a long-lived IMAP socket can | `brew install isync msmtp` |
| `pass` or any secret CLI | `password_cmd` / `!command` fields, so no secret sits in a config file | `brew install pass` |
| `jj` | optional Jujutsu workflow; orch drives a colocated `.jj` checkout natively | `brew install jj` |
| `wrangler` | `orch chatgpt-bridge` (Cloudflare Worker MCP bridge) | `npm i -g wrangler` |

Linux: same package names via your distribution or `npm`/`uv`; the macOS-only
piece of orch is the optional Seatbelt sandbox.

## 2. First run in ten minutes

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

`--dry-run` is the single most useful command while you set things up: it
prints the resolved agent, model, sandbox posture, and the full provider argv,
so a wrong model ref shows up before any tokens are spent. Note that `--task`
resolves relative to your shell's current directory, not `--worktree`.

## 3. Pick an agent and model per role

### Roles

| Role | Writes the worktree | Agents allowed | Typical use |
|---|---|---|---|
| `implementer` | yes (takes the worktree lock) | codex, claude, pi, omp | land a change; rework via `--resume-from` |
| `reviewer` | no | codex, claude, pi, omp | approve / request_changes with findings |
| `verifier` | yes (must run tests) | codex, claude, pi, omp | pass / fail against acceptance checks |
| `researcher` | no, web allowed | codex, claude, omp (not pi) | recommendation, never code |
| `controller` | no, may call `orch` | claude only | `orch new` and `orch mailctl` drive this |

### The config

Defaults live in `~/.config/orch/config.json` under `defaults`, in three
sections:

- `agents.<role>`: which agent handles a role. A bare string is shorthand for
  `{ "agent": ... }`; the object form adds a `model` and a `timeout_sec`.
- `models.<agent>`: the default model for an agent, in that CLI's own ref
  format. This is the line that makes a custom provider the default for every
  role you give that agent, including fan-out runs.
- `fanout`: which roster agents `cross-review` and `investigate` dispatch to
  (section 5).

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

Model precedence for every `orch run create`, first match wins:

1. `--model` on the command line.
2. `defaults.agents.<role>.model`, only when the run's agent is that entry's
   agent. A model ref is written in one CLI's format, so it never follows a
   `--agent` override to another CLI.
3. `defaults.models.<agent>`.
4. The driver's built-in default (table below).

With the example above, `--role implementer` runs pi on `myprov/coder-large`,
`--role verifier` runs pi on `myprov/coder-small`, `--role reviewer` runs
claude on `opus`, and `--role reviewer --agent pi` runs pi on
`myprov/coder-large`. `--resume-from <run_id>` inherits agent, model, and
worktree from the prior run; only `timeout_sec` still comes from the config.

The file is shape-checked on every read. An unknown key (`default.agents`,
`sandbox_wirte_dirs`), an unknown role or agent used as a key, or an
unrecognized `language`/`sandbox` value prints one warning per process:

```
[orch] config.json: unknown key sandbox_wirte_dirs is ignored (known: version, workspaces, defaults, language, sandbox, sandbox_write_dirs)
```

A known key holding the wrong type (a non-string model, a negative timeout, an
unknown agent name as a value) fails the command with the offending path.

### Built-in defaults when you set nothing

These are the author's own providers and will not exist on a fresh machine.
If you use pi or omp with a different provider, one `defaults.models.pi` or
`defaults.models.omp` line replaces them for every role.

| Agent | Model when no `--model` | Reasoning | Notes |
|---|---|---|---|
| `pi` | `openai-codex/gpt-6-astra` | `--thinking high`, always | no fallback chain |
| `omp` | `openai-codex/gpt-6-astra` | `--thinking=high`, always | the quota fallback `google-antigravity/gemini-3.1-pro` rides a per-run overlay; a model outside that chain gets no overlay, so omp's own `retry.fallbackChains` in `~/.omp/agent/config.yml` governs |
| `codex` | whatever `~/.codex/config.toml` sets | config.toml, except researcher forces `high` + web search | researcher pins `gpt-6-astra` unless `--model` |
| `claude` | the CLI's default model | per role: implementer `medium`, verifier `low`, reviewer `high`, researcher `xhigh`, controller `medium` | reviewer pins `--model opus`, researcher `--model fable`; `--model` overrides both |

A `--model` value is passed through verbatim, so it must be in the format the
selected CLI expects:

| Agent | Model ref format | Example |
|---|---|---|
| `pi` | `<provider>/<model-id>` as declared in its `models.json` | `myprov/coder-large` |
| `omp` | same as pi, fuzzy match allowed | `myprov/reviewer-xl` |
| `codex` | bare model name; the provider comes from `model_provider` in config.toml | `gpt-5.5` |
| `claude` | alias (`sonnet`, `opus`, `fable`) or full model id | `claude-opus-5` |

## 4. Bring your own provider

Custom providers are configured in each CLI, never in orch. Once the CLI can
reach the model interactively, orch can dispatch to it with `--model` or a
`defaults.agents.<role>.model`.

**pi** reads `~/.pi/agent/models.json`. One entry per provider; `api` is the
wire protocol (`openai-responses`, `openai-completions`, `anthropic-messages`),
and `apiKey` is either the literal key or `!<command>` whose stdout is the key.

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

Check with `pi --list-models myprov`, then dispatch with `--model myprov/coder-large`.
orch always appends `--thinking high`, so confirm the model accepts a thinking
level before giving it a pi or omp role.

**omp** is a pi fork and uses the same `models.json` layout under
`~/.omp/agent/`. Confirm the ref once interactively with `omp --model myprov/reviewer-xl`.
A custom primary gets no orch fallback overlay; if you want quota fallbacks,
declare `retry.fallbackChains.default` in `~/.omp/agent/config.yml`.

**codex** declares providers in `~/.codex/config.toml` and selects one with the
top-level `model_provider` key. orch passes `--model` only, never `--profile`,
so the provider selection must be the global default:

```toml
model_provider = "myprov"
model = "coder-large"

[model_providers.myprov]
name = "my gateway"
base_url = "https://llm.example.com/v1"
env_key = "MYPROV_API_KEY"
wire_api = "responses"
```

**claude** reaches a gateway through its own environment:
`ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`),
exported in your shell or set in the `env` block of `~/.claude/settings.json`.
orch's role tiers use the aliases `opus` and `fable` for reviewer and
researcher; if your gateway does not resolve aliases, set
`defaults.agents.reviewer.model` and `defaults.agents.researcher.model` to full ids.

Two rules that hold for every CLI:

- Secrets stay in the CLI's own store or your environment. `config.json`
  contains agent names and model refs only.
- With `"sandbox": true` (macOS Seatbelt jail, see the README) the selected
  CLI's state directory must already exist (`~/.pi`, `~/.omp`, `~/.codex`,
  `~/.claude`); the run refuses to start otherwise.

## 5. Fan-outs pick agents from the roster

`orch cross-review`, `orch investigate`, and `orch fanout` pick agents from the
mail roster in `~/.config/orch/mail-agents.json`, seeded by
`orch mail agent defaults`:

| Command | Default agents | Role |
|---|---|---|
| `cross-review` | `claude-reviewer`, `omp-reviewer`, or `defaults.fanout.cross-review` | reviewer |
| `investigate` | `omp-researcher`, `claude-researcher`, or `defaults.fanout.investigate` | researcher |
| `fanout --role <r>` | every roster entry with `auto_invite` for that role | any |

Each selected agent becomes one `orch run create --role <r> --agent <provider>`,
so the model precedence from section 3 applies per run: a role default whose
agent matches, else `defaults.models.<agent>`. That is how two reviewers on two
providers each get the right model without any flag. `--model` on a fan-out
forwards one ref to every spawned run, so use it only when the selected agents
share a provider:

```sh
$ orch cross-review --thread pr-123 --task review.md --to-agent claude-reviewer --model claude-opus-5
```

To make your own pair the default, bind a roster entry and name it in
`defaults.fanout`; an id that is not in the roster fails the command rather
than being dropped:

```sh
$ orch mail agent bind --id pi-reviewer --address orch+pi.reviewer@local.orch \
    --provider pi --role reviewer --session-mode ephemeral --auto-invite
$ orch cross-review --thread pr-123 --task review.md --dry-run   # shows who would run
```

`orch new '<one sentence>'` is claude-only: the plan phase runs
`--role researcher --agent claude --model fable`, and the same session resumes
as the controller. `--model <ref>` changes the model; the agent cannot change.

## 6. A day with orch (the author's usage, sanitized)

Roughly 600 recorded runs across four months, one developer, several repos.
Where the tokens go:

| Role | Share of runs | Agents, most used first |
|---|---|---|
| reviewer | 65% | claude (opus tier), omp, pi |
| implementer | 21% | pi, codex, claude |
| researcher | 7% | claude (fable tier), codex |
| verifier | 4% | claude, codex, pi |
| controller | 3% | claude (fable) |

Seven out of ten runs are dispatched by a fan-out or a controller rather than
by hand, which is why the roster in section 5 matters more than
`defaults.agents` in day-to-day use. The loops that produce those runs:

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

The profile behind it: pi implements (cheapest cache traffic at equal resolve
rate in a same-model pilot), claude at the opus tier and omp review the same
diff as two model families, claude at the fable tier plans and controls, codex
is kept in the roster for explicit `--to-agent` use. An explicit `--model`
appears on about one run in ten, and most of those are the fable pin that
`orch new` applies itself; the roster and role tiers carry the rest.

## 7. Sharp edges to know before you rely on it

- **Built-in pi/omp model refs are the author's providers.** With nothing
  configured, pi and omp ask for `openai-codex/gpt-6-astra`. One
  `defaults.models.<agent>` line fixes it; there is no interactive setup.
- **Thinking level is fixed.** pi and omp always get `high`; claude gets a
  per-role effort. A model that rejects a thinking level cannot be used
  through pi/omp yet.
- **claude is the only controller.** `orch new` and `orch mailctl` plan and
  orchestrate with claude; `--model` changes the model, not the agent.
- **A per-agent claude model replaces the role tiers.** `defaults.models.claude`
  applies to reviewer and researcher too; pin `opus`/`fable` back per role in
  `defaults.agents` if you want the escalation.
- **No preflight.** `orch doctor` is on the roadmap; today a missing CLI or an
  unknown model ref surfaces as a failed run with the provider's stderr in
  `stderr.log` under the run directory. `--dry-run` shows the argv first.
