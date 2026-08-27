import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import http from 'http'
import { CursorHooksConnector } from '../connector.js'
import type { NormalizedAgentEvent } from '../../../types/index.js'

describe('CursorHooksConnector', () => {
  let tmpDir: string
  let connector: CursorHooksConnector

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-hooks-conn-'))
    connector = new CursorHooksConnector({
      workingDir: '/test/workspace',
      hooksPath: path.join(tmpDir, 'hooks.json'),
    })
  })

  afterEach(async () => {
    await connector.disconnect()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('initializes with correct metadata', () => {
    expect(connector.id).toBe('cursor-hooks')
    expect(connector.name).toBe('Cursor Hooks')
    expect(connector.version).toBe('1.0.0')
    expect(connector.capabilities.tools).toContain('edit_file')
    expect(connector.capabilities.tools).toContain('bash')
    expect(connector.capabilities.tools).toContain('read_file')
  })

  it('connect starts bridge and installs hooks', async () => {
    await connector.connect()
    expect(connector['bridge'].port).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(tmpDir, 'hooks.json'))).toBe(true)
  })

  it('emits events from bridge through onEvent handlers', async () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))
    await connector.connect()

    const port = connector['bridge'].port
    const secret = connector['secret']
    const payload = JSON.stringify({
      hook_event_name: 'preToolUse',
      timestamp: '2026-08-27T10:00:00Z',
      cwd: '/workspace',
      session_id: 'sess-1',
      tool_name: 'Shell',
      tool_input: { command: 'echo hello' },
    })

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/hook',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-meetless-secret': secret,
        },
      })
      req.on('response', (res) => {
        expect(res.statusCode).toBe(200)
        resolve()
      })
      req.on('error', reject)
      req.end(payload)
    })

    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('bash')
    expect(events[0].params).toEqual({ command: 'echo hello' })
  })

  it('disconnect stops bridge and uninstalls hooks', async () => {
    await connector.connect()
    const port = connector['bridge'].port
    await connector.disconnect()

    const err = await new Promise<Error | null>((resolve) => {
      const server = http.createServer()
      server.listen(port, '127.0.0.1', () => { server.close(() => resolve(null)) })
      server.on('error', resolve)
    })
    expect(err).toBeNull()

    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf-8'))
    const meetlessHooks = Object.values(content.hooks as Record<string, Array<{ command: string }>>)
      .flat()
      .filter(h => h.command.includes('bridge-client.mjs'))
    expect(meetlessHooks).toHaveLength(0)
  })

  it('generates a random secret on construction', () => {
    const conn1 = new CursorHooksConnector({ workingDir: '/a', hooksPath: '/a/hooks.json' })
    const conn2 = new CursorHooksConnector({ workingDir: '/b', hooksPath: '/b/hooks.json' })
    expect(conn1['secret']).toBeTruthy()
    expect(conn2['secret']).toBeTruthy()
    expect(conn1['secret']).not.toBe(conn2['secret'])
  })
})
