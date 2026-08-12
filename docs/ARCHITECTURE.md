# Jarvis – arkitektur

**Status:** Utkast v1.0. Autoritativt hierarki: [CANONICAL_SPEC.md](CANONICAL_SPEC.md) gjelder ved motstrid.

## 1. Arkitekturprinsipper

1. **Modulær monolitt, få prosesser.** Logiske moduler i én kodebase; 3–5 produksjonsprosesser totalt.
   Moduler kommuniserer via typede interne kontrakter, slik at en modul senere kan skilles ut uten omskriving.
2. **Adapter foran alle leverandører.** LLM, STT, TTS, workflow-motor, lagring, varsling og
   hjemmestyring nås kun gjennom interne adaptere (`ModelGateway`, `SpeechAdapter`, `WorkflowAdapter`,
   `StorageAdapter`, `NotifyAdapter`, `HomeAdapter`). Ingen modul importerer en leverandør-SDK direkte.
3. **Deterministisk der det er mulig, LLM der det trengs.** Ruting av kjente intensjoner, policy-håndheving,
   godkjenninger og watchdog er ren kode. LLM brukes til samtale, analyse og planlegging.
4. **Alt er sporbart.** Hver handling knyttes til person, tenant, sesjon, jobb, policybeslutning, credential og kostnad.
5. **Flyttbarhet.** Alt kjører i containere med konfigurasjon via miljø; ingen komponent antar en bestemt
   maskin, region eller skyleverandør.

## 2. Prosesstopologi

```
                    ┌────────────────────────────────────────────────┐
 Terminaler         │                JARVIS CORE (API)               │
 ──────────         │                                                │
 Web-chat ────HTTP──▶  Identity │ Session │ Fast Router │ Context   │
 Mobil/Watch──HTTP──▶  Builder │ Conversation │ Task │ Orchestrator │
                    │  Policy Gateway │ Model Gateway │ Memory      │
 Rom-satellitt      │  Writer │ Notification                        │
   │ lyd (WebRTC)   └──────▲─────────────────────────▲──────────────┘
   ▼                       │ intern kontrakt         │
 ┌──────────────────┐      │                  ┌──────┴─────────┐
 │  VOICE GATEWAY   │──────┘                  │     WORKER     │
 │ VAD·AEC·STT·TTS  │                         │ durable jobs · │
 │ barge-in·rom     │                         │ agentprofiler ·│
 └──────────────────┘                         │ sandbox-kjøring│
                                              └──────┬─────────┘
        ┌──────────────────────────────────────────┐ │
        │ DATA: PostgreSQL (autoritativ) · objekt- │◀┘
        │ lagring · krypterte backuper             │
        └──────────────────────────────────────────┘
 Edge per sted: Home Assistant (enhetsbuss) · lokal fallback
 Sidekar: Watchdog (egen prosess) · Langfuse · vault
```

Prosesser i første produksjonsversjon: **Core**, **Voice Gateway**, **Worker**, **Watchdog** (+ database).
Voice Gateway er en egen prosess fordi sanntidslyd har helt andre latens-, oppetids- og skaleringsbehov
enn resten, og fordi en krasj i talekjeden aldri skal ta ned Core.

## 3. Moduler i Core

| Modul | Ansvar | Viktige grensesnitt |
|---|---|---|
| Identity Service | Personer, enheter, tenants, auth_strength, delegasjoner | `resolveIdentity(request) → IdentityContext` |
| Session Service | Sesjonskontinuitet på tvers av kanaler, aktiv tilstand, gjenopptak | `resumeOrCreate(identity, channel) → Session` |
| Fast Router | Deterministisk intensjonsruting (<100 ms), ingen LLM for kjente kommandoer | `route(input) → FastAction \| ConversationTurn \| JobRequest` |
| Context Builder | Hybrid retrieval fra autoriserte memory spaces innen tokenbudsjett | `build(session, query, budget) → Context` |
| Conversation Engine | Dialog, tur-taking, svarstil, avbrytelse, streaming | `converse(context) → TokenStream` |
| Task Service | Jobb-livssyklus, status, artefakter, varsling | `create/get/cancel/resume(task)` |
| Orchestrator | Planlegging av flertrinnsjobber, delegering til agentprofiler | `plan(job) → Steps`, `dispatch(step)` |
| Policy Gateway | Kontroll av ALLE verktøykall: capability-klasse, mandat, godkjenning, rate | `authorize(toolCall, identity) → Allow \| Deny \| NeedsApproval` |
| Model Gateway | Provideradaptere, modellvalg, budsjett, fallback, rate limits | `complete(request) → Stream`, `embed(texts)` |
| Memory Writer | Uttrekk, dedup, karantene, versjonering, relasjonsbygging | `propose(rawEvent) → ADD\|UPDATE\|INVALIDATE\|NOOP` |
| Notification Service | Telegram, push, e-post, Watch-godkjenninger | `notify(target, message, severity)` |

