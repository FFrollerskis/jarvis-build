# Jarvis – prosjektstatus

**Oppdatert:** 2026-08-12 · **Branch:** `claude/fase-2-identity-data`

## Aktiv fase og oppgave

**Fase 2 – Identitet, kontrakter og datafundament: implementert, venter på ekstern
arkitektkontroll og Tobias sin godkjenning.**
Fase 0 fullført (`7e31f4a`); fase 1 godkjent av ekstern arkitekt + Tobias (`9e43531`).

## Fase 2 – implementerte komponenter

- **`modules/core`:** minimal migrasjonskjører (nummererte SQL-filer, transaksjon per fil);
  5 migrasjoner: identitet (tenants/people/person_tenants/organizations/projects/sites/rooms/
  devices/memory_spaces), sesjoner/meldinger/append-only events, tasks/capabilities/persistente
  approvals, append-only audit + cost_events, RLS.
- **RLS per tenant** håndhevet i databasen: FORCE RLS, app-rolle (`jarvis_app`) uten bypass,
  default deny uten tenant-kontekst, WITH CHECK mot skriving til feil tenant; `people` synlig kun
  via medlemskap. Space-RLS kommer med minnetabellene i fase 4.
- **IdentityService** (validerer medlemskap/enhet/space → kontraktvalidert IdentityContext),
  **SessionService** (resumeOrCreate på tvers av kanaler), **EventWriter** (idempotent via
  `(tenant_id, idempotency_key)`), **AuditWriter** (append-only, samme transaksjon som skrivingen),
  **PgApprovalStore** (atomisk engangs-nonce i databasen – kobles til Policy Gateway i fase 3).
- **infra/local:** postgres 16-tjeneste (pgvector-image; pgmq bevisst utelatt per D-13) med
  env-styrte credentials uten defaults.

## Fase 2 – testresultater (2026-08-12)

- **41/41 tester grønne** (28 fase 1-regresjon + 13 nye DB-integrasjonstester mot **ekte embedded
  PostgreSQL 16.14** – ingen mocks); også verifisert under Node 22.14.0.
- `pnpm lint` og `pnpm typecheck` (4/4 pakker) grønne; gitleaks 8.30.1: no leaks, exit 0.
- Akseptanse 1 (tenant-isolasjon på DB-nivå), 2 (idempotens), 3 (kanalkryssende gjenopptak),
  4 (audit med full identitetskontekst): **PASS** med faktiske tester.

## Fase 2 – avvik

- **Docker finnes fortsatt ikke på dev-PC-en:** `docker compose config` fortsatt uverifisert;
  DB-tester bruker embedded PostgreSQL 16.14 i stedet (reell Postgres, samme major som prod-image).
- Policy Gateway bruker fortsatt in-memory nonce-lager: gateway-grensesnittet er synkront (fase 1)
  og røres ikke; PgApprovalStore står klar og kobles inn når gateway går async i fase 3.

## Blokkeringer

1. **CI-resultat kan ikke verifiseres herfra** (`gh` mangler) – kontrolleres på GitHub Actions-siden.
2. **Fase 3 krever eksplisitt godkjenning** etter ekstern arkitektkontroll av fase 2.

## Neste fase

**Fase 3 – Jarvis Core og tekst-MVP** (webchat, modellgateway, rask ruter, kontekstbygger,
observability) – starter først etter godkjenning. Planlagt branch: `claude/fase-3-core-text-mvp`.

---

## Arkiv: fase 1 (godkjent på `9e43531`)

### Hva som ble implementert

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

### Verifikasjonsresultater (fase 1-porten, 2026-08-12)

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

### Avvik (fase 1)

- Lokal Node er v24.11.1 (kravet er 22): `engines: >=22`, CI/Docker pinner 22; Node 22 verifisert separat.
- Vitest kjører kontraktene via kildekode-alias (ingen build-steg) – bevisst enkelt.
