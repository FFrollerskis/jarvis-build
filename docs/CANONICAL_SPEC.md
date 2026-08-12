# Jarvis – kanonisk spesifikasjon

**Status:** Utkast v1.0 – venter på Tobias sin godkjenning før implementering.
**Kilde:** [docs/input/01_Jarvis_Masterplan_v2.1.md](input/01_Jarvis_Masterplan_v2.1.md) (masterplan v2.1, 12. august 2026) + kritisk gjennomgang dokumentert i [DECISIONS_AND_ASSUMPTIONS.md](DECISIONS_AND_ASSUMPTIONS.md).

Dette dokumentet er den autoritative spesifikasjonen. Ved motstrid mellom dokumenter gjelder:
`CANONICAL_SPEC.md` > øvrige docs/-dokumenter > masterplan-PDF > eldre notater.

---

## 1. Hva Jarvis er

Jarvis er Tobias sitt personlige, langsiktige AI-operativsystem: én identitet, ett logisk minne, tilgjengelig
fra alle terminaler (web, PC, mobil, Watch, rom-satellitter, bil), med evne til å delegere arbeid til
underagenter og verktøy, og med deterministisk håndhevet sikkerhet.

### 1.1 Absolutte krav (ikke forhandlingsbare)

1. Én Jarvis-identitet på tvers av alle terminaler.
2. Ett logisk minnesystem med strengt adskilte sikkerhetsområder (memory spaces).
3. Samme samtale, prosjekter og arbeidskø på tvers av enheter.
4. Full-duplex tale (streaming, barge-in, avbrytelse) fra første talepilot.
5. Lange jobber overlever at terminalen kobles fra.
6. Delegering til Claude Code, Codex og spesialiserte agentprofiler.
7. Home Assistant er enhetsbuss og kontrollag – aldri samtalemotor eller hjerne.
8. Alle leverandører (LLM, STT, TTS, lagring, workflow) byttes gjennom adaptere.
9. Ubetrodd innhold får aldri samtidig tilgang til privat minne og utgående handlinger.
10. Kritiske handlinger håndheves av deterministisk kode og signerte godkjenninger – aldri kun promptregler.
11. Full sporbarhet: beslutning, handling, kilde, kostnad og resultat.
12. Start billig på eksisterende PC; flytt til server/sky uten omskriving.
13. Hemmeligheter finnes aldri i kildekode eller i LLM-kontekst.

### 1.2 Eksplisitte ikke-mål i første versjon

- Ingen mikrotjeneste-arkitektur (3–5 produksjonsprosesser er taket).
- Ingen autonom selvreparasjon (kun deterministisk watchdog med reversible handlinger).
- Ingen egen grafdatabase før Postgres-relasjonslaget beviselig ikke strekker til.
- Ingen Temporal før målt volum forsvarer driftsbyrden.
- Ingen kontinuerlig lagring av rå romlyd.
- Ingen stemmeprofil som eneste autentisering for kritiske handlinger.

## 2. Systemoversikt

Modulær monolitt med få prosesser:

| Prosess | Ansvar |
|---|---|
| **Jarvis API/Core** | Identitet, sesjoner, kontekstbygging, dialog, rask ruter, policy, oppgaver, minne-skriving |
| **Voice Gateway** | Sanntidslyd: WebRTC, VAD, AEC, støyreduksjon, streaming STT/TTS, barge-in, romsesjoner |
| **Worker** | Durable bakgrunnsjobber, agentprofiler, isolert Claude Code/Codex-kjøring |
| **Data** | PostgreSQL (autoritativ), objektlagring, krypterte backuper |
| **Watchdog** | Deterministisk overvåking, Telegram-varsling, reversible tiltak |

Edge (per fysisk sted): Home Assistant + lokal fallback. Detaljer i [ARCHITECTURE.md](ARCHITECTURE.md).

### 2.1 Samtaleflyt (normalflyt)

