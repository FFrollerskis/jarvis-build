# PROJECT STATUS

**Oppdatert:** 2026-09-19 (branch `claude/v1-daily-brief-delivery-idempotency`, fra fersk `origin/main`
HEAD `6960654`). **PR #95/#96 (W1)/#98/#87 er ALLE MERGET.** Aktiv oppgave: **D-194 (V1 Value Track
Telegram-leveringsfiks) - klar for commit/push/PR under D-192.**

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19)

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd. issue #68 BEHOLDES som logg
(`CLAUDE_REPORT` posteres der fortsatt), men oppgave-autoritet kommer nå fra chat. Claude har STÅENDE
FULLMAKT til å merge rutinemessige PR-er selv når CI er grønt/tester består/ingen åpne funn - varsler,
spør ikke. `HARD_EXTERNAL_BLOCKER` (credentials/betaling/fysisk host-handling/juridisk aksept) stopper
fortsatt alltid og varsler Tobias direkte. Se D-192 i DECISIONS_AND_ASSUMPTIONS.md og oppdatert
`CLAUDE.md` §Merge-autoritet. Brukt for PR #96, #98 og #87.

## Hvor `main` står nå

- **PR #95 (B2+B3, D-174→D-179) MERGET.**
- **PR #96 (W1, D-180→D-193) MERGET** - fullt host-bevist (`run_id=28c2059a`, `hard_fail=false`,
  16/16 markører PASS).
- **PR #98 (post-W1-merge status-oppdatering) MERGET.**
- **PR #87 (D-166, cross-worker task-admission-eksklusivitet) MERGET** (`6960654`) - fikset en reell
  race condition i `ops/claude-worker` sin låsemekanisme. KUN `ops/claude-worker/**`, ikke rørt
  Jarvis-produktkoden.
- **D-194 (V1 Value Track-undersøkelse + fiks, denne branchen):** Tobias ba (direkte chat, D-192) om å
  bygge resten av planen sammen uten ChatGPT-arkitekten. Undersøkte "V1 Value Track" (masterplan
  Daily Executive Brief) - `PROJECT_STATUS.md`/D-180/D-181 hevdet "IKKE startet", men
  `modules/tool-gateway/src/daily-brief.ts` (`DailyBrief`-klassen) er FAKTISK fullt bygget og
  produksjonswiret (schedulert i `apps/api/src/main.ts`). Reelt gjenstående gap er kun
  atferdsbevis over ekte dager (`PENDING_EXTERNAL_EVIDENCE`), ikke kode - rapportert eksplisitt til
  Tobias. To kandidat-kodegap undersøkt, Tobias valgte å fikse begge (strukturert spørsmål):
  1. **`DailyBrief` mangler i `worker-main.ts`** - UNDERSØKT, FUNNET IKKE Å VÆRE ET REELT GAP (bevisst
     arkitektur: ALLE `DailyScheduler`-jobber bor kun i `main.ts`, aldri i `worker-main.ts`). Droppet,
     rapportert til Tobias som unødvendig.
  2. **Morgenleverings-callbacken brukte den generiske, ikke-idempotente `sendTelegram`-closuren**
     i stedet for `DailyBrief.deliverViaTelegram()` (som allerede fantes, idempotency-nøklet per
     chunk) - en re-kjørt levering kunne duplisere chunks, og en stille tapt levering ble aldri
     logget. **FIKSET:** byttet til `DailyBrief.deliverViaTelegram(toolGateway, ownerIdentity, brief)`
     + eksplisitt `console.error` ved mislykket levering. 3 nye strukturelle regresjonstester i
     `apps/api/test/drive-runtime-wiring.test.ts` (describe "M"). Typecheck/lint/full testfil grønt
     lokalt. Se D-194 i DECISIONS_AND_ASSUMPTIONS.md for full begrunnelse.

## Blokkeringer

Ingen kjente blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET, dekker
resten av masterplanen: AI-leverandørfamilier, Growth-stack live-evidens, reelle Finance-transaksjoner
(Stripe), iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. Fullfør quality gates (full lokal testsuite/diff-check/secret scan) for D-194-branchen, commit, push,
   åpne draft-PR, vent på CI, merge under D-192 (ingen arkitektonisk usikkerhet - liten, godt testet
   observability-/robusthetsfiks).
2. Etter merge: gå tilbake til Tobias for neste prioritet - enten en samlet oversikt over
   API-nøkler/kontoer/MCP-koblinger som trengs for de gjenstående eksterne blokkeringene (D-170), eller
   videre plan-bygging direkte i chat (D-192).
