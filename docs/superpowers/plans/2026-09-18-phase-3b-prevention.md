# Phase 3B — Prevention & Synchronous Decision

Date: 2026-09-18
Status: Implementation Plan
Source Spec: docs/superpowers/specs/2026-09-18-phase-3b-prevention-design.md

## Task 1 — Prisma Schema & Decision Audit

## Task 2 — RuleEvaluableEvent Refactor

## Task 3 — Decision Service

## Task 4 — POST /api/decisions

## Task 5 — Rules Route Decision Field

## Task 6 — Prevention E2E & Regression

## Task 7 — Demo & Documentation

## Task 8 — OpenCode Enforcement

## Task 9 — Cursor Enforcement

## Task 10 — Final Verification

---

### Task 1 — Prisma Schema & Decision Audit

**Objective:** Add the prevention data model without touching the Phase 3A observation model: a `RuleVerdict` enum, an optional `Rule.decision` field, and a separate scalar `RuleDecision` audit model that survives Rule deletion.

**Files to create/modify:**
- Modify: `packages/database/prisma/schema.prisma` (append `RuleVerdict` enum, add `decision` to `Rule`, append `RuleDecision` model)
- Create: `packages/database/src/__tests__/decision-models.test.ts`

**Implementation steps:**

1. Add the enum after `RuleAction`:
   ```prisma
   enum RuleVerdict {
     ALLOW
     DENY
   }
   ```
2. Add the optional decision field to the `Rule` model (after `action`, before `message`):
   ```prisma
   decision     RuleVerdict?
   ```
   `RuleAction` is UNCHANGED (`LOG | NOTIFY` only).
3. Append the scalar audit model after `RuleHit`:
   ```prisma
   model RuleDecision {
     id          String       @id @default(cuid())
     ruleId      String
     workspaceId String
     sessionId   String
     agentId     String
     connectorId String
     tool        String
     path        String?
     ruleName    String
     verdict     RuleVerdict
     matchedOn   Json
     message     String?
     createdAt   DateTime     @default(now())
     @@index([sessionId, createdAt])
     @@index([ruleId])
     @@index([workspaceId, createdAt])
   }
   ```
   `RuleDecision` has NO `@relation` lines — fully scalar per the approved design. No relation to `NormalizedEvent` or `Rule`.
4. Regenerate the client and push the schema, then run the model test.

**TDD tests to write first** (`packages/database/src/__tests__/decision-models.test.ts`):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'

const prisma = new PrismaClient()

beforeAll(async () => { await prisma.$connect() })
afterAll(async () => { await prisma.$disconnect() })

describe('RuleDecision audit model', () => {
  it('persists Rule.decision, records a RuleDecision, and survives Rule deletion', async () => {
    const team = await prisma.team.create({ data: { name: 'Dec Team', slug: `dec-${randomUUID()}` } })
    const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'Dec WS' } })

    const rule = await prisma.rule.create({
      data: {
        workspaceId: workspace.id,
        name: 'Block prod config',
        action: 'NOTIFY',
        pathPattern: 'config/prod/**',
        decision: 'DENY',
        message: 'Prod config is off-limits',
      },
    })
    expect(rule.decision).toBe('DENY')

    const decision = await prisma.ruleDecision.create({
      data: {
        ruleId: rule.id,
        workspaceId: workspace.id,
        sessionId: 'any-session',
        agentId: 'claude-1',
        connectorId: 'claude-code',
        tool: 'edit_file',
        path: 'config/prod/app.yaml',
        ruleName: rule.name,
        verdict: 'DENY',
        matchedOn: { tool: null, pathPattern: 'config/prod/**', connectorId: null, agentPattern: null },
        message: rule.message,
      },
    })
    expect(decision.verdict).toBe('DENY')
    expect(decision.matchedOn).toMatchObject({ pathPattern: 'config/prod/**' })

    // Delete the Rule; the scalar RuleDecision must survive (no FK relation).
    await prisma.rule.delete({ where: { id: rule.id } })
    const surviving = await prisma.ruleDecision.findUnique({ where: { id: decision.id } })
    expect(surviving).not.toBeNull()
    expect(surviving?.ruleId).toBe(rule.id)
    expect(surviving?.ruleName).toBe('Block prod config')

    // cleanup
    await prisma.ruleDecision.deleteMany({})
    await prisma.workspace.delete({ where: { id: workspace.id } })
    await prisma.team.delete({ where: { id: team.id } })
  })
})
```

Run it FIRST (before the schema exists) and confirm it FAILS (`prisma.ruleDecision` / `decision` undefined), then apply the schema.

**Exact validation commands:**
```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
npm run db:generate
npm run db:push
npx vitest run src/__tests__/decision-models.test.ts
```
(workdir: `packages/database`)

**Expected result:** `db:generate` succeeds, `db:push` reports schema in sync, the new model test PASSES, and the pre-existing `rule-models.test.ts` + `connector-models.test.ts` still PASS (regression).

**Commit message:**
```bash
git add packages/database/prisma/schema.prisma packages/database/src/__tests__/decision-models.test.ts
git commit -m "feat(rules): add prevention decision field and RuleDecision audit model"
```

---

### Task 2 — RuleEvaluableEvent Refactor

**Objective:** Introduce the narrow `RuleEvaluableEvent` contract as the single input type for the shared matcher/evaluator, so both the pre-execution decision path and the post-execution ingestion path use ONE matcher. `NormalizedAgentEvent` must remain a valid superset usable by the evaluator. Matching logic, deterministic ordering, and Phase 3A behavior must be preserved.

**Files to create/modify:**
- Modify: `apps/api/src/services/rule-engine.ts`
- Modify (tests): `apps/api/src/services/__tests__/rule-engine.test.ts`

**Implementation steps:**

1. Add the narrow contract and the verdict type to `rule-engine.ts`:
   ```ts
   export type RuleVerdict = 'ALLOW' | 'DENY'

   export interface RuleEvaluableEvent {
     agentId: string
     connectorId: string
     tool: string
     // Only params.path (a string) is read by the matcher. Typed as `unknown`
     // so a full NormalizedAgentEvent (params: unknown) remains assignable —
     // this is what keeps NormalizedAgentEvent a valid superset.
     params: unknown
   }
   ```
2. Add the optional prevention field to `RuleLike`:
   ```ts
   export interface RuleLike {
     id: string
     name: string
     enabled: boolean
     priority: number
     tool: string | null
     pathPattern: string | null
     connectorId: string | null
     agentPattern: string | null
     action: RuleAction
     decision?: RuleVerdict | null
     message: string | null
     createdAt: Date | string
   }
   ```
3. Change the matcher and evaluator signatures from `NormalizedAgentEvent` to `RuleEvaluableEvent` (the only change — the bodies stay byte-for-byte identical):
   ```ts
   function matchesRule(rule: RuleLike, path: string | null, event: RuleEvaluableEvent): boolean {
     // unchanged body: tool/connectorId/agentPattern/pathPattern logic
   }

   export function evaluate(event: RuleEvaluableEvent, rules: RuleLike[]): RuleEvaluationResult[] {
     // unchanged body: sort byDeterministicOrder → filter enabled → filter matches → map
   }
   ```
   `NormalizedAgentEvent` satisfies `RuleEvaluableEvent` structurally, so the existing `events.ts` ingestion call site continues to compile and behave identically. There is exactly ONE matcher and ONE evaluator.

**TDD tests to write first** (extend `apps/api/src/services/__tests__/rule-engine.test.ts`):

```ts
it('accepts a RuleEvaluableEvent (pre-execution shape) and matches deterministically', () => {
  const r = base({ pathPattern: 'config/**', action: 'NOTIFY' })
  const pre = { agentId: 'claude-1', connectorId: 'claude-code', tool: 'edit_file', params: { path: 'config/prod/x' } }
  const res = evaluate(pre, [r])
  expect(res).toHaveLength(1)
  expect(res[0].ruleId).toBe('r1')
})

