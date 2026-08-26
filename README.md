# Meetless — Active Source of Truth for Coding Agents

Hosted reconciliation layer for AI coding agents (Claude Code, Codex, Cursor, OpenCode, Grok) via MCP.

## Quick Start

Prerequisites: Node 20+, Docker, npm

```bash
cp .env.example .env          # edit if needed
docker compose up -d          # start postgres + redis
npm ci                        # install deps
npm run db:generate           # generate Prisma client
npm run db:push               # sync schema to database
npm run dev                   # start API (http://localhost:3000)
```

Health check: GET http://localhost:3000/api/health

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start all workspaces in watch mode |
| `npm run build` | Build all workspaces |
| `npm run test` | Run all tests |
| `npm run lint` | Lint all workspaces |
| `npm run db:studio` | Open Prisma Studio |

See [docs/architecture.md](docs/architecture.md), [docs/development.md](docs/development.md), and [docs/project-overview.md](docs/project-overview.md).

## Phase 2A: Claude Code Connector

Demo a full MCP connector → ingestion → conflict detection flow:

```bash
docker compose up -d          # Postgres + Redis
npm ci
npm run db:generate
npm run db:push
npm run demo --workspace=@meetless/api
```

The demo script (`apps/api/scripts/demo-claude-connector.ts`) starts a server, simulates two agents editing the same file, and verifies conflict detection via the API.

See [apps/api/README.md](apps/api/README.md) for full API docs.
