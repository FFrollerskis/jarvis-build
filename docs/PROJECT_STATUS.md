# PROJECT STATUS

**Oppdatert:** 2026-09-17 (branch `tobias/manual-masterplan-ua10-activation-p1`, PR **#86**, rekonsiliert mot
`main=14a12fd170ace732ee7bcfc8e879a61540db1982` = PR #83 sin merge-commit). Aktiv oppgave: **UA-10 P1
Aktivering (D-160)** - rekonsiliering av PR #86 mot dagens main etter at PR #83/UA-9 er merget, slik at
UA-10 P1 kan vurderes og merges trygt oppå en main som nå inneholder BÅDE UA-9 Vision og UA-10 P0.
`MERGE_AUTHORIZED=false`, `SELF_APPROVAL=false`, `HOST_ACCEPTANCE_REQUIRED=false`.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Hvor `main` står nå

- **PR #84 (D-157/D-158/D-159)** MERGET 2026-09-16 som `a0d9a7b27e1a6aaac8c70527e8a8e3357b3c9bad`.
- **PR #85 (UA-10 P0 Proactive Situation Engine, `056_situations.sql`)** MERGET 2026-09-16 som
  `639730c5c14ba6175e91b09606abc4d9dd24fb8a`.
- **PR #83 (UA-9 Vision, D-153, `055_vision.sql`)** MERGET 2026-09-17 som normal two-parent merge
  `14a12fd170ace732ee7bcfc8e879a61540db1982` (parents `639730c5…`, `c7bc3a4e…`; arkitekt-review
  5229954341 `MERGE_AUTHORIZED=true` etter D165 proveniens-rekonsiliering, ACK 5706901949 / REPORT
  5706914372; post-merge CI run 35169923716 grønn; lokal main ff-synket).
- **PR #86 (UA-10 P1 aktivering, D-160, `057_situations_activation.sql`)** - DENNE branchen: draft,
  `origin/main` (`14a12fd…`) merget INN i branchen med vanlig merge-commit (første forelder = tidligere
  PR #86-head `9b51bf71…`, andre forelder = main). Ingen rebase/force/history-omskriving.

## Rekonsilieringen (denne merge-committen)

**Konflikt (nøyaktig én):** `docs/PROJECT_STATUS.md` - overskrevet (denne filen).

**Auto-merget og verifisert komponert (ikke blindt valgt):**
- `apps/api/src/main.ts`: UA-9 Vision-wiring fra main (`VisionService`, `vision-retention-sweep` kl. 02)
  OG UA-10 P1-wiring fra PR #86 (durable `DomainPauseRegistry` + `restore()`, `SituationEngine`,
  `situations`-verktøyet via `firstWaveTools(..., { additionalTools })`, `situation-sweep` kl. 07 med
  fail-closed `assertSituationSweepHealthy()`) - begge til stede; fortsatt NØYAKTIG ETT
  `toolGateway.register(`-sted (regresjonsvakt J i `drive-runtime-wiring.test.ts`).
- `modules/erasure/src/plan.ts`: vision-blokken (055) + `situations` (056) fra main, samt PR #86 sin
  dokumenterte utelatelse av `situation_autonomy_policies` (eier-policy, ikke persondata). Person-/space-
  isolasjon og fail-closed-semantikk uendret.
- `apps/api/package.json` + `pnpm-lock.yaml`: både `@jarvis/vision` og `@jarvis/situations`.
- `docs/DECISIONS_AND_ASSUMPTIONS.md`: D-153 (fra main) og D-160 (fra PR #86) begge til stede.

**Migrasjonsrekkefølge (deterministisk, én gyldig):** `migrator.ts` kjører `^\d{3}_.*\.sql$` sortert og
hopper over navn i `schema_migrations`. Etter merge: `054_tool_executions_postcondition.sql ->
055_vision.sql -> 056_situations.sql -> 057_situations_activation.sql`. Ingen dupliserte prefikser, ingen
tapt migrasjon. Fersk install kjører alle fire i rekkefølge; en host på dagens main (055+056 anvendt) får
KUN 057 ved neste oppstart. Bevist av `modules/core/test/migration-order-055-056.test.ts` (fra main,
utvidet i denne rekonsilieringen til å dekke 057: fersk bane vs. «main-bane så kun 057», identisk
katalog-snapshot på to ekte embedded Postgres-klynger).

**PR #86 sine review-fikser er bevart uendret av mergen:** identitet KUN fra `ToolInvocationContext`
(`transport.ts`, review 5229219808 funn 2) og fail-closed scheduler-grense (`sweep.ts` +
`.then(assertSituationSweepHealthy)` i `main.ts`, funn 3); begge filene er byte-identiske med
`9b51bf71…`. Head-historikken er intakt (merge-commit oppå eksisterende commits).

## UA-10 P1 - innhold (uendret, se D-160 og `UA10_SITUATION_ENGINE_DESIGN.md` §10)

`057_situations_activation.sql`, `open-loop-bridge.ts`, `sweep.ts`, motor-utvidelser, `transport.ts`,
wiring i `main.ts`. Arkitekt-review runde 1 (5229219808): funn 2 og 3 rettet og bekreftet lukket i
review 5229519184; funn 1 (sekvens: PR #83 først) er nå LUKKET ved at PR #83 er merget og denne
branchen er rekonsiliert oppå den.

## Blokkeringer

1. **Merge av PR #86.** `MERGE_AUTHORIZED=false`. Krever ny uavhengig arkitekt-review mot eksakt ny HEAD og
   eksplisitt merge-autorisasjon.
2. **Host-/live-kjøring av `situation-sweep`** er ikke gjort (FIXED_SUITE, se RUNTIME_GATES.md).
3. **Embedded-Postgres-flake (B.3, port-kontensjon)** er fortsatt kjent i repo-suiten (uendret).

## Neste oppgave

Arkitekt-review og merge av rekonsiliert PR #86. Deretter host-kjøring av `situation-sweep`
(RUNTIME_GATES-rad -> LIVE), så **UA-11 Executive Mode P0** (ikke startet).
