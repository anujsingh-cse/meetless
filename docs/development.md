# Development Guide

## Local Development
```bash
docker compose up -d   # postgres + redis
npm run dev            # watch mode
```

If Docker is unavailable, tests that need PostgreSQL/Redis will fail or report degraded health checks — that is expected.

## Database
```bash
npm run db:generate    # regenerate Prisma client after schema changes
npm run db:push        # push schema without migration history
npm run db:migrate     # create a named migration
npm run db:seed        # seed data
npm run db:studio      # browse data
```

## Testing
```bash
npm run test              # unit tests (all workspaces)
npm run test:integration  # API integration suite
```

## Adding a New Workspace
1. Create folder under `apps/` or `packages/`
2. Add `package.json` named `@meetless/<name>`
3. Reference it from dependents with `"@meetless/<name>": "*"`
4. Run `npm ci` from root
