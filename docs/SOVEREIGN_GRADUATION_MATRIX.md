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
| Pause / revoke / kill switch | TESTED, EN reell gjenstående gap - NESTE SLICE VALGT | `situations`-domener durable+delt (D-160 F); **`OwnerControls`/`KillSwitch` fortsatt in-memory, PER PROSESS, ikke delt api↔worker** - K1 (durable+delt + read-only `executive.get_control_surface_status`) valgt som neste slice av arkitekt-review (5241197516, D-163 F), ikke implementert i denne PR-en |
| Erasure / retention | LIVE-PROVEN (teknisk fundament) | Q-20 PRODUCTION_VERIFIED (2026-08-16) - teknisk fundament, IKKE juridisk GDPR-sertifisering |
| Audit / provenance | TESTED, live-datastrøm gjenstår | UA0-PRIVACY PARTIAL_RUNTIME - RLS/karantene/injection-vern suite-bevist |
| Restart / restore / recovery | LIVE-PROVEN (lokalt) / BLOCKED (off-site) | OPS-RUNTIME VERIFIED lokalt; ekstern uptime/off-site backup gjenstår |

## UA-9/UA-10/UA-11 deferred-punkter - A/B/C-klassifisering

Full begrunnelse per punkt: D-163 (denne og forrige runde) og D-153/D-160/D-161/D-162 (tidligere
runder). `A = IMPLEMENT_NOW` (kodbar nå, ingen ekstern avhengighet) · `B = PROVE_NOT_REQUIRED`
(utenfor nåværende graduation-scope, med begrunnelse) · `C = BLOCKED_EXTERNAL` (krever navngitt
ekstern/fysisk avhengighet).

**RETTET etter arkitekt-review runde 1 (review 5241197516, RESULT=CHANGES_REQUIRED, D-163 F):** den
FØRSTE versjonen av denne tabellen konflaterte IMPLEMENTASJON med LIVE-BEVIS og klassifiserte derfor
flere internt kodbare punkter som `C` når kun deres produksjons-/live-evidens faktisk var eksternt
blokkert. Hvert punkt nedenfor er nå splittet i (a) implementasjon og (b) live-bevis der de to er
reelt forskjellige.

