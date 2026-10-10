# Langfuse og Infisical som kontrollerte mål (WP-E1, UA-5) - metadata uten innhold/verdier

**Status (2026-10-09): BYGGET OG TESTET MOT LOKALE FAKE-SERVERE - IKKE KJØRT MOT DEN EKTE LANGFUSE/INFISICAL PÅ NAS-en.** API-formene er verifisert mot leverandørenes
dokumentasjon via søk 2026-10-09 (direkte nedlasting var blokkert i byggemiljøet); alt som ikke kunne bekreftes står som `NOT VERIFIED`. Begge er SOVENDE: de bruker de
EKSISTERENDE variablene (ingen ny credential) og gjør ingenting uten dem.

**D-64:** Langfuse og Infisical er ADAPTERE (`EXTERNAL_CANONICAL`) bak henholdsvis `TraceSink` og `SecretProvider` - Jarvis eier policy, revisjon, journal og eierens credential-binding; ingen
domenemodell avhenger av deres API-form (`CORE_DEPENDENCY_DECISION_REQUIRED=false`). **D-41:** lesing er klasse A; Infisical-rotasjon er klasse D. Resten står i §4 som `DEFERRED`/`PARTIAL`.

## 1. Langfuse (verktøy-id `langfuse`, kun klasse A)

| Handling | Hva | Merknad |
|---|---|---|
| `get_health` | `GET /api/public/health?failIfDatabaseUnavailable=true` (uten autentisering) | 200 = OK, 503 = nede/DB utilgjengelig. `version` leses defensivt (feltet er ikke bekreftet i dokumentasjonen) |
| `get_project` | `GET /api/public/projects` (Basic-auth) | prosjekt-id/-navn/organisasjon + **maskert** public key (`pk-lf-xxx…abcd`) - bekrefter at nøkkelparet er gyldig. Aldri secret key |
| `get_trace_counts` | `GET /api/public/metrics/daily` (siste N dager, maks 31); fallback `traces?limit=1` og KUN `meta.totalItems` | **kun tall** (traces/observasjoner/kost per dag). Aldri prompt, svar, bruker, sesjon eller metadata. Endepunktet er markert deprecated i nyere Langfuse; finnes i selvhostet v2 |

Bruker `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY` og `LANGFUSE_SECRET_KEY` (de samme som trace-sinken). `LANGFUSE_BASE_URL` kan være den selvhostede instansen (`http://langfuse:3000`) eller Langfuse Cloud - en Cloud-adresse
betyr at tellingene hentes fra leverandøren (se `docs/security/PROCESSOR_REGION_MATRIX.md`). Basis-URL-en må være en ren opprinnelse (`http(s)://vert[:port]`); sti, query og brukerinfo avvises.

## 2. Infisical (verktøy-id `infisical`)

| Handling | Klasse | Hva |
|---|---|---|
| `get_health` | A | `GET /api/status` (offentlig): svarer instansen; e-post/redis konfigurert |
| `list_secret_metadata` | A | navn, versjon, opprettet/endret, **alder i dager**, tagger, rotasjonsflagg, `stale` mot `max_age_days` (standard 90) for prosjektets miljø og sti |
| `get_secret_metadata` | A | det samme for én secret (null hvis den ikke finnes) |
| `list_secret_rotations`, `get_rotation` | A | Secret Rotation V2: type, status, sist/neste rotasjon. `available:false` hvis funksjonen ikke er tilgjengelig i instansen (lisens) |
| `rotate_secrets` | **D** | `POST /api/v2/secret-rotations/{type}/{id}/rotate-secrets`. Typen leses fra Infisicals egen liste (aldri fra kaller) og valideres som ren sti-token. Kun rotasjons-id-er i `JARVIS_INFISICAL_ROTATION_IDS` |

**Aldri verdier.** Metadata hentes med `viewSecretValue=false` og svaret hvitlistes feltvis: `secretValue`, `secretComment` og metadata-felt kopieres aldri videre - bevist av test med en server som ignorerer parameteren og sender verdiene likevel. Hverken svar,
revisjon, ledger, journal eller varsel inneholder en verdi. Rotasjonens før-/etter-tilstand er STATUS og TIDSPUNKT, ikke verdier.

