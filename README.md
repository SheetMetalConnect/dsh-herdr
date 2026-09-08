# herdr-bridge

Make any CLI coding agent show up as a first-class agent in [Herdr](https://herdr.dev).

Herdr ships integrations for Claude Code, Codex, opencode and a dozen others. An
agent it does not know about runs as an anonymous shell: no state icon, no
sidebar row, no notification when it stops and waits for you. Herdr documents a
contract for closing that gap. This is a small, dependency-free implementation
of it, plus an adapter for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

```
npm install herdr-bridge
```

## The contract

Herdr hands every pane four variables: `HERDR_ENV`, `HERDR_PANE_ID`,
`HERDR_BIN_PATH` and `HERDR_SOCKET_PATH`. An agent reports lifecycle changes by
calling the herdr binary, and releases the pane when it exits. States are
`idle`, `working`, `blocked` and `unknown`. `blocked` is the one that matters —
it means a person has to decide something, and it is what fires the
notification.

## From a shell or a hook

Agents that expose start/stop hooks need no code:

```sh
herdr-report --agent dsh --state working --message "running tests"
herdr-report --agent dsh --state blocked --message "waiting for approval"
herdr-report --agent dsh --release
```

Outside a Herdr pane it exits 0 and does nothing, so the same hook script is
safe in a plain terminal.

## From Node

```js
const { createBridge } = require('herdr-bridge')

const bridge = createBridge({ agent: 'my-agent' })
bridge.attachExitHandlers()

await bridge.report('working', { message: 'indexing repository' })
await bridge.report('blocked', { message: 'needs approval to write' })
await bridge.release()
```

`bridge.enabled` is `false` outside Herdr and every call becomes a no-op, so
you do not need to branch on it.

Pass `sessionId` and `sessionPath` when your agent has a native session
reference. Herdr uses them to put a pane back into its own conversation after a
server restart, rather than reviving an empty shell.

## DeepSeek Harness adapter

dsh ships `web`, `headless`, `sdk` and `acp` profiles and no Herdr integration.
The adapter in `adapters/dsh` subscribes to the harness lifecycle and reports
through the bridge.

```yaml
# in the profile's cordis.patch.yml
- insert:
    - id: herdr-bridge
      name: 'herdr-bridge/adapters/dsh'
      config:
        agent: dsh
```

dsh's event surface still moves between release candidates, so the adapter
subscribes defensively: an event that does not exist in the version you run
simply never fires. Nothing throws, and the pane falls back to the last state
that was reported.

## Writing another adapter

An adapter is a few lines: create a bridge, map the host's events onto the four
states, release on exit. `adapters/dsh/plugin.js` is the worked example. The
interesting design question is not the plumbing, it is deciding which of your
host's events genuinely mean "a person has to look at this now" — report that
as `blocked` and nothing else, or the notification stops meaning anything.

## Security

This runs inside a process that holds API keys and a shell, so the threat model
is written down in [SECURITY.md](SECURITY.md). The short version: no
dependencies, no network, no filesystem writes, no credential access, never a
shell, and a validated binary path.

## Licence

MIT