1. Terminal sender lyd/tekst med identitets- og stedsmetadata.
2. Voice Gateway eller API oppretter/gjenopptar `session_id`.
3. **Fast Router** klassifiserer: enkel kommando / samtale / kompleks jobb.
4. Context Builder henter autorisert minne fra tillatte memory spaces innen tokenbudsjett.
5. Enkel kommando → deterministisk verktøy direkte (ingen stor LLM).
6. Samtale → valgt modell via Model Gateway (streaming).
7. Kompleks oppgave → varig jobb hos orkestrator/worker.
8. **Policy Gateway kontrollerer alle verktøykall før utførelse.**
9. Resultat, kilde, kostnad, verifikasjon og artefakter lagres.
10. Svar streames tilbake; langvarig arbeid fortsetter i bakgrunnen.

## 3. Identitet og tenancy

Hver forespørsel bærer minst: `person_id`, `tenant_id`, `memory_space_id`, `session_id`, `device_id`,
`site_id`, `room_id`, `channel`, `auth_strength`, og `delegation_id` når en agent handler på vegne av Tobias.

Memory spaces: `personal`, `business`, `project`, `health`, `home`, `guest`, `shared`.
Context Builder krever eksplisitt tillatelse per område. Helsedata behandles lokalt eller sterkt minimert og
blandes aldri inn i generelle agentjobber. Full modell i [MEMORY_ARCHITECTURE.md](MEMORY_ARCHITECTURE.md)
og [SECURITY_MODEL.md](SECURITY_MODEL.md).

## 4. Kjernetjenester (logiske moduler i Core)

Identity Service, Session Service, Context Builder, Conversation Engine, Fast Router, Task Service,
Orchestrator, Policy Gateway, Model Gateway, Memory Writer, Notification Service.
Ansvarsbeskrivelser i [ARCHITECTURE.md](ARCHITECTURE.md).

**Rutingprinsipp:** Rask bane (deterministisk, <100 ms ruting) for kjente intensjoner: lys/klima/avspilling,
kalenderlesing, system- og oppgavestatus. Intelligent bane (LLM) for samtale, minnespørsmål, analyse og
flertrinnsplanlegging. En full LLM-orkestrator er aldri obligatorisk foran en enkel kommando.

## 5. Agenter og jobber

MVP-agentprofiler: **Jarvis Executive** (dialog/prioritering/sluttsvar), **Coding Worker** (Claude
Code/Codex, tester, PR-er), **Research Worker** (kildekritisk research), **Verifier** (uavhengig kontroll).
Fremtidige roller innføres som prompt-/verktøyprofiler, ikke egne tjenester.

Jobbkontrakt (obligatorisk for alle jobber): `task_id`, eier, tenant, mål med maskinelle akseptansekriterier,
inngangsdata med tillitsnivå/proveniens, tillatte verktøy/datasoner/nettverksmål, agentprofil,
modellbudsjett, tidsfrist, retry-policy, maks steg, artefakter, logger, kostnad, verifikasjon og sluttstatus.

Workflow-motor: skjules bak internt `WorkflowAdapter`. Valg av konkret motor (pg-boss/Postgres-basert
først; Trigger.dev eller Hatchet vurderes i fase 6) – se [DECISIONS_AND_ASSUMPTIONS.md](DECISIONS_AND_ASSUMPTIONS.md) D-07.

## 6. Minne (sammendrag – autoritativ detalj i MEMORY_ARCHITECTURE.md)

Hybridminne i PostgreSQL: rå hendelseslogg → strukturert sannhet → fulltekst (tsvector) → vektor
(pgvector) → relasjonslag (`entities`/`relations`) → sammendragslag → reranking. Ren pgvector er
utilstrekkelig og er eksplisitt forkastet som eneste løsning.

Minnetyper: working, episodisk, semantisk, prosedyre, preferanse, relasjon, prosjekt, operativt,
beslutninger/forpliktelser, arkiv. Hvert minne har eier, tenant, memory space, kilde, tidsstempel,
gyldighetsperiode, sensitivitet, tillitsnivå, konfidens, versjon, relasjoner og retensjonsregel.

