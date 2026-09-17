# PROJECT STATUS

**Oppdatert:** 2026-09-17 (branch `tobias/manual-masterplan-ua11-executive-mode-p0` fra exact
`main=ff24a4a3b742b7c67a95b3af58a4808ea558a307`). Aktiv oppgave: **UA-11 Executive Mode P0 (D-162)
– attention-ranking + samlet kontrollflate som KOMPONERER `situations`-verktøyet, ikke dupliserer det.**
`MERGE_AUTHORIZED=false`, `SELF_APPROVAL=false`. Sovereign som helhet **FORTSATT IKKE komplett**. Ingen
ny masterplan, ingen UGREEN-migrering.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Hvor `main` står nå

- Base for denne branchen: exact `main=ff24a4a3b742b7c67a95b3af58a4808ea558a307` (PR #90 sin
  merge-commit - UA-10 P1 runtime-gate closeout, D-161, PRODUCTION_VERIFIED).
- Main har migrasjonene `054 -> 055_vision -> 056_situations -> 057_situations_activation` og komponerer
  UA-9 Vision + UA-10 Situation Engine (`situation-sweep`) i `apps/api/src/main.ts`.

## UA-11 Executive Mode P0 - hva er bygget (D-162)

**Ny pakke `@jarvis/executive`** (`modules/executive`): `ExecutiveService` sin konstruktør tar KUN en
`ToolGateway`-referanse (aldri `SituationEngine`/`DomainPauseRegistry` direkte) - hver lesning/mutasjon
går via et NESTET `gateway.execute({tool_id:"situations",...})`-kall med `identity` videresendt UENDRET
fra den betrodde `ToolInvocationContext` (D-68). Dette gjør komposisjon (ikke duplisering av
`situations`-logikk) strukturelt garantert, ikke bare en avtale.

- `src/ranking.ts` (ren funksjon, ingen DB/IO): deterministisk attention-scoring på KUN faktisk
  eksisterende `Situation`-felt (stage/priority/confidence/opened_at/status/notification-cooldown),
  tie-break `score -> opened_at -> situation_id`, `explainAttentionScore()`/`recommendNextAction()` per
  item. "Business impact" EKSPLISITT IKKE brukt (ingen datakilde).
- `src/service.ts` / `src/transport.ts`: 6 ToolGateway-handlinger (`get_attention_queue`/
  `get_attention_item`/`get_pause_state` klasse A, `pause_domain`/`resume_domain` klasse C,
  `resolve_situation` klasse B) - identitet KUN fra `ToolInvocationContext`, aldri fra parametre.
- Registrert i `apps/api/src/main.ts` sin `firstWaveTools({...}, {additionalTools: [...situations...,
  ...executive...]})` - SAMME registreringsloop, ingen parallelt sted.
- **`WORKER_SITUATIONS_GAP=true` bekreftet** (pre-eksisterende siden UA-10 P1): `worker-main.ts` har
  aldri koblet `@jarvis/situations`; `@jarvis/executive` er BEVISST heller ikke koblet der i denne
  sliceen (testet fravær, `executive-wiring.test.ts` gruppe B) - ingen HTTP-/prosessflate der å bruke det.
- **Ingen ny persistens/migrasjon/credential.** Køen er fullt deriverbar fra `situations.get_queue()` ved
  lesetidspunkt. Ingen Q-20-registrering nødvendig.
- **Funn, ikke fikset ved roten:** `Situation.confidence` returneres som STRENG av `pg` for
  `numeric`-kolonnen (ingen global `pg.types.setTypeParser` i repoet) - fikset DEFENSIVT kun ved
  `@jarvis/executive` sin egen grense (`toNumberOrNull()`), `@jarvis/situations` selv urørt (utenfor
  scope for denne minimale P0-sliceen).

## Tester og gates

- `modules/executive/test/ranking.test.ts` (21, ren) + `service-transport.test.ts` (17, ekte embedded
  Postgres/RLS) + `apps/api/test/executive-wiring.test.ts` (4, strukturell regresjonsvakt) = 42 nye
  tester, alle grønne. Ingen regresjon i `drive-runtime-wiring.test.ts` (13) eller
  `executive-parity.test.ts` (4, urelatert BO-11.1-navnekollisjon).
- `pnpm -w typecheck`: PASS (alle moduler inkl. `modules/executive`, `apps/api`).
- `pnpm -w lint`: PASS (ren).
- `pnpm -w test` (full workspace-suite): se terminalrapport for eksakt tall (kjørt separat pga.
  lang kjøretid).
- `git diff --check`: PASS. Manuell secret-scan av diff/nye filer: kun testplaceholdere
  (`"test-token"`/`pw`/`pw2` for embedded-Postgres, samme mønster som alle andre modul-testsuiter) og
  prosetekst som nevner "secret"/"credential" - ingen ekte nøkler/tokens.

## Blokkeringer

1. **Merge av denne PR-en.** `MERGE_AUTHORIZED=false`; krever arkitekt-review mot exact HEAD.
2. **Embedded-Postgres-flake (B.3, port-kontensjon)** er fortsatt kjent i repo-suiten (uendret av denne
   sliceen).

## Eksplisitt DEFERRED (ikke stille utelatt)

Dashboard/UI, forretningshelse-/personlige domenekilder utover `situations`, beslutningslogg/scenario/
risikoregister/delegasjonstavle, business-impact-vekting (ingen datakilde), modell-assistert ranking
(ModelGateway-avhengighet, egen D-64/D-41-port ved behov, ALDRI eneste autoritet), dedikert HTTP-rute,
worker-wiring (se `WORKER_SITUATIONS_GAP` over), host-akseptanse-harness for UA-11 (ingen host-kjørbar
leverandør/credential/migrasjon i denne sliceen - `RUNTIME_GATES.md`: `FIXED_SUITE_VERIFIED`,
`HOST_ACCEPTANCE_REQUIRED=false` for P0).

## Neste oppgave

Videre UA-11-slicer (dashboard/UI-flate, worker-wiring hvis en fremtidig prosess faktisk trenger det,
modell-assistert ranking under D-64/D-41-port) - **ikke startet i denne oppgaven**. Sovereign som helhet
er **FORTSATT IKKE komplett**. Ingen ny masterplan, ingen UGREEN-migrering.
