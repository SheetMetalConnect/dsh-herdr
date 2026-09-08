import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

import { insideWorkspace } from '../src/session.js'

// The agent decides which path to ask for, and the agent has read this repo's
// files. These are the paths a prompt injection would reach for.
test('refuses paths outside the workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.txt'), 'ok')

  assert.equal(insideWorkspace(join(root, 'src', 'a.txt'), root), true)
  assert.equal(insideWorkspace('src/a.txt', root), true)
  assert.equal(insideWorkspace(root, root), true)

  assert.equal(insideWorkspace(join(homedir(), '.config/deepseek/key'), root), false)
  assert.equal(insideWorkspace(join(homedir(), '.ssh/id_rsa'), root), false)
  assert.equal(insideWorkspace('/etc/passwd', root), false)
  assert.equal(insideWorkspace(join(root, '..', 'escape.txt'), root), false)
  assert.equal(insideWorkspace(`${root}-sibling/secret`, root), false)
  assert.equal(insideWorkspace('', root), false)
  assert.equal(insideWorkspace(undefined, root), false)
})

test('a symlink pointing out of the workspace does not get through', () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-'))
  const outside = mkdtempSync(join(tmpdir(), 'out-'))
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))

  assert.equal(insideWorkspace(join(root, 'link.txt'), root), false)
})
