# dsh-herdr

DeepSeek Harness in your terminal, wired into [Herdr](https://herdr.dev).

DeepSeek ships `web`, `headless`, `sdk` and `acp` profiles — no interactive terminal
client. So a harness pane is either a browser tab or a one-shot command, and Herdr sees an
anonymous shell either way. This closes both gaps: an interactive client over the standard
Agent Client Protocol, with live `idle` / `working` / `blocked` in the Herdr sidebar and a
one-key handoff to the harness web UI.

```
› Review this repo and name the three weakest spots

  ☰ To-dos  1 in progress, 2 pending
    ◐ Survey repo structure and read project instructions
    ○ Review routes, hooks and shared modules
    ○ Summarise findings
  ◇ Think   This is a large monorepo. Let me split the review…
  ▶ Bash    List repo root and recent git history
  ⌕ Glob    *.json
  ⚑ Agent   Review Supabase backend weaknesses
    └ Three findings, strongest first: …                    52s

  <the answer>

  ███░░░░░░░░░ · 80.2K / 1M tokens · 205s
```

Each tool gets its own icon and colour, a spinner carries the current step, and while
subagents are out it says how many are running. Slow calls report what they cost; a
subagent always reports what it came back with.

## Install

```sh
npm install -g @deepseek-ai/dsh github:SheetMetalConnect/dsh-herdr
```

The DeepSeek key comes from `DEEPSEEK_API_KEY`, or `~/.config/deepseek/key` (mode 600).

## Use

```sh
dsx                     # interactive session in the current repo
dsx -p "run the tests"  # one turn, print, exit
dsx -v                  # show full reasoning instead of one folded line
```

| Command | |
|---|---|
| `/web` | start the harness web UI and print its URL — same `$DSH_HOME`, so this session is in that list |
| `/todos` | the current to-do list, with per-item status |
| `/trace` | every tool call of the last turn, with what it returned |
| `/spaces` | your Herdr workspaces, read live from the running server |
| `/space <name>` | start a session in one of them |
| `/sessions` | sessions in this workspace |
| `/resume <id>` | continue an earlier session, including one you worked on in the browser |
| `/new` | fresh session |
| `/verbose` | fold or unfold reasoning |
| `/help` `/quit` | |

`Ctrl-C` cancels the running turn; again exits.

Output is line-based rather than a full-screen redraw, so Herdr's scrollback, `pane_history`
and ordinary copy-paste keep working.

## In Herdr

The pane reports `working` while a turn runs, `blocked` when the harness asks for
permission — the state that raises a notification — and `idle` when it is your move. The
session id goes with it, so Herdr can put the pane back into its own conversation after a
server restart.

Herdr gives each pane exactly one status authority. Start `dsx` in a fresh pane: in a pane
already running Claude Code, Codex or opencode, that integration stays authoritative and
these reports are ignored by design. `herdr agent explain <pane-id>` shows which source won.

## Handoff, both directions

`/web` starts `dsh web --no-open` and prints a tokenised loopback URL. It never opens a
browser tab. Because both sides share `$DSH_HOME`, the session you are typing in appears in
that list; work you continue in the browser lands in the same session file, and `/resume`
brings it back to the terminal.

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

Outside a Herdr pane both are no-ops, so the same script is safe in a plain terminal.

There is also a dsh plugin (`adapters/dsh`) that reports state from inside the harness
itself, for the `headless` and `web` profiles:

```sh
dsh plugin --profile headless add github:SheetMetalConnect/dsh-herdr
```

Note that a single-shot headless job can start before the plugin mounts, so the opening
`turn/start` is already past and only the closing `turn/end` lands.

## Security

This runs inside a process holding API keys and a shell. The threat model is in
[SECURITY.md](SECURITY.md): the Herdr side has no dependencies, no network, no filesystem
writes, no credential access, never a shell, and a validated binary path.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Sidebar shows another agent | One status authority per pane. Use a fresh pane. |
| Nothing reports at all | Not in a Herdr pane, or `HERDR_BIN_PATH` is not an absolute executable file. |
| `no DeepSeek key` | Set `DEEPSEEK_API_KEY` or write `~/.config/deepseek/key`. |
| Plugin installed but inert | `dsh plugin add` only joins packages declaring `dsh.bundle.patch`. Check `dsh.profile.bundles` in the profile's `package.json`. |
| pnpm skips an update | It reuses the lockfile. Pin the commit: `add "github:owner/repo#<sha>"`. |

## Licence

MIT
