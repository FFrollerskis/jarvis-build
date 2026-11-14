# WP-K: rester fra funnregisteret (JARVIS-018, 053, 054, 056, 068)

**Status (2026-11-14): BYGGET OG TESTET MOT EKTE POSTGRES, EKTE LOKALE HTTP-SERVERE OG FAKES - IKKE KJØRT MOT NAS-en, IKKE DEPLOYET, INGENTING ER `VERIFIED`.**
Beslutning: D-471 (føres i beslutningsloggen av arkitekt/Tobias; denne grenen rører ikke `DECISIONS_AND_ASSUMPTIONS.md`). Branch `claude/wp-k-ledger-rester`. Forrige tilstand per funn står i
[FINDINGS_LEDGER.md](../remediation/FINDINGS_LEDGER.md) (kun de fem radene er endret). `CORE_DEPENDENCY_DECISION_REQUIRED=false` (ingen ny leverandør; D-64 uberørt).
Migrasjon: **108** (`108_policy_decision_journal.sql`) er den eneste; 109 er ikke brukt.

## 1. Oversikt

| Funn | Hva er bygget | Statusord | Standard | Slå på / av |
|---|---|---|---|---|
| JARVIS-018 | Avbruddssignal på `ToolTransport` (5. parameter `signal?` + ambient kontekst); tidsavbrudd avbryter forespørselen; ingen retry av ikke-idempotent POST etter tidsavbrudd | `CODE_FIXED` (delvis) | **PÅ** (feilretting av kallkontrakten, ingen flagg) | ingen flagg; tilbakerulling = tilbakerull committen |
| JARVIS-053 | Varig, tenant-skopet policy-journal (`policy_decisions`) bak `PolicyGateway`s `auditSink`; avgrenset kø med mottrykk; sink-feil endrer aldri en avgjørelse | `CODE_FIXED` (delvis) / `DORMANT` til flagget settes | **AV** | `JARVIS_POLICY_AUDIT_SINK=db` (api og worker) |
| JARVIS-054 | `task_id`/`trace_id` fra planlagte kjøringer inn i `system`-kall; `decision_id` i hver revisjonsrad | `CODE_FIXED` (delvis) | **PÅ** (additive metadata, ingen flagg) | ingen flagg |
| JARVIS-056 | Google-klientens id/secret leses hvelv-først (dashbord/Infisical), miljøet er logget-deprecated fallback; Drive-sjekken er hvelv-bevisst | `CODE_FIXED` (delvis); hemmelighetsrotasjon er `BLOCKED_EXTERNAL` (Tobias) | **PÅ** (uendret oppførsel så lenge verdiene står i `.env`) | fjern verdien fra hvelvet = miljøet brukes igjen |
| JARVIS-068 | Avstemt mot WP-E1 (D-461): rad satt til `CODE_FIXED` (delvis); to små rester bygget (motsigelses-mål, `tests_basis`/`connectivity_scope`) | `CODE_FIXED` (delvis) | **PÅ** (additive felt + én ny avvisning) | ingen flagg |

Alt under er `CODE_FIXED`, ikke `DEPLOYED_UNVERIFIED` og ikke `VERIFIED`: kode + tester finnes og består i sandkassen; ingenting er observert på NAS-en.

## 2. Flagg og miljøvariabler

| Variabel | Prosess | Standard | Verdi | Virkning |
|---|---|---|---|---|
| `JARVIS_POLICY_AUDIT_SINK` | api, worker | tom = **AV** | kun eksakt `db` (store/små bokstaver) slår på; en ukjent verdi tolkes som AV og meldes ved oppstart (`policy_audit_sink_unknown_value`) | `PolicyGateway` får en `PgPolicyAuditSink`; AV = dagens ringbuffer (`maxInMemoryAudit`) uendret |
| `JARVIS_POLICY_AUDIT_QUEUE_MAX` | api, worker | 2000 | 100-50000 | tak for hendelser i minnekøen; full kø avviser NYE hendelser (mottrykk, telt) |
| `JARVIS_POLICY_AUDIT_RETENTION_DAYS` | api | 90 | 30-3650 (gulv 30 også i databasen) | dagssveipet `policy-decision-retention-sweep` (kun når sinken er på; api-prosessen, som øvrig oppbevaring) |

