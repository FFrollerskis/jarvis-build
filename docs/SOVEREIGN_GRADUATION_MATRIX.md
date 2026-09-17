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
| Pause / revoke / kill switch | TESTED, EN reell gjenstående gap | `situations`-domener durable+delt (D-160 F); **`OwnerControls`/`KillSwitch` fortsatt in-memory, PER PROSESS, ikke delt api↔worker** (se D-163/Q-35 kandidat K1) |
| Erasure / retention | LIVE-PROVEN (teknisk fundament) | Q-20 PRODUCTION_VERIFIED (2026-08-16) - teknisk fundament, IKKE juridisk GDPR-sertifisering |
| Audit / provenance | TESTED, live-datastrøm gjenstår | UA0-PRIVACY PARTIAL_RUNTIME - RLS/karantene/injection-vern suite-bevist |
| Restart / restore / recovery | LIVE-PROVEN (lokalt) / BLOCKED (off-site) | OPS-RUNTIME VERIFIED lokalt; ekstern uptime/off-site backup gjenstår |

## UA-9/UA-10/UA-11 deferred-punkter - A/B/C-klassifisering

Full begrunnelse per punkt: D-163 (denne runden) og D-153/D-160/D-161/D-162 (tidligere runder).
`A = IMPLEMENT_NOW` (kodbar nå, ingen ekstern avhengighet) · `B = PROVE_NOT_REQUIRED` (utenfor
nåværende graduation-scope, med begrunnelse) · `C = BLOCKED_EXTERNAL` (krever navngitt ekstern/fysisk
avhengighet).

| Punkt | Klasse | Kort begrunnelse |
|---|---|---|
| UA-9: live iPhone-/HA-kamera, ekte objektklassifiserer, sensitiv strøm-ruting | C | Krever fysisk enhet/HA-instans/valgt modell-leverandør; egen D-64/D-41-port |
| UA-9: biometrisk ansiktsgjenkjenning, kontinuerlig rå video | B | Eksplisitt UTENFOR masterplan v4.0 UA-9-scope (DPIA §5) |
| UA-10: infra-/home-/health-detektor | C | Ingen eksisterende signalkilde - avhenger av at UA-9/health/location faktisk får en live kilde først |
| UA-10: modell-assistert klassifisering | C | ModelGateway/AI Council-avhengighet, egen D-64/D-41-port |
| UA-10: simulation/counterfactual/feedback learning | B | Masterplanens egen 'where useful'-kvalifikator, ikke et akseptansekrav |
| UA-10: vision-/helse-/lokasjonsbro | C | Broen selv er kodbar mot fake sources, men gir null reell verdi før en live kilde finnes (samme avhengighet som linjen over) |
| UA-10: `situations`/`executive` i `worker-main.ts` | **B (revidert denne runden)** | Bekreftet fortsatt fraværende ved fersk kodelesing, men ingen eier-vendt kaller finnes i worker-prosessen for noen av de to namespacene - wiring nå ville vært utestet/ubrukt kode |
| UA-11: dashboard/UI | B | Kun i masterplanens 'Bygges'-ROADMAP-liste, ikke i de tre faktiske akseptansekriteriene; `situations.*` fikk samme behandling |
| UA-11: business health/personal attention-kilder utover `situations` | B (delvis allerede dekket) | Sales/support/kontrakt/marketing/finans/produkt/drift flyter allerede inn via de 26 `OpenLoopType`-verdiene og den eksisterende broen (D-160 B) - personal/home/health-signaler er blokkert av UA-9/helse/lokasjon sine egne C-punkter over |
| UA-11: decision log/scenario/risikoregister/OKR/delegasjonstavle | A (men for stort for én slice) | Ordrett i 'Bygges'-listen, INGEN kanonisk datakilde finnes - egen, ny domenepakke, se Q-35 kandidat K2 |
| UA-11: akseptansekriterium 3 ('one control surface' for connector/provider/agent/autonomy-domene) | A (men krever et forutgående vedtak) | `situations` dekket; `OwnerControls`/`KillSwitch` fortsatt per-prosess, ikke durable/delt - se Q-35 kandidat K1 |
| UA-11: host-akseptanse-harness | B | Zero ny migrasjon/credential/leverandør i P0 - ingenting å bevise live |

## Neste-steg-kandidater (INGEN kode skrevet for disse denne runden)

Ingen av kandidatene under er valgt/implementert i denne audit-runden (D-163). Begge krever et
EKSPLISITT Tobias-vedtak før oppstart, se Q-35 for full kontekst:

- **K1 - Durable, delt owner-kontroll.** Gjør `OwnerControls`/`KillSwitch` durable og delt mellom
  api-/worker-prosessene (samme mønster som `DomainPauseRegistry`, D-160 F), deretter eksponer dem
  read-only via `executive.get_control_surface_status`. Høy blast radius (rører kjernen av
  autorisasjonspipelinen) - krever eksplisitt sign-off før start.
- **K2 - Decision log (kun det, ikke hele Bygges-listen).** Ny, liten `JARVIS_CANONICAL`-pakke etter en
  egen D-64-port. Krever ny persistens; ingen eksisterende kanonisk kilde å komponere mot.

## Dokumentasjonshull (registrert, ikke rettet i kode)

UA-7 (Communications Hub, D-119) og UA-8 (Personal Digital Twin, D-130/D-131) er kode-implementert og
dokumentert i `IMPLEMENTATION_PLAN.md`/`DECISIONS_AND_ASSUMPTIONS.md`, men har INGEN egen rad i
`docs/RUNTIME_GATES.md`. UA-9 (Vision) har samme mangel. Registrert som Q-35 - en fremtidig, ren
dokumentasjons-oppfølging, ikke en del av mandatet for denne audit-runden.
