# Phase 3B — Prevention & Synchronous Decision

Date: 2026-09-18
Status: Draft pending review

## 1. Purpose

Meetless today is a post-execution observation pipeline: agent events are ingested,
evaluated against workspace rules, and notified on, while a reconciliation engine detects
file-level conflicts. Phase 3B adds the first control surface: **synchronous prevention /
veto**. Before a tool executes in a connected harness, Meetless returns an allow/deny
verdict derived from the existing workspace rules. The goal is controlled agent
coordination without an enterprise workflow engine.

The architecture separates two distinct paths:

- `POST /api/events` — **post-execution observation/ingestion** (Phase 3A, unchanged).
- `POST /api/decisions` — **pre-execution synchronous authorization decision** (Phase 3B).

A denied pre-execution call must NEVER enter the normal post-execution event/reconciliation
path. Blocked tools are prevented before they run; they never become `NormalizedEvent` rows.

## 2. Approved Decisions

Locked from the approved discovery (`.superpowers/sdd/phase-3b/discovery.md`):

1. Phase 3B is synchronous prevention/veto only.
2. Verdicts are `allow` or `deny` only. No `ask`, no rewrite.
3. OpenCode + Cursor are the initial enforcement surface.
4. Claude Code + Codex are follow-on adapters, NOT Phase 3B implementation scope.
5. Pre-execution calls are normalized before rule evaluation (normalize-before-decide).
6. A narrow `RuleEvaluableEvent` abstraction is shared by both pre- and post-execution
   evaluation. Do NOT duplicate matcher/evaluator logic.
7. LOG/NOTIFY rules do not deny pre-execution requests.
8. Decision evaluation does NOT create `RuleHit` rows.
9. Decision evaluation does NOT broadcast RuleHit WebSocket events.
10. Do NOT extend `RuleAction` with `BLOCK`.
11. Add an explicit optional prevention decision/verdict field to `Rule`.
12. Use a separate scalar `RuleDecision` audit model.
13. Fail-open when Meetless is unavailable or the decision path fails.
14. Enforcement adapters must enforce their own short timeout, targeting ~2–5 seconds.
15. The adapter timeout is independent of the harness timeout.
16. Pre- and post-execution paths must derive the same `agentId`.
17. No argument/tool rewriting.
18. No native "ask" routing.
19. No context injection.
20. No rule-aware reconciliation/severity.
21. No offline outbox.
22. No RBAC/auth enforcement expansion.
23. No decision caching.
24. No command-content matching.
25. Existing constraints remain: `tool | pathPattern | connectorId | agentPattern`.

## 3. Non-Goals

Explicitly out of scope for Phase 3B:

- Hosted approval/hold/ack lifecycle and native `ask` routing.
- Context injection into agents (system prompts, agent messages).
- Argument/tool rewriting (no mutation of args, commands, paths, or inputs).
- Rule-aware reconciliation, conflict severity, authoritative-file semantics.
- Offline WS outbox / replay infrastructure.
- RBAC / auth enforcement expansion beyond the existing permissive dev stub.
- Global/team rule scope.
- Decision caching and dry-run decision endpoint.
- Command-content matching or any new constraint types beyond
  `tool | pathPattern | connectorId | agentPattern`.
- Claude Code and Codex enforcement adapters (follow-on, not 3B).
- Any modification to `packages/opencode-plugin` runtime deps, the reconciliation
  algorithm, or Phase 3A event/response contracts.

## 4. Current-State Baseline

Baseline: commit `855e49b`, tag `phase-3a-complete`.

Phase 3A post-execution pipeline (UNCHANGED by 3B):

```
connector observes tool AFTER it ran
  → NormalizedAgentEvent (POST /api/events)
  → RuleEngine.evaluate(event, rules)          // pure, in-memory
  → RuleHit createMany (audit rows)
  → NOTIFY hits broadcast via WS `rule_triggered`
  → ReconciliationEngine.processSessionEvent
  → 201 { id, sessionId, tool, ruleHits? }
```

Key facts relied on by 3B:

- `apps/api/src/services/rule-engine.ts` — pure evaluator. `evaluate(event, rules)` returns
  `RuleEvaluationResult[]`; constraints `tool | pathPattern | connectorId | agentPattern`
  (AND, null=wildcard); deterministic ordering `priority asc → createdAt asc → id asc`;
  all matching rules fire; `isValidGlob` rejects malformed patterns.
- `apps/api/src/routes/events.ts` — single ingestion seam between `normalizedEvent.create`
  and `reconciliation.processSessionEvent`. Rule seam runs in try/catch, never blocks
  ingestion/reconciliation, always returns 201.
