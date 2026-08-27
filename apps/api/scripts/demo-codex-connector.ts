#!/usr/bin/env tsx
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../src/app.js'
import { CodexCliConnector, IngestionPipeline, InMemoryConnectorRegistry } from '@meetless/shared/connectors'

const prisma = new PrismaClient()

async function main() {
  console.log('=== Codex CLI Connector Demo ===\n')

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
  const team = await prisma.team.create({ data: { name: 'Codex Demo Team', slug: `codex-demo-${Date.now()}` } })
  const user = await prisma.user.create({ data: { clerkId: `clerk_codex_${Date.now()}`, email: `codex-demo-${Date.now()}@example.com` } })
  const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'Codex Demo Workspace' } })
  const session = await prisma.session.create({ data: { workspaceId: workspace.id, userId: user.id, name: 'Codex Demo Session' } })
  console.log(`Session created: ${session.id}`)

  // 3. Set up connector + pipeline
  const registry = new InMemoryConnectorRegistry()
  const connector = new CodexCliConnector({ workingDir: process.cwd() })
  registry.register(connector)
  const pipeline = new IngestionPipeline({ apiBaseUrl: baseUrl, registry })

  // 4. Mock child_process.spawn (plain object, no vi)
  const childProcess = await import('child_process')
  const origSpawn = childProcess.spawn
  const mockProc = {
    stdin: { write(_data: string) {} },
    stdout: { on(_evt: string, _cb: (...args: unknown[]) => void) {} },
    stderr: { on(_evt: string, _cb: (...args: unknown[]) => void) {} },
    on(_evt: string, _cb: (...args: unknown[]) => void) {},
    kill() {}
  }
  childProcess.spawn = (() => mockProc) as typeof childProcess.spawn

  await connector.connect()
  console.log('Connector connected (mocked)')

  // 5. Simulate Agent A editing a file via Codex
  console.log('\nAgent A (Codex) editing src/app.ts ...')
  await pipeline.handleEvent({
    sessionId: session.id,
    agentId: 'codex-1',
    tool: 'edit_file',
    params: { path: 'src/app.ts', patch: '@@ -1,3 +1,4 @@\n+import codex' },
    result: null,
    timestamp: Date.now(),
    connectorId: 'codex-cli',
    connectorVersion: '1.0.0',
    mcpEventId: 'codex-demo-1'
  })
  console.log('Agent A event ingested')

  // 6. Simulate Agent B (Claude) editing the SAME file (cross-connector conflict)
  console.log('\nAgent B (Claude) editing src/app.ts ...')
  await pipeline.handleEvent({
    sessionId: session.id,
    agentId: 'claude-1',
    tool: 'edit_file',
    params: { path: 'src/app.ts', content: 'function main() { return "B" }' },
    result: { success: true },
    timestamp: Date.now(),
    connectorId: 'claude-code',
    connectorVersion: '1.0.0',
    mcpEventId: 'claude-demo-1'
  })
  console.log('Agent B event ingested')

  // 7. Verify conflicts via DB
  const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
  console.log(`\nConflicts detected: ${conflicts.length}`)
  for (const c of conflicts) {
    console.log(`  - File: ${c.file}, Agents: ${c.agents.join(', ')}, Status: ${c.status}`)
  }

  // 8. Verify via API
  const resp = await fetch(`${baseUrl}/api/sessions/${session.id}/conflicts`)
  const apiConflicts = await resp.json()
  console.log(`\nAPI GET /api/sessions/${session.id}/conflicts returned ${apiConflicts.length} conflict(s)`)

  // 9. Clean up
  childProcess.spawn = origSpawn
  await app.close()
  await prisma.$disconnect()
  console.log('\nDemo complete.')
}

main().catch((err) => { console.error(err); process.exit(1) })
