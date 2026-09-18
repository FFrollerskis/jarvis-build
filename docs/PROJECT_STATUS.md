# PROJECT STATUS

**Oppdatert:** 2026-09-18 (branch `tobias/manual-masterplan-post-k1-sovereign-reaudit`, PR #94, exact
base `main=22d391d248c3b99f2a3949b2606bfab2d7e7bcb3` = PR #93/K1 sin merge-commit). Aktiv oppgave:
**POST-K1 SOVEREIGN RE-AUDIT + DOCS CLOSEOUT (D-169), RETTET AV UAVHENGIG ARKITEKT-REVIEW TRE GANGER
(D-170, DERETTER D-171/BLOKKER B2, DERETTER D-172 SIN FINANSDOMENE-KORREKSJON).** K1 sin durable/delte
kjernemekanisme (kill switch, connector-frys, credential-tilbakekalling/-gjenoppretting) er FERDIG,
host-bevist, MERGET (D-164 t.o.m. D-168) - DETTE er UENDRET av D-171/D-172. D-171 fant at kapittel-28
punkt 15 ("eier kan fra ÉTT kontrollpanel pause/revoke connector/enhet/leverandør/agent/finansdomene/
HELE Jarvis") var OVERCLAIMED: `executive.*` samler i dag LESING (status) av kontrolloverflaten, men
IKKE MUTASJON. **D-172 rettet D-171 sin finansdomene-kartlegging:** en fersk dekningsaudit fant at
`finance.enable_kill_switch`/`disable_kill_switch`/`get_kill_switch` (tenant-skopet `finance_kill_switch`,
allerede sjekket av Fiken-/Stripe-/Vipps-utbetalingsstien OG Wallester-kort-spend-limit-mutasjoner)
ALLEREDE finnes - "finansdomene" er derfor SAMME gap-type som connector/provider/agent (rent
eksponeringsgap), IKKE en manglende primitiv som D-171 påsto.
**Status er NÅ (D-172, siste for denne PR-en):** `INTERNAL_BUILD_BLOCKERS=<navngitt B2-gap, enhet er nå
det ENESTE reelle manglende-primitiv-punktet>` (RETTET fra D-169/D-170 sin `NONE`),
`INTERNAL_BUILD_COMPLETE=false` (RETTET fra `true`, FORBLIR `false` uendret av D-172), `SOVEREIGN_COMPLETE=false`
(uendret, allerede korrekt i D-170). Denne runden (PR #94) FORBLIR docs-only closeout av
re-audit-syklusen + next-slice-definisjon - IKKE implementasjon av B2 selv (det er neste PR).
`SELF_APPROVAL=false`, `MERGED=false` for DENNE PR-en.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Hvor `main` står nå

- **PR #93 (K1) MERGET 2026-09-18** (`MERGE_SHA=22d391d248c3b99f2a3949b2606bfab2d7e7bcb3`, normal
  two-parent merge, parents `34c9c474a478cb7aab7858284ec0606eab51c128` (gammel `main`) +
  `9fcf1a3d3aa1b0d39f0311dc7be6f07150831a25` (PR-head) - verifisert via `git cat-file -p`). Postmerge
  CI (run `35340723640`): `build-test`/`gitleaks`/`windows-git-auth` alle `success`.
- **K1 sin kjernemekanisme er `PRODUCTION_VERIFIED` NÅR KALT VIA `owner_controls.*` DIREKTE:**
  durable/delt `KillSwitch`/`OwnerControls`, kanonisk `owner_controls.*` ToolGateway-namespace (7
  handlinger: `get_control_state`/`activate_kill_switch`/`deactivate_kill_switch`/`freeze_connector`/
  `unfreeze_connector`/`revoke_credential`/`restore_credential`), `executive.get_control_surface_status`
  (READ-ONLY komposisjon). B1-selv-lås-bug fikset (D-166); harnessets EGEN audit-bevis-determinisme-bug
  fikset (D-167); Tobias sin ANDRE host-rerun (uavhengig arkitekt-review `5247323973`, RESULT=PASS)
  bekreftet ALLE K1-markører PASS (D-168). **MEN (D-171/B2):** dette er IKKE det samme som "ett
  kontrollpanel for MUTASJON av alle syv kapittel-28-mål" - se under.
- **Finans-modulet har sin EGEN, allerede-eksisterende domene-kill-switch (D-172):**
  `finance.enable_kill_switch`/`disable_kill_switch`/`get_kill_switch` (klasse D, `finance_kill_switch`
  tenant-skopet, migrasjon 038) - separat fra K1 sin `owner_controls`-kill-switch, men SAMME gap-type
  (eksponering fra `executive.*` mangler, primitiven selv finnes).
- Main komponerer UA-9 Vision + UA-10 Situation Engine + UA-11 Executive Mode + K1 owner-controls i
  `apps/api/src/main.ts` OG `apps/api/src/worker-main.ts` (samme delte `OwnerControls`/`ToolGateway`-
  par mot samme databasetabell i begge prosesser, bekreftet i D-171).

## D-171/D-172 / BLOKKER B2: kapittel-28 punkt 15 sin mål-for-mål-kartlegging (fersk kildekode-audit)

| Kapittel-28-mål | Kanonisk objekt/primitiv i dag | Delt/durabel | Nåbar fra `executive.*`? | Status |
|---|---|---|---|---|
| Connector | `tool_id` + `owner_controls.freeze_connector`/`unfreeze_connector` | Ja (K1) | Nei | Eksponeringsgap |
| Hele Jarvis-systemet | Global kill switch, `owner_controls.activate/deactivate_kill_switch` | Ja (K1) | Nei | Eksponeringsgap |
| Leverandør ("provider") | SAMME som connector + `owner_controls.revoke/restore_credential` per `credential_ref` | Ja | Nei | Eksponeringsgap (ingen egen entitet nødvendig) |
| Agent | `tool_id: "tasks"` (coding-agent/task-utførelse), SAMME `freeze_connector`-mekanikk, håndhevet identisk i `main.ts` OG `worker-main.ts` | Ja | Nei | Eksponeringsgap (kartlegging dokumentert her første gang) |
| Finansdomene | `finance.enable_kill_switch`/`disable_kill_switch`/`get_kill_switch` (`finance_kill_switch`, tenant-skopet, migrasjon 038) - EKSISTERER ALLEREDE (**RETTET, D-172**, se D-171 sin opprinnelige feilklassifisering) | Ja (DB, klasse D) | Nei | Eksponeringsgap (**RETTET fra "REELT GAP", D-172**) |
| Enhet ("device") | `SessionGrantService.revokeForDeviceOn()` EKSISTERER, men kalles i dag KUN internt (re-innrullering) | Ja (DB) | Nei (ingen ToolGateway-handling i det hele tatt) | **REELT GAP** - ny eier-vendt handling nødvendig over eksisterende primitiv (uendret av D-172, ENESTE gjenstående reelt-manglende-primitiv-punkt) |
| Autonomi-/situasjonsdomene | `situations.pause_domain`/`resume_domain` (`DomainPauseRegistry`) | Ja (K1/UA-10 P1) | **JA** | Allerede fullt samlet |

**Konklusjon (RETTET, D-172):** 6 av 7 mål (inkl. finansdomene, rettet fra D-171 sin feilklassifisering)
har en tilstrekkelig eksisterende primitiv som bare mangler en `executive.*`-videresending (rent
eksponeringsarbeid); KUN enhet krever i tillegg en NY, liten ToolGateway-handling over eksisterende
mekanikk (ingen ny lagringstilstand i noen av tilfellene - heller ikke for enhet). Kapittel-28 punkt 15
forblir rettet fra "LIVE-PROVEN, NÅ FULLFØRT" til **`GAP / INTERNALLY_BUILDABLE`**.

## Post-K1 Sovereign re-audit-syklus (D-169 → D-170 → D-171 → D-172)

1. **D-169:** Fresh 16-områders re-audit; ÉTT område (K1) flippet til LIVE-PROVEN/MERGET. Konkluderte
   feilaktig `SOVEREIGN_COMPLETE=true "under en presis, intern tolkning"` - en oppfunnet tolkningsakse.
2. **D-170 (rettet av uavhengig arkitekt-review 5247795732):** masterplanens kapittel 28 er ÉN DoD-
   liste, ikke to akser. Rettet til to-akset status: `INTERNAL_BUILD_COMPLETE=true`/
   `SOVEREIGN_COMPLETE=false`. La til eksplisitt 15-punkts sjekkliste.
3. **D-171 (rettet av uavhengig arkitekt-re-review 5248461491, BLOKKER B2):** D-170 sin
   `SOVEREIGN_COMPLETE=false` STÅR FORTSATT KORREKT - men punkt 15 sin `INTERNAL_BUILD_COMPLETE=true`
   var selv overclaimed. Fersk kildekode-audit fant at `executive.*` kun samler LESING, ikke MUTASJON,
   av kontrolloverflaten. Rettet: `INTERNAL_BUILD_BLOCKERS=<B2, navngitt>`, `INTERNAL_BUILD_COMPLETE=false`.
4. **D-172 (rettet av uavhengig arkitekt-re-review 5248756307):** D-171 sin finansdomene-kartlegging
   (mål 5) var selv unøyaktig - klassifisert som "REELT GAP" da en dekningsaudit av HELE `finance`-
   modulet ikke var fullført. Fersk dekningsaudit (se tabell over) bekreftet at `finance.enable_kill_switch`/
   `disable_kill_switch`/`get_kill_switch` allerede eksisterer og allerede dekker Fiken/Stripe/Vipps-
   utbetalingsstier + Wallester-kort-mutasjoner - rettet til SAMME gap-type som connector/provider/agent
   (eksponeringsgap, ikke manglende primitiv). `INTERNAL_BUILD_COMPLETE=false` FORBLIR uendret (enhet
   alene er tilstrekkelig til å holde denne `false`).
5. **K2 og andre "Bygges"-roadmap-punkter FORBLIR `NOT_REQUIRED_FOR_GRADUATION`** (D-169 sin analyse av
   DETTE punktet var og er korrekt, uendret av D-170/D-171/D-172).
6. **Navngitte `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS`** (D-170 sin sjekkliste, punkt 1/2/4/7/9/11/14) er
   FORTSATT ekte, uendrede eksterne graduation-blokkeringer, uavhengig av B2 (som er INTERN).

## Valgt neste interne slice (definert i D-171, RETTET av D-172, IKKE implementert i PR #94)

**"Samlet eier-kontrolloverflate, mutasjonsfullføring (B2)":** `executive.*` blir DEN ENE eier-vendte
mutasjonsoverflaten ved å komponere (ikke duplisere) `owner_controls.*`/`situations.*`/`finance.*`
gjennom `ToolGateway.execute()` - legg til videresendinger for kill switch/connector-frys/credential-
tilbakekalling (`owner_controls.*`) OG for `finance.enable_kill_switch`/`disable_kill_switch`/
`get_kill_switch` (**RETTET, D-172: eksponering av EKSISTERENDE finance-primitiv, IKKE en ny
domene-nivå-primitiv**); legg til én ny eier-vendt enhets-tilbakekallingshandling over
`revokeForDeviceOn()` (fortsatt det ENESTE punktet som krever noe utover ren eksponering). Identitet
UENDRET, INGEN ny/duplisert tilstand, SAMME autorisasjons-/audit-semantikk, B1 sin
selvgjenopprettingsgaranti bevares.

## Blokkeringer

1. **Merge av DENNE PR-en (docs-only).** `SELF_APPROVAL=false`; krever uavhengig arkitekt-review av
   D-172 sin korrigerte konklusjon (samme protokoll som alle foregående slices).
2. **B2 (INTERN, navngitt i D-171, rettet av D-172)** - `executive.*` mangler mutasjonsvideresending for
   kill switch/connector-frys/credential-tilbakekalling OG for den eksisterende `finance_kill_switch`;
   ingen eier-vendt enhets-tilbakekallingshandling. Dette er Jarvis-KODE Claude KAN bygge - definert som
   neste slice, IKKE startet i denne PR-en.
3. **`EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS`** (se D-170 sin sjekkliste) - FAKTISKE, navngitte
   gjenstående Sovereign-graduation-krav: leverandørvalg via D-64-porten, credentials
   (Stripe/Ads/AI-providere), fysisk maskinvare (Apple/HA), voice-benchmark, atferds-/brukstidsevidens
   (Daily Value Loop). Ingen av dem er Jarvis-kode Claude kan bygge seg forbi.
4. **Embedded-Postgres-flake (B.3, port-kontensjon)** fortsatt kjent i repo-suiten, uendret, ikke
   K1/B2-relatert.

## Neste oppgave

Denne PR-en (docs-only) venter på uavhengig arkitekt-review av D-172 sin korrigerte konklusjon. Når
denne PR-en er godkjent/merget: neste oppgave er å IMPLEMENTERE B2 ("Samlet eier-kontrolloverflate,
mutasjonsfullføring") som en egen, ny slice/PR - ikke en fortsettelse av denne docs-only-PR-en.
`SOVEREIGN_COMPLETE` forblir `false` selv ETTER B2 er lukket, til de navngitte
`EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` faktisk er lukket (Tobias sine handlinger) ELLER masterplanen selv
oppdateres. Ingen ny masterplan, ingen UGREEN-migrering.
