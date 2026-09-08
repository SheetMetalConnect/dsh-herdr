#!/usr/bin/env node
'use strict'

// Shell-facing side of the bridge, for agents that expose hooks instead of a
// plugin API. Drop it in a start/stop hook and the pane reports state.
//
//   herdr-report --agent dsh --state working --message "running tests"
//   herdr-report --agent dsh --release
//
// Outside a Herdr pane it exits 0 and does nothing, so the same hook script
// stays safe in a plain terminal.

const { createBridge, STATES } = require('../src/bridge.js')

function parseArgs(argv) {
  const out = { release: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const take = () => {
      const value = argv[++i]
      if (value === undefined) {
        throw new Error(`${arg} needs a value`)
      }
      return value
    }
    switch (arg) {
      case '--agent':
        out.agent = take()
        break
      case '--source':
        out.source = take()
        break
      case '--state':
        out.state = take()
        break
      case '--message':
        out.message = take()
        break
      case '--session-id':
        out.sessionId = take()
        break
      case '--session-path':
        out.sessionPath = take()
        break
      case '--release':
        out.release = true
        break
      case '-h':
      case '--help':
        out.help = true
        break
      default:
        throw new Error(`unknown option: ${arg}`)
    }
  }
  return out
}

const USAGE = `herdr-report — report agent state to the surrounding Herdr pane

  --agent <label>      required, shown in the sidebar
  --source <id>        defaults to custom:<agent>
  --state <state>      ${STATES.join(' | ')}
  --message <text>     short status line, control chars stripped
  --session-id <id>    native session reference, so a restart can resume
  --session-path <p>   path to that session file
  --release            hand pane authority back and exit

Does nothing outside a Herdr pane.`

async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`)
    return 2
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!opts.agent) {
    process.stderr.write(`--agent is required\n\n${USAGE}\n`)
    return 2
  }
  if (!opts.release && !opts.state) {
    process.stderr.write(`--state or --release is required\n\n${USAGE}\n`)
    return 2
  }
  if (opts.state && !STATES.includes(opts.state)) {
    process.stderr.write(`--state must be one of ${STATES.join(', ')}\n`)
    return 2
  }

  const bridge = createBridge({ agent: opts.agent, source: opts.source })
  if (!bridge.enabled) return 0

  if (opts.release) {
    await bridge.release()
    return 0
  }
  await bridge.report(opts.state, {
    message: opts.message,
    sessionId: opts.sessionId,
    sessionPath: opts.sessionPath,
  })
  return 0
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => process.exit(1),
)
