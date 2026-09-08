const useColour = process.stdout.isTTY && process.env.NO_COLOR === undefined

const code = (n) => (s) => (useColour ? `[${n}m${s}[0m` : s)
export const dim = code(2)
export const bold = code(1)
export const cyan = code(36)
export const yellow = code(33)
export const red = code(31)

const LABEL_WIDTH = 9

export function step(label, text = '') {
  const pad = label.padEnd(LABEL_WIDTH)
  process.stdout.write(dim(`  ${pad} ${oneLine(text)}\n`))
}

export function oneLine(text, max = Math.max(40, (process.stdout.columns || 100) - 16)) {
  const flat = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function answer(text) {
  process.stdout.write(`\n${text.trimEnd()}\n`)
}

export function footer(parts) {
  const line = parts.filter(Boolean).join(dim(' · '))
  if (line) process.stdout.write(dim(`\n  ${line}\n`))
}

export function notice(text) {
  process.stdout.write(cyan(`  ${text}\n`))
}

export function warn(text) {
  process.stdout.write(yellow(`  ${text}\n`))
}

export function fail(text) {
  process.stdout.write(red(`  ${text}\n`))
}

export function tokens(used, size) {
  if (!used) return ''
  const k = (n) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
  return size ? `${k(used)} / ${k(size)} tokens` : `${k(used)} tokens`
}

export function seconds(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(0)}s` : `${ms}ms`
}
