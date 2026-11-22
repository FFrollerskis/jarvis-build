TS: 2026-11-22T15:01:06.634Z
# WP-N1 fiks-runde 2 (del A + B): sluttrapport (bygger)

Ny HEAD er `b60bceb6` (base `17949ceb`, 8 nye commits). Treet er rent. Det er ikke pushet, jeg har ikke kjørt hele suiten, og delte docs er urørt (kun `docs/runbooks/WPN1_RESTRICTED_HISTORY.md`). Alt er DORMANT bak flagget og **NOT VERIFIED** mot NAS og ekte modell.

## Nye commits (alle med begge trailerne)
```
83b734e8 fix:  F2-B1 jobbresultat holdes tilbake fra sky (get_task_status) + hurtigbanens jobbstatus låser turen
e498cdf5 test: F2-B1/F2-B2 beskyttelsesbevis (jobb-status, failed/cancelled-levering, predikat)
f23fcb04 fix:  F2-A1 bekreftelsesbanen beholder restricted_origin
1308b882 test: F2-A1 reviewer A sin C1 over ekte /confirmations-rute + setter-vakt 2→3
c4a589e4 fix:  F2-A3 executive servedLocally = financeLockServedLocally (+ guard-env-pinner)
51a3b863 test: 28 nye mutanter M92-M119 + N1_WORKERS
9ef38571 test: wpd4-council-proposal-db tilpasset approveAndTake-formen
b60bceb6 docs: runbook fiks-runde 2
```

## Per funn
- **F2-B1 (NF-1 MEDIUM): FIKSET.**
  - `ChatJobs.list/get` velger `restricted_origin`. `TasksDelegateTransport` får et valgfritt tredje argument, `withholdsRestrictedJobFromCloud` (gjenbruker `financeLockServedLocally`, fail-closed).
  - Sky/ukjent/tom/STORE får `withheld: true`, nøytral tittel, `result_text`/`error` = null og en norsk merknad uten sifre eller leverandørnavn. Lokal modell og eier-ruter får alt.
  - Hurtigbanens `jobbstatus` slår opp jobbens opprinnelse og låser turen før svaret lagres. Oppslagsfeil gir lås.
  - Bevis: `wpn1-job-status.test.ts` (13, ekte Postgres/kø/MeshToolExecutor), reviewerens D2/D4 snudd til beskyttelse.
- **F2-B2 (NF-2): FIKSET.** Feilede og avbrutte jobber leveres begrenset (4 args), ikke-låst gir 3 args, i `wpn1-job-delivery.test.ts`. M109 er drept.
- **F2-A1 (N1 MEDIUM): FIKSET.**
  - `MeshToolExecutor` legger `restricted_turn` i kortets grunner, `approveAndTake` returnerer `taint_reasons`, og `server.ts` sender `restrictedOrigin` kun for `tasks.delegate_background_task` med grunnen.
  - Bevis: `wpn1-confirmation-path.test.ts` (13) kjører den ekte `/confirmations`-ruten via `createApiServer`. Grant og identitet er enkle, resten er ekte (Postgres, `TaskService.submit` med policy, MeshToolExecutor med guards). Kontrakt `restricted_origin=true`, levering `restricted=true`, ingen skylekkasje.
  - Setter-vakten er nå tre steder (M117 legger til et fjerde og dør).
  - `taint_reasons` leses av dashbordkort, Autoritet- og Sikkerhet-senteret. Alle viser kun teksten, og telleren endres ikke.
- **F2-A2: FIKSET** (samme som F2-B1a). Feltnavnet er `withheld` (+ `note_no`), likt for id og liste, og dokumentert.
- **F2-A3: FIKSET.** `main.ts` bruker `financeLockServedLocally`. guard-env pinner uttrykket og at kun 4 produksjonsfiler bruker `servedByCloudModel`. E07n (`() => true`) dør (M118).
- **F2-A4: kun dokumentert** (runbook begrensning 12, Q-2). Ingen kodeendring.
- **INFO:** kildevakt D, invariant C og `personal.finance_read` står i runbookens begrensninger 13–14.

