# PROJECT STATUS

**Oppdatert:** 2026-09-17 (branch `tobias/manual-masterplan-ua10-p1-host-acceptance` fra exact
`main=ecb99eaba0ae0cd438a60404f7088efd1021ec31` = PR #86 sin merge-commit). Aktiv oppgave: **UA-10 P1
runtime-gate closeout (D-160 G/H)** - host-akseptanse-harness for `situation-sweep` + én produksjonsbug
funnet live og fikset; arkitekt-review runde 1 på PR #88 (5234145170) rettet. `MERGE_AUTHORIZED=false`, `SELF_APPROVAL=false`, `HOST_ACCEPTANCE_REQUIRED=true`.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Hvor `main` står nå

- **PR #84** merget `a0d9a7b2…` (2026-09-16). **PR #85 (UA-10 P0, 056)** merget `639730c5…` (2026-09-16).
- **PR #83 (UA-9 Vision, 055)** merget `14a12fd1…` (2026-09-17, review 5229954341, post-merge CI grønn).
- **PR #86 (UA-10 P1 aktivering, 057)** merget `ecb99eab…` (2026-09-17, review 5232870566, post-merge CI
  run 35199539252 grønn, lokal main ff-synket).
- Main har nå migrasjonene `054 -> 055_vision -> 056_situations -> 057_situations_activation` og
  komponerer UA-9 Vision-wiring + UA-10 Situation Engine-wiring i `apps/api/src/main.ts`.

## UA-10 P1 runtime-gate - hva som er gjort (denne branchen)

**Harness (samme to-fils-mønster som UA-3/UA-4, ingen ny mekanisme):**
- `modules/situations/scripts/ua10-p1-situation-sweep-host-run.ts` - bootstrap (pnpm install
  --frozen-lockfile -> docker compose up postgres -> build migrate/api/worker -> run migrate (057) ->
  restart api/worker) -> live-script.
- `modules/situations/scripts/ua10-p1-situation-sweep-live.ts` - 18 markører (Q-21, migrasjon 057 etter
  055/056, runtime-init, kontrollflate-credential, open-loop-bro live, sveip healthy, evidens-først
  leveranse, live Telegram-transport, idempotens/replay, eier-autoritet, identitetsforfalskning,
  domene-pause (kjøre-unikt `ua10_acceptance_<runId>` - ALDRI `spend`/`*`), auto-ACT nøyaktig én gang,
  tenant/space-isolasjon, fail-closed scheduler med EKTE `DailyScheduler`, release-stuck-claim,
  eksisterende globale pauser bevart (full rad-snapshot før/etter), cleanup). Produksjonens secret-kjede, kanonisk `telegram.notify`,
  kjøre-unike scheduler-jobbnavn (produksjonens `situation-sweep`-rad røres aldri), full selvopprydding.
- `modules/situations/test/ua10-p1-situation-sweep-host-run-wiring.test.ts` - CI-vakt (19 tester) inkl.
  regresjonsvakter: alle `situations.*`-credential_refs løses av PRODUKSJONENS kjede uten env; ingen
  hardkodet pause/unpause/cleanup mot ekte domener eller `*` (avviser den gamle HEAD-versjonen).

**Container-runtime-kjøring (Linux cloud-container - IKKE Tobias sin Windows/Docker-host):** ekte
PostgreSQL 16.13, ekte `apps/api/src/migrate-main.ts` (57 migrasjoner i rekkefølge, `jarvis_runtime`
non-superuser/non-bypassrls, owner-seed), live-script som runtime-rolle.
- Run 1 `cf8b750d` (main uendret): **`ua10_control_surface_credential=FAIL`** - produksjonsbug:
  `situations.*` brukte oppfunnet `JARVIS_SITUATIONS_INTERNAL_TOKEN` => `credential_unavailable` for hele
  eier-kontrollflaten i drift (pause/policy/kø/release). Sveip/bro/leveranse/replay/scheduler PASS.
- Fiks (minste): `credential_ref = BUSINESS_INTERNAL_CREDENTIAL_REF` i `transport.ts` (samme sentinel
  som alle andre interne verktøy).
- Run 2 `14b04af4` (etter fiks): **16/17 PASS, `hard_fail=false`**, `ua10_notification_live_transport=
  BLOCKED_EXTERNAL` (ingen Telegram-credential i containeren - lokal opptaker, ærlig merket).
  Runtime etter kjøring: 0 rester, owner-seed intakt.
- Review runde 1 (5234145170): akseptansen muterte den GLOBALE `spend`-pausen. Rettet (kun script + vakt,
  ingen motorendring). Run 3 `72aef659` (ny klynge, vitnepause på `spend` sådd før kjøring): 17/18 PASS,
  `hard_fail=false`, notification BLOCKED_EXTERNAL, `ua10_existing_global_pauses_preserved=PASS`,
  vitne-raden byte-identisk etterpå, 0 rester. To NUL-byte-glipp (docs i HEAD `022592e` + fiks-utkast)
  fjernet.

**Repo-gates på denne branchen (etter review-runde 1):** situations 133/133 + wiring-vakt 19/19 +
erasure/situations 2/2 + api-wiring 23/23 = 10 filer / 177 tester grønne; `pnpm -w typecheck` exit 0; `pnpm -w lint` exit 0;
`git diff --check` rent; secret-scan rent.

## Blokkeringer

1. **HARD_EXTERNAL_BLOCKER: host-kjøringen.** UA-10 P1 runtime-gaten kan KUN lukkes av Tobias på
   Windows/Docker-hosten (ingen Docker-daemon/.env/Telegram i cloud-containeren). Kommando fra repo-roten
   (KUN etter ny arkitekt-review av PR #88 sin nye HEAD - ikke før):
   `node --env-file=.env --experimental-transform-types modules/situations/scripts/ua10-p1-situation-sweep-host-run.ts`
   - lim inn HELE output-blokken (kun statusmarkører, ingen secrets). Med Telegram i `.env` sendes ett
   syntetisk INFORM- og ett ACT-varsel til eierens chat.
2. **Merge av fiks-PR-en.** `MERGE_AUTHORIZED=false`; krever uavhengig arkitekt-review mot exact HEAD.
3. **Embedded-Postgres-flake (B.3, port-kontensjon)** er fortsatt kjent i repo-suiten (uendret).

## Neste oppgave

Arkitekt-review + merge av fiks-PR-en, deretter Tobias sin host-kjøring (RUNTIME_GATES-rad ->
VERIFIED/COMPLETE med host-run_id). Så **UA-11 Executive Mode P0** (ikke startet).