Variablene er lagt i `infra/local/service-env.mjs` og generert inn i `docker-compose.yml` (api: alle tre; worker: sink + kø-tak). `.env.example` har kommentert eksempel.
Ingen nye variabler for 018/054/056/068. `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET` og `JARVIS_SPOTIFY_CLIENT_ID`/`_SECRET` er nå **deprecated som miljøvariabler** (fortsatt støttet, se §6).

## 3. JARVIS-018 - tidsavbrudd avbryter forespørselen

**Før:** `ToolGateway` avviste bare løftet ved tidsavbrudd; forespørselen (og en retry-løkke bak den) levde videre til `guardedFetch`s 45 s-grense, så en POST kunne både fullføre og sendes på nytt etter at gatewayen hadde meldt «utfall ukjent».
**Nå:** gatewayen lager en `AbortController` per leverandørkall og gir signalet til transporten på to måter: som 5. parameter `signal?` på `ToolTransport.invoke(action, parameters, credential, context, signal)` og som ambient kontekst
(`AsyncLocalStorage`, `call-signal.ts`) som `guardedFetch` plukker opp når kalleren ikke har eget signal - dekning «ved konstruksjon» for ca. 70 kallesteder. Tidsavbruddet avviser med `Error("tool_timeout")` FØR signalet avbrytes, så utfallet klassifiseres `unverified`
(ukjent) og aldri som en feil som kan prøves på nytt. Retry-/poll-løkker kaller `throwIfAborted()` og venter med `abortableSleep()` (rydder timeren). Et nøstet `execute()` startes aldri på vegne av et allerede avbrutt kall (`caller_call_aborted`).
Delt arbeid (OAuth-token-utveksling) kobles fra det enkelte kallets signal og hver kaller venter med `raceCallSignal()`, så første kallers frist ikke dreper utvekslingen for de andre.

**Bevis per transportfamilie** (alle uten ekte nettverk; ekte lokale servere/prosesser der det er mulig):

| Familie | Test (`modules/tool-gateway/test/wpk-018-gateway-abort.test.ts` hvis ikke annet er oppgitt) |
|---|---|
| Kontrakten gateway/transport | A: signal som 5. parameter og ambient (samme objekt), tidsavbrudd = `tool_timeout` + `unverified`, samtidig feil klassifiseres likt, readback får egen frist, nøstet kall nektes (`caller_call_aborted`) |
| Google (Gmail/Calendar/Drive/Sheets/GCE/Ads deler `googleAccessToken`) | B: Gmail send henger -> avbrutt, ikke sendt på nytt, `unverified`, replay utfører ingenting; sen kjede-forespørsel avbrytes; delt token-utveksling slipper kalleren fri uten å drepe utvekslingen; GCE `reset_instance`: poll-løkken stopper |
| GitHub, Zapier | C: 429 + `Retry-After` sover ikke videre etter tidsavbrudd (fake-timer-test beviser at timeren ryddes); hengende POST avbrytes; 5xx på mutasjon gjentas aldri; Zapier via sammensatt signal (eget 45 s-tak + kallsignal) |
| Meldinger (Slack, Telegram) | D: henger -> avbrutt, én forespørsel, `unverified` |
| Konfigurerbar base-URL (Home Assistant, Cloudflare) | E: ekte lokal server ser socketen lukkes, nøyaktig én forespørsel; Cloudflare-lesing sover ikke etter tidsavbrudd |
| Prosess/tilkobling med egen I/O (Docker, Postgres-drift, nettleser-gateway) | F: tidsavbrudd dreper docker-prosessen og stopper flertrinns-handlingen; Postgres-drift lukker tilkoblingen; nettleser-gatewayen avbryter via eksplisitt og via gateway-signal |
| Annonser (Google Ads, Meta Ads) | `modules/growth/test/wpk-call-signal.test.ts` |
| Primitiver, `guardedFetch`-rekkefølge, vakt | `wpk-call-signal.test.ts` A-F: kildevakt som krever at enhver ny fil med eget `signal:` er begrunnet/sammensatt, og at ingen retry-løkke sover uavbrytbart |
| Ledger | `d392-ledger-reserve.test.ts` (utvidet): ingen dobbel mutasjon etter tidsavbrudd |

