#!/usr/bin/env tsx
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../src/app.js'

const prisma = new PrismaClient()

async function main() {
  console.log('=== Rule Engine Demo ===\n')

  const app = await buildApp()
  await app.ready()
  await app.listen({ port: 0 })
  const addr = app.server.address()
  if (!addr || typeof addr !== 'object') throw new Error('Server not listening')
  const port = addr.port
  const baseUrl = `http://127.0.0.1:${port}`
  console.log(`API server running at ${baseUrl}`)

  const team = await prisma.team.create({ data: { name: `Rules Demo Team`, slug: `rules-demo-${Date.now()}` } })
  const user = await prisma.user.create({ data: { clerkId: `clerk_rules_${Date.now()}`, email: `rules-${Date.now()}@example.com` } })
  const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'Rules Demo Workspace' } })
  const session = await prisma.session.create({
    data: { id: `rules-demo-${Date.now()}`, workspaceId: workspace.id, userId: user.id, name: 'Rules Demo Session' },
  })
  console.log(`Session: ${session.id}`)

  const mkRule = (body: Record<string, unknown>) =>
    fetch(`${baseUrl}/api/rules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  await mkRule({ workspaceId: workspace.id, name: 'Protect API contract', action: 'NOTIFY', pathPattern: 'contracts/**', message: 'API contract is authoritative — coordinate changes' })
  await mkRule({ workspaceId: workspace.id, name: 'Watch schema edits', action: 'LOG', pathPattern: 'prisma/schema.prisma' })
  console.log('Rules created (NOTIFY contracts/**, LOG prisma/schema.prisma)\n')

  const post = (p: Record<string, unknown>) =>
    fetch(`${baseUrl}/api/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })

  const r1 = await post({
    sessionId: session.id, agentId: 'claude-1', tool: 'edit_file',
    params: { path: 'contracts/api.yaml', content: 'claude version' }, result: { success: true },
    connectorId: 'claude-code', connectorVersion: '1.0.0', mcpEventId: `claude-rules-${Date.now()}`,
  })
  console.log(`claude-code event => status ${r1.status}`)

  const r2 = await post({
    sessionId: session.id, agentId: 'opencode-1', tool: 'edit_file',
    params: { path: 'contracts/api.yaml', content: 'opencode version' }, result: { success: true },
    connectorId: 'opencode', connectorVersion: '0.0.0', mcpEventId: `opencode-rules-${Date.now()}`,
  })
  console.log(`opencode event => status ${r2.status}`)

  const hits = await (await fetch(`${baseUrl}/api/sessions/${session.id}/rule-hits`)).json() as Array<{ ruleName: string; action: string; connectorId: string; path: string | null; message: string | null }>
  console.log(`\nRule hits: ${hits.length}`)
  for (const h of hits) {
    console.log(`  - [${h.action}] ${h.ruleName} (${h.connectorId} @ ${h.path}) ${h.message ?? ''}`)
  }

  const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
  console.log(`\nConflicts detected: ${conflicts.length}`)
  for (const c of conflicts) {
    console.log(`  - File: ${c.file}, Agents: ${c.agents.join(', ')}, Status: ${c.status}`)
  }

  await app.close()
  await prisma.$disconnect()
  console.log('\nDemo complete.')
}

main().catch((err) => { console.error(err); process.exit(1) })