| Punkt | Klasse | Kort begrunnelse |
|---|---|---|
| UA-9: objektklassifiserer-PIPELINE (a: implementasjon) | **B (rettet fra C)** | ModelGateway/Gemma-vision-stien (D-81) eksisterer allerede og kan kalles mot et test-/syntetisk bilde uten en fysisk kamera - klassifiserer-KODEN er ikke blokkert. Bygges IKKE nå fordi masterplanens UA-9 P0-DoD eksplisitt valgte en provider-uavhengig kjerne (D-153) og ingen reell verdi kommer av å klassifisere syntetiske bilder |
| UA-9: kamerafangst/live strøm-ruting (b: live-bevis) | C | Krever fysisk iPhone-/HA-kamera + valgt modell-leverandør-avtale; egen D-64/D-41-port. Dette, IKKE klassifiserer-koden, er den faktiske eksterne blokkeringen |
| UA-9: biometrisk ansiktsgjenkjenning, kontinuerlig rå video | B | Eksplisitt UTENFOR masterplan v4.0 UA-9-scope (DPIA §5) |
| UA-10: infra-detektor (a: implementasjon) | **B (rettet fra C)** | `modules/incidents` har ALLEREDE ekte, internt kanonisk deploy-/incident-tilstand (`correlateIncident()`, D-104/D-105) - en bro fra incidents til situations er kodbar NÅ mot eksisterende intern data, ingen fysisk avhengighet. Ikke bygget fordi UA-10s egne akseptansekriterier (dedupe/ACT-autoritet/varsel/pause) allerede er oppfylt uten den - masterplanen krever den ikke ennå |
| UA-10: home-/health-detektor (a: implementasjon) | **B (rettet fra C)** | `@jarvis/health`/`@jarvis/location` har canonical schema + `FakeHealthMetricSource`/test-kilder - en bro er kodbar og testbar NÅ mot disse, akkurat som open-loop-broen ble bygget mot intern Business OS-data. Ikke bygget fordi det ikke er et UA-10-akseptansekrav ennå |
| UA-10: infra-/home-/health-detektor (b: live produksjonsbevis) | C | Ekte tverr-provider-korrelasjon (GitHub/Vercel/GCP) og ekte fysiske health/home-signaler krever leverandør-/enhets-tilkobling (Q-31, D-36, HA-RUNTIME) - dette er den faktiske eksterne blokkeringen, ikke bro-koden |
| UA-10: modell-assistert klassifisering (a: implementasjon) | **B (rettet fra C)** | `ModelGateway` og provider-uavhengig modell-infrastruktur finnes allerede i repoet - IKKE en ekstern blokkering i seg selv. Ikke bygget fordi det er masterplanens egen valgfrie forbedring av en ALLEREDE fullt deterministisk, host-verifisert P0/P1-motor, ikke et akseptansekrav |
| UA-10: modell-assistert klassifisering (b: leverandørspesifikk live-bruk) | C (kun der en spesifikk leverandør faktisk kreves) | Reservert for et navngitt credential-/leverandørkrav hvis/når en slik klassifisering faktisk velges - ikke en generell blokkering av selve kapabiliteten |
| UA-10: simulation/counterfactual/feedback learning | B | Masterplanens egen 'where useful'-kvalifikator, ikke et akseptansekrav |
| UA-10: vision-/helse-/lokasjonsbro (a: implementasjon) | **B (rettet fra C)** | Broen selv ER kodbar/testbar mot canonical schema + fake sources (samme mønster som open-loop-broen) - ikke bygget fordi det ikke er et UA-10-akseptansekrav ennå, ikke fordi den er blokkert |
| UA-10: vision-/helse-/lokasjonsbro (b: reell produksjonsverdi) | C | Gir null reell nytte i PRODUKSJON før UA-9/helse/lokasjon faktisk har en live kilde - dette er en verdi-/live-bevis-blokkering, ikke en kode-blokkering |
| UA-10: `situations`/`executive` i `worker-main.ts` | B | Bekreftet fortsatt fraværende ved fersk kodelesing, men ingen eier-vendt kaller finnes i worker-prosessen for noen av de to namespacene - wiring nå ville vært utestet/ubrukt kode |
| UA-11: dashboard/UI | B | Kun i masterplanens 'Bygges'-ROADMAP-liste, ikke i de tre faktiske akseptansekriteriene; `situations.*` fikk samme behandling |
| UA-11: business health/personal attention-kilder utover `situations` | B (delvis allerede dekket) | Sales/support/kontrakt/marketing/finans/produkt/drift flyter allerede inn via de 26 `OpenLoopType`-verdiene og den eksisterende broen (D-160 B) - personal/home/health-signaler avhenger av UA-10s helse-/lokasjonsbro (a) over, som nå er B (kodbar), ikke C |
| UA-11: decision log/scenario/risikoregister/OKR/delegasjonstavle | A (men for stort for én slice) | Ordrett i 'Bygges'-listen, INGEN kanonisk datakilde finnes - egen, ny domenepakke, se Q-35 kandidat K2 |
| UA-11: akseptansekriterium 3 ('one control surface' for connector/provider/agent/autonomy-domene) | **A - VALGT som neste slice etter arkitekt-review runde 1** | `situations` dekket; `OwnerControls`/`KillSwitch` fortsatt per-prosess, ikke durable/delt. Arkitekt-review (5241197516) prioriterer dette FØR K2, se Q-35 kandidat K1 |
| UA-11: host-akseptanse-harness | B | Zero ny migrasjon/credential/leverandør i P0 - ingenting å bevise live |

## Neste-steg (K1 valgt av arkitekt-review runde 1, K2 forblir en fremtidig kandidat)

**K1 er valgt som neste Sovereign-slice etter denne audit-PR-en (5241197516, D-163 F) - IKKE
implementert i denne PR-en, som forblir docs-only.** K2 forblir en fremtidig, IKKE valgt kandidat.
Se Q-35 for full kontekst.

- **K1 - Durable, delt owner-kontroll (VALGT, neste slice).** Gjør `OwnerControls`/`KillSwitch`
  durable og delt mellom api-/worker-prosessene (samme mønster som `DomainPauseRegistry`, D-160 F),
  deretter eksponer dem read-only via `executive.get_control_surface_status`. Lukker UA-11
  akseptansekriterium 3 sitt gjenværende gap direkte. Høy blast radius (rører kjernen av
  autorisasjonspipelinen) - arkitekt-review har eksplisitt prioritert og godkjent retningen, men
  selve implementasjonen skjer i en EGEN, senere PR, ikke her.
- **K2 - Decision log (kun det, ikke hele Bygges-listen).** Ny, liten `JARVIS_CANONICAL`-pakke etter
  en egen D-64-port. Krever ny persistens; ingen eksisterende kanonisk kilde å komponere mot. Lavere
  prioritet enn K1 per arkitekt-review.

## Dokumentasjonshull (registrert, ikke rettet i kode)

UA-7 (Communications Hub, D-119) og UA-8 (Personal Digital Twin, D-130/D-131) er kode-implementert og
dokumentert i `IMPLEMENTATION_PLAN.md`/`DECISIONS_AND_ASSUMPTIONS.md`, men har INGEN egen rad i
`docs/RUNTIME_GATES.md`. UA-9 (Vision) har samme mangel. Registrert som Q-35 - en fremtidig, ren
dokumentasjons-oppfølging, ikke en del av mandatet for denne audit-runden.
