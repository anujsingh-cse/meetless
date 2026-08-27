import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { HookInstaller } from '../hook-installer.js'

describe('HookInstaller', () => {
  let tmpDir: string
  let installer: HookInstaller

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-hooks-test-'))
    installer = new HookInstaller({
      hooksPath: path.join(tmpDir, 'hooks.json'),
      hookScriptPath: '/path/to/bridge-client.mjs',
      secret: 'test-secret-123',
      bridgePort: 9999,
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates hooks.json when it does not exist', async () => {
    await installer.install()
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf-8'))
    expect(content.version).toBe(1)
    expect(content.hooks.preToolUse).toBeDefined()
    expect(content.hooks.preToolUse.length).toBeGreaterThan(0)
    expect(content.hooks.preToolUse[0].command).toContain('bridge-client.mjs')
  })

  it('merges hooks into existing hooks.json without overwriting', async () => {
    const existing = {
      version: 1,
      hooks: {
        preToolUse: [{ command: 'my-existing-hook.sh', matcher: '' }],
        postToolUse: [{ command: 'other-hook.sh', matcher: '' }],
      },
    }
    fs.writeFileSync(path.join(tmpDir, 'hooks.json'), JSON.stringify(existing))

    await installer.install()
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf-8'))

    expect(content.hooks.preToolUse).toHaveLength(2)
    expect(content.hooks.preToolUse[0].command).toBe('my-existing-hook.sh')
    expect(content.hooks.postToolUse[0].command).toBe('other-hook.sh')

    const meetlessHook = content.hooks.preToolUse.find((h: { command: string }) =>
      h.command.includes('bridge-client.mjs')
    )
    expect(meetlessHook).toBeDefined()
  })

  it('does not duplicate Meetless hooks on repeated install', async () => {
    await installer.install()
    await installer.install()
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf-8'))
    const meetlessHooks = content.hooks.preToolUse.filter((h: { command: string }) =>
      h.command.includes('bridge-client.mjs')
    )
    expect(meetlessHooks).toHaveLength(1)
  })

  it('uninstall removes only Meetless hooks', async () => {
    const existing = {
      version: 1,
      hooks: {
        preToolUse: [
          { command: 'my-hook.sh', matcher: '' },
          { command: `node /path/to/bridge-client.mjs --secret test-secret-123 --port 9999 --event preToolUse`, matcher: '' },
        ],
      },
    }
    fs.writeFileSync(path.join(tmpDir, 'hooks.json'), JSON.stringify(existing))

    await installer.uninstall()
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf-8'))
    expect(content.hooks.preToolUse).toHaveLength(1)
    expect(content.hooks.preToolUse[0].command).toBe('my-hook.sh')
  })

  it('uninstall removes entire event key if no hooks remain', async () => {
    const existing = {
      version: 1,
      hooks: {
        preToolUse: [
          { command: `node /path/to/bridge-client.mjs --secret test-secret-123 --port 9999 --event preToolUse`, matcher: '' },
        ],
      },
    }
    fs.writeFileSync(path.join(tmpDir, 'hooks.json'), JSON.stringify(existing))

    await installer.uninstall()
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf-8'))
    expect(content.hooks.preToolUse).toBeUndefined()
  })

  it('identifies Meetless hooks by bridge-client.mjs in command', () => {
    expect(installer.isMeetlessHook({ command: 'my-hook.sh', matcher: '' })).toBe(false)
    expect(installer.isMeetlessHook({
      command: 'node /path/to/bridge-client.mjs --secret x --port 1 --event preToolUse',
      matcher: '',
    })).toBe(true)
  })
})
