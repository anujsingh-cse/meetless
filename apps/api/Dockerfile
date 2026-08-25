FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN npm install -g turbo
COPY package.json package-lock.json turbo.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/database/package.json ./packages/database/
COPY apps/api/package.json ./apps/api/
RUN npm ci
COPY . .
RUN npm run db:generate --workspace=@meetless/database
RUN npm run build --filter=@meetless/api
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace=@meetless/api"]
