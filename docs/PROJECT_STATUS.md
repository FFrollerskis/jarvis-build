# PROJECT STATUS

**Oppdatert:** 2026-09-18 (branch `tobias/manual-masterplan-b2-b3-control-surface-mutation`, PR #95,
exact base `main=ac5f941724947eef8ee4935087cc58738fb8a828` = PR #94 sin merge-commit). Aktiv oppgave:
**B2+B3 IMPLEMENTERT (D-174), RETTET (D-175, BLOKKER B4; D-176, BLOKKER B5; D-177, BLOKKER B6; D-178,
BLOKKER B7 - uavhengige arkitekt-re-reviews 5250409538/5251073737/5252077633/5252418219), NÅ
HOST-BEVIST (D-179, arkitekt-host-akseptanse-review 5253069695, RESULT=PASS):
SAMLET EIER-KONTROLLOVERFLATE (executive.\* MUTASJONSGJENNOMSLAG OG LESING), FINANS-KILL-SWITCH-
DEKNINGSREPARASJON (Wallester `activate_card`), EIER-VENDT ENHETSTILBAKEKALLING - MÅL-TENANTEN er
`identity.tenant_id`, ALDRI et kaller-oppgitt parameter (D-175 rettet D-174 sin opprinnelige,
feilaktige "tenant_id er et fritt mål-parameter"-antakelse for `revoke_device`) - OG
`executive.get_control_surface_status` (D-176 rettet D-174/D-175 sin feilaktige antakelse om at
`executive` sine handlingsnavn er identiske med `owner_controls` sine for LESING, PLUSS at samme
lesing sine to NØSTEDE `situations`/`finance`-kall også måtte unntas fra lås-gatene; D-177 rettet
D-176 sin HOST-AKSEPTANSE-HARNESS, som brukte den SAMME strukturelt umulige sekvensielle
lås-oppsett-bugen testsuiten allerede var rettet for - BEGGE lås-forutsetningene settes nå direkte
via det durable laget i BÅDE test OG host-script, ALDRI via en sekvensiell `executive.*`-oppsett).**
**D-178 (BLOKKER B7): FØRSTE EKTE Windows-host-kjøring (`run_id=d265a028`) FEILET - enhets-
tilbakekallings-FIKSTUREN/-LESINGEN (seksjon 9/10) skrev/leste RLS-beskyttede `devices`/`sessions`/
`session_grants`-rader UTEN tenant-kontekst under den ekte `jarvis_runtime`-rollen (ALT ANNET i
kjøringen var PASS, inkl. Q-21 og B4/B5/B6). Rettet til å bruke den eksisterende kanoniske
`withTenantTransaction()`-hjelperen for fikstur/lesing - selve `executive.revoke_device`-kallet under
test er UENDRET.** **D-179 (LIVE-BEVIST, docs-only closeout): Tobias sin ekte Windows/Docker/Postgres-
rerun av det D-178-rettede harnesset (`run_id=bfca277d`, `hard_fail=false`, med en tidligere
suksessfull rerun `fc9b99e5` rett før) beviser ALLE markører PASS, inkl. `executive.revoke_device`
(`revoked_grants=1`, tenant bundet til `tenant-personal`) - den EKSAKTE handlingen `d265a028` aldri
nådde. `HOST_ACCEPTANCE_STATUS=PASS`, `INTERNAL_BUILD_BLOCKERS=NONE`, `INTERNAL_BUILD_COMPLETE=true`
(RETTET tilbake fra D-178 sin `false`). `SOVEREIGN_COMPLETE=false` FORBLIR UENDRET.**
PR #94 (D-169 t.o.m. D-173, docs-only closeout av post-K1 re-audit-syklusen) er MERGET til `main`. Denne
PR-en er den DEFINERTE "neste interne slice" (B2+B3) sin faktiske implementasjon - IKKE lenger
docs-only.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Hvor `main` står nå

- **PR #94 MERGET 2026-09-18** (`MERGE_SHA=ac5f941724947eef8ee4935087cc58738fb8a828`, normal
  two-parent merge, parents `22d391d248c3b99f2a3949b2606bfab2d7e7bcb3` (K1-mergen, PR #93) +
  `f0a533102f69d41eaa20fb3262d5431dfd371066` (PR #94-head) - verifisert via `git cat-file -p`).
  Postmerge CI (run `35360915984`): `build-test`/`gitleaks`/`windows-git-auth` alle `success`.
- **K1/B1 sin durable/delte kjernemekanisme forblir `PRODUCTION_VERIFIED`, UENDRET av denne PR-en:**
  `KillSwitch`/`OwnerControls`, `owner_controls.*` (7 handlinger + nå `revoke_device`, se under), B1
  selvgjenoppretting (D-166), audit-vannmerke-korreksjon (D-167).
- **D-174 (DENNE PR-en) lukker kapittel-28 punkt 15 sitt eksponerings-/dekningsgap (D-171→D-173):**
  `executive.*` er nå DEN SAMLEDE eier-vendte mutasjonsoverflaten for kill switch, connector-frys,
  credential-tilbakekalling, finans-nødbryter OG enhetstilbakekalling - se tabellen under. B1-
  selvgjenopprettingsevnen (`get_control_state`/`deactivate_kill_switch`/`restore_credential`) er
  UTVIDET til også å virke via `executive.*` sin egen `tool_id` (fresh arkitektonisk funn under
  implementasjonen, se D-174 §B i DECISIONS_AND_ASSUMPTIONS.md).
- **Finans-kill-switch-dekningshullet (D-173, BLOKKER B3) er FIKSET:** `CardService.activateCard()`
  (`modules/finance/src/card-service.ts`) sjekker nå `finance_kill_switch` (`{ killSwitchGated: true }`,
  var `{}`). `finance_wallester.activate_card` sin `capability_class` rettet `"B"` → `"C"`.
- **Eier-vendt enhetstilbakekalling (D-171 mål 6, tidligere REELT GAP) er LUKKET, RETTET av D-175:**
  `owner_controls.revoke_device` (og `executive.revoke_device`) pakker inn den allerede-eksisterende
  `SessionGrantService.revokeForDeviceOn()`. MÅL-TENANTEN er UBETINGET `identity.tenant_id` (skjemaet
  har INGEN `tenant_id`-felt) - en enhet som KUN finnes i en ANNEN tenant feiler LUKKET
  (`DeviceNotFoundError`), ALDRI et stille `ok:true`/`revoked_grants:0`. Eieren kan fortsatt
  tilbakekalle en ANNEN persons (delegat) enhet, SÅ LENGE den enheten er i eierens EGEN tenant.
- Main komponerer UA-9 Vision + UA-10 Situation Engine + UA-11 Executive Mode + K1 owner-controls i
  `apps/api/src/main.ts` OG `apps/api/src/worker-main.ts`. `worker-main.ts` er BEVISST UENDRET av denne
  PR-en (eksponerer ingen `owner_controls.*`/`executive.*`/`situations.*`-handlinger i det hele tatt).

## Kapittel-28 punkt 15 sine syv mål - status ETTER D-174 (var D-171/D-172/D-173 sin kartlegging)

| Kapittel-28-mål | Kanonisk objekt/primitiv | Nåbar fra `executive.*`? | Status |
|---|---|---|---|
| Connector | `owner_controls.freeze_connector`/`unfreeze_connector` | **JA (D-174)** | Lukket |
| Hele Jarvis-systemet | Global kill switch, `owner_controls.activate/deactivate_kill_switch` | **JA (D-174)** | Lukket |
| Leverandør ("provider") | SAMME som connector + `owner_controls.revoke/restore_credential` | **JA (D-174)** | Lukket |
| Agent | `tool_id: "tasks"`, SAMME `freeze_connector`-mekanikk | **JA (D-174)** | Lukket |
| Finansdomene | `finance.enable_kill_switch`/`disable_kill_switch`/`get_kill_switch` | **JA (D-174)** | Lukket - PLUSS `activateCard()`-dekningsreparasjonen (B3) |
| Enhet ("device") | `owner_controls.revoke_device` (NY, D-174, RETTET D-175) → `SessionGrantService.revokeForDeviceOn()`, mål-tenant = `identity.tenant_id` | **JA (D-174/D-175, NY handling)** | Lukket |
| Autonomi-/situasjonsdomene | `situations.pause_domain`/`resume_domain` | Ja (uendret, K1/UA-10 P1) | Allerede lukket |

**Alle syv mål er nå nåbare fra ÉTT kontrollpanel (`executive.*`) for BÅDE lesing OG mutasjon - OGSÅ
UNDER LÅS (D-176, BLOKKER B5): `executive.get_control_surface_status` selv, PLUSS de to nøstede
`situations.get_pause_state`/`finance.get_kill_switch`-lesingene den komponerer, overlever nå BÅDE
kill-switch-aktiv- og delt-credential-tilbakekalt-gaten - FØR D-176 ble denne samlede lesingen selv
avslått akkurat når eieren mest trengte den.**
`INTERNAL_BUILD_BLOCKERS` fra D-173 var **NONE** (RETTET fra D-173 sin navngitte liste) - **RETTET
IGJEN av D-178/BLOKKER B7:** den FØRSTE ekte host-kjøringen fant at enhets-tilbakekallings-
fikstur/-lesing-koden i host-harnesset selv manglet tenant-kontekst under RLS - `INTERNAL_BUILD_
BLOCKERS` var derfor NAVNGITT PÅ NYTT ("B7 host fixture/readback RLS tenant-context proof"), OG
`INTERNAL_BUILD_COMPLETE=false` (RETTET fra `true`) inntil en FERSK host-kjøring av det D-178-rettede
harnesset beviste fiksen. Produksjonskoden (executive/owner-controls/policy/tool-gateway) var
UPÅVIRKET - B7 var en feil i AKSEPTANSE-SCRIPTETS eget fikstur-/lesekode, ikke i det som ble bygget.
**RETTET TILBAKE (D-179, 2026-09-18, arkitekt-host-akseptanse-review 5253069695, RESULT=PASS):**
Tobias sin ekte host-rerun (`run_id=bfca277d`, `hard_fail=false`, med en suksessfull rerun `fc9b99e5`
rett før) beviser NÅ D-178-fiksen LIVE - `INTERNAL_BUILD_BLOCKERS=NONE`, `INTERNAL_BUILD_COMPLETE=true`.
`SOVEREIGN_COMPLETE=false` FORBLIR UENDRET - de navngitte, eksterne `EXTERNAL_RUNTIME_EVIDENCE_
BLOCKERS` (D-170 sin sjekkliste) er IKKE noe denne PR-en kan eller forsøker å lukke; full
kapittel-28-graduering er FORTSATT ikke fullført, kun DENNE interne B2+B3-slicen.

## Hva denne PR-en (D-174) faktisk endret

Se D-174 i `DECISIONS_AND_ASSUMPTIONS.md` for full begrunnelse. Kort:

1. **B3-fiks:** `CardService.activateCard()` → `{ killSwitchGated: true }`; `finance_wallester.
   activate_card` klasse B→C; 8 nye regresjonstester.
2. **Selvgjenopprettings-gate utvidet:** `gateway.ts`/`policy-gateway.ts` sin
   `OWNER_CONTROLS_SELF_RECOVERY_ACTIONS`-sjekk gjelder nå BÅDE `tool_id === "owner_controls"` OG
   `tool_id === "executive"` - uten dette ville `executive.deactivate_kill_switch`/`restore_credential`
   selv blitt blokkert av den YTRE kill-switch-/credential-revoked-sjekken før de nådde det allerede
   trygge, nøstede `owner_controls`-kallet. **RETTET (D-176, BLOKKER B5):** den opprinnelige `tool_id
   === "..."`-unionen antok FEILAKTIG identiske handlingsnavn på `executive`/`owner_controls` for
   LESING (`get_control_surface_status` ≠ `get_control_state`), OG at kun DISSE to tool_id-ene var
   berørt - `executive.get_control_surface_status` sine to NØSTEDE lesekall (`situations.
   get_pause_state`/`finance.get_kill_switch`) er OGSÅ uavhengig gatet. Ny `isSelfRecoveryAction
   (toolId, action)` (owner-control-store.ts) erstatter unionen med en eksplisitt per-(tool_id,action)-
   mapping for ALLE FIRE tool_id-ene - fortsatt like smalt, INGEN mutasjon lagt til.
3. **`executive.*` nye mutasjoner:** `activate_kill_switch`/`deactivate_kill_switch`/
   `freeze_connector`/`unfreeze_connector`/`revoke_credential`/`restore_credential`/`revoke_device`/
   `enable_finance_kill_switch`/`disable_finance_kill_switch`/`get_finance_kill_switch` - ALLE tynne
   `gateway.execute()`-gjennomslag, INGEN egen logikk/tilstand. `ControlSurfaceStatus` utvidet med
   `finance_kill_switch`.
4. **Device revocation:** `OwnerControlsService.revokeDevice()` (nytt, valgfritt 3. konstruktør-
   argument) pakker inn `SessionGrantService.revokeForDeviceOn()`; ny `owner_controls.revoke_device`.
   **RETTET (D-175, BLOKKER B4):** mål-tenanten er UBETINGET `identity.tenant_id` (skjemaet har INGEN
   `tenant_id`-felt) - en enhet i en ANNEN tenant feiler LUKKET (`DeviceNotFoundError`), ALDRI et
   stille `ok:true`/`revoked_grants:0` som D-174 sin opprinnelige versjon tillot.
5. **`apps/api/src/main.ts`:** `SessionGrantService` hoistet, `OwnerControlsService`-konstruksjonen i
   `additionalTools` utvidet med device-avhengighetene. `worker-main.ts` uendret.
6. **Provider-/agent-målkartlegging (D-171) fresh-bekreftet korrekt** - ingen ny primitiv nødvendig.
7. **Tester:** ny "H"-blokk (`modules/executive/test/service-transport.test.ts`, fullt koblet lokal
   stack) og ny "K"-blokk (`modules/owner-controls/test/owner-control-authority.test.ts`, ekte
   `session_grants`).
8. **Host-akseptanse:** ny `modules/executive/scripts/d174-executive-control-surface-live.ts` +
   `-host-run.ts` + strukturell wiring-test (37 tester, grønn i denne sesjonen - utvidet fra 23 av
   D-175, fra 26 av D-176, fra 31 av D-177, korrigert av D-178/BLOKKER B7). **FØRSTE EKTE
   Windows-host-kjøring (Tobias, `run_id=d265a028`, mot HEAD `f32ffe92850cf46d9cf4922d4d47ee890b7c378f`)
   feilet** (`hard_fail=true`) på seksjon 9/10 (enhets-tilbakekallings-fikstur/-lesing skrev/leste
   `devices`/`sessions`/`session_grants` via en rå `sidePool`/`freshPool`-spørring UTEN
   tenant-kontekst, avslått av `FORCE ROW LEVEL SECURITY` under den ekte `jarvis_runtime`-rollen) -
   ALT ANNET i kjøringen var PASS, inkl. Q-21 og B4/B5/B6/D-176-seksjon-4b. **RETTET (D-178):**
   `seedDeviceGrant()` og seksjon 9/10 sine lesinger bruker nå den EKSISTERENDE kanoniske
   `withTenantTransaction()`-hjelperen (`@jarvis/core`, INGEN ny mekanisme); `adminPool` BEVISST
   IKKE brukt for fikstur/lesing (kun CLEANUP, uendret). Selve `executive.revoke_device`-kallet under
   test er UENDRET. **LIVE-BEVIST (D-179):** Tobias kjørte det D-178-rettede harnesset PÅ NYTT (faktisk
   to ganger - `run_id=fc9b99e5` og den avsluttende `run_id=bfca277d`, BEGGE `hard_fail=false`) - ALLE
   markører PASS, inkl. `executive.revoke_device` (`grants_before=1`, `revoked_grants=1`, tenant
   bundet til `tenant-personal`) og ferskinstans-holdbarhetslesingen (seksjon 10). `HOST_ACCEPTANCE_
   STATUS=PASS` (RETTET fra `REQUIRES_RERUN`).

## Kjent, UENDRET sandkasse-/miljøbegrensning (IKKE en kodefeil, IKKE introdusert av denne PR-en)

DB-bakte testsuiter (embedded Postgres) kan IKKE kjøres LOKALT i DENNE agent-sesjonens sandkasse: den
kjører som root i en container som allerede HAR en OS-bruker "postgres", og `embedded-postgres`-
biblioteket dropper privilegier til DENNE brukeren uten å chowne mkdtemp-mappen (det skjer kun når
`createPostgresUser: true` er satt) - `initdb` får derfor `Permission denied` på en 0700 root-eid
mappe. Dette gjelder IDENTISK for ALLE DB-bakte suiter i HELE repoet (reprodusert/verifisert årsak i
denne sesjonen), ikke noe spesifikt for D-174-endringene. Ikke-DB-avhengige tester (typecheck/lint/
`wallester-transport-wiring.test.ts`/`ranking.test.ts`/de nye `-host-run-wiring.test.ts`) er BEKREFTET
grønne lokalt i denne sesjonen. DB-bakte suiter er fresh-verifisert ved kildekode-lesing mot faktiske
funksjonssignaturer, men det kjørte beviset for dem avhenger av CI (ikke-root runner) - se PR-en sin
egen CI-status før merge.

## Blokkeringer

1. **Merge av DENNE PR-en.** `SELF_APPROVAL=false`; krever en eksplisitt `ARCHITECT_TASK`-melding med
   `ARCHITECT_MERGE_APPROVED=true` i issue #68 (D-120-protokollen) - en PR-review-PASS ALENE (selv
   D-179 sin host-akseptanse-PASS) er IKKE tilstrekkelig autoritet til å merge, kun til denne
   docs-closeouten.
2. **CI på eksakt pushet HEAD** må forbli grønn før noen merge-vurdering (build-test/gitleaks/
   windows-git-auth) - bekreftet grønt på `d8d91fd` (run `35394376138`); ny CI-kjøring trigges av
   DENNE docs-only-pushen.
3. **Host-akseptanse (`d174-executive-control-surface-host-run.ts`) er NÅ `PASS` (D-179):** Tobias sin
   rerun av det D-178-rettede harnesset (`run_id=bfca277d`, `hard_fail=false`) beviste ALLE markører,
   inkl. `executive.revoke_device` - IKKE lenger en blokkering.
4. **`EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS`** (D-170 sin sjekkliste) - UENDRET, ekte eksterne
   graduation-krav, ingen av dem Jarvis-kode Claude kan bygge seg forbi. `SOVEREIGN_COMPLETE=false`
   FORBLIR til disse er lukket - denne PR-en lukker KUN den interne B2+B3-slicen (nå ferdig).

## Neste oppgave

Denne posten er en DOCS-ONLY closeout (INGEN produksjonskode endret) av D-179/arkitekt-host-
akseptanse-review 5253069695 sin PASS. Vent på grønn CI på den nye pushen, deretter en eksplisitt
`ARCHITECT_TASK`-merge-ordre i issue #68 (D-120-protokollen) FØR noen merge-vurdering - IKKE noe
Claude selv kan utløse fra en PR-review alene. Ingen ny masterplan, ingen UGREEN-migrering, ingen ny
kode-slice startet av denne posten. `SOVEREIGN_COMPLETE=false` FORBLIR - full kapittel-28-graduering
er FORTSATT ikke fullført.