**Gjenstår (`DEFERRED`/`PARTIAL`):**
* Finans-transportene (`modules/finance`) har egne 20 s-signaler og er bevisst IKKE rørt (utenfor WP-K-omfanget: finans).
* Preflight-kallet i klasse D-kjeden (`transport.invoke(preflight_action, ...)` i `gateway.ts`) har fortsatt ingen frist og ingen signal (lesing før mutasjon; ingen mutasjon er startet).
* Postgres-drift: avbrudd lukker klientens tilkobling, men en setning som alt kjører på serveren avbrytes ikke aktivt - den er begrenset av `statement_timeout`.
* En transport som utfører en mutasjon FØR tidsavbruddet kan ikke «angre» den; det gatewayen nå garanterer er at ingen NY forespørsel startes og at utfallet står som `unverified` (reconcile viser det).

## 4. JARVIS-053 - varig policy-journal (flagget AV som standard)

**Bygget:** `PgPolicyAuditSink` (`modules/core/src/services/policy-audit-sink.ts`), tabellen `policy_decisions` (migrasjon 108) og kobling i api/worker kun når flagget er på.
* **Append-only og tenant-skopet:** `tenant_id` + `FORCE ROW LEVEL SECURITY`, ingen UPDATE-grant og en `forbid_mutation`-trigger; `jarvis_app` har kun `SELECT, INSERT`. Primærnøkkel `(tenant_id, decision_id)`; skriving er idempotent (`ON CONFLICT DO NOTHING`).
* **Avgrenset kø med mottrykk:** `JARVIS_POLICY_AUDIT_QUEUE_MAX`; full kø avviser NYE hendelser (`rejected_full`, telt), den kaster aldri og blokkerer aldri `authorize()`.
* **Sink-feil endrer aldri en avgjørelse:** `PolicyGateway.emit()` isolerer sinken (kastet feil, avvist løfte og `false` telles som `sink_failures`/`sink_rejected` og gir en strupet loggline `policy_audit_sink_failed` med kun kode/navn, aldri feiltekst). Samme avgjørelse med og uten en død journal er bevist (`wpk-053-policy-sink-e2e.test.ts`).
* **Robusthet:** batch per tenant, backoff, kun SQLSTATE 22/23 isoleres som «giftig rad» (systemfeil beholdes og forsøkes igjen), frist per innsetting, drain ved SIGTERM (3 s), ugyldig tenant hoppes over (`skipped_unattributable`, aldri en oppdiktet tenant/person).
* **Redigering:** kun metadata lagres (person/sesjon/verktøy/handling/klasse/avgjørelse/grunnkode/oppgave/spor) - aldri parametre, godkjenningsinnhold eller prompts. `reason` går gjennom `scanForSecrets`; en hemmelighetsaktig id erstattes deterministisk av `redacted-<sha256-prefiks>` (samme input gir samme markør, så korrelasjon består).
* **Oppbevaring (på linje med 073):** `prune_policy_decisions(dager, batch)` er `SECURITY DEFINER` eid av `jarvis_definer`; `jarvis_app` har EXECUTE, ikke DELETE; 30-dagersgulvet står i selve RLS-policyene for definer-rollen. Standard 90 dager, aldri under 30. **`audit_events` er fortsatt den autoritative revisjonen** (ingen oppbevaringsgrense, JARVIS-074) - en revisjonsrad kan derfor peke på en `decision_id` som er ryddet fra journalen etter 90 dager; det er bevisst.
* **Synlighet:** Authority Center viser `policy_audit` kun når sinken er på (OK/WARN/UNKNOWN fra tellere; avgjørelsene er uendret ved WARN). Flagget AV gir en uendret seksjon.

