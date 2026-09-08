import { createBridge } from '../../src/bridge.js'

export const name = 'dsh-herdr'

const TRANSITIONS = [
  ['agent/session-start', 'working'],
  ['turn/start', 'working'],
  ['step/start', 'working'],
  ['step/end', 'working'],
  ['tools/result', 'working'],
  ['subagent/start', 'working'],
  ['subagent/end', 'working'],
  ['approval/decided', 'working'],

  ['turn/end', 'idle'],
  ['session/disposed', 'idle'],
  ['agent/disposed', 'idle'],

  ['approval/request', 'blocked'],
  ['user-questions/request', 'blocked'],
  ['agent/error', 'blocked'],
]

export function apply(ctx, config = {}) {
  const bridge = createBridge({
    agent: config.agent || 'dsh',
    source: config.source,
  })
  if (!bridge.enabled) return

  const detach = bridge.attachExitHandlers()

  const send = (state, extra) => {
    Promise.resolve(bridge.report(state, extra)).catch(() => {})
  }

  for (const [event, state] of TRANSITIONS) {
    try {
      ctx.on(event, () => send(state))
    } catch {
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
    }
  }
}

