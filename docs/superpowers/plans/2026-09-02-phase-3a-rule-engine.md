# Phase 3A — Rule Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, harness-agnostic Rule Engine to the Meetless API that evaluates normalized agent events against workspace-scoped rules, persists auditable rule hits, and broadcasts NOTIFY hits via WebSocket — without altering conflict detection.

**Architecture:** A pure evaluator (`apps/api/src/services/rule-engine.ts`) sits between `normalizedEvent.create` and `ReconciliationEngine.processSessionEvent` inside the `POST /api/events` handler. Rules are fetched once per event (workspace-scoped, enabled), evaluated in-memory (all matching rules fire; priority is ordering only), hits are bulk-inserted with pre-generated ids/timestamps, NOTIFY hits are broadcast, and the 201 response gains an optional `ruleHits` array. Reconciliation is untouched.

**Tech Stack:** TypeScript (NodeNext), Fastify, Prisma (Postgres, db-push mode), picomatch (glob matching), vitest, ioredis/ws, PowerShell 5.1.

**Spec:** `docs/superpowers/specs/2026-09-01-phase-3a-rule-engine-design.md`

## Global Constraints

- Windows PowerShell 5.1. NEVER use `mkdir -p`. Use `; if ($?) { }` conditionals, NOT `&&`. Do not recreate existing directories.
- `apps/api` DB tests need a live Postgres. ALWAYS pass DATABASE_URL externally because `apps/api/vitest.setup.ts` defaults to the wrong credentials (`postgres:postgres`); the running container uses `meetless:meetless`:
  - `$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"`
  - Also set `$env:REDIS_URL = "redis://localhost:6379"` when running commands that boot the app.
- db-push mode (no migrations). Schema changes: `npm run db:push` + `npm run db:generate` from `packages/database`.
- Do NOT modify: `packages/shared/src/connectors/**`, `packages/opencode-plugin/**`, the reconciliation algorithm in `apps/api/src/services/reconciliation.ts`, or the `NormalizedAgentEvent`/`AgentAction` types.
- Scope gate (spec §3, §13): NO prevention/veto, context injection, approval flows, dry-run endpoint, retention, auth/RBAC, dashboard, or other 3B+ features. Actions are `LOG` and `NOTIFY` only. All matching rules fire; priority is ordering only (never first-match-wins, never suppresses a lower-priority match).
- Deterministic ordering everywhere results list in rule order: `priority ASC → createdAt ASC → id ASC`. The evaluator sorts internally regardless of input order.
- `matchedOn` in both `RuleHit` and `RuleEvaluationResult` is the fixed nullable shape `{ tool, pathPattern, connectorId, agentPattern }` — all four keys always present; `null` when unconstrained (do not delete keys).
- Clever-but-exact rule-hit construction: generate hit ids/timestamps BEFORE persistence (a single shared `firedAt` per evaluation request, `randomUUID()` per hit) so broadcast payload ids exactly match persisted rows — no per-hit queries.
- Zero-constraint divergence (both must be preserved): the pure evaluator treats an all-`null` constraint rule as matching everything; the API refuses to create/update a rule with zero constraints (400).
- Rule evaluation failure must NEVER block ingestion or reconciliation: the seam runs in try/catch, logs with diagnostic context, and the handler still returns 201.
- Repo test conventions: vitest, colocated `__tests__/`, `fileParallelism:false`, real Prisma, FK-safe `beforeEach` cleanup, `randSuffix()` helper.
- Repo commit style: Conventional-Commit-ish scope prefix (e.g. `feat(rules):`, `test(rules):`, `docs(rules):`). Every task ends with a commit. Working copy is on `main`; the phase ends with a push to `origin/main` (repo convention; no release tags are used — phase checkpoints are pushed commits).

---

### Task 1: Prisma schema — Rule, RuleHit, RuleAction

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Test: `packages/database/src/__tests__/rule-models.test.ts`

**Interfaces:**
- Consumes: existing `Workspace` model (FK target).
- Produces: Prisma models `Rule`, `RuleHit` and enum `RuleAction` (available on `@prisma/client` as `PrismaClient['rule']`, `PrismaClient['ruleHit']`), plus `RuleAction` as a generated enum class (`$Enums.RuleAction`). `RuleHit` has NO FK relations (scalar `ruleId`, `workspaceId`, `sessionId` only).

- [ ] **Step 1: Write the failing model test**

Create `packages/database/src/__tests__/rule-models.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'

const prisma = new PrismaClient()

beforeAll(async () => {
  await prisma.$connect()
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('Rule / RuleHit models', () => {
  it('persists a Rule scoped to a workspace and a scalar RuleHit that survives Rule deletion', async () => {
    const team = await prisma.team.create({ data: { name: 'Rules Team', slug: `rules-${randomUUID()}` } })
    const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'Rules WS' } })

    const rule = await prisma.rule.create({
      data: {
        workspaceId: workspace.id,
        name: 'Protect prod config',
        tool: null,
        pathPattern: 'config/prod/**',
        connectorId: null,
        agentPattern: null,
        action: 'NOTIFY',
        message: 'Prod config is off-limits',
        priority: 10,
      },
    })
    expect(rule.workspaceId).toBe(workspace.id)
    expect(rule.enabled).toBe(true)

    const hit = await prisma.ruleHit.create({
      data: {
        ruleId: rule.id,
        workspaceId: workspace.id,
        sessionId: 'any-session',
        agentId: 'claude-1',
        connectorId: 'claude-code',
        tool: 'edit_file',
        path: 'config/prod/app.yaml',
        ruleName: rule.name,
        action: rule.action,
        matchedOn: { tool: null, pathPattern: 'config/prod/**', connectorId: null, agentPattern: null },
        message: rule.message,
      },
    })
    expect(hit.ruleId).toBe(rule.id)
    expect(hit.matchedOn).toMatchObject({ pathPattern: 'config/prod/**' })

    // Delete the Rule; the scalar RuleHit must survive (no FK relation).
    await prisma.rule.delete({ where: { id: rule.id } })
    const surviving = await prisma.ruleHit.findUnique({ where: { id: hit.id } })
    expect(surviving).not.toBeNull()
    expect(surviving?.ruleId).toBe(rule.id)
    expect(surviving?.ruleName).toBe('Protect prod config')

    // cleanup
    await prisma.ruleHit.deleteMany({})
    await prisma.workspace.delete({ where: { id: workspace.id } })
    await prisma.team.delete({ where: { id: team.id } })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
npx vitest run src/__tests__/rule-models.test.ts
```
(workdir: `packages/database`)
Expected: FAIL — `prisma.rule` is undefined (model does not exist yet).

- [ ] **Step 3: Add the schema**

Modify `packages/database/prisma/schema.prisma` — append the enum and two models (placement: after the `Connector` model, before end of file):

```prisma
enum RuleAction {
  LOG
  NOTIFY
}

model Rule {
  id           String     @id @default(cuid())
  workspaceId  String
  name         String
  description  String?
  enabled      Boolean    @default(true)
  priority     Int        @default(100)
  tool         String?
  pathPattern  String?
  connectorId  String?
  agentPattern String?
  action       RuleAction
  message      String?
  createdBy    String?
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
  workspace    Workspace  @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  @@index([workspaceId, enabled])
}

model RuleHit {
  id          String   @id @default(cuid())
  ruleId      String
  workspaceId String
  sessionId   String
  agentId     String
  connectorId String
  tool        String
  path        String?
  ruleName    String
  action      RuleAction
  matchedOn   Json
  message     String?
  createdAt   DateTime @default(now())
  @@index([sessionId, createdAt])
  @@index([ruleId])
  @@index([workspaceId, createdAt])
}
```

Note: `RuleHit` intentionally has NO `@relation` lines — it is fully scalar per spec §2(4) and §4.

