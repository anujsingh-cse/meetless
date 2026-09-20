import type { PrismaClient, RuleDecision, RuleVerdict } from '@prisma/client'

export const ASK_EXPIRY_MS = 60_000

export interface CreatePendingInput {
  workspaceId: string
  sessionId: string
  agentId: string
  connectorId: string
  tool: string
  path?: string | null
  ruleId: string
  ruleName: string
  verdict: RuleVerdict
  matchedOn: unknown
  message?: string | null
  pendingKey: string
  expiresAt?: Date
}

export interface CreatePendingResult {
  pendingId: string
  created: boolean
  expiresAt: Date
}

export interface ResolveResult {
  status: 'APPROVED' | 'DENIED' | 'EXPIRED'
  changed: boolean
  resolvedAt: Date | null
  resolvedBy: string | null
}

// Single-flight guard keyed by (connectorId, sessionId, pendingKey) so concurrent
// identical creates cannot both insert. Application-level, per this dev-mode boundary.
const inFlight = new Map<string, Promise<CreatePendingResult>>()

function computeExpiresAt(now: Date): Date {
  return new Date(now.getTime() + ASK_EXPIRY_MS)
}

export async function createPendingDecision(
  prisma: PrismaClient,
  input: CreatePendingInput
): Promise<CreatePendingResult> {
  const key = `${input.connectorId}||${input.sessionId}||${input.pendingKey}`
  const existing = inFlight.get(key)
  if (existing) return existing

  const task = (async (): Promise<CreatePendingResult> => {
    const open = await prisma.ruleDecision.findFirst({
      where: {
        connectorId: input.connectorId,
        sessionId: input.sessionId,
        pendingKey: input.pendingKey,
        status: 'PENDING',
      },
      orderBy: { createdAt: 'asc' },
    })
    if (open) {
      return { pendingId: open.id, created: false, expiresAt: open.expiresAt ?? new Date(0) }
    }
    const expiresAt = input.expiresAt ?? computeExpiresAt(new Date())
    const created = await prisma.ruleDecision.create({
      data: {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        connectorId: input.connectorId,
        tool: input.tool,
        path: input.path ?? null,
        ruleId: input.ruleId,
        ruleName: input.ruleName,
        verdict: input.verdict,
        matchedOn: input.matchedOn as never,
        message: input.message ?? null,
        status: 'PENDING',
        pendingKey: input.pendingKey,
        expiresAt,
      },
    })
    return { pendingId: created.id, created: true, expiresAt }
  })()

  inFlight.set(key, task)
  try {
    return await task
  } finally {
    inFlight.delete(key)
  }
}

export async function resolvePending(
  prisma: PrismaClient,
  pendingId: string,
  outcome: 'APPROVED' | 'DENIED',
  resolvedBy: string | null,
  resolutionMethod: 'human' | 'api'
): Promise<ResolveResult | null> {
  const now = new Date()
  const res = await prisma.ruleDecision.updateMany({
    where: { id: pendingId, status: 'PENDING' },
    data: { status: outcome, resolvedAt: now, resolvedBy, resolutionMethod },
  })
  if (res.count === 1) {
    return { status: outcome, changed: true, resolvedAt: now, resolvedBy }
  }
  const row = await prisma.ruleDecision.findUnique({ where: { id: pendingId } })
  if (!row) return null
  return {
    status: row.status as 'APPROVED' | 'DENIED' | 'EXPIRED',
    changed: false,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
  }
}

export async function expireIfNeeded(prisma: PrismaClient, pendingId: string): Promise<RuleDecision | null> {
  const now = new Date()
  await prisma.ruleDecision.updateMany({
    where: { id: pendingId, status: 'PENDING', expiresAt: { not: null, lte: now } },
    data: { status: 'EXPIRED', resolvedAt: now, resolvedBy: null, resolutionMethod: 'timeout' },
  })
  return prisma.ruleDecision.findUnique({ where: { id: pendingId } })
}

export async function markDeliveryFailure(prisma: PrismaClient, pendingId: string): Promise<RuleDecision | null> {
  const now = new Date()
  await prisma.ruleDecision.updateMany({
    where: { id: pendingId, status: 'PENDING' },
    data: { status: 'EXPIRED', resolvedAt: now, resolvedBy: null, resolutionMethod: 'delivery_failure' },
  })
  return prisma.ruleDecision.findUnique({ where: { id: pendingId } })
}

export async function listSessionDecisions(prisma: PrismaClient, sessionId: string, take = 200): Promise<RuleDecision[]> {
  return prisma.ruleDecision.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take,
  })
}