- `apps/api/src/routes/rules.ts` — CRUD + `GET /api/sessions/:sessionId/rule-hits`.
  Validation: ≥1 constraint (400 otherwise), valid globs, existing workspaceId, action enum.
- `packages/database/prisma/schema.prisma` — `Rule` (workspace-scoped, FK to Workspace,
  `RuleAction` enum LOG|NOTIFY) and `RuleHit` (fully scalar, survives Rule deletion).
- `apps/api/src/services/ws-manager.ts` — `broadcastRuleHit(sessionId, payload)` →
  single-nested `{ type: 'rule_triggered', payload }`.
- `apps/api/src/services/reconciliation.ts` — conflict detection only (file-level,
  multi-agent same file). Reads `NormalizedEvent` rows. No rule awareness.
- `apps/api/src/plugins/auth.ts` — permissive dev stub: `verify()` returns dev-user when
  `CLERK_SECRET_KEY` unset; preHandler populates `req.user` if Bearer present but never
  rejects. No RBAC.
- Connectors (`packages/shared/src/connectors/**`) are observe-only:
  - `BaseConnector` — `onEvent/emitEvent` (one-way observation), `sendMCPEvent` throws.
  - `claude-code.ts` — spawns `claude --mcp`, parses `tools/call` from stdout.
  - `codex-cli.ts` — spawns `codex mcp-server`, parses `codex/event` notifications.
  - `cursor-hooks/` — writes `.cursor/hooks.json` entries calling `bridge-client.mjs`;
    bridge POSTs hook payload to local BridgeServer, returns `{ ok: true }`. Observe-only;
    NO verdict channel today (bridge-client never prints a Cursor JSON verdict).
  - `opencode-plugin/` — in-process Bun plugin; subscribes `tool.execute.after` and
    `event` (`file.edited`); normalizes edit/write/patch → `edit_file`. Observe-only.

## 5. Pre-Execution Decision Architecture

A separate synchronous decision path is added alongside the unchanged post-execution
ingestion path:

```
PENDING tool call in harness
  │  (pre-hook)
  ▼
[connector adapter]  e.g. opencode-plugin tool.execute.before / cursor bridge verdict
  │  normalize raw tool/args → RuleEvaluableEvent
  │  POST /api/decisions  { sessionId, agentId, connectorId, tool, params }
  ▼
[Meetless API] decision route
  ├─ resolve session → workspaceId (400 if invalid sessionId)
  ├─ fetch enabled workspace rules (1 indexed query)
  ├─ select prevention-participating rules only (Rule.decision != null)
  ├─ evaluate(RuleEvaluableEvent, rules)       // shared matcher
  ├─ combine verdicts (any deny → deny; all matching fire for audit)
  ├─ persist RuleDecision audit rows (scalar, no FK)
  └─ return { decision: allow|deny, reason?, matchedOn?, ruleId?, ruleName? }
  ▼
[connector adapter] allow → continue execution unchanged;
                    deny → block and surface reason to agent/user
```

- The decision path is served by the SAME rule evaluator/matcher as ingestion. No second
  evaluator, no duplicated matching logic.
- The decision route does NOT create `NormalizedEvent` rows, does NOT create `RuleHit`
  rows, and does NOT broadcast WebSocket events.
- A denied pre-execution call never enters the post-execution event/reconciliation path.

## 6. RuleEvaluableEvent Contract

The evaluator and matcher operate on a narrow conceptual type, NOT on the full
`NormalizedAgentEvent`:

```
RuleEvaluableEvent {
  agentId: string
  connectorId: string
  tool: string
  params: {
    path?: string
  }
}
```

- Pre-execution requests do not have the full `NormalizedAgentEvent` fields (`result`,
  `timestamp`, `connectorVersion`, `mcpEventId`).
- `NormalizedAgentEvent` remains a VALID SUPERSET of `RuleEvaluableEvent`. The
  post-execution path passes a full `NormalizedAgentEvent` into the same evaluator
  unchanged.
- The existing evaluator/matcher is refactored to this narrow contract (type-level
  change; matching logic unchanged). There is exactly one matcher.

## 7. Normalize-Before-Decide Contract

Raw harness pre-hook input is normalized by the connector adapter BEFORE the decision
request:

```
raw harness pre-hook
  → connector-adapter normalization
  → RuleEvaluableEvent
  → shared rule evaluation
  → allow/deny decision
```

- Rules ALWAYS operate on normalized tool semantics. Raw connector-specific tool names
  are NEVER evaluated directly.