- [ ] **Step 4: Push + generate the client, then run the test**

```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
npm run db:generate   # workdir: packages/database (regenerates @prisma/client)
npm run db:push
npx vitest run src/__tests__/rule-models.test.ts
```
(workdir: `packages/database`)
Expected: `db:generate` succeeds, `db:push` reports the schema in sync / applied, and the test PASSES. (The push may report that it applied new models.)

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/src/__tests__/rule-models.test.ts
git commit -m "feat(rules): add Rule and RuleHit Prisma models and RuleAction enum"
```

---

### Task 2: Pure rule-evaluator service + picomatch dependency + unit tests

**Files:**
- Modify: `apps/api/package.json` (add `picomatch` deps)
- Create: `apps/api/src/services/rule-engine.ts`
- Test: `apps/api/src/services/__tests__/rule-engine.test.ts`

**Interfaces:**
- Consumes: `NormalizedAgentEvent` from `@meetless/shared/types` (type-only; no runtime dep).
- Produces:
  - `export type RuleAction = 'LOG' | 'NOTIFY'`
  - `export interface RuleLike { id: string; name: string; enabled: boolean; priority: number; tool: string | null; pathPattern: string | null; connectorId: string | null; agentPattern: string | null; action: RuleAction; message: string | null; createdAt: Date | string }`
  - `export interface RuleMatchedOn { tool: string | null; pathPattern: string | null; connectorId: string | null; agentPattern: string | null }`
  - `export interface RuleEvaluationResult { ruleId: string; ruleName: string; action: RuleAction; message: string | null; matchedOn: RuleMatchedOn; event: { agentId: string; connectorId: string; tool: string; path: string | null } }`
  - `export function isValidGlob(pattern: string): boolean`
  - `export function evaluate(event: NormalizedAgentEvent, rules: RuleLike[]): RuleEvaluationResult[]`

- [ ] **Step 1: Install picomatch**

```powershell
npm install picomatch --workspace=@meetless/api
npm install -D @types/picomatch --workspace=@meetless/api
```
(workdir: repo root)
Expected: both install cleanly; `picomatch` appears in `apps/api/package.json` `dependencies`, `@types/picomatch` in `devDependencies`.

- [ ] **Step 2: Write the failing unit tests**

Create `apps/api/src/services/__tests__/rule-engine.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { evaluate, isValidGlob } from '../rule-engine.js'
import type { RuleLike } from '../rule-engine.js'

const base = (over: Partial<RuleLike> = {}): RuleLike => ({
  id: 'r1',
  name: 'rule',
  enabled: true,
  priority: 100,
  tool: null,
  pathPattern: null,
  connectorId: null,
  agentPattern: null,
  action: 'LOG',
  message: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
})

const event = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  agentId: 'claude-1',
  tool: 'edit_file',
  params: { path: 'src/app.ts', content: 'x' },
  result: {},
  timestamp: 1,
  connectorId: 'claude-code',
  connectorVersion: '1.0.0',
  mcpEventId: 'm1',
  ...over,
})

const ctx = (r: RuleLike) => ({ process: { env: {} }, cwd: () => '' })

describe('evaluate', () => {
  it('matches a rule on exact tool', () => {
    const r = base({ tool: 'edit_file', action: 'LOG' })
    const res = evaluate(event() as never, [r])
    expect(res).toHaveLength(1)
    expect(res[0].ruleId).toBe('r1')
    expect(res[0].action).toBe('LOG')
  })

  it('does not match a rule when tool differs', () => {
    const r = base({ tool: 'bash' })
    const res = evaluate(event() as never, [r])
    expect(res).toHaveLength(0)
  })

  it('matches a path glob **', () => {
    const r = base({ pathPattern: 'config/prod/**', action: 'NOTIFY' })
    const res = evaluate(event({ params: { path: 'config/prod/app.yaml', content: 'x' } }) as never, [r])
    expect(res).toHaveLength(1)
    expect(res[0].matchedOn.pathPattern).toBe('config/prod/**')
  })

  it('matches a path glob * within a segment', () => {
    const r = base({ pathPattern: 'src/*.ts' })
    const res = evaluate(event({ params: { path: 'src/app.ts' } }) as never, [r])
    expect(res).toHaveLength(1)
  })

  it('does not match when path does not fit the pattern', () => {
    const r = base({ pathPattern: 'contracts/**' })
    const res = evaluate(event({ params: { path: 'src/app.ts' } }) as never, [r])
    expect(res).toHaveLength(0)
  })

  it('normalizes backslashes before matching', () => {
    const r = base({ pathPattern: 'src/*.ts' })
    const res = evaluate(event({ params: { path: 'src\\app.ts' } }) as never, [r])
    expect(res).toHaveLength(1)
  })

  it('never matches a path rule when the event has no string path', () => {
    const r = base({ pathPattern: '**' })
    const res = evaluate(event({ tool: 'bash', params: { command: 'ls' } }) as never, [r])
    expect(res).toHaveLength(0)
  })

  it('matches a rule on exact connectorId', () => {
    const r = base({ connectorId: 'claude-code' })
    const res = evaluate(event() as never, [r])
    expect(res).toHaveLength(1)
    expect(res[0].matchedOn.connectorId).toBe('claude-code')
  })

  it('does not match when connectorId differs', () => {
    const r = base({ connectorId: 'codex-cli' })
    const res = evaluate(event() as never, [r])
    expect(res).toHaveLength(0)
  })

  it('matches an agent pattern glob', () => {
    const r = base({ agentPattern: 'frontend-*' })
    const res = evaluate(event({ agentId: 'frontend-editor-1' }) as never, [r])
    expect(res).toHaveLength(1)
    expect(res[0].event.agentId).toBe('frontend-editor-1')
  })

  it('respects AND semantics: all set constraints must match', () => {
    const r = base({ connectorId: 'claude-code', tool: 'edit_file', pathPattern: 'contracts/**' })
    const good = evaluate(event({ params: { path: 'contracts/api.yaml' } }) as never, [r])
    const bad = evaluate(event({ params: { path: 'src/app.ts' } }) as never, [r])
    expect(good).toHaveLength(1)
    expect(bad).toHaveLength(0)
  })

  it('does not evaluate disabled rules', () => {
    const r = base({ enabled: false })
    const res = evaluate(event() as never, [r])
    expect(res).toHaveLength(0)
  })

  it('treats a zero-constraint rule as matching everything (pure-evaluator contract)', () => {
    const r = base({}) // all constraints null
    const res = evaluate(event() as never, [r])
    expect(res).toHaveLength(1)
  })

  it('fires ALL matching rules; priority only orders results and never suppresses', () => {
    const low = base({ id: 'low', priority: 500 })
    const high = base({ id: 'high', priority: 10 })
    const res = evaluate(event() as never, [high, low]) // priority 10 first
    expect(res.map((x) => x.ruleId)).toEqual(['high', 'low'])
  })

  it('orders by priority asc, then createdAt asc, then id asc (input order irrelevant)', () => {
    const a = base({ id: 'a', priority: 100, createdAt: new Date('2026-01-02T00:00:00Z') })
    const b = base({ id: 'b', priority: 100, createdAt: new Date('2026-01-01T00:00:00Z') })
    const c = base({ id: 'c', priority: 50 })
    const res = evaluate(event() as never, [a, b, c])
    expect(res.map((x) => x.ruleId)).toEqual(['c', 'b', 'a'])
  })

  it('is deterministic: same input twice yields deep-equal output', () => {
    const rules = [base({ id: 'a' }), base({ id: 'b', action: 'NOTIFY', pathPattern: 'x/**' })]
    const e = event() as never
    expect(evaluate(e, rules)).toEqual(evaluate(e, rules))
  })

  it('produces the fixed nullable matchedOn shape', () => {
    const r = base({ pathPattern: 'config/**' })
    const res = evaluate(event() as never, [r])
    expect(res[0].matchedOn).toEqual({ tool: null, pathPattern: 'config/**', connectorId: null, agentPattern: null })
  })

  it('connector-independence: connectorless rule yields identical results across all connectors', () => {
    const r = base({ pathPattern: 'src/**' })
    const connectors = ['claude-code', 'codex-cli', 'cursor-hooks', 'opencode']
    const results = connectors.map((cid) => {
      const res = evaluate(event({ connectorId: cid }) as never, [r])
      return { tool: res[0].event.tool, path: res[0].event.path }
    })
    expect(results).toEqual([
      { tool: 'edit_file', path: 'src/app.ts' },
      { tool: 'edit_file', path: 'src/app.ts' },
      { tool: 'edit_file', path: 'src/app.ts' },
      { tool: 'edit_file', path: 'src/app.ts' },
    ])
  })
})

