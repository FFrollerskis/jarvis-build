# Jarvis – prosjektstatus

**Oppdatert:** 2026-08-12 · **Branch:** `claude/fase-1-security-foundation`

## Aktiv fase og oppgave

**Fase 1 – Kjørbart sikkerhets- og prosjektfundament: implementert, venter på ekstern
arkitektkontroll og Tobias sin godkjenning.** Fase 0 fullført på `7e31f4a`.

## Hva som faktisk ble implementert

- **pnpm-monorepo** (TypeScript, Node ≥22): `apps/api`, `packages/contracts`, `modules/policy`,
  `infra/local`. Ingen fremtidsmapper (D-15); ingen LLM/minne/tale/integrasjoner (fase-scope holdt).
- **`@jarvis/contracts`:** IdentityContext (person/tenant/space/sesjon/enhet/kanal/auth_strength/
  delegation), CapabilityClass A–D, SignedApproval (action/parameters/expiry/nonce/enhet/signatur),
  JobContract, EventEnvelope – Zod-runtime-validering + kanonisk JSON som signaturgrunnlag.
- **`@jarvis/policy`:** deterministisk `PolicyGateway.authorize()`; klasse A/B/C-skjelettregler;
  klasse D krever gyldig Ed25519-signert godkjenning (eksakt action- og parametermatch, utløp,
  enhetsregister); engangs-nonce med in-memory lager (replay-vern); kill switch som gir DENY for
  alle klasser; audit-logging av alle beslutninger.
- **`apps/api`:** minimalt kjørbart API (node:http, uten rammeverk) med `/health`.
- **`infra/local`:** portabel docker-compose + Dockerfile (Node 22-pinned, ingen hardkodede stier, D-20).
- **Sikkerhetsdokumenter** i `docs/security/`: THREAT_MODEL (12 trusler mot 5 tillitszoner),
  DPIA_DRAFT (inkl. fremtidig tale), TENANT_MODEL, PROCESSOR_REGION_MATRIX (LLM/STT/TTS/realtime,
  alle TBD/benchmark required), RUNBOOK_TEMPLATE, SECRETS_STRATEGY (D-16).
- **CI** (`.github/workflows/ci.yml`): install → lint → typecheck → test + gitleaks på hele historikken.

## Verifikasjonsresultater (fase 1-porten, 2026-08-12)

- Ren installasjon: `pnpm install --frozen-lockfile` fra slettet node_modules – PASS
- `pnpm test`: **28/28 grønne** · `pnpm typecheck`: 3/3 pakker · `pnpm lint`: grønt
- **Gitleaks 8.30.1 (offisiell binær), full historikk (16 commits): no leaks found, exit 0**
- **Node 22-verifikasjon (v22.14.0 via pnpm use-node-version):** typecheck 3/3, tester 28/28, API
  kjørt reelt med HTTP 200 på `/health`
- **API faktisk kjørt** (Node 24 og 22): `GET /health` → 200 med korrekt JSON-body
- Akseptansetester 1–10: PASS (test 6 beviser første-ALLOW/andre-DENY på nonce)
- Funnet og rettet under verifikasjon: `main.ts` importerte `./server.js` – feiler under Nodes
  type-stripping ved reell kjøring (unit-testene fanget det ikke pga. vitest-resolusjon). Rettet til
  `./server.ts` + `allowImportingTsExtensions`.

## Avvik

- Lokal Node er v24.11.1 (kravet er 22): `engines: >=22`, CI/Docker pinner 22; Node 22 verifisert separat.
- **Docker er ikke installert på dev-PC-en:** `docker compose config` og image-bygg er IKKE verifisert
  lokalt (kun YAML-syntaks sjekket). Verifiseres når Docker/NAS-miljø etableres (fase 2).
- Vitest kjører kontraktene via kildekode-alias (ingen build-steg i fase 1) – bevisst enkelt.

## Blokkeringer

1. **CI-resultat kan ikke verifiseres herfra** (`gh` mangler) – kontrolleres på GitHub Actions-siden.
2. **Fase 2 krever eksplisitt godkjenning** etter ekstern arkitektkontroll.

## Neste foreslåtte oppgave

Ekstern arkitektkontroll av fase 1 → Tobias godkjenner → **Fase 2 – Identitet, kontrakter og
datafundament** (Postgres + RLS) på `claude/fase-2-identity-data` per
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
