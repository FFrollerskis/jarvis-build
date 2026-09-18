# Sovereign Autonomy v4.0 – graduation-matrise

**Sist oppdatert:** 2026-09-17 (D-163, exact base `main=9a2f642b1747ad8fde945f062152104cdc52bbd3`
= PR #91 sin merge-commit). Denne filen er den KONSISE, oversiktlige statusen for hele masterplanen
("Sovereign graduation") - `docs/RUNTIME_GATES.md` og `docs/DECISIONS_AND_ASSUMPTIONS.md` forblir de
detaljerte, autoritative kildene; denne filen peker til dem, den erstatter dem ikke.

`docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` er den faktiske v4.0-masterplanteksten
(distinkt fra v2.1-dokumentet CLAUDE.md sin dokumenthierarki navngir). Fasene løper **UA-0 til UA-11**;
det finnes ingen UA-12 eller senere fase i repoet - UA-11 (Executive Mode) er masterplanens TERMINALE
UA-fase. "Sovereign komplett" betyr derfor: summen av UA-0..UA-11 sine egne, ordrette akseptansekriterier
faktisk oppfylt og der masterplanen krever det, host-bevist - IKKE et eget, separat toppnivå-graduation-
kriterium utover disse.

**Status per 2026-09-17: Sovereign er FORTSATT IKKE komplett.** Se D-163 for den fulle, ferske
gap-audit-en denne matrisen oppsummerer.

## 16-områders graduation-matrise

| Område | Status | Evidens (kort) |
|---|---|---|
| AI Mesh / routing / fallback | LIVE-PROVEN (kjerne) | Ekte OpenAI-kall bevist (UA0-RUNRATE); Gemma-first routing CI_VERIFIED (D-80/D-81); enkelte providere (Gemini m.fl.) fortsatt ukonfigurert i dette miljøet |
| Memory / knowledge / retrieval | LIVE-PROVEN | UA-2 P0/P1A/P1B PRODUCTION_VERIFIED; pgvector/HNSW selv BLOCKED_EXTERNAL (portabel `real[]`+cosine i drift) |
| Business Graph | LIVE-PROVEN | UA-3 P0 PRODUCTION_VERIFIED (host run `ca2d9248`) |
| Ads / Growth | TESTED (ikke live-provider-verifisert) | UA-4 CI_VERIFIED/COMPLETE mot masterplanens fire kriterier; Google Ads live-verifisering `DEFERRED_TO_FINAL_INTEGRATION_PHASE` (D-86) |
| Cloud / dev / task execution | LIVE-PROVEN | UA-5 v2 LIVE_VERIFIED, alle fire kriterier COMPLETE (D-105) |
| Finance | TESTED (ikke live) | FIXED_SUITE_VERIFIED; Stripe `STRIPE_LIVE_GATE=PENDING_CREDENTIALS` |
| Communications / voice | LIVE-PROVEN (Telegram/Gmail) + BLOCKED_EXTERNAL (voice-benchmark) | Telegram/Gmail LIVE+VERIFIED; D-30 voice-benchmark krever ≥100 norske prøver + STT/TTS-nøkler. **UA-7 har ingen egen RUNTIME_GATES.md-rad (dokumentasjonshull, se Q-35)** |
| Personal / device / home | BLOCKED_EXTERNAL | D-36 Apple runtime krever Mac/Xcode/Developer-konto; HA-RUNTIME krever ekte HA-instans+token. **UA-8 har ingen egen RUNTIME_GATES.md-rad (dokumentasjonshull, se Q-35)** |
| Vision (UA-9) | IMPLEMENTED, provider-uavhengig kjerne, ikke live | D-153: `CAN_RUN_WITHOUT_PROVIDER=true`, ZERO leverandør koblet. Live kamera/klassifiserer = BLOCKED_EXTERNAL. **Ingen egen RUNTIME_GATES.md-rad (dokumentasjonshull, se Q-35)** |
| Situation Engine (UA-10) | LIVE-PROVEN | P1 Aktivering PRODUCTION_VERIFIED (D-161, host run `0562c48a`, 18/18 PASS, ekte Telegram) |
| Executive Mode (UA-11) | TESTED, host ikke nødvendig for P0 | FIXED_SUITE_VERIFIED (D-162); `HOST_ACCEPTANCE_REQUIRED=false` (zero ny migrasjon/credential/leverandør) |
| Class D authority | TESTED (suite), live mot ekte connectors delvis | UA0-AUTHORITY PARTIAL_RUNTIME i eget navn, men substansielt dekket kumulativt av UA-5/UA-10 P1 sine host-bevis |
| Pause / revoke / kill switch | LIVE-PROVEN (kjernemekanisme, K1) | `situations`-domener durable+delt (D-160 F); `OwnerControls`/`KillSwitch` NÅ OGSÅ durable+delt (D-164, migrasjon 058, `owner_control_state`) - api/worker deler SAMME live DB-autoritet, INGEN prosess-lokal divergens. **PRODUCTION_VERIFIED for kill switch + connector-frys** (D-165, host run_id `d7d5d246`, 10/10 PASS på ekte Windows/Docker Desktop, EKTE container-restart). `revoke_credential`/`restore_credential` forblir SUITE/CI-PROVEN (ikke øvet av dette harnesset) - se RUNTIME_GATES.md |
| Erasure / retention | LIVE-PROVEN (teknisk fundament) | Q-20 PRODUCTION_VERIFIED (2026-08-16) - teknisk fundament, IKKE juridisk GDPR-sertifisering |
| Audit / provenance | TESTED, live-datastrøm gjenstår | UA0-PRIVACY PARTIAL_RUNTIME - RLS/karantene/injection-vern suite-bevist |
| Restart / restore / recovery | LIVE-PROVEN (lokalt) / BLOCKED (off-site) | OPS-RUNTIME VERIFIED lokalt; ekstern uptime/off-site backup gjenstår |

## UA-9/UA-10/UA-11 deferred-punkter - IMPLEMENTATION_STATUS / LIVE_EVIDENCE_STATUS

Full begrunnelse per punkt: D-163 (alle runder) og D-153/D-160/D-161/D-162 (tidligere faser).
`A = IMPLEMENT_NOW` (kodbar nå, ingen ekstern avhengighet) · `B = PROVE_NOT_REQUIRED` (utenfor
nåværende graduation-scope, med konkret masterplan-begrunnelse) · `C = BLOCKED_EXTERNAL` (krever
navngitt ekstern/fysisk avhengighet for selve completion).

**RETTET etter arkitekt-review runde 1 OG 2 (review 5241197516, RESULT=CHANGES_REQUIRED, D-163 F/G):**
den FØRSTE versjonen av denne tabellen konflaterte IMPLEMENTASJON med LIVE-BEVIS og klassifiserte
derfor flere internt kodbare punkter som `C` når kun deres produksjons-/live-evidens faktisk var
eksternt blokkert. Hvert punkt der de to reelt er forskjellige er nå splittet i to EGNE kolonner -
`IMPLEMENTATION_STATUS` (kan selve koden/pipelinen/broen bygges og testes nå, mot canonical
contracts/fake sources/eksisterende intern data?) og `LIVE_EVIDENCE_STATUS` (krever den FAKTISKE
production-completion en navngitt ekstern/fysisk avhengighet?). `C` brukes KUN når selve completion
faktisk krever den eksterne avhengigheten - aldri som en samlebetegnelse for "ingen har bygget dette
ennå".

| Punkt | IMPLEMENTATION_STATUS | LIVE_EVIDENCE_STATUS | Begrunnelse |
|---|---|---|---|
| UA-9: objektklassifiserer/model-pipeline | **B** (rettet fra C) | **C** | `ModelGateway`/Gemma-vision-stien (D-81) finnes allerede og kan kalles mot et test-/syntetisk bilde uten fysisk kamera - klassifiserer-KODEN er ikke eksternt blokkert (`IMPLEMENTATION_STATUS=B`, ikke påkrevd av UA-9 P0-DoD som eksplisitt valgte en provider-uavhengig kjerne, D-153). Kun kamerafangst/live strøm-ruting krever fysisk iPhone-/HA-kamera + valgt modell-leverandør-avtale (`LIVE_EVIDENCE_STATUS=C`, egen D-64/D-41-port) |
| UA-9: biometrisk ansiktsgjenkjenning, kontinuerlig rå video | B | N/A | Eksplisitt UTENFOR masterplan v4.0 UA-9-scope (DPIA §5) - ingen live-bevis-spørsmål oppstår når implementasjonen selv ikke skal bygges |
| UA-10: infra-detektor (bro fra incidents/deploy-tilstand til situations) | **B** (rettet fra C) | **C** | `modules/incidents` har ALLEREDE ekte, internt kanonisk deploy-/incident-tilstand (`correlateIncident()`, D-104/D-105) - broen er kodbar/testbar NÅ mot eksisterende intern data, ingen fysisk avhengighet (`IMPLEMENTATION_STATUS=B`: UA-10s egne akseptansekriterier - dedupe/ACT-autoritet/varsel/pause - er allerede oppfylt uten den, masterplanen krever den ikke ennå). Ekte tverr-provider-korrelasjon (GitHub/Vercel/GCP) for PRODUKSJON krever leverandør-tilkobling (Q-31) (`LIVE_EVIDENCE_STATUS=C`) |
| UA-10: home-/health-detektor (bro fra `@jarvis/health`/`@jarvis/location` til situations) | **B** (rettet fra C) | **C** | `@jarvis/health`/`@jarvis/location` har canonical schema + `FakeHealthMetricSource`/test-kilder - broen er kodbar/testbar NÅ, samme mønster som open-loop-broen mot intern Business OS-data (`IMPLEMENTATION_STATUS=B`: ikke et UA-10-akseptansekrav ennå). Ekte fysiske health-/home-signaler krever enhets-/HA-tilkobling (D-36, HA-RUNTIME) (`LIVE_EVIDENCE_STATUS=C`) |
| UA-10: modell-assistert klassifisering | **B** (rettet fra C) | **C** (betinget) | `ModelGateway` og provider-uavhengig modell-infrastruktur finnes ALLEREDE i repoet - IKKE en ekstern blokkering i seg selv (`IMPLEMENTATION_STATUS=B`: masterplanens egen valgfrie forbedring av en allerede fullt deterministisk, host-verifisert P0/P1-motor, ikke et akseptansekrav). `LIVE_EVIDENCE_STATUS=C` reservert KUN for et navngitt credential-/leverandørkrav hvis/når en spesifikk leverandør faktisk velges - ikke en generell blokkering av kapabiliteten |
| UA-10: simulation/counterfactual/feedback learning | B | N/A | Masterplanens egen 'where useful'-kvalifikator, ikke et akseptansekrav |
| UA-10: vision-/helse-/lokasjonsbro (situations-siden av broen) | **B** (rettet fra C) | **C** | Broen selv ER kodbar/testbar mot canonical schema + fake sources, samme mønster som open-loop-broen (`IMPLEMENTATION_STATUS=B`: ikke et UA-10-akseptansekrav ennå). Reell PRODUKSJONSVERDI krever at UA-9/helse/lokasjon faktisk har en live kilde (`LIVE_EVIDENCE_STATUS=C`) - en verdi-/live-bevis-blokkering, ikke en kode-blokkering |
| UA-10: `situations`/`executive` i `worker-main.ts` | B | N/A | Bekreftet fortsatt fraværende ved fersk kodelesing (uendret av denne korrigeringsrunden), men ingen eier-vendt kaller finnes i worker-prosessen for noen av de to namespacene - wiring nå ville vært utestet/ubrukt kode |
| UA-11: dashboard/UI | B | N/A | Kun i masterplanens 'Bygges'-ROADMAP-liste, ikke i de tre faktiske akseptansekriteriene; `situations.*` fikk samme behandling |
| UA-11: business health/personal attention-kilder utover `situations` | B (delvis allerede dekket) | N/A | Sales/support/kontrakt/marketing/finans/produkt/drift flyter allerede inn via de 26 `OpenLoopType`-verdiene og den eksisterende broen (D-160 B) - personal/home/health-signaler avhenger av UA-10s helse-/lokasjonsbro over, som nå er `IMPLEMENTATION_STATUS=B` (kodbar), ikke C |
| UA-11: decision log/scenario/risikoregister/OKR/delegasjonstavle | A (men for stort for én slice) | N/A | Ordrett i 'Bygges'-listen, INGEN kanonisk datakilde finnes - egen, ny domenepakke, se Q-35 kandidat K2 (lavere prioritet enn K1) |
| UA-11: akseptansekriterium 3 ('one control surface' for connector/provider/agent/autonomy-domene) | **A - IMPLEMENTERT; HOST-BEVIST for kjernemekanismen, B1 FUNKSJONELT HOST-BEVIST men harnessets audit-bevis-mekanisme selv trengte en D-167-fiks, FIXED_SUITE_VERIFIED_AFTER_B1 for credential-selvgjenoppretting (K1, D-164/D-165/D-166/D-167)** | LIVE-PROVEN for kill switch + connector-frys-kjernen (host run_id `d7d5d246`, 10/10 PASS); B1 sin selvgjenoppretting/samtidig-deadlock-gjenoppretting/cleanup LIVE-PROVEN på host (HEAD `ca167dba...`), men det SAMME host-forsøket avdekket en ikke-deterministisk "siste 10 rader"-bug i harnessets EGEN audit-bevis-spørring (IKKE en produksjonsfeil) - fikset (D-167), IKKE ennå re-kjørt på host | `situations` dekket via `executive.*`; `OwnerControls`/`KillSwitch` NÅ durable+delt (D-164) - `owner_controls.*` kanonisk ToolGateway-namespace + `executive.get_control_surface_status` komponerer begge lag. Kjernemekanismen (freeze/unfreeze/kill-switch-parity) er lukket i kode/suite OG bevist på ekte Windows/Docker-host (D-165). Uavhengig arkitekt-review fant BLOCKER B1 (2026-09-18): `revoke_credential` på DEN DELTE `credential_ref` blokkerte sin egen `restore_credential` - fikset med en minimal, handlings-nivå selvgjenopprettings-mengde (D-166). Tobias sin påfølgende host-rerun (HEAD `ca167dba...`) bekreftet B1 FUNKSJONELT (`k1_credential_revocation_self_recovery=PASS`/`k1_combined_deadlock_recovery=PASS`/`k1_cleanup_state_unchanged=PASS`), men harnessets EGEN, sekundære audit-bevis-spørring (en håndplukket "siste 10 rader"-grense satt før D-166 fantes) mistet den opprinnelige aktiveringsraden etter at D-166 la til flere `owner_controls`-kall enn grensen tålte (`k1_audit_evidence=FAIL`, `hard_fail=true` for kjøringen som helhet) - rettet med en run-avgrenset (`session_id`+vannmerke, ingen `LIMIT`) spørring (D-167), 32/32+19/19 nye/oppdaterte tester grønne, IKKE ennå re-kjørt på host. `executive.get_control_surface_status`/idempotency forblir suite/CI-proven (ikke øvet av dette spesifikke harnesset) - se Q-35 |
| UA-11: host-akseptanse-harness | B | N/A | Zero ny migrasjon/credential/leverandør i P0 - ingenting å bevise live |

## Neste-steg (K1 implementert; kjernemekanisme host-bevist 2026-09-17/18, D-164/D-165; B1-fiks funksjonelt host-bevist 2026-09-18, D-166; host-harnessets EGET audit-bevis fikset 2026-09-18, D-167, host-rerun utestående; K2 forblir en fremtidig kandidat)

**K1 er nå IMPLEMENTERT OG HOST-BEVIST for kjernemekanismen** (durable+delt `KillSwitch`/
`OwnerControls`, kanonisk `owner_controls.*` ToolGateway-namespace) - se D-164/D-165 og
RUNTIME_GATES.md sin K1-rad. `PRODUCTION_VERIFIED` for kill switch + connector-frys (host run_id
`d7d5d246`, 10/10 PASS på ekte Windows/Docker Desktop, EKTE container-restart). **B1 (D-166, 2026-09-18):**
uavhengig arkitekt-review av PR #93 fant en REELL selv-lås-bug i `revoke_credential`/`restore_credential`
på den delte `credential_ref` (ikke bare "ikke øvet ennå" som tidligere antatt) - fikset med en minimal
handlings-nivå selvgjenopprettings-mengde. **D-167 (host-rerun, 2026-09-18):** Tobias sin påfølgende
host-kjøring (HEAD `ca167dba...`) bekreftet B1 FUNKSJONELT PASS (selvgjenoppretting/samtidig-deadlock/
cleanup), men harnessets EGEN "siste 10 rader"-audit-bevis-spørring var ikke-deterministisk etter at
D-166 la til flere `owner_controls`-kall enn den håndplukkede grensen tålte - IKKE en produksjonsfeil,
rettet med en run-avgrenset (`session_id`+vannmerke) spørring. Status forblir
`FIXED_SUITE_VERIFIED_AFTER_B1`, `HOST_ACCEPTANCE_REQUIRED=true` til det fiksede harnesset kjøres på
nytt. `executive.get_control_surface_status`/idempotency forblir SUITE/CI-PROVEN (ikke
øvet av dette spesifikke host-harnesset - se RUNTIME_GATES.md for den eksplisitte distinksjonen). PR
#93 forblir IKKE merget, venter på uavhengig arkitekt-review av B1-/D-167-fiksene. K2 forblir en fremtidig, IKKE startet,
lavere prioritert kandidat. Se Q-35 for full kontekst.

- **K1 - Durable, delt owner-kontroll (IMPLEMENTERT; kjernemekanisme HOST-BEVIST, B1 funksjonelt HOST-BEVIST, harnessets audit-bevis FIXED_SUITE_VERIFIED_AFTER_B1 pending re-kjøring).**
  `OwnerControls`/`KillSwitch` er nå durable og delt mellom api-/worker-prosessene (samme mønster som
  `DomainPauseRegistry`, D-160 F), eksponert via kanonisk `owner_controls.*` og komponert av
  `executive.get_control_surface_status`. Lukker UA-11 akseptansekriterium 3 sitt gjenværende gap i
  kode/suite (759+96 tester grønne) OG på ekte host (D-165) for kjernemekanismen; B1 (D-166) rettet en
  selv-lås i credential-revoke/restore-selvgjenopprettingen, host-bevist funksjonelt (D-167) men
  harnessets EGET audit-bevis trengte en egen determinisme-fiks (D-167), host-rerun
  utestående. Høy blast radius (rørte kjernen av
  autorisasjonspipelinen) - `SELF_APPROVAL=false`/`MERGED=false` for denne PR-en, som fortsatt venter på uavhengig
  arkitekt-review + eksplisitt merge-closeout-vedtak, samme protokoll som alle foregående Sovereign-slices.
- **K2 - Decision log (kun det, ikke hele Bygges-listen).** Ny, liten `JARVIS_CANONICAL`-pakke etter
  en egen D-64-port. Krever ny persistens; ingen eksisterende kanonisk kilde å komponere mot. Lavere
  prioritet enn K1, ikke startet.

## Dokumentasjonshull (registrert, ikke rettet i kode)

UA-7 (Communications Hub, D-119) og UA-8 (Personal Digital Twin, D-130/D-131) er kode-implementert og
dokumentert i `IMPLEMENTATION_PLAN.md`/`DECISIONS_AND_ASSUMPTIONS.md`, men har INGEN egen rad i
`docs/RUNTIME_GATES.md`. UA-9 (Vision) har samme mangel. Registrert som Q-35 - en fremtidig, ren
dokumentasjons-oppfølging, ikke en del av mandatet for denne audit-runden.
