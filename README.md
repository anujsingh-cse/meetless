# Meetless

![Meetless logo](docs/assets/meetless-logo.svg)

Meetless is a coordination and control layer for multiple AI coding agents working in the same codebase.

## Table of Contents

- [What is Meetless?](#what-is-meetless)
- [The Problem](#the-problem)
- [How Meetless Works](#how-meetless-works)
- [Core Concepts](#core-concepts)
- [Supported Connectors](#supported-connectors)
- [Rules](#rules)
- [Prevention](#prevention)
- [Approval (ASK)](#approval-ask)
- [Reconciliation](#reconciliation)
- [Architecture](#architecture)
- [API](#api)
- [WebSocket Events](#websocket-events)
- [Project Structure](#project-structure)
- [Requirements](#requirements)
- [Local Development](#local-development)
- [Environment Variables](#environment-variables)
- [Testing](#testing)
- [Development Workflow](#development-workflow)
- [Current Status](#current-status)
- [Roadmap](#roadmap)
- [Design Documents](#design-documents)
- [Scope and Non-Goals](#scope-and-non-goals)
- [Security and Trust](#security-and-trust)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## What is Meetless?

Meetless is a coordination and control layer for multiple AI coding agents working on the same codebase.

Several agents can work at the same time, but each agent has its own session and its own view of the work. That is the problem Meetless addresses.

Meetless receives agent events, normalizes them, applies workspace rules, detects conflicts, and makes pre-execution decisions. Depending on the rule, an action is allowed, denied, or held for approval.

## The Problem

```
Agent A ──┐
Agent B ──┤
Agent C ──┼──> the same workspace
Agent D ──┘
```

Each agent sees only its own session. Without coordination this leads to conflicting edits, repeated work, unsafe actions, and unclear decisions.

- Two agents edit the same file at once → silently overwriting each other.
- One agent makes a dangerous change → nothing stops it before it runs.
- An agent needs review of a risky action → there is no shared approval step.

Meetless provides the shared layer for events, rules, decisions, conflicts, and approvals.

## How Meetless Works

Meetless has two control paths.

### Observation

An agent emits an event. Meetless normalizes it, applies workspace rules, records the result, and (if two agents touch the same file) detects a conflict.

```
Agent
→ Connector
→ Normalized event
→ POST /api/events
→ Rules
→ RuleHit / reconciliation
```

### Prevention

Before an agent runs a tool, the connector asks Meetless for a decision. The rule engine returns `ALLOW`, `DENY`, or `ASK`.

```
Connector pre-hook
→ normalized decision
→ POST /api/decisions
→ ALLOW / DENY / ASK
```

Both paths share one rule engine and one set of data.

## Core Concepts

### Connector

A connector is the integration between Meetless and a single agent runtime (for example OpenCode or Claude Code). It observes agent events and, for supported connectors, enforces pre-execution decisions.

### Normalized event

A single shape Meetless uses for events from any connector. Every connector turns its native event into the same normalized form.

### Rule

A workspace-scoped rule that matches events (by tool, path pattern, connector, or agent pattern) and defines an action (log, notify) and an optional decision (allow, deny, ask).

### RuleHit

A recorded rule match. When an ingested event matches a rule, Meetless writes a RuleHit. RuleHits survive rule deletion. See the Phase 3A spec.

### RuleDecision

The outcome record written by the decision path (allow/deny) or by an ask lifecycle. Persisted per decision; this is the audit trail for decisions.

### Pending Decision

A rule decision in the `PENDING` state created when an ASK rule matches. It waits for an approval, a denial, or an expiration.

### Reconciliation

The conflict-detection engine. If two agents edit the same file with different contents in a session, Meetless records a conflict.

## Supported Connectors

| Connector | Package | Observation (events) | Prevention (allow/deny) | Approval (ask) |
| --------- | ------- | -------------------- | ----------------------- | -------------- |
| Claude Code | `claude-code` connector | Yes | No | Planned |
| Codex CLI | `codex-cli` connector | Yes | No | Planned |
| Cursor Hooks | `cursor-hooks` connector | Yes | Yes (pre-execution permission hooks) | No |
| OpenCode | `opencode-plugin` package | Yes | Yes (`tool.execute.before`) | Yes (`permission.updated` + permission reply) |

This table is generated from the actual connector implementations in this repository. Approval and prevention support for Claude Code and Codex are planned but not implemented.

## Rules

A rule is defined per workspace. The fields are:

| Field | Purpose |
| ----- | ------- |
| `tool` | match against the event tool name |
| `pathPattern` | glob match on the event's file path |
| `connectorId` | match against the writing connector |
| `agentPattern` | glob match on the agent id |
| `action` | `LOG` or `NOTIFY` (observation) |
| `decision` | `ALLOW`, `DENY`, or `ASK` (prevention/approval, nullable) |

The rule engine is deterministic: rules are evaluated in a fixed order (`priority asc`, then `createdAt asc`, then `id asc`). All matching rules fire; the verdict is decided by precedence.

## Prevention

Prevention runs before the tool executes. The supported verdicts are:

- `ALLOW` — the tool runs.
- `DENY` — the tool is blocked.
- `ASK` — the tool is held for approval.

`DENY` takes precedence over `ASK`; `ASK` takes precedence over `ALLOW`.

## Approval (ASK)

When a rule with `decision: ASK` matches a pending action, Meetless creates a pending decision instead of an immediate verdict.

Lifecycle:

```
PENDING
  ├── approve  → APPROVED
  └── deny     → DENIED
  └── timeout  → EXPIRED
```

- **PENDING** → the action waits for a decision.
- **APPROVED** → the action is allowed.
- **DENIED** → the action is blocked.
- **EXPIRED** → the pending timed out or the delivery failed. EXPIRED is never an implicit deny.

An approval is currently delivered through the OpenCode plugin. The plugin watches `permission.updated` for a permission request, creates a pending decision in Meetless, polls until the decision is terminal, and replies to OpenCode with `once` (approve) or `reject` (deny). An EXPIRED decision produces no reply (fail-open: no implicit refusal).

If delivery of the decision fails (for example the WS broadcast throws), the pending is marked `EXPIRED` with `resolutionMethod: delivery_failure`. Repeated resolution of a terminal decision is a no-op (idempotent). The current default expiry is 60 seconds (`ASK_EXPIRY_MS`).

Write this section carefully:

In the current development mode the resolution boundary is permissive — any caller may resolve a pending decision. The originating agent may therefore technically resolve its own request. That is accepted in Phase 3C. Authenticated actor separation and RBAC are planned future work.

## Reconciliation

If two agents write different content to the same file in a session, Meetless records a conflict (`Conflict` row, `status: PENDING`). Conflict detection runs after every ingested event. The reconciliation algorithm is unchanged by the rule and decision paths.

## Architecture

```
Coding Agents
     │
     ▼
Connectors
     │
     ▼
Normalization
     │
  ┌──┴─────────────┐
  ▼                ▼
Events           Decisions
  │                │
  ▼                ▼
Rules ───────── ALLOW / DENY / ASK
  │                │
  ▼                ▼
RuleHits         Pending lifecycle
  │
  ▼
Reconciliation (conflicts)
```

The same shared rule evaluator runs both paths. Approval is asynchronous (permission event → notify → reply); decision enforcement is synchronous (pre-execution).

## API

All routes are under `/api`.

### `GET /api/health`

Health check. Returns `{ status: "ok" }` and dependency readiness.

### `POST /api/events`

Ingest one normalized agent event.

Required body fields: `sessionId`, `agentId`, `tool`, `params`, `connectorId`, `connectorVersion`, `mcpEventId`. Optional: `result`.

Behavior: the event is stored, workspace rules are evaluated, and `RuleHit` rows are written for matches. On a matching `NOTIFY` rule a `rule_triggered` event is broadcast on the session.

### `POST /api/decisions`

Ask for a pre-execution decision.

Required body fields: `sessionId`, `agentId`, `connectorId`, `tool`, `params`. Optional: `pendingKey` (connector-native identifier for dedup of a pending ASK).

Response for a matching `ALLOW`/`DENY` rule: `{ decision: "allow" | "deny", ruleId?, ruleName?, matchedOn?, reason? }`.

Response for a matching `ASK` rule: `{ decision: "ask", pendingId, ruleId, ruleName, reason?, expiresAt }`.

Invalid sessionId returns `400 { error: "Invalid sessionId" }`. Server faults return a safe fallback `{ decision: "allow" }` (fail-open).

### `POST /api/decisions/:pendingId/approve`

Approve a pending decision. Response: `{ pendingId, status: "APPROVED", resolvedAt, resolvedBy? }`. Resolving an already-terminal decision is a deterministic no-op.

### `POST /api/decisions/:pendingId/deny`

Deny a pending decision. Response: `{ pendingId, status: "DENIED", resolvedAt, resolvedBy? }`. Idempotent on repeat.

### `GET /api/sessions/:sessionId/rule-decisions`

List decisions for a session (pending + historical), newest first, capped at 200. Overdue pendings are lazily expired (`EXPIRED`, never implicit deny). Legacy rows from earlier phases remain readable.

### `GET /api/sessions/:sessionId/conflicts`

List conflicts for a session.

### `POST /api/conflicts/:conflictId/resolve`

Set a conflict resolution. Body: `{ resolution: "accept_agent" | "merge_manual" | "reject_changes", resolvedBy }`.

### `POST /api/rules` · `GET /api/rules` · `PATCH /api/rules/:id` · `DELETE /api/rules/:id`

Rule CRUD for a workspace. Rules are validated for at least one constraint and valid glob patterns.

### `GET /api/sessions/:sessionId/rule-hits`

List rule hits for a session.

### Events socket

`GET /api/ws?sessionId=…` upgrades to a WebSocket session consumer.

## WebSocket Events

Real-time messages are sent on a session-scoped WebSocket (`/api/ws?sessionId=…`).

| Type | Meaning |
| ---- | ------- |
| `agent_action` | a normalized agent action happened (agent-action emission) |
| `conflict_created` | a file conflict was detected |
| `conflict_resolved` | a conflict was resolved |
| `rule_triggered` | a rule matched an ingested event |
| `decision_pending` | an ASK pending decision was created |
| `decision_resolved` | a pending decision reached a terminal state |

`decision_pending`/`decision_resolved` are added for the approval lifecycle; see [docs/superpowers/specs/2026-09-19-phase-3c-approval-design.md](docs/superpowers/specs/2026-09-19-phase-3c-approval-design.md).

## Project Structure

```text
apps/
  api/                Fastify API server
packages/
  database/           Prisma schema + client
  shared/             types, config, connectors, shared helpers
  opencode-plugin/    the OpenCode plugin (observe + decision + approval)
docs/
  superpowers/specs/  design specifications per phase
  superpowers/plans/  implementation plans per phase
```

## Requirements

- Node.js >= 20
- npm (the repo is an npm workspace — do not use `pnpm`)
- Docker + PostgreSQL 16 (via `docker compose up -d postgres redis`)
- Redis (via docker compose)
- Access to the connectors you use (OpenCode CLI, Cursor, Claude Code, Codex CLI)

## Local Development

```bash
git clone <repo>
cd meetless
npm ci
# create config file, see Environment Variables
docker compose up -d postgres redis
npm run db:generate   # generate the Prisma client
npm run db:push       # sync the database schema (db-push mode, no migrations)
npm run dev           # start the API in watch mode
```

The API runs at `http://localhost:3000` by default. Health check: `GET /api/health`.

## Environment Variables

| Variable | Purpose | Required |
| -------- | ------- | -------- |
| `DATABASE_URL` | Postgres connection string | yes |
| `REDIS_URL` | Redis connection string | yes |
| `PORT` | API listen port (default 3000) | no |
| `HOST` | API listen host (default 0.0.0.0) | no |
| `NODE_ENV` | `development` / `test` / `production` (default `development`) | no |
| `LOG_LEVEL` | `fatal`/`error`/`warn`/`info`/`debug`/`trace` (default `info`) | no |
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key (optional; unset → permissive dev auth) | no |
| `CLERK_SECRET_KEY` | Clerk secret key (optional; unset → permissive dev auth) | no |

## Testing

```bash
npm run test          # run all workspace tests (turbo)
npm run lint          # lint all workspaces
npm run build         # build all workspaces
```

Demo scripts:

```bash
npm run demo           --workspace=@meetless/api   # claude-code connector demo
npm run demo:codex     --workspace=@meetless/api   # codex connector demo
npm run demo:cursor    --workspace=@meetless/api   # cursor hooks demo
npm run demo:opencode  --workspace=@meetless/api   # opencode connector demo
npm run demo:rules     --workspace=@meetless/api   # rule engine demo
npm run demo:decisions --workspace=@meetless/api   # prevention decisions demo
```

## Development Workflow

Research → Design → Plan → Implement → Test → Review → Commit. Phases are versioned in `docs/superpowers/specs/` and `docs/superpowers/plans/`. Each phase is a self-contained, tested increment.

## Current Status

### Implemented

- Phase 1: core infrastructure (API, database, Redis, dependencies).
- Phase 2A: Claude Code connector, ingestion pipeline, conflict detection.
- Phase 2B: Codex CLI connector.
- Phase 2C: Cursor Hooks connector.
- Phase 2D: OpenCode native plugin (observe-only).
- Phase 3A: Rule Engine (workspace rules, LOG/NOTIFY, RuleHit, rule CRUD, `rule_triggered` WS).
- Phase 3B: prevention (`POST /api/decisions`, ALLOW/DENY, RuleDecision, fail-open, adapter timeout).

### In progress

There is no active implementation in progress in the working tree (the working tree is clean apart from the Phase 3C docs).

### Planned

Approval (ASK) for Claude Code, Codex, and Cursor; context injection; multi-step approval; escalation; and rule-aware reconciliation are planned future work and not implemented.

## Roadmap

- More connector adapters for prevention and approval (Claude Code, Codex).
- Context injection for agents (deferred until safety/coherency is managed).
- Governance and authenticated rule management (deferred).

These items are planned; nothing on this list is currently complete.

## Design Documents

Specifications and implementation plans for the phases:

- [Phase 3A — Rule Engine design spec](docs/superpowers/specs/2026-09-01-phase-3a-rule-engine-design.md)
- [Phase 3A — Implementation plan](docs/superpowers/plans/2026-09-02-phase-3a-rule-engine.md)
- [Phase 2D — OpenCode plugin/connector docs](docs/project-overview.md)
- [Phase 3C — Approval/ASK design spec](docs/superpowers/specs/2026-09-19-phase-3c-approval-design.md)
- [Phase 3C — Implementation plan](docs/superpowers/plans/2026-09-19-phase-3c-approval.md)

## Scope and Non-Goals

Meetless is not a general workflow engine, an RBAC platform, an orchestration engine, or a memory/context platform. It does not implement automatic merging or arbitrary agent orchestration. It focuses on the coordination layer between coding agents.

## Security and Trust

- **Authentication is permissive in development.** If `CLERK_SECRET_KEY` is not set, a permissive development identity is used. This is a known limitation; production RBAC is planned work.
- **RuleDecision is a durable audit record.** Decision history is immutable after terminal state.
- **ASK is not an absolute security boundary.** An `EXPIRED` ask is never an implicit deny, and the origin agent may resolve it under the permissive development boundary.
- **Fail-open.** If the decision path fails or times out, the agent is allowed to proceed rather than being silently blocked. This is a deliberate reliability choice.
- **Adapter timeout.** Enforcement adapters have a 3-second timeout independent of the agent's own timeout, so a stalled API never blocks an agent indefinitely.

## Troubleshooting

- **PostgreSQL/Redis not running**: run `docker compose up -d postgres redis`, or `npm run dev` fails on connection errors.
- **Prisma client missing**: run `npm run db:generate` before `npm run dev`.
- **Schema not synced**: db-push mode — run `npm run db:push` after schema changes.
- **Wrong package manager**: this repo is npm workspaces; do not use `pnpm`.
- **Port 3000 already in use**: set `PORT` to another value or stop the other process.
- **Docker daemon down**: start Docker Desktop, then `docker compose up -d postgres redis`.

## Contributing

The repo uses the phase-based process. Design → spec → plan → implement → review → commit. See the [design documents](#design-documents) for prior phase specs and plans.

## License

License: Not specified yet.

## Final Summary

Meetless gives multiple AI coding agents a shared layer for events, rules, decisions, conflicts, and approvals.
