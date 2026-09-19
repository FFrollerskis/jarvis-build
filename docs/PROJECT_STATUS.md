# PROJECT STATUS

**Oppdatert:** 2026-09-19 (branch `claude/w1-watchdog-runtime-durability`, ny PR følger, exact base
`main=9ede3ac1d2e32e708d38104e7a6869772774d628` = PR #95 sin merge-commit). Aktiv oppgave:
**W1 (D-180) IMPLEMENTERT - Watchdog produksjons-wiring + durabel kostnadseksplosjon-nødstopp + reell
Telegram-varsling (arkitekt-order `D183-W1-WATCHDOG-RUNTIME-DURABILITY-20260919-A` på issue #68, som
selv bygger på D182 sin read-only rekonstruksjon av et `REAL_INTERNAL_GAP` D181 ikke fanget opp).**

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Hvor `main` står nå

- **PR #95 (B2+B3, D-174→D-179) er MERGET** (`MERGE_SHA=9ede3ac1d2e32e708d38104e7a6869772774d628`,
  normal two-parent merge). `executive.*` er DEN SAMLEDE eier-vendte kontrolloverflaten (kill switch,
  connector-frys, credential-tilbakekalling, finans-nødbryter, enhetstilbakekalling) - se D-174→D-179 i
  `DECISIONS_AND_ASSUMPTIONS.md` for full historikk. `HOST_ACCEPTANCE_STATUS=PASS` for DEN flaten.
