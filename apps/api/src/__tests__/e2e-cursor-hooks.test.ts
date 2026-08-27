import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../app.js'
import { prisma } from '@meetless/database/client'
import { CursorHooksConnector } from '@meetless/shared/connectors'
import type { NormalizedAgentEvent } from '@meetless/shared/types'

let app: Awaited<ReturnType<typeof buildApp>>
const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let teamId: string
let userId: string
let workspaceId: string

beforeAll(async () => {
  teamId = (await prisma.team.create({ data: { name: 'Cursor E2E Team', slug: `cursor-e2e-${randSuffix()}` } })).id
  userId = (await prisma.user.create({ data: { clerkId: `clerk_cursor_${randSuffix()}`, email: `cursor-e2e-${randSuffix()}@example.com` } })).id
  workspaceId = (await prisma.workspace.create({ data: { teamId, name: 'Cursor E2E Workspace' } })).id

  app = await buildApp()
  await app.ready()
  await app.listen({ port: 0 })
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.normalizedEvent.deleteMany()
  await prisma.conflict.deleteMany()
  await prisma.session.deleteMany()
  await prisma.connector.deleteMany()
})

async function createSession(name: string) {
  return prisma.session.create({ data: { workspaceId, userId, name } })
}

describe('E2E: Cursor Hooks → reconciliation', () => {
  it('Cursor edit_file event enters reconciliation and detects conflict with Claude', async () => {
    const session = await createSession('Cursor-Claude Conflict Test')

    await prisma.connector.upsert({
      where: { id: 'cursor-hooks' },
      update: {},
      create: { id: 'cursor-hooks', name: 'Cursor Hooks', version: '1.0.0', capabilities: {} }
    })
    await prisma.connector.upsert({
      where: { id: 'claude-code' },
      update: {},
      create: { id: 'claude-code', name: 'Claude Code', version: '1.0.0', capabilities: {} }
    })

    const cursorEvent = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'cursor-sess-1',
        tool: 'edit_file',
        params: { path: 'src/app.ts', content: 'cursor version of the code' },
        connectorId: 'cursor-hooks',
        connectorVersion: '1.0.0',
        mcpEventId: `cursor-e2e-${randSuffix()}`
      }
    })
    expect(cursorEvent.statusCode).toBe(201)

    const claudeEvent = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/app.ts', content: 'claude version of the code' },
        result: { success: true },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: `claude-e2e-${randSuffix()}`
      }
    })
    expect(claudeEvent.statusCode).toBe(201)

    const events = await prisma.normalizedEvent.findMany({ where: { sessionId: session.id } })
    expect(events).toHaveLength(2)
    expect(events.map(e => e.connectorId).sort()).toEqual(['claude-code', 'cursor-hooks'])

    const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].file).toBe('src/app.ts')
    expect(conflicts[0].agents).toEqual(expect.arrayContaining(['cursor-sess-1', 'claude-1']))
    expect(conflicts[0].status).toBe('PENDING')

    const resp = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/conflicts` })
    expect(resp.statusCode).toBe(200)
    const apiConflicts = JSON.parse(resp.payload)
    expect(apiConflicts).toHaveLength(1)
    expect(apiConflicts[0].agents).toEqual(expect.arrayContaining(['cursor-sess-1', 'claude-1']))
  })

  it('Cursor and Codex editing different files produces no conflict', async () => {
    const session = await createSession('Cursor-Codex No Conflict')

    await prisma.connector.upsert({
      where: { id: 'cursor-hooks' },
      update: {},
      create: { id: 'cursor-hooks', name: 'Cursor Hooks', version: '1.0.0', capabilities: {} }
    })
    await prisma.connector.upsert({
      where: { id: 'codex-cli' },
      update: {},
      create: { id: 'codex-cli', name: 'Codex CLI', version: '1.0.0', capabilities: {} }
    })

    const a = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'cursor-sess-1',
        tool: 'edit_file',
        params: { path: 'src/a.ts', content: 'cursor edit' },
        connectorId: 'cursor-hooks',
        connectorVersion: '1.0.0',
        mcpEventId: `cursor-diff-${randSuffix()}`
      }
    })
    expect(a.statusCode).toBe(201)

    const b = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'codex-1',
        tool: 'edit_file',
        params: { path: 'src/b.ts', patch: 'x' },
        connectorId: 'codex-cli',
        connectorVersion: '1.0.0',
        mcpEventId: `codex-diff-${randSuffix()}`
      }
    })
    expect(b.statusCode).toBe(201)

    const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
    expect(conflicts).toHaveLength(0)
  })

  it('CursorHooksConnector connects and emits events through bridge', async () => {
    const session = await createSession('Cursor Bridge Test')
    const connector = new CursorHooksConnector({
      workingDir: process.cwd(),
      hooksPath: `${process.env.TMPDIR ?? process.env.TMP ?? '/tmp'}/cursor-hooks-e2e-${randSuffix()}.json`,
    })

    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    await connector.connect()

    const http = await import('http')
    const port = connector['bridge'].port
    const secret = connector['secret']

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
      req.end(JSON.stringify({
        hook_event_name: 'afterFileEdit',
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
        session_id: session.id,
        tool_name: 'Write',
        tool_input: { file_path: 'src/app.ts' },
        tool_output: 'diff content here',
      }))
    })

    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('edit_file')
    expect(events[0].params).toEqual({ path: 'src/app.ts', content: 'diff content here' })

    await connector.disconnect()
  })
})
