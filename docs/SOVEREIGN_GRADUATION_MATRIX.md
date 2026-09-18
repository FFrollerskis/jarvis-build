# Sovereign Autonomy v4.0 – graduation-matrise

**Sist oppdatert:** 2026-09-18 (D-169, fersk re-audit paa exact base `main=22d391d248c3b99f2a3949b2606bfab2d7e7bcb3`
= PR #93/K1 sin merge-commit). Denne filen er den KONSISE, oversiktlige statusen for hele masterplanen
("Sovereign graduation") - `docs/RUNTIME_GATES.md` og `docs/DECISIONS_AND_ASSUMPTIONS.md` forblir de
detaljerte, autoritative kildene; denne filen peker til dem, den erstatter dem ikke.

`docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` er den faktiske v4.0-masterplanteksten
(distinkt fra v2.1-dokumentet CLAUDE.md sin dokumenthierarki navngir). Fasene løper **UA-0 til UA-11**;
det finnes ingen UA-12 eller senere fase i repoet - UA-11 (Executive Mode) er masterplanens TERMINALE
UA-fase. "Sovereign komplett" betyr derfor: summen av UA-0..UA-11 sine egne, ordrette akseptansekriterier
faktisk oppfylt og der masterplanen krever det, host-bevist - IKKE et eget, separat toppnivå-graduation-
kriterium utover disse.

**Status per 2026-09-18 (D-169, KORRIGERT av uavhengig arkitekt-review 5247795732 → D-170):
TO-AKSET, IKKE ETT samlet tall.** `INTERNAL_BUILD_COMPLETE=true` (D-169): INGEN internt byggbar
Sovereign-graduation-blokkering gjenstaar - K1 (siste gap D-163 fant) er nå MERGET og HOST-BEVIST I
SIN HELHET (D-168). Fersk git-historikk-verifisering bekrefter at INGEN annen kode landet paa `main`
mellom D-163 sin audit-base (`9a2f642b1747ad8fde945f062152104cdc52bbd3`) og naa - KUN PR #92 (audit-en
selv) og PR #93 (K1) - saa D-163 sin klassifisering av de andre 15 omraadene er FORTSATT gyldig.
**MEN `SOVEREIGN_COMPLETE=false` (D-170 sin rettelse):** masterplanens kapittel 28 ("Definition of
Done for Jarvis Universal Access") har ÉN samlet DoD, og flere av dens 15 punkter krever EKSPLISITT
FAKTISK live-/atferds-evidens (fire AI-leverandørfamilier+lokal live-rutet, Growth-stack med
before/after-evidens, reelle Finance-transaksjoner, iPhone/Watch/Home/Personal/Health LIVE,
backups/monitoring PRODUCTION_VERIFIED) - IKKE bare kode/pipeline. D-169 sin `SOVEREIGN_COMPLETE=true
"under en presis intern tolkning"` var en oppfunnet akse denne matrisen IKKE lenger bruker. De
gjenstående punktene ER derfor FAKTISKE `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` for FULL Sovereign-status
(navngitt ekstern credential/maskinvare/juridisk/atferds-avhengighet Tobias selv maa skaffe - se D-170
sin fulle sjekkliste), IKKE "ikke-blokkerende notater". Roadmap-/"Bygges"-liste-punkter utenfor de
faktiske UA-fase-akseptansekriteriene forblir korrekt `NOT_REQUIRED_FOR_GRADUATION` (D-169 sin analyse
av DETTE punktet var korrekt og UENDRET av D-170).
**Se D-169 for re-audit-en og D-170 for den korrigerte, to-aksede konklusjonen + fulle
kapittel-28-sjekklisten. Neste-steg er en docs-only "intern bygge-closeout / graduation-readiness",
IKKE en "final Sovereign graduation closeout" og IKKE K2.**

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
| Pause / revoke / kill switch | LIVE-PROVEN (K1, HELE flaten) | `situations`-domener durable+delt (D-160 F); `OwnerControls`/`KillSwitch` durable+delt (D-164, migrasjon 058, `owner_control_state`) - api/worker deler SAMME live DB-autoritet, INGEN prosess-lokal divergens. `PRODUCTION_VERIFIED` for kill switch + connector-frys (D-165, host run_id `d7d5d246`) OG for `revoke_credential`/`restore_credential`/samtidig-deadlock-gjenoppretting/run-avgrenset audit-bevis (D-166/D-167/D-168, fersk host-kjøring på HEAD `9fcf1a3...`, alle markører PASS inkl. `k1_audit_evidence=PASS`). PR #93 MERGET (`22d391d2...`), postmerge CI grønn. Se RUNTIME_GATES.md |
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
| UA-11: decision log/scenario/risikoregister/OKR/delegasjonstavle | **B (rettet fra A, D-169) - NOT_REQUIRED_FOR_GRADUATION** | N/A | Ordrett i masterplanens 'Bygges'-ROADMAP-liste, men IKKE blant de TRE faktiske, ordrette UA-11-akseptansekriteriene (`UA11_EXECUTIVE_MODE_DESIGN.md` §7/§9: "Masterplan-bullets uten en eksisterende kanonisk kilde i repoet ennå" - eksplisitt DEFERRED, samme behandling som dashboard/UI). INGEN kanonisk datakilde finnes; K2 (denne kandidaten) er derfor IKKE en Sovereign-graduation-blokkering - kun en fremtidig, lavere-prioritert, eksplisitt IKKE-valgt utvidelse utover selve akseptansekriteriene (D-169) |
| UA-11: akseptansekriterium 3 ('one control surface' for connector/provider/agent/autonomy-domene) | **A - IMPLEMENTERT, HOST-BEVIST I SIN HELHET, MERGET (K1, D-164/D-165/D-166/D-167/D-168) - KRITERIUM OPPFYLT** | LIVE-PROVEN for kill switch + connector-frys-kjernen (host run_id `d7d5d246`) OG for B1 sin credential-selvgjenoppretting/samtidig-deadlock-gjenoppretting/audit-bevis (fersk host-rerun på HEAD `9fcf1a3...`, ALLE markører PASS inkl. `k1_audit_evidence=PASS`) | `situations` dekket via `executive.*`; `OwnerControls`/`KillSwitch` durable+delt (D-164) - `owner_controls.*` kanonisk ToolGateway-namespace + `executive.get_control_surface_status` komponerer begge lag. Kjernemekanismen host-bevist (D-165). Uavhengig arkitekt-review fant BLOCKER B1 (2026-09-18): `revoke_credential` på DEN DELTE `credential_ref` blokkerte sin egen `restore_credential` - fikset (D-166). Tobias sin FØRSTE host-rerun (HEAD `ca167dba...`) bekreftet B1 funksjonelt, men fant harnessets EGEN "siste 10 rader"-audit-bevis-bug (IKKE produksjonsfeil) - rettet med run-avgrenset spørring (D-167). Tobias sin ANDRE host-rerun (HEAD `9fcf1a3...`, samme HEAD uavhengig arkitekt-review `5247323973` reviewet) bekreftet ALLE markører PASS inkl. det fiksede audit-beviset, `hard_fail=false` (D-168). Arkitekt-review PASS + Tobias sin eksplisitte merge-closeout-ordre → PR #93 MERGET (`22d391d2...`), postmerge CI grønn. `executive.get_control_surface_status`/idempotency forblir suite/CI-proven (ikke øvet av K1-harnesset selv, men ikke et akseptansekriterium-krav) - se Q-35/D-169 |
| UA-11: host-akseptanse-harness | B | N/A | Zero ny migrasjon/credential/leverandør i P0 - ingenting å bevise live |

## Neste-steg (K1 MERGET og HOST-BEVIST I SIN HELHET 2026-09-18, D-164 t.o.m. D-168; post-K1 re-audit D-169 KORRIGERT av D-170: INTERNAL_BUILD_COMPLETE=true, SOVEREIGN_COMPLETE=false - docs-only "intern bygge-closeout" valgt, IKKE K2, IKKE en "final Sovereign graduation closeout")

**K1 er nå FULLFØRT: IMPLEMENTERT, HOST-BEVIST I SIN HELHET, OG MERGET** (durable+delt `KillSwitch`/
`OwnerControls`, kanonisk `owner_controls.*` ToolGateway-namespace) - se D-164 t.o.m. D-168 og
RUNTIME_GATES.md sin K1-rad. `PRODUCTION_VERIFIED` for BÅDE kill switch + connector-frys-kjernen
(host run_id `d7d5d246`) OG credential-revoke/restore-selvgjenopprettingen + samtidig-deadlock-
gjenopprettingen + det run-avgrensede audit-beviset (D-166/D-167/D-168: uavhengig arkitekt-review
`5247323973` PASS + fersk host-rerun på eksakt reviewet HEAD `9fcf1a3d3aa1b0d39f0311dc7be6f07150831a25`,
ALLE K1-markører PASS, `hard_fail=false`). Tobias sin eksplisitte merge-closeout-ordre → **PR #93
MERGET** (`MERGE_SHA=22d391d248c3b99f2a3949b2606bfab2d7e7bcb3`, normal two-parent merge, parents
`34c9c474a478...`+`9fcf1a3d3aa1...`, verifisert via `git cat-file -p`), postmerge CI (run
`35340723640`) grønn på alle tre jobber. UA-11 akseptansekriterium 3 er dermed OPPFYLT I SIN HELHET.

**Post-K1 re-audit (D-169, 2026-09-18), KORRIGERT av uavhengig arkitekt-review (5247795732 → D-170):**
fersk gjennomgang av alle 16 graduation-områder, med git-historikk-bekreftelse at INGEN annen kode
landet på `main` mellom D-163 sin audit-base og K1 sin merge (kun PR #92 og PR #93) - D-163 sin
klassifisering av de øvrige 15 områdene er derfor FORTSATT gyldig. Konklusjon (TO-AKSET, D-170):
`INTERNAL_BUILD_BLOCKERS=NONE`, `INTERNAL_BUILD_COMPLETE=true` - INGEN internt byggbar
Sovereign-kode-arbeid gjenstår. **MEN `SOVEREIGN_COMPLETE=false`:** masterplanens fulle,
ordrette kapittel-28-DoD krever FAKTISK live-/atferds-evidens på flere punkter (se D-170 sin
sjekkliste) som eksplisitt gjenstår - disse er `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS`, IKKE
"ikke-blokkerende notater". **K2 (decision log-domenet) er DERFOR FORTSATT IKKE valgt** (D-169 sin
analyse av DETTE punktet var korrekt og uendret) - det er ordrett i "Bygges"-roadmap-listen, men IKKE
blant UA-11 sine tre faktiske akseptansekriterier (se rettelsen i tabellen over) - å bygge det nå
ville vært roadmap-arbeid valgt fordi det er interessant, ikke fordi masterplanen faktisk krever det
for graduation. I stedet er en docs-only **"INTERN BYGGE-CLOSEOUT / GRADUATION-READINESS"** valgt som
neste slice - IKKE en "final Sovereign graduation closeout" (D-169 sin opprinnelige framing av dette
var selve feilen D-170 rettet). Se D-169 for re-audit-en og D-170 for den korrigerte, to-aksede
konklusjonen + den fulle kapittel-28-sjekklisten, som selv bør gå gjennom SAMME uavhengige
arkitekt-review-disiplin som enhver annen slice før den behandles som endelig.

- **K1 - Durable, delt owner-kontroll (FULLFØRT: IMPLEMENTERT, HOST-BEVIST I SIN HELHET, MERGET).**
  `OwnerControls`/`KillSwitch` er nå durable og delt mellom api-/worker-prosessene (samme mønster som
  `DomainPauseRegistry`, D-160 F), eksponert via kanonisk `owner_controls.*` og komponert av
  `executive.get_control_surface_status`. Lukker UA-11 akseptansekriterium 3 sitt gjenværende gap i
  kode/suite OG på ekte host (D-165/D-168) for HELE flaten, inkl. B1-selvgjenopprettingen (D-166) og
  harnessets eget audit-bevis-determinisme-fiks (D-167). `SELF_APPROVAL=false`, uavhengig
  arkitekt-review PASS FØR merge-closeout-ordren, samme protokoll som alle foregående Sovereign-slices.
- **K2 - Decision log.** Reklassifisert `NOT_REQUIRED_FOR_GRADUATION` (D-169) - roadmap-only, ikke et
  UA-11-akseptansekriterium. Forblir en fremtidig, lavere prioritert, IKKE startet, IKKE valgt kandidat
  dersom Tobias på et senere tidspunkt ønsker den utover selve Sovereign-graduation-scopet.

## Dokumentasjonshull (registrert, ikke rettet i kode)

UA-7 (Communications Hub, D-119) og UA-8 (Personal Digital Twin, D-130/D-131) er kode-implementert og
dokumentert i `IMPLEMENTATION_PLAN.md`/`DECISIONS_AND_ASSUMPTIONS.md`, men har INGEN egen rad i
`docs/RUNTIME_GATES.md`. UA-9 (Vision) har samme mangel. Registrert som Q-35 - en fremtidig, ren
dokumentasjons-oppfølging, ikke en del av mandatet for denne audit-runden.
