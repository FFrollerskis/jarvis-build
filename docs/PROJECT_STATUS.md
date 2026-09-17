# PROJECT STATUS

**Oppdatert:** 2026-09-17 (branch `tobias/manual-masterplan-ua9-vision-p0`, PR **#83**, rekonsiliert mot
`main=639730c5c14ba6175e91b09606abc4d9dd24fb8a` = PR #85 sin merge-commit). Aktiv oppgave: **D163/D164 -
rekonsiliering av PR #83 (UA-9 Vision) mot dagens main** slik at UA-9 kan merges trygt ETTER at PR #85/UA-10
allerede ligger på main, og sekvensblokkeren for PR #86 lukkes.
`MERGE_AUTHORIZED=false`, `SELF_APPROVAL=false`, `HOST_ACCEPTANCE_REQUIRED=false`.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Hvor `main` står nå

- **PR #84 (D-157/D-158/D-159, kontrollplanens merge-bevis) MERGET** 2026-09-16 som normal two-parent
  merge `a0d9a7b27e1a6aaac8c70527e8a8e3357b3c9bad`.
- **PR #85 (UA-10 P0 Proactive Situation Engine, `056_situations.sql`) MERGET** 2026-09-16 som normal
  two-parent merge `639730c5c14ba6175e91b09606abc4d9dd24fb8a`.
- **PR #83 (UA-9 Vision, D-153, `055_vision.sql`)** - DENNE branchen: `origin/main` merget INN i branchen
  med vanlig merge-commit (ingen rebase/force/history-omskriving).
- **PR #86 (UA-10 P1 aktivering, D-160, `057_situations_activation.sql`)** er draft, urørt av dette
  arbeidet, og venter på at PR #83 er rekonsiliert og merget (arkitekt-review 5229519184).

## Rekonsilieringen (denne merge-committen)

**Konflikter (nøyaktig to, begge additive):**
1. `modules/erasure/src/plan.ts` - `planMemorySpaceInContext()`: PR #83 la til vision-blokken
   (`vision_event_observations` -> `vision_rooms` -> `vision_retention_policies`), main la til
   `situations`. BEGGE beholdt; ingen FK mellom 055- og 056-tabellene (055 refererer kun
   tenants/people/person_tenants/vision_rooms, 056 kun tenants/people/person_tenants/business_open_loops),
   rekkefølgen dem imellom er vilkårlig. `planPerson()` (vision-delen) hadde ingen konflikt.
2. `docs/PROJECT_STATUS.md` - overskrevet (denne filen).

Alt annet auto-merget: `apps/api/src/main.ts` (main rørte den ikke siden merge-base - Vision-wiringen
`vision-retention-sweep` er den ENESTE deltaen mot main; UA-10 P0 har ingen main.ts-wiring på main),
`apps/api/package.json` (`@jarvis/vision`), `docs/DECISIONS_AND_ASSUMPTIONS.md` (D-153 + D-157..D-159),
`pnpm-lock.yaml`, hele `modules/situations/**` og `ops/claude-worker/**` fra main.

**Migrasjonsrekkefølge (deterministisk, én gyldig):** `migrator.ts` kjører `^\d{3}_.*\.sql$` i
lexikografisk sortert rekkefølge og hopper over navn som allerede står i `schema_migrations`. Etter
merge: `... 054_tool_executions_postcondition.sql -> 055_vision.sql -> 056_situations.sql`. Ingen
dupliserte ID-er, ingen tapt migrasjon. En host som allerede har kjørt 056 (fra main) får KUN 055 lagt til
ved neste oppstart; en fersk database kjører 055 så 056. Begge banene gir samme skjema - se
`modules/core/test/migration-order-055-056.test.ts` (to ekte embedded Postgres-klynger; deterministisk
katalog-snapshot - kolonner, constraints, indekser, RLS-policyer/-flagg, grants, triggere, funksjoner,
roller, anvendte migrasjoner - sammenlignet mellom «055 så 056» og «056 så 055»; ingen pg_dump-avhengighet).

## Blokkeringer

1. **Merge av PR #83.** `MERGE_AUTHORIZED=false`. Krever uavhengig arkitekt-review mot eksakt ny HEAD og en
   ARCHITECT_TASK/-REVIEW med `ARCHITECT_MERGE_APPROVED=true`.
2. **Embedded-Postgres-flake (B.3, port-kontensjon)** er fortsatt kjent i repo-suiten (uendret).
3. **UA-9 live-adaptere** (iPhone/HA-kamera, objektklassifisering) er fortsatt DEFERRED (DPIA §5).

## Neste oppgave

Arkitekt-review og merge av rekonsiliert PR #83. Deretter PR #86 (UA-10 P1) re-guardes mot ny main
(057 kommer etter 056; 055 er da allerede på main) og reviewes på nytt. Så UA-11 Executive Mode P0.