it('accepts a full NormalizedAgentEvent (post-execution superset) via the same evaluator', () => {
  const r = base({ pathPattern: 'config/**', action: 'NOTIFY' })
  const full = event({ params: { path: 'config/prod/x' } }) as never
  const res = evaluate(full, [r])
  expect(res).toHaveLength(1)
  expect(res[0].ruleId).toBe('r1')
})

it('produces identical results for pre-execution and post-execution shapes with the same matcher inputs', () => {
  const r = base({ pathPattern: 'config/**', action: 'NOTIFY' })
  const pre = { agentId: 'claude-1', connectorId: 'claude-code', tool: 'edit_file', params: { path: 'config/prod/x' } }
  const full = event({ params: { path: 'config/prod/x' } }) as never
  const a = evaluate(pre, [r])
  const b = evaluate(full, [r])
  expect(a).toEqual(b)
})

it('keeps RuleLike.decision optional: null/undefined rules match observation-only behavior', () => {
  const r = base({ decision: null })
  const res = evaluate(event() as never, [r])
  expect(res).toHaveLength(1) // decision presence does NOT change matching
  expect(res[0].action).toBe('LOG')
})
```

Write these FIRST (they pass only after the refactor), then confirm all pre-existing tests in the file still pass unchanged.

**Exact validation commands:**
```powershell
npx vitest run src/services/__tests__/rule-engine.test.ts
npm run lint
npm run build
```
(workdir: `apps/api`)

**Expected result:** all 20 pre-existing unit tests PLUS the 4 new refactor tests PASS; lint clean; tsc build succeeds. The `events.ts` ingestion seam and reconciliation behavior are untouched and still compile.

**Commit message:**
```bash
git add apps/api/src/services/rule-engine.ts apps/api/src/services/__tests__/rule-engine.test.ts
git commit -m "refactor(rules): introduce RuleEvaluableEvent shared evaluator contract"
```

---

### Task 3 — Decision Service

**Objective:** Create a PURE decision service (`apps/api/src/services/decision-service.ts`) that selects prevention-participating rules, evaluates all of them via the shared evaluator, applies deny precedence with deterministic winner selection, and returns an allow/deny verdict. No Prisma, network, WebSocket, or other I/O — pure function only.

**Files to create/modify:**
- Create: `apps/api/src/services/decision-service.ts`
- Create: `apps/api/src/services/__tests__/decision-service.test.ts`

**Implementation steps:**

1. Create `apps/api/src/services/decision-service.ts`:
   ```ts
   import { evaluate } from './rule-engine.js'
   import type { RuleEvaluableEvent, RuleLike, RuleMatchedOn, RuleVerdict } from './rule-engine.js'

   export const DEFAULT_DENY_REASON_PREFIX = 'Blocked by rule'

   export interface RuleDecisionMatch {
     ruleId: string
     ruleName: string
     verdict: RuleVerdict
     matchedOn: RuleMatchedOn
     message: string | null
   }

   export interface DecisionResult {
     decision: 'allow' | 'deny'
     matches: RuleDecisionMatch[] // all matching prevention rules, deterministic order
     winning?: RuleDecisionMatch  // first DENY in deterministic order (highest priority)
     reason?: string | null       // winning deny's message; default when null
   }

   // Only rules explicitly participating in prevention (decision set) are considered.
   // LOG/NOTIFY rules and rules with decision === null/undefined never deny.
   export function selectPreventionRules(rules: RuleLike[]): RuleLike[] {
     return rules.filter((r) => r.decision === 'ALLOW' || r.decision === 'DENY')
   }

   export function decide(event: RuleEvaluableEvent, rules: RuleLike[]): DecisionResult {
     const prevention = selectPreventionRules(rules)
     const results = evaluate(event, prevention) // shared evaluator: deterministic order
     const matches: RuleDecisionMatch[] = results.map((r) => ({
       ruleId: r.ruleId,
       ruleName: r.ruleName,
       verdict: prevention.find((p) => p.id === r.ruleId)?.decision ?? 'ALLOW',
       matchedOn: r.matchedOn,
       message: r.message,
     }))
     const winning = matches.find((m) => m.verdict === 'DENY')
     if (winning) {
       return {
         decision: 'deny',
         matches,
         winning,
         reason: winning.message ?? `${DEFAULT_DENY_REASON_PREFIX} ${winning.ruleName}`,
       }
     }
     return { decision: 'allow', matches }
   }
   ```
   Determinism: `evaluate` already returns matches in `priority asc → createdAt asc → id asc`; the FIRST DENY in that order is the deterministic winner, and its `message` (or the default reason) is the returned reason.

**TDD tests to write first** (`apps/api/src/services/__tests__/decision-service.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { decide, selectPreventionRules, DEFAULT_DENY_REASON_PREFIX } from '../decision-service.js'
import type { RuleLike } from '../rule-engine.js'

const base = (over: Partial<RuleLike> = {}): RuleLike => ({
  id: 'r1', name: 'rule', enabled: true, priority: 100,
  tool: null, pathPattern: null, connectorId: null, agentPattern: null,
  action: 'NOTIFY', decision: null, message: null,
  createdAt: new Date('2026-01-01T00:00:00Z'), ...over,
})

const pre = (over: Record<string, unknown> = {}) => ({
  agentId: 'claude-1', connectorId: 'claude-code', tool: 'edit_file',
  params: { path: 'config/prod/app.yaml' }, ...over,
})

describe('selectPreventionRules', () => {
  it('keeps only rules with decision ALLOW or DENY', () => {
    const deny = base({ id: 'd', decision: 'DENY' })
    const allow = base({ id: 'a', decision: 'ALLOW' })
    const obs = base({ id: 'o', decision: null })
    const log = base({ id: 'l', decision: 'DENY', action: 'LOG' })
    const picked = selectPreventionRules([deny, allow, obs, log])
    expect(picked.map((r) => r.id)).toEqual(['d', 'a', 'l'])
  })
})

