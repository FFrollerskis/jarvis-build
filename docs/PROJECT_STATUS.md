# PROJECT STATUS

**Oppdatert:** 2026-09-19 (branch `claude/ua11-executive-dashboard-readonly`, fra fersk `origin/main`
HEAD `7c1bdc7`, som inkluderer D-198/PR #103 MERGET). **PR #95/#96(W1)/#98/#87/#99(D-194)/#100(D-195)/
#101(D-196)/#102(D-197)/#103(D-198) er ALLE MERGET.** Aktiv oppgave: **D-199 (UA-11 Executive
dashboard-UI, lese-delen) - klar for push/PR under D-192.**

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19) - GJELDENDE VIDERE

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd, helt til punktet der videre fremgang
faktisk krever credentials/kontoer/MCP-koblinger - IKKE start ny scope utover masterplanen. issue #68
BEHOLDES som logg. Claude har STÅENDE FULLMAKT til å merge rutinemessige PR-er når CI er grønt/tester
består/ingen åpne funn. **D-198 og D-199 eksplisitt delegert av Tobias** - D-198s designbeslutning
("din call, fortsett med det du mener er riktig") og D-199s prioriteringsrekkefølge ("Begge, din
prioriterte rekkefølge" - dashboard-UI FØR UA-11 K2) avgjort/utført av Claude selv. Se D-192 i
DECISIONS_AND_ASSUMPTIONS.md og `CLAUDE.md` §Merge-autoritet. Brukt for PR #96, #98, #87, #99, #100,
#101, #102, #103 og kommende D-199-PR.

## Hvor `main` står nå

- **PR #95/#96(W1)/#98/#87 MERGET** (se tidligere økters detaljer i git-historikk/DECISIONS_AND_ASSUMPTIONS.md).
- **PR #99 (D-194, V1 Value Track Telegram-leveringsfiks) MERGET** (`569f39f`).
- **PR #100 (D-195, UA-10 infra-slice: incidents-broen) MERGET** (`6a78c8d0`).
- **PR #101 (D-196, V3 Builder Loop: main.ts drain-løkke-feillogging-fiks) MERGET** (`a794d66d`).
- **PR #102 (D-197, RUNTIME_GATES.md UA-7/UA-8/UA-9-dokumentasjonshull lukket) MERGET** (`f5b5f346`).
- **PR #103 (D-198, V4 Business Operating Loop: ukentlig business-brief-push) MERGET** (`7c1bdc7`):
  `business.get_business_brief` (D-53) var ALDRI schedulert/pushet - kun on-demand. Bygget KUN den
  ukentlige push-varianten (mandag kl. 07 default, `DailyScheduler`), BEVISST IKKE en daglig push
  (ville duplisert `situations`-broens allerede eksisterende sanntidsvarsling av de samme individuelle
  hendelsene) og BEVISST IKKE V2s cross-channel-visning (samme overlapp-begrunnelse). Ekstraherte
  `DailyBrief.deliverViaTelegram()` sin chunket/idempotente Telegram-leverings-mekanisme til en delt
  `deliverChunkedTextViaTelegram()` FØR den fikk en andre bruker. 16 nye tester. Se D-198.
- **D-199 (UA-11 Executive dashboard-UI, lese-delen, branch `claude/ua11-executive-dashboard-readonly`,
  commit `6f2d695`, IKKE PUSHET ENNÅ):** `modules/executive` sitt fullt bygde 17-handlings
  `executive.*` ToolGateway-namespace hadde INGEN HTTP-rute/UI. Bygget KUN de to lese-handlingene
  (`get_attention_queue`, `get_control_surface_status`) via ny `POST /executive/query` (hardkodet
  allowlist, samme grant-autoritet som `/chat`/`/brief`) + ny `GET /dashboard`
  (`apps/web/dashboard.html`, samme enhetsnøkkel-/grant-flyt som `apps/web/index.html`). De 15
  mutasjonshandlingene (pause/resume/kill-switch/revoke osv.) forblir BEVISST utenfor allowlistet -
  egen, senere slice. 16 nye tester (10 e2e - ekte HTTP/Postgres, ikke kjørt lokalt pga.
  sandbox-`initdb`-begrensning, verifiseres av CI; 6 DB-uavhengig strukturell wiring-vakt, kjørt og
  grønt lokalt, 6/6). Se D-199.

**MERK (selvkorrigert denne økten):** D-199-arbeidet ble først ved en feil committet på toppen av den
allerede D-198-PR-mergede `claude/v4-weekly-business-brief-push`-branchen (PR #103 hadde allerede
merget da nye commits ble lagt oppå den samme lokale branchen). Oppdaget og rettet FØR push til feil
sted forårsaket skade: D-199-commiten ble cherry-picket over på en FERSK branch fra oppdatert
`origin/main` (`claude/ua11-executive-dashboard-readonly`), samme mønster CLAUDE.md foreskriver for en
allerede-merget branch. `claude/v4-weekly-business-brief-push` (nå med tre commits utover den mergede
PR #103, aldri brukt av noen åpen PR) er forlatt uten videre bruk - INGEN destruktiv handling utført
(ingen branch slettet/force-pushet).

## Blokkeringer

Ingen kjente blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET, dekker
resten av masterplanen: AI-leverandørfamilier, Growth-stack live-evidens, reelle Finance-transaksjoner
(Stripe), iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. Push `claude/ua11-executive-dashboard-readonly`, åpne draft-PR for D-199, vent på CI, merge under
   D-192.
2. Videre kodbart masterplan-arbeid (samme "fullfør planen til credential-grensen"-oppdrag):
   - UA-11 Executive Mode "K2": decision log/scenarios/risk register/OKRs/delegation board (navngitt
     i masterplanen, zero kode, zero ekstern avhengighet - ingen eksisterende kanonisk kilde å
     komponere fra, krever ny datamodell fra bunnen).
3. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer.