**Tester:** `modules/core/test/wpk-policy-audit-sink.test.ts` (21, ekte Postgres som begrenset rolle), `modules/policy/test/wpk-decision-ids.test.ts` (12), `modules/tool-gateway/test/wpk-053-policy-sink-e2e.test.ts` (3), `apps/api/test/wpk-policy-audit-center.test.ts` (8, inkl. wiring-vakt: flagget AV = ingenting koblet), samt oppdaterte vakter (se §9).

**Gjenstår (`DEFERRED`/`PARTIAL`):** journalen er `DORMANT` til Tobias setter flagget; ikke kjørt mot NAS; ingen UI utover Authority Center-raden; kø i minnet betyr at et prosesskrasj kan miste uskrevne hendelser (de ligger fortsatt i `audit_events` for det som ledet til en handling - journalen er et supplement); retensjon for `audit_events` er en eierbeslutning (JARVIS-074, uendret).

## 5. JARVIS-054 - system-kall bærer jobb- og spor-ID

* `DailyScheduler.start(deliver)` gir nå `deliver(run)` en `ScheduledRun` (`task_id = sched:<jobb>:<dato>` stabil per jobb og dag; `trace_id = sched-<jobb>-<dato>-a<forsøk>` per forsøk fra `scheduler_state.attempts`). `deliver()` kan fortsatt deklareres uten parameter; `claimToday()` er uendret.
* `business-events-sync`, `conversation-graph-sync` og `support-inbox-sync` sender ID-ene videre til `ToolGateway.execute({ task_id, trace_id })`. Identiteten er fortsatt `person_id: "system"` (ingen falsk prinsipal; `actor_kind = system` i begge tabeller). Uten korrelasjon er kallene byte-identiske med før.
* Det nøstede `business.sync_business_events` arver det ytre kallets `task_id`/`trace_id` (`ToolInvocationContext`).
* **Policy-avgjørelse <-> revisjonsrad:** hver avgjørelse har en `decision_id` (UUID); `ToolGateway` skriver den som `audit_events.payload->>'policy_decision_id'` i HVER rad for kallet (også `tool.denied` etter policy), og journalen har samme id. «Hva skjedde kl. 03:17» er ett join (§8, spørring 2).
* Kildevakt (`apps/api/test/wpk-054-system-caller-correlation.test.ts`): i hver pakke som bygger en `person_id: "system"`-identitet må alle filer som kaller `.execute({` bruke `correlationFields(`, og de tre jobbene i `main.ts` må sende `run`.

**Tester:** `modules/tool-gateway/test/wpk-054-scheduled-run.test.ts` (5; ekte Postgres), `modules/business/test/wpk-054-system-correlation-e2e.test.ts` (3; scheduler -> sveip -> gateway -> policy -> `audit_events` + `policy_decisions`, og nøstet kall), `apps/api/test/wpk-054-system-caller-correlation.test.ts` (10), `modules/tool-gateway/test/wpk-054-decision-correlation.test.ts`.

**Gjenstår (`DEFERRED`/`PARTIAL`):** `apps/api/src/follow-up-push.ts` skriver fortsatt `system`-revisjonsrader uten `task_id` (kun `writeAudit`, ingen verktøykall); ikke alle jobber er `person_id: "system"`-kallere (brief/worker bruker `systemIdentity(owner, ...)` med eierens person-id og er uendret); `get_business_brief` bruker en `system`-identitet uten gateway-kall (bare DB-lesing) og har derfor ingenting å korrelere; policy-journalen finnes kun når `JARVIS_POLICY_AUDIT_SINK=db`.

## 6. JARVIS-056 - klient-id/secret via hvelvet

* **Før:** `googleTokenExchange()` leste `process.env["JARVIS_GOOGLE_CLIENT_ID"/"_SECRET"]` direkte, Drive-registreringssjekken målte bare miljøet, og Spotify hadde en stille miljø-fallback.
* **Nå:** `createVaultFirstConfigReader({ vault: infisicalSecretProvider })` (`oauth-client-config.ts`) kobles inn ved oppstart i api og worker (`configureGoogleOAuthClientSource`). Rekkefølge per referanse: (1) hvelvet (dashbord-lagret/Infisical; tom streng og feil/nedetid = «ikke tilgjengelig»), (2) miljøet som **logget-deprecated fallback**
  (én loggline per referanse og prosess, `credential_env_fallback_deprecated`, kun referansenavnet, aldri verdien), (3) ikke konfigurert. Uten en konfigurert kilde (skript/tester) leses miljøet stille som før.
