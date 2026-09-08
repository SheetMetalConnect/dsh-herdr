#!/usr/bin/env node
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { createBridge } from './bridge.js'
import { connect, modelOf } from './session.js'
import {
  step, answer, footer, notice, warn, fail, tokens, seconds,
  dim, bold, sky, startSpinner, stopSpinner, setSpinnerLabel,
} from './render.js'
const cyan = sky

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
      // The harness sends several assistant messages per turn: progress notes
      // while subagents run, then the real answer. Glue them together and the
      // result reads as one run-on paragraph, so each message id is its own block.
      if (update.messageId && update.messageId !== state.messageId) {
        flushAnswer()
        state.messageId = update.messageId
      }
      state.answer = (state.answer ?? '') + (update.content?.text ?? '')
      return
    case 'tool_call': {
      flushThought()
      const { key, detail } = describe(update)
      step(key, detail)
      setSpinnerLabel(detail || key)
      return
    }
    case 'tool_call_update':
      if (update.status === 'failed') step('failed', describe(update).detail)
      return
    case 'plan':
      flushThought()
      for (const entry of update.entries ?? []) step('plan', entry.content ?? '')
      return
    case 'usage_update':
      state.used = update.used ?? state.used
      state.size = update.size ?? state.size
      return
    default:
      return
  }
}

// dsh reports every tool with kind "other", so the tool name lives in `title`
// and everything worth showing lives in `rawInput`.
const DETAIL = {
  read: (i) => i.file_path ?? i.path,
  write: (i) => i.file_path ?? i.path,
  edit: (i) => i.file_path ?? i.path,
  glob: (i) => i.pattern,
  grep: (i) => [i.pattern, i.path && basename(i.path)].filter(Boolean).join('  '),
  bash: (i) => i.description ?? i.command,
  subagent: (i) => i.description ?? oneLineTask(i.prompt),
  fetch: (i) => i.url,
  skill: (i) => i.name ?? i.skill,
}

const KEY = {
  read: 'read', write: 'write', edit: 'edit', glob: 'glob', grep: 'grep',
  bash: 'bash', subagent: 'agent', list_agents: 'agents', fetch: 'fetch',
  todo_write: 'plan', skill: 'skill',
}

function basename(p) {
  return String(p).split('/').pop()
}

function oneLineTask(prompt) {
  const line = String(prompt ?? '').split('\n').find((l) => l.trim())
  return line ?? ''
}

function describe(update) {
  const name = String(update.title ?? '').toLowerCase()
  const raw = update.rawInput ?? {}
  const detail = DETAIL[name]?.(raw) ?? raw.description ?? raw.command ?? update.title ?? ''
  return { key: KEY[name] ?? 'tool', detail }
}

function flushAnswer() {
  if (!state.answer?.trim()) {
    state.answer = undefined
    return
  }
  answer(state.answer)
  state.answer = undefined
}

function flushThought() {
  if (state.verbose || !state.thought) return
  step('think', state.thought)
  state.thought = undefined
}

async function askPermission(rl, request) {
  bridge.report('blocked', { message: request.toolCall?.title ?? 'permission' }).catch(() => {})
  const options = request.options ?? []
  process.stdout.write(`\n${bold('  Permission')} ${request.toolCall?.title ?? ''}\n`)
  options.forEach((o, i) => process.stdout.write(dim(`   ${i + 1}. ${o.name ?? o.optionId}\n`)))
  const reply = await question(rl, cyan('  choose > '))
  bridge.report('working').catch(() => {})
  // No terminal, no answer, or a number that is not on the list: refuse. Falling back to
  // the first option would auto-approve whatever the agent asked for, unattended.
  if (reply === null) {
    warn('no input available — refused')
    return undefined
  }
  const picked = options[Number(reply.trim()) - 1]
  if (!picked) {
    warn('refused')
    return undefined
  }
  return picked.optionId
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
  state.messageId = undefined
  state.busy = true
  setSpinnerLabel('thinking')
  startSpinner('thinking')
  bridge.report('working', { message: input, sessionId: state.sessionId }).catch(() => {})
  const started = Date.now()
  const result = await link.conn
    .prompt({ sessionId: state.sessionId, prompt: [{ type: 'text', text: input }] })
    .catch((err) => ({ stopReason: 'error', error: err.message }))
  state.busy = false
  stopSpinner()
  flushThought()
  flushAnswer()
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
