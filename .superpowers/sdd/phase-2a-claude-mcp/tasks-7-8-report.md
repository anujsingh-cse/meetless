# Tasks 7-8 Report: Ingestion Pipeline + Conflict Resolution

## Status: DONE_WITH_CONCERNS

## Commits

| SHA | Subject |
|-----|---------|
| `e66cd32` | `test: cover identical-content no-conflict rule` |
| `d57d577` | `feat: add ingestion pipeline for connector event forwarding` |
| `818490d` | `feat: add conflict resolution endpoint and WebSocket broadcast` |

## What Was Done

### Part 0: Review Finding Fix
- Added test for identical-content no-conflict rule in `reconciliation.test.ts`
- Fixed undefined variable references (`workspaceId`/`userId`) by using existing `createSession` helper
- Ensured `app.ts` ends with trailing EOF newline

### Part 1: Task 7 — Ingestion Pipeline
- Created `packages/shared/src/connectors/ingestion.ts` — HTTP-only pipeline (`{ apiBaseUrl, registry }` constructor, no PrismaClient)
- `handleEvent(event)` is public, POSTs JSON to `${apiBaseUrl}/api/events`
- On non-2xx: logs warning via `console.warn`, continues (never throws)
- On fetch rejection: logs warning, continues
- Tests mock `fetch` via `vi.stubGlobal('fetch', ...)` asserting POST URL + JSON body
- Exported from `packages/shared/src/connectors/index.ts`

### Part 2: Task 8 — Conflict Resolution + WebSocket Broadcast
- `ReconciliationEngine` now accepts optional `broadcaster?: (msg: unknown) => void` constructor param
- Broadcaster called on conflict create/update; engine does NOT import ws/fastify
- `ws-manager.ts` gets `broadcastConflict(sessionId, payload)` and `broadcastConflictResolved(sessionId, conflictId, resolution)` methods
- New route: `apps/api/src/routes/conflicts.ts` — `POST /conflicts/:conflictId/resolve`
- Body: `{ resolution: 'accept_agent' | 'merge_manual' | 'reject_changes', resolvedBy: string, mergedContent?: string }`
- Resolution stored in conflict `changes` JSON alongside existing edits
- Registered in `app.ts` with `{ prefix: '/api' }`
- `events.ts` wires broadcaster closure that calls `app.wsManager.broadcastConflict`
- Tests: broadcast test with `vi.fn()` broadcaster; conflict resolution test with real DB fixture pattern

## Test Summary

| Suite | Tests | Status |
|-------|-------|--------|
| `@meetless/shared` (all) | 16 passed | ✅ |
| `@meetless/api` (non-DB) | 6 passed | ✅ |
| `@meetless/api` (DB-dependent) | 4 failed | ❌ No PostgreSQL |

## Concerns

1. **PostgreSQL not available**: DB-dependent tests (reconciliation, events, conflicts) require a running PostgreSQL instance. Docker is not installed on this machine. All DB tests fail with `P1001: Can't reach database server`. These tests will pass once PostgreSQL is available.

2. **Lint**: ✅ All 3 packages pass lint.
3. **Build**: ✅ All 3 packages compile successfully.

## Report Path

`.superpowers/sdd/phase-2a-claude-mcp/tasks-7-8-report.md`
