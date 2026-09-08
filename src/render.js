const useColour = process.stdout.isTTY && process.env.NO_COLOR === undefined

// Catppuccin Frappé, the palette the rest of the desk already uses.
const FRAPPE = {
  sky: [153, 209, 219],
  blue: [140, 170, 238],
  green: [166, 209, 137],
  yellow: [229, 200, 144],
  red: [231, 130, 132],
  mauve: [202, 158, 230],
  peach: [239, 159, 118],
  overlay: [131, 139, 167],
}

const paint = (rgb) => (s) => (useColour ? `[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}[0m` : s)
export const sky = paint(FRAPPE.sky)
export const blue = paint(FRAPPE.blue)
export const green = paint(FRAPPE.green)
export const yellow = paint(FRAPPE.yellow)
export const red = paint(FRAPPE.red)
export const mauve = paint(FRAPPE.mauve)
export const peach = paint(FRAPPE.peach)
export const muted = paint(FRAPPE.overlay)
export const dim = (s) => (useColour ? `[2m${s}[0m` : s)
export const bold = (s) => (useColour ? `[1m${s}[0m` : s)
export const italic = (s) => (useColour ? `[3m${s}[0m` : s)

// icon, colour, and the label as it prints.
export const TOOLS = {
  think: ['◇', muted, 'Think'],
  bash: ['▶', peach, 'Bash'],
  read: ['▤', blue, 'Read'],
  glob: ['⌕', blue, 'Glob'],
  grep: ['⌕', blue, 'Grep'],
  edit: ['✎', yellow, 'Edit'],
  write: ['✎', yellow, 'Write'],
  fetch: ['⇣', blue, 'Fetch'],
  plan: ['☰', mauve, 'Plan'],
  agent: ['⚑', mauve, 'Agent'],
  agents: ['⚑', mauve, 'Agents'],
  skill: ['✦', mauve, 'Skill'],
  tool: ['·', muted, 'Tool'],
  failed: ['✗', red, 'Failed'],
  done: ['✓', green, 'Done'],
}

const LABEL_WIDTH = 7

let spinnerTimer
let spinnerFrame = 0
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function startSpinner(text = 'working') {
  if (!process.stdout.isTTY || spinnerTimer) return
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % FRAMES.length
    process.stdout.write(`\r  ${sky(FRAMES[spinnerFrame])} ${dim(text)}[K`)
  }, 90)
  spinnerTimer.unref?.()
}

export function stopSpinner() {
  if (!spinnerTimer) return
  clearInterval(spinnerTimer)
  spinnerTimer = undefined
  if (process.stdout.isTTY) process.stdout.write('\r[K')
}

// Clears the spinner, prints, then puts it back — so streaming lines never
// fight the animation for the same row.
function line(text) {
  const running = Boolean(spinnerTimer)
  const label = spinnerLabel
  stopSpinner()
  process.stdout.write(text)
  if (running) startSpinner(label)
}

let spinnerLabel = 'working'
export function setSpinnerLabel(text) {
  spinnerLabel = text
}

// Elapsed seconds in the gutter turn every line into a timeline: you can see
// where the run actually spent itself instead of guessing from the total.
let turnStart = Date.now()
export function markTurnStart() {
  turnStart = Date.now()
}

function gutter() {
  const secs = Math.floor((Date.now() - turnStart) / 1000)
  return muted(`${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`)
}

export function step(key, text = '', depth = 0) {
  const [icon, colour, label] = TOOLS[key] ?? TOOLS.tool
  const indent = '  '.repeat(depth)
  line(`${gutter()} ${indent}${colour(icon)} ${colour(label.padEnd(LABEL_WIDTH))} ${dim(oneLine(text))}\n`)
}

export function oneLine(text, max = Math.max(40, (process.stdout.columns || 100) - 20)) {
  const flat = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const WRAP_INDENT = '      '

// Wraps to the pane and renders the bits of markdown the harness actually
// emits, so an answer reads as prose instead of a wall with literal asterisks.
const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line)
const isTableRule = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line)

function cells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
}

// A markdown table printed as raw pipes is unreadable at terminal width, and
// the model reaches for one whenever it compares things.
function renderTable(rows, out) {
  const parsed = rows.filter((r) => !isTableRule(r)).map(cells)
  const columns = Math.max(...parsed.map((r) => r.length))
  const available = (process.stdout.columns || 100) - WRAP_INDENT.length - (columns - 1) * 3

  // Give every column what its widest cell needs, then take the overshoot off
  // the widest columns until it fits. Cells wrap inside their column instead of
  // running past the edge and dropping the tail to column 0.
  const wanted = Array.from({ length: columns }, (_, i) =>
    Math.max(...parsed.map((r) => visibleLength(inline(r[i] ?? '')))),
  )
  const widths = [...wanted]
  let over = widths.reduce((a, b) => a + b, 0) - available
  while (over > 0 && Math.max(...widths) > 8) {
    const widest = widths.indexOf(Math.max(...widths))
    widths[widest] -= 1
    over -= 1
  }

  const sep = dim(' │ ')
  // Once cells wrap, consecutive rows read as one block; a blank line between
  // them is the cheapest way to keep the rows apart.
  const anyWrapped = parsed.some((row) =>
    widths.some((w, i) => visibleLength(inline(row[i] ?? '')) > w),
  )
  parsed.forEach((row, index) => {
    const style = index === 0 ? (t) => bold(sky(t)) : (t) => t
    const wrapped = widths.map((w, i) => wrap(style(inline(row[i] ?? '')), w))
    const height = Math.max(...wrapped.map((c) => c.length))
    for (let n = 0; n < height; n++) {
      const cellsOut = wrapped.map((c, i) => {
        const text = c[n] ?? ''
        return text + ' '.repeat(Math.max(0, widths[i] - visibleLength(text)))
      })
      out.push(`${WRAP_INDENT}${cellsOut.join(sep).trimEnd()}`)
    }
    if (index === 0) {
      out.push(`${WRAP_INDENT}${muted(widths.map((w) => '─'.repeat(w)).join('─┼─'))}`)
    } else if (anyWrapped && index < parsed.length - 1) {
      out.push('')
    }
  })
}

