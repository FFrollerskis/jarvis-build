# PROJECT STATUS

**Oppdatert:** 2026-09-17 (branch `tobias/manual-masterplan-ua10-p1-runtime-gate-closeout` fra exact
`main=e34cb8a92764e0274a74afcdc7798b495822c821` = PR #89 sin merge-commit). Aktiv oppgave: **UA-10 P1
runtime-gate closeout (D-161) - KUN dokumentasjon.** UA-10 P1 Situation Engine er **PRODUCTION_VERIFIED**
på ekte Windows/Docker-host (run_id `0562c48a`, 18/18 PASS, `hard_fail=false`, `blocked_external=0`).
`MERGE_AUTHORIZED=false`, `SELF_APPROVAL=false`, `PRODUCTION_CODE_CHANGED=false`, `TEST_CODE_CHANGED=false`.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Hvor `main` står nå

- **PR #83 (UA-9 Vision, 055)** merget `14a12fd1…`; **PR #86 (UA-10 P1 aktivering, 057)** merget `ecb99eab…`;
  **PR #88 (kontrollflate-credential-fiks + host-harness, D-160 G/H)** merget `fadad73e…` (alle 2026-09-17).
- **PR #89 (to harness-feil fra host run `2105bb7d`, D-160 I)** merget `e34cb8a9…` (2026-09-17, review
  5235894421, post-merge CI run 35224750489 grønn, lokal main ff-synket).
- Main har migrasjonene `054 -> 055_vision -> 056_situations -> 057_situations_activation` og komponerer
  UA-9 Vision-wiring + UA-10 Situation Engine-wiring (`situation-sweep`) i `apps/api/src/main.ts`.

## UA-10 P1 runtime-gate - LUKKET (D-161)

**Host-kjøring 2 (Tobias, Windows/Docker, main `e34cb8a9`, run_id `0562c48a`):** 18/18 markører PASS,
`hard_fail=false`, `blocked_external=0`. Live-evidens: `jarvis_runtime` non-superuser/non-bypassrls;
055/056/057 i rekkefølge uten kollisjoner; Telegram `LIVE_TRANSPORT` med ekte INFORM (1 forsøk, 1 suksess,
`tool_executions` succeeded + external_id, `pending=0`) og ekte ACT (`read_state,assign,read_state`,
`stage=act_notify`, `act_notify_calls=1`); replay 0 nye sends, krasj-rekonsiliering fra evidens;
healthy scheduler `completed_at` satt, mismatch `completed_at=NULL`; globale pauser identiske (ingen);
cleanup 0 rester, produksjonens `situation-sweep`-rad urørt.

**Migrasjonsobservasjon (ikke blocker):** historisk orphan `023_zendesk_support.sql` (ikke-merget branch,
2026-08-18) rapportert eksplisitt; migratoren nøkler på eksakt filnavn, 055/056/057 korrekte,
`repo_prefix_collisions=(ingen)`, `required_prefix_collisions=(ingen)`.

**Historisk spor (bevares):** host-kjøring 1 `2105bb7d` (main `fadad73e`) FEILET 11/18 på to harness-feil
(D-160 I: for bred migrasjonspåstand + `CountingTransport` som droppet credential foran
`TelegramTransport`), fikset i PR #89. Før det: produksjonsbug i kontrollflatens `credential_ref` (D-160 G,
PR #88) og review-funn om global `spend`-pause (D-160 H).

**Denne branchen endrer KUN docs:** `RUNTIME_GATES.md` (UA-10 P1-rad -> PRODUCTION_VERIFIED),
`DECISIONS_AND_ASSUMPTIONS.md` (ny D-161), `IMPLEMENTATION_PLAN.md` (UA-10 P1 host-status),
`UA10_SITUATION_ENGINE_DESIGN.md` (statuslinje), denne filen. Ingen produksjonskode, tester eller harness.

## Blokkeringer

1. **Merge av denne docs-PR-en.** `MERGE_AUTHORIZED=false`; krever arkitekt-review mot exact HEAD.
2. **Embedded-Postgres-flake (B.3, port-kontensjon)** er fortsatt kjent i repo-suiten (uendret).

## Neste oppgave

**UA-11 Executive Mode P0** (attention-ranking + samlet kontrollflate som komponerer `situations`-verktøyet)
er neste Sovereign-arbeid - **ikke startet**. Sovereign som helhet er **FORTSATT IKKE komplett** (UA-11
gjenstår; UA-0..UA-9 sine kjente credential-/host-blokkerte rester per D-108 er uendret). Ingen ny
masterplan, ingen UGREEN-migrering.
