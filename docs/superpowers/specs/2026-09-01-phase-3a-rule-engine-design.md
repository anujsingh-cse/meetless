# Phase 3A — Rule Engine (Design Spec)

Date: 2026-09-01
Status: Approved discovery, pending spec review
Scope gate: single phase (3A). No implementation outside items listed here.

## 1. Purpose

Meetless today is a passive pipeline: agent events → conflict detection → human resolution. Phase 3A inserts a deterministic rule-evaluation step between ingestion and reconciliation so that events can be classified, audited, and alerted-on as they arrive — harness-agnostically.

Target architecture:

```
NormalizedAgentEvent
        ↓
Rule Engine  (evaluate)
        ↓
RuleEvaluationResult[]
        ↓
persist RuleHits / broadcast NOTIFY events
        ↓
Reconciliation (UNCHANGED)
```

The rule engine must be predictable, testable, explainable, fast, harness-agnostic, and easy to extend.

## 2. Approved decisions

1. **Rule scope = `workspaceId`.** A rule applies to every session in a workspace. Not session-scoped, not global.
2. **Actions = `LOG` and `NOTIFY` only.** Prevention, context injection, approval flows, and bidirectional tool control are deferred to 3B+.
3. **All matching rules fire.** `priority` is a deterministic ordering of results only (ascending; ties broken by `createdAt`, then `id`). It does NOT mean first-match-wins.
4. **Placement = `apps/api` (control plane).** No new package. No dry-run endpoint. `RuleHit` uses **scalar IDs only (no Prisma foreign-key relations)**; `ruleId` is retained as a scalar so audit rows remain meaningful after a `Rule` is deleted.

## 3. Non-goals (explicitly out of scope)

- Blocking/veto of tool calls, `tool.execute.before`, pre-flight enforcement
- Context injection into agents; outbound content channels
- Automatic conflict merging or autonomous conflict resolution
- Changes to connectors (`packages/shared/src/connectors/**`) or to the reconciliation algorithm
- Dashboard, authentication/RBAC, billing, tunnel
- Source-of-truth generator; full context/memory system
- Dry-run evaluation endpoint (deferred)
- Retention policy / cleanup of RuleHit rows
- Multi-trigger (OR) rules, condition DSL, rule templates, severity taxonomy

## 4. Data model

Prisma additions to `packages/database/prisma/schema.prisma`. Existing models are untouched. Convention: `db push` (no migrations), `cuid()` ids, `@default(now())`.

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
  tool         String?    // exact-match on event.tool; null = wildcard
  pathPattern  String?    // glob on event.params.path ('**' + '*'); null = wildcard
  connectorId  String?    // exact-match on event.connectorId; null = wildcard (harness-agnostic default)
  agentPattern String?    // glob on event.agentId; null = wildcard
  action       RuleAction
  message      String?    // human "why", snapshotted onto hits
  createdBy    String?    // free-text; no auth enforcement exists
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
  workspace    Workspace  @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  @@index([workspaceId, enabled])
}

model RuleHit {
  id          String   @id @default(cuid())
  ruleId      String   // scalar only — NO relation; survives Rule deletion
  workspaceId String   // scalar (denormalized); no relation
  sessionId   String   // scalar; audit must outlive session cleanup
  agentId     String
  connectorId String
  tool        String
  path        String?
  ruleName    String   // snapshot at fire time
  action      RuleAction // snapshot at fire time (Rule.action may later change)
  matchedOn   Json     // constraint snapshot for "why it matched" (see §6)
  message     String?  // snapshot of Rule.message at fire time
  createdAt   DateTime @default(now())
  @@index([sessionId, createdAt])
  @@index([ruleId])
  @@index([workspaceId, createdAt])
}
```

Rationale:
- `Rule` gets a real FK to `Workspace` (mirrors `Session.workspaceId` pattern); workspace deletion cleans up its rules.
- `RuleHit` is fully scalar: FK-free so audit rows survive deletion of rules, sessions, or test cleanup, and so ingest never joins.
- `matchedOn`, `ruleName`, `action`, `message` snapshots make a hit self-explanatory forever.

## 5. RuleHit ↔ event linkage

No dedicated relation. The correlation field is `sessionId` + `path` + `agentId` in both `NormalizedEvent` and `RuleHit`; ingestion response also returns `ruleHits` inline (§8), which is the primary consumer-facing linkage. A `NormalizedEvent.id` is not stored on the hit (the hit is about the rule's view of the event, not the storage row; keeping it scalar preserves delete-safety).

## 6. Deterministic evaluation contract

Service: `apps/api/src/services/rule-engine.ts` (pure — no Prisma, no I/O).

```ts
// Contract. NormalizedAgentEvent is taken from @meetless/shared/types.
evaluate(event: NormalizedAgentEvent, rules: RuleLike[]): RuleEvaluationResult[]