export function answer(text) {
  const width = Math.max(40, (process.stdout.columns || 100) - WRAP_INDENT.length - 2)
  const out = []
  let inFence = false
  const lines = text.trimEnd().split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!inFence && isTableRow(raw)) {
      const rows = []
      while (i < lines.length && isTableRow(lines[i])) rows.push(lines[i++])
      i--
      renderTable(rows, out)
      continue
    }
    // Inside a fence every space is meaningful, so it goes through untouched.
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      out.push(`${WRAP_INDENT}${muted(raw.trim())}`)
      continue
    }
    if (inFence) {
      out.push(`${WRAP_INDENT}${peach(raw)}`)
      continue
    }
    const heading = raw.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      out.push(`${WRAP_INDENT}${bold(sky(heading[2]))}`)
      continue
    }
    const bullet = raw.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)
    const body = bullet ? bullet[3] : raw
    const lead = bullet ? `${WRAP_INDENT}${bullet[1]}${sky('•')} ` : WRAP_INDENT
    const cont = bullet ? `${WRAP_INDENT}${bullet[1]}  ` : WRAP_INDENT
    if (!body.trim()) {
      out.push('')
      continue
    }
    // Nested bullets carry their own indent, so the usable width shrinks with
    // depth; measuring against the flat width lets the terminal wrap instead,
    // which drops the tail to column 0 mid-word.
    const usable = Math.max(24, width - visibleLength(cont) + WRAP_INDENT.length)
    for (const [n, chunk] of wrap(inline(body), usable).entries()) {
      out.push(`${n === 0 ? lead : cont}${chunk}`)
    }
  }
  line(`\n${out.join('\n')}\n`)
}

function inline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => bold(t))
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, lead, t) => `${lead}${italic(t)}`)
    .replace(/`([^`]+)`/g, (_, t) => peach(t))
}

// Width has to be measured on the visible text, not the bytes, or every styled
// word would count its escape codes as characters and wrap far too early.
function visibleLength(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '').length
}

function wrap(text, width) {
  const words = text.split(/\s+/).filter(Boolean)
  const lines = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (visibleLength(candidate) > width && current) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

// Closes a turn: a rule across the pane with the numbers sitting on its right
// end, so every turn ends at the same place no matter how long the answer was.
export function footer(parts) {
  const text = parts.filter(Boolean).join(dim('  ·  '))
  if (!text) return
  const width = (process.stdout.columns || 100) - 2
  const rule = Math.max(0, width - visibleLength(text) - 2)
  line(`\n  ${muted('─'.repeat(rule))}  ${text}\n`)
}

export function notice(text) {
  line(`  ${sky('→')} ${text}\n`)
}

export function warn(text) {
  line(`  ${yellow('!')} ${text}\n`)
}

export function fail(text) {
  line(`  ${red('✗')} ${text}\n`)
}

// Context fill as a short bar, because "80.2K / 1M" does not tell you how close
// you are to a compaction.
export function bar(used, size, width = 10) {
  if (!used || !size) return ''
  const ratio = Math.min(1, used / size)
  // Never round a live context down to an empty bar; 1% still means "started".
  const filled = Math.max(1, Math.round(ratio * width))
  const shade = ratio > 0.85 ? red : ratio > 0.6 ? yellow : green
  return `${shade('█'.repeat(filled))}${muted('░'.repeat(width - filled))}`
}

const TODO_MARK = {
  completed: () => green('✓'),
  in_progress: () => sky('◐'),
  pending: () => muted('○'),
  cancelled: () => muted('✗'),
}

export function todos(items) {
  const counts = items.reduce((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {})
  const summary = ['in_progress', 'pending', 'completed']
    .filter((k) => counts[k])
    .map((k) => `${counts[k]} ${k.replace('_', ' ')}`)
    .join(', ')
  // The plan is the one block worth interrupting the log for, so it gets air
  // around it and the live item is the only line at full brightness.
  line('\n')
  line(`${gutter()} ${mauve('\u2630')} ${bold(mauve('To-dos'.padEnd(LABEL_WIDTH)))} ${dim(summary)}\n`)
  for (const t of items) {
    const mark = (TODO_MARK[t.status] ?? TODO_MARK.pending)()
    const text = oneLine(t.content)
    const body =
      t.status === 'in_progress'
        ? bold(sky(text))
        : t.status === 'completed'
          ? muted(text)
          : dim(text)
    line(`      ${mauve('\u2502')}  ${mark} ${body}\n`)
  }
  line('\n')
}

export function result(key, text, extra = '') {
  const [, colour] = TOOLS[key] ?? TOOLS.tool
  const tail = extra ? dim(`  ${extra}`) : ''
  line(`      ${colour('└')} ${dim(oneLine(text))}${tail}\n`)
}

export function tokens(used, size) {
  if (!used) return ''
  const pct = size ? ` (${Math.round((used / size) * 100)}%)` : ''
  const k = (n) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}K`
        : String(n)
  return size ? `${k(used)} / ${k(size)}${pct}` : `${k(used)} tokens`
}

export function seconds(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(0)}s` : `${ms}ms`
}
