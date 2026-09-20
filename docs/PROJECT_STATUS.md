# PROJECT STATUS

**Oppdatert:** 2026-09-20 (branch `claude/hva-skjer-hvordan-ligger-0z3ztp`, fra fersk `origin/main` HEAD
`826519a` + D-203/PR #110 MERGET på toppen av det. Aktiv kodeoppgave: D-204 (Gemma
`bad_request`-diagnostikk, se under) - commit/PR ikke opprettet ennå i denne økten.

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

- **PR #106-#110 MERGET** (D-200 Gemma-streaming, D-201 sluttmål, PROJECT_STATUS-refresh, D-202
  Langfuse Cloud-routing, D-203 chat-sensitivitetsdefault - se DECISIONS_AND_ASSUMPTIONS.md for detaljer
  per PR). Alle NAS-redeployet og live-verifisert av Tobias i denne økten.
- **D-203 (chat-sensitivitetsdefault) live-verifisert POST-redeploy: fikset udefinert-sensitivitet-
  gaten, MEN Gemma dukket fortsatt ALDRI opp i chatten** ("de nye kommer ikke opp"/"fortsatt bare
  chat GPT-meldinger"). Dette utløste D-204s feilsøking.
- **D-204 (denne økten, kode skrevet/testet, IKKE ENNÅ commitet/pushet/PR-et/merget): rotårsaken til
  at Gemma fortsatt ikke velges er FUNNET og delvis diagnostisert, men IKKE fullstendig fikset ennå.**
  Direkte SQL mot NAS-ens `cost_events`-tabell (host-bevis) viste: `gemma_hosted` BLIR faktisk valgt
  som topp-kandidat av AUTO-scoringen (133 poeng mot `openai`s 132 - scoringslogikken er og var
  korrekt), men feiler `model:failed:bad_request` på HVERT ekte kall til Gemini API, hvorpå den
  eksisterende, korrekte fallback-logikken (§12) stille går videre til `openai` - INGEN bruker-synlig
  feil, INGEN krasj, bare en helt usynlig transportfeil. Den EKSAKTE Gemini-feilkoden bak
  `bad_request` var UVERIFISERBAR fordi `gemma.ts` (i motsetning til søsken-adapterne `gemini.ts`/
  `kimi.ts`) aldri fikk D-106 HOST-FIX Defekt B sin trygge feilkode-diagnostikk, og
  `recordFailedAttempt()` persisterer uansett kun `err.kind`, aldri meldingen. **Levert i D-204
  (diagnostikk, IKKE rotårsaks-fiks):** `gemma.ts` fikk samme `extractProviderErrorCode()`/
  `sanitizeEndpointForDiagnostics()`-mønster som gemini/kimi; `ModelGateway.executePlan()` fikk en
  ny, alltid-på `console.error("model_attempt_failed", ...)`-linje med provider/kind/status/diagnostic
  (alle allerede vettet trygge felt). 5 nye tester i `conformance.test.ts`, alle grønne.
  `pnpm --filter @jarvis/provider-adapters typecheck`/`pnpm --filter @jarvis/model-gateway
  typecheck`/`npx eslint .` rene. **Mistenkt (IKKE bekreftet) egentlig rotårsak:** Gemini API sitt
  restriktive `functionDeclarations`-skjema-subsett avviser trolig en eller flere standard
  JSON-Schema-nøkler (f.eks. `additionalProperties`) i Jarvis sine verktøydefinisjoner -
  `gemma_hosted` er den FØRSTE adapteren i kodebasen som faktisk sender `tools` til Gemini
  API-flaten. Se D-204 for full begrunnelse.

## GJENSTÅENDE: D-204 commit/PR/merge + NAS-redeploy + live-verifisering av DEN EKTE feilkoden

D-204-diagnostikk-koden er skrevet og testet i denne sandboxen, men IKKE ENNÅ commitet/pushet/PR-et/
merget. Neste steg: commit → push → draft PR → CI → merge under D-192 → NAS git-hent/rebuild (kildekode
i `packages/provider-adapters`+`modules/model-gateway` - KREVER `docker compose build api worker &&
up -d`, ikke bare `up -d`) → send ÉN ny chatmelding → `sudo docker logs local-api-1 | grep
model_attempt_failed` for å faktisk se Gemini API sin ekte feilkode (`diagnostic.provider_error_code`)
→ DERETTER implementere den reelle rotårsaks-fiksen (mistenkt skjema-oversettelse for
`functionDeclarations`, men IKKE en gjettet fiks før feilkoden er sett) → nok en NAS-redeploy → live-
verifisering i Langfuse/chat at Gemma faktisk svarer.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå utover D-204s pågående diagnostikk-runde.
`EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET, dekker resten av masterplanen: Growth-stack
live-evidens, reelle Finance-transaksjoner (Stripe), iPhone/Watch/Home/Personal/Health LIVE, off-site
backup/monitoring. Se `docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

**Google OAuth (Calendar/Drive/Gmail) - FULLFØRT tidligere denne økten** (utenfor git,
credential-oppsett): live-verifisert, Jarvis leser faktiske e-poster i produksjon.

## Neste oppgave

1. **Fullføre D-204:** commit + push + draft PR + CI + merge (D-192) + NAS-rebuild + send én chat-
   melding + les `model_attempt_failed`-loggen for den ekte Gemini-feilkoden + implementer den
   evidensbaserte rotårsaks-fiksen (se eget avsnitt over).
2. **UA-11 Executive Mode "K2":** decision log/scenarios/risk register/OKRs/delegation board (navngitt
   i masterplanen, zero kode, zero ekstern avhengighet). Avklar akseptansekriterier med Tobias før
   implementering starter.
3. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer (Stripe/Neonomics/
   Google Ads gjenstår fortsatt, se tidligere øktnotater).