- **PR #87** (`claude/d166-cross-worker-task-admission`) forblir ÅPEN, IKKE rørt av denne posten
  (D183 forbød det eksplisitt) - `mergeable=CONFLICTING` mot naværende main (41 commits bak/4 foran),
  klassifisert `STALE_OR_SUPERSEDED` av D181. Defekten den beskriver (worker-eksklusivitet er fortsatt
  per lock-FIL, ikke per TASK_ID på tvers av deployments) er ekte og ulukket, men IKKE en kapittel-28-
  graduation-blokkering - se D181 sin CLAUDE_REPORT (issue #68, comment `5737478988`) for full analyse.
- **D181 (post-PR95 gap-rekonstruksjon):** fant `INTERNAL_BUILD_COMPLETE=false` pga. Value Track-
  måling (kapittel-28 DoD punkt 2, andre ledd) som mangler HELT - valgt neste slice `V1`, IKKE startet
  av denne posten (D183 forbød eksplisitt Value Track-arbeid i DENNE TASK_ID).
- **D182 (watchdog-rekonstruksjon):** fant, uavhengig av D181, et ANNET `REAL_INTERNAL_GAP`:
  `@jarvis/watchdog` var HELT null-koblet til produksjon, OG `costExplosionCheck` sin nødstopp brukte
  en ikke-durabel `killSwitch.activate()`-form som ville vært et stille no-op mot produksjonens
  faktiske `PolicyGateway.isActiveDurable()`-håndheving.
- **D183/D-180 (DENNE POSTEN) implementerer W1** - retter BEGGE D182-funnene. Se full begrunnelse i
  `DECISIONS_AND_ASSUMPTIONS.md` D-180.

## Hva denne PR-en (W1/D-180) faktisk endret

1. **`modules/watchdog/src/watchdog.ts`:**
   - `costExplosionCheck(pool, killSwitch, ownerPersonId, hardLimitOre)` - nytt, PÅKREVD
     `ownerPersonId`-parameter (ingen default). Kaller nå `await killSwitch.activateDurable(reason,
     ownerPersonId)` (ALDRI den bare `.activate()`-formen), og guard mot gjentatt aktivering bruker
     `await killSwitch.isActiveDurable()` (den autoritative, delte tilstanden).
   - `TelegramAlertSink` (den ubetinget-kastende stubben) ERSTATTET av `GatewayAlertSink(gateway,
     identity)` - sender via DEN SAMME kanoniske `ToolGateway.execute({tool_id:"telegram",
     action:"notify"})`-stien som `DailyBrief.deliverViaTelegram()` allerede bruker. Ingen ny
     Telegram-credential-mekanisme, ingen rå bot-token i watchdog-koden.
   - `Watchdog.tick()`: varslings-/handlingsfeil logges nå ALLTID (`console.error`), ALDRI stille
     svelget; en `ticking`-vaktflagg forhindrer overlappende samtidige `tick()`-kjøringer (droppet
     overlapp logges eksplisitt via `console.warn`, returnerer `[]`).
2. **`apps/api/src/worker-main.ts`:** `@jarvis/watchdog` wiret inn - én `Watchdog`-instans konstruert
   ETTER `assertRuntimeRoleSafe(pool)`/`killSwitch.restore()`/`ownerControls.restore()`, FØR
   drenerings-intervall-loopen. Registrerer `databaseCheck`/`stuckTasksCheck`/`costExplosionCheck`
   (SAMME delte, pool-baserte `killSwitch`), kjørt på `JARVIS_WATCHDOG_INTERVAL_MS` (default 60s) via
   `setInterval` - SAMME mønster som den eksisterende `worker.drain()`-loopen. `costExplosionCheck`
   sin `ownerPersonId` er BEVISST `ownerControlAuthority.owner_person_id` (SAMME som resten av filens
   wiring) - IKKE en oppdiktet "system"-identitet (se D-180 §B for FK-/autorisasjonsbegrunnelsen).
   `apps/api/src/main.ts` er BEVISST UENDRET (unngår duplikat watchdog-instans).
3. **`apps/api/package.json`:** `@jarvis/watchdog` lagt til dependencies.
4. **`modules/watchdog/package.json`:** `@jarvis/contracts`/`@jarvis/owner-controls`/`@jarvis/tool-gateway`
   lagt til (ingen sirkulær avhengighet - verifisert).
5. **Tester:** ny `w1-durable-emergency-shutdown.test.ts` (8 caser, embedded Postgres); eksisterende
   `fase10-ops.test.ts` sin kill-switch-test oppgradert til pool-backet `KillSwitch` (DEN eneste måten
   defekten kunne vært fanget); ny `w1-production-wiring.test.ts` (14 caser, ren kildetekst, INGEN DB);
   ny `w1-watchdog-durability-host-run-wiring.test.ts` (21 caser, ren kildetekst, INGEN DB).
6. **Host-akseptanse:** ny `modules/watchdog/scripts/w1-watchdog-durability-live.ts` + `-host-run.ts`
   (samme `section()`/admin-pool-for-scaffold/selvopprydding-mønster som K1/B1 og B2+B3). Se D-180 §E
   i `DECISIONS_AND_ASSUMPTIONS.md` for de 12 bevispunktene. `WATCHDOG_HOST_ACCEPTANCE_REQUIRED=true` -
   IKKE kjørt i denne økten (krever Tobias sin ekte Windows/Docker/Postgres-host).

## Kjent, UENDRET sandkasse-/miljøbegrensning (IKKE en kodefeil, IKKE introdusert av denne PR-en)

DB-bakte testsuiter (embedded Postgres) kan IKKE kjøres LOKALT i DENNE agent-sesjonens sandkasse - SAMME
forhåndseksisterende, dokumenterte begrensning som ALLE andre DB-bakte suiter i repoet (bekreftet
identisk mot `erasure-restore-contract.test.ts`, urørt av denne posten). DB-uavhengige tester (35 nye:
14+21 strukturelle) og fullt arbeidsromsomfattende `typecheck` (30/30 pakker)/`lint` er BEKREFTET grønne
lokalt i denne sesjonen. DB-bakte suiter er fresh-verifisert ved kildekode-lesing mot faktiske
funksjonssignaturer/-semantikk.

## Blokkeringer

1. **Draft PR for denne branchen** må opprettes/oppdateres og kreve fersk exact-HEAD CI grønt
   (build-test/gitleaks/windows-git-auth) FØR noen review-/merge-vurdering.
2. **Host-akseptanse (`w1-watchdog-durability-host-run.ts`) er `NOT_RUN`** - krever Tobias sin ekte
   Windows/Docker/Postgres-host. `INTERNAL_BUILD_COMPLETE` kan IKKE settes `true` for DENNE flaten
   alene før den kjøres (uavhengig av D181 sitt separate Value Track-funn, som allerede holder
   `INTERNAL_BUILD_COMPLETE=false`).
3. **`EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS`** (D-170 sin sjekkliste) - UENDRET, ekte eksterne
   graduation-krav. `SOVEREIGN_COMPLETE=false` FORBLIR.
4. **Ingen merge uten en eksplisitt `ARCHITECT_TASK`-melding med `ARCHITECT_MERGE_APPROVED=true` i
   issue #68** (D-120-protokollen) - `SELF_APPROVAL=false`.

## Neste oppgave

Push branchen, opprett draft PR, vent på grønn CI, rapporter til issue #68. Deretter, i separate,
fremtidige `ARCHITECT_TASK`-ordre: (a) host-akseptanse for W1 (Tobias sin ekte host), (b) V1
Value Track-slicen D181 valgte, (c) en fersk reissue av PR #87 sin cross-worker-admission-fiks mot
naværende main. Ingen ny masterplan, ingen UGREEN-migrering startet av denne posten.
`SOVEREIGN_COMPLETE=false` FORBLIR.
