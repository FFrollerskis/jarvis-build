# PROJECT STATUS

**Oppdatert:** 2026-09-20 (branch `claude/gemma-live-verified-status`, fra fersk `origin/main` HEAD
`dbd32f2` = D-205/PR #112 MERGET. **Gemma-first-policyen (D-79/D-80) er FAKTISK i drift for
normal chat for FØRSTE gang** - live-verifisert av Tobias rett etter D-205-redeploy. Aktiv
kodeoppgave: D-206 (fjerner Gemini sine "thought"-resonnerings-parter fra svarteksten, oppdaget
UMIDDELBART etter D-205-live-verifiseringen) - commit/PR ikke opprettet ennå i denne økten.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19) - GJELDENDE VIDERE

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd, helt til punktet der videre fremgang
faktisk krever credentials/kontoer/MCP-koblinger - IKKE start ny scope utover masterplanen. issue #68
BEHOLDES som logg. Claude har STÅENDE FULLMAKT til å merge rutinemessige PR-er når CI er grønt/tester
består/ingen åpne funn. D-201 presiserer sluttmålet: hele masterplanen bygget/fungerende, ALLE eksterne
integrasjoner unntatt `Fiken`/`Walley` (permanent ekskludert), en helt autonom agent, drift på
UGREEN-NAS-en + Tobias sin PC (`gemma_local`) som tilleggskraft inntil dedikert maskin. Se
D-192/D-201 i DECISIONS_AND_ASSUMPTIONS.md og `CLAUDE.md` §Merge-autoritet.

## Hvor `main` står nå

- **PR #106-#112 MERGET** (D-200 Gemma-streaming, D-201 sluttmål, PROJECT_STATUS-refresh, D-202
  Langfuse Cloud-routing, D-203 chat-sensitivitetsdefault, D-204 Gemma-diagnostikk, D-205 Gemma
  skjema-fiks - se DECISIONS_AND_ASSUMPTIONS.md for detaljer per PR). Alle NAS-redeployet og
  live-verifisert av Tobias i denne økten.
- **D-205 LIVE-VERIFISERT: `gemma_hosted` svarer faktisk på ekte chat, for FØRSTE gang siden
  D-79/D-80 ble bygget.** Etter NAS-rebuild + én chatmelding viste `docker logs`
  `"provider":"gemma_hosted"` gjennom en HEL samtale (start→text_delta×N→usage→finish), null
  `model_attempt_failed`-linjer. Hele D-200→D-203→D-204→D-205-kjeden (streaming-kapabilitet →
  sensitivitetsdefault → diagnostikk → den ekte skjema-fiksen) er dermed reelt fullført og
  bevist, ikke bare "kode skrevet".
- **D-206 (denne økten, kode skrevet/testet, IKKE ENNÅ commitet/pushet/PR-et/merget): et NYTT,
  ekte funn oppdaget UMIDDELBART av Tobias etter D-205-verifiseringen.** Jarvis sine svar via
  `gemma_hosted` inneholdt synlig intern resonneringstekst FØR selve svaret (f.eks. "The user is
  repeatedly saying hei... I should respond simply..."). Rotårsak: Gemini sine "thinking"-
  modeller (Gemma 4 inkludert) returnerer resonnering som EGNE `parts`-elementer merket
  `thought: true` - `GemmaHostedAdapter.complete()`/`.stream()` behandlet ALLE tekst-parts likt,
  uten å filtrere disse bort, verken i sluttsvaret eller i de live strømmede `text_delta`-eventene.
  **Levert:** begge metodene filtrerer nå eksplisitt bort `thought: true`-parter. 2 nye tester
  (complete()+stream()). `pnpm --filter @jarvis/provider-adapters typecheck`/`npx eslint` rene,
  `conformance.test.ts` 94/94 + `sse-fixtures.test.ts` 11/11 grønt. Se D-206.

## GJENSTÅENDE: D-206 commit/PR/merge + NAS-redeploy + live-verifisering at resonnering IKKE lekker

D-206-koden er skrevet og testet i denne sandboxen, men IKKE ENNÅ commitet/pushet/PR-et/merget. Neste
steg: commit → push → draft PR → CI → merge under D-192 → NAS-rebuild (kildekode i
`packages/provider-adapters` - KREVER `docker compose build api worker && up -d`) → send ÉN ny
chatmelding via web-UI-en (IKKE bare docker-logg-sjekk denne gangen - Tobias må faktisk LESE svaret
og bekrefte ingen synlig "The user said..."-resonnering lenger) → oppdater PROJECT_STATUS.md en
siste gang for å lukke ut hele Gemma-sagaen (D-200→D-206).

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå utover D-206s pågående redeploy-verifisering.
`EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET, dekker resten av masterplanen: Growth-stack
live-evidens, reelle Finance-transaksjoner (Stripe), iPhone/Watch/Home/Personal/Health LIVE, off-site
backup/monitoring. Se `docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

**Google OAuth (Calendar/Drive/Gmail) - FULLFØRT tidligere denne økten** (utenfor git,
credential-oppsett): live-verifisert, Jarvis leser faktiske e-poster i produksjon.

## Neste oppgave

1. **Fullføre D-206:** commit + push + draft PR + CI + merge (D-192) + NAS-rebuild + send én chat-
   melding + Tobias bekrefter visuelt at resonnering ikke lenger vises (se eget avsnitt over).
2. **UA-11 Executive Mode "K2":** decision log/scenarios/risk register/OKRs/delegation board (navngitt
   i masterplanen, zero kode, zero ekstern avhengighet). Avklar akseptansekriterier med Tobias før
   implementering starter.
3. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer (Stripe/Neonomics/
   Google Ads gjenstår fortsatt, se tidligere øktnotater).
