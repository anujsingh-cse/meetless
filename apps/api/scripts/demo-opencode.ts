#!/usr/bin/env tsx
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../src/app.js'

const prisma = new PrismaClient()

async function main() {
  const { normalizeOpenCodeEvent, emitToMeetless } = await import('@meetless/opencode')
  console.log('=== OpenCode Plugin Connector Demo ===\n')

  const app = await buildApp()
  await app.ready()
  await app.listen({ port: 0 })
  const addr = app.server.address()
  if (!addr || typeof addr !== 'object') throw new Error('Server not listening')
  const port = addr.port
  const baseUrl = `http://127.0.0.1:${port}`
  console.log(`API server running at ${baseUrl}`)

  const team = await prisma.team.create({ data: { name: 'OC Demo Team', slug: `oc-demo-${Date.now()}` } })
  const user = await prisma.user.create({ data: { clerkId: `clerk_oc_${Date.now()}`, email: `oc-demo-${Date.now()}@example.com` } })
  const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'OC Demo Workspace' } })
  const session = await prisma.session.create({
    data: { id: `oc-demo-${Date.now()}`, workspaceId: workspace.id, userId: user.id, name: 'OpenCode Demo Session' },
  })
  console.log(`Session created: ${session.id}`)

  console.log('\nAgent A (OpenCode) editing src/app.ts ...')
  const ocEvent = normalizeOpenCodeEvent({
    sessionId: session.id,
    callId: `oc-call-${Date.now()}`,
    tool: 'edit',
    args: { filePath: 'src/app.ts', content: 'function main() { return "OpenCode version" }' },
    eventType: 'tool',
  }, { connectorId: 'opencode', connectorVersion: '0.0.0', agentId: 'opencode-agent' })
  if (!ocEvent) throw new Error('expected opencode event')
  await emitToMeetless({ apiBaseUrl: baseUrl }, ocEvent)
  console.log('OpenCode event ingested')

  console.log('\nAgent B (Claude) editing src/app.ts ...')
  const claudeRes = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.id,
      agentId: 'claude-1',
      tool: 'edit_file',
      params: { path: 'src/app.ts', content: 'function main() { return "Claude version" }' },
      result: { success: true },
      connectorId: 'claude-code',
      connectorVersion: '1.0.0',
      mcpEventId: `claude-demo-${Date.now()}`,
    }),
  })
  console.log(`Claude event ingested (status ${claudeRes.status})`)

  const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
  console.log(`\nConflicts detected: ${conflicts.length}`)
  for (const c of conflicts) {
    console.log(`  - File: ${c.file}, Agents: ${c.agents.join(', ')}, Status: ${c.status}`)
  }

  const resp = await fetch(`${baseUrl}/api/sessions/${session.id}/conflicts`)
  const apiConflicts = await resp.json() as Array<{ file: string; agents: string[] }>
  console.log(`\nAPI returned ${apiConflicts.length} conflict(s)`)

  await app.close()
  await prisma.$disconnect()
  console.log('\nDemo complete.')
}

main().catch((err) => { console.error(err); process.exit(1) })