interface RuleLike {           // satisfied by Prisma Rule rows or plain objects (tests)
  id: string; name: string
  enabled: boolean
  priority: number
  tool: string | null
  pathPattern: string | null
  connectorId: string | null
  agentPattern: string | null
  action: 'LOG' | 'NOTIFY'
  message: string | null
  createdAt: Date | string
}

interface RuleEvaluationResult {
  ruleId: string          // which rule matched
  ruleName: string
  action: 'LOG' | 'NOTIFY'// the action produced
  message: string | null
  matchedOn: {            // WHY it matched: the rule's constraints that were active
    tool: string | null
    pathPattern: string | null
    connectorId: string | null
    agentPattern: string | null
  }
  event: {                // echoed event facts (what was matched against)
    agentId: string
    connectorId: string
    tool: string
    path: string | null
  }
}
```

Matcher semantics (AND over present constraints; null = wildcard):

1. `tool`: exact string equality with `event.tool`.
2. `pathPattern`: glob (`*`, `**`) via **picomatch**, matched against `event.params.path` after backslash→slash normalization (`path.replaceAll('\\','/')`). If the rule has a `pathPattern` and the event has no string `params.path`, no match.
3. `connectorId`: exact equality with `event.connectorId`.
4. `agentPattern`: picomatch glob against `event.agentId`.

Algorithm:

```
matches(rule, event) per §above
hits = rules
  .filter(r => r.enabled)
  .filter(r => matches rule)
  .map(to RuleEvaluationResult)
  .sort(stable by priority asc → createdAt asc → id asc)
return hits
```

Properties guaranteed by contract (each is a test):
- **Pure:** same `(event, rules)` ⇒ byte-identical result sequence.
- **Explainable:** from a result you can read (a) the rule (`ruleId`/`ruleName`), (b) why it matched (`matchedOn` = exactly the rule's non-null constraints — the AND-set that the event satisfied), (c) the action (`action`, `message`).
- **All-matching-fire:** zero, one, or many results; never stopped early.
- **Order-stable:** `priority` ascending; `createdAt`; `id` as final tiebreaker.
- **Harness-agnostic:** no connector-specific branches; identical event bodies from `claude-code`/`codex-cli`/`cursor-hooks`/`opencode` produce identical results for connector-independent rules.

Glob validation: pattern validity is checked at rule create/update time (compile via picomatch inside a try/catch → 400 on invalid), so evaluation cannot throw on a stored bad pattern.

## 7. Integration into ingestion (single seam)

`apps/api/src/routes/events.ts` — POST `/api/events` handler, inserted between `normalizedEvent.create` and `reconciliation.processSessionEvent`:

```
session = findUnique(id: body.sessionId)        // existing (400 on miss)
connector upsert                                // existing
event = normalizedEvent.create(...)             // existing

rules  = prisma.rule.findMany({                 // NEW — 1 indexed query
           where: { workspaceId: session.workspaceId, enabled: true } })
results = evaluate(eventAsNormalized, rules)    // NEW — pure, in-memory
hits   = prisma.ruleHit.createMany(...)         // NEW — 1 insert (skip if empty)
for hit in results.filter(r => r.action === 'NOTIFY'):
  wsManager.broadcastRuleHit(hit.sessionId, payload)   // NEW

