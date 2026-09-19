# PROJECT STATUS

**Oppdatert:** 2026-09-19 (branch `claude/ua10-infra-incident-bridge`, fra fersk `origin/main`
HEAD `569f39f`). **PR #95/#96 (W1)/#98/#87/#99 (D-194) er ALLE MERGET.** Aktiv oppgave: **D-195
(UA-10 infra-slice: incidents-broen) - klar for commit/push/PR under D-192.**

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19) - GJELDENDE VIDERE

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd. issue #68 BEHOLDES som logg
(`CLAUDE_REPORT` posteres der fortsatt), men oppgave-autoritet kommer nå fra chat. Claude har STÅENDE
FULLMAKT til å merge rutinemessige PR-er selv når CI er grønt/tester består/ingen åpne funn - varsler,
spør ikke. `HARD_EXTERNAL_BLOCKER` (credentials/betaling/fysisk host-handling/juridisk aksept) stopper
fortsatt alltid og varsler Tobias direkte. Se D-192 i DECISIONS_AND_ASSUMPTIONS.md og oppdatert
`CLAUDE.md` §Merge-autoritet. Brukt for PR #96, #98, #87 og #99.

**Presisering fra Tobias (samme økt, etter D-194):** bygg ALT som gjenstår i masterplanen som er
kodbart NÅ (ingen nye eksterne credentials nødvendig), helt til punktet der videre fremgang faktisk
krever credentials/kontoer/MCP-koblinger - IKKE start ny scope utover masterplanen. Full
gap-revisjon kjørt (research-agent, kildekode-kryssjekket) - se D-195 for detaljer og prioritert
liste over gjenstående kodbart arbeid.

## Hvor `main` står nå

- **PR #95 (B2+B3, D-174→D-179) MERGET.**
- **PR #96 (W1, D-180→D-193) MERGET** - fullt host-bevist (`run_id=28c2059a`, `hard_fail=false`,
  16/16 markører PASS).
- **PR #98 (post-W1-merge status-oppdatering) MERGET.**
- **PR #87 (D-166, cross-worker task-admission-eksklusivitet) MERGET** - fikset en reell race
  condition i `ops/claude-worker` sin låsemekanisme. KUN `ops/claude-worker/**`.
- **PR #99 (D-194, V1 Value Track Telegram-leveringsfiks) MERGET** (`569f39f`) - morgenleverings-
  callbacken bruker nå `DailyBrief.deliverViaTelegram()` (idempotency-nøklet), ikke den generiske
  `sendTelegram`-closuren. Se D-194.
- **D-195 (UA-10 infra-slice: incidents-broen, DENNE BRANCHEN, IKKE PUSHET ENNÅ):** full
  masterplan-gap-revisjon identifiserte situasjons-motor-broer fra `health`/`location`/`vision`/
  `incidents` som mest konkrete gjenstående kodbare arbeid (UA-10 design-notatets §5 utsatte disse
  BEVISST til "en EGEN slice PER domene NÅR en faktisk signalkilde finnes" - `modules/incidents`
  (UA-5) er nå den kilden for infra). Levert: `infra-incident-bridge.ts` (ren bro, samme mønster som
  `open-loop-bridge.ts`), ny generalisert `SituationEngine.resolveStaleForDomain()`, `sweep.ts` sitt
  FRIVILLIGE `incidents?: IncidentReader`-felt (fravær = uendret oppførsel), wiring av eksisterende
  `incidentService` i `main.ts`. ZERO migrasjon. 18 nye tester grønne lokalt (15 rene enhetsbevis +
  3 strukturell wiring-vakt). Typecheck/lint/diff-check rene. Se D-195 for full begrunnelse.
  Home/location/vision-broene er FORTSATT ugjort (egne, senere slicer - vision/health/location har
  fake-source, ikke live data ennå uansett).

## Blokkeringer

Ingen kjente blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET, dekker
resten av masterplanen: AI-leverandørfamilier, Growth-stack live-evidens, reelle Finance-transaksjoner
(Stripe), iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. Fullfør quality gates for D-195-branchen (full lokal testsuite så langt sandbox tillater/
   diff-check/secret scan), commit, push, åpne draft-PR, vent på CI, merge under D-192.
2. Videre kodbart masterplan-arbeid (samme "fullfør planen til credential-grensen"-oppdrag), i
   prioritert rekkefølge fra D-195-gap-revisjonen:
   - Value Track V2-V5 wiring-audit (samme mønster som D-194 fant for V1 - verifiser resten faktisk
     er korrekt koblet, fiks reelle gap).
   - UA-11 Executive Mode "K2": decision log/scenarios/risk register/OKRs/delegation board (navngitt
     i masterplanen, zero kode, zero ekstern avhengighet).
   - Executive dashboard-UI (backend `executive.*` er host-bevist ferdig; `apps/web` er fortsatt
     fase-3 chat-MVP).
   - `docs/RUNTIME_GATES.md` doc-gap-lukking for UA-7/UA-8/UA-9 (Q-35).
   - (Lavere prioritet/IKKE anbefalt uten et konkret behov, per masterplanens egen
     connector-factory-doktrine): flere Growth-/Communications-Hub-kanaladaptere - disse ville uansett
     være død kode uten leverandør-credentials.
3. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer.
