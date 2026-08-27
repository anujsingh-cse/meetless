#!/usr/bin/env tsx
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../src/app.js'
import { CursorHooksConnector, IngestionPipeline, InMemoryConnectorRegistry } from '@meetless/shared/connectors'

const prisma = new PrismaClient()

async function main() {
  console.log('=== Cursor Hooks Connector Demo ===\n')

  // 1. Start API server on an ephemeral port
  const app = await buildApp()
  await app.ready()
  await app.listen({ port: 0 })
  const addr = app.server.address()
  if (!addr || typeof addr !== 'object') throw new Error('Server not listening')
  const port = addr.port
  const baseUrl = `http://127.0.0.1:${port}`
  console.log(`API server running at ${baseUrl}`)

  // 2. Seed prerequisite rows
  const team = await prisma.team.create({ data: { name: 'Cursor Demo Team', slug: `cursor-demo-${Date.now()}` } })
  const user = await prisma.user.create({ data: { clerkId: `clerk_cursor_${Date.now()}`, email: `cursor-demo-${Date.now()}@example.com` } })
  const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'Cursor Demo Workspace' } })
  const session = await prisma.session.create({ data: { workspaceId: workspace.id, userId: user.id, name: 'Cursor Demo Session' } })
  console.log(`Session created: ${session.id}`)

  // 3. Set up connector + pipeline
  const registry = new InMemoryConnectorRegistry()
  const connector = new CursorHooksConnector({
    workingDir: process.cwd(),
    hooksPath: `${process.env.TMP ?? '/tmp'}/cursor-hooks-demo.json`,
  })
  registry.register(connector)
  const pipeline = new IngestionPipeline({ apiBaseUrl: baseUrl, registry })

  await connector.connect()
  console.log(`Connector connected — bridge on port ${connector['bridge'].port}`)
  console.log(`Secret: ${connector['secret']}`)

  // 4. Simulate Cursor editing a file (via bridge)
  console.log('\nAgent A (Cursor) editing src/app.ts ...')
  const http = await import('http')
  const bridgePort = connector['bridge'].port
  const secret = connector['secret']

  await new Promise<void>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: bridgePort,
      path: '/hook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-meetless-secret': secret,
      },
    })
    req.on('response', () => { console.log('Cursor event ingested'); resolve() })
    req.on('error', reject)
    req.end(JSON.stringify({
      hook_event_name: 'afterFileEdit',
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
      session_id: session.id,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.ts' },
      tool_output: 'function main() { return "Cursor version" }',
    }))
  })

  // 5. Simulate Claude editing the SAME file (cross-connector conflict)
  console.log('\nAgent B (Claude) editing src/app.ts ...')
  await pipeline.handleEvent({
    sessionId: session.id,
    agentId: 'claude-1',
    tool: 'edit_file',
    params: { path: 'src/app.ts', content: 'function main() { return "Claude version" }' },
    result: { success: true },
    timestamp: Date.now(),
    connectorId: 'claude-code',
    connectorVersion: '1.0.0',
    mcpEventId: 'claude-demo-1'
  })
  console.log('Claude event ingested')

  // 6. Verify conflicts via DB
  const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
  console.log(`\nConflicts detected: ${conflicts.length}`)
  for (const c of conflicts) {
    console.log(`  - File: ${c.file}, Agents: ${c.agents.join(', ')}, Status: ${c.status}`)
  }

  // 7. Verify via API
  const resp = await fetch(`${baseUrl}/api/sessions/${session.id}/conflicts`)
  const apiConflicts = await resp.json() as Array<{ file: string; agents: string[] }>
  console.log(`\nAPI GET /api/sessions/${session.id}/conflicts returned ${apiConflicts.length} conflict(s)`)

  // 8. Clean up
  await connector.disconnect()
  await app.close()
  await prisma.$disconnect()
  console.log('\nDemo complete.')
}

main().catch((err) => { console.error(err); process.exit(1) })