reconciliation.processSessionEvent(...)         // UNCHANGED
201 { id, sessionId, tool, ruleHits? }          // response gains optional field
```

Invariants:
- **Reconciliation unchanged** — it reads `NormalizedEvent` rows; rules do not mutate or suppress stored events, so conflict detection is byte-identical.
- **Failure isolation**: the whole rule block runs inside try/catch; on error it logs via the Fastify logger and continues to reconciliation; 201 is still returned (rules never break ingestion).
- **Latency bound**: one indexed `findMany` + one in-memory pass + one `createMany`. No per-rule queries.

WebSocket: add `broadcastRuleHit(sessionId, payload)` to `apps/api/src/services/ws-manager.ts`, emitting single-nested `{ type: 'rule_triggered', payload }` to clients of that session (existing session channel mechanics; unlike `conflict_created`, do NOT double-nest `type`). Payload = the persisted hit fields: `{ id, ruleId, ruleName, sessionId, agentId, connectorId, tool, path, action, message, createdAt }`.

## 8. API surface (minimum useful set)

Routes: `apps/api/src/routes/rules.ts`, registered with `{ prefix: '/api' }` in `app.ts` like the existing routes. Same inline JSON-schema `as const` convention; authenticated behavior identical to current routes (permissive preHandler, unchanged).

| Method & path | Body / params | Success | Errors |
|---|---|---|---|
| POST `/api/rules` | `{ workspaceId, name, description?, enabled?, priority?, tool?, pathPattern?, connectorId?, agentPattern?, action, message?, createdBy? }` | 201 Rule row | 400 invalid glob / bad action / no constraints (see below) / unknown workspaceId |
| GET `/api/rules?workspaceId=…` | query | 200 Rule[] sorted (priority asc, createdAt asc) | — |
| PATCH `/api/rules/:id` | partial: any of the rule fields | 200 updated rule | 404 unknown id; 400 invalid glob / empty-constraint result |
| DELETE `/api/rules/:id` | — | 200 `{ id }` | 404 |
| GET `/api/sessions/:sessionId/rule-hits` | — | 200 RuleHit[] (createdAt desc), cap 200 | — |

Validation rules:
- At least one of `tool | pathPattern | connectorId | agentPattern` must be set (a zero-constraint rule matches everything — a misconfiguration, so reject with 400 + message; refuse silently-ever-firing content too).
- `action` enum `LOG|NOTIFY` (schema enum → automatic 400 via Fastify/Ajv, same pattern as conflicts route).
- `pathPattern`/`agentPattern` compile-checked via picomatch on create/update.
- `workspaceId` existence verified with `workspace.findUnique` → 400 `Invalid workspaceId` (mirrors `Invalid sessionId` wording).

Omitted on purpose (deferred): `GET /api/rules/:id`, separate enable/disable routes (PATCH covers), dry-run endpoint, hit retention/pruning endpoints, rule templates.

## 9. Test strategy

Repo conventions: vitest; colocated `__tests__`; api tests hit real Postgres via `buildApp()`; `fileParallelism: false`; FK-safe cleanup in `beforeEach`. `RuleHit` has no FKs, so cleanup never blocks on it.

**Unit — `apps/api/src/services/__tests__/rule-engine.test.ts`** (pure evaluator; no DB):
1. exact tool match / non-match
2. path glob match: `*`, `**`, literal beat segments; `?` unsupported expectations documented if unused
3. backslash normalization (`src\app.ts` matches `src/*.ts`)
4. no path on event + pathPattern rule → no match
5. connectorId exact match / mismatch
6. agentPattern glob (`frontend-*`) match / mismatch
7. AND-semantics: two constraint fields, one fails → no match
8. disabled rule never evaluated as a hit (evaluate receives only enabled rules AND `evaluate` defensively filters — assert both)
9. zero-constraint input construction impossible at API (unit: document expected behavior if passed — treat as match, but never persisted by API)
10. multiple rules → all matching fire once each; stable order priority asc → createdAt → id
11. determinism: same inputs twice → deep-equal outputs
12. malicious/invalid glob never evaluated (validated at API; unit asserts compile-check helper returns invalid)
13. connector-independence: same event, connectorId swept `claude-code|codex-cli|cursor-hooks|opencode`, connectorless rule → identical results

**Route — `apps/api/src/routes/__tests__/rules.test.ts` (real DB):** create 201 + row shape; 400 missing constraints; 400 invalid glob; 400 bad action; 400 unknown workspaceId; list filtering by workspaceId + ordering; PATCH update + disable; PATCH invalidates to zero constraints → 400; DELETE 200 + gone + 404 after; DELETE unknown → 404; rule-hits endpoint returns hits for session ordered desc.

**Service+route seam — assertion that events.ts calls engine correctly:** covered by e2e.

**E2E — `apps/api/src/__tests__/e2e-rule-engine.test.ts` (real DB + app):**
1. Seed workspace+session; create NOTIFY rule `config/prod/**`; POST `claude-code` event on `config/prod/app.yaml` → 201 with `ruleHits` length 1; DB hit present with correct snapshots; `broadcastRuleHit` invoked once with `{ type:'rule_triggered', payload:{...} }` (assert via decorator-seam spy: replace `app.wsManager.broadcastRuleHit` after buildApp, pre-`listen`).
2. Non-path event: POST `{ tool: 'bash', params: { command: 'ls' } }` (no `params.path`) → rule with `pathPattern` never matches → 0 hits, 201 still returned.
3. LOG-action rule → hit persisted; broadcast NOT called.
4. Connector sweep: identical event posted with each of the 4 connectorIds against a connectorless rule → 4 identical hits (connectorId differs only where recorded).
5. Additive safety: two agents edit same file with an active matching rule → `Conflict` still PENDING exactly as before (rule layer proven non-interfering).
6. Disabled rule never fires over the live route.
7. Regression: all existing e2e suites pass unchanged (`e2e-claude-flow`, `e2e-cursor-hooks`, `e2e-multi-connector`, `e2e-opencode`).

**Demo — `apps/api/scripts/demo-rules.ts` + `demo:rules` script:** create workspace/session, seed 2 rules, ingest one claude-code + one opencode event, print rules fired + conflict result. Mirrors existing demo conventions (Prisma seed, `buildApp` on ephemeral port, cleanup).

## 10. The five canonical product examples (what 3A delivers)

| # | Example | 3A rule | Behavior now |
|---|---|---|---|
| 1 | Never allow agents to modify production config | `pathPattern: "config/prod/**"`, NOTIFY, message | Detection + alert (hit persisted + broadcast). True prevention needs connector-side enforcement → 3B+ |
| 2 | API contract changes are authoritative | `pathPattern: "contracts/**"`, NOTIFY | Flags/announcements; consumers read via `/rule-hits` or WS. Downstream conflict-severity semantics → 3B+ |
| 3 | Schema change → inform other active agents | `pathPattern: "prisma/schema.prisma"`, `tool: "edit_file"`, NOTIFY | WS broadcast to session subscribers. Offline/cross-session delivery → 3B+ |
| 4 | Two agents touch same contract → human review | contract rule + existing reconciliation | Hit + PENDING conflict both visible via API/WS; hard gating → 3B+ |
| 5 | Frontend agents must respect API contract | `agentPattern: "frontend-*"`, `pathPattern: "contracts/**"`, NOTIFY | Fully supported |

## 11. File/component structure

```
packages/database/prisma/schema.prisma           + RuleAction enum, Rule, RuleHit
apps/api/src/services/rule-engine.ts             evaluate/matches/normalizePath/isValidGlob
apps/api/src/services/__tests__/rule-engine.test.ts
apps/api/src/routes/rules.ts                     CRUD + rule-hits
apps/api/src/routes/__tests__/rules.test.ts
apps/api/src/__tests__/e2e-rule-engine.test.ts
apps/api/src/services/ws-manager.ts              + broadcastRuleHit (~5 lines)
apps/api/src/routes/events.ts                    single seam (≈20 lines incl. try/catch), response `ruleHits`
apps/api/src/__tests__/… (no edits)              regression: existing suites must pass
apps/api/package.json                            + picomatch (dependency), + demo:rules script
apps/api/scripts/demo-rules.ts                   new demo
docs/project-overview.md                         + Rule Engine section; API table rows; workspace package table fix (opencode row was already stale)
packages/shared/src/types/index.ts               remove dead dormant `Rule` interface (safe — zero references), avoids dual “Rule” truth
```

No new workspace package. No connector edits. No reconciliation algorithm edits.

## 12. Risks & mitigations

1. **Ingest latency creep** — one extra query + insert per event. Indexed; bounded; measured acceptable for 3A. Persist first and broadcast after; rule path wrapped in try/catch → ingestion never fails due to rules.
2. **Glob sharp edges** (dot segments, windows) — picomatch with `dot: true`; path normalization before match; invalid patterns rejected at write time.
3. **RuleHit unbounded growth** — accepted for 3A; defer retention to 3B. Documented.
4. **Consumers absent (no dashboard yet)** — value surfaces via API + WS + demo; deliberate (API-first).
5. **Response contract churn** — `ruleHits` is additive/optional; existing clients unaffected.
6. **Priority semantics confusion** — contract says ordering only; enforced by tests (§9.10) and documented in field comments.
7. **Shared `Rule` type removal** — zero references, verified by repo-wide grep during discovery; remove to avoid two divergent Rule definitions.

## 13. Deferred to Phase 3B+ (explicit)

- Prevention/veto (`tool.execute.before` for OpenCode; harness analogues), pre-flight decision API
- Rule-aware reconciliation (conflict severity, authoritative-file handling, review gates)
- Context injection / outbound agent channels
- Approval workflows, hold/ack event lifecycle
- Dry-run evaluate endpoint; hit retention/pruning; rule templates/preset library
- Global/team-level rules; auth on rule management
- WS persistence for offline agents

## 14. Success criteria (verifiable)

1. `npm run build`, `npm run lint` clean.
2. `npm run test` green everywhere, including new unit + route + e2e suites above.
3. `npm run demo:rules --workspace=@meetless/api` shows the two seeded rules firing for claude-code and opencode events with identical evaluation, and an unchanged conflict result.
4. Cross-connector determinism proven: identical events from all four connectors → identical RuleEvaluationResults (connectorless rule).
5. `git status` of tasks shows no edits inside `packages/shared/src/connectors/**`, `packages/opencode-plugin/**`, or the reconciliation algorithm body of `apps/api/src/services/reconciliation.ts`.
```

