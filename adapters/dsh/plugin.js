'use strict'

// DeepSeek Harness adapter.
//
// dsh ships web, headless, sdk and acp profiles but no Herdr integration, so a
// dsh pane shows up as an anonymous shell. This plugin reports its lifecycle
// through the bridge and the pane becomes a first-class Herdr agent.
//
// Add it to a profile:
//   dsh plugin --profile headless add herdr-bridge
// or by hand in the profile's cordis.patch.yml:
//   - insert:
//       - id: herdr-bridge
//         name: 'herdr-bridge/adapters/dsh'
//         config: { agent: dsh }
//
// dsh's event surface is still moving between release candidates. Rather than
// pin one shape, every known lifecycle event is subscribed defensively: an
// event that does not exist in the running version simply never fires, and the
// pane falls back to the state its neighbours reported.

const { createBridge } = require('../../src/bridge.js')

const name = 'herdr-bridge'

// event name -> what the pane should say while it is happening
const TRANSITIONS = [
  ['turn/start', 'working'],
  ['step/start', 'working'],
  ['tools/result', 'working'],
  ['step/end', 'working'],
  ['turn/end', 'idle'],
  ['agent/turn-stopping', 'idle'],
  ['session/idle', 'idle'],
  // A question or an approval prompt is the one state worth a notification:
  // the run has stopped and it is waiting on a person.
  ['user/question', 'blocked'],
  ['user/approval-request', 'blocked'],
  ['agent/request-error', 'blocked'],
]

function apply(ctx, config = {}) {
  const bridge = createBridge({
    agent: config.agent || 'dsh',
    source: config.source,
  })
  if (!bridge.enabled) return

  const detach = bridge.attachExitHandlers()

  // Reporting must never break a turn, so every handler is fire-and-forget.
  const send = (state, extra) => {
    Promise.resolve(bridge.report(state, extra)).catch(() => {})
  }

  for (const [event, state] of TRANSITIONS) {
    try {
      ctx.on(event, () => send(state))
    } catch {
      // Unknown event in this dsh version. Nothing to do.
    }
  }

  send('idle', { message: 'dsh ready' })

  if (typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', () => {
        detach()
        bridge.release().catch(() => {})
      })
    } catch {
      // No dispose hook: the process exit handlers still release the pane.
    }
  }
}

module.exports = { name, apply }
