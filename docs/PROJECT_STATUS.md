# PROJECT STATUS

**Oppdatert:** 2026-09-20 (branch `claude/d203-chat-sensitivity-default`, fra fersk `origin/main` HEAD
`826519a`, som inkluderer D-200/PR #106, D-201/PR #107, PROJECT_STATUS-refresh/PR #108 og D-202/PR #109
ALLE MERGET). Aktiv kodeoppgave: D-203 (chat-sensitivitetsdefault, se under) - PR ikke opprettet ennå
i denne økten. Google OAuth (Calendar/Drive/Gmail) er FULLFØRT og live-verifisert i denne økten
(utenfor git - credential-oppsett, ikke kode).

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19) - GJELDENDE VIDERE

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd, helt til punktet der videre fremgang
faktisk krever credentials/kontoer/MCP-koblinger - IKKE start ny scope utover masterplanen. issue #68
BEHOLDES som logg. Claude har STÅENDE FULLMAKT til å merge rutinemessige PR-er når CI er grønt/tester
består/ingen åpne funn. **D-201 (2026-09-20)** presiserer sluttmålet EKSPLISITT: hele masterplanen
bygget/fungerende, ALLE eksterne integrasjoner unntatt `Fiken`/`Walley` (permanent ekskludert), en
helt autonom agent, drift på UGREEN-NAS-en + Tobias sin PC (`gemma_local`) som tilleggskraft inntil
dedikert maskin - deretter "plan nr 2". Se D-192/D-201 i DECISIONS_AND_ASSUMPTIONS.md og `CLAUDE.md`
§Merge-autoritet. Brukt for PR #96, #98, #87, #99-#109 (alle rutinemessige denne og forrige økt).

## Hvor `main` står nå

- **PR #95-#105 MERGET** (se tidligere økters PROJECT_STATUS-historikk i git-loggen og
  DECISIONS_AND_ASSUMPTIONS.md for detaljer per PR).
- **PR #106 (D-200, `gemma_hosted` fikk ekte SSE-strømming, Q-30 lukket) MERGET, NAS-redeployet OG
  live-verifisert:** `GemmaHostedAdapter.stream()` implementert mot Geminis
  `streamGenerateContent?alt=sse`. NAS-en (`10.0.0.30`) er rebygget med fiksen (`git archive` +
  `pscp` + `docker compose build api worker && up -d`).
- **PR #107 (D-201, sluttmål-/scope-bekreftelse) MERGET** - ren dokumentasjonsendring.
- **PR #108 (PROJECT_STATUS-refresh etter D-200/D-201) MERGET.**
- **PR #109 (D-202, Langfuse Cloud-routing) MERGET, NAS-redeployet OG live-verifisert:**
  `infra/local/docker-compose.yml` hardkodet `LANGFUSE_BASE_URL` til den selvhostede
  container-adressen for BÅDE `api`/`worker` - `.env` sin Langfuse Cloud-URL ble derfor aldri faktisk
  brukt. Byttet til `${LANGFUSE_BASE_URL:-http://langfuse:3000}` (samme default, nå faktisk
  overstyrbar). NAS-en oppdatert (kun `docker-compose.yml`, ingen rebuild nødvendig - `docker compose
  up -d` alene). Live-bekreftet: `docker exec local-api-1 printenv LANGFUSE_BASE_URL` viste
  `https://cloud.langfuse.com`, og ekte chat-observasjoner dukket opp i Langfuse Cloud (riktignok under
  "Custom instrumentation"/Observations-visningen der, ikke hoved-Traces-fanen, siden
  `LangfuseTraceSink` sender et rått ingestion-batch-kall uten SDK-versjonsheader - en kjent,
  ikke-blokkerende kosmetisk forskjell, IKKE fulgt opp videre denne økten).
- **Live-observasjonene fra D-202-verifiseringen avdekket D-203:** HVER chat-generasjon rutet til
  `openai:gpt-5` med `routing_reason=PRIVACY_RESTRICTED` - D-200s strømmingsfiks virket, men ble ALDRI
  faktisk brukt, fordi `ConversationEngine.handle()` aldri satte `sensitivity` på chat-inputen, og
  D-81s fail-closed-regel ekskluderer `gemma_hosted` (hosted_free_tier) for udefinert sensitivitet.
  Tobias: "simpel default, lav-sensitiv som standard, fiks det." **Levert (denne økten, PR ikke
  opprettet/merget ennå):** `apps/api/src/conversation.ts` setter nå
  `sensitivity: "PUBLIC_OR_LOW_SENSITIVITY"` som ubetinget default for normal chat - BEVISST IKKE for
  Council (`runCouncil()`, uendret, høyere risikoprofil). 3 nye tester i
  `apps/api/test/conversation-d106-overrides.test.ts`. Typecheck/lint rene, relevant testsuite grønn
  (259 tester). Se D-203.

## GJENSTÅENDE: D-203 commit/PR/merge + NAS-redeploy

D-203-koden er skrevet og testet i denne sandboxen, men IKKE ENNÅ commitet/pushet/PR-et/merget (økten
ble avbrutt av brukerens siste instruks midt i implementeringen - neste steg i en fremtidig økt eller
resten av DENNE økten: commit → push → draft PR → CI → merge under D-192 → NAS git-hent + restart
(ingen rebuild nødvendig, kun `apps/api`-kildekode - MEN api/worker-imagene bygger FRA kildekoden, så
dette KREVER en rebuild, i motsetning til D-202 sin rene compose-fil-endring) → live-verifisering i
Langfuse Cloud at `gemma_hosted`/`gemma-4-...` faktisk dukker opp som brukt provider for normal chat.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET,
dekker resten av masterplanen: Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

**Google OAuth (Calendar/Drive/Gmail) - FULLFØRT denne økten** (utenfor git, credential-oppsett):
`modules/core/scripts/google-drive-reauth.ts` og `google-email-reauth.ts` kjørt lokalt på Tobias sin
Windows-PC (gjenbrukte eksisterende "Jarvis Desktop"-OAuth-klient i `jarvis-505414`), begge
`=PASS`. `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN`/`_OAUTH_CLIENT_TYPE`/`JARVIS_EMAIL_TOKEN`
overført til NAS-ens `.env` (via nedlastet+redigert+re-opplastet fil - direkte terminal-liming inn i
`nano` viste seg upålitelig i denne PuTTY-økten, IKKE brukt til slutt). Live-verifisert: Jarvis leser
faktiske e-poster i produksjon. Kalender ikke eksplisitt re-testet, men samme credential/kodevei.

## Neste oppgave

1. **Fullføre D-203:** commit + push + draft PR + CI + merge (D-192) + NAS-rebuild + live-verifisering
   i Langfuse at Gemma faktisk velges for normal chat (se eget avsnitt over).
2. **UA-11 Executive Mode "K2":** decision log/scenarios/risk register/OKRs/delegation board (navngitt
   i masterplanen, zero kode, zero ekstern avhengighet - genuint åpen-endt, ingen eksisterende mønster
   å komponere fra). Avklar akseptansekriterier med Tobias før implementering starter.
3. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer (Stripe/Neonomics/
   Google Ads gjenstår fortsatt, se tidligere øktnotater).
