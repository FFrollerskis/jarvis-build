# Jarvis runtime-image (BO-07): hele workspacet, ingen build-steg (D-25:
# node --experimental-transform-types kjører .ts direkte). Node 22 LTS pinnes
# selv om dev-maskiner kan kjøre nyere (engines: >=22).
# Samme image brukes av api, worker og one-shot migrate (ulik command i compose).
FROM node:22-alpine

WORKDIR /app
RUN corepack enable && apk add --no-cache git
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY modules ./modules
# --prod: kun runtime-avhengigheter (test-/dev-verktøy holdes ute av imaget).
RUN pnpm install --frozen-lockfile --prod

EXPOSE 3010
CMD ["node", "--experimental-transform-types", "apps/api/src/main.ts"]
