'use strict'


const { spawn } = require('node:child_process')
const { accessSync, statSync, constants } = require('node:fs')
const { isAbsolute } = require('node:path')

const STATES = Object.freeze(['idle', 'working', 'blocked', 'unknown'])
const MESSAGE_MAX = 200

// Status text is model output: strip control chars, cap the length.
function cleanMessage(text) {
  if (typeof text !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!stripped) return undefined
  return stripped.length > MESSAGE_MAX ? stripped.slice(0, MESSAGE_MAX - 1) + '\u2026' : stripped
}

// HERDR_BIN_PATH is env-controlled; unchecked it is arbitrary execution.
function usableBin(binPath) {
  if (typeof binPath !== 'string' || !binPath || !isAbsolute(binPath)) return false
  try {
    if (!statSync(binPath).isFile()) return false
    accessSync(binPath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function readEnv(env) {
  return {
    active: env.HERDR_ENV === '1',
    paneId: env.HERDR_PANE_ID,
    binPath: env.HERDR_BIN_PATH,
  }
}

function createBridge(options = {}) {
  const env = options.env || process.env
  const agent = options.agent
  if (!agent || typeof agent !== 'string') throw new TypeError('agent label is required')
  const source = options.source || `custom:${agent}`

  const { active, paneId, binPath } = readEnv(env)
  const enabled = Boolean(active && paneId && usableBin(binPath))

  // Climbing seq: a slow report cannot overwrite a newer state.
  let seq = 0
  let released = false

  const run = (args) =>
    new Promise((resolve) => {
      if (!enabled || released) return resolve(false)
      try {
        const child = spawn(binPath, args, {
          shell: false,
          stdio: 'ignore',
          detached: false,
        })
        child.once('error', () => resolve(false))
        child.once('close', (code) => resolve(code === 0))
      } catch {
        resolve(false)
      }
    })

  return {
    enabled,
    paneId: enabled ? paneId : undefined,
    get seq() {
      return seq
    },

    // state: idle | working | blocked | unknown
    report(state, extra = {}) {
      if (!STATES.includes(state)) {
        return Promise.reject(new RangeError(`state must be one of ${STATES.join(', ')}`))
      }
      const args = [
        'pane',
        'report-agent',
        paneId,
        '--source',
        source,
        '--agent',
        agent,
        '--state',
        state,
        '--seq',
        String(++seq),
      ]
      const message = cleanMessage(extra.message)
      if (message) args.push('--message', message)
      if (typeof extra.sessionId === 'string' && extra.sessionId) {
        args.push('--agent-session-id', extra.sessionId)
      }
      if (typeof extra.sessionPath === 'string' && extra.sessionPath) {
        args.push('--agent-session-path', extra.sessionPath)
      }
      return run(args)
    },

    // Idempotent.
    async release() {
      if (released) return false
      const args = [
        'pane',
        'release-agent',
        paneId,
        '--source',
        source,
        '--agent',
        agent,
        '--seq',
        String(++seq),
      ]
      const ok = await run(args)
      released = true
      return ok
    },

    // So a killed agent does not linger as "working".
    attachExitHandlers(proc = process) {
      if (!enabled) return () => {}
      const done = () => {
        this.release().catch(() => {})
      }
      const signals = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP']
      for (const sig of signals) proc.once(sig, done)
      return () => {
        for (const sig of signals) proc.removeListener(sig, done)
      }
    },
  }
}

module.exports = { createBridge, STATES, cleanMessage, usableBin, MESSAGE_MAX }