Bruker maskin-identiteten som allerede er i api/worker (`INFISICAL_URL`, `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_PROJECT_ID`, `INFISICAL_ENV`) via universal-auth - samme identitet som `InfisicalSecretProvider`. Tokenet caches kun i minnet
og fornyes ved 401. Hva identiteten faktisk får gjøre bestemmes av rollen du har gitt den i Infisical (**EIERHANDLING:** for rotasjon må identiteten ha tilgang til Secret Rotation i prosjektet - **NOT VERIFIED** hvilke eksakte rettigheter som kreves).

**Step-up (gjennomgang av PR #324, M2).** `rotate_secrets` har `step_up_required: true`: `ToolGateway` nekter uten en enhetssignert økt fra web/desktop/api/mobile (aldri tale/Telegram/meldingsplattform/system), og `POST /infra/cloud/mutate` gir `403 step_up_required` / `403 owner_required` før noe journalføres.
Standard = strengest; kan lempes av Tobias med en navngitt D-beslutning. Lesing (klasse A) krever aldri step-up.

**Leverandørtekst (gjennomgang av PR #324, M1).** `lastRotationJobError`, rotasjonsnavn/-status, statusmeldinger, tagger og Langfuses prosjekt-/organisasjonsnavn og feilmeldinger går gjennom den sentrale hemmelighetsskanneren (`vendor-text.ts`) FØR de forlater transporten (en rotasjonsfeil kan sitere en
tilkoblingsstreng med passord eller et Bearer-token, og svaret havner i `tool_executions` og `audit_events`); tidsstempel-, dato- og id-felt godtas kun i sin egen form. Bevist av tester med fiendtlige seed-verdier i alle fake-serverne. Ingen redirects følges (L2).

**Rotasjon (klasse D) - kjeden:** mål-autorisasjon (id står i `JARVIS_INFISICAL_ROTATION_IDS`) FØR noen I/O → preflight (rotasjonen finnes) → snapshot av status/tidspunkt → idempotens-nøkkel påkrevd → rotasjon → readback (ny listing: ikke feilet, `lastRotatedAt` innenfor 10 minutter) → umiddelbar Telegram-varsling → journal i `infra_executions`.
Ærlig gjenoppretting: **ingen teknisk reversering** - forrige verdi ligger i Infisicals versjonshistorikk og må gjenopprettes manuelt der; avhengige tjenester må hente ny verdi. `PAUSED` stanser rotasjon, `DEGRADED` stanser klasse D, lesing stanses aldri.

## 3. Konfigurasjon

| Variabel | Standard | Effekt |
|---|---|---|
| `LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | (eksisterende) | Langfuse-tilkobling. Uten secret key: `credential_unavailable` |
| `INFISICAL_URL` / `INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET` / `INFISICAL_PROJECT_ID` / `INFISICAL_ENV` | (eksisterende) | Infisical-tilkobling. Uten klient-hemmelighet: `credential_unavailable` |
| `JARVIS_INFISICAL_ROTATION_IDS` | tom | kommaseparert liste av EKSAKTE rotasjons-id-er (UUID) Jarvis får rotere. Tom = ingen rotasjon. Kun `.env` + restart, aldri dashbord/modell. Finn id-ene med `list_secret_rotations` |

## 4. Kjente begrensninger (D-41: `DEFERRED`/`PARTIAL`)

**Langfuse**
- **DEFERRED:** sletting av traces/sesjoner (`DELETE /api/public/traces…`) - ikke verifisert mot selvhostet v2.95.x (nyere Langfuse sletter asynkront uten bekreftelse, maks 30-50 id-er per kall), irreversibelt og uten gjenopprettingsvei. Erasure-gapet for Langfuse står fortsatt i `docs/DATA_ERASURE.md` og krever en egen eierbeslutning og et verifisert endepunkt/readback.
- **DEFERRED:** opprette/slette prosjekt-API-nøkler og nøkkelrotasjon (`/api/public/projects/{id}/apiKeys`) - krever en organisasjons-nøkkel og Enterprise Edition ved selvhosting; den nye secret key returneres én gang og må rett inn i Infisical uten å passere modell/logg.
- **PARTIAL:** nøkkel-metadata = prosjekt + maskert public key (nøkkellisten er DEFERRED over). **NOT VERIFIED:** `version` i helsesvaret og `fromTimestamp`/`toTimestamp` på trace-listen (fallback).
- Prompts, datasett, scores, annotering: produktfunksjoner utenfor UA-5.

**Infisical**
- **PARTIAL:** rotasjonsstatus og `rotate_secrets` - eksakte statusverdier, feltnavn for siste feil og svarkroppen til rotate er ikke bekreftet (leses defensivt; readback via ny listing). Rotasjon kan være lisensbegrenset - da meldes den som `available:false`.
- **Verdiskriving** (opprette/oppdatere secret) dekkes av den eksisterende eierveien `owner_controls.set_connector_credential` (D-213, step-up) og er bevisst ikke duplisert.
- **DEFERRED:** slette secret (ingen verdifri gjenopprettingsvei - verdien kan ikke snapshottes uten å lese den), rotasjonskonfigurasjon, maskin-identiteter/prosjekter/medlemmer/tilganger (privilegie-eskalering: identiteten her leser alle connector-hemmeligheter - krever en egen, isolert identitet og eierbeslutning), snapshots/point-in-time-rollback (plan-/lisensbegrenset).
- Endepunktet `GET /api/v3/secrets/raw` er markert deprecated i dokumentasjonen, men er det den eksisterende provideren allerede bruker; ved Infisical-oppgradering må begge flyttes sammen.

## 5. Bruk og akseptanse (`NOT VERIFIED` til du har kjørt den; alle kall med `grant_token` i kroppen)

```
POST /infra/cloud/read
{ "grant_token": "<session-grant>", "provider": "infisical", "action": "list_secret_metadata", "parameters": { "max_age_days": 90 } }
```
`/infra/cloud/read` når KUN registrerte klasse A-handlinger i de fire verktøy-id-ene (`cloudflare`, `langfuse`, `infisical`, `postgres_ops`): en skrive-handling (f.eks. `cloudflare.purge_cache`) gir `400 cloud_read_not_a_read_action` og et annet verktøy-id `400 cloud_read_unknown_action`, begge FØR gatewayen eller leverandøren røres
(gjennomgang av PR #324, M33 - tabelltest utledet fra de registrerte definisjonene). Skriving går alltid via `/infra/cloud/mutate` (eier + step-up + journal). `/infra/cloud/mutate` med et ukjent leverandørnavn (også `constructor`/`__proto__`) gir `cloud_mutation_unknown_provider:<navn>` (L8).

1. `langfuse.get_health` → `healthy: true`; `langfuse.get_project` → riktig prosjekt og maskert nøkkel; `langfuse.get_trace_counts` → tall som stemmer med Langfuse-dashbordet.
2. `infisical.get_health` → `healthy: true`; `list_secret_metadata` → dine connector-nøkler med alder; **kontroller at ingen verdi står i svaret** (søk etter en kjent verdi).
3. `list_secret_rotations` → `available: true/false` (hvis `false`: ingen rotasjon er konfigurert eller funksjonen er ikke tilgjengelig - det er OK).
4. (Kun hvis du har en V2-rotasjon du tåler å rotere, helst mot en test-nøkkel) legg id-en i `JARVIS_INFISICAL_ROTATION_IDS`, restart, kjør
   `POST /infra/cloud/mutate { "provider": "infisical", "action": "rotate_secrets", "parameters": { "rotation_id": "<uuid>" }, "idempotency_key": "rot-1" }`
   → forventet `verification_outcome: SUCCESS`, Telegram-varsel og en `infra_executions`-rad uten verdier. Prøv en id som IKKE står i listen → `infisical_rotation_not_authorized`.
5. `POST /infra/pause`: lesing virker, rotasjon gir `infra_paused`. `POST /infra/resume`.

## 6. Avvikling

Tøm `JARVIS_INFISICAL_ROTATION_IDS` + restart for å stoppe rotasjon. Lesing slås av ved å fryse connectoren (`owner_controls.freeze_connector` med `infisical`/`langfuse`) eller fjerne credential. Maskin-identiteten kan alltid tilbakekalles i Infisical.

## 7. Driftsstatus og hendelser

Helse og siste journalførte endring for alle skymål (og åpne hendelser, produsentenes helse) leses samlet med `executive.get_infra_status` (chat) / `POST /infra/overview`. Hendelsesprodusentene, livssyklusen og sannhetsregimet er beskrevet i `docs/runbooks/INCIDENT_LIFECYCLE.md`.
**Kun eieren fra en signert enhetsøkt (gjennomgang av PR #324, M3/L4):** `get_infra_status` har samme lese-port som kontrollsentrene (eier OG `auth_strength: signed`, fail-closed også uten eier-register; avslaget er en vanlig `tool.denied`-revisjonsrad), står ikke på tale (`VOICE_EXCLUDED_KEYS`) og er sensitivitetsmerket `private`.
`POST /infra/overview` gir i tillegg `403 owner_required` for alle andre enn den suverene eieren.