describe('decide', () => {
  it('returns allow with no matches when no prevention rule matches', () => {
    const res = decide(pre(), [base({ decision: 'DENY', pathPattern: 'contracts/**' })])
    expect(res).toEqual({ decision: 'allow', matches: [] })
  })

  it('LOG/NOTIFY rules never deny and are not in matches', () => {
    const notify = base({ id: 'n', decision: null, pathPattern: 'config/**', action: 'NOTIFY' })
    const res = decide(pre(), [notify])
    expect(res.decision).toBe('allow')
    expect(res.matches).toHaveLength(0)
  })

  it('evaluates ALL matching prevention rules (deny + allow both present)', () => {
    const deny = base({ id: 'd', decision: 'DENY', pathPattern: 'config/**', priority: 10 })
    const allow = base({ id: 'a', decision: 'ALLOW', pathPattern: 'config/**', priority: 20 })
    const res = decide(pre(), [allow, deny])
    expect(res.matches.map((m) => m.ruleId)).toEqual(['d', 'a']) // deterministic order
    expect(res.decision).toBe('deny')
  })

  it('DENY wins over ALLOW regardless of order', () => {
    const deny = base({ id: 'd', decision: 'DENY', pathPattern: 'config/**', priority: 50 })
    const allow = base({ id: 'a', decision: 'ALLOW', pathPattern: 'config/**', priority: 10 })
    const res = decide(pre(), [deny, allow])
    expect(res.decision).toBe('deny')
  })

  it('selects the winning deny deterministically (highest priority deny)', () => {
    const denyHi = base({ id: 'hi', decision: 'DENY', pathPattern: 'config/**', priority: 10, message: 'high' })
    const denyLo = base({ id: 'lo', decision: 'DENY', pathPattern: 'config/**', priority: 90, message: 'low' })
    const res = decide(pre(), [denyLo, denyHi])
    expect(res.winning?.ruleId).toBe('hi')
    expect(res.reason).toBe('high')
  })

  it('uses the default deny reason when the winning deny has no message', () => {
    const deny = base({ id: 'd', decision: 'DENY', pathPattern: 'config/**', name: 'block-prod', message: null })
    const res = decide(pre(), [deny])
    expect(res.reason).toBe(`${DEFAULT_DENY_REASON_PREFIX} block-prod`)
  })

  it('is pure: identical input yields deep-equal output (no I/O)', () => {
    const rules = [base({ id: 'd', decision: 'DENY', pathPattern: 'config/**', priority: 10 })]
    expect(decide(pre(), rules)).toEqual(decide(pre(), rules))
  })

  it('does not evaluate disabled prevention rules', () => {
    const disabled = base({ id: 'x', decision: 'DENY', pathPattern: 'config/**', enabled: false })
    const res = decide(pre(), [disabled])
    expect(res.decision).toBe('allow')
    expect(res.matches).toHaveLength(0)
  })
})
```

Write these FIRST (fail: module `../decision-service.js` does not exist), then implement.

**Exact validation commands:**
```powershell
npx vitest run src/services/__tests__/decision-service.test.ts
npx vitest run src/services/__tests__/rule-engine.test.ts
npm run lint
npm run build
```
(workdir: `apps/api`)

**Expected result:** all decision-service tests PASS; rule-engine refactor tests still PASS; lint clean; tsc build succeeds. The service is pure (no Prisma/network/WS imports).

**Commit message:**
```bash
git add apps/api/src/services/decision-service.ts apps/api/src/services/__tests__/decision-service.test.ts
git commit -m "feat(rules): add pure decision service with deny precedence"
```

---

### Task 4 — POST /api/decisions

**Objective:** Add the pre-execution decision route `POST /api/decisions`, structurally separate from `POST /api/events`. It resolves the session → workspace, fetches enabled workspace rules, runs the pure decision service, persists `RuleDecision` audit rows, returns allow/deny, and fails open on catchable errors. It never creates `NormalizedEvent` or `RuleHit` rows and never broadcasts over WebSocket.

**Files to create/modify:**
- Create: `apps/api/src/routes/decisions.ts`
- Create: `apps/api/src/routes/__tests__/decisions.test.ts`
- Modify: `apps/api/src/app.ts` (register `decisionRoutes`)

**Implementation steps:**

1. Create `apps/api/src/routes/decisions.ts`:

```ts
import { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { decide } from '../services/decision-service.js'

interface DecisionBody {
  sessionId: string
  agentId: string
  connectorId: string
  tool: string
  params: Record<string, unknown>
}

const decisionBodySchema = {
  type: 'object',
  required: ['sessionId', 'agentId', 'connectorId', 'tool', 'params'],
  properties: {
    sessionId: { type: 'string' },
    agentId: { type: 'string' },
    connectorId: { type: 'string' },
    tool: { type: 'string' },
    params: { type: 'object', additionalProperties: true },
  },
} as const

const decisionResponseSchema = {
  type: 'object',
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: ['allow', 'deny'] },
    ruleId: { type: 'string' },
    ruleName: { type: 'string' },
    matchedOn: { type: 'object', additionalProperties: true },
    reason: { type: ['string', 'null'] },
  },
} as const

export const decisionRoutes: FastifyPluginAsync = async (app) => {
  app.post('/decisions', {
    schema: {
      body: decisionBodySchema,
      response: {
        200: decisionResponseSchema,
        400: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
      },
    },
  }, async (req, reply) => {
    const body = req.body as DecisionBody

    const session = await app.prisma.session.findUnique({ where: { id: body.sessionId } })
    if (!session) return reply.code(400).send({ error: 'Invalid sessionId' })

    try {
      const rules = await app.prisma.rule.findMany({
        where: { workspaceId: session.workspaceId, enabled: true },
      })

      const outcome = decide(
        { agentId: body.agentId, connectorId: body.connectorId, tool: body.tool, params: body.params },
        rules
      )

      if (outcome.matches.length > 0) {
        const firedAt = new Date()
        const rows = outcome.matches.map((m) => ({
          id: randomUUID(),
          ruleId: m.ruleId,
          workspaceId: session.workspaceId,
          sessionId: body.sessionId,
          agentId: body.agentId,
          connectorId: body.connectorId,
          tool: body.tool,
          path: typeof body.params?.path === 'string' ? body.params.path : null,
          ruleName: m.ruleName,
          verdict: m.verdict,
          matchedOn: m.matchedOn as unknown as Prisma.InputJsonValue,
          message: m.message,
          createdAt: firedAt,
        }))
        await app.prisma.ruleDecision.createMany({ data: rows })
      }

      if (outcome.decision === 'deny' && outcome.winning) {
        return {
          decision: 'deny',
          ruleId: outcome.winning.ruleId,
          ruleName: outcome.winning.ruleName,
          matchedOn: outcome.winning.matchedOn,
          reason: outcome.reason ?? null,
        }
      }
      if (outcome.matches.length > 0) {
        const first = outcome.matches[0]
        return {
          decision: 'allow',
          ruleId: first.ruleId,
          ruleName: first.ruleName,
          matchedOn: first.matchedOn,
          reason: first.message ?? null,
        }
      }
      return { decision: 'allow' }
    } catch (err) {
      // Fail-open: catchable decision-path failures return 200 allow.
      // The residual 500 boundary is ONLY for genuinely unhandled/catastrophic
      // failures outside this try/catch (Fastify's default error handler).
      app.log.error({ err, workspaceId: session.workspaceId, sessionId: body.sessionId, tool: body.tool }, 'decision evaluation failed; fail-open allow')
      return { decision: 'allow' }
    }
  })
}
```

2. Register in `apps/api/src/app.ts` (after `ruleRoutes`):

```ts
import { decisionRoutes } from './routes/decisions.js'
// ...
  await app.register(ruleRoutes, { prefix: '/api' })
  await app.register(decisionRoutes, { prefix: '/api' })
