# herdr-bridge

Make any CLI coding agent show up as a first-class agent in [Herdr](https://herdr.dev) —
live `idle` / `working` / `blocked` in the sidebar instead of an anonymous shell.

Ships an adapter for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
which has no Herdr integration of its own.

## Quick start: DeepSeek Harness in Herdr

```sh
npm install -g @deepseek-ai/dsh
dsh plugin --profile headless add herdr-bridge
```

Then, in a Herdr pane, inside the repo you want to work on:

```sh
DEEPSEEK_API_KEY=… dsh --profile headless "list the top-level packages"
```

The sidebar row for that pane becomes `dsh`, and follows the run.

Three things that are not obvious:

**Reasoning goes to stderr, the answer to stdout.** `dsh --profile headless` streams
its whole thought process to the terminal. Redirect it and you get just the answer:

```sh
dsh --profile headless "…" 2>/dev/null
```

**A pane already running another agent wins.** Herdr gives each pane exactly one
status authority, so an integration with full lifecycle hooks — Claude Code, Codex,
opencode — stays authoritative and dsh's reports are ignored. This is by design, not a
failure. Start dsh in a fresh pane. `herdr agent explain <pane-id>` shows which source
won and why.

**Single-shot headless can miss the opening `working`.** The job may begin before the
plugin is mounted, so the first `turn/start` is already past and only the closing
`turn/end` lands. Anything with more than one turn reports normally.

The web UI (`dsh web --no-open`) is a separate window onto the same sessions — trajectory
viewer, tool calls, token and cache meters. It is not needed to run tasks, binds loopback
only, and prints a tokenised URL.

## The contract

Herdr hands every pane `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH` and
`HERDR_SOCKET_PATH`. An agent reports state by calling the herdr binary and releases the
pane on exit. States are `idle`, `working`, `blocked`, `unknown`.

Report `blocked` only when a person actually has to decide something — that is what
raises the notification. Everything else dilutes it.

## From a shell or a hook

For agents that expose start/stop hooks, no code is needed:

```sh
herdr-report --agent my-agent --state working --message "running tests"
herdr-report --agent my-agent --state blocked --message "waiting for approval"
herdr-report --agent my-agent --release
```

Outside a Herdr pane it exits 0 and does nothing, so the same script is safe in a plain
terminal.

## From Node

```js
const { createBridge } = require('herdr-bridge')

const bridge = createBridge({ agent: 'my-agent' })
bridge.attachExitHandlers()

await bridge.report('working', { message: 'indexing repository' })
await bridge.release()
```

`bridge.enabled` is `false` outside Herdr and every call becomes a no-op, so there is
nothing to branch on.

Pass `sessionId` and `sessionPath` when your agent has a native session reference; Herdr
uses them to put a pane back into its own conversation after a server restart.

## Writing another adapter

`adapters/dsh/plugin.js` is the worked example: create a bridge, map the host's events
onto the four states, release on exit. The plumbing is trivial; the real question is
which of your host's events genuinely mean "a person has to look at this now".

## Troubleshooting

| Symptom | Cause |
|---|---|
| Sidebar shows the other agent, not yours | One status authority per pane. Use a fresh pane. |
| Nothing reports at all | Not in a Herdr pane, or `HERDR_BIN_PATH` is not an absolute executable file. `bridge.enabled` is then `false` by design. |
| Installed but inert | The package must declare `dsh.bundle.patch`; `dsh plugin add` only joins bundles. Check `dsh.profile.bundles` in the profile's `package.json`. |
| pnpm skips the update | `dsh plugin add` reuses the lockfile. Pin the commit: `add "github:owner/repo#<sha>"`. |
| Only `idle`, never `working` | Single-shot headless; see above. |

## Security

This runs inside a process holding API keys and a shell. The threat model is in
[SECURITY.md](SECURITY.md): no dependencies, no network, no filesystem writes, no
credential access, never a shell, validated binary path.

## Licence

MIT