describe('isValidGlob', () => {
  it('accepts a valid glob', () => {
    expect(isValidGlob('config/prod/**')).toBe(true)
    expect(isValidGlob('*.ts')).toBe(true)
  })
  it('rejects a malformed glob (unbalanced paren)', () => {
    expect(isValidGlob('config(prod/**')).toBe(false)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

```powershell
npx vitest run src/services/__tests__/rule-engine.test.ts
```
(workdir: `apps/api`)
Expected: FAIL — `../rule-engine.js` module / `evaluate` / `isValidGlob` not found.

- [ ] **Step 4: Implement the evaluator**

Create `apps/api/src/services/rule-engine.ts`:

```ts
import picomatch from 'picomatch'
import type { NormalizedAgentEvent } from '@meetless/shared/types'

export type RuleAction = 'LOG' | 'NOTIFY'

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
  message: string | null
  createdAt: Date | string
}

export interface RuleMatchedOn {
  tool: string | null
  pathPattern: string | null
  connectorId: string | null
  agentPattern: string | null
}

export interface RuleEvaluationResult {
  ruleId: string
  ruleName: string
  action: RuleAction
  message: string | null
  matchedOn: RuleMatchedOn
  event: { agentId: string; connectorId: string; tool: string; path: string | null }
}

const normalizePath = (p: string): string => p.replaceAll('\\', '/')

export function isValidGlob(pattern: string): boolean {
  try {
    picomatch(pattern, { dot: true })
    return true
  } catch {
    return false
  }
}

function eventPath(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null
  const p = (params as Record<string, unknown>).path
  return typeof p === 'string' ? p : null
}

function matchesRule(rule: RuleLike, path: string | null, event: NormalizedAgentEvent): boolean {
  if (rule.tool !== null && rule.tool !== event.tool) return false
  if (rule.connectorId !== null && rule.connectorId !== event.connectorId) return false
  if (rule.agentPattern !== null && !picomatch(rule.agentPattern, { dot: true })(event.agentId)) return false
  if (rule.pathPattern !== null) {
    if (path === null) return false
    if (!picomatch(rule.pathPattern, { dot: true })(normalizePath(path))) return false
  }
  return true
}

function byDeterministicOrder(a: RuleLike, b: RuleLike): number {
  if (a.priority !== b.priority) return a.priority - b.priority
  const at = new Date(a.createdAt).getTime()
  const bt = new Date(b.createdAt).getTime()
  if (at !== bt) return at - bt
  return a.id.localeCompare(b.id)
}

export function evaluate(event: NormalizedAgentEvent, rules: RuleLike[]): RuleEvaluationResult[] {
  const path = eventPath(event.params)
  return [...rules]
    .sort(byDeterministicOrder)
    .filter((r) => r.enabled)
    .filter((r) => matchesRule(r, path, event))
    .map((r) => ({
      ruleId: r.id,
      ruleName: r.name,
      action: r.action,
      message: r.message,
      matchedOn: { tool: r.tool, pathPattern: r.pathPattern, connectorId: r.connectorId, agentPattern: r.agentPattern },
      event: { agentId: event.agentId, connectorId: event.connectorId, tool: event.tool, path },
    }))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```powershell
npx vitest run src/services/__tests__/rule-engine.test.ts
```
(workdir: `apps/api`)
Expected: PASS (all tests). If a `picomatch` import shape error appears, run `npm run build` first and confirm `tsconfig.base.json` uses `esModuleInterop` (it does — `app.ts` imports default from `fastify`); do not change the import.

- [ ] **Step 6: Run lint + full api build to confirm no type errors**

```powershell
npm run lint
npm run build
```
(workdir: `apps/api`)
Expected: clean lint, successful `tsc` build.

- [ ] **Step 7: Commit**

```bash
git add apps/api/package.json apps/api/package-lock.json apps/api/src/services/rule-engine.ts apps/api/src/services/__tests__/rule-engine.test.ts
git commit -m "feat(rules): add deterministic rule evaluator with glob matching"
```

---

### Task 3: WebSocket broadcastRuleHit

**Files:**
- Modify: `apps/api/src/services/ws-manager.ts`
- Test: `apps/api/src/services/ws-manager.test.ts`

**Interfaces:**
- Consumes: existing `WSManager.broadcastToSession`, `WSClient`, and the singleton `wsManager`.
- Produces: `WSManager.broadcastRuleHit(sessionId: string, payload: unknown): void` — emits `{ type: 'rule_triggered', payload }` to the session channel (single-nested `type`, unlike `conflict_created`).

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `apps/api/src/services/ws-manager.test.ts` (preserve existing imports; if `WebSocket` isn't imported, import `{ WebSocket } from 'ws'`; `vi` must be imported from `vitest`):

```ts
describe('broadcastRuleHit', () => {
  it('broadcasts a single-nested rule_triggered message to the session', () => {
    const send = vi.fn()
    const fakeWs = { readyState: WebSocket.OPEN, send } as unknown as import('ws').WebSocket
    const m = new WSManager()
    m.add({ id: 'c1', sessionId: 's1', agentId: 'a1', ws: fakeWs, connectedAt: new Date() })

    m.broadcastRuleHit('s1', { id: 'hit-1', ruleId: 'r1', ruleName: 'rule', sessionId: 's1', agentId: 'a1' })

    const sent = JSON.parse(send.mock.calls[0][0] as string)
    expect(sent.type).toBe('rule_triggered')
    expect(sent.payload).toEqual({ id: 'hit-1', ruleId: 'r1', ruleName: 'rule', sessionId: 's1', agentId: 'a1' })
  })

  it('does not broadcast when there are no clients in the session', () => {
    const m = new WSManager()
    expect(() => m.broadcastRuleHit('s-absent', { id: 'x' })).not.toThrow()
  })
})
```

Expected initial state: if the existing test file uses `vi`, `WSManager` and `WebSocket` — confirm the imports; otherwise add them. Run the file and expect the new tests to FAIL because `broadcastRuleHit` does not exist.

- [ ] **Step 2: Run the test to verify it fails**

```powershell
npx vitest run src/services/ws-manager.test.ts
```
(workdir: `apps/api`)
Expected: FAIL — `broadcastRuleHit is not a function`.

- [ ] **Step 3: Implement**

Add to `apps/api/src/services/ws-manager.ts` (place after `broadcastConflictResolved`, before `getSessionClients`):

```ts
  broadcastRuleHit(sessionId: string, payload: unknown) {
    this.broadcastToSession(sessionId, { type: 'rule_triggered', payload })
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```powershell
npx vitest run src/services/ws-manager.test.ts
```
(workdir: `apps/api`)
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ws-manager.ts apps/api/src/services/ws-manager.test.ts
git commit -m "feat(rules): add WS rule_triggered broadcast"
```

---

### Task 4: Rules CRUD routes + rule-hits endpoint + app registration

**Files:**
- Create: `apps/api/src/routes/rules.ts`
- Create: `apps/api/src/routes/__tests__/rules.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `app.prisma` (decorated), `isValidGlob` from `../services/rule-engine.js`, `RuleLike`/`RuleAction` types from the same module.
- Produces: routes `POST /api/rules`, `GET /api/rules?workspaceId=…`, `PATCH /api/rules/:id`, `DELETE /api/rules/:id`, `GET /api/sessions/:sessionId/rule-hits`. Rule validation: ≥1 constraint (`tool | pathPattern | connectorId | agentPattern` non-empty after trim), valid globs, workspace exists, `action` in enum. Ordering: `priority asc, createdAt asc, id asc`.
- Later tasks use the public serialized Rule shape: `{ id, workspaceId, name, description, enabled, priority, tool, pathPattern, connectorId, agentPattern, action, message, createdBy, createdAt(ISO), updatedAt(ISO) }` and hit shape `{ id, ruleId, workspaceId, sessionId, agentId, connectorId, tool, path, ruleName, action, matchedOn, message, createdAt(ISO) }`.

- [ ] **Step 1: Write the failing route tests**

Create `apps/api/src/routes/__tests__/rules.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../../app.js'
import { prisma } from '@meetless/database/client'

let app: Awaited<ReturnType<typeof buildApp>>

const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function createWorkspace() {
  const team = await prisma.team.create({ data: { name: `T-${randSuffix()}`, slug: `t-${randSuffix()}` } })
  return prisma.workspace.create({ data: { teamId: team.id, name: `W-${randSuffix()}` } })
}

const validRuleBody = (workspaceId: string) => ({
  workspaceId,
  name: 'Protect prod',
  action: 'NOTIFY',
  pathPattern: 'config/prod/**',
  message: 'off-limits',
})

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

beforeEach(async () => {
  await prisma.normalizedEvent.deleteMany()
  await prisma.conflict.deleteMany()
  await prisma.ruleHit.deleteMany()
  await prisma.rule.deleteMany()
  await prisma.session.deleteMany()
  await prisma.workspace.deleteMany()
  await prisma.membership.deleteMany()
  await prisma.user.deleteMany()
  await prisma.team.deleteMany()
  await prisma.connector.deleteMany()
})

describe('POST /api/rules', () => {
  it('creates a rule', async () => {
    const ws = await createWorkspace()
    const res = await app.inject({ method: 'POST', url: '/api/rules', payload: validRuleBody(ws.id) })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)
    expect(body.action).toBe('NOTIFY')
    expect(body.enabled).toBe(true)
    expect(body.priority).toBe(100)
    expect(body.pathPattern).toBe('config/prod/**')
  })
  it('rejects a rule with zero constraints', async () => {
    const ws = await createWorkspace()
    const res = await app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: { workspaceId: ws.id, name: 'match-all', action: 'LOG', tool: '   ' },
    })
    expect(res.statusCode).toBe(400)
  })
  it('rejects an invalid path glob', async () => {
    const ws = await createWorkspace()
    const res = await app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: { ...validRuleBody(ws.id), pathPattern: 'config(prod/**' },
    })
    expect(res.statusCode).toBe(400)
  })
  it('rejects an unknown workspaceId', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/rules', payload: validRuleBody('nope') })
    expect(res.statusCode).toBe(400)
  })
  it('rejects an invalid action via schema enum', async () => {
    const ws = await createWorkspace()
    const res = await app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: { ...validRuleBody(ws.id), action: 'PREVENT' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /api/rules', () => {
  it('lists rules for a workspace ordered by priority asc', async () => {
    const ws = await createWorkspace()
    await prisma.rule.createMany({
      data: [
        { workspaceId: ws.id, name: 'a', action: 'LOG', priority: 100 },
        { workspaceId: ws.id, name: 'b', action: 'NOTIFY', priority: 10 },
      ],
    })
    const res = await app.inject({ method: 'GET', url: `/api/rules?workspaceId=${ws.id}` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.map((r: { name: string }) => r.name)).toEqual(['b', 'a'])
  })
  it('rejects a missing workspaceId query', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/rules' })
    expect(res.statusCode).toBe(400)
  })
})

describe('PATCH /api/rules/:id', () => {
  it('updates fields and can disable a rule', async () => {
    const ws = await createWorkspace()
    const rule = await prisma.rule.create({ data: { workspaceId: ws.id, name: 'r', action: 'LOG', pathPattern: 'a/**' } })
    const res = await app.inject({ method: 'PATCH', url: `/api/rules/${rule.id}`, payload: { enabled: false, message: 'new' } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.enabled).toBe(false)
    expect(body.message).toBe('new')
  })
  it('rejects an update that leaves zero constraints', async () => {
    const ws = await createWorkspace()
    const rule = await prisma.rule.create({ data: { workspaceId: ws.id, name: 'r', action: 'LOG', pathPattern: 'a/**' } })
    const res = await app.inject({ method: 'PATCH', url: `/api/rules/${rule.id}`, payload: { pathPattern: null, tool: null, connectorId: null, agentPattern: null } })
    expect(res.statusCode).toBe(400)
  })
  it('returns 404 for an unknown rule', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/rules/does-not-exist', payload: { enabled: false } })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /api/rules/:id', () => {
  it('deletes a rule and returns its id', async () => {
    const ws = await createWorkspace()
    const rule = await prisma.rule.create({ data: { workspaceId: ws.id, name: 'r', action: 'LOG', pathPattern: 'a/**' } })
    const res = await app.inject({ method: 'DELETE', url: `/api/rules/${rule.id}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).id).toBe(rule.id)
    expect(await prisma.rule.findUnique({ where: { id: rule.id } })).toBeNull()
  })
  it('returns 404 for an unknown rule', async () => {
    const ws = await createWorkspace()
    await prisma.rule.create({ data: { workspaceId: ws.id, name: 'r', action: 'LOG', pathPattern: 'a/**' } })
    const res = await app.inject({ method: 'DELETE', url: '/api/rules/does-not-exist' })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/sessions/:sessionId/rule-hits', () => {
  it('returns hits for a session ordered by createdAt desc with matchedOn shape', async () => {
    const ws = await createWorkspace()
    const rule = await prisma.rule.create({ data: { workspaceId: ws.id, name: 'r', action: 'NOTIFY', pathPattern: 'a/**' } })
    await prisma.ruleHit.createMany({
      data: [
        { ruleId: rule.id, workspaceId: ws.id, sessionId: 's1', agentId: 'a', connectorId: 'c', tool: 't', path: 'a/x', ruleName: 'r', action: 'NOTIFY', matchedOn: { tool: null, pathPattern: 'a/**', connectorId: null, agentPattern: null }, message: 'm', createdAt: new Date('2026-01-02T00:00:00Z') },
        { ruleId: rule.id, workspaceId: ws.id, sessionId: 's1', agentId: 'a', connectorId: 'c', tool: 't', path: 'a/x', ruleName: 'r', action: 'NOTIFY', matchedOn: { tool: null, pathPattern: 'a/**', connectorId: null, agentPattern: null }, message: 'm', createdAt: new Date('2026-01-01T00:00:00Z') },
      ],
    })
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/rule-hits' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body).toHaveLength(2)
    expect(body[0].createdAt).toBe('2026-01-02T00:00:00.000Z')
    expect(body[0].matchedOn).toEqual({ tool: null, pathPattern: 'a/**', connectorId: null, agentPattern: null })
  })
})
```

- [ ] **Step 2: Run the route tests to verify they fail**

```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
npx vitest run src/routes/__tests__/rules.test.ts
```
(workdir: `apps/api`)
Expected: FAIL — route `/api/rules` returns 404 (not registered yet).

- [ ] **Step 3: Implement the routes + register**

Create `apps/api/src/routes/rules.ts`:

```ts
import { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { isValidGlob } from '../services/rule-engine.js'
import type { RuleAction } from '../services/rule-engine.js'

interface RuleBody {
  workspaceId?: string
  name?: string
  description?: string
  enabled?: boolean
  priority?: number
  tool?: string
  pathPattern?: string
  connectorId?: string
  agentPattern?: string
  action?: RuleAction
  message?: string
  createdBy?: string
}

const ruleResponseSchema = {
  type: 'object',
  required: ['id', 'workspaceId', 'name', 'enabled', 'priority', 'action', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    workspaceId: { type: 'string' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    enabled: { type: 'boolean' },
    priority: { type: 'integer' },
    tool: { type: ['string', 'null'] },
    pathPattern: { type: ['string', 'null'] },
    connectorId: { type: ['string', 'null'] },
    agentPattern: { type: ['string', 'null'] },
    action: { type: 'string', enum: ['LOG', 'NOTIFY'] },
    message: { type: ['string', 'null'] },
    createdBy: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const

const hitResponseSchema = {
  type: 'object',
  required: ['id', 'ruleId', 'workspaceId', 'sessionId', 'agentId', 'connectorId', 'tool', 'ruleName', 'action', 'matchedOn', 'createdAt'],
  properties: {
    id: { type: 'string' },
    ruleId: { type: 'string' },
    workspaceId: { type: 'string' },
    sessionId: { type: 'string' },
    agentId: { type: 'string' },
    connectorId: { type: 'string' },
    tool: { type: 'string' },
    path: { type: ['string', 'null'] },
    ruleName: { type: 'string' },
    action: { type: 'string', enum: ['LOG', 'NOTIFY'] },
    matchedOn: { type: 'object', additionalProperties: true },
    message: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const

function toPublicRule(r: {
  id: string; workspaceId: string; name: string; description: string | null; enabled: boolean; priority: number;
  tool: string | null; pathPattern: string | null; connectorId: string | null; agentPattern: string | null;
  action: RuleAction; message: string | null; createdBy: string | null; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: r.id, workspaceId: r.workspaceId, name: r.name, description: r.description, enabled: r.enabled,
    priority: r.priority, tool: r.tool, pathPattern: r.pathPattern, connectorId: r.connectorId,
    agentPattern: r.agentPattern, action: r.action, message: r.message, createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  }
}

const toStringOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null

function validateConstraints(fields: {
  tool?: unknown; pathPattern?: unknown; connectorId?: unknown; agentPattern?: unknown;
}, globCtx: { pathPattern?: unknown; agentPattern?: unknown } = {}): string | null {
  const tool = toStringOrNull(fields.tool)
  const pathPattern = toStringOrNull(fields.pathPattern)
  const connectorId = toStringOrNull(fields.connectorId)
  const agentPattern = toStringOrNull(fields.agentPattern)
  if (tool === null && pathPattern === null && connectorId === null && agentPattern === null) {
    return 'Rule requires at least one constraint (tool, pathPattern, connectorId, agentPattern)'
  }
  const pp = toStringOrNull(globCtx.pathPattern ?? fields.pathPattern)
  if (pp !== null && !isValidGlob(pp)) return 'Invalid glob pattern: pathPattern'
  const ap = toStringOrNull(globCtx.agentPattern ?? fields.agentPattern)
  if (ap !== null && !isValidGlob(ap)) return 'Invalid glob pattern: agentPattern'
  return null
}

export const ruleRoutes: FastifyPluginAsync = async (app) => {
  app.post('/rules', {
    schema: {
      body: {
        type: 'object',
        required: ['workspaceId', 'name', 'action'],
        properties: {
          workspaceId: { type: 'string' },
          name: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          enabled: { type: 'boolean' },
          priority: { type: 'integer' },
          tool: { type: 'string' },
          pathPattern: { type: 'string' },
          connectorId: { type: 'string' },
          agentPattern: { type: 'string' },
          action: { type: 'string', enum: ['LOG', 'NOTIFY'] },
          message: { type: 'string' },
          createdBy: { type: 'string' },
        },
      },
      response: { 201: ruleResponseSchema, 400: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } } },
    },
  }, async (req, reply) => {
    const body = req.body as RuleBody
    const workspace = await app.prisma.workspace.findUnique({ where: { id: body.workspaceId! } })
    if (!workspace) return reply.code(400).send({ error: 'Invalid workspaceId' })

    const err = validateConstraints(body)
    if (err) return reply.code(400).send({ error: err })

    const rule = await app.prisma.rule.create({
      data: {
        workspaceId: body.workspaceId!,
        name: body.name!,
        description: body.description,
        enabled: body.enabled ?? true,
        priority: body.priority ?? 100,
        tool: toStringOrNull(body.tool),
        pathPattern: toStringOrNull(body.pathPattern),
        connectorId: toStringOrNull(body.connectorId),
        agentPattern: toStringOrNull(body.agentPattern),
        action: body.action!,
        message: body.message,
        createdBy: body.createdBy,
      },
    })
    return reply.code(201).send(toPublicRule(rule))
  })

  app.get('/rules', {
    schema: {
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
      response: { 200: { type: 'array', items: ruleResponseSchema } },
    },
  }, async (req) => {
    const { workspaceId } = req.query as { workspaceId: string }
    const rules = await app.prisma.rule.findMany({
      where: { workspaceId },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    })
    return rules.map(toPublicRule)
  })

  app.patch('/rules/:id', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: ['string', 'null'] },
          enabled: { type: 'boolean' },
          priority: { type: 'integer' },
          tool: { type: ['string', 'null'] },
          pathPattern: { type: ['string', 'null'] },
          connectorId: { type: ['string', 'null'] },
          agentPattern: { type: ['string', 'null'] },
          action: { type: 'string', enum: ['LOG', 'NOTIFY'] },
          message: { type: ['string', 'null'] },
          createdBy: { type: ['string', 'null'] },
        },
      },
      response: { 200: ruleResponseSchema, 400: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } }, 404: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } } },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as RuleBody
    const existing = await app.prisma.rule.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: 'Rule not found' })

    const merged = {
      tool: body.tool !== undefined ? toStringOrNull(body.tool) : existing.tool,
      pathPattern: body.pathPattern !== undefined ? toStringOrNull(body.pathPattern) : existing.pathPattern,
      connectorId: body.connectorId !== undefined ? toStringOrNull(body.connectorId) : existing.connectorId,
      agentPattern: body.agentPattern !== undefined ? toStringOrNull(body.agentPattern) : existing.agentPattern,
    }
    const err = validateConstraints(merged)
    if (err) return reply.code(400).send({ error: err })

    const updated = await app.prisma.rule.update({
      where: { id },
      data: {
        name: body.name ?? existing.name,
        description: body.description !== undefined ? body.description : existing.description,
        enabled: body.enabled ?? existing.enabled,
        priority: body.priority ?? existing.priority,
        tool: merged.tool,
        pathPattern: merged.pathPattern,
        connectorId: merged.connectorId,
        agentPattern: merged.agentPattern,
        action: body.action ?? (existing.action as RuleAction),
        message: body.message !== undefined ? body.message : existing.message,
        createdBy: body.createdBy !== undefined ? body.createdBy : existing.createdBy,
      },
    })
    return updated
  })

  app.delete('/rules/:id', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, 404: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } } },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await app.prisma.rule.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: 'Rule not found' })
    await app.prisma.rule.delete({ where: { id } })
    return { id }
  })

  app.get('/sessions/:sessionId/rule-hits', {
    schema: {
      params: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
      response: { 200: { type: 'array', items: hitResponseSchema } },
    },
  }, async (req) => {
    const { sessionId } = req.params as { sessionId: string }
    const hits = await app.prisma.ruleHit.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    return hits.map((h) => ({
      id: h.id, ruleId: h.ruleId, workspaceId: h.workspaceId, sessionId: h.sessionId,
      agentId: h.agentId, connectorId: h.connectorId, tool: h.tool, path: h.path,
      ruleName: h.ruleName, action: h.action, matchedOn: h.matchedOn, message: h.message,
      createdAt: h.createdAt.toISOString(),
    }))
  })
}
```

Register in `apps/api/src/app.ts` (add import, then register after `conflictRoutes`):

```ts
import { ruleRoutes } from './routes/rules.js'
// ...
  await app.register(conflictRoutes, { prefix: '/api' })
  await app.register(ruleRoutes, { prefix: '/api' })
