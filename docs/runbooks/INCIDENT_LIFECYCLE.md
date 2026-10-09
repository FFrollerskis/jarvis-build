# Incident-livssyklus, produsenter og sannhetsregime (WP-E1, UA-5, JARVIS-068)

**Status (2026-10-09): BYGGET OG TESTET MOT EKTE POSTGRES OG FAKES - IKKE KJØRT MOT NAS-en.** Produsentene er **AV som standard** (`JARVIS_INCIDENT_PRODUCERS_ENABLED=true` slår dem på).
Alt her er observasjon + registrering i Jarvis' egen database. Ingen reparasjon utføres automatisk, og ingen produsent skriver mot noe eksternt system (reparasjon er fortsatt bak
`InfraExecutionGate`/klasse D-kjeden).

**D-64:** Jarvis eier hendelsesmodellen (`JARVIS_CANONICAL`); Sentry/GitHub/Vercel er kilder, ikke domenekjerne. `CORE_DEPENDENCY_DECISION_REQUIRED=false`.

## 1. Livssyklus og varig historikk

Lagrede statusverdier er uendret (CHECK, data og situasjonsmotorens infra-bro avhenger av dem); eieren ser **fasen**:

| Fase (norsk) | Lagret status | Eier-handling (`POST /incidents/transition`, `action`) |
|---|---|---|
| åpen | `open` | `reopen` (fra løst/lukket) |
| anerkjent | `diagnosing` | `acknowledge` |
| avbøting foreslått / pågår | `repair_proposed` / `repair_in_progress` | `mitigate` / `start_mitigation` |
| løst | `resolved` | `resolve` |
| lukket uten tiltak | `wont_fix` | `close` |

* **Eneste vei til en statusendring er `IncidentService.transition()`** (den gamle `setStatus()` er borte). Hver endring skriver en rad i `incident_transitions` (hvem, når, hvorfor, peker til bevis/jobb) og en revisjonsrad
  (`trace_id` = hendelsens korrelasjons-id) i samme transaksjon. Årsak er påkrevd (≤ 500 tegn, redigert for hemmeligheter).
* **Databasen håndhever det også:** en utsatt trigger avviser enhver statusendring uten en matchende overgangsrad i samme transaksjon (også rå SQL fra app-rollen); overgangsraden kan bare være et lovlig par
  (CHECK; en test holder SQL-parene identiske med `INCIDENT_TRANSITIONS`); historikken er append-only (ingen UPDATE-grant, direkte DELETE avvises - den forsvinner kun med hendelsen ved erasure).
* **Aktør-regler:** `owner` (alltid personen fra grantet, aldri fra kroppen) kan gjøre enhver lovlig overgang. En **produsent** kan kun (a) løse sin egen hendelse med en peker til et **VERIFIED bevis for samme hendelse**,
  og (b) gjenåpne en løst hendelse (regresjon) - aldri en manuell hendelse, aldri «lukk uten tiltak», aldri gjenåpne en hendelse eieren har lukket. Reparasjonsflyten kan kun foreslå tiltak. `system` brukes bare til opprettelses-/bakfyllsraden.
* `GET`-flaten: `POST /incidents/get` returnerer hendelse (med `phase`/`phase_no`), **overgangshistorikk** og bevis med sannhetsmerking (`truth_no`). `POST /incidents/list` validerer status.

## 2. Sannhetstype-regimet (ingen kan bekrefte sin egen påstand)

| Status | Betydning | Hvem setter den |
|---|---|---|
| `UNVERIFIED` («påstått») | noen har sagt det; ingenting er kontrollert | eier (standard), modell (alltid), ekstern tekst (Sentry) |
| `PROVISIONAL` («observert, ikke bekreftet») | én måling/vurdering, ikke bekreftet | produsent/kontroll fra Jarvis-intern kilde; eier som egen vurdering |
| `VERIFIED` («bekreftet») | en **deterministisk kontroll eller uavhengig kilde** har bekreftet det, grunnlaget er lagret (`verified_by` + `verification_basis` + `verified_at`) | **kun** `IncidentService.verifyEvidence()` fra kode: deploy-treff i korrelasjonen, produsentens re-måling, en uavhengig probe |

