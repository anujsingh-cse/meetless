# @meetless/api

Fastify REST API for Meetless — agent event ingestion, conflict detection, and resolution.

## Quick Start

```bash
# Start infrastructure
docker compose up -d

# Install + generate
npm ci
npm run db:generate
npm run db:push

# Development
npm run dev                # http://localhost:3000

# Demo (standalone script)
npm run demo               # npx tsx scripts/demo-claude-connector.ts
```

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/events` | Ingest a normalized agent event |
| GET | `/api/sessions/:sessionId/conflicts` | List conflicts for a session |
| POST | `/api/conflicts/:conflictId/resolve` | Resolve a conflict |

### POST /api/events

```json
{
  "sessionId": "cuid...",
  "agentId": "claude-1",
  "tool": "edit_file",
  "params": { "path": "src/foo.ts", "content": "..." },
  "result": { "success": true },
  "connectorId": "claude-code",
  "connectorName": "Claude Code",
  "connectorVersion": "1.0.0",
  "mcpEventId": "mcp-123"
}
```

### POST /api/conflicts/:conflictId/resolve

```json
{
  "resolution": "accept_agent",
  "resolvedBy": "user-1"
}
```

Valid resolutions: `accept_agent`, `merge_manual`, `reject_changes`

## Demo Script

`npm run demo` runs `scripts/demo-claude-connector.ts` which:

1. Starts a real Fastify server on an ephemeral port
2. Creates a Connector and IngestionPipeline
3. Mocks `child_process.spawn` (no real Claude Code needed)
4. Simulates two agents editing the same file
5. Verifies conflict detection via DB + API