```

- [ ] **Step 4: Run the route tests to verify they pass**

```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
npx vitest run src/routes/__tests__/rules.test.ts
```
(workdir: `apps/api`)
Expected: PASS (all).

- [ ] **Step 5: Lint + build**

```powershell
npm run lint
npm run build
```
(workdir: `apps/api`)
Expected: clean lint, successful build.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/rules.ts apps/api/src/routes/__tests__/rules.test.ts apps/api/src/app.ts
git commit -m "feat(rules): add rules CRUD and session rule-hits endpoints"
```

---

### Task 5: Ingestion seam — evaluate, persist hits, broadcast, surface ruleHits

**Files:**
- Modify: `apps/api/src/routes/events.ts`
- Test: `apps/api/src/routes/__tests__/events.test.ts`

**Interfaces:**
- Consumes: `evaluate` from `../services/rule-engine.js`; `RuleAction` type; existing `app.prisma`, `app.wsManager`, `randomUUID` from `node:crypto`.
- Produces: after `normalizedEvent.create` and before `reconciliation.processSessionEvent`, the handler (a) fetches enabled workspace rules, (b) evaluates, (c) constructs hit rows (pre-generated `id` + shared `firedAt` timestamp) and bulk-inserts, (d) broadcasts NOTIFY hits, (e) appends an optional `ruleHits` array to the 201 response. Rule evaluation is wrapped in try/catch that logs and never blocks ingestion.

