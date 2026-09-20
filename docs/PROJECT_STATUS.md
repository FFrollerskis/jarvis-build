# PROJECT STATUS

**Oppdatert:** 2026-09-20 (branch `claude/hva-skjer-hvordan-ligger-0z3ztp`, fra fersk `origin/main` HEAD
`65b3997` = D-204/PR #111 MERGET. Aktiv kodeoppgave: D-205 (den EKTE `gemma_hosted`
`additionalProperties`-skjema-fiksen, se under) - commit/PR ikke opprettet ennå i denne økten.

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

- **PR #106-#111 MERGET** (D-200 Gemma-streaming, D-201 sluttmål, PROJECT_STATUS-refresh, D-202
  Langfuse Cloud-routing, D-203 chat-sensitivitetsdefault, D-204 Gemma-diagnostikk - se
  DECISIONS_AND_ASSUMPTIONS.md for detaljer per PR). PR #106-#110 NAS-redeployet og live-verifisert
  av Tobias tidligere i denne økten.
- **D-203 (chat-sensitivitetsdefault) live-verifisert POST-redeploy: fikset udefinert-sensitivitet-
  gaten, MEN Gemma dukket fortsatt ALDRI opp i chatten.** Dette utløste D-204/D-205s feilsøking.
- **D-204 (NAS-redeployet OG live-verifisert i denne økten): trygg feilkode-diagnostikk lagt til
  `gemma_hosted`** (samme mønster som `gemini.ts`/`kimi.ts`) + alltid-på `console.error` på ethvert
  mislykket modellforsøk. Diagnostikken avslørte umiddelbart den ekte Gemini-feilkoden
  (`INVALID_ARGUMENT`) - noe som var UMULIG å se før denne fiksen.
- **D-205 (denne økten, kode skrevet/testet, IKKE ENNÅ commitet/pushet/PR-et/merget): den EKTE
  rotårsaken funnet OG fikset.** Live host-feilsøking etter D-204-redeploy fulgte to blindveier
  først (begge dokumentert i D-205 for sporbarhet): (1) NAS-ens `.env` hadde
  `JARVIS_GEMMA_MODEL=gemma3:4b` (en Ollama-stil-tag, ugyldig Gemini API-modell-ID - trolig
  sammenblandet med `gemma_local`s config) - fjernet, men IDENTISK `bad_request`/`INVALID_ARGUMENT`
  vedvarte mot kodens korrekte default-modell (`gemma-4-26b-a4b-it`), som beviste modellnavnet ikke
  var hele problemet. (2) En live `node -e fetch(...)`-test direkte fra NAS-en mot Gemini API (samme
  nøkkel/modell, INGEN `tools`) ga `HTTP 200` - isolerte feilen til selve `tools`-payloaden. Fant at
  ALLE tre verktøyskjemaene i `modules/tool-gateway/src/mesh-bridge.ts` (`MESH_TOOLS`) setter
  `additionalProperties: false` - gyldig for `openai`/`anthropic`, men Gemini API sitt
  function-calling-skjema støtter IKKE denne nøkkelen (bekreftet uavhengig via Google sitt eget
  utviklerforum - identisk feilklasse rapportert der). **Levert:** ny, rekursiv
  `stripAdditionalProperties()`-hjelpefunksjon i `GemmaHostedAdapter.buildRequestBody()`
  (`packages/provider-adapters/src/gemma.ts`) fjerner KUN denne ene, dobbelt-bevist usupporterte
  nøkkelen fra `t.input_schema` FØR den sendes som `functionDeclarations[].parameters` - kilden
  (`mesh-bridge.ts`) er UENDRET (nøkkelen er fortsatt riktig der for de andre providerne). 1 ny test
  i `conformance.test.ts` (fanger faktisk sendt request-body, beviser nøkkelen fjernes rekursivt).
  `pnpm --filter @jarvis/provider-adapters typecheck`/`npx eslint .` rene, `conformance.test.ts`
  93/93, full `modules/model-gateway`-suite 330/333 (kun kjent urelatert embedded-Postgres-
  sandbox-feil) grønne.

## GJENSTÅENDE: D-205 commit/PR/merge + NAS-redeploy + live-verifisering at Gemma faktisk svarer

D-205-koden er skrevet og testet i denne sandboxen, men IKKE ENNÅ commitet/pushet/PR-et/merget. Neste
steg: commit → push → draft PR → CI → merge under D-192 → NAS-rebuild (kildekode i
`packages/provider-adapters` - KREVER `docker compose build api worker && up -d`) → send ÉN ny
chatmelding → `sudo docker logs --since 2m local-api-1 | grep -E "model_attempt_failed|stream_debug_
gateway.*provider"` for å bekrefte `gemma_hosted` faktisk svarer (ingen `model_attempt_failed`-linje,
`provider":"gemma_hosted"` i stream-eventene) → live-verifisering i Langfuse at Gemma faktisk brukes
for normal chat.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå utover D-205s pågående redeploy-verifisering.
`EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET, dekker resten av masterplanen: Growth-stack
live-evidens, reelle Finance-transaksjoner (Stripe), iPhone/Watch/Home/Personal/Health LIVE, off-site
backup/monitoring. Se `docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

**Google OAuth (Calendar/Drive/Gmail) - FULLFØRT tidligere denne økten** (utenfor git,
credential-oppsett): live-verifisert, Jarvis leser faktiske e-poster i produksjon.

## Neste oppgave

1. **Fullføre D-205:** commit + push + draft PR + CI + merge (D-192) + NAS-rebuild + send én chat-
   melding + bekreft `gemma_hosted` faktisk svarer (se eget avsnitt over).
2. **UA-11 Executive Mode "K2":** decision log/scenarios/risk register/OKRs/delegation board (navngitt
   i masterplanen, zero kode, zero ekstern avhengighet). Avklar akseptansekriterier med Tobias før
   implementering starter.
3. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer (Stripe/Neonomics/
   Google Ads gjenstår fortsatt, se tidligere øktnotater).
