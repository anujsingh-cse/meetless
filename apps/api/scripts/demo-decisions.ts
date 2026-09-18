#!/usr/bin/env tsx
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../src/app.js'

const prisma = new PrismaClient()

async function main() {
  console.log('=== Prevention Demo ===\n')

  const app = await buildApp()
  await app.ready()
  await app.listen({ port: 0 })
  const addr = app.server.address()
  if (!addr || typeof addr !== 'object') throw new Error('Server not listening')
  const port = addr.port
  const baseUrl = `http://127.0.0.1:${port}`
  console.log(`API server running at ${baseUrl}`)

  const team = await prisma.team.create({ data: { name: `Prevention Demo Team`, slug: `prev-demo-${Date.now()}` } })
  const user = await prisma.user.create({ data: { clerkId: `clerk_prev_${Date.now()}`, email: `prev-${Date.now()}@example.com` } })
  const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'Prevention Demo Workspace' } })
  const session = await prisma.session.create({
    data: { id: `prev-demo-${Date.now()}`, workspaceId: workspace.id, userId: user.id, name: 'Prevention Demo Session' },
  })
  console.log(`Session: ${session.id}`)

  const mkRule = (body: Record<string, unknown>) =>
    fetch(`${baseUrl}/api/rules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  await mkRule({ workspaceId: workspace.id, name: 'Block prod config', action: 'NOTIFY', decision: 'DENY', pathPattern: 'config/prod/**', message: 'Prod config is off-limits' })
  await mkRule({ workspaceId: workspace.id, name: 'Allow contracts', action: 'NOTIFY', decision: 'ALLOW', pathPattern: 'contracts/**' })
  console.log('Rules created (DENY config/prod/**, ALLOW contracts/**)\n')

  const decide = (p: Record<string, unknown>) =>
    fetch(`${baseUrl}/api/decisions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })

  const deny = await decide({ sessionId: session.id, agentId: 'claude-1', connectorId: 'claude-code', tool: 'edit_file', params: { path: 'config/prod/app.yaml', content: 'x' } })
  console.log(`DENY case  => status ${deny.status}`)
  console.log(`  ${await deny.text()}\n`)

  const allow = await decide({ sessionId: session.id, agentId: 'claude-1', connectorId: 'claude-code', tool: 'edit_file', params: { path: 'src/app.ts', content: 'x' } })
  console.log(`ALLOW case => status ${allow.status}`)
  console.log(`  ${await allow.text()}\n`)

  const decisions = await prisma.ruleDecision.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'asc' } })
  console.log(`RuleDecision audit rows: ${decisions.length}`)
  for (const d of decisions) {
    console.log(`  - [${d.verdict}] ${d.ruleName} (${d.connectorId} @ ${d.path ?? 'n/a'}) ${d.message ?? ''}`)
  }

  await app.close()
  await prisma.$disconnect()
  console.log('\nDemo complete.')
}

main().catch((err) => { console.error(err); process.exit(1) })