- Example: OpenCode `edit`/`write`/`patch` must map to the same normalized
  representation (`edit_file` with `params.path`) used by OpenCode's existing ingestion
  path.
- This preserves harness-agnosticism: rules written for Phase 3A keep working unchanged
  on the decision path.
- Normalization must produce a `RuleEvaluableEvent` carrying `agentId`, `connectorId`,
  `tool` (normalized), and `params` (with `path` when the tool is path-based).

## 8. Decision Semantics

- **Prevention-participating rules only**: only rules configured with a decision/verdict
  field (prevention participation) are considered by the decision path. LOG and NOTIFY
  rules never cause denial.
- **All matching prevention rules are evaluated.** No early termination.
- **Deny precedence**: if any applicable prevention rule produces DENY, the overall
  decision is DENY. Otherwise the overall decision is ALLOW.
- **Deterministic ordering**: matched rules are ordered by `priority asc → createdAt asc →
  id asc` (existing evaluator contract). Audit data preserves the full set of matching
  prevention rules in that order.
- **Reason/message selection**: the decision response carries the winning deny's reason
  and rule attribution (ruleId, ruleName, matchedOn). When multiple denies match, the
  highest-priority (first in deterministic order) deny's reason is returned.
- **No-match behavior**: when no prevention rule matches, the decision is ALLOW with no
  rule attribution and no audit row (nothing matched).
- **Side-effect isolation**: decision evaluation creates NO `RuleHit` rows and broadcasts
  NO WebSocket events. Audit is recorded exclusively in `RuleDecision`.

## 9. Rule Model Changes

`RuleAction` is NOT extended. `RuleAction` remains `LOG | NOTIFY` exactly as in Phase 3A.

`Rule` gains an explicit OPTIONAL prevention decision/verdict field that marks the rule as
participating in prevention decisions:

```
Rule {
  id           String   @id @default(cuid())
  workspaceId  String
  name         String
  description  String?
  enabled      Boolean  @default(true)
  priority     Int      @default(100)
  tool         String?              // existing constraint
  pathPattern  String?              // existing constraint
  connectorId  String?              // existing constraint
  agentPattern String?              // existing constraint
  action       RuleAction           // UNCHANGED: LOG | NOTIFY (observation only)
  message      String?
  createdBy    String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  workspace    Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  @@index([workspaceId, enabled])
}
```

The optional decision field (exact name decided in the formal plan, e.g. `decision` or
`verdict`) has enum `ALLOW | DENY` and is `null` by default. A rule with `decision = null`
is observation-only (Phase 3A behavior). A rule with `decision = 'DENY'` participates in
prevention. `ALLOW` is explicit and participates by confirming allow; its presence still
marks the rule as prevention-participating.

Rules API validation updates:

- POST /api/rules and PATCH /api/rules/:id accept the optional decision/verdict field.
- If provided, the value must be `ALLOW` or `DENY` (schema enum → automatic 400 via
  Fastify/Ajv, same pattern as `action`).
- The existing ≥1-constraint validation is UNCHANGED: a prevention rule still requires at
  least one of `tool | pathPattern | connectorId | agentPattern`.
- Glob validation is unchanged (`pathPattern`/`agentPattern` via `isValidGlob`).

The public serialized Rule shape gains the optional decision field (ISO/JSON-safe), and
`GET /api/rules?workspaceId=…` returns it. Existing rule rows are unaffected (nullable
field defaults to null).

## 10. RuleDecision Audit Model

A separate scalar `RuleDecision` model records decision outcomes. It is fully scalar
(no Prisma `@relation` lines), workspace/session safe, and survives deletion of the Rule,
session, or test cleanup — exactly like `RuleHit`.

```
model RuleDecision {
  id          String       @id @default(cuid())
  ruleId      String                    // scalar only — NO relation; survives Rule deletion
  workspaceId String                    // scalar (denormalized); no relation
  sessionId   String                    // scalar; audit outlives session cleanup
  agentId     String
  connectorId String
  tool        String
  path        String?
  ruleName    String                    // snapshot at decision time
  verdict     RuleVerdict               // ALLOW | DENY (snapshot of Rule.decision)
  matchedOn   Json                      // constraint snapshot ("why it matched")
  message     String?                   // snapshot of Rule.message at decision time
  createdAt   DateTime @default(now())
  @@index([sessionId, createdAt])
  @@index([ruleId])
  @@index([workspaceId, createdAt])
}
```

Plus:

```
enum RuleVerdict {
  ALLOW
  DENY
}
```

