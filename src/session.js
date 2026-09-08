import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const KEY_FILE = `${process.env.HOME}/.config/deepseek/key`

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    return readFileSync(KEY_FILE, 'utf8').trim()
  } catch {
    return undefined
  }
}

function toWebStreams(child) {
  return ndJsonStream(
    new WritableStream({ write: (chunk) => void child.stdin.write(chunk) }),
    new ReadableStream({
      start(ctrl) {
        child.stdout.on('data', (d) => ctrl.enqueue(new Uint8Array(d)))
        child.stdout.on('end', () => ctrl.close())
        child.stdout.on('error', () => ctrl.close())
      },
    }),
  )
}

// Spawns `dsh --profile acp` and speaks the Agent Client Protocol to it.
// handlers: { onUpdate(update), onPermission(request) -> optionId }
export async function connect({ cwd = process.cwd(), handlers = {}, onExit } = {}) {
  const key = apiKey()
  if (!key) throw new Error(`no DeepSeek key: set DEEPSEEK_API_KEY or write ${KEY_FILE}`)

  const child = spawn('dsh', ['--profile', 'acp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DEEPSEEK_API_KEY: key },
  })
  const stderr = []
  child.stderr.on('data', (d) => {
    stderr.push(String(d))
    if (stderr.length > 40) stderr.shift()
  })
  child.on('exit', (codeNum) => onExit?.(codeNum, stderr.join('')))

  const conn = new ClientSideConnection(
    () => ({
      async sessionUpdate(payload) {
        handlers.onUpdate?.(payload.update, payload.sessionId)
      },
      async requestPermission(request) {
        const optionId = await handlers.onPermission?.(request)
        if (!optionId) return { outcome: { outcome: 'cancelled' } }
        return { outcome: { outcome: 'selected', optionId } }
      },
      async readTextFile({ path, line, limit }) {
        let content = readFileSync(path, 'utf8')
        if (line != null || limit != null) {
          const lines = content.split('\n')
          const from = Math.max(0, (line ?? 1) - 1)
          content = lines.slice(from, limit != null ? from + limit : undefined).join('\n')
        }
        return { content }
      },
      async writeTextFile() {
        return null
      },
    }),
    toWebStreams(child),
  )

  const info = await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
  })

  return {
    conn,
    child,
    info,
    stderr: () => stderr.join(''),
    close() {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    },
  }
}

export function modelOf(session) {
  const opt = session?.configOptions?.find((o) => o.id === 'model')
  if (!opt?.currentValue) return undefined
  try {
    const parsed = JSON.parse(opt.currentValue)
    return Array.isArray(parsed) ? parsed[parsed.length - 1] : String(parsed)
  } catch {
    return String(opt.currentValue)
  }
}