* HTTP-ruter kan ikke sette `VERIFIED`, `asserted_by` eller verifiseringsfelt (avvises med grunn, kroppen har ikke feltene). Modellskrevet bevis står alltid `UNVERIFIED` og kan aldri forfremmes.
* **Diagnoser:** en modell-hypotese er alltid `UNVERIFIED`, en eier-konklusjon kan aldri være `VERIFIED`, og en `deterministic` diagnose (kun fra kode, ikke HTTP) kan være `VERIFIED` kun med minst ett `VERIFIED` støttebevis for **samme** hendelse. Et bevis fra en annen hendelse kan ikke siteres.
* **Databasen** avviser rå `VERIFIED` uten grunnlag, nedgradering/omskriving av `VERIFIED`, innholdsendring på bevis og diagnoser, og modellbevis over `UNVERIFIED`.
* **Migrasjon 097 bakfyller ærlig:** gamle selv-påståtte `VERIFIED` ble `PROVISIONAL`; deploy-bevis som peker på en faktisk `deployments`-rad beholdt `VERIFIED` med grunnlag `backfill 097`. Modell- og eier-diagnoser ble nedgradert.

## 3. Produsentene (observasjon + registrering)

Ett fingeravtrykk `<kilde>:<emne>` gir én aktiv hendelse (unik indeks + advisory-lås, api og worker kan kjøre samtidig). Samme fakta oppdaterer hendelsen (teller, alvorlighet kun **opp**, nytt bevis kun hvis det skiller seg, maks 50 bevis).
En løst hendelse som kommer tilbake innen 24 t **gjenåpnes** (samme rad); senere gir den en ny rad med **samme korrelasjons-id**. Eierens «lukk uten tiltak» **demper** samme faktum i 7 døgn (kun telleren øker). Maks 25 aktive hendelser per produsent (en støyende kilde fyller ikke tabellen).
**Løsning skjer kun etter positiv re-måling** (nytt `VERIFIED` bevis + overgang atomisk) - aldri fordi noe «ikke er sett», aldri når kilden er nede, aldri på en gammel vakthund-rapport.

| Produsent | Åpner når | Løses når | Merknad |
|---|---|---|---|
| `scheduler` | jobb i `scheduler_state` har gitt opp / gikk tapt (samme klassifisering som selvdiagnose/brief) | jobbens siste rad er fullført | `retry_pending`/`stalled` og PC-avhengige jobber (D-445) gir aldri hendelse |
| `deployment` | nyeste avgjorte utrulling for `repo@gren` (kun grener i `JARVIS_INCIDENT_DEPLOY_REFS`, standard `main`) er `failure`, siste 48 t | nyeste avgjorte utrulling er `success` | valgfri innhenting av nye Actions-kjøringer for `JARVIS_INCIDENT_DEPLOY_REPOS` (via `github.list_workflow_runs` + eksisterende `ingestGithubDeployment`) |
| `slo` | tjenestemål er `BREACH` | tjenestemål er `OK` (`UNKNOWN` gjør ingenting) | alvorlighet `normal` (målene er forslag) |
| `provider` | konfigurert tilkobling er `unavailable`/`auth_failed` i `ToolGateway.health` | helse målt `healthy` etter siste observerte svikt | leser helsekartet, ingen hvelv-oppslag |
| `infra_execution` | journalført eksekusjon `FAILED`/`PARTIAL`/`UNKNOWN` siste døgn, ikke knyttet til en hendelse og ikke gjenopprettet | gjenoppretting journalført `SUCCESS` for eksekusjonen | én hendelse per eksekusjon |
| `sentry` | uløst `error`/`fatal`-issue sist sett siste time (krever `JARVIS_SENTRY_API_TOKEN`) | `get_issue` for akkurat dette issuet sier `resolved`/`ignored` | **ubetrodd kilde:** tittel er en fast mal, bevis kun validerte felt og `UNVERIFIED`, maks 10 per kjøring, dormant uten token |
| `watchdog` | en vakthundsjekk feilet i siste fullførte tikk (worker) | samme sjekk lyktes i et senere tikk | `Watchdog.setObserver()`; gammel/manglende rapport hoppes over |

Hver kjøring registreres i `incident_producer_runs` (start, slutt, utfall, tall, feil på rad) og vises i driftsstatusen. En produsent kan ikke åpne en annen produsents hendelser (kjøreren avviser, databasen krever riktig prefiks).