- [ ] **Step 1: Write the failing tests**

Append this `describe` block to `apps/api/src/routes/__tests__/events.test.ts` (keep the existing helpers `createSession`, `ensureConnector`, `randSuffix`, and the `beforeEach` cleanup — extend the `beforeEach` cleanup to also delete `ruleHit` and `rule` before `session` if they aren't already there; see Step 2 note):

```ts
describe('rules in event ingestion', () => {
  it('persists a NOTIFY hit and returns ruleHits when a rule matches', async () => {
    const session = await createSession('Rules Ingest')
    const rule = await prisma.rule.create({
      data: { workspaceId: session.workspaceId, name: 'protect', action: 'NOTIFY', pathPattern: 'config/prod/**', message: 'off-limits' },
    })

    const res = await app.inject({
      method: 'POST', url: '/api/events',
      payload: {
        sessionId: session.id, agentId: 'claude-1', tool: 'edit_file',
        params: { path: 'config/prod/app.yaml', content: 'x' }, result: { success: true },
        connectorId: 'claude-code', connectorVersion: '1.0.0', mcpEventId: 'm-r1',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)
    expect(body.ruleHits).toHaveLength(1)
    expect(body.ruleHits[0].ruleId).toBe(rule.id)
    expect(body.ruleHits[0].action).toBe('NOTIFY')

    const hit = await prisma.ruleHit.findFirst({ where: { sessionId: session.id } })
    expect(hit).not.toBeNull()
    expect(hit?.ruleName).toBe('protect')
    expect(hit?.matchedOn).toEqual({ tool: null, pathPattern: 'config/prod/**', connectorId: null, agentPattern: null })
    expect(hit?.id).toBe(body.ruleHits[0].id)
  })

  it('omits ruleHits when no rule matches', async () => {
    const session = await createSession('Rules None')
    const res = await app.inject({
      method: 'POST', url: '/api/events',
      payload: {
        sessionId: session.id, agentId: 'claude-1', tool: 'edit_file',
        params: { path: 'src/app.ts', content: 'x' }, result: { success: true },
        connectorId: 'claude-code', connectorVersion: '1.0.0', mcpEventId: 'm-r2',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)
    expect(body.ruleHits).toBeUndefined()
  })

  it('still returns 201 and persists the event when a stored rule has an invalid glob (failure isolation)', async () => {
    const session = await createSession('Rules Faulty')
    await prisma.rule.create({
      data: { workspaceId: session.workspaceId, name: 'bad', action: 'NOTIFY', pathPattern: 'config(prod/**' },
    })
    const res = await app.inject({
      method: 'POST', url: '/api/events',
      payload: {
        sessionId: session.id, agentId: 'claude-1', tool: 'edit_file',
        params: { path: 'config/prod/app.yaml', content: 'x' }, result: { success: true },
        connectorId: 'claude-code', connectorVersion: '1.0.0', mcpEventId: 'm-r3',
      },
    })
    expect(res.statusCode).toBe(201)
    const persisted = await prisma.normalizedEvent.findFirst({ where: { mcpEventId: 'm-r3' } })
    expect(persisted).not.toBeNull()
  })
})
```

- [ ] **Step 2: Extend the beforeEach cleanup (FK-safe order)**

In `apps/api/src/routes/__tests__/events.test.ts`, update `beforeEach` so it deletes `ruleHit` and `rule` before `session` (Rule has an FK to Workspace; RuleHit has none but keep it first). Insert after `conflict.deleteMany()`:

```ts
  await prisma.ruleHit.deleteMany()
  await prisma.rule.deleteMany()
```

- [ ] **Step 3: Run the tests to verify they fail**

```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
npx vitest run src/routes/__tests__/events.test.ts
```
(workdir: `apps/api`)
Expected: the three new tests FAIL — `body.ruleHits` is `undefined` (seam not implemented yet).

- [ ] **Step 4: Implement the seam**

Modify `apps/api/src/routes/events.ts`:

1. Add imports at the top:

```ts
import { randomUUID } from 'node:crypto'
import { evaluate } from '../services/rule-engine.js'
```

2. Add `ruleHits` to the 201 response schema (in the `response` object, extend the existing `201` property):

```ts
        201: {
          type: 'object',
          required: ['id', 'sessionId', 'tool'],
          properties: {
            id: { type: 'string' },
            sessionId: { type: 'string' },
            tool: { type: 'string' },
            ruleHits: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'ruleId', 'ruleName', 'action', 'matchedOn', 'createdAt'],
                properties: {
                  id: { type: 'string' },
                  ruleId: { type: 'string' },
                  ruleName: { type: 'string' },
                  action: { type: 'string', enum: ['LOG', 'NOTIFY'] },
                  message: { type: ['string', 'null'] },
                  path: { type: ['string', 'null'] },
                  tool: { type: 'string' },
                  agentId: { type: 'string' },
                  connectorId: { type: 'string' },
                  sessionId: { type: 'string' },
                  workspaceId: { type: 'string' },
                  matchedOn: { type: 'object', additionalProperties: true },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
```

3. In the handler, replace the `normalizedEvent.create(...)` … `return reply.code(201).send(...)` tail so that between the event insert and reconciliation there is the rule seam, and the response includes `ruleHits` (preserve the existing reconciliation call and its exact arguments):

```ts
    const event = await app.prisma.normalizedEvent.create({
      data: {
        sessionId: body.sessionId,
        agentId: body.agentId,
        tool: body.tool,
        params: body.params as unknown as Prisma.InputJsonValue,
        result: (body.result ?? {}) as unknown as Prisma.InputJsonValue,
        connectorId: body.connectorId,
        connectorVersion: body.connectorVersion,
        mcpEventId: body.mcpEventId,
        timestamp: new Date()
      }
    })

    // --- Rule engine seam (additive; never blocks ingestion or reconciliation) ---
    let ruleHits: Array<Record<string, unknown>> | undefined
    try {
      void ruleHits
      const rules = await app.prisma.rule.findMany({
        where: { workspaceId: session.workspaceId, enabled: true },
      })
      if (rules.length > 0) {
        const results = evaluate({
          sessionId: event.sessionId,
          agentId: event.agentId,
          tool: event.tool,
          params: event.params,
          result: event.result ?? undefined,
          timestamp: event.timestamp.getTime(),
          connectorId: event.connectorId,
          connectorVersion: event.connectorVersion,
          mcpEventId: event.mcpEventId,
        }, rules)
        if (results.length > 0) {
          const firedAt = new Date()
          const hits = results.map((r) => ({
            id: randomUUID(),
            ruleId: r.ruleId,
            workspaceId: session.workspaceId,
            sessionId: event.sessionId,
            agentId: event.agentId,
            connectorId: event.connectorId,
            tool: event.tool,
            path: r.event.path,
            ruleName: r.ruleName,
            action: r.action,
            matchedOn: r.matchedOn,
            message: r.message,
            createdAt: firedAt,
          }))
          await app.prisma.ruleHit.createMany({ data: hits })
          for (const hit of hits) {
            if (hit.action === 'NOTIFY') app.wsManager.broadcastRuleHit(hit.sessionId, hit)
          }
          ruleHits = hits.map((h) => ({ ...h, matchedOn: h.matchedOn, createdAt: h.createdAt.toISOString() }))
        }
      }
    } catch (err) {
      app.log.error({ err, workspaceId: session.workspaceId, sessionId: event.sessionId, tool: event.tool }, 'rule evaluation failed; ingestion unaffected')
    }

    await reconciliation.processSessionEvent({
      sessionId: event.sessionId,
      agentId: event.agentId,
      tool: event.tool,
      params: event.params,
      result: event.result ?? undefined,
      timestamp: event.timestamp.getTime(),
      connectorId: event.connectorId,
      connectorVersion: event.connectorVersion,
      mcpEventId: event.mcpEventId
    })

    return reply.code(201).send({ id: event.id, sessionId: event.sessionId, tool: event.tool, ruleHits })
  })
```

Note: the `runHits`/`void ruleHits` preamble is unnecessary — remove the `void ruleHits;` line; keep `ruleHits` declared and assigned, always sent in the response (`ruleHits` will be `undefined` when no rule matched, which is excluded by the response serializer because it's not `required`).

- [ ] **Step 5: Run the tests to verify they pass**

```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
npx vitest run src/routes/__tests__/events.test.ts
```
(workdir: `apps/api`)
Expected: PASS — all pre-existing tests plus the three new rule-ingestion tests.

- [ ] **Step 6: Lint + build**

```powershell
npm run lint
npm run build
```
(workdir: `apps/api`)
Expected: clean lint, successful build.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/events.ts apps/api/src/routes/__tests__/events.test.ts
git commit -m "feat(rules): evaluate events against rules during ingestion"
```

---

### Task 6: E2E — cross-connector determinism, broadcast, conflict non-interference

**Files:**
- Create: `apps/api/src/__tests__/e2e-rule-engine.test.ts`

**Interfaces:**
- Consumes: full `buildApp()`; `prisma` from `@meetless/database/client`; `evaluate`/determinism concepts from Task 2; the WS broadcast from Task 3; the ingestion seam from Task 5.
- Produces: proof that four connectors produce identical rule evaluation against a connectorless rule, that NOTIFY hits broadcast `rule_triggered`, LOG hits persist without broadcast, disabled rules never fire, and reconciliation still produces a conflict.

- [ ] **Step 1: Write the e2e test**

Create `apps/api/src/__tests__/e2e-rule-engine.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { buildApp } from '../app.js'
import { prisma } from '@meetless/database/client'

let app: Awaited<ReturnType<typeof buildApp>>
let broadcastSpy: ReturnType<typeof vi.fn>

const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function ensureConnector(id: string) {
  await prisma.connector.upsert({ where: { id }, update: {}, create: { id, name: id, version: '1.0.0', capabilities: {} } })
}

beforeAll(async () => {
  app = await buildApp()
  broadcastSpy = vi.fn()
  app.wsManager.broadcastRuleHit = broadcastSpy as never
  await app.listen({ port: 0 })
})

afterAll(async () => {
  await app.close()
})

beforeEach(async () => {
  broadcastSpy.mockClear()
  await prisma.normalizedEvent.deleteMany()
  await prisma.conflict.deleteMany()
  await prisma.ruleHit.deleteMany()
  await prisma.rule.deleteMany()
  await prisma.session.deleteMany()
  await prisma.workspace.deleteMany()
  await prisma.membership.deleteMany()
  await prisma.user.deleteMany()
  await prisma.team.deleteMany()
  await prisma.connector.deleteMany()
})

async function seed(sessionId: string) {
  const team = await prisma.team.create({ data: { name: `T-${randSuffix()}`, slug: `t-${randSuffix()}` } })
  const user = await prisma.user.create({ data: { clerkId: `c-${randSuffix()}`, email: `e-${randSuffix()}@ex.com` } })
  const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'W' } })
  await prisma.session.create({ data: { id: sessionId, workspaceId: workspace.id, userId: user.id, name: 'E2E' } })
  return { workspaceId: workspace.id, sessionId }
}