Skriveflyt med karantene for ubetrodd innhold, versjonering av motstrid (aldri overskriving), og
menneskelesbar eksport til mappestruktur. Eval-sett (50–100 spørsmål fra reell historikk) før minnet får
høy autoritet; null kryss-tenant-lekkasje er absolutt krav.

## 7. Modellstrategi

Model Gateway standardiserer OpenAI, Anthropic, OpenRouter og lokale modeller bak adapter.
Ruting vurderer oppgavetype, kvalitetskrav, latensbudsjett, sensitivitet/region, kontekstmengde,
kostnadstak, verktøybehov og tilgjengelighet/fallback.

Kostnadskontroll (håndheves i kode, ikke dashboard): varsel ved 1 000 kr/mnd, aktiv godkjenning ved
2 000 kr/mnd, hardgrense ved 3 000 kr/mnd med signert overstyring. Kostnad knyttes til `task_id`.
Billig modell for klassifisering; frontier-modell kun ved behov; lokal modell når personvern/latens/økonomi
forsvarer det. Grensene revideres etter 30 dager.

## 8. Tale (sammendrag – autoritativ detalj i VOICE_ARCHITECTURE.md)

Voice Gateway er en egen sanntidsprosess, adskilt fra Core. Full-duplex fra første pilot: WebRTC-transport,
streaming STT, streaming TTS, VAD, AEC, støyreduksjon, barge-in ≤250 ms, sesjonsgjenopptak.
Home Assistant Assist er kjørbar reservevei – aldri autoritativ samtalemotor eller egen identitet.
Norsk provider-benchmark (≥100 lydprøver) og tale-DPIA er porter før valg låses. Fire ukers stop/go-gate.

## 9. Sikkerhet (sammendrag – autoritativ detalj i SECURITY_MODEL.md)

Fem tillitszoner: Ingestion, Reasoning, Memory, Execution, Secret. Capability-klasser A (lese), B (reversibel
intern), C (ekstern innen mandat), D (betaling/kontrakt/sletting/publisering/lås/alarm/tilgang).
Klasse D krever signert godkjenningsobjekt (handling, parametere, utløpstid, engangs-ID, godkjennende
enhet) verifisert i deterministisk kode. Workers kjører i kastbare containere med nettverksallowlist og
jobbspesifikke tokens. Secrets: SOPS + age i fase 1, sentral vault senest ved eksterne integrasjoner
(D-16); append-only audit utenfor agentprosessen; kill switch.

## 10. Personvern

Behandlingsoversikt, DPIA (inkl. talelyd), databehandleravtaler og region-/retensjonsmatrise per
leverandør (LLM, STT, TTS, realtime) før bedrifts-, gjeste- eller helsedata kobles inn. RLS og separate
nøkler per tenant. Pseudonymisering/dataminimering før eksterne modellkall. Ingen kontinuerlig lagring
av rå romlyd. Gjestemodus, fysisk mute, synlig lytteindikator.

## 11. Drift (sammendrag – autoritativ detalj i DEPLOYMENT_STRATEGY.md)

Lokal drift først (Tobias sin Windows-PC med Docker/WSL2), deretter alltid-på node/server/sky når måling
forsvarer det. Langfuse-basert observability koblet til `task_id`. Deterministisk watchdog med
Telegram-varsling. RTO/RPO-tiers: Tier 1 (identitet/DB) RPO ≤2 t, RTO ≤4 t; Tier 2 (oppgaver) RPO ≤4 t,
RTO samme dag; Tier 3 (arkiv) daglig/ukentlig. Restore testes med tidtaking.

## 12. Implementering

Ti faser, definert i [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Fase 1 er et lite, kjørbart
fundament (repo, kontrakter, policy-skjelett med tester, sikkerhetsdokumenter) – ikke hele Jarvis.
Ingen applikasjonskode skrives før Tobias har godkjent fase 1-innholdet.
