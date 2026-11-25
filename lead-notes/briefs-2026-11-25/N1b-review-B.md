TS: 2026-11-25T21:03:10.296Z
VERDICT: MERGE ETTER FIKSER. 0 HIGH og 1 MEDIUM (F1: `executive.get_infra_status` og `infra`-situasjoner lekker finanskobling- og jobbnavn til sky, mens runbooken sier «ingen finans»). I tillegg 6 LOW (F2–F7), alle med minimal fiks under.

HEAD er `ebc85c38`, worktreen er urørt (`git status --short` tom, probene er flyttet ut). Alt er kjørt som `postgres`, `--maxWorkers=2`, `timeout -k 5`.

## Funn (rangert, fil:linje mot HEAD)

**F1, MEDIUM: `get_infra_status` og `infra`-situasjoner røper finansmetadata til sky**
- Runbook l.149 klassifiserer `executive.get_infra_status` som «infrastruktur, ingen finans». Det stemmer ikke.
- `InfraIncidentItem.title` returneres rått (`modules/executive/src/infra/types.ts:44`, `transport.ts:220`). Kommentaren på `service.ts:588` sier selv «hendelsestitler ... jobbnavn».
- Titlene bygges av `providerProducer` (`provider.ts:32`: «Tilkobling svikter: <display_name>») og `schedulerProducer` (`scheduler.ts:27`: «Bakgrunnsjobben <job_name> ga opp»). De dekker også Stripe, Vipps, Neonomics, Wallester og jobbene `stripe-payment-sync` osv.
- Samme titler går via `infra-incident-bridge.ts:60` inn som situasjoner i domenet `infra`. K2 filtrerer bare `spend` (`service.ts:199`), så `get_attention_queue` og `get_attention_item` lekker dem også.
- Dette er samme klasse metadata som R09/R10/R14 (navn og helse for finanskoblinger). Drift-senteret utelater titler bevisst (`operations.ts:221`), og H2 har `isFinanceJobName` (`shared.ts:272`).
- Betingelser: eier og signert økt (samme port som sentrene), og at hendelser finnes. Det krever `JARVIS_INCIDENT_PRODUCERS_ENABLED=true` eller manuelt registrerte hendelser. Derfor MEDIUM og ikke HIGH.
- Probe: `P3` i `zz-n1b-review-b-probes.test.ts`, 3 røde tester. Tittelen kommer fra ekte `providerProducer` og `connectorStatusesFromGateway`. Skyresultatet inneholder `["Tilkobling svikter: Stripe","Bakgrunnsjobben stripe-payment-sync ga opp"]`, og kø-reason `Tilkobling svikter: Stripe (status: open, ...)`.
- Fiks: i `get_infra_status`, legg til `if (withholdFinanceFromCurrentModel()) return { data: { ...financeWithheldMarker() } }`, som `get_self_diagnosis`. Flytt `get_infra_status` fra `read_no_finance` (`wpn1b-structure.test.ts:206`) til `handled` og legg til en rad R24 i `n1b-rows.ts`. I `rankedQueueWithSource` (`service.ts:199`), utvid filteret med `|| FINANCE_STEM.test(s.reason)` (eller hold `infra` tilbake helt). Alternativt: marker raden ærlig som DEFERRED/PARTIAL og endre «LUKKET» i begrensning 6 og I5.

**F2, LOW: `servingModel: null` er fail-åpent for K2-leserne, men fail-lukket for finanslåsen** (`gateway.ts:791`)
- `request.servingModel ?? ambient?.servingModel` gjør `null` til «ingen modell», så ingen skop settes og K2-leserne gir eierinnhold.
- Samtidig nekter `executeCall` `finance.*` for samme `null` (`servedByCloud(null)` gir `true`).
- Probe `P1` med `null`: `list_open_loops` lekker `N1B-KATEGORI-SPEND`, mens `finance.get_kill_switch` nektes. De ti andre variantene (tom streng, 0, false, `{}`, provider undefined/tall/`" gemma_local"`/`GEMMA_LOCAL`/`Local`/tom) er greit sky.
- Produksjonskode kan i dag ikke sende `null`: strukturtest C forbyr det, og `MeshToolExecutor` stempler alltid et objekt. Det er altså en grenseherding.
- Fiks: `(request.servingModel !== undefined ? request.servingModel : ambient?.servingModel)`.

**F3, LOW: setteren er offentlig API, og kildevakten kan omgås**
- `index.ts:4` (`export *`) eksporterer `runWithModelScope` (`model-scope.ts:59`). Pakken har bare `exports: {".": index.ts}`.
- Probe `P2b`: en trusted modul kan kalle `runWithModelScope({cloud:false}, ...)` inne i et skykall og få finansløkker.
- Vakt A (`wpn1b-structure.test.ts:42,46`) teller bare `navn(`. Mutant C41 (alias-import uten ordet `servingModel`) overlever hele suiten. C36 (aliaset leser i `growth`) overlever også.
- Fiks: eksporter kun lesere og typer fra `index.ts` (`gateway.ts` importerer setteren direkte fra `./model-scope.ts`). La vakt A telle `\brunWithModelScope\b` og `\bwithholdFinanceFromCurrentModel\b` (alle forekomster, også import og alias).