- `matchedOn` preserves the fixed nullable shape `{ tool, pathPattern, connectorId,
  agentPattern }` — all four keys present, `null` when unconstrained.
- One `RuleDecision` row is persisted per matching prevention rule (all matching rules are
  audited, in deterministic order), NOT one row per decision request. An ALLOW decision
  with no matching rule persists nothing.
- No FK relationships. No `NormalizedEvent.id` stored. Audit growth is unbounded by
  design; retention is deferred to 3C+ (accepted, documented).
- `RuleDecision` does NOT appear in `GET /api/sessions/:sessionId/rule-hits`. Decision
  replay is out of scope for 3B; `RuleDecision` rows are the durable record.

## 11. POST /api/decisions API Contract

Endpoint: `POST /api/decisions` (registered under `/api` in `app.ts`, JSON-schema
`as const` style matching existing routes).

**Request schema:**

```
{
  sessionId: string
  agentId: string
  connectorId: string
  tool: string          // NORMALIZED tool name (e.g. edit_file, bash) — see §7
  params: { path?: string }   // additionalProperties: true for non-path tools
}
```

- `params` is required (object), matching the ingestion body convention.
- `sessionId`, `agentId`, `connectorId`, `tool` are required strings.

**Response schemas:**

- `200` ALLOW (no matching prevention rule, or only ALLOW matches):
  ```
  { decision: 'allow' }
  ```
  With matching prevention rule(s), ALLOW includes rule attribution:
  ```
  { decision: 'allow', ruleId?, ruleName?, matchedOn?, reason? }
  ```
