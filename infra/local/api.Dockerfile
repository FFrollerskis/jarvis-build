# Fase 1: minimal container for jarvis-api (health-endepunkt).
# Node 22 LTS pinnes her selv om dev-maskiner kan kjøre nyere (engines: >=22).
FROM node:22-alpine

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages/contracts ./packages/contracts
COPY modules/policy ./modules/policy
RUN pnpm install --frozen-lockfile

EXPOSE 3010
CMD ["node", "--experimental-strip-types", "apps/api/src/main.ts"]
