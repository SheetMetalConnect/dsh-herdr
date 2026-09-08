import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_CONFIG = join(homedir(), '.claude.json')

// Servers whose auth lives in an OAuth session rather than the config: the
// harness takes url + headers, and there is no header to give it.
function needsOAuth(server) {
  if (server.type !== 'http' && server.url === undefined) return false
  const url = String(server.url ?? '')
  const hasInlineSecret = /[?&](token|key|api_key)=/.test(url) || /\/mcp\/[A-Za-z0-9]{12,}/.test(url)
  const hasHeader = Boolean(server.headers && Object.keys(server.headers).length)
  return !hasInlineSecret && !hasHeader
}

function normalise(name, server) {
  if (server.command) {
    return {
      name,
      command: server.command,
      args: server.args ?? [],
      ...(server.env ? { env: server.env } : {}),
    }
  }
  if (server.url) {
    return { name, url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
  }
  return undefined
}

// Reads the MCP servers already configured for Claude Code — user scope plus
// the entry for this working directory — so one place stays the source of truth.
export function readMcpServers({ cwd = process.cwd(), configPath = CLAUDE_CONFIG } = {}) {
  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return { servers: [], skipped: [] }
  }

  const merged = { ...(config.mcpServers ?? {}) }
  for (const [projectPath, project] of Object.entries(config.projects ?? {})) {
    if (cwd === projectPath || cwd.startsWith(`${projectPath}/`)) {
      Object.assign(merged, project.mcpServers ?? {})
    }
  }

  // Opt-in only. Handing a session every server you happen to have configured
  // is a wide surface for something that usually needs one of them.
  const only = (process.env.DSX_MCP ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!only.length) return { servers: [], skipped: [] }

  const servers = []
  const skipped = []
  for (const [name, server] of Object.entries(merged)) {
    if (!only.includes(name)) continue
    if (needsOAuth(server)) {
      skipped.push(name)
      continue
    }
    const entry = normalise(name, server)
    if (entry) servers.push(entry)
  }
  return { servers, skipped }
}
