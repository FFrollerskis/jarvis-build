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

## Testresultater (lokalt, 2026-08-12)

- `pnpm test`: **28/28 grønne** (3 testfiler: contracts 9, policy 17, api 2)
- `pnpm typecheck`: grønt (3/3 pakker) · `pnpm lint`: grønt
- Akseptansetester 1–9: PASS (detaljer i testfilene; test 6 beviser første-ALLOW/andre-DENY på nonce)
- Test 10 (gitleaks): **ikke kjørt lokalt** – gitleaks er ikke installert på PC-en; kjøres av CI på
  GitHub. Manuell mønsterskanning av diff utført uten funn. Risiko: lav (ingen reelle secrets finnes).

## Avvik

- Lokal Node er v24.11.1 (kravet er 22): `engines: >=22`, CI og Docker pinner Node 22. Lav risiko.
- Vitest kjører kontraktene via kildekode-alias (ingen build-steg i fase 1) – bevisst enkelt.

## Blokkeringer

1. **CI-resultat kan ikke verifiseres herfra** (`gh` mangler) – kontrolleres på GitHub Actions-siden
   etter push.
2. **Fase 2 krever eksplisitt godkjenning** etter ekstern arkitektkontroll.

## Neste foreslåtte oppgave

Ekstern arkitektkontroll av fase 1 → Tobias godkjenner → **Fase 2 – Identitet, kontrakter og
datafundament** (Postgres + RLS) på `claude/fase-2-identity-data` per
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