async function postEvent(sessionId: string, connectorId: string, path: string, agentId: string, mcpEventId: string) {
  return app.inject({
    method: 'POST', url: '/api/events',
    payload: {
      sessionId, agentId, tool: 'edit_file', params: { path, content: `content-${mcpEventId}` }, result: { success: true },
      connectorId, connectorVersion: '1.0.0', mcpEventId,
    },
  })
}

describe('Rule engine E2E', () => {
  it('produces identical rule evaluation for all four connectors and broadcasts NOTIFY once', async () => {
    const { workspaceId, sessionId } = await seed(`e2e-${randSuffix()}`)
    await prisma.rule.create({ data: { workspaceId, name: 'contract', action: 'NOTIFY', pathPattern: 'contracts/**', message: 'authoritative' } })
    await ensureConnector('claude-code')
    await ensureConnector('codex-cli')
    await ensureConnector('cursor-hooks')
    await ensureConnector('opencode')

    const connectors = ['claude-code', 'codex-cli', 'cursor-hooks', 'opencode']
    for (const cid of connectors) {
      const res = await postEvent(sessionId, cid, 'contracts/api.yaml', `${cid}-agent`, `m-${cid}`)
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.payload)
      expect(body.ruleHits).toHaveLength(1)
      expect(body.ruleHits[0].matchedOn).toEqual({ tool: null, pathPattern: 'contracts/**', connectorId: null, agentPattern: null })
    }

    const hits = await prisma.ruleHit.findMany({ where: { sessionId } })
    expect(hits).toHaveLength(4)
    expect(hits.map((h) => h.connectorId).sort()).toEqual(connectors.sort())
    // one NOTIFY broadcast per hit (4 total), each carrying the persisted hit id
    expect(broadcastSpy).toHaveBeenCalledTimes(4)
    const firstPayload = broadcastSpy.mock.calls[0][1] as { id: string; type?: never }
    expect(hits.some((h) => h.id === (firstPayload as { id: string }).id)).toBe(true)
  })

  it('LOG rules persist hits but do not broadcast; disabled rules never fire', async () => {
    const { workspaceId, sessionId } = await seed(`e2e-${randSuffix()}`)
    await prisma.rule.create({ data: { workspaceId, name: 'log-schema', action: 'LOG', pathPattern: 'prisma/schema.prisma' } })
    await prisma.rule.create({ data: { workspaceId, name: 'disabled', action: 'NOTIFY', pathPattern: '**', enabled: false } })
    await ensureConnector('claude-code')

    const res = await postEvent(sessionId, 'claude-code', 'prisma/schema.prisma', 'claude-1', 'm-log')
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)
    expect(body.ruleHits).toHaveLength(1)
    expect(body.ruleHits[0].action).toBe('LOG')
    expect(broadcastSpy).not.toHaveBeenCalled()
    expect(await prisma.ruleHit.count({ where: { sessionId } })).toBe(1)
  })

  it('reconciliation is unaffected: conflicting edits with an active rule still produce a conflict', async () => {
    const { workspaceId, sessionId } = await seed(`e2e-${randSuffix()}`)
    await prisma.rule.create({ data: { workspaceId, name: 'watch', action: 'NOTIFY', pathPattern: 'src/**' } })
    await ensureConnector('claude-code')
    await ensureConnector('cursor-hooks')

    const r1 = await postEvent(sessionId, 'claude-code', 'src/app.ts', 'claude-1', 'm-c1')
    const r2 = await postEvent(sessionId, 'cursor-hooks', 'src/app.ts', 'cursor-1', 'm-c2')
    expect(r1.statusCode).toBe(201)
    expect(r2.statusCode).toBe(201)

    const conflicts = await prisma.conflict.findMany({ where: { sessionId } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].status).toBe('PENDING')
    expect(conflicts[0].agents).toEqual(expect.arrayContaining(['claude-1', 'cursor-1']))
    // every edit event produced a hit too
    expect(await prisma.ruleHit.count({ where: { sessionId } })).toBe(2)
  })
})
```

- [ ] **Step 2: Run it compute** — run the e2e

```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
npx vitest run src/__tests__/e2e-rule-engine.test.ts
```
(workdir: `apps/api`)
Expected: PASS (all three tests).

- [ ] **Step 3: Run the full api test suite (regression)**

```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
npm test
```
(workdir: `apps/api`)
Expected: all api tests pass, including the four pre-existing e2e suites (`e2e-claude-flow`, `e2e-cursor-hooks`, `e2e-multi-connector`, `e2e-opencode`) — proving reconciliation behavior is unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/e2e-rule-engine.test.ts
git commit -m "test(rules): e2e cross-connector determinism and conflict non-interference"
```

