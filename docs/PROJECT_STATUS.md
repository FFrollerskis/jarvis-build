# PROJECT STATUS

**Oppdatert:** 2026-09-17 (branch `tobias/manual-masterplan-ua10-p1-host-fix` fra exact
`main=fadad73e6ea2f2ad4cd7be6e23920797aca43600` = PR #88 sin merge-commit). Aktiv oppgave: **UA-10 P1
runtime-gate closeout etter FØRSTE ekte host-kjøring (D-160 I)** - host run `2105bb7d` ga `hard_fail=true`
(11/18 PASS); rotårsakene er reprodusert, bevist og fikset (to harness-feil, ingen produksjonsbug).
`MERGE_AUTHORIZED=false`, `SELF_APPROVAL=false`, `HOST_ACCEPTANCE_REQUIRED=true` (re-run etter merge).

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Hvor `main` står nå

- **PR #83 (UA-9 Vision, 055)** merget `14a12fd1…`; **PR #86 (UA-10 P1 aktivering, 057)** merget `ecb99eab…`
  (2026-09-17).
- **PR #88 (UA-10 P1 kontrollflate-credential-fiks + host-akseptanse-harness, D-160 G/H)** merget
  `fadad73e…` (2026-09-17, review 5234709923, post-merge CI run 35213783834 grønn, lokal main ff-synket).
- Main har migrasjonene `054 -> 055_vision -> 056_situations -> 057_situations_activation` og komponerer
  UA-9 Vision-wiring + UA-10 Situation Engine-wiring i `apps/api/src/main.ts`.

## UA-10 P1 host-funn run `2105bb7d` - hva som er gjort (denne branchen)

**Reprodusert EKSAKT i container** (run `d9c2d9dc`: samme 11 PASS / 7 FAIL, `telegram_calls=0`,
`evidence=MANGLER`, `stage=act`, `duplicate_prefixes=2`) mot ny PostgreSQL 16.13 + ekte
`migrate-main.ts` + hostens historiske `schema_migrations`-rader sådd + falsk Telegram-credential.

**Rotårsak A - migrasjon (harness, ikke produksjon):** påstanden «ingen prefiks i HELE `schema_migrations`
har count > 1» var for bred. Migratoren nøkler på eksakt filnavn og ignorerer historiske rader. Git-
historikken viser nøyaktig to mulige duplikater: `014_pgvector_embeddings.sql` (Tobias' `6a306f6`
2026-08-13, migrert på Docker-PG, fjernet som «hook artifact» samme dag) og `023_zendesk_support.sql`
(ikke-merget Zendesk-branch 2026-08-18). Fiks: ren `scripts/lib/migration-evidence.ts`
(`evaluateMigrationEvidence()`, 8 enhetstester): 055/056/057 unike/ordnet/anvendt, repo-mappe uten
prefiks-kollisjon; historikk rapporteres eksplisitt, skjules aldri.

**Rotårsak B - varsling (harness, ikke produksjon):** `CountingTransport.invoke(action, parameters)`
droppet `credential` foran `TelegramTransport` => `https://api.telegram.org/botundefined/sendMessage`
=> 404 => `tool.failed` i `audit_events` (ingen `tool_executions`-rad) => `pending` uten grunn =>
`stage=act`, kaskade av 6 FAIL. Slapp gjennom fordi `scripts/` ikke ble typesjekket (TS2554 hadde
fanget det). Fiks: wrapperen videresender ALLE argumenter og teller forsøk ved inngang; `scripts` i
tsconfig-`include`; `ObservingGateway` + `telegramDiagnostics()` (schema, credential-oppløsning som
boolean, gateway-grunn, transport-forsøk/suksess, audit-grunner token-redigert, tool_executions-status).

**Regresjonstester:** `ua10-p1-canonical-telegram-path.test.ts` (3: hele produksjonskjeden med EKTE
`TelegramTransport` og stubbet `fetch` som verifiserer `bot<token>`-URL/chat_id/tekst; INFORM + ACT;
credential-droppende wrapper gir nøyaktig host-symptomet), `migration-evidence.test.ts` (8),
wiring-vakt (25).

**Bevis etter fiks (container):** run `4b5961c3` (opptaker): 17/18 PASS, `hard_fail=false`, migrasjon
PASS med `014`/`023` rapportert som legitime; run `3179e670` (falsk token): `transport_attempts=1`,
`last_reason=tool_failed:telegram_error_403`, ingen token i loggen. Klynge stoppet og fjernet.

**Repo-gates:** `pnpm -w typecheck` exit 0 (inkl. `scripts/`); `pnpm -w lint` exit 0; `git diff --check`
rent; secret-scan rent; målrettede + full suite: se PR-beskrivelsen for tall.

## Blokkeringer

1. **Arkitekt-review + merge av denne fiks-PR-en.** `MERGE_AUTHORIZED=false`.
2. **HARD_EXTERNAL_BLOCKER: host-kjøringen på nytt.** Etter merge kjører Tobias fra repo-roten på main:
   `node --env-file=.env --experimental-transform-types modules/situations/scripts/ua10-p1-situation-sweep-host-run.ts`
   - lim inn HELE output-blokken (markører + `diag[...]`-linjer, ingen secrets). Krav: 18/18 markører,
   `hard_fail=false`, `blocked_external=0`, ekte Telegram-evidens (INFORM + ACT), replay 0, scheduler
   completed_at satt/NULL korrekt, globale pauser identiske, 0 rester.
3. **Embedded-Postgres-flake (B.3, port-kontensjon)** er fortsatt kjent i repo-suiten (uendret).

## Neste oppgave

Arkitekt-review + merge av fiks-PR-en, deretter Tobias sin host-kjøring (RUNTIME_GATES-rad ->
VERIFIED/COMPLETE med host-run_id). **UA-11 Executive Mode P0 startes IKKE før UA-10 P1 runtime-gaten
er lukket.**