```

**TDD tests to write first** (`apps/api/src/routes/__tests__/decisions.test.ts`):

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../../app.js'
import { prisma } from '@meetless/database/client'

let app: Awaited<ReturnType<typeof buildApp>>

const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function createSession() {
  const team = await prisma.team.create({ data: { name: `T-${randSuffix()}`, slug: `t-${randSuffix()}` } })
  const user = await prisma.user.create({ data: { clerkId: `c-${randSuffix()}`, email: `e-${randSuffix()}@ex.com` } })
  const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'W' } })
  const session = await prisma.session.create({ data: { workspaceId: workspace.id, userId: user.id, name: 'Dec' } })
  return { sessionId: session.id, workspaceId: workspace.id }
}

const decisionBody = (sessionId: string, path: string) => ({
  sessionId, agentId: 'claude-1', connectorId: 'claude-code', tool: 'edit_file',
  params: { path, content: 'x' },
})

beforeAll(async () => { app = await buildApp(); await app.ready() })
afterAll(async () => { await app.close() })

beforeEach(async () => {
  await prisma.normalizedEvent.deleteMany()
  await prisma.conflict.deleteMany()
  await prisma.ruleHit.deleteMany()
  await prisma.ruleDecision.deleteMany()
  await prisma.rule.deleteMany()
  await prisma.session.deleteMany()
  await prisma.workspace.deleteMany()
  await prisma.membership.deleteMany()
  await prisma.user.deleteMany()
  await prisma.team.deleteMany()
  await prisma.connector.deleteMany()
})

describe('POST /api/decisions', () => {
  it('returns allow with no attribution when no prevention rule matches', async () => {
    const { sessionId, workspaceId } = await createSession()
    await prisma.rule.create({ data: { workspaceId, name: 'deny-contracts', action: 'NOTIFY', decision: 'DENY', pathPattern: 'contracts/**' } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: decisionBody(sessionId, 'src/app.ts') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ decision: 'allow' })
    expect(await prisma.ruleDecision.count({ where: { sessionId } })).toBe(0)
  })

  it('returns deny with reason when a DENY prevention rule matches', async () => {
    const { sessionId, workspaceId } = await createSession()
    const rule = await prisma.rule.create({ data: { workspaceId, name: 'deny-prod', action: 'NOTIFY', decision: 'DENY', pathPattern: 'config/prod/**', message: 'off-limits' } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: decisionBody(sessionId, 'config/prod/app.yaml') })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.decision).toBe('deny')
    expect(body.ruleId).toBe(rule.id)
    expect(body.ruleName).toBe('deny-prod')
    expect(body.reason).toBe('off-limits')
  })

  it('persists a RuleDecision audit row and creates NO RuleHit / NormalizedEvent rows', async () => {
    const { sessionId, workspaceId } = await createSession()
    const rule = await prisma.rule.create({ data: { workspaceId, name: 'deny-prod', action: 'NOTIFY', decision: 'DENY', pathPattern: 'config/prod/**' } })
    await app.inject({ method: 'POST', url: '/api/decisions', payload: decisionBody(sessionId, 'config/prod/app.yaml') })
    const decision = await prisma.ruleDecision.findFirst({ where: { sessionId } })
    expect(decision).not.toBeNull()
    expect(decision?.ruleId).toBe(rule.id)
    expect(decision?.verdict).toBe('DENY')
    expect(decision?.matchedOn).toEqual({ tool: null, pathPattern: 'config/prod/**', connectorId: null, agentPattern: null })
    expect(await prisma.ruleHit.count({ where: { sessionId } })).toBe(0)
    expect(await prisma.normalizedEvent.count({ where: { sessionId } })).toBe(0)
  })

  it('LOG/NOTIFY rules never deny and produce no audit rows on the decision path', async () => {
    const { sessionId, workspaceId } = await createSession()
    await prisma.rule.create({ data: { workspaceId, name: 'notify', action: 'NOTIFY', pathPattern: 'config/**' } })
    await prisma.rule.create({ data: { workspaceId, name: 'log', action: 'LOG', pathPattern: 'config/**' } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: decisionBody(sessionId, 'config/prod/x') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).decision).toBe('allow')
    expect(await prisma.ruleDecision.count({ where: { sessionId } })).toBe(0)
    expect(await prisma.ruleHit.count({ where: { sessionId } })).toBe(0)
  })

it('deny precedence: DENY wins over ALLOW and all matches are audited', async () => {
    const { sessionId, workspaceId } = await createSession()
    const deny = await prisma.rule.create({ data: { workspaceId, name: 'deny', action: 'NOTIFY', decision: 'DENY', pathPattern: 'config/**', priority: 10 } })
    const allow = await prisma.rule.create({ data: { workspaceId, name: 'allow', action: 'NOTIFY', decision: 'ALLOW', pathPattern: 'config/**', priority: 20 } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: decisionBody(sessionId, 'config/x') })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.decision).toBe('deny')
    expect(body.ruleId).toBe(deny.id) // deterministic winner: first DENY in priority order
    const rows = await prisma.ruleDecision.findMany({ where: { sessionId } })
    expect(rows.map((r) => r.ruleId).sort()).toEqual([deny.id, allow.id].sort())
    expect(rows.map((r) => r.verdict).sort()).toEqual(['ALLOW', 'DENY'])
  })

  it('returns 400 for an unknown sessionId', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: decisionBody('nope', 'src/x') })
    expect(res.statusCode).toBe(400)
  })

  it('fail-open: a server error returns 200 allow (residual 500 is catastrophic-only)', async () => {
    const { sessionId } = await createSession()
    const original = app.prisma.rule.findMany.bind(app.prisma.rule)
    app.prisma.rule.findMany = (async () => { throw new Error('boom') }) as never
    try {
      const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: decisionBody(sessionId, 'src/x') })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload)).toEqual({ decision: 'allow' })
    } finally {
      app.prisma.rule.findMany = original as never
    }
  })
})
```

Write these FIRST (fail: `/api/decisions` is 404 — route not registered), then implement.

**Exact validation commands:**
```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
$env:REDIS_URL = "redis://localhost:6379"
npx vitest run src/routes/__tests__/decisions.test.ts
npm run lint
npm run build
```
(workdir: `apps/api`)

**Expected result:** all decision route tests PASS; lint clean; tsc build succeeds. A denied call produces no `NormalizedEvent`, no `RuleHit`, and no WebSocket broadcast. The residual 500 boundary is documented as catastrophic-only.

**Commit message:**
```bash
git add apps/api/src/routes/decisions.ts apps/api/src/routes/__tests__/decisions.test.ts apps/api/src/app.ts
git commit -m "feat(rules): add POST /api/decisions pre-execution decision route"
```

---

### Task 5 — Rules Route Decision Field

**Objective:** Extend the rules CRUD API to accept and return the optional prevention decision/verdict field (`ALLOW`/`DENY`), keeping `RuleAction` unchanged and preserving all Phase 3A validation (≥1 constraint, valid globs, workspace exists).

**Files to create/modify:**
- Modify: `apps/api/src/routes/rules.ts`
- Modify (tests): `apps/api/src/routes/__tests__/rules.test.ts`

**Implementation steps:**

1. In `apps/api/src/routes/rules.ts`:
   - Import the verdict type: `import type { RuleAction, RuleVerdict } from '../services/rule-engine.js'`
   - Add to `RuleBody`:
     ```ts
     decision?: RuleVerdict
     ```
   - Add `decision` to `ruleResponseSchema.properties`:
     ```ts
     decision: { type: ['string', 'null'], enum: ['ALLOW', 'DENY', null] },
     ```
   - Add `decision` to the POST body schema properties:
     ```ts
     decision: { type: 'string', enum: ['ALLOW', 'DENY'] },
     ```
   - Add `decision` to the PATCH body schema properties:
     ```ts
     decision: { type: ['string', 'null'], enum: ['ALLOW', 'DENY', null] },
     ```
   - Include `decision` in `toPublicRule` return:
     ```ts
     decision: r.decision ?? null,
     ```
     and add `decision: RuleVerdict | null` to the `toPublicRule` parameter type.
   - Add `decision: body.decision ?? null` to the POST create data.
   - Add `decision: body.decision !== undefined ? body.decision : existing.decision` to the PATCH update data (merge like the other fields).

**TDD tests to write first** (append to `apps/api/src/routes/__tests__/rules.test.ts`):

