# PROJECT STATUS

**Oppdatert:** 2026-09-19 (branch `claude/w1-watchdog-runtime-durability`, PR #96 - draft, åpen, CI
grønt på forrige HEAD `631d45a`, ny push følger for B1-fiksen - exact base
`main=9ede3ac1d2e32e708d38104e7a6869772774d628` = PR #95 sin merge-commit). Aktiv oppgave:
**D-181 (BLOKKER B1) - retter et funn fra en UAVHENGIG arkitekt-review av PR #96 (`ARCHITECT_TASK
D184-PR96-W1-B1-EMERGENCY-ALERT-20260919-A` på issue #68): D-180 sin `GatewayAlertSink` rutet
watchdog-ens nødvarsel gjennom den ordinære `ToolGateway.execute(telegram.notify)`-stien - nektet av
`PolicyGateway` med `kill_switch_active` når kill switchen (watchdog-ens EGEN aktivering) er aktiv.
En "nødstopp uten nødvarsel". Erstattet av en dedikert `WatchdogEmergencyAlertSink`.**

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Hvor `main`/PR #96 står nå

- **PR #95 (B2+B3, D-174→D-179) er MERGET til `main`** (`MERGE_SHA=9ede3ac1...`). `executive.*` er
  DEN SAMLEDE eier-vendte kontrolloverflaten - se D-174→D-179 for full historikk.
- **PR #96 (`claude/w1-watchdog-runtime-durability`) er ÅPEN, DRAFT.** Forrige HEAD `631d45a` (D-180,
  W1 implementert) hadde eksakt-HEAD CI GRØNT (`windows-git-auth`/`gitleaks`/`build-test` alle
  `success`, run `35408757916`), `mergeable_state=clean`, ingen åpne review-tråder. En UAVHENGIG
  arkitekt-review (ikke Claude selv - se CLAUDE.md regel 9) fant deretter BLOKKER B1 (over) FØR merge.
  Denne posten (D-181) retter B1 på SAMME branch/PR - ny push/CI følger.
- **PR #87** forblir ÅPEN, IKKE rørt (uendret siden D181/D183/D184 - se forrige økters status for full
  analyse; `mergeable=CONFLICTING` mot naværende main, klassifisert `STALE_OR_SUPERSEDED` av D181).
- **D181 sitt Value Track-funn** (`INTERNAL_BUILD_COMPLETE=false`, valgt neste slice `V1`) er UENDRET
  og IKKE startet av noen post i denne rekken (D183/D184 forbød det eksplisitt).

## Hva D-181 (BLOKKER B1) faktisk endret, OVENPÅ D-180/W1

Se D-181 i `DECISIONS_AND_ASSUMPTIONS.md` for full begrunnelse. Kort:

1. **`modules/watchdog/src/watchdog.ts`:** `GatewayAlertSink` (rutet via `ToolGateway.execute()`)
   ERSTATTET HELT av `WatchdogEmergencyAlertSink` - en smal, dedikert grense (`send(alert)` er
   eneste metode, ingen kaller-kontrollert mål) som BEVISST hopper over
   `ToolGateway.execute()`/`PolicyGateway.authorize()` for KUN watchdog sitt eget nødvarsel, og kaller
   `transport.invoke("notify", {message}, credential)` DIREKTE mot et smalt, lokalt
   `EmergencyAlertTransport`-grensesnitt. `isSelfRecoveryAction()` er BEVISST IKKE utvidet med
   `telegram.notify` (ville svekket kill-switch-semantikken for alle andre kallere).
   `watchdog.ts` trenger nå INGEN avhengighet til `@jarvis/tool-gateway`/`@jarvis/contracts` i
   kildekoden (kun `scripts`/`test`) - mindre avhengighetsgraf enn D-180.
2. **`apps/api/src/worker-main.ts`:** `telegramTransport`/`toolSecretProvider` hoistet til navngitte
   konstanter, injisert BÅDE i den ordinære `telegram`-verktøyregistreringen OG i
   `WatchdogEmergencyAlertSink` - SAMME credential_ref, SAMME mottaker, ingen parallell klient.
3. **Tester:** `w1-durable-emergency-shutdown.test.ts` fikk 7 nye caser (embedded Postgres) som
   beviser BEGGE punktene SAMTIDIG under SAMME aktive kill-switch-tilstand: et ordinært
   `gateway.execute(telegram.notify)` forblir nektet MED `kill_switch_active` (transporten kalles
   ALDRI), MENS `WatchdogEmergencyAlertSink.send()` FAKTISK leverer. `w1-production-wiring.test.ts`
   fikk 5 nye strukturelle caser (kildetekst, ingen DB). Host-live-scriptet fikk en ny seksjon "2b".
4. **DB-bakte suiter kunne IKKE kjøres lokalt** (samme forhåndseksisterende sandkasse-begrensning som
   hele denne økten) - fresh-verifisert ved kildekode-lesing. Strukturelle tester (44/44),
   arbeidsromsomfattende `typecheck` (30/30) og `lint` er BEKREFTET grønne lokalt.

## Blokkeringer

1. **Push B1-fiksen til PR #96, vent på fersk exact-HEAD CI grønt** FØR noen ny review-/merge-vurdering.
2. **Host-akseptanse (`w1-watchdog-durability-host-run.ts`) er FORTSATT `NOT_RUN`** - krever Tobias sin
   ekte Windows/Docker/Postgres-host. `INTERNAL_BUILD_COMPLETE` forblir `false` til den kjøres (og
   uavhengig av D181 sitt separate Value Track-funn).
3. **`EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS`** (D-170) - UENDRET. `SOVEREIGN_COMPLETE=false` FORBLIR.
4. **Ingen merge uten en eksplisitt `ARCHITECT_TASK`-melding med `ARCHITECT_MERGE_APPROVED=true` i
   issue #68** - `SELF_APPROVAL=false`.

## Neste oppgave

Push B1-fiksen (D-181) til `claude/w1-watchdog-runtime-durability`/PR #96, vent på grønn CI, rapporter
til issue #68. Deretter, i separate, fremtidige `ARCHITECT_TASK`-ordre: (a) en NY uavhengig
arkitekt-review av den rettede PR-en, (b) host-akseptanse for W1, (c) V1 Value Track-slicen, (d) en
fersk reissue av PR #87. Ingen ny masterplan, ingen UGREEN-migrering. `SOVEREIGN_COMPLETE=false`
FORBLIR.