**Regel:** Alle verktøykall – også fra rask bane – går gjennom Policy Gateway. Rask bane hopper over
LLM-en, aldri over policyen.

## 4. Voice Gateway (egen prosess)

Ansvar: WebRTC-/WebSocket-transport, VAD, ekkokansellering, støyreduksjon, streaming STT inn,
streaming TTS ut, barge-in (≤250 ms stopp av avspilling), romsesjoner og sesjonsgjenopptak etter
failover. Kommuniserer med Core over en typet intern kontrakt (tekst + metadata inn, tekststream +
handlinger ut). Detaljer: [VOICE_ARCHITECTURE.md](VOICE_ARCHITECTURE.md).

## 5. Worker og sandboxing

Worker-prosessen kjører durable jobber bak `WorkflowAdapter`. Agentkjøring (Claude Code/Codex) skjer i
kastbar container per jobb (WSL2/Docker på PC-en): eget filsystem, nettverksallowlist, jobbspesifikke
tokens, ingen hovednøkler. Produksjonsendringer krever PR + tester + menneskelig merge-gate.
Detaljer: [SECURITY_MODEL.md](SECURITY_MODEL.md).

## 6. Dataflyt og lagring

PostgreSQL er den autoritative databasen: identitet, sesjoner, hendelseslogg, minne (alle lag), jobber,
policy, audit og kostnad. Objektlagring for artefakter, lyd-snutter (kun der DPIA tillater) og eksporter.
Menneskelesbar minneeksport genereres fra databasen – aldri motsatt vei.
Detaljer: [MEMORY_ARCHITECTURE.md](MEMORY_ARCHITECTURE.md).

## 7. Edge og steder

Per fysisk sted (hus, hytte): Home Assistant som enhetsbuss + lokal fallback for kritiske
hurtigkommandoer når sky/nett er nede. Sikkerhetsautomasjoner (lås, alarm, varme) er deterministiske i
HA og avhenger aldri av LLM eller skytilkobling. Detaljer: [INTEGRATIONS.md](INTEGRATIONS.md).

## 8. Observability

- **Langfuse** (selvhostet): traces for modellkall, kostnad, latency, evals – alt koblet til `task_id`.
- **Strukturert logging** (JSON) med correlation-ID = `session_id`/`task_id`.
- **Systemmetrics** separat (container-helse, disk, RAM, GPU, temperatur).
- **Watchdog** (egen prosess, også ekstern sjekk): uptime, P95, kø, backup, fastlåste jobber, tokenutløp.
  Kun eksplisitte, reversible tiltak (restart av én tjeneste). Varsling til Telegram med alvorlighetsgrad og runbook.

## 9. Repostruktur (monorepo)

```
jarvis/
├── apps/
│   ├── api/            # Core-prosessen (modulær monolitt)
│   ├── web/            # Webchat-klient
│   └── voice-gateway/  # Egen sanntidsprosess
├── modules/            # Logiske moduler brukt av apps/api
│   ├── core/  memory/  tasks/  policy/  notifications/
├── workers/
│   ├── runner/         # Durable worker-prosess
│   └── profiles/       # Agentprofiler (executive, coding, research, verifier)
├── integrations/       # home-assistant, github, google, telegram, ...
├── packages/
│   ├── contracts/      # Typede kontrakter, skjemaer, hendelsesformat (delt av alt)
│   ├── provider-adapters/
│   └── observability/
├── infra/              # docker-compose (local), senere cloud/edge
└── docs/               # Denne dokumentasjonen
```

Logisk struktur – ikke én deploy per mappe. `packages/contracts` er den eneste delte avhengigheten alle
moduler kan importere fritt; alt annet går via definerte grensesnitt.

## 10. Bevisste avvik fra masterplanen

Se [DECISIONS_AND_ASSUMPTIONS.md](DECISIONS_AND_ASSUMPTIONS.md) for full liste. Viktigst:

- `apps/mobile` og `apps/desktop` opprettes først i fase 8 – ikke tomme mapper fra dag én.
- Workflow-motor starter Postgres-basert (pg-boss el.l.) bak `WorkflowAdapter`; administrert
  Trigger.dev-sky strider mot lokal-først-prinsippet og vurderes først i fase 6.
- Supabase-sky er valgfritt; kravet er ren PostgreSQL med RLS, pgvector, tsvector og pgmq – som kjører
  identisk lokalt i Docker.
