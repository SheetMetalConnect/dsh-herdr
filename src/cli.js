#!/usr/bin/env node
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { createBridge } from './bridge.js'
import { connect, modelOf } from './session.js'
import { step, answer, footer, notice, warn, fail, tokens, seconds, dim, bold, cyan } from './render.js'

const bridge = createBridge({ agent: 'dsh' })

const state = {
  sessionId: undefined,
  model: undefined,
  used: 0,
  size: 0,
  verbose: Boolean(process.env.DSX_VERBOSE),
  web: undefined,
  busy: false,
}

const HELP = `  /web        open the harness web UI on this session
  /sessions   list sessions in this workspace
  /resume <id>  continue an earlier session
  /verbose    toggle full reasoning
  /new        start a fresh session
  /help /quit`

function render(update) {
  switch (update.sessionUpdate) {
    case 'agent_thought_chunk': {
      const text = update.content?.text ?? ''
      if (state.verbose) process.stdout.write(dim(text))
      else if (text.trim()) state.thought = (state.thought ?? '') + text
      return
    }
    case 'agent_message_chunk':
      flushThought()
      state.answer = (state.answer ?? '') + (update.content?.text ?? '')
      return
    case 'tool_call':
      flushThought()
      step(labelFor(update), detailOf(update))
      return
    case 'tool_call_update':
      if (update.status === 'failed') step('Failed', update.title ?? '')
      return
    case 'plan':
      flushThought()
      for (const entry of update.entries ?? []) step('Plan', entry.content ?? '')
      return
    case 'usage_update':
      state.used = update.used ?? state.used
      state.size = update.size ?? state.size
      return
    default:
      return
  }
}

// The title carries the command name, rawInput carries what it actually runs.
function detailOf(update) {
  const raw = update.rawInput ?? {}
  return raw.command ?? raw.description ?? raw.pattern ?? raw.path ?? raw.query ?? update.title ?? ''
}

function labelFor(update) {
  const kind = `${update.kind ?? ''} ${update.title ?? ''}`.toLowerCase()
  if (kind.includes('execute') || kind.includes('bash')) return 'Bash'
  if (kind.includes('read')) return 'Read'
  if (kind.includes('edit') || kind.includes('write')) return 'Edit'
  if (kind.includes('search') || kind.includes('grep')) return 'Search'
  if (kind.includes('fetch')) return 'Fetch'
  return 'Tool'
}

function flushThought() {
  if (state.verbose || !state.thought) return
  step('Think', state.thought)
  state.thought = undefined
}

async function askPermission(rl, request) {
  bridge.report('blocked', { message: request.toolCall?.title ?? 'permission' }).catch(() => {})
  const options = request.options ?? []
  process.stdout.write(`\n${bold('  Permission')} ${request.toolCall?.title ?? ''}\n`)
  options.forEach((o, i) => process.stdout.write(dim(`   ${i + 1}. ${o.name ?? o.optionId}\n`)))
  const reply = await question(rl, cyan('  choose > '))
  const picked = reply === null ? options[0] : options[Number(reply.trim()) - 1] ?? options[0]
  bridge.report('working').catch(() => {})
  return picked?.optionId
}

let inputClosed = false

// Resolves null once stdin is gone, so a piped script and a closed terminal
// both end the loop instead of throwing ERR_USE_AFTER_CLOSE.
function question(rl, prompt) {
  if (inputClosed || rl.closed) return Promise.resolve(null)
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      rl.off('close', onClose)
      resolve(value)
    }
    const onClose = () => {
      inputClosed = true
      finish(null)
    }
    rl.once('close', onClose)
    rl.question(prompt, (answerText) => finish(answerText))
  })
}

async function openWeb() {
  if (state.web) {
    notice(state.web)
    return
  }
  const child = spawn('dsh', ['web', '--no-open'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: process.env,
    detached: true,
  })
  child.unref()
  const url = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 30000)
    child.stdout.on('data', (d) => {
      const match = String(d).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)
      if (match) {
        clearTimeout(timer)
        resolve(match[0])
      }
    })
  })
  if (!url) return warn('web UI did not report a URL in time')
  state.web = url
  notice(url)
  notice('same $DSH_HOME, so this session is in that list')
}

function parseArgv(argv) {
  const out = { prompt: undefined, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-p' || argv[i] === '--prompt') out.prompt = argv[++i]
    else if (argv[i] === '-v' || argv[i] === '--verbose') out.verbose = true
    else if (out.prompt === undefined) out.prompt = argv[i]
  }
  return out
}