* `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET` er lagt som **valgfrie** credential-refs på `google_calendar`, `gmail`, `google_drive` og `google_sheets`, så eieren kan lagre dem i dashbordet (Tilkoblinger -> `set_connector_credential` -> Infisical). De teller ikke med i `configured`. Allowlisten er fortsatt eneste grense (kun disse to refene, kun disse fire connectorene).
* Drive-verktøyene registreres bare når client id + secret + refresh-token finnes; målingen skjer nå hvelv-bevisst ÉN gang ved oppstart (`primeGoogleDriveCredentialCheck`) FØR `firstWaveTools()`. Den synkrone `driveTransportsIfConfigured()` er uendret.
* Å bytte kilde nullstiller access-token-cachen. Spotify i api/worker bruker allerede resolvere mot secret-kjeden; standardfallbacken (uten resolvere) er nå logget-deprecated.
* **Hemmelighetsrotasjon er IKKE gjort (og skal ikke gjøres av koden):** `BLOCKED_EXTERNAL` - Tobias eier den. Ingen ekte verdier er rørt, lest eller lagret.

**Tester:** `modules/tool-gateway/test/wpk-056-oauth-client-config.test.ts` (18; mutanter drept: hvelv ignorert, snapshot ignorert), `apps/api/test/wpk-056-google-client-wiring.test.ts` (5), `modules/owner-controls/test/wpk-056-google-client-refs.test.ts` (2).

**Gjenstår (`DEFERRED`/`PARTIAL`/`BLOCKED_EXTERNAL`):** miljøfallbacken fjernes først når verdiene er flyttet og verifisert på NAS (egen beslutning); host-skriptene (`modules/core/scripts/google-*-reauth.ts`, `knowledge`/`growth`-skript) skriver/leser fortsatt `.env` direkte (operatørverktøy, ikke runtime); `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE` er en ikke-hemmelig markør som fortsatt leses fra miljøet; andre `process.env`-lesinger av hemmeligheter i `modules/finance`/øvrige moduler er ikke gjennomgått her.

## 7. JARVIS-068 - avstemming mot WP-E1 (D-461)

**Avstemming (kode + tester lest og kjørt; se rad i funnregisteret):**

| Del av funnet | Dekket av | Bevis |
|---|---|---|
| Ingen livssyklus-overganger | `IncidentService.transition()` er eneste vei til en statusendring; `incident_transitions` (096, append-only) + utsatt DB-trigger avviser statusendring uten overgangsrad (også rå SQL) | `modules/incidents/test/e1-incident-lifecycle.test.ts` A-C (ugyldig overgang endrer ingenting, samtidige overganger serialiseres, rå SQL avvises, RLS, aktør-regler), `state-machine.test.ts` (tilstandsmaskinen), `e1-incident-migration-upgrade.test.ts` (SQL-parene = `INCIDENT_TRANSITIONS`), `apps/api/test/e1-review-m3-owner-gate.test.ts` (`403 owner_required`) |
| Ingen produsenter | 7 produsenter (scheduler, deployment, slo, provider, infra_execution, sentry, watchdog) med dedupe/gjenåpning/demping/tak, AV som standard | `e1-incident-lifecycle.test.ts` D, `e1-incident-producers.test.ts`, `e1-incident-migration-upgrade.test.ts` |
| Sannhetstyper uten håndheving (selv-«VERIFIED») | `truth.ts` + migrasjon 097: ingen avsender kan sette `VERIFIED`; kun `verifyEvidence()` fra kode; DB avviser rå `VERIFIED` uten grunnlag, nedgradering, omskriving, modellbevis over `UNVERIFIED` | `e1-incident-lifecycle.test.ts` E (6 tester) |
| `/incidents/repair` med alltid-bestått test | `test_command` påkrevd og validert (`assertTestCommand`), reparerbar status, ingen dobbel jobb, `repair_proposed` via `transition()`, eier + step-up + budsjetttak | `apps/api/test/e1-incident-lifecycle-api.test.ts` (`repair_test_command_invalid`, `repair_already_in_progress`, `repair_incident_not_repairable`), `apps/api/test/e1-review-m3-owner-gate.test.ts` (`repair_budget_exceeds_cap`, `403 owner_required`), `modules/incidents/test/repair.test.ts` |

