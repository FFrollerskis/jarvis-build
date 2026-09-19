# PROJECT STATUS

**Oppdatert:** 2026-09-19 (branch `claude/v3-drain-loop-error-logging`, fra fersk `origin/main`
HEAD `6a78c8d0`). **PR #95/#96 (W1)/#98/#87/#99 (D-194)/#100 (D-195) er ALLE MERGET.** Aktiv oppgave:
**D-196 (V3 Builder Loop-revisjon: drain-løkke-feillogging-fiks) - klar for commit/push/PR under
D-192.**

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19) - GJELDENDE VIDERE

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd. issue #68 BEHOLDES som logg
(`CLAUDE_REPORT` posteres der fortsatt), men oppgave-autoritet kommer nå fra chat. Claude har STÅENDE
FULLMAKT til å merge rutinemessige PR-er selv når CI er grønt/tester består/ingen åpne funn - varsler,
spør ikke. Se D-192 i DECISIONS_AND_ASSUMPTIONS.md og `CLAUDE.md` §Merge-autoritet. Brukt for PR #96,
#98, #87, #99 og #100.

**Presisering (samme økt, etter D-194):** bygg ALT som gjenstår i masterplanen som er kodbart NÅ
(ingen nye eksterne credentials nødvendig), helt til punktet der videre fremgang faktisk krever
credentials/kontoer/MCP-koblinger - IKKE start ny scope utover masterplanen. Full gap-revisjon kjørt
(D-195); Value Track V2-V5-revisjon kjørt (D-196, samme mønster som D-194 for V1).

## Hvor `main` står nå

- **PR #95/#96(W1)/#98/#87 MERGET** (se forrige økters detaljer i git-historikk/DECISIONS_AND_ASSUMPTIONS.md).
- **PR #99 (D-194, V1 Value Track Telegram-leveringsfiks) MERGET** (`569f39f`).
- **PR #100 (D-195, UA-10 infra-slice: incidents-broen) MERGET** (`6a78c8d0`) - `situations` broer nå
  også fra `modules/incidents` (UA-5), ikke bare `business`. Home/location/vision-broene forblir
  bevisst deferred (ingen live signalkilde ennå).
- **D-196 (Value Track V2-V5-revisjon, DENNE BRANCHEN, IKKE PUSHET ENNÅ):** samme "gap-revisjon +
  fiks reelle funn"-mønster som D-194 brukte for V1, nå kjørt for V2 (Unified Follow-up), V3 (Jarvis
  Builder Loop), V4 (Business Operating Loop), V5 (Autonomous Operations). Konklusjon:
  - **V5 (auto-ACT/situasjons-leveranse):** allerede det mest herdede kodesporet i repoet - INGEN funn.
  - **V2/V4:** reelle, men IKKE-bug-formede gap - `business.get_business_brief` og den "unifiserte"
    cross-channel-visningen er begge pull-only (ingen scheduler-push). Krever en EKSPLISITT
    designbeslutning (klokkeslett/kanal/dedup mot situasjons-strømmen) - IKKE fikset denne runden,
    flagget som kandidat for neste prioritering.
  - **V3 (Jarvis Builder Loop): ETT KONKRET, REELT funn - FIKSET.** `apps/api/src/main.ts` sin
    `worker.drain()`-pollingsløkke svelget feil stille (`.catch(() => undefined)`) mens
    `worker-main.ts` sin byte-for-byte identiske løkke allerede logget dem strukturert. Kopiert inn
    samme loggingsmønster (`drain_error`), `.unref()` beholdt uendret. 2 nye strukturelle
    regresjonstester i `drive-runtime-wiring.test.ts` (describe "N"). Se D-196 for full begrunnelse.

## Blokkeringer

Ingen kjente blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET, dekker
resten av masterplanen: AI-leverandørfamilier, Growth-stack live-evidens, reelle Finance-transaksjoner
(Stripe), iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. Fullfør quality gates for D-196-branchen, commit, push, åpne draft-PR, vent på CI, merge under D-192.
2. Videre kodbart masterplan-arbeid (samme "fullfør planen til credential-grensen"-oppdrag):
   - Legg frem for Tobias (designbeslutning, ikke stille avgjøre selv): skal V4s daglige/ukentlige
     `business.get_business_brief` og/eller V2s cross-channel-attention-visning få en schedulert
     push-levering (samme DailyScheduler+deliverViaTelegram-mønster som V1)? Hvis ja: klokkeslett,
     kanal, og forhold til den allerede eksisterende situasjons-baserte leveransen må avklares først.
   - UA-11 Executive Mode "K2": decision log/scenarios/risk register/OKRs/delegation board (navngitt
     i masterplanen, zero kode, zero ekstern avhengighet).
   - Executive dashboard-UI (backend `executive.*` er host-bevist ferdig; `apps/web` er fortsatt
     fase-3 chat-MVP).
   - `docs/RUNTIME_GATES.md` doc-gap-lukking for UA-7/UA-8/UA-9 (Q-35).
3. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer.
