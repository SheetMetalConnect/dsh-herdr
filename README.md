```
        888          888                 888              888
        888          888                 888              888
        888          888                 888              888
    .d88888 .d8888b  88888b.        8888888888 .d88b.  888d888 .d88888 888d888
   d88" 888 88K      888 "88b       888  888  d8P  Y8b 888P"  d88" 888 888P"
   888  888 "Y8888b. 888  888       888  888  88888888 888    888  888 888
   Y88b 888      X88 888  888       888  888  Y8b.     888    Y88b 888 888
    "Y88888  88888P' 888  888       888  888   "Y8888  888     "Y88888 888
```

**DeepSeek Harness in your terminal, wired into [Herdr](https://herdr.dev).**

DeepSeek ships `web`, `headless`, `sdk` and `acp` profiles — no interactive terminal
client. So a harness pane is either a browser tab or a one-shot command, and Herdr sees an
anonymous shell either way. This closes both gaps: a full client over the standard
[Agent Client Protocol](https://agentclientprotocol.com), live pane state in the Herdr
sidebar, and a handoff to the harness web UI that works in both directions.

---

```
 ◆ my-repo main  ·  DeepSeek-V4-Pro (max)
   web  http://127.0.0.1:3080/?token=…
   /help for commands

› Review this repo and name the three weakest spots

00:02 ☰ To-dos  1 in progress, 2 pending
        ◐ Survey repo structure and read project instructions
        ○ Review routes, hooks and shared modules
        ○ Summarise findings
00:04 ◇ Think   This is a large monorepo. Let me split the review…
00:09 ▶ Bash    List repo root and recent git history
00:11 ⌕ Glob    *.json
00:12 ⚑ Agent   Review the backend
      └ Three findings, strongest first: …                        52s

      **First**, `src/lib/dispatch.ts:190` runs the same guard twice…

  ███░░░░░░░░░ · 80.2K / 1M tokens · 205s
```

Every step carries elapsed time, so the log reads as a timeline: you can see where a long
turn went instead of inferring it from the total. Reasoning folds to one line unless you
ask for it. While subagents are out, the spinner says how many.

---

## Install

```sh
npm install -g @deepseek-ai/dsh github:SheetMetalConnect/dsh-herdr
```

The key comes from `DEEPSEEK_API_KEY`, or `~/.config/deepseek/key` at mode 600.

## Run

```sh
dsx                              # interactive session in the current repo
dsx -p "run the tests"           # one turn, print, exit
dsx --model pro --effort max     # pick the weight class at launch
dsx -v                           # full reasoning instead of one folded line
```

Launch flags are what turn one command into a set of them — a cheap lane for sweeps and a
strong one for the hard work:

```sh
alias dsxf='dsx --model flash'
alias dsxp='dsx --model pro --effort max'
```

## Defaults

Every session — terminal, web and headless — starts from `~/.dsh/settings.yaml`:

```yaml
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: high
```

`--model`, `--effort` and `/model` override it per session; this is what they fall back to.
Set `deepseek-v4-pro` here if the hard work is your normal work, and keep an alias for the
cheap lane rather than the other way round.

A self-hosted endpoint is a `provider` here too. There is no per-session provider switch:
the ACP server does not expose one, so the settings file is where that choice lives.

**The harness refuses to boot on an invalid document**, and the error surfaces as a client
that cannot start. YAML indentation is the usual cause — every key of a block sits at the
same column, and a top-level key starts at column 0:

```
Error: settings-file: invalid document at ~/.dsh/settings.yaml: BAD_INDENT at line 3
```

## Modes and presets

The web UI offers Standard, PTC, Minimal and Creator presets. They are not reachable from
here: the ACP server registers nine methods and `session/set_mode` is not among them, and
the bundle composes no presets by design. Choose a preset in the web UI, or give a preset
its own dsh profile and point at that.

## Commands

**Model**

| | |
|---|---|
| `/model` `/effort` | switch model or reasoning effort; no argument lists the choices |
| `/set <id> <value>` | any other config option the harness exposes |

**Sessions**

| | |
|---|---|
| `/sessions` | sessions in this workspace |
| `/resume <id>` | continue an earlier one, including work done in the browser |
| `/new` | start fresh |

**Seeing what happened**

| | |
|---|---|
| `/todos` | the current to-do list with per-item status |
| `/trace` | every tool call of the last turn, with what it returned |
| `/queue` | what is waiting to run |
| `/web` | the harness web UI on this session |
| `/verbose` | fold or unfold reasoning |
| `/spaces` `/space <name>` | your Herdr workspaces, and jump to one |

Type while a turn is running and your input is queued rather than swallowed; it drains in
order when the turn ends. `Ctrl-C` cancels the turn, then clears the queue, then exits.

Output is line-based rather than a full-screen redraw, so scrollback, `pane_history` and
ordinary copy-paste keep working.

## In Herdr

The pane reports `working` while a turn runs, `blocked` when the harness needs a decision
or a turn fails — the state that raises a notification — and `idle` when it is your move.
The session id travels with every report, so Herdr can put the pane back into its own
conversation after a server restart.

Herdr gives each pane one status authority. Start `dsx` in a fresh pane: where Claude
Code, Codex or opencode is already running, that integration stays authoritative and these
reports are ignored by design. `herdr agent explain <pane-id>` shows which source won.

## Handoff, both directions

The web UI starts on first launch and its link is printed in the header; a second session
reuses the same server rather than starting another. It never opens a browser tab.

Both sides share `$DSH_HOME`, so the session you are typing in appears in that list, work
you continue in the browser lands in the same session file, and `/resume` brings it back
to the terminal.

Session *grouping* in the web UI is host-side only and cannot be set over ACP — add a repo
there once and sessions in that directory group under it from then on.

## Reporting state from another agent

The Herdr side is a standalone, dependency-free module. Any CLI can use it:

```sh
herdr-report --agent my-agent --state working --message "running tests"
herdr-report --agent my-agent --release
```

```js
import { createBridge } from 'dsh-herdr/src/bridge.js'

const bridge = createBridge({ agent: 'my-agent' })
bridge.attachExitHandlers()
await bridge.report('working', { message: 'indexing' })
```

Outside a Herdr pane both are no-ops, so the same script stays safe in a plain terminal.

There is also a dsh plugin that reports from inside the harness, for the `headless` and
`web` profiles:

```sh
dsh plugin --profile headless add github:SheetMetalConnect/dsh-herdr
```

A single-shot headless job can begin before the plugin mounts, so the opening `turn/start`
is already past and only the closing `turn/end` lands.

## Security

This runs inside a process holding API keys and a shell, so the threat model is written
down in [SECURITY.md](SECURITY.md). In short:

- **No dependencies on the Herdr side.** No network, no filesystem writes, no credential
  access, never a shell, and a binary path that must resolve to an absolute executable file.
- **File access is confined to the workspace.** The harness asks the client to read and
  write files, and what it asks for is chosen by a model that has just read this repository.
  Paths resolve through `realpath` and are refused outside the session directory, which
  also closes the symlink route out.
- **Permission prompts fail closed.** No terminal, no answer, or an out-of-range choice all
  refuse.
- **Terminal delegation is declined.** The harness runs its own shell under its own
  sandbox; accepting that request would hand it a second one with none.
- **The key never reaches a command line.** It is passed to the child through its
  environment, so it stays out of `ps` and shell history.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Sidebar shows another agent | One status authority per pane. Use a fresh pane. |
| Nothing reports at all | Not in a Herdr pane, or `HERDR_BIN_PATH` is not an absolute executable file. |
| `no DeepSeek key` | Set `DEEPSEEK_API_KEY` or write `~/.config/deepseek/key`. |
| Plugin installed but inert | `dsh plugin add` only joins packages declaring `dsh.bundle.patch`. Check `dsh.profile.bundles` in the profile's `package.json`. |
| pnpm skips an update | It reuses the lockfile. Pin the commit: `add "github:owner/repo#<sha>"`. |
| Sessions show as Ungrouped | Workspace grouping is host-side; add the repo once in the web UI. |

## Licence

MIT