```ts
it('creates a rule with a DENY decision', async () => {
  const ws = await createWorkspace()
  const res = await app.inject({ method: 'POST', url: '/api/rules', payload: { ...validRuleBody(ws.id), decision: 'DENY' } })
  expect(res.statusCode).toBe(201)
  const body = JSON.parse(res.payload)
  expect(body.decision).toBe('DENY')
  expect(body.action).toBe('NOTIFY') // RuleAction unchanged
})

it('serializes decision as null when not provided', async () => {
  const ws = await createWorkspace()
  const res = await app.inject({ method: 'POST', url: '/api/rules', payload: validRuleBody(ws.id) })
  expect(res.statusCode).toBe(201)
  expect(JSON.parse(res.payload).decision).toBeNull()
})

it('rejects an invalid decision enum value', async () => {
  const ws = await createWorkspace()
  const res = await app.inject({ method: 'POST', url: '/api/rules', payload: { ...validRuleBody(ws.id), decision: 'BLOCK' } })
  expect(res.statusCode).toBe(400)
})

it('updates the decision field via PATCH', async () => {
  const ws = await createWorkspace()
  const rule = await prisma.rule.create({ data: { workspaceId: ws.id, name: 'r', action: 'LOG', pathPattern: 'a/**' } })
  const res = await app.inject({ method: 'PATCH', url: `/api/rules/${rule.id}`, payload: { decision: 'DENY' } })
  expect(res.statusCode).toBe(200)
  expect(JSON.parse(res.payload).decision).toBe('DENY')
})

it('can clear the decision field via PATCH', async () => {
  const ws = await createWorkspace()
  const rule = await prisma.rule.create({ data: { workspaceId: ws.id, name: 'r', action: 'LOG', pathPattern: 'a/**', decision: 'DENY' } })
  const res = await app.inject({ method: 'PATCH', url: `/api/rules/${rule.id}`, payload: { decision: null } })
  expect(res.statusCode).toBe(200)
  expect(JSON.parse(res.payload).decision).toBeNull()
})
```

Write these FIRST (fail: `decision` is not accepted/serialized yet), then implement.

**Exact validation commands:**
```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
$env:REDIS_URL = "redis://localhost:6379"
npx vitest run src/routes/__tests__/rules.test.ts
npx vitest run src/routes/__tests__/decisions.test.ts
npm run lint
npm run build
```
(workdir: `apps/api`)

**Expected result:** all rules tests (existing + new) PASS; decisions route tests still PASS; lint clean; tsc build succeeds.

**Commit message:**
```bash
git add apps/api/src/routes/rules.ts apps/api/src/routes/__tests__/rules.test.ts
git commit -m "feat(rules): support prevention decision field on rule CRUD"
```

---

### Task 6 — Prevention E2E & Regression

**Objective:** Prove the synchronous prevention flow end-to-end against a real app + DB: a denied pending call never enters ingestion/reconciliation, allowed flows still reconcile, audit rows are correct, and the FULL api suite (including all pre-existing connector e2e suites) stays green.

**Files to create/modify:**
- Create: `apps/api/src/__tests__/e2e-prevention.test.ts`

**Implementation steps:**

1. Create `apps/api/src/__tests__/e2e-prevention.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../app.js'
import { prisma } from '@meetless/database/client'

let app: Awaited<ReturnType<typeof buildApp>>

const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0 })
})

afterAll(async () => { await app.close() })

beforeEach(async () => {
  await prisma.normalizedEvent.deleteMany()
  await prisma.conflict.deleteMany()
  await prisma.ruleHit.deleteMany()
  await prisma.ruleDecision.deleteMany()
  await prisma.rule.deleteMany()
  await prisma.session.deleteMany()
  await prisma.workspace.deleteMany()
  await prisma.membership.deleteMany()
  await prisma.user.deleteMany()
  await prisma.team.deleteMany()
  await prisma.connector.deleteMany()
})

async function seed() {
  const team = await prisma.team.create({ data: { name: `T-${randSuffix()}`, slug: `t-${randSuffix()}` } })
  const user = await prisma.user.create({ data: { clerkId: `c-${randSuffix()}`, email: `e-${randSuffix()}@ex.com` } })
  const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'W' } })
  const session = await prisma.session.create({ data: { workspaceId: workspace.id, userId: user.id, name: 'E2E' } })
  await prisma.connector.upsert({ where: { id: 'claude-code' }, update: {}, create: { id: 'claude-code', name: 'claude-code', version: '1.0.0', capabilities: {} } })
  return { workspaceId: workspace.id, sessionId: session.id }
}

function pending(sessionId: string, path: string) {
  return { sessionId, agentId: 'claude-1', connectorId: 'claude-code', tool: 'edit_file', params: { path, content: 'x' } }
}

describe('Prevention E2E', () => {
  it('denies a pending call against a DENY rule, audits it, and never ingests it', async () => {
    const { workspaceId, sessionId } = await seed()
    const rule = await prisma.rule.create({ data: { workspaceId, name: 'deny-prod', action: 'NOTIFY', decision: 'DENY', pathPattern: 'config/prod/**', message: 'off-limits' } })

    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: pending(sessionId, 'config/prod/app.yaml') })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.decision).toBe('deny')
    expect(body.ruleId).toBe(rule.id)
    expect(body.reason).toBe('off-limits')

    const decision = await prisma.ruleDecision.findFirst({ where: { sessionId } })
    expect(decision).not.toBeNull()
    expect(decision?.verdict).toBe('DENY')
    expect(await prisma.normalizedEvent.count({ where: { sessionId } })).toBe(0)
    expect(await prisma.conflict.count({ where: { sessionId } })).toBe(0)
    expect(await prisma.ruleHit.count({ where: { sessionId } })).toBe(0)
  })

  it('allows a non-matching pending call with no audit row', async () => {
    const { workspaceId, sessionId } = await seed()
    await prisma.rule.create({ data: { workspaceId, name: 'deny-prod', action: 'NOTIFY', decision: 'DENY', pathPattern: 'config/prod/**' } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: pending(sessionId, 'src/app.ts') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ decision: 'allow' })
    expect(await prisma.ruleDecision.count({ where: { sessionId } })).toBe(0)
  })

it('allowed flows still reconcile: conflicting edits with an active DENY rule still produce a conflict', async () => {
    const { workspaceId, sessionId } = await seed()
    await prisma.rule.create({ data: { workspaceId, name: 'watch-src', action: 'NOTIFY', decision: 'DENY', pathPattern: 'src/**' } })
    await prisma.connector.upsert({ where: { id: 'cursor-hooks' }, update: {}, create: { id: 'cursor-hooks', name: 'cursor-hooks', version: '1.0.0', capabilities: {} } })

    const e1 = await app.inject({ method: 'POST', url: '/api/events', payload: { sessionId, agentId: 'claude-1', tool: 'edit_file', params: { path: 'src/app.ts', content: 'a' }, result: { success: true }, connectorId: 'claude-code', connectorVersion: '1.0.0', mcpEventId: `m-${randSuffix()}` } })
    const e2 = await app.inject({ method: 'POST', url: '/api/events', payload: { sessionId, agentId: 'cursor-1', tool: 'edit_file', params: { path: 'src/app.ts', content: 'b' }, result: { success: true }, connectorId: 'cursor-hooks', connectorVersion: '1.0.0', mcpEventId: `m-${randSuffix()}` } })
    expect(e1.statusCode).toBe(201)
    expect(e2.statusCode).toBe(201)

    const conflicts = await prisma.conflict.findMany({ where: { sessionId } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].status).toBe('PENDING')
    // ruleHit rows come only from the ingestion path (NOTIFY on src/**), never from decisions
    expect(await prisma.ruleHit.count({ where: { sessionId } })).toBe(2)
    expect(await prisma.ruleDecision.count({ where: { sessionId } })).toBe(0)
  })
})
```

