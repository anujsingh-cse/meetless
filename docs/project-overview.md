# Meetless — Project Overview

## What Gets Built

Meetless is a hosted reconciliation layer for AI coding agents (Claude Code, Codex, Cursor, OpenCode) via MCP.

### Phase 1 — Core Infrastructure
- **Fastify API** — REST endpoints for health, agent actions, conflict retrieval
- **WebSocket server** — Real-time broadcast of agent actions and conflict events
- **Prisma + PostgreSQL** — Data persistence for sessions, workspaces, users, teams, conflicts
- **Redis** — Session caching and pub/sub

### Phase 2A — First MCP Connector + Agent Event Pipeline

| Component | Description |
|-----------|-------------|
| **Connector abstraction** | `Connector` interface + `BaseConnector` abstract class + `ConnectorRegistry` for managing multiple agents |
| **Claude Code connector** | Spawns Claude Code in MCP mode, normalizes `tools/call` JSON-RPC events into `NormalizedAgentEvent` |
| **Codex CLI connector** | Spawns Codex CLI in MCP server mode, normalizes `file_patch` and `shell_exec` events from `codex/event` notifications |
| **Ingestion pipeline** | Forwards connector events to the API via HTTP POST for persistence and reconciliation |
| **Reconciliation engine** | Detects file-level conflicts when two agents edit the same file in a session |
| **Conflict resolution API** | `POST /api/conflicts/:id/resolve` with `accept_agent`, `merge_manual`, `reject_changes` |
| **WebSocket broadcast** | Real-time conflict creation/resolution notifications to session subscribers |
| **E2E test** | `apps/api/src/__tests__/e2e-claude-flow.test.ts` — full connector → pipeline → API → verification flow |
| **Demo script** | `apps/api/scripts/demo-claude-connector.ts` — standalone runnable demo |

## Getting Started

```bash
# Prerequisites: Node 20+, Docker
cp .env.example .env
docker compose up -d          # Postgres + Redis
npm ci
npm run db:generate
npm run db:push
npm run dev                   # API at http://localhost:3000

# Run demo (separate terminal)
npm run demo --workspace=@meetless/api

# Run Codex demo (separate terminal)
npm run demo:codex --workspace=@meetless/api

# Run Cursor Hooks demo (separate terminal)
npm run demo:cursor --workspace=@meetless/api
```

## Docker Workflow

All local development runs against Docker services:

```bash
docker compose up -d          # Start Postgres (5432) and Redis (6379)
docker compose down           # Stop services
```

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/events` | Ingest a normalized agent event |
| GET | `/api/sessions/:sessionId/conflicts` | List conflicts for a session |
| POST | `/api/conflicts/:conflictId/resolve` | Resolve a conflict |

## Connector Development

To add a new agent connector:

1. Extend `BaseConnector` from `@meetless/shared/connectors`
2. Implement `connect()`, `disconnect()`, and MCP event normalization
3. Register with `InMemoryConnectorRegistry`
4. Wire into `IngestionPipeline`

See the existing `ClaudeCodeConnector` implementation for reference.

### Available Connectors

| Connector | ID | Tools | Status |
|-----------|----|-------|--------|
| Claude Code | `claude-code` | `edit_file`, `read_file`, `list_files`, `grep`, `todo_write`, `bash` | ✅ |
| Codex CLI | `codex-cli` | `file_patch` → `edit_file`, `shell_exec` → `bash` | ✅ |
| Cursor Hooks | `cursor-hooks` | `edit_file`, `read_file`, `list_files`, `grep`, `bash`, `subagent`, `mcp_tool`, `session_init`, `session_end` | ✅ |

## Workspace Packages

| Package | Purpose |
|---------|---------|
| `@meetless/api` | Fastify API server |
| `@meetless/shared` | Types, config, connectors, shared utilities |
| `@meetless/database` | Prisma schema and client |
