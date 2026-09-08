#!/usr/bin/env node
import readline from 'node:readline'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createBridge } from './bridge.js'
import { connect, flattenOption, labelOfValue } from './session.js'
import { readMcpServers } from './mcp.js'
import {
  step, result, todos, answer, markTurnStart, footer, notice, warn, fail, tokens, seconds, bar,
  dim, bold, sky, startSpinner, stopSpinner, setSpinnerLabel,
} from './render.js'

const bridge = createBridge({ agent: 'DeepSeek', source: 'custom:dsh' })

const state = {
  sessionId: undefined,
  model: undefined,
  used: 0,
  size: 0,
  verbose: Boolean(process.env.DSX_VERBOSE),
  calls: new Map(),
  trace: [],
  todos: [],
  options: [],
  effort: undefined,
  web: undefined,
  busy: false,
}

const HELP = `  /web        open the harness web UI on this session
  /spaces     your herdr workspaces
  /space <n>  start a session in one of them
  /sessions   list sessions in this workspace
  /resume <id>  continue an earlier session
  /model      switch model, any provider the harness offers
  /effort     reasoning effort: off, low, high, max
  /queue      what is waiting to run
  /todos      the current to-do list
  /trace      every tool call of the last turn, with its output
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
      state.calls.set(update.toolCallId, { key, detail, started: Date.now() })
      const list = update.rawInput?.todos
      if (Array.isArray(list) && list.length) {
        state.todos = list
        todos(list)
        // Progress belongs in the sidebar too, so a glance says how far it is.
        const done = list.filter((t) => t.status === 'completed').length
        bridge.metadata({ summary: `${done}/${list.length} done` }).catch(() => {})
      } else {
        step(key, detail)
      }
      tickSpinner()
      return
    }
    case 'tool_call_update': {
      const call = state.calls.get(update.toolCallId)
      const text = (update.content ?? [])
        .map((c) => c.content?.text ?? '')
        .join(' ')
        .trim()
      if (update.status === 'failed') {
        step('failed', call?.detail ?? text)
        state.calls.delete(update.toolCallId)
        tickSpinner()
        return
      }
      // A to-do update can arrive on the completion too; without this the list
      // moves in the sidebar while the pane shows nothing.
      const laterTodos = update.rawInput?.todos
      if (Array.isArray(laterTodos) && laterTodos.length) {
        state.todos = laterTodos
        todos(laterTodos)
        const finished = laterTodos.filter((t) => t.status === 'completed').length
        bridge.metadata({ summary: `${finished}/${laterTodos.length} done` }).catch(() => {})
      }
      if (update.status !== 'completed') return
      const took = call ? Date.now() - call.started : 0
      state.trace.push({ ...call, took, output: text })
      state.calls.delete(update.toolCallId)
      // A subagent is the slow, interesting one: always show what came back.
      // Everything else only reports when it was slow enough to have been felt.
      if (call?.key === 'agent') result('agent', text || 'done', seconds(took))
      else if (took > 3000 && call) result(call.key, call.detail, seconds(took))
      tickSpinner()
      return
    }
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
  read: (i) => relative(i.file_path ?? i.path),
  write: (i) => relative(i.file_path ?? i.path),
  edit: (i) => relative(i.file_path ?? i.path),
  glob: (i) => i.pattern,
  grep: (i) => [i.pattern, i.path && basename(i.path)].filter(Boolean).join('  '),
  ls: (i) => relative(i.path),
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

// Absolute paths eat the line and say nothing: inside a repo the interesting
// part is always the tail.
function relative(p) {
  const path = String(p ?? '')
  const root = process.cwd()
  return path.startsWith(root + '/') ? path.slice(root.length + 1) : path
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

// The spinner doubles as the subagent monitor: while agents are out, it says
// how many and stops pretending the run is one linear thing.
function tickSpinner() {
  const running = [...state.calls.values()]
  const agents = running.filter((c) => c.key === 'agent').length
  if (agents > 0) setSpinnerLabel(`${agents} subagent${agents > 1 ? 's' : ''} running`)
  else if (running.length) setSpinnerLabel(running[running.length - 1].detail || 'working')
  else setSpinnerLabel('thinking')
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
  const reply = await question(rl, sky('  choose > '))
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

// Mirrors the Herdr sidebar: its workspaces are the repos you actually work in,
// so they are the right list to jump between. Read live from the running Herdr
// server, never stored, so nothing about the workspaces lands in this repo.
// Which Herdr workspace this pane belongs to — the grouping you see in the
// sidebar, so the header agrees with it.
function herdrSpaceOfPane() {
  const paneId = process.env.HERDR_PANE_ID
  const bin = process.env.HERDR_BIN_PATH
  if (!paneId || !bin) return undefined
  const out = spawnSync(bin, ['pane', 'get', paneId], { encoding: 'utf8', shell: false })
  if (out.status !== 0) return undefined
  try {
    const workspaceId = JSON.parse(out.stdout).result?.pane?.workspace_id
    return herdrSpaces()?.find((w) => w.id === workspaceId)?.label
  } catch {
    return undefined
  }
}

function herdrSpaces() {
  const bin = process.env.HERDR_BIN_PATH || 'herdr'
  const read = (args) => {
    const out = spawnSync(bin, args, { encoding: 'utf8', shell: false })
    if (out.status !== 0) return undefined
    try {
      return JSON.parse(out.stdout).result
    } catch {
      return undefined
    }
  }
  const spaces = read(['workspace', 'list'])?.workspaces
  if (!spaces) return undefined
  // Workspace rows carry a label but no path; the panes inside them do.
  const panes = read(['agent', 'list'])?.agents ?? []
  const cwdOf = new Map()
  for (const pane of panes) if (pane.workspace_id && pane.cwd) cwdOf.set(pane.workspace_id, pane.cwd)
  return spaces.map((w) => ({
    id: w.workspace_id,
    label: w.label,
    status: w.agent_status,
    cwd: cwdOf.get(w.workspace_id),
  }))
}

const WEB_CACHE = `${process.env.DSH_HOME || `${process.env.HOME}/.dsh`}/.dsx-web`

// The token is only printed when the server starts, so a second dsx would have
// no way to reach an already-running UI. Cache it next to the harness home at
// 0600 — same posture as the credential file, and never inside a repo.
function cachedWebUrl() {
  try {
    const url = readFileSync(WEB_CACHE, 'utf8').trim()
    return url.startsWith('http://127.0.0.1:') ? url : undefined
  } catch {
    return undefined
  }
}

// The tokened URL answers with a redirect to "/", and following it drops the
// token and comes back 401 — which reads as a dead server. Judge the first
// response instead of the one it points at.
async function alive(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
    return res.status < 400 || (res.status >= 300 && res.status < 400)
  } catch {
    return false
  }
}

async function ensureWeb({ quiet = false, timeoutMs = 30000 } = {}) {
  if (state.web) return state.web

  const cached = cachedWebUrl()
  if (cached && (await alive(cached))) {
    state.web = cached
    return cached
  }

  const child = spawn('dsh', ['web', '--no-open'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: process.env,
    detached: true,
  })
  child.unref()
  const url = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    child.once('exit', () => resolve(undefined))
    child.stdout.on('data', (d) => {
      const match = String(d).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)
      if (match) {
        clearTimeout(timer)
        resolve(match[0])
      }
    })
  })
  if (!url) {
    // A server already holding the port is the usual cause, and its token was
    // only printed when it started, so it cannot be recovered from here.
    if (!quiet) warn('no web UI: the port is busy or the harness did not answer in time')
    return undefined
  }
  try {
    writeFileSync(WEB_CACHE, `${url}\n`, { mode: 0o600 })
  } catch {
    /* cache is a convenience, not a requirement */
  }
  state.web = url
  return url
}

function gitBranch(cwd) {
  const out = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
    shell: false,
  })
  return out.status === 0 ? out.stdout.trim() : undefined
}

function parseArgv(argv) {
  const out = { prompt: undefined, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-p' || arg === '--prompt') out.prompt = argv[++i]
    else if (arg === '-v' || arg === '--verbose') out.verbose = true
    else if (arg === '-m' || arg === '--model') out.model = argv[++i]
    else if (arg === '-e' || arg === '--effort') out.effort = argv[++i]
    else if (out.prompt === undefined) out.prompt = arg
  }
  return out
}

// One matcher behind both `/model pro` and `--model pro`: a number picks from
// the list, anything else matches on name, so aliases stay readable.
async function chooseOption(link, optionId, wanted) {
  const option = state.options.find((o) => o.id === optionId)
  if (!option) return { error: `no option "${optionId}"` }
  const choices = flattenOption(option)
  const choice =
    choices[Number(wanted) - 1] ??
    choices.find((c) => c.name.toLowerCase().includes(String(wanted).toLowerCase()))
  if (!choice) return { error: `no ${optionId} matching "${wanted}"` }
  const res = await link.conn
    .setSessionConfigOption({ sessionId: state.sessionId, configId: optionId, value: choice.value })
    .catch((e) => ({ error: e.message }))
  if (res?.error) return res
  option.currentValue = choice.value
  if (optionId === 'model') state.model = choice.name
  if (optionId === 'reasoning_effort') state.effort = choice.name
  return { name: choice.name }
}

// The harness runs as a child process, so it can die under you: killed by
// hand, out of memory, a bad settings edit. Rather than leaving a prompt that
// answers every turn with "connection closed", reconnect and say what was lost.
async function reconnect(live) {
  warn('the harness connection died — reconnecting')
  try {
    live.link?.close()
  } catch {
    /* already gone */
  }
  const link = await connect({ cwd: process.cwd(), handlers: live.handlers })
  const fresh = await link.conn.newSession({ cwd: process.cwd(), mcpServers: readMcpServers().servers })
  live.link = link
  state.sessionId = fresh.sessionId
  state.options = fresh.configOptions ?? state.options
  state.used = 0
  state.todos = []
  notice(`new session ${fresh.sessionId.slice(0, 8)} — earlier turns are not in its history`)
  return link
}

async function runTurn(link, input, live) {
  state.answer = undefined
  state.thought = undefined
  state.messageId = undefined
  state.calls.clear()
  state.trace = []
  state.busy = true
  markTurnStart()
  setSpinnerLabel('thinking')
  startSpinner('thinking')
  bridge.report('working', { message: input, sessionId: state.sessionId }).catch(() => {})
  const started = Date.now()
  let result = await link.conn
    .prompt({ sessionId: state.sessionId, prompt: [{ type: 'text', text: input }] })
    .catch((err) => ({ stopReason: 'error', error: err.message }))

  if (/connection closed|bridge has been disposed/i.test(result.error ?? '') && live) {
    const revived = await reconnect(live).catch((err) => ({ error: err.message }))
    if (revived?.error) fail(revived.error)
    else {
      result = await revived.conn
        .prompt({ sessionId: state.sessionId, prompt: [{ type: 'text', text: input }] })
        .catch((err) => ({ stopReason: 'error', error: err.message }))
    }
  }
  state.busy = false
  stopSpinner()
  flushThought()
  flushAnswer()
  // A turn can end while subagents are still out: their tool calls never
  // completed. Reporting idle there says "done" about a pane that is still
  // working, so the outstanding count decides the state.
  const outstanding = [...state.calls.values()].filter((c) => c.key === 'agent').length
  if (outstanding) {
    warn(`${outstanding} subagent${outstanding > 1 ? 's' : ''} still running — ask again to collect`)
  }
  if (result.error) fail(result.error)
  footer([
    outstanding ? `${outstanding} subagent${outstanding > 1 ? 's' : ''} out` : '',
    bar(state.used, state.size),
    tokens(state.used, state.size),
    seconds(Date.now() - started),
    result.stopReason !== 'end_turn' ? result.stopReason : '',
  ])
  const closing = result.error || result.stopReason === 'refusal' ? 'blocked' : outstanding ? 'working' : 'idle'
  bridge
    .report(closing, {
      message: result.error ?? (outstanding ? `${outstanding} subagents running` : state.model),
      sessionId: state.sessionId,
    })
    .catch(() => {})
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

  const mcp = readMcpServers({ cwd })
  const session = await link.conn.newSession({ cwd, mcpServers: mcp.servers })
  state.sessionId = session.sessionId
  state.options = session.configOptions ?? []
  const modelOpt = state.options.find((o) => o.id === 'model')
  const effortOpt = state.options.find((o) => o.id === 'reasoning_effort')
  state.model = modelOpt ? labelOfValue(modelOpt, modelOpt.currentValue) : 'deepseek'
  state.effort = effortOpt ? labelOfValue(effortOpt, effortOpt.currentValue) : undefined

  if (args.model) {
    const applied = await chooseOption(link, 'model', args.model)
    if (applied.error) warn(applied.error)
  }
  if (args.effort) {
    const applied = await chooseOption(link, 'reasoning_effort', args.effort)
    if (applied.error) warn(applied.error)
  }

  const live = { link, handlers: { onUpdate: render } }

  bridge.attachExitHandlers()
  bridge.report('idle', { message: state.model, sessionId: state.sessionId }).catch(() => {})

  if (args.prompt) {
    await runTurn(link, args.prompt, live)
    await bridge.release().catch(() => {})
    link.close()
    process.exit(0)
  }

  const repo = cwd.split('/').pop()
  const branch = gitBranch(cwd)
  const space = herdrSpaceOfPane()
  process.stdout.write(
    `\n ${sky('◆')} ${bold(repo)}${branch ? dim(` ${branch}`) : ''}${space && space !== repo ? dim(`  in ${space}`) : ''}  ${dim('·')}  ${sky(state.model)}${state.effort ? dim(` (${state.effort.toLowerCase()})`) : ''}\n`,
  )
  if (mcp.servers.length || mcp.skipped.length) {
    const loaded = mcp.servers.map((m) => m.name).join(' ')
    process.stdout.write(`   ${dim('mcp')}  ${dim(loaded || 'none')}\n`)
    if (mcp.skipped.length) {
      process.stdout.write(`        ${dim(`${mcp.skipped.join(' ')} need OAuth — not portable`)}\n`)
    }
  }
  process.stdout.write(
    `   ${dim(`session ${state.sessionId.slice(0, 8)}`)}  ${dim('·')}  ${dim('/help for commands')}\n`,
  )

  // Never block the prompt on a server: the link arrives when it arrives, and
  // says so plainly when it cannot.
  if (!process.env.DSX_NO_WEB) {
    void ensureWeb({ quiet: true, timeoutMs: 8000 }).then((url) => {
      if (url) notice(url)
      else notice(dim('no web UI — port busy; stop the old server and run /web'))
    })
  }

  // Whatever sat in the terminal's input buffer before we got here — replayed
  // scrollback, a paste into a dead prompt, keys pressed during startup — is
  // not a queue of tasks. Drop it before readline can read it as lines.
  if (process.stdin.isTTY) {
    process.stdin.resume()
    while (process.stdin.read() !== null) {
      /* discard */
    }
    process.stdin.pause()
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.on('close', () => {
    inputClosed = true
  })

  const queue = []
  let cancelling = false
  let running = false

  const showPrompt = () => {
    if (inputClosed || rl.closed) return
    rl.setPrompt(`\n${sky('›')} `)
    rl.prompt()
  }

  rl.on('SIGINT', () => {
    if (state.busy && !cancelling) {
      cancelling = true
      link.conn.cancel({ sessionId: state.sessionId }).catch(() => {})
      warn('cancelling turn')
      return
    }
    if (queue.length) {
      queue.length = 0
      warn('queue cleared')
      showPrompt()
      return
    }
    rl.close()
  })

  const handle = async (input) => {
    if (input.startsWith('/')) return command(input)
    cancelling = false
    await runTurn(link, input, live)
    return true
  }

  const command = async (input) => {
    const [cmd, ...rest] = input.slice(1).split(/\s+/)
    if (cmd === 'quit' || cmd === 'q') {
      rl.close()
      return false
    }
    if (cmd === 'help') {
      process.stdout.write(`${HELP}\n`)
      return true
    }
    if (cmd === 'verbose') {
      state.verbose = !state.verbose
      notice(`reasoning ${state.verbose ? 'shown' : 'folded'}`)
      return true
    }
    if (cmd === 'model' || cmd === 'effort' || cmd === 'set') {
      const wantedId = cmd === 'set' ? rest[0] : cmd === 'model' ? 'model' : 'reasoning_effort'
      const option = state.options.find((o) => o.id === wantedId)
      if (!option) {
        warn(`no option "${wantedId}"; try ${state.options.map((o) => o.id).join(', ')}`)
        return true
      }
      const choices = flattenOption(option)
      const picked = cmd === 'set' ? rest.slice(1).join(' ') : rest.join(' ')
      if (!picked) {
        choices.forEach((c, i) => {
          const here = c.value === option.currentValue
          step(here ? 'agent' : 'tool', `${i + 1}. ${c.name}${c.group ? dim(`  ${c.group}`) : ''}${here ? sky('  ←') : ''}`)
        })
        notice(`/${cmd} <number or name>`)
        return true
      }
      const applied = await chooseOption(link, option.id, picked)
      if (applied.error) warn(applied.error)
      else notice(`${option.name}: ${applied.name}`)
      return true
    }
    if (cmd === 'queue') {
      if (!queue.length) warn('nothing queued')
      else queue.forEach((q, i) => step('tool', `${i + 1}. ${q}`))
      return true
    }
    if (cmd === 'todos') {
      if (!state.todos.length) warn('no to-do list in this session yet')
      else todos(state.todos)
      return true
    }
    if (cmd === 'trace') {
      if (!state.trace.length) warn('no tool calls in the last turn')
      else
        for (const t of state.trace) {
          step(t.key, t.detail)
          if (t.output) result(t.key, t.output, seconds(t.took))
        }
      return true
    }
    if (cmd === 'spaces') {
      const spaces = herdrSpaces()
      if (!spaces) warn('no herdr server to read workspaces from')
      else {
        for (const w of spaces) {
          step(w.status === 'working' ? 'agent' : 'tool', `${w.label}${w.cwd ? dim(`  ${w.cwd}`) : ''}`)
        }
        notice('/space <name> starts a session there')
      }
      return true
    }
    if (cmd === 'space') {
      const wanted = rest.join(' ').toLowerCase()
      const match = (herdrSpaces() ?? []).find((w) => w.cwd && w.label.toLowerCase().startsWith(wanted))
      if (!match) warn(`no herdr workspace matching "${wanted}" with a known path`)
      else {
        const moved = await link.conn.newSession({ cwd: match.cwd, mcpServers: readMcpServers({ cwd: match.cwd }).servers })
        state.sessionId = moved.sessionId
        state.used = 0
        process.chdir(match.cwd)
        notice(`${match.label}  ${match.cwd}`)
      }
      return true
    }
    if (cmd === 'web') {
      const url = await ensureWeb()
      if (url) notice(url)
      return true
    }
    if (cmd === 'sessions') {
      const list = await link.conn.listSessions({}).catch((e) => ({ error: e.message }))
      for (const item of list.sessions ?? []) {
        step(item.sessionId === state.sessionId ? 'agent' : 'tool', `${item.sessionId}  ${item.title ?? ''}`)
      }
      if (list.error) warn(list.error)
      return true
    }
    if (cmd === 'resume') {
      const id = rest[0]
      if (!id) warn('usage: /resume <session-id>')
      else {
        const resumed = await link.conn.resumeSession({ sessionId: id, cwd }).catch((e) => ({ error: e.message }))
        if (resumed.error) warn(resumed.error)
        else {
          state.sessionId = id
          notice(`resumed ${id}`)
        }
      }
      return true
    }
    if (cmd === 'new') {
      const fresh = await link.conn.newSession({ cwd, mcpServers: mcp.servers })
      state.sessionId = fresh.sessionId
      state.used = 0
      state.todos = []
      notice(`new session ${fresh.sessionId}`)
      return true
    }
    warn(`unknown command: /${cmd}`)
    return true
  }

  // Anything typed during a turn is queued rather than lost, and drains in
  // order once the turn ends — the whole point of a long-running agent is that
  // you keep thinking while it works.
  const drain = async () => {
    if (running) return
    running = true
    while (queue.length) {
      const next = queue.shift()
      const keepGoing = await handle(next)
      if (keepGoing === false) {
        running = false
        return
      }
    }
    running = false
    showPrompt()
  }

  // A pasted block arrives as several line events within a few milliseconds.
  // Nobody types that fast, so lines that land together are one message —
  // otherwise every paragraph of a pasted brief becomes its own task.
  let pasted = []
  let pasteTimer

  const submit = () => {
    pasteTimer = undefined
    const input = pasted.join('\n').trim()
    pasted = []
    if (!input) {
      if (!running) showPrompt()
      return
    }
    queue.push(input)
    if (running) notice(`queued (${queue.length})`)
    else void drain()
  }

  rl.on('line', (raw) => {
    pasted.push(raw)
    clearTimeout(pasteTimer)
    pasteTimer = setTimeout(submit, 25)
  })

  showPrompt()
  await new Promise((resolve) => rl.once('close', resolve))
  await bridge.release().catch(() => {})
  link.close()
  process.exit(0)
}

main().catch((err) => {
  fail(err.stack ?? err.message)
  process.exit(1)
})
