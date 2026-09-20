# PROJECT STATUS

**Oppdatert:** 2026-09-20 (branch `claude/gemma-nas-redeploy-status`, fra fersk `origin/main` HEAD
`8429a55`, som inkluderer D-200/PR #106 og D-201/PR #107 MERGET). **PR #95/#96(W1)/#98/#87/#99(D-194)/
#100(D-195)/#101(D-196)/#102(D-197)/#103(D-198)/#104(D-199)/#105(status-fiks)/#106(D-200)/#107(D-201)
er ALLE MERGET.** Ingen aktiv kodeoppgave akkurat nå - neste anbefalte oppgave er live NAS-redeploy +
verifisering av Gemma-streaming (se under), deretter UA-11 "K2".

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19) - GJELDENDE VIDERE

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd, helt til punktet der videre fremgang
faktisk krever credentials/kontoer/MCP-koblinger - IKKE start ny scope utover masterplanen. issue #68
BEHOLDES som logg. Claude har STÅENDE FULLMAKT til å merge rutinemessige PR-er når CI er grønt/tester
består/ingen åpne funn. **D-198/D-199 eksplisitt delegert av Tobias** (designbeslutning/prioritering).
**D-201 (2026-09-20)** presiserer sluttmålet EKSPLISITT: hele masterplanen bygget/fungerende, ALLE
eksterne integrasjoner unntatt `Fiken`/`Walley` (permanent ekskludert), en helt autonom agent, drift
på UGREEN-NAS-en + Tobias sin PC (`gemma_local`) som tilleggskraft inntil dedikert maskin - deretter
"plan nr 2". Se D-192/D-201 i DECISIONS_AND_ASSUMPTIONS.md og `CLAUDE.md` §Merge-autoritet. Brukt for
PR #96, #98, #87, #99, #100, #101, #102, #103, #104, #106, #107.

## Hvor `main` står nå

- **PR #95/#96(W1)/#98/#87 MERGET** (se tidligere økters detaljer i git-historikk/DECISIONS_AND_ASSUMPTIONS.md).
- **PR #99 (D-194) / #100 (D-195) / #101 (D-196) / #102 (D-197) / #103 (D-198) / #104 (D-199) / #105
  (status-fiks) MERGET** - se forrige økters PROJECT_STATUS-historikk i git-loggen og
  DECISIONS_AND_ASSUMPTIONS.md for detaljer per PR.
- **PR #106 (D-200, `gemma_hosted` fikk ekte SSE-strømming, Q-30 lukket) MERGET** (`8429a55`): Tobias
  observerte live på sin NAS-kjørende instans at web-chatten rutet til Claude i stedet for Gemma
  ("fiks gemma"). Rotårsak: `packages/provider-adapters/src/gemma.ts` hadde ALDRI en `.stream()`-
  metode - routeren kan strukturelt aldri velge en provider uten streaming-capability for `/chat`
  (som alltid krever `[tool_calling, streaming]`). Implementert `GemmaHostedAdapter.stream()` mot
  Geminis `streamGenerateContent?alt=sse` (samme `sseLines()`/`AbortSignal.any()`-mønster som
  `anthropic.ts`/`openai.ts`). Bevisst atferdsforskjell dokumentert: Gemini leverer `functionCall`
  KOMPLETT i én chunk (ingen delta-fase). `capability-registry.ts`: `"streaming"` lagt til
  `gemma_hosted` (uendret for `gemini` selv). 10 tester i `sse-fixtures.test.ts` (5 nye + 5
  eksisterende), 53 eksisterende routing-tester uendret grønne, 349 tester grønt i full
  `packages/provider-adapters modules/model-gateway`-suite. Typecheck/lint rene. Se D-200.
- **PR #107 (D-201, sluttmål-/scope-bekreftelse) MERGET** (`0288c4d`): ren dokumentasjonsendring,
  ingen kodeendring - se D-201 i DECISIONS_AND_ASSUMPTIONS.md for full tekst.
- Begge PR-er hadde et ekte merge-konflikt-punkt mot hverandre i `docs/DECISIONS_AND_ASSUMPTIONS.md`
  (begge satte inn en rad rett etter D-199) - løst med en vanlig to-forelder merge-commit
  (`e988c3c`) på `claude/gemma-hosted-streaming` FØR PR #106 ble merget, ingen historikk omskrevet.

## GJENSTÅENDE ETTER PR #106: NAS-redeploy + live-verifisering

Gemma-strømmingsfiksen (D-200) er merget til `main`, men Tobias sin faktiske kjørende NAS-instans
(UGREEN DXP4800 Plus, `10.0.0.30`) bygger fortsatt fra et ELDRE image - koden der har IKKE fiksen
ennå. Gjenstår (host-handling, kan ikke gjøres fra denne sandboxen):
1. Hente oppdatert `main` til NAS-en (git/pscp-transfer, samme mønster som første deployment).
2. `docker compose --env-file ../../.env build api worker && docker compose --env-file ../../.env up -d`
   (fra `infra/local/`) for å bygge inn D-200-fiksen i imagene.
3. Live-verifisere i web-chatten at Gemma faktisk velges for en strømmet samtale (forvent `rute: model`
   med `gemma_hosted` i loggene, ikke lenger konsekvent Claude/OpenAI).
Ingen egen D-ID for selve redeploy-utfallet ennå - loggføres når Tobias bekrefter resultatet.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET,
dekker resten av masterplanen: AI-leverandørfamilier, Growth-stack live-evidens, reelle
Finance-transaksjoner (Stripe), iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring.
Se `docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

**Google OAuth (Calendar/Drive/Gmail) - pågår i chat parallelt med dette:** Tobias har allerede en
"Jarvis Desktop"-OAuth-klient (riktig type) i Google Cloud-prosjektet `jarvis-505414`. `JARVIS_GOOGLE_
TOKEN` (Calendar/Drive) og `JARVIS_EMAIL_TOKEN` (Gmail, separat credential) er fortsatt tomme -
selvbetjente reauth-script finnes (`modules/core/scripts/google-drive-reauth.ts`/`google-email-
reauth.ts`), anbefalt kjørt lokalt på Tobias sin Windows-PC (ikke på den headless NAS-en) pga.
nettleser-/loopback-redirect-behovet. Ikke fullført ennå ved denne statusoppdateringen.

## Neste oppgave

1. **NAS-redeploy + live-verifisering av D-200** (se eget avsnitt over) - host-handling, venter på Tobias.
2. **Google OAuth-oppsett** (Calendar/Drive/Gmail) - pågår i chat, se eget avsnitt over.
3. **UA-11 Executive Mode "K2":** decision log/scenarios/risk register/OKRs/delegation board (navngitt
   i masterplanen, zero kode, zero ekstern avhengighet - genuint åpen-endt, ingen eksisterende mønster
   å komponere fra). Avklar akseptansekriterier med Tobias før implementering starter.
4. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer.