- `200` DENY:
  ```
  { decision: 'deny', ruleId, ruleName, matchedOn, reason }
  ```
  `reason` is the winning deny's message (Rule.message snapshot); if null, a default
  denial message is returned (exact wording is a plan detail, e.g. "Blocked by rule
  <ruleName>").
- `400`: invalid/missing sessionId (`Invalid sessionId`), schema validation failures.
- `500`: unexpected decision-path failure (see §12 — the endpoint should not normally
  reach this; server-side errors are logged and return `allow` when catchable).

**Validation:**

- `sessionId` must resolve to an existing Session → else 400 `Invalid sessionId`
  (mirrors the events route wording).
- Workspace is derived from the Session (rules are workspace-scoped).

**Behavior:**

- Fetch enabled workspace rules (1 indexed query: `where: { workspaceId, enabled: true }`).
- Select only prevention-participating rules (`Rule.decision != null`).
- Evaluate via the shared matcher on `RuleEvaluableEvent`.
- Combine: any DENY → overall DENY; else ALLOW. All matching prevention rules are
  evaluated; none are skipped.
- Persist one `RuleDecision` per matching prevention rule (ALLOW or DENY).
- Return the verdict per the schemas above.
- No `RuleHit` rows, no WebSocket broadcast, no `NormalizedEvent` creation.

**Timeout expectations:** the endpoint must be fast (one indexed `findMany` + one in-memory
eval + one `createMany`). The harness-side latency budget is enforced by the adapters
(§12), NOT by the server. Server response-time target: tens of milliseconds.

## 12. Failure Semantics and Timeout Behavior

- **Fail-open default (architectural invariant):** hook/adapter network error or timeout ⇒
  ALLOW. A slow or unreachable Meetless never blocks agent work.
- **Adapter self-enforced timeout (architectural invariant):** every enforcement adapter
  enforces its own short timeout, INDEPENDENT of the harness default (Claude/Codex default
  to 600s; Cursor to a platform default). Recommended bounded budget ≈ **2–5 seconds**;
  when the budget is exceeded the adapter fails open (ALLOW). The exact value is pinned in
  the plan (target: 3s).
- **Server-side failure isolation:** if the decision route errors (rule fetch failure,
  eval failure, persistence failure), it logs with diagnostic context (workspaceId,
  sessionId, tool) and returns a safe verdict: `200 { decision: 'allow' }`. It never
  crashes the harness hook. This mirrors the Phase 3A ingestion seam's try/catch contract.
- **Determinism:** same pending call + same rules ⇒ same verdict sequence (priority asc →
  createdAt asc → id asc). Evaluation remains pure.
- **Denied calls never enter ingestion.** The adapter that receives DENY blocks the tool;
  no `NormalizedEvent`, no reconciliation input.
- **Cursor specific:** Cursor permission hooks block on invalid JSON even without
  `failClosed`. The Cursor adapter must therefore emit strictly-valid verdict JSON or the
  hook blocks unexpectedly (see §14).

## 13. OpenCode Enforcement Adapter

Surface: OpenCode plugin (`packages/opencode-plugin/**`) — initial enforcement surface.

- Add a `tool.execute.before` hook alongside the existing `tool.execute.after` / `event`
  hooks.
- `tool.execute.before` receives `{ tool, sessionID, callID, args }` (raw OpenCode tool
  names and arguments).
- **Normalize** the raw tool/args into a `RuleEvaluableEvent` using the SAME normalization
  semantics as the ingestion path (§7): `edit`/`write`/`patch` → `edit_file` with
  `params.path`; other tools preserved with their normalized name.
- **agentId**: derived identically to the ingestion path (§15).
- **Call the decision endpoint** `POST /api/decisions` with a bounded timeout (~2–5s,
  enforced via `AbortController`; fail-open on timeout or fetch error).
- **DENY**: throw an Error carrying the deny reason — this aborts the tool call before
  execution and surfaces the reason to the agent/user.
- **ALLOW**: return normally; execution proceeds UNCHANGED (no argument mutation).
- The plugin must remain self-contained (no runtime npm deps; Bun runtime). Only `fetch`
  + `AbortController` are added.
- If a pending tool has no path and is not an edit tool, the adapter may short-circuit to
  ALLOW without a network round-trip ONLY if no prevention rule could match (e.g. tool
  cannot match any enabled prevention rule). Otherwise it must ask Meetless. Exact
  short-circuit conditions are a plan detail; the safe default is to ask.

## 14. Cursor Enforcement Adapter

Surface: Cursor hooks bridge (`packages/shared/src/connectors/cursor-hooks/**`) — initial
enforcement surface.

Current state: `bridge-client.mjs` reads hook JSON from stdin, POSTs it to the local
BridgeServer with `x-meetless-secret`, and exits 0 on 200. It NEVER prints a verdict. The
BridgeServer always responds `{ ok: true }`. This is observe-only.

Changes (preserving observe-only behavior for non-decision hooks):

- Pre-execution permission hooks (`preToolUse`, `beforeShellExecution`,
  `beforeMCPExecution`, `beforeReadFile`) become decision-capable.
- For these hooks, `bridge-client.mjs` must:
  1. Read the hook JSON from stdin (unchanged).
  2. POST the pending call to the Meetless decision endpoint (bounded timeout ~2–5s;
     fail-open → ALLOW on timeout/error).
  3. Print a Cursor verdict JSON to stdout and exit 0:
     ```
     { continue: true, permission: 'allow' }        // ALLOW
     { continue: true, permission: 'deny', user_message, agent_message }   // DENY
     ```
     `user_message` (shown to user) and `agent_message` (fed to agent) carry the deny
     reason from the decision response. Exit code 2 is the alternative block mechanism but
     the JSON verdict is preferred so the reason is delivered.
  4. On DENY, the tool is blocked by Cursor; execution does not proceed.
- For all NON-permission hooks (`afterShellExecution`, `afterFileEdit`, session lifecycle,
  etc.), behavior is UNCHANGED: observe-only, forward to BridgeServer, no verdict output.
- The BridgeServer decision path must return the decision payload to `bridge-client.mjs`
  (the local bridge acts as the connector-side client; it calls Meetless directly or
  forwards through the bridge — exact wiring is a plan detail; the invariant is that the
  decision verdict reaches `bridge-client.mjs` so it can print Cursor-compatible JSON).
- Strictly-valid JSON output is mandatory: Cursor permission hooks block on invalid JSON
  even without `failClosed`.
- The existing secret header (`x-meetless-secret`) contract is preserved for local bridge
  auth.

## 15. AgentId Consistency

Architectural invariant:

- The pre-execution adapter MUST derive and send the SAME `agentId` that the corresponding
  post-execution ingestion path uses for the same session.
- OpenCode: `MEETLESS_AGENT_ID` when set, else `opencode-<first 8 chars of sessionId>` —
  identical to the ingestion normalizer.
- Cursor: the agentId used by the bridge for ingestion must be reused for decisions.
- This guarantees `agentPattern` rules behave identically before and after execution.
- A single shared helper resolves agentId per connector/session so the two paths cannot
  drift.

## 16. Authentication / Authorization Boundary

- The permissive dev auth stub is UNCHANGED. `verify()` returns dev-user when
  `CLERK_SECRET_KEY` unset; the preHandler populates `req.user` if a Bearer token is
  present but never rejects.
- `POST /api/decisions` follows the same pattern as existing routes (permissive
  preHandler, unchanged). No new RBAC or auth enforcement is introduced in 3B.
- Rule management stays workspace-scoped; `createdBy` remains free text. Optionally
  capture `req.user?.userId` into `createdBy` when a Bearer token is present — matching the
  existing rules route behavior.
- The decision endpoint must still validate `sessionId` (400 on unknown session) — that is
  an input-validation boundary, not an auth boundary.

## 17. Reconciliation Boundary

- The reconciliation algorithm (`apps/api/src/services/reconciliation.ts`) is UNCHANGED.
  Phase 3B does not touch it.
- Reconciliation reads `NormalizedEvent` rows. Denied pre-execution calls never become
  `NormalizedEvent` rows, so they never influence conflict detection.
- Rules never mutate or suppress stored events. Allowed tools flow through the existing
  post-execution path exactly as in Phase 3A.
- No rule-aware severity, no authoritative-file semantics, no conflict-state influence in
  3B (deferred to 3C+).

## 18. Test Strategy

Testing must prove, in order:

1. **Evaluator reuse** — the shared matcher is exercised by BOTH the post-execution path
   (`evaluate(NormalizedAgentEvent, rules)`) and the decision path
   (`evaluate(RuleEvaluableEvent, rules)`); unit test asserts one matcher implementation
   serves both (no forked logic).
2. **Normalization equivalence** — OpenCode raw `edit`/`write`/`patch` maps to the same
   normalized `RuleEvaluableEvent`/`NormalizedAgentEvent` (tool `edit_file`, `params.path`)
   used by ingestion; assert identical rule-match outcomes pre vs post.
3. **Allow/deny semantics** — decision route returns ALLOW when no prevention rule matches
   and DENY when a DENY prevention rule matches; LOG/NOTIFY rules never deny.
4. **Deny precedence** — multiple matching prevention rules (ALLOW + DENY) → overall DENY;
   all matching rules persisted to `RuleDecision` in deterministic order.
5. **Fail-open behavior** — decision endpoint internal error returns `200 { decision:
   'allow' }`; adapter fetch error/timeout → allow.
6. **Adapter timeout** — adapter aborts a hung decision after ~2–5s and fails open;
   assert the timeout is adapter-enforced, independent of harness default.
7. **OpenCode blocking** — `tool.execute.before` DENY throws (blocks execution); ALLOW
   returns without mutating args; denied tool never emits an ingestion event.
8. **Cursor blocking** — `bridge-client.mjs` prints valid Cursor verdict JSON
   (`{ continue, permission, user_message?, agent_message? }`) for permission hooks;
   non-permission hooks stay observe-only (no verdict output).
9. **AgentId consistency** — pre-execution adapter sends the same agentId as ingestion for
   the same session; `agentPattern` rule behaves identically pre/post.
10. **Decision audit** — `RuleDecision` rows persist with correct ruleId, ruleName,
    matchedOn, verdict, reason; rows survive Rule deletion; NO `RuleHit` rows are created
    by the decision path; NO WS broadcast occurs.
11. **Phase 3A unchanged** — full api regression: events route, rules route, rule-engine
    unit tests, ws-manager tests all pass.
12. **Reconciliation unchanged** — reconciliation unit/E2E suites pass; denied calls never
    produce conflicts.
13. **All existing connector regression suites remain green** — e2e-claude-flow,
    e2e-cursor-hooks, e2e-multi-connector, e2e-opencode, plus opencode-plugin tests.

Test layout (repo conventions: vitest, colocated `__tests__/`, `fileParallelism: false`,
real Prisma, FK-safe cleanup, `randSuffix()`):

- `apps/api/src/services/__tests__/rule-engine.test.ts` — extended: evaluator operates on
  `RuleEvaluableEvent`; post-execution passes a full `NormalizedAgentEvent` (superset).
- `apps/api/src/services/__tests__/decision-service.test.ts` (pure unit) — deny precedence,
  all-matching-fire, deterministic order, prevention-participating selection.
- `apps/api/src/routes/__tests__/decisions.test.ts` (real DB) — route contract: allow
  no-match, deny match, 400 invalid sessionId, audit rows persisted, no RuleHits, no WS.
- `apps/api/src/__tests__/e2e-prevention.test.ts` — end-to-end decision flow with real app
  + DB: seed workspace/session/rules, simulate adapter pending calls, assert verdict +
  audit + reconciliation non-interference.
- `packages/opencode-plugin/src/__tests__/plugin.test.ts` — extended: `tool.execute.before`
  deny throws / allow returns / fetch-error fail-open / args preserved.
- `packages/shared/src/connectors/cursor-hooks/__tests__/bridge.test.ts` — extended:
  verdict JSON printed for permission hooks; observe-only for others.

## 19. Demo / Validation Strategy

- Add a `demo:decisions` script to `apps/api` (`apps/api/scripts/demo-decisions.ts` +
  `"demo:decisions": "npx tsx scripts/demo-decisions.ts"`), mirroring `demo:rules`
  conventions (Prisma seed, `buildApp` on ephemeral port, cleanup).
- The demo seeds a workspace/session, creates a DENY prevention rule (e.g. `pathPattern:
  'config/prod/**'`), issues a pending decision request for a matching path, and prints the
  verdict, reason, and `RuleDecision` audit row — proving the synchronous prevention path
  end-to-end.
- Optionally prints an ALLOW case (non-matching path) and an allow-with-matching-ALLOW-rule
  case.
- Validation commands (documented in the plan):
  - `npm run test --workspace=@meetless/api`
  - `npm run test --workspace=@meetless/opencode`
  - `npm run test --workspace=@meetless/shared`
  - `npm run lint` / `npm run build` (turbo, all workspaces)
  - `npm run demo:decisions --workspace=@meetless/api`

## 20. File / Component Structure

Phase 3B changes (implementation scope — NO Claude Code or Codex tasks here):

```
packages/database/prisma/schema.prisma
  + enum RuleVerdict { ALLOW DENY }
  + Rule.decision (optional, RuleVerdict?, default null)
  + model RuleDecision (scalar, no relations)
apps/api/src/services/rule-engine.ts
  refactor: evaluate/matches operate on RuleEvaluableEvent (narrow contract);
  NormalizedAgentEvent remains a valid superset; export RuleEvaluableEvent type
apps/api/src/services/decision-service.ts        (new)
  prevention-participating selection + verdict combining + reason selection
apps/api/src/services/__tests__/decision-service.test.ts
apps/api/src/routes/decisions.ts                 (new)
  POST /decisions; registered in app.ts under /api
apps/api/src/routes/__tests__/decisions.test.ts
apps/api/src/__tests__/e2e-prevention.test.ts    (new)
apps/api/src/routes/rules.ts
  accept optional decision field on create/update; include in serialized Rule shape
apps/api/src/routes/__tests__/rules.test.ts       (extend)
apps/api/scripts/demo-decisions.ts                (new)
apps/api/package.json                             (add demo:decisions)
packages/opencode-plugin/src/plugin.ts            (extend)
  add tool.execute.before hook → normalize → POST /api/decisions → throw on DENY
packages/opencode-plugin/src/decision.ts          (new, optional — or inline in plugin.ts)
packages/opencode-plugin/src/__tests__/plugin.test.ts (extend)
packages/shared/src/connectors/cursor-hooks/bridge-client.mjs (extend)
  permission hooks print verdict JSON; others unchanged
packages/shared/src/connectors/cursor-hooks/bridge.ts (extend)
  decision-capable /hook response for permission hooks
packages/shared/src/connectors/cursor-hooks/__tests__/bridge.test.ts (extend)
docs/project-overview.md                          (Prevention section + API table rows)
docs/superpowers/specs/2026-09-18-phase-3b-prevention-design.md  (this spec)
```

Protected (DO NOT MODIFY): `apps/api/src/services/reconciliation.ts`,
`packages/shared/src/connectors/claude-code.ts`, `packages/shared/src/connectors/codex-cli.ts`,
the Phase 3A event/response contracts, and `packages/opencode-plugin` runtime dependencies.

## 21. Risks and Mitigations

1. **Latency on the synchronous path** — one indexed `findMany` + in-memory eval +
   one `createMany` per request; target tens of ms. Adapters enforce their own timeout and
   fail open, so a slow Meetless degrades enforcement (not agent work). Mitigation:
   fail-open default; caching deferred (3C+).
2. **Cursor invalid-JSON blocking** — Cursor permission hooks block on invalid JSON even
   without `failClosed`. Mitigation: strict, schema-valid verdict output; unit tests assert
   exact JSON shape.
3. **OpenCode plugin self-containment** — must stay dependency-free (Bun runtime).
   Mitigation: only `fetch` + `AbortController`; no new runtime deps.
4. **Deny loops / agent retry** — a denied tool call may be retried; reasons must be
   actionable. Mitigation: deny reason surfaced via `agent_message`/error; no loop control
   in 3B (defer 3C+).
5. **Rule/event shape mismatch** — raw pre-execution tool names must normalize to the same
   representation as ingestion. Mitigation: normalize-before-decide invariant (§7) + test 2
   (normalization equivalence).
6. **agentId drift** — pre/post paths could derive different agentIds. Mitigation:
   shared agentId helper per connector (§15) + test 9.
7. **Audit growth** — `RuleDecision` grows unbounded. Mitigation: accepted for 3B;
   retention deferred to 3C+.
8. **Fail-open weakens enforcement** — Meetless downtime silently allows. Mitigation:
   documented and accepted; per-rule/per-endpoint fail-closed override deferred to 3C+.
9. **Scope creep** — temptation to add ask/rewrite/severity. Mitigation: §3 Non-Goals and
   §22 Deferred are explicit; no connector work for Claude Code/Codex in 3B.

## 22. Deferred Phase 3C+ Work

- Claude Code enforcement adapter (PreToolUse hook installer/script).
- Codex enforcement adapter (PreToolUse hook installer/script; note: hosted tools bypass
  hooks — accepted limitation).
- Hosted approval/hold/ack lifecycle and native `ask` routing (OpenCode `permission.ask`,
  Claude `ask`, Cursor `ask`; Codex does not support `ask`).
- Argument/tool rewriting via harness `updatedInput`/`updated_input`/args mutation.
- Context injection into agents (system prompts, agent messages, additional context).
- Rule-aware reconciliation: conflict severity, authoritative-file semantics, review gates.
- Offline WS outbox / replay infrastructure for disconnected consumers.
- RBAC / auth enforcement on rule management and decision endpoints.
- Global/team-level rules.
- Decision caching and dry-run decision endpoint.
- Command-content matching (e.g. blocking specific bash commands) and any new constraint
  types beyond `tool | pathPattern | connectorId | agentPattern`.
- `RuleDecision` retention/pruning and decision replay endpoints.

## 23. Success Criteria

Concrete and executable:

1. `npm run build` and `npm run lint` are clean across all workspaces (turbo).
2. `npm run test` is green across all workspaces (shared, database, opencode-plugin, api),
   including:
   - all existing Phase 3A api suites (events, rules, rule-engine, ws-manager),
   - all four pre-existing e2e connector suites (e2e-claude-flow, e2e-cursor-hooks,
     e2e-multi-connector, e2e-opencode),
   - the new decision-service, decisions route, e2e-prevention, and connector adapter
     tests.
3. Test 2 (normalization equivalence) passes: identical rule-match outcomes pre vs post
   execution for the same normalized event.
4. Test 4 (deny precedence) passes: overall DENY with all matching prevention rules
   persisted to `RuleDecision` in deterministic order.
5. Test 5 (fail-open) passes: decision endpoint internal error → `200 { decision: 'allow' }`;
   adapter fetch error/timeout → allow.
6. Test 6 (adapter timeout) passes: a hung decision is aborted at the adapter after ~2–5s
   and fails open.
7. Tests 7–8 (OpenCode blocking, Cursor blocking) pass: DENY prevents execution; ALLOW
   proceeds unchanged; non-permission Cursor hooks remain observe-only.
8. Test 9 (agentId consistency) passes: pre/post derive identical agentIds.
9. Test 10 (decision audit) passes: `RuleDecision` rows correct, no `RuleHit` rows created
   by decisions, no WS broadcast from the decision path.
10. `npm run demo:decisions --workspace=@meetless/api` prints an ALLOW case and a DENY case
    with reason, plus the persisted `RuleDecision` audit row.
11. A denied pre-execution call produces no `NormalizedEvent` and no `Conflict` (verified
    by e2e-prevention).
12. Reconciliation behavior is byte-identical to Phase 3A: no rule influences conflict
    state; reconciliation source is untouched.

## 24. Revision / Open Questions

Status: Draft pending review. Locked decisions are per §2 Approved Decisions.

Open (resolved at plan time, not architecture):

- Exact field name for the optional prevention field on `Rule` (e.g. `decision` vs
  `verdict`) and exact enum member names (e.g. `ALLOW`/`DENY`).
- Exact `RuleDecision` column shapes/casts (e.g. `matchedOn` JSON handling, `createdAt`
  pre-generation for exact broadcast-less audit).
- Exact adapter timeout value within the ~2–5s range (target: 3s).
- Exact default denial reason wording.
- OpenCode adapter short-circuit conditions for non-path/non-edit tools.
- Cursor bridge decision-path wiring (BridgeServer forwards to Meetless vs bridge-client
  calls Meetless directly) — invariant is that the verdict reaches `bridge-client.mjs`.
- Whether `GET /api/sessions/:sessionId/rule-hits` should eventually include decisions
  (recommended: no in 3B).
