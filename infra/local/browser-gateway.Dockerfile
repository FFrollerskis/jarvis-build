# D-339: browser-gateway sin EGEN image, atskilt fra api.Dockerfile sitt
# delte image (api/worker/migrate) og fra voice-gateway.Dockerfile - Playwright
# krever en Chromium-binær PLUSS et helt sett systemavhengigheter (fonter,
# codec-biblioteker osv.) som IKKE er trivielt å installere manuelt.
#
# Microsoft sitt eget, offisielle Playwright-image
# (`mcr.microsoft.com/playwright`) bygger nøyaktig dette FERDIG - Chromium +
# alle systemavhengigheter forhåndsinstallert for en gitt Playwright-versjon.
# Tag-en `v1.63.0-noble` er VERIFISERT å faktisk eksistere denne økten
# (`curl https://mcr.microsoft.com/v2/playwright/tags/list`, IKKE gjettet) -
# versjonen MÅ matche `apps/browser-gateway/package.json` sin
# `playwright`-avhengighet (`^1.63.0`) nøyaktig, ellers mismatcher den
# installerte npm-pakken sin forventede browser-binær-versjon mot den som
# faktisk ligger i imaget. `-noble` (Ubuntu 24.04) matcher CI sin
# `ubuntu-24.04`-runner - ingen grunn til en annen Ubuntu-linje her.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS runtime

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY modules ./modules
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: imaget har ALLEREDE riktig Chromium-
# versjon forhåndsinstallert (se filhodet over) - en ny nedlasting under
# `pnpm install` ville vært både unødvendig og ville sløst byggetid/-lag.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --prod

EXPOSE 3030
CMD ["node", "--experimental-transform-types", "apps/browser-gateway/src/main.ts"]
