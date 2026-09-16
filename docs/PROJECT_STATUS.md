# PROJECT STATUS

**Oppdatert:** 2026-09-16 (branch `tobias/manual-masterplan-ua10-activation-p1`, base
`main=639730c5c14ba6175e91b09606abc4d9dd24fb8a` = PR #85 sin merge-commit). Aktiv oppgave: **UA-10 P1
Aktivering (D-160)** - manuell masterplan-slice valgt etter en fersk, repo-basert Sovereign-audit.
`MERGE_AUTHORIZED=false`, `SELF_APPROVAL=false`, `HOST_ACCEPTANCE_REQUIRED=false`.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Hvor `main` står nå

- **PR #84 (D-157/D-158/D-159, kontrollplanens merge-bevis) MERGET** 2026-09-16 som normal two-parent
  merge `a0d9a7b27e1a6aaac8c70527e8a8e3357b3c9bad` (review 5228070972 `MERGE_AUTHORIZED=true`, post-merge
  CI grønn).
- **PR #85 (UA-10 P0 Proactive Situation Engine) MERGET** 2026-09-16 som normal two-parent merge
  `639730c5c14ba6175e91b09606abc4d9dd24fb8a` (review 5228551712 `MERGE_AUTHORIZED=true`, post-merge CI
  run 35152674039 grønn).
- **PR #83 (UA-9 Vision, D-153)** er fortsatt ÅPEN, ready-for-review, base `6f1c980c` (to merger bak
  `main`). Ikke rørt av denne sliceen.

## Sovereign completion-audit (fersk, repo-basert, UA-0..UA-11) - kortversjon

| UA | Status | Gjenstående |
|---|---|---|
| UA-0 | PARTIAL (dokumentert) | Docker/UGREEN/Infisical/Langfuse/pgvector/Apple/HA-runtime, off-site backup - alle host-/credential-blokkerte (RUNTIME_GATES.md); connector-vedlikeholdsledger ikke bygget |
| UA-1 | COMPLETE (4 provider-familier + lokal adapter) | lokal inferens-maskinvare (host), hosted-Gemma-streaming (Q-30, ikke-blokkerende) |
| UA-2 | VERIFIED/COMPLETE | Pieces/Knowledge Graph er "Bygges"-bredde, ikke kriterier |
| UA-3 | COMPLETE (D-130/D-131) | ingen provider-uavhengig rest |
| UA-4 | COMPLETE (D-93) | Google Ads live + autonom utførelse = D-108/DoD-rest (credentials) |
| UA-5 | COMPLETE (D-105) | GitHub live-token, `redeploy_container` produksjonssikkerhet (D-108/eier) |
| UA-6 | COMPLETE (D-115/D-116) | live leverandør-credentials (D-108) |
| UA-7 | 3/4 (kriterium 4 PARTIAL) | Q-32 punkt 1 (eier-/juridisk), utgående kanaler (D-108) |
| UA-8 | COMPLETE provider-uavhengig | Apple Health/lokasjon/iOS-bygg (fysisk/host) |
| UA-9 | kun på PR #83 | merge av PR #83 (arkitekt) |
| UA-10 | P0 merget; **P1 aktivering = DENNE sliceen** | infra/home/health-detektorer, modell-assistert klassifisering, counterfactual (alle eksplisitt utsatt) |
| UA-11 | NOT_STARTED | executive brief/attention-ranking over levende situasjoner, samlet kontrollflate (komponerer `situations`-verktøyet), decision log/risk register/OKR/delegation |

**Hvorfor UA-10 P1 før UA-11:** motoren var død kode på main (ingen import utenfor egen pakke, ingen
bro, ingen sveip, `last_notified_at` stemplet uten leveranse, `actOn()` kun fra tester). DoD-en
"Situation Engine performs autonomous ACT/ACT+NOTIFY ..." krever at den kjører, og UA-11 forutsetter den.

## UA-10 P1 - ferdig implementert og testet (denne branchen)

Se `docs/UA10_SITUATION_ENGINE_DESIGN.md` §10 og D-160 for full detalj. Kort:
`057_situations_activation.sql` (frosset INFORM-tekst + bokført leveranse + `situation_autonomy_policies`),
`open-loop-bridge.ts` (uttømmende `OpenLoopType`-kartlegging), `sweep.ts` (INGEST -> RESOLVE -> DELIVER
-> AUTO-ACT), motor-utvidelser (evidens-først leveranse, eier-bundet autonomi-policy, `autoActPending`,
kildebasert løsning), `transport.ts` (`situations`-verktøy = kontrollflate), wiring i
`apps/api/src/main.ts` (durable pause `restore()`, `situation-sweep` kl. 07).

**Bevis (kjørt i denne økten, som `postgres`-bruker fordi embedded-postgres nekter root i containeren):**
- `modules/situations/test/activation.test.ts` **18/18** + `open-loop-bridge.test.ts` **7/7** (nye).
- Eksisterende: `service-rls` 29/29, `act-on` + `domain-pause` + `stage-rules` + `erasure/situations-erasure`
  **72/72** - alle grønne mot den utvidede motoren og den nye migrasjonen.
- `@jarvis/situations` og `@jarvis/api` typecheck rene. Repo-lint/typecheck/full arbeidsområde-suite:
  se PR-beskrivelsen for eksakte tall (rapportert som målt).

## Blokkeringer

1. **Merge.** `MERGE_AUTHORIZED=false`. Krever uavhengig arkitekt-review mot eksakt HEAD og en
   ARCHITECT_TASK/-REVIEW med `ARCHITECT_MERGE_APPROVED=true`.
2. **Host-/live-kjøring av `situation-sweep`** er ikke gjort (FIXED_SUITE, se RUNTIME_GATES.md).
   Leveransen bruker samme `telegram.notify`-transport som daglig brief - ingen ny credential.
3. **Embedded-Postgres-flake (B.3, port-kontensjon)** er fortsatt kjent i repo-suiten (uendret).
4. **PR #83 (UA-9)** er to merger bak main og trenger arkitekt-beslutning.

## Neste oppgave

Uavhengig arkitekt-review av denne draft-PR-en. Deretter, i rekkefølge: merge, host-kjøring av
`situation-sweep` (RUNTIME_GATES-rad -> LIVE), så **UA-11 Executive Mode P0**: samlet kontrollflate som
komponerer `situations`/`finance`/`infra`/`OwnerControls`-pausene (durabelt, rutet, eier-autorisert),
executive brief/attention-ranking over open loops + situasjoner + tasks + kalender + kontekst med
"hvorfor prioritert", og decision log / risk register / goals / delegation board.