---

### Task 7: Demo script + docs

**Files:**
- Create: `apps/api/scripts/demo-rules.ts`
- Modify: `apps/api/package.json` (add `demo:rules` script)
- Modify: `docs/project-overview.md` (Rule Engine section + API table rows)

**Interfaces:**
- Consumes: `buildApp()`, `prisma` from `@prisma/client`, the public rules + events + rule-hits + conflicts routes from Tasks 4/5.
- Produces: a runnable `npm run demo:rules --workspace=@meetless/api` showing two rules firing across two connectors and a conflict result.

- [ ] **Step 1: Create the demo script**

Create `apps/api/scripts/demo-rules.ts`:

```ts
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
```

- [ ] **Step 2: Add the npm script**

In `apps/api/package.json`, add to `"scripts"` (after `demo:opencode`):

```jsonc
"demo:rules": "npx tsx scripts/demo-rules.ts"
```

- [ ] **Step 3: Run the demo (verify end-to-end)**

```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
npm run demo:rules --workspace=@meetless/api
```
Expected: two rule hits printed (NOTIFY "Protect API contract" for claude-code and opencode on `contracts/api.yaml`), and `Conflicts detected: 1` (File `contracts/api.yaml`, Agents include `claude-1` and `opencode-1`, Status `PENDING`).