### Slå på
```
JARVIS_INCIDENT_PRODUCERS_ENABLED=true          # api OG worker (kun eksakt «true»)
JARVIS_INCIDENT_PRODUCERS_INTERVAL_MS=300000    # api, 60000-3600000
JARVIS_INCIDENT_DEPLOY_REFS=main                # api
JARVIS_INCIDENT_DEPLOY_REPOS=                   # api, tom = ingen polling av GitHub
```
Restart api og worker. Hendelsene lages for eier-tenanten i `business`-rommet (samme rom situasjonssveipet leser) og flyter via den uendrede infra-broen til oppmerksomhetskøen. **NB:** situasjonssveipet leser kun *business-tenanter*.

## 4. Driftsstatus (klasse A)

* Chat: `executive.get_infra_status` («har vi åpne hendelser?», «er noe nede?», «skystatus»). HTTP: `POST /infra/overview { grant_token }`.
* Innhold: åpne hendelser (fase, alvorlighet, bekreftet/observert/påstått, antall observasjoner, siste endring), de sju skymålene (Cloudflare, Vercel, Google Cloud, Docker, Langfuse, Infisical, Postgres: sovende/ukjent/ok/redusert/nede + siste journalførte endring),
  produsentenes helse og infra-modus. **Aldri** bevistekst, årsaker, credential-verdier eller -navn. Ukjent vises som ukjent; er produsentene AV, står det uttrykkelig at «ingen hendelser» bare betyr «ingen registrert manuelt».

## 5. `/incidents/repair` er sikret

`test_command` er **påkrevd** og må være en kjent testløper (`assertTestCommand`): tidligere ble en tom liste til `node -e process.exit(0)` (en test som alltid består, så en reparasjon kunne meldes `tests: passed` uten at noe var testet). Hendelsen må være `open`/`diagnosing`/`repair_proposed`,
det kan ikke finnes en uferdig reparasjonsjobb fra før (ingen dobbel agentkjøring), og overgangen til `repair_proposed` går via `transition()` med aktør `repair`. Ingen auto-merge (D-95/D-102 uendret).

## 6. Verifisering (kjør selv)

1. Migrasjon på din database: `node --experimental-transform-types apps/api/src/migrate-main.ts --plan` viser 096-098 før du anvender dem (se også `docs/runbooks/D103_HOST_ACCEPTANCE.md`); ta backup først (forover-kun, ingen ned-migrasjon).
2. `POST /incidents/create` → `POST /incidents/transition {action:"acknowledge", reason:"…"}` → `POST /incidents/get` viser historikken med deg som aktør.
3. Forsøk `POST /incidents/evidence/add {…, status:"VERIFIED"}` → 400 `truth_verified_requires_deterministic_basis`.
4. Slå på produsentene, få en jobb til å feile (eller bruk `POST /deployments/ingest/github` mot en feilet kjøring på `main`) og se hendelsen i `POST /infra/overview` og i oppmerksomhetskøen. Fiks årsaken og se at hendelsen løses med `VERIFIED` bevis i historikken.
5. Kjør testene: `npx vitest run modules/incidents modules/watchdog modules/executive modules/situations apps/api/test/e1-*`.

## 7. Kjente begrensninger (`DEFERRED`/`PARTIAL`/`NOT VERIFIED`)

* **NOT VERIFIED:** mot ekte NAS/Sentry/GitHub. Sentry-svarformen er basert på trent kunnskap (som `SentryTransport` selv sier); produsenten leser defensivt og ignorerer alt som ikke validerer.
* **DEFERRED:** postmortem (observert vs. antatt) er ikke bygget (migrasjonsutkastet ble bevisst droppet); automatisk korrelering mot deploy/logg/DB-tilstand ved åpning (de manuelle rutene `/incidents/correlate`, `/incidents/evidence/acquire_logs`, `/incidents/correlate/db` finnes);
  Vercel/GCP/uptime-spesifikke produsenter (de dekkes i dag via `provider`-helse og `infra_execution`); automatisk reparasjon (aldri uten eierens bevisste valg bak `InfraExecutionGate`).
* **ÅPENT i JARVIS-068 utenfor denne PR-en (modules/tasks):** `coding.ts` kan fortsatt melde `tests: "passed"` for den interne standardtesten når en annen kaller utelater testkommando (incident-reparasjon gjør det ikke lenger), og `pr-publisher.ts` kan fullføre jobben selv om PR-publisering feilet.
  `db-correlation.ts`' `connectivity: "ok"` sier bare at api-ets egen DB svarer. Gjenoppretting er bundet til den journalførte eksekusjonen (`recovery_target_mismatch`, WP-E1).
* Hendelser i andre minne-rom enn `business` leses ikke av driftsstatusen.