**Nytt i WP-K (små rester i sannhetsregimet og ærlig merking):**
* En **motsigelse** (`contradicts_evidence_id`) kan bare peke på bevis i SAMME hendelse (og tenant). Tenant-FK (080) stoppet allerede en annen tenants rad, men ikke en annen hendelses (FK-oppslag omgår RLS). Avvises nå med `incident_evidence_contradiction_target_invalid` (vises som `reason` av API-et) og ingen rad skrives. Test: `modules/incidents/test/wpk-068-reconcile.test.ts` (4).
* `tests_basis` på kodejobbens resultat: `contract_command` (kontraktstyrt, validert testløper) eller `internal_default_noop` (ingen testkommando oppgitt - Jarvis' interne standard som alltid består). `tests: "passed"` er uendret; feltet gjør en tom «passed» gjenkjennelig. Test: `modules/tasks/test/wpk-068-tests-basis.test.ts` (5).
* `connectivity_scope: "api_own_pool"` på DB-korrelasjonen: `connectivity: "ok"` beviser bare at API-prosessens egen pool nådde databasen. Test: `modules/incidents/test/db-correlation.test.ts` (utvidet).

**Gjenstår (`DEFERRED`):**
* **Kodejobber uten testkommando kjører fortsatt den interne alltid-beståtte standarden** (`coding.ts`); bare merket, ikke avvist. Å kreve en eksplisitt testkommando (eller melde `tests: "not_run"`) endrer kontrakten for `POST /tasks/submit` og ~15 eksisterende tester - krever eierbeslutning.
* **`pr-publisher.ts`:** en jobb fullføres selv om PR-publisering feilet (`pr.status: "failed"` står i resultatet; grenen er allerede pushet og D-95 gjør forsøket idempotent). Å la jobben feile endrer D-95/D-102-semantikken - krever eierbeslutning.
* **Opprettelse er ikke håndhevet i databasen:** statusENDRING krever overgangsrad (utsatt trigger), men en rå INSERT med en annen startstatus enn `open` og uten opprettelsesrad er mulig for app-rollen (096 sier det eksplisitt; eldre tester setter inn rå). Tjenesten skriver alltid `open` + opprettelsesrad. En DB-håndheving krever migrasjon (109) og omskriving av de eldre testene.
* Motsigelses-målet er sjekket i tjenestelaget (alle skrivinger går dit), ikke med en DB-trigger; rå SQL fra app-rollen kan fortsatt peke på en annen hendelses bevis.
* Postmortem, automatisk korrelering ved åpning og Vercel/GCP/uptime-produsenter er fortsatt `DEFERRED` (som i `INCIDENT_LIFECYCLE.md` §7). Ikke kjørt mot NAS/Sentry/GitHub.

## 8. Slik verifiserer eieren på NAS-en (ALT UNDER ER `NOT VERIFIED` - ikke utført av byggeren)

Ta backup først (forover-kun migrasjon). Migrasjon 108 anvendes ved vanlig oppstart (`node --experimental-transform-types apps/api/src/migrate-main.ts --plan` viser den først).

1. **Journalen (053):** sett `JARVIS_POLICY_AUDIT_SINK=db` i `.env`, start api og worker på nytt. Forvent loggline `policy_audit_sink_enabled` (ikke `..._unknown_value`). Gjør én handling, og kjør som database-eier:
   `SELECT decided_at, decision, reason, tool_id, action, actor_kind, task_id FROM policy_decisions ORDER BY decided_at DESC LIMIT 10;`
   Authority Center skal vise raden `policy_audit` (OK; antall skrevet/i kø). Etter første natt: loggline `policy_decision_retention_sweep_completed`.
2. **«Hva skjedde kl. 03:17» (054):** etter neste planlagte kjøring (standard 05:xx for `business-events-sync`):
   `SELECT a.at, a.type, a.tool_id, a.action, a.actor_kind, a.task_id, a.trace_id, p.decision, p.reason FROM audit_events a LEFT JOIN policy_decisions p ON p.tenant_id = a.tenant_id AND p.decision_id = a.payload->>'policy_decision_id' WHERE a.task_id LIKE 'sched:%' ORDER BY a.at DESC LIMIT 20;`
   Forvent `actor_kind = system`, `task_id = sched:<jobb>:<dato>`, og en `p.decision` per rad (så lenge journalen er på og raden er yngre enn oppbevaringen).
3. **Dødt-journal-test (053):** ikke gjør dette i produksjon. Bevisene ligger i `wpk-053-policy-sink-e2e.test.ts`.
4. **Klient-id/secret (056):** i loggen etter oppstart: `credential_env_fallback_deprecated` med `ref: JARVIS_GOOGLE_CLIENT_ID` og `_SECRET` (så lenge verdiene står i `.env`). Flytt dem i dashbordet (Tilkoblinger -> Google Calendar -> valgfrie felt), start api/worker på nytt, og sjekk at linjene for de refene er borte og at Gmail/Kalender/Drive fortsatt virker.
   Fjern `.env`-verdiene først etter at det er bekreftet. **Rotasjon av hemmelighetene er din (Tobias) - koden har ikke rørt dem.**
5. **Tidsavbrudd (018):** etter et kall som tidsavbrytes skal `tool_executions` stå `unverified` (ikke retry) og `reconcile` skal vise det; loggen skal ikke vise en ny forespørsel til leverandøren etter avbruddet. Kjør de automatiske bevisene: `pnpm exec vitest run modules/tool-gateway/test/wpk-018-gateway-abort.test.ts modules/tool-gateway/test/wpk-call-signal.test.ts modules/growth/test/wpk-call-signal.test.ts`.
6. **Hendelser (068):** følg `INCIDENT_LIFECYCLE.md` §6. I tillegg: `POST /incidents/evidence/add` med `contradicts_evidence_id` fra en ANNEN hendelse skal gi `400` med `reason: incident_evidence_contradiction_target_invalid`; et kodejob-resultat har `tests_basis`.

## 9. Endrede vakter/baselines (alle bevisst, nevnt i rapporten)

* `modules/core/test/remediation-2-schema-invariants.test.ts`: `prune_policy_decisions` lagt til i listen over tillatte `SECURITY DEFINER`-funksjoner.
* `modules/erasure/test/d395-erasure-coverage.test.ts`: `policy_decisions` i `BASELINE` (tenant-tabell; slettes med tenanten via erasure-kaskaden, oppbevaring i tillegg via `prune_policy_decisions`).
* `docs/security/PROCESSING_INVENTORY.md`: ny rad for `policy_decisions` (D-420-vakten krever en rad per migrasjonstabell).
* `apps/api/test/d442-sweep-failure-escalation.test.ts`: kildevaktene tillater nå at kjøringen `run` følger samleren `failures` som siste argument for de tre `system`-sveipene.
* `modules/tool-gateway/test/wpc3-github-token-provider.test.ts` (G2): de fire Google-connectorene har nå valgfrie credential-refs (klient-id/secret); ingen annen connector har det.
* `infra/local/service-env.mjs` + generert `infra/local/docker-compose.yml`: tre nye variabler (se §2). Ingen endring i verktøytellinger, `scope-fk`-baseline eller connector-registerets påkrevde refs.

## 10. Tilbakerulling

* 053: fjern `JARVIS_POLICY_AUDIT_SINK` (eller sett `off`) og start om: `PolicyGateway` bruker ringbufferen som før. Tabellen og radene blir stående (append-only; ryddes av oppbevaringen hvis flagget slås på igjen). Migrasjon 108 er forover-kun.
* 056: slett de to valgfrie refene i hvelvet - miljøet brukes igjen, uendret.
* 018/054/068: ingen flagg; tilbakerull committene på grenen (additive felt og en feilretting).