- [ ] **Step 4: Update docs**

In `docs/project-overview.md`:

1. After the existing "## API Routes" table, append a **Rule Engine** section:

```markdown
## Rule Engine (Phase 3A)

Workspace-scoped, deterministic rules evaluate each normalized agent event during ingestion (rules run for all connectors — claude-code, codex-cli, cursor-hooks, opencode — with no connector-specific code). Actions are `LOG` (persist a hit) and `NOTIFY` (persist a hit + WebSocket `rule_triggered`). All matching rules fire; `priority` orders results only. Rules never block or alter reconciliation.

| Rule | When it matches | Action |
|------|-----------------|--------|
| `pathPattern` glob (`*`, `**`; `\` normalized to `/`) | `event.params.path` | — |
| `tool` | exact `event.tool` | — |
| `connectorId` | exact `event.connectorId` | — |
| `agentPattern` glob | `event.agentId` | — |

A rule's constraints are AND-ed; an unset constraint is a wildcard. Patterns are validated (via picomatch) at create/update time.
```

2. Add these rows to the "## API Routes" table:

```markdown
| POST | `/api/rules` | Create a rule (workspace-scoped) |
| GET | `/api/rules?workspaceId=…` | List rules (priority asc) |
| PATCH | `/api/rules/:id` | Update / enable / disable a rule |
| DELETE | `/api/rules/:id` | Delete a rule (hits persist) |
| GET | `/api/sessions/:sessionId/rule-hits` | Rule hits for a session |
```

- [ ] **Step 5: Lint + commit**

```powershell
npm run lint   # workdir: apps/api
```
Then:

```bash
git add apps/api/scripts/demo-rules.ts apps/api/package.json docs/project-overview.md
git commit -m "feat(rules): add rule-engine demo script and docs"
```

---

### Task 8: Remove dead shared Rule type + final verification + push

**Files:**
- Modify: `packages/shared/src/types/index.ts` (remove dead `Rule` interface, lines 10-14)
- Verify: whole repo build/lint/test; confirm out-of-scope files unchanged.

**Interfaces:**
- Consumes: nothing new. Confirms the repo state before the phase checkpoint.
- Produces: a clean repo without the stale dormant `Rule` interface; a pushed phase checkpoint.

- [ ] **Step 1: Confirm the dead type has no references**

```powershell
git grep -n "interface Rule\b" packages/shared; git grep -n -E ":\s*Rule\b|Rule\[\]|from ['\"].*types.*['\"]" apps packages -- "*.ts" | Select-String -Pattern "Rule\b" | Select-Object -First 20
```
Expected: the only occurrence of the `Rule` interface is its declaration in `packages/shared/src/types/index.ts:10-14`; no imports/usages of this `Rule` type in `apps/` or `packages/` (`RuleHit`/`rule` are unrelated names and must not be matched away).

- [ ] **Step 2: Remove the dead type**

Delete lines 10-14 from `packages/shared/src/types/index.ts` (the `export interface Rule { ... }` block), leaving `AgentAction`, `Conflict`, `Change`, and the re-exports intact.

- [ ] **Step 3: Rebuild shared + run shared tests (the api depends on shared dist)**

```powershell
npm run build --workspace=@meetless/shared
npm test --workspace=@meetless/shared
```
Expected: build succeeds; shared tests pass.

- [ ] **Step 4: Full repo verification (build → lint → test)**

```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
npm run build; if ($?) { npm run lint }
npm run test
```
(workdir: repo root — `turbo` runs build/lint/test across all workspaces)
Expected: build + lint clean; all tests pass (shared, database, opencode-plugin, and api including all new rule-engine tests and the four pre-existing e2e suites).

- [ ] **Step 5: Confirm out-of-scope files are untouched**

```powershell
git status --short
git diff --stat 8b80b95..HEAD -- packages/shared/src/connectors packages/opencode-plugin apps/api/src/services/reconciliation.ts
```
Expected: the second command shows no changes to those paths (only the `reconciliation.ts` path is listed with zero diff). `git status` is clean after commit.

- [ ] **Step 6: Commit + push (phase checkpoint)**

```bash
git add packages/shared/src/types/index.ts
git commit -m "chore(rules): remove dead dormant Rule interface from shared types"
git push origin main
```
Expected: push succeeds (`main -> main`). This is the Phase 3A checkpoint — per repo convention, a pushed commit (no release tags are used; Phase 2C/2D checkpoints were pushed commits on `main`).