**F4, LOW: orakel i `run_rate.list_connector_maintenance`** (`run-rate.ts:86,165`)
- `recent` er `LIMIT 5`, og finansfilteret kommer etterpå. Fem nye finansrader tømmer skyens `recent` (3 rader blir 1) mens `minutes_30d` er uendret.
- Dermed røpes det at finans-vedlikehold finnes. Probe `P4b` er rød.
- Fiks: filtrer finanskoblinger i SQL før `LIMIT`, eller hent uten `LIMIT` og `slice(0,5)` etter filteret.

**F5, LOW: testhull som mutantene viser**
- C15/C16: å legge `withheld_count` i skysvaret på `list_open_loops` og `get_attention_queue` overlever. «Ingen orakel» er ikke test-vokta. Fiks: ta inn `P4` (skysvar med og uten finansdata, normalisert) i tabelltesten.
- C23/C24: `get_value_report` og `get_cost_overview` leser først og holder tilbake etterpå. Overlever, fordi ingen test spionerer på at tjenesten ikke kalles for sky. Det bryter intensjonen «før verktøyet leser».
- C20/C21: redundant OR i `centerResponse`. Funksjonelt ekvivalent i dagens kobling.

**F6, LOW: dokumentasjon**
- NAS-trinn 7c (l.218, fra før) og 7g (l.226, nytt) bruker `audit_events.created_at`. Kolonnen heter `at` (`004_audit_cost.sql`). Reprodusert: `column "created_at" does not exist`. K3 krever riktige steg.
- «LUKKET» i begrensning 6 (l.257) og I5 (l.97) er overdrevet så lenge F1 står.
- «23 stier (R01–R23)» (l.31): tabellen har 25 rad-id-er (R14b, R21a, R21b).

**F7, INFO**
- K2-tilbakehold gir ingen egen revisjonsrad, bare vanlig `tool.executed`. Steg 7h–7k kan derfor ikke telle tilbakehold fra `audit_events`.
- Worker-gatewayen har ingen lås. Bakgrunnsflaten gir `executive.get_capability_status` (`tool-manifest.ts:~303`), så K2-tilbakeholdet for den stien gjelder ikke i worker. Dette er kjent rest (c)–(j) og begrensning 7/23e.

## Dine fire punkter

- **(a) Glemt/misklassifisert:** F1 er den eneste ekte. Antakelse 4–12 og begrensning 20–24 stemmer med koden og er ærlig DEFERRED. Verifisert:
  - `growth.*` er dokumentert og inkonsistent med at `marketing_spend_anomaly` holdes tilbake (begrensning 21).
  - `open_tasks` leses ikke av `conversation.ts`.
  - `tasksSource` brukes bare i `main.ts:1626` (scheduler og `/brief`).
  - `business.read_metrics` gir `open_pipeline_value_ore` fra CRM. Det er dokumentert som ikke-finans, men ikke et Q-punkt.
  - Skriveekkoet er bak bekreftelseskort: `confirmation-store.ts` har bare `approveAndTake`, ingen «approved uten take».
- **(b) Nøytraltsvaret:** `FINANCE_WITHHELD_NOTE_NO` er konstant, uten sifre og uten leverandørnavn. Samme form med og uten finansdata er bevist på 9 DB-baserte stier (list, kø, daglig/ukentlig brief, kalibrering, tverr-kanal ×2, vedlikehold og kostoversikt). Unntaket er F4.
- **(c) Enkeltoppslag gir merket i stedet for «ikke funnet»:** akseptabelt. ID-ene er `biz-ol-<randomUUID>` (`open-loop-service.ts:70`), så en modell kan ikke gjette dem. `Q4` viser tre forskjellige svar, men orakelet krever en kjent ID.
- **(d) Ukjent løkketype utelates fra SQL-hvitlisten:** ingen bivirkning i dag. `P6`: loop_type-CHECK i DB er lik nøklene i `FINANCE_DERIVED_LOOP_TYPE`. En fremtidig migrasjon uten klassifisering skjules for sky (fail-lukket), og pin-testen fanger avviket.

## Byggerens påstander mot dom