async function runTurn(link, input) {
  state.answer = undefined
  state.thought = undefined
  state.busy = true
  bridge.report('working', { message: input, sessionId: state.sessionId }).catch(() => {})
  const started = Date.now()
  const result = await link.conn
    .prompt({ sessionId: state.sessionId, prompt: [{ type: 'text', text: input }] })
    .catch((err) => ({ stopReason: 'error', error: err.message }))
  state.busy = false
  flushThought()
  if (state.answer) answer(state.answer)
  if (result.error) fail(result.error)
  footer([
    tokens(state.used, state.size),
    seconds(Date.now() - started),
    result.stopReason !== 'end_turn' ? result.stopReason : '',
  ])
  bridge.report('idle', { message: state.model, sessionId: state.sessionId }).catch(() => {})
  return result
}

async function main() {
  const args = parseArgv(process.argv.slice(2))
  if (args.verbose) state.verbose = true
  const cwd = process.cwd()
  let link
  try {
    link = await connect({
      cwd,
      handlers: { onUpdate: render },
      onExit: (code, err) => {
        if (code !== 0 && code !== null) fail(`dsh exited (${code})\n${err.trim().slice(-500)}`)
      },
    })
  } catch (err) {
    fail(err.message)
    process.exit(1)
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.on('close', () => {
    inputClosed = true
  })
  const session = await link.conn.newSession({ cwd, mcpServers: [] })
  state.sessionId = session.sessionId
  state.model = modelOf(session) ?? 'deepseek'

  bridge.attachExitHandlers()
  bridge.report('idle', { message: state.model, sessionId: state.sessionId }).catch(() => {})

  if (args.prompt) {
    await runTurn(link, args.prompt)
    await bridge.release().catch(() => {})
    link.close()
    rl.close()
    process.exit(0)
  }

  process.stdout.write(
    `${bold('dsh')} ${dim(link.info?.agentInfo?.version ?? '')} ${dim('·')} ${state.model} ${dim('·')} ${dim(cwd)}\n`,
  )
  process.stdout.write(dim('  /help for commands\n'))

  let cancelling = false
  rl.on('SIGINT', () => {
    if (state.busy && !cancelling) {
      cancelling = true
      link.conn.cancel({ sessionId: state.sessionId }).catch(() => {})
      warn('cancelling turn')
      return
    }
    rl.close()
  })

  for (;;) {
    const raw = await question(rl, `\n${cyan('›')} `)
    if (raw === null) break
    const input = raw.trim()
    if (!input) continue

    if (input.startsWith('/')) {
      const [cmd, ...rest] = input.slice(1).split(/\s+/)
      if (cmd === 'quit' || cmd === 'q') break
      if (cmd === 'help') {
        process.stdout.write(`${HELP}\n`)
        continue
      }
      if (cmd === 'verbose') {
        state.verbose = !state.verbose
        notice(`reasoning ${state.verbose ? 'shown' : 'folded'}`)
        continue
      }
      if (cmd === 'web') {
        await openWeb()
        continue
      }
      if (cmd === 'sessions') {
        const list = await link.conn.listSessions({}).catch((e) => ({ error: e.message }))
        for (const s of list.sessions ?? []) {
          step(s.sessionId === state.sessionId ? 'current' : 'session', `${s.sessionId}  ${s.title ?? ''}`)
        }
        if (list.error) warn(list.error)
        continue
      }
      if (cmd === 'resume') {
        const id = rest[0]
        if (!id) {
          warn('usage: /resume <session-id>')
          continue
        }
        const resumed = await link.conn.resumeSession({ sessionId: id, cwd }).catch((e) => ({ error: e.message }))
        if (resumed.error) {
          warn(resumed.error)
          continue
        }
        state.sessionId = id
        notice(`resumed ${id}`)
        continue
      }
      if (cmd === 'new') {
        const fresh = await link.conn.newSession({ cwd, mcpServers: [] })
        state.sessionId = fresh.sessionId
        state.used = 0
        notice(`new session ${fresh.sessionId}`)
        continue
      }
      warn(`unknown command: /${cmd}`)
      continue
    }

    cancelling = false
    await runTurn(link, input)
  }

  await bridge.release().catch(() => {})
  link.close()
  rl.close()
  process.exit(0)
}

main().catch((err) => {
  fail(err.stack ?? err.message)
  process.exit(1)
})