Write these FIRST (fail: `/api/decisions` behavior not wired to the DB/persistence yet — route returns 404), then implement against the full app.

2. Run the FULL api suite as regression: `npm test` in `apps/api`. This must include the four pre-existing connector e2e suites (`e2e-claude-flow`, `e2e-cursor-hooks`, `e2e-multi-connector`, `e2e-opencode`) plus all Phase 3A suites and the new prevention/decision suites.

**Exact validation commands:**
```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
$env:REDIS_URL = "redis://localhost:6379"
npx vitest run src/__tests__/e2e-prevention.test.ts
npm test
npm run lint
npm run build
```
(workdir: `apps/api`)

**Expected result:** the 3 e2e-prevention tests PASS; the FULL api suite is green (all connector e2e regression suites included); lint clean; tsc build succeeds — proving reconciliation and Phase 3A behavior are unchanged.

**Commit message:**
```bash
git add apps/api/src/__tests__/e2e-prevention.test.ts
git commit -m "test(rules): e2e prevention flow and regression"
```

---

### Task 7 — Demo & Documentation

**Objective:** Add a runnable `demo:decisions` script proving the synchronous prevention path end-to-end (DENY + ALLOW cases with `RuleDecision` audit output), plus docs for the new API surface in `docs/project-overview.md`.

**Files to create/modify:**
- Create: `apps/api/scripts/demo-decisions.ts`
- Modify: `apps/api/package.json` (add `demo:decisions` script)
- Modify: `docs/project-overview.md` (Prevention section + API table rows)

**Implementation steps:**

1. Create `apps/api/scripts/demo-decisions.ts` (modeled on `demo-rules.ts` conventions: PrismaClient + `buildApp` on ephemeral port, cleanup):

```ts
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
```

2. In `apps/api/package.json`, add to `"scripts"` (after `demo:rules`):

```jsonc
"demo:decisions": "npx tsx scripts/demo-decisions.ts"
```

3. In `docs/project-overview.md`:
   - Add rows to the "## API Routes" table:
     ```markdown
     | POST | `/api/decisions` | Pre-execution allow/deny decision (prevention) |
     ```
   - Add a short **Prevention (Phase 3B)** section after the Rule Engine section:
     ```markdown
     ## Prevention (Phase 3B)

     `POST /api/decisions` is the synchronous pre-execution decision path. Before a tool
     runs, connectors (OpenCode plugin, Cursor hooks) ask Meetless for an `allow`/`deny`
     verdict. Only rules with a `decision` field (`ALLOW`/`DENY`) participate; `LOG`/`NOTIFY`
     rules never deny. Verdicts fail open on timeout/error; adapters enforce their own ~3s
     timeout. Outcomes are recorded in the scalar `RuleDecision` audit table. Blocked calls
     never enter ingestion or reconciliation.
     ```

**Exact validation commands:**
```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
$env:REDIS_URL = "redis://localhost:6379"
npm run demo:decisions --workspace=@meetless/api
```
(workdir: repo root)

**Expected result:** demo prints a DENY case (with reason), an ALLOW case, and the persisted `RuleDecision` audit rows. Then `npm run lint` (workdir `apps/api`) is clean.

**Commit message:**
```bash
git add apps/api/scripts/demo-decisions.ts apps/api/package.json docs/project-overview.md
git commit -m "feat(rules): add prevention demo script and docs"
```

---

### Task 8 — OpenCode Enforcement

**Objective:** Add `tool.execute.before` to the OpenCode plugin so a pending tool call is normalized, sent to `POST /api/decisions` with a bounded adapter timeout, and the tool is BLOCKED (throw) on DENY or allowed to proceed unchanged on ALLOW. The plugin stays self-contained (no runtime deps; `fetch` + `AbortController` only). `agentId` derivation matches the ingestion path.

**Files to create/modify:**
- Modify: `packages/opencode-plugin/src/config.ts` (timeout constant / config)
- Create: `packages/opencode-plugin/src/decision.ts` (decision request client)
- Modify: `packages/opencode-plugin/src/plugin.ts` (add `tool.execute.before`)
- Modify (tests): `packages/opencode-plugin/src/__tests__/plugin.test.ts`
- Create (tests): `packages/opencode-plugin/src/__tests__/decision.test.ts`

**Implementation steps:**

1. Create `packages/opencode-plugin/src/decision.ts`:

```ts
import type { EmitterConfig } from './emitter.js'

export const DECISION_TIMEOUT_MS = 3000 // adapter-enforced, independent of harness timeout

export interface PendingToolCall {
  sessionId: string
  agentId: string
  connectorId: string
  tool: string
  params: Record<string, unknown>
}

export interface DecisionResponse {
  decision: 'allow' | 'deny'
  reason?: string
}

// Fail-open: network error / timeout / non-2xx ⇒ allow.
export async function requestDecision(
  config: EmitterConfig,
  pending: PendingToolCall
): Promise<DecisionResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DECISION_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.apiToken) headers.Authorization = `Bearer ${config.apiToken}`
    const res = await fetch(`${config.apiBaseUrl}/api/decisions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(pending),
      signal: controller.signal,
    })
    if (!res.ok) return { decision: 'allow' }
    const body = (await res.json()) as { decision?: string; reason?: string }
    return { decision: body.decision === 'deny' ? 'deny' : 'allow', reason: body.reason }
  } catch {
    return { decision: 'allow' } // timeout or network failure ⇒ fail-open
  } finally {
    clearTimeout(timer)
  }
}