| Påstand | Dom | Bevis |
|---|---|---|
| K1: skopet settes én gang i `execute()`, nøstede kall arver | BEKREFTET | P2a/c/d. C06/C07/C39/C40 drept av atferdstester også uten strukturtestene. |
| K1: ingen lekkasje mellom samtidige forespørsler (≥50) | BEKREFTET | Q1: 400 samtidige kall (alle 25 rader × sky/ukjent/blank/lokal/ingen) + 60 sentre: 0 kryssinger. C08 (`enterWith`) drept. |
| K1: uten modell gir full tilgang | BEKREFTET | Q1 «eier» og «lokal». |
| K1: fail-lukket | DELVIS | Ti av elleve ugyldige varianter er greit. `null` gir F2. «Modellvei uten stempel = full tilgang» er antakelse 3, ikke fail-lukket. |
| K1: én lokalitetsfunksjon | BEKREFTET | `servedByCloud(` finnes 3 ganger, ingen ny kopi. C01–C04 drept. |
| K1: flagg AV er identisk med main | BEKREFTET | `execute()` går rett til `executeCall`. Q2: ingen nye felter. Guard-/differensialsettet (10 filer, 93 tester) er grønt. Fixturen er urørt. |
| K1: setteren bare i gatewayen | DELVIS | F3. |
| K2: 23 stier holdt tilbake ved utførelse | DELVIS | Tabelltesten 151/151 og Q1 grønne. `get_infra_status` og `infra`-situasjoner mangler (F1). |
| K2: merket alltid med | BEKREFTET | P4 og Q1. |
| K2: `tasksSource`/`open_tasks`/`personal.finance_read` ikke modellnåbare | BEKREFTET | Grep. C37 (modellflate) og C38 (importerer ToolGateway) drept. |
| K2: revisjon uten innhold | BEKREFTET | P5: 0 finansmarkører i `audit_events` og `tool_executions` for skykall. |
| K3: aktiveringsrekkefølge og NOT VERIFIED | DELVIS | Tekst riktig (l.44, l.234). NAS-SQL 7g er feil (F6). Ingen steg er destruktive. 7h nevner test-tenant. |
| K4: tester, rød-først, mutanter | BEKREFTET | Baseline 9 filer/262 tester grønne. Ingen `skip`/`only`. De to endrede N1-testene er strammet (invertert hull-forventning), ikke svekket. Hull: F5. |
| K5: ingen nye flagg, avhengigheter eller migrasjon | BEKREFTET | Diff har 0 nye `JARVIS_*`. Ingen `package.json`, lock, infra, ops eller .sql. `gitleaks` (10 commits): `no leaks found`. |
| K6: tabell og begrensninger stemmer med koden | DELVIS | F6, og tabellraden for `get_infra_status`. |

## Mutasjoner

- **Byggerens skript** (`N1B_RUN_AS=postgres node apps/api/test/support/wpn1b-mutants.mjs`): 39 kjørt, 39 drept av assertion, 0 overlevd.
- **Mine egne** (`/tmp/lead/N1b-review-B-probes/mutants-B.mjs`): 41 kjørt, 33 drept, 8 overlevd.
  - Drept (33): blant annet predikat kaster/undefined/ikke-funksjon regnes lokalt, leser snudd, `enterWith`, ordstamme `payment|bank` fjernet, ikke-streng id/ref/domene fail-åpent, `owner_control` begrunnelse/`reasons_withheld`, SLO ikke rekomponert, lokalt skop vinner over sky, delegeringstavle/sentre/overvåking, tre klassifiseringsflipp, flagg-parser godtar `true`, `personal.finance_read` på modellflate, `servingModel` ikke videresendt, nøstet kall arver ikke.
  - Overlevde, testhull: C15, C16 (`withheld_count`), C23, C24 (les før tilbakehold).
  - Overlevde, kildevakt omgått: C36, C41 (alias).
  - Overlevde, ekvivalente: C20, C21 (redundant OR i senter-avgjørelsen).
- Ekvivalent men drept bare av kildetekstvakt: C05 (overlever uten strukturtester). C09 (`Object.freeze`) drepes også av en atferdstest.

## Ikke verifisert av meg

- NAS, ekte skymodell og ekte lokal modell.
- Ekte transporter (Gmail, MCP, browser) og at skopet overlever der.
- Ekte hendelsesprodusenter via `JARVIS_INCIDENT_PRODUCERS_ENABLED` og situasjonssveipet i drift. F1 er bevist med ekte `providerProducer`, men fake `infra.source` og fake `situations.get_queue`.
- H2-sentrene memory/agent/operations/privacy/security. Min probe Q5 var ikke informativ, fordi sentrene ikke ble registrert i testverdenen. Jeg støtter meg bare på at `wph2-restrict-finance-db` er grønn.
- `pnpm typecheck`, `lint` og `check:containment` (byggerens påstand).
- Hele suiten (lead kjører den).
- Worker-adferd.

## Probe-mappe

`/tmp/lead/N1b-review-B-probes/`

- `zz-n1b-review-b-probes.test.ts`: 36 tester, 5 røde (P1 `null`, P2b setter, P3 ×3 F1) pluss P4b (F4). Totalt 6 røde over begge filer.
- `zz-n1b-review-b-probes2.test.ts`: 6 tester, alle grønne (samtidighet, flagg AV, Q3 `get_capability_status`, Q4 id-former, Q5 ikke informativ).
- `mutants-B.mjs` med loggene `mutants-B.log`, `mutants-B-nostruct.log` og `mutants-builder.log`.
- `run-vitest.sh`, `out-*.log`.
