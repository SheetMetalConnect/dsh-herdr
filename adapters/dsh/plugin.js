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
// Event names below were read out of dsh 0.1.2-rc.1 rather than guessed, but
// the surface still moves between release candidates, so every subscription is
// defensive: an event that does not exist in the version you run simply never
// fires and nothing throws.
//
// One ordering caveat, visible in a single-shot `--profile headless` run: the
// job can begin before this plugin is mounted, so the opening `turn/start` is
// already past and the pane only sees the closing `turn/end`. Any session with
// more than one turn reports normally.

const { createBridge } = require('../../src/bridge.js')

const name = 'herdr-bridge'

// event name -> what the pane should say while it is happening
const TRANSITIONS = [
  ['agent/session-start', 'working'],
  ['turn/start', 'working'],
  ['step/start', 'working'],
  ['step/end', 'working'],
  ['tools/result', 'working'],
  ['subagent/start', 'working'],
  ['subagent/end', 'working'],
  // A decision came back, so the run is moving again.
  ['approval/decided', 'working'],

  ['turn/end', 'idle'],
  ['session/disposed', 'idle'],
  ['agent/disposed', 'idle'],

  // The only states worth a notification: the run has stopped and it is
  // waiting on a person. Report nothing else as blocked or the notification
  // stops meaning anything.
  ['approval/request', 'blocked'],
  ['user-questions/request', 'blocked'],
  ['agent/error', 'blocked'],
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