// Normalize a raw tool.execute.before input into a RuleEvaluableEvent-shaped pending call.
// edit/write/patch → edit_file with params.path (same mapping as the ingestion normalizer).
export function normalizePendingToolCall(
  input: { tool?: string; sessionID?: string; callID?: string; args?: Record<string, unknown> },
  opts: { connectorId: string; connectorVersion: string; agentId: string }
): PendingToolCall | null {
  const tool = input.tool
  if (!tool) return null
  const isEdit = tool === 'edit' || tool === 'write' || tool === 'patch'
  const normalizedTool = isEdit ? 'edit_file' : tool
  const args = input.args ?? {}
  const path = typeof args.filePath === 'string' ? args.filePath : typeof args.path === 'string' ? args.path : undefined
  const params: Record<string, unknown> = {}
  if (path !== undefined) params.path = path
  return {
    sessionId: String(input.sessionID ?? ''),
    agentId: opts.agentId,
    connectorId: opts.connectorId,
    tool: normalizedTool,
    params,
  }
}
```

2. In `packages/opencode-plugin/src/plugin.ts`:
   - Import `requestDecision`, `normalizePendingToolCall` from `./decision.js`.
   - Add a `resolveAgentId` helper shared with the ingestion path (identical derivation):
     ```ts
     function resolveAgentId(config: PluginConfig, sessionId: string): string {
       return config.agentId ?? `opencode-${sessionId.slice(0, 8)}`
     }
     ```
   - Use `resolveAgentId` inside `forward()` (replacing the inline fallback) so pre/post paths cannot drift.
   - Add the hook to the returned hooks object:
     ```ts
     async 'tool.execute.before'(input, _output) {
       if (input?.sessionID) currentSession = String(input.sessionID)
       const sessionId = String(input.sessionID ?? currentSession)
       if (!sessionId) return
       const pending = normalizePendingToolCall(input, {
         connectorId: 'opencode',
         connectorVersion: OPENCODE_CONNECTOR_VERSION,
         agentId: resolveAgentId(config, sessionId),
       })
       if (!pending) return
       const verdict = await requestDecision(config, pending)
       if (verdict.decision === 'deny') {
         throw new Error(verdict.reason ?? 'Blocked by rule')
       }
     },
     ```

3. **No short-circuit in 3B:** the adapter asks Meetless for EVERY pending tool call (the spec's safe default). Short-circuit optimization is deferred.

**TDD tests to write first** (`packages/opencode-plugin/src/__tests__/decision.test.ts`):

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { requestDecision, normalizePendingToolCall, DECISION_TIMEOUT_MS } from '../decision.js'

afterEach(() => { vi.restoreAllMocks() })

describe('normalizePendingToolCall', () => {
  it('maps edit/write/patch to edit_file with params.path', () => {
    const p = normalizePendingToolCall({ tool: 'write', sessionID: 's1', callID: 'c', args: { filePath: 'src/a.ts', content: 'x' } }, { connectorId: 'opencode', connectorVersion: '0.0.0', agentId: 'oc-1' })
    expect(p).toEqual({ sessionId: 's1', agentId: 'oc-1', connectorId: 'opencode', tool: 'edit_file', params: { path: 'src/a.ts' } })
  })
  it('preserves non-edit tools by name with no path', () => {
    const p = normalizePendingToolCall({ tool: 'bash', sessionID: 's1', args: { command: 'ls' } }, { connectorId: 'opencode', connectorVersion: '0.0.0', agentId: 'oc-1' })
    expect(p?.tool).toBe('bash')
    expect(p?.params).toEqual({})
  })
  it('returns null when tool is missing', () => {
    expect(normalizePendingToolCall({ sessionID: 's1' }, { connectorId: 'opencode', connectorVersion: '0.0.0', agentId: 'oc-1' })).toBeNull()
  })
})

describe('requestDecision', () => {
  it('returns allow on non-200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const r = await requestDecision({ apiBaseUrl: 'http://x' }, { sessionId: 's1', agentId: 'a', connectorId: 'c', tool: 'edit_file', params: {} })
    expect(r).toEqual({ decision: 'allow' })
  })
  it('returns deny with reason when the server denies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ decision: 'deny', reason: 'no' }) }))
    const r = await requestDecision({ apiBaseUrl: 'http://x' }, { sessionId: 's1', agentId: 'a', connectorId: 'c', tool: 'edit_file', params: {} })
    expect(r).toEqual({ decision: 'deny', reason: 'no' })
  })
  it('fails open on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const r = await requestDecision({ apiBaseUrl: 'http://x' }, { sessionId: 's1', agentId: 'a', connectorId: 'c', tool: 'edit_file', params: {} })
    expect(r).toEqual({ decision: 'allow' })
  })
  it('aborts after the adapter timeout and fails open', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_u: string, opts: RequestInit) => new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    const p = requestDecision({ apiBaseUrl: 'http://x' }, { sessionId: 's1', agentId: 'a', connectorId: 'c', tool: 'edit_file', params: {} })
    vi.advanceTimersByTime(DECISION_TIMEOUT_MS + 10)
    const r = await p
    expect(r).toEqual({ decision: 'allow' })
    vi.useRealTimers()
  })
})
```

And extend `packages/opencode-plugin/src/__tests__/plugin.test.ts`:

```ts
describe('MeetlessPlugin tool.execute.before', () => {
  it('exposes tool.execute.before', async () => {
    const hooks = await MeetlessPlugin(stubCtx)
    expect(typeof hooks['tool.execute.before']).toBe('function')
  })
})
```

(mock `../decision.js` in the plugin test the same way `../emitter.js` is mocked).

**Exact validation commands:**
```powershell
npx vitest run src/__tests__/decision.test.ts
npx vitest run src/__tests__/plugin.test.ts
npm run lint
npm run build
```
(workdir: `packages/opencode-plugin`)

**Expected result:** all opencode-plugin tests PASS (new + existing); lint clean; tsc build succeeds; plugin remains dependency-free.

**Commit message:**
```bash
git add packages/opencode-plugin/src/decision.ts packages/opencode-plugin/src/plugin.ts packages/opencode-plugin/src/config.ts packages/opencode-plugin/src/__tests__/decision.test.ts packages/opencode-plugin/src/__tests__/plugin.test.ts
git commit -m "feat(opencode): add tool.execute.before prevention decision hook"
```

---

### Task 9 — Cursor Enforcement

**Objective:** Make the Cursor pre-execution permission hooks (`preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`) decision-capable so `bridge-client.mjs` prints a synchronous Cursor verdict JSON; ALL non-permission hooks stay observe-only. The decision verdict reaches `bridge-client.mjs` via the BridgeServer response. `agentId` matches the ingestion derivation.

**Files to create/modify:**
- Modify: `packages/shared/src/connectors/cursor-hooks/bridge.ts` (decision-capable `/hook` response for permission hooks)
- Modify: `packages/shared/src/connectors/cursor-hooks/bridge-client.mjs` (print verdict JSON for permission hooks)
- Modify: `packages/shared/src/connectors/cursor-hooks/types.ts` (decision config + permission-hook list)
- Modify: `packages/shared/src/connectors/cursor-hooks/connector.ts` (pass decision config through)
- Modify (tests): `packages/shared/src/connectors/cursor-hooks/__tests__/bridge.test.ts`

**Implementation steps:**

1. In `packages/shared/src/connectors/cursor-hooks/types.ts`:
   - Add the permission-hook set (reused by bridge + client):
     ```ts
     export const CURSOR_PERMISSION_HOOKS = [
       'preToolUse',
       'beforeShellExecution',
       'beforeMCPExecution',
       'beforeReadFile',
     ] as const
     export type CursorPermissionHook = (typeof CURSOR_PERMISSION_HOOKS)[number]
     export function isCursorPermissionHook(name: string): boolean {
       return (CURSOR_PERMISSION_HOOKS as readonly string[]).includes(name)
     }
     ```
   - Add decision options:
     ```ts
     export interface CursorDecisionConfig {
       baseUrl?: string
       apiToken?: string
       timeoutMs?: number
     }
     ```