## Tester
- **N1:** 211 grønne i 17 filer (var 177 i 15).
- **Bred kjøring på HEAD (2 arbeidere, som `postgres`):**
  - `apps/api/test`: 228 filer / 3383 tester grønne.
  - executive, tool-gateway, model-gateway, tasks + alle main.ts-lesere i andre moduler: 250 filer / 4206 tester. Kun de tre kjente `wpc3-review1-hardening` F10a/b/c er røde.
  - `modules/core/test` (uten ipv4-contention): 55 filer / 979 tester grønne.
- Den brede kjøringen fant en tredje eksakt-form-test (`wpd4-council-proposal-db`) som låste den gamle `approveAndTake`-formen. Den er tilpasset og kjørt grønn (46/46). De to andre er `part3-taint-confirmations` og `wpf1-confirmation-store-guards`.
- `pnpm -r run typecheck`, `pnpm lint` og `pnpm check:containment`: exit 0.

## Mutanter
- 106 totalt, 105 drept av assertion, 0 tekniske brudd, 0 ugyldige. Den ene overlevende er M48 (ekvivalent, som før).
- 28 nye (M92–M119), alle drept. Blant dem: fjernet `restricted_origin`-valg, invertert og fail-open prediktat, tittel/resultat/feil ikke holdt tilbake, `withheld` også med flagg AV, `list`/`get` glemmer filter, fjernet `jobbstatus`-lås, oppslagsfeil gir ikke lås, reason ikke lagt til, `taint_reasons` ikke returnert, server sender ikke/ubetinget/for feil verktøy, fjerde setter-sted.

## Kartlegging av jobbresultat-lesere
- **Lukket:** `tasks.get_task_status` (id og liste), hurtigbanens `jobbstatus` og leveringsmeldingen (F-A2, nå også failed/cancelled).
- **Uendret, eierens egne ruter uten modell:** `POST /chat/jobs`, web-UI, `GET /tasks/:id`, Telegram-varsel, daglig brief (`tasksSource`; `business.get_business_brief` bruker den ikke).
- **Kun metadata:** kontrollsentrene (`agents.ts` leser aldri tittel, resultat eller feiltekst).
- **Ubrukt:** `ContextBuilder.open_tasks` (motoren leser kun `context.history`).
- **Andre domener:** `operations.list_tasks`, `todoist.list_tasks` og video-`get_task_status`.
- Detaljer står i runbooken.

## Runbook (endret)
- Nye rader K3c og K3d, og egne seksjoner for jobbresultater og bekreftelsesbanen.
- Steg 7d/7e, begrensning 12–15, og to nye «flagg AV = main»-detaljer.
- Oppdatert bevis og NOT VERIFIED.

## Åpne punkter
- **Q-4:** nå bygget på alle tre veier (hurtigbane, modelldrevet uten bekreftelse, modelldrevet med bekreftelse), og resultatet holdes tilbake ved lesing. Gjenstår:
  - jobber og kort opprettet før aktivering,
  - jobber som selv leser finans- eller helsedata (kun oppgaveteksten klassifiseres),
  - NAS.
- **Q-2:** `system_status` er den hyppigste smitteutløseren. Mål frekvensen på NAS. Innstrammingen står i runbooken, ikke bygget.
- **Q-9:** tillegg `tasksSource`, `open_tasks` og `personal.finance_read`.
- **Avvik å vurdere:**
  - `approveAndTake` returnerer `taint_reasons` uavhengig av flagg, som i reviewerens prototype. Kortet i databasen og bindingen er uendret med flagg AV.
  - `ChatJobs` henter `restricted_origin` som ekstra SQL-kolonne også med flagg AV (viewet og kallformen er uendret).
  - Et ventende kort fra en ulåst tur som gjenbrukes av en senere låst tur får ikke merket. Parametrene er byte-like, så ingenting nytt kan ha kommet inn.
  - `jobbstatus` låser uavhengig av jobbens status (strengeste regel).

## NOT VERIFIED
- NAS og ekte Ollama/Anthropic, og kjeden motor → ekte `ModelGateway`.
- Flagg PÅ i full api-oppstart via compose.
- `/confirmations` med ekte grant og identitet, og dashbordet.
- `get_task_status` og `jobbstatus` med en ekte sky-tur på NAS.
- Lekkasjetidspunktet ende-til-ende (vindu utløpt eller ny økt).
- Alle runbook-steg 1–8 og 7b–7e.
