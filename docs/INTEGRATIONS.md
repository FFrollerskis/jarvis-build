# Jarvis – integrasjoner

**Status:** Utkast v1.0. Ved motstrid gjelder [CANONICAL_SPEC.md](CANONICAL_SPEC.md).

## 1. Prinsipper

1. **Alt går gjennom Tool Gateway.** Ingen modul kaller eksterne API-er direkte; hvert verktøy er
   registrert med skjema, capability-klasse, scopes, rate limit og audit.
2. **Offisielt API foretrekkes** fremfor nettleserautomatisering. Nettleser er siste utvei og kjører da i
   sandbox med egne begrensninger.
3. **Egne credentials per integrasjon** med minst mulig scope, lagret i vault, aldri i kode.
4. **MCP-servere er ubetrodde inntil verifisert:** låses til eksplisitte skjemaer, minst mulig tilgang,
   output behandles som Ingestion Zone-innhold.
5. **Alle integrasjoner er utbyttbare:** Gmail↔Outlook, Google↔Proton osv. bak samme interne kontrakt.

## 2. Verktøyregister (Tool Gateway)

Hvert verktøy registreres med:

```
{ tool_id, navn, beskrivelse, json-skjema (input/output), capability_klasse (A–D),
  scopes, tillatte_datasoner, nettverksmål, rate_limit, kostnadsmodell,
  rollback_prosedyre, eier, credential_referanse }
```

Policy Gateway bruker registeret ved autorisasjon; Orchestrator bruker det ved planlegging.
Prompt injection-test er obligatorisk før et verktøy med klasse C/D aktiveres.

## 3. Første bølge (fase 7, rekkefølge etter verdi/risiko)

| Integrasjon | Formål | Klasse (typisk) | Merknad |
|---|---|---|---|
| GitHub | Kode, PR-er, issues for Coding Worker | B/C | Issues/PR-tekst = ubetrodd innhold |
| Google Calendar | Lese/foreslå avtaler | A (lese), C (skrive) | Skriving krever mandat |
| Gmail | Lese, utkast, sende | A (lese), C/D (sende) | Sending alltid med godkjenning i starten |
| Google Drive/Docs | Dokumenter | A/B | |
| Telegram | Varsling + fjern-godkjenning + chat-kanal | B | Første varslingskanal |
| Supabase/Postgres | Egen datalagring | – | Intern, ikke via Tool Gateway |
| Vercel | Deploy av web | C | |
| Google Cloud | Ev. sky-ressurser | C | Kun ved behov |
| Claude Code / Codex | Kodeagenter i sandbox | via Worker | Se SECURITY_MODEL §5 |
| OpenAI / Anthropic API | Modeller via Model Gateway | – | Ikke et «verktøy», men provider |
| Home Assistant | Enhetsbuss (se §5) | A/B/C, sikkerhet=D | |

## 4. Andre bølge (etter fase 7)

Kundeoppfølging/Dennis og CRM, Slack/Teams og møtesystemer, telefoni/SMS/VoIP, Fiken/Folio
(økonomi, kun avgrensede grensesnitt), nettsideovervåking/kostnad/SLA, bil- og hvitevare-API-er,
Apple Health (kun via kontrollert mobilintegrasjon, `health`-space-regler gjelder).

## 5. Home Assistant (spesialrolle)

- HA er **enhetsbuss og kontrollag** for fysiske enheter – aldri samtalemotor, aldri Jarvis-identitet.
- Jarvis → HA: via HA sitt API som registrert verktøy (klasse B for lys/klima; **klasse D for lås, alarm og
  sikkerhetsfunksjoner**).
- Sikkerhetsautomasjoner (frostsikring, lekkasjestopp, alarm) ligger deterministisk i HA og virker uten
  sky, uten Jarvis og uten LLM.
- HA Assist beholdes som lokal reservevei for grunnkommandoer når Voice Gateway er nede.
- Per sted (hus, hytte): egen HA-instans med rommetadata (`site_id`, `room_id`) som mappes til
  identitetsmodellen.

## 6. Modell-leverandører (via Model Gateway, ikke Tool Gateway)

- OpenAI, Anthropic, OpenRouter og lokale modeller bak felles adapter (LiteLLM-kandidat, se
  DECISIONS D-06).
- Per leverandør dokumenteres: region, databehandleravtale, trenings-/retensjonsvilkår, og hvilke
  memory spaces som er tillatt å sende dit (f.eks. `health` → kun lokal modell eller sterkt minimert).
- STT/TTS-leverandører følger samme regime og velges via benchmark i fase 5.

## 7. Feilhåndtering og robusthet

- Hver integrasjon har: helsesjekk, retry-policy med backoff, rate limit-håndtering, tokenutløpsvarsling
  (via watchdog) og dokumentert rollback.
- Integrasjonsfeil skal degradere funksjonalitet – aldri ta ned Core.
- All output fra integrasjoner går inn som hendelser i eventloggen med kilde og tillitsklasse.