2. In `packages/shared/src/connectors/cursor-hooks/bridge.ts`:
   - `BridgeServerOptions` gains `decision?: CursorDecisionConfig`.
   - In `handleRequest`, for permission hooks (`isCursorPermissionHook(payload.hook_event_name)`), after forwarding the normalized event to handlers, call Meetless `POST /api/decisions` with a `RuleEvaluableEvent`-shaped body built from the normalized event (`sessionId`, `agentId`, `connectorId`, `tool`, `params`), using `AbortController` with `decision.timeoutMs ?? 3000`; then set the response body to `{ ok: true, verdict, reason? }`. On error/timeout/no `decision.baseUrl`, respond `{ ok: true }` (bridge-client fails open to allow).
   - Keep all non-permission hooks responding exactly as today (`{ ok: true }`).
   - `agentId` comes from the same normalization as ingestion (the normalized event's `agentId`).
3. In `packages/shared/src/connectors/cursor-hooks/bridge-client.mjs`:
   - Read `--event` (already passed by the installer) to know whether this is a permission hook.
   - For permission hooks: parse the response body JSON; if `verdict === 'deny'` print:
     ```json
     { "continue": true, "permission": "deny", "user_message": "<reason>", "agent_message": "<reason>" }
     ```
     else print:
     ```json
     { "continue": true, "permission": "allow" }
     ```
     On any error/timeout/missing body, print the ALLOW verdict (fail-open). Always exit 0.
   - For non-permission hooks: behavior unchanged (exit 0 on 200, no stdout output).
   - Strictly-valid JSON output is mandatory (Cursor permission hooks block on invalid JSON even without `failClosed`).
4. In `packages/shared/src/connectors/cursor-hooks/connector.ts`:
   - `CursorHooksConnectorOptions` gains `decision?: CursorDecisionConfig`.
   - Pass `decision` into `new BridgeServer({ secret, connectorVersion, decision })`.

**TDD tests to write first** (extend `packages/shared/src/connectors/cursor-hooks/__tests__/bridge.test.ts`):

```ts
import { BridgeServer } from '../bridge.js'
import { isCursorPermissionHook } from '../types.js'

describe('isCursorPermissionHook', () => {
  it('classifies the four permission hooks', () => {
    for (const h of ['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile']) {
      expect(isCursorPermissionHook(h)).toBe(true)
    }
  })
  it('does not classify observation hooks', () => {
    expect(isCursorPermissionHook('afterShellExecution')).toBe(false)
    expect(isCursorPermissionHook('afterFileEdit')).toBe(false)
  })
})

describe('BridgeServer decision path', () => {
  it('returns a deny verdict for a permission hook when Meetless denies', async () => {
    const decisionServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ decision: 'deny', reason: 'off-limits' })) })
    })
    await new Promise<void>((resolve) => decisionServer.listen(0, '127.0.0.1', resolve))
    const decisionPort = (decisionServer.address() as { port: number }).port
    const bridge = new BridgeServer({ secret: 's', connectorVersion: '1.0.0', decision: { baseUrl: `http://127.0.0.1:${decisionPort}` } })
    await bridge.start()
    try {
      const res = await makeRequest(bridge.port, JSON.stringify({ hook_event_name: 'preToolUse', session_id: 'sess-1', tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }), 's')
      let body = ''
      res.on('data', (c) => { body += c })
      const parsed = await new Promise<{ ok: boolean; verdict?: string; reason?: string }>((resolve) => res.on('end', () => resolve(JSON.parse(body))))
      expect(parsed.ok).toBe(true)
      expect(parsed.verdict).toBe('deny')
      expect(parsed.reason).toBe('off-limits')
    } finally {
      await bridge.stop()
      decisionServer.close()
    }
  })

  it('fails open (no verdict) for permission hooks when Meetless is unreachable', async () => {
    const bridge = new BridgeServer({ secret: 's', connectorVersion: '1.0.0', decision: { baseUrl: 'http://127.0.0.1:1' } })
    await bridge.start()
    try {
      const res = await makeRequest(bridge.port, JSON.stringify({ hook_event_name: 'preToolUse', session_id: 'sess-1', tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }), 's')
      let body = ''
      res.on('data', (c) => { body += c })
      const parsed = await new Promise<{ ok: boolean; verdict?: string }>((resolve) => res.on('end', () => resolve(JSON.parse(body))))
      expect(parsed.ok).toBe(true)
      expect(parsed.verdict).toBeUndefined()
    } finally {
      await bridge.stop()
    }
  })

  it('keeps observation hooks observe-only (no verdict in response)', async () => {
    const bridge = new BridgeServer({ secret: 's', connectorVersion: '1.0.0', decision: { baseUrl: 'http://127.0.0.1:1' } })
    await bridge.start()
    try {
      const res = await makeRequest(bridge.port, JSON.stringify({ hook_event_name: 'afterFileEdit', session_id: 'sess-1', tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }), 's')
      let body = ''
      res.on('data', (c) => { body += c })
      const parsed = await new Promise<{ ok: boolean; verdict?: string }>((resolve) => res.on('end', () => resolve(JSON.parse(body))))
      expect(parsed.ok).toBe(true)
      expect(parsed.verdict).toBeUndefined()
    } finally {
      await bridge.stop()
    }
  })
})
```

**Exact validation commands:**
```powershell
npx vitest run src/connectors/cursor-hooks/__tests__/bridge.test.ts
npx vitest run src/connectors/cursor-hooks/__tests__/connector.test.ts
npm run lint
npm run build
npm test
```
(workdir: `packages/shared` — lint/build; then `packages/shared` tests)

**Expected result:** bridge tests PASS (new + existing); shared suite green; lint clean; build succeeds. `bridge-client.mjs` prints valid Cursor verdict JSON only for permission hooks; observation hooks stay observe-only.

**Commit message:**
```bash
git add packages/shared/src/connectors/cursor-hooks/bridge.ts packages/shared/src/connectors/cursor-hooks/bridge-client.mjs packages/shared/src/connectors/cursor-hooks/types.ts packages/shared/src/connectors/cursor-hooks/connector.ts packages/shared/src/connectors/cursor-hooks/__tests__/bridge.test.ts
git commit -m "feat(cursor-hooks): synchronous verdict for pre-execution permission hooks"
```

---

### Task 10 — Final Verification

**Objective:** Confirm the whole repo is green, no protected files changed, the phase commits are present, and push the phase checkpoint to `origin/main`.

**Files to create/modify:**
- None (verification only; docs commit optional if `docs/project-overview.md` or the plan was touched outside Task 7)

**Implementation steps:**

1. Confirm the protected paths are untouched against the true phase base (`e7daa8c` is the 3B discovery-base? NO — 3B base is `855e49b`, the Phase 3A checkpoint):
   ```powershell
   git status --short
   git diff --stat 855e49b..HEAD -- packages/shared/src/connectors/claude-code.ts packages/shared/src/connectors/codex-cli.ts apps/api/src/services/reconciliation.ts
   ```
   Expected: empty diff for those paths (reconciliation untouched; claude/codex untouched).

2. Full repo verification (turbo build → lint → test):
   ```powershell
   $env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
   $env:REDIS_URL = "redis://localhost:6379"
   npm run build
   npm run lint
   npm run test
   ```
   (workdir: repo root)
   Expected: build + lint clean; all tests green across shared, database, opencode-plugin, and api (including the four pre-existing connector e2e suites, all Phase 3A suites, and the new decision/prevention suites).

3. Confirm the phase commit list:
   ```powershell
   git log --oneline 855e49b..HEAD
   ```
   Expected: the 10 task commits (one per task) in order.

4. Commit any remaining doc/plan artifacts (e.g. the plan file itself, if repo convention tracks `docs/superpowers/plans/`):
   ```bash
   git add docs/superpowers/plans/2026-09-18-phase-3b-prevention.md docs/superpowers/specs/2026-09-18-phase-3b-prevention-design.md
   git commit -m "docs(rules): Phase 3B prevention design spec and implementation plan"
   ```

5. Push the phase checkpoint:
   ```bash
   git push origin main
   ```
   Expected: `main -> main` (repo convention; phase checkpoints are pushed commits).

**Exact validation commands:**
```powershell
git status --short
git diff --stat 855e49b..HEAD -- packages/shared/src/connectors/claude-code.ts packages/shared/src/connectors/codex-cli.ts apps/api/src/services/reconciliation.ts
npm run build; if ($?) { npm run lint }
npm run test
git log --oneline 855e49b..HEAD
git push origin main
```
(workdir: repo root)

**Expected result:** working tree clean after final commit; protected paths show zero diff; full repo build/lint/test green; 10 task commits plus the docs commit present; push succeeds.

**Commit message:**
```bash
git commit -m "docs(rules): Phase 3B prevention design spec and implementation plan"
git push origin main
```
