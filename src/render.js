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
export const cyan = sky

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

export function step(key, text = '', depth = 0) {
  const [icon, colour, label] = TOOLS[key] ?? TOOLS.tool
  const indent = '  '.repeat(depth + 1)
  line(`${indent}${colour(icon)} ${colour(label.padEnd(LABEL_WIDTH))} ${dim(oneLine(text))}\n`)
}

export function oneLine(text, max = Math.max(40, (process.stdout.columns || 100) - 20)) {
  const flat = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function answer(text) {
  line(`\n${text.trimEnd()}\n`)
}

export function footer(parts) {
  const text = parts.filter(Boolean).join(dim(' · '))
  if (text) line(dim(`\n  ${text}\n`))
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

export function tokens(used, size) {
  if (!used) return ''
  const k = (n) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}K`
        : String(n)
  return size ? `${k(used)} / ${k(size)} tokens` : `${k(used)} tokens`
}

export function seconds(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(0)}s` : `${ms}ms`
}
