TS: 2026-11-22T13:13:30.380Z
# WP-N1 fiks-runde 1: sluttrapport (bygger)

Ny HEAD er `17949ceb` (base `96999794`). Treet er rent, uten push og uten hele suiten. Delte docs er urørt, kun runbooken er endret. Alt er fortsatt DORMANT bak `JARVIS_RESTRICTED_CONTEXT_GUARD` og **NOT VERIFIED** mot NAS og ekte modell.

## Nye commits (8, begge trailerne)
```
2e6b2e54 fix: F-B1 (HIGH) utførelseslåsen omgås av nøstede kall - executive holder finans-nødbryteren tilbake fra skymodeller
fa59d4e7 fix: F-B2/F-A1 lokalitetsprediktatet flyttet til restricted-context-guard.ts og testet mot de ekte profilene
70c6dbdd fix: F-A2 jobb-levering fra en LÅST tur lagres begrenset (+ F-A4 selvdiagnose/SLO merkes, F-A6b lås før jobbstart)
f639927e test: F-A3/F-B3 testhull lukket (C08, C09/R27, C11, D07, T03/T04, R31/R32/R35, R08, L4-prober) + F-B4/I2 fail-closed save + F-A5 tekst
e17e3352 test: F-A8 strukturtest for stempling av servingModel
730d3eaa test: mutantsettet utvidet med 31 mutanter + turbilde-, taint- og rå-verdi-tester
7363d9bf fix: F-A2 turbildet får `restricted` via markøren (attachTurn); d367-vakten låser `executorFor(identity, turn)`
17949ceb docs: runbook fiks-runde 1 + M19 rettet
```

## Per funn (alle FIKSET unntatt der noe annet er skrevet)
- **F-B1 (HIGH): FIKSET.** Reviewer B sin patch er brukt som utgangspunkt.
  - Servicemetodene tar `{ withholdFinance }`. Transporten sender det kun for sky/ukjent modell, og `main.ts` setter valget kun med flagget på (betinget spredning).
  - Flagg AV er identisk: samme kallform (ingen ekstra argument) og ingen nye felter.
  - **Avvik:** den holdte avlesningen får `finance_kill_switch_withheld: true`. Uten det leses `null` som «aldri en rad / ingen nødbryter». Merket finnes kun når avlesningen faktisk holdes tilbake.
  - Bevis: `wpn1-nested-finance-lock.test.ts` (12).
    - LK5 for sky, lokal modell og eier-rute, via gateway og ekte `MeshToolExecutor`.
    - Flagg AV som main.
    - GENERELL invariant: alle registrerte web_chat-verktøy kalt som sky med låsen på når aldri en `finance*`-transport (kontroll uten lås: den nås).
    - Kildevakt over hvem som utfører `tool_id: "finance…"`.
  - **Kartlegging (c):** nøstede `gateway.execute`/`requireData` finnes i executive, business, comms, conversation-graph, growth, incidents, knowledge, owner-controls, situations og self-modification. Kun `executive/service.ts` og `apps/api/src/finance-actions.ts` (eierens egen rute) navngir `finance*`. De tre `executive.*_finance_kill_switch` står ikke på modellflaten.
- **F-B2/F-A1: FIKSET.** `financeLockServedLocally` og `FINANCE_EXECUTION_LOCK` ligger i `restricted-context-guard.ts`. `main.ts` bruker objektet, og pinnen i guard-env er oppdatert. `wpn1-lock-predicate.test.ts` (7) kjører prediktatet mot de ti `DEFAULT_PROFILES` og mot tom/blank/ukjent/STORE BOKSTAVER/feil type. R41/R42/W01/W02/W07 er drept (M68–M70, M86).
- **F-A2: FIKSET, bygget og ikke lenger DEFERRED.**
  - Kjede: `restricted` → `ToolInvocationContext.restrictedOrigin` → `restricted_origin` i kontrakten → `sweepDeliveries` → `createDeliverySaver` (kun med vakten på).
  - **Avvik (begrunnet):** jeg dekket også modelldrevet delegering. `RestrictedTurnMarker.attachTurn` setter `turn.restricted` når turen låses, og `MeshToolExecutor` videreformidler det. Samme lekkasjeklasse, som reviewer bare viste på hurtigbanen.
  - `restricted_origin` er ikke reservert i `/tasks/submit`, fordi merket bare kan øke begrensningen.
  - Setter-stedene er låst av kildevakt (to steder).
  - Bevis: `wpn1-job-delivery.test.ts` (8, ekte Postgres).
    - Reviewer A sin reproduksjon er lukket: levering `restricted=true`, og holdt utenfor neste skytur.
    - Kontroll uten lås gir umerket levering og tre argumenter.
    - Flagg AV gir kontrakt uten nøkkel og tre argumenter.
    - Modelldrevet delegering og forfalsket merke i argumentene.
    - Kontrakten overlever det ekte zod-skjemaet, køen og databasen.
- **F-A3/F-B3: FIKSET.** Probene er tatt inn som wpn1-tester, kun målrettede tilfeller:
  - council, fast, sql (+ ordrett main-kopi i `modules/core/test/support`), db (samtidighet 6×8 og feilinjeksjon), delivery, wiring, taint og odd.
  - Ikke tatt inn, per ordren: smitte-måling (`chain`), `props`, `gen`, `dump`.
  - Dekker C08, C09/R27, C11, D07, T03/T04 (`localOnlyNote`: ingen sifre/leverandørnavn/klassifisererord), R31/R32/R35 (jobbkontrakt og godkjenning løfter ikke låsen; reason-literalen er pinnet) og R08.
  - R08: katalogens ACL for ALLE roller inkl. PUBLIC.
- **F-A4: FIKSET.** `slo_report`, `self_diagnosis` og `system_status` merkes og låses før rapporten leses. `system_status` er tatt med fordi det er kortformen av samme selvdiagnose (ikke eksplisitt bestilt). Konsekvens og én-linje-bryter (Q-2) er dokumentert.
- **F-A5: FIKSET.**
  - `localOnlyNote` sier nå «Samtalen holdes lokal så lenge en begrenset melding er blant de siste meldingene» (ingen «ny samtale»).
  - Semantikken (a) er beholdt. Taint-testen F feiler mot (b), og M90 (X01) er drept.
  - «Bruk Claude» mot låst kjede: `wpn1-explicit-cloud-restricted.test.ts` (3) viser at den ekte ruteren feiler lukket. Kjeden mot ekte `ModelGateway` er NOT VERIFIED.
- **F-A6: FIKSET.** (a) Runbook pkt 8: verste utfall er spørsmålstekst, aldri svar, målt på ekte Postgres. (b) Hurtigbanen låser FØR rapport/intensjon og FØR jobbstart; en kastet merking starter aldri jobben. Bevis: M78/M87 og `wpn1-council-fast`.
- **F-A7: FIKSET** (dokumentert i runbookens rollback-del): `history()` leser alltid `restricted`, så api krever migrasjon 140 også med flagget AV, og det kommer én ny oppstartslogglinje.
- **F-A8: FIKSET.** `wpn1-stamping-structure.test.ts` (8): `servingModel: { provider: call.provider, … }` står nøyaktig én gang i produksjonskoden. Modellløkkene er kjent (chatten 1, jobbhandleren 4), og alle går via `executorFor` til `MeshToolExecutor`. M83 er drept.
- **F-B4:** I1 og I3–I6 er dokumentert i runbooken. I2 er fikset: `save` lagrer alt som ikke er `undefined`/`false` som begrenset (M82). I5 er kartlagt og IKKE endret (se Q-9).

## Tester (kommando og resultat)
- N1: `pnpm exec vitest run --maxWorkers=2 modules/{core,model-gateway,tool-gateway}/test/wpn1-*.test.ts apps/api/test/wpn1-*.test.ts` gir **177 grønne i 15 filer** (var 98 i 8).
- Bred kjøring A (HEAD `730d3eaa`; `apps/api`, executive, tool-gateway, model-gateway og core-testene pluss 91 filer som leser `main.ts`/`worker-main.ts`): 514 filer / 8233 tester, 8228 grønne. Røde:
  - `wpc3-review1-hardening` F10a/b/c (kjent sandkassefeil).
  - `embedded-postgres-ipv4-contention` (1 test): jeg tok med hele `modules/core/test`-mappen, og denne er utelatt i din fullsuite-kommando. Ikke N1.
  - `d367-memory-proposals-route`: **ny regresjon fra min F-A2-endring**, rettet i `7363d9bf` (testen låser teksten `executorFor(identity, turn)`).
- Bred kjøring B (HEAD `7363d9bf`; `apps/api/test` hele mappen + voice-e2e, memory, radar, env-drift): **230 filer / 3435 tester grønne**.
- `pnpm -r run typecheck`, `pnpm lint` og `pnpm check:containment`: exit 0 på `17949ceb`.
- Flagg-AV-differensialen (508 sammenligninger mot ren main) har 0 forskjeller, også etter fiks-runden.

## Mutanter
- **78 totalt** (46 gamle + 32 nye: M60–M91). **77 drept av en feilet assertion**, 0 tekniske brudd, 0 ugyldige. Den ene overlevende er M48 (ekvivalent).
- De nye dekker blant annet:
  - nøstet-kall-tilbakehold fjernet/snudd/ignorert og `withholdFinance` ignorert;
  - prediktatet snudd/alltid-lokal/alltid-sky;
  - `restricted_origin` ikke satt/ikke lest/lagret umerket/vakt ignorert;
  - lås etter jobbstart, slo/selvdiagnose/status umerket, `save` fail-open (I2), stempling fjernet;
  - main.ts-oppkoblinger ubetinget/svak lås, X01.
- M42 og M19 var utdatert av omskrivinger og er rettet.
- Kjøreren skiller nå assertion-drap fra tekniske brudd og feiler på sistnevnte.

## Runbook (endret)
- Nye rader K3b og K6b, oppdatert `messages.save`-tabell.
- Kartlegging av nøstede kall med I3–I6.
- NAS-steg 7b (levering) og 7c (nøstet avlesning).
- Rollback-delen: de to flagg-AV-detaljene, merket kan ikke fjernes uten superbruker-DDL, og kan fjernes via DELETE+INSERT i egen tenant (L4).
- Begrensninger oppdatert: smitte-måling og beholdt semantikk, F-A4-konsekvens, verste utfall, «bruk Claude», baseline-fixtur.
- Bevis med nye tall, og utvidet NOT VERIFIED.

## Åpne punkter (Q-forslag)
- **Q-1 smitte:** behold (a), bekreftet av måling og test.
- **Q-2 AI-kost:** nå fem intensjoner bak én bryter. Mål frekvensen av «status»-låsing på NAS.
- **Q-4: BYGGET** (hurtigbane og modelldrevet). Gjenstår: jobber startet før aktivering, og jobbresultatets eget innhold.
- **Q-3, Q-5, Q-6, Q-7:** uendret.
- **Q-8:** stempling er nå strukturtestet. Forslag til senere: en `trackedExecutor`-hook som låser når `memory.search` gir special/helse-innhold.
- **Nytt Q-9:** avledet finansmetadata utenfor `finance*` (Q-64 pkt 2). Konkrete kandidater:
  - `business.get_business_brief` og `list_open_loops` med `finance_spend_*`-løkker (innhold ikke verifisert);
  - `get_capability_status` og `get_connector_status`;
  - kontrollsentrene Autoritet/Integrasjoner/AI;
  - fritekst i `owner_control`.
- **Nytt Q-10:** bære `servingModel` gjennom nøstede kall (AsyncLocalStorage, som `call-signal.ts`) i stedet for per-tjeneste-tilbakehold.

## NOT VERIFIED
- NAS og alle runbook-steg (1–8, 7b, 7c).
- Ekte Ollama/Anthropic, og kjeden samtalemotor → ekte `ModelGateway` (kun ruterens regel er testet).
- Flagg PÅ i full api-oppstart via compose.
- Jobb-leveringen i én kjøring mot ekte modell og worker (delene er testet hver for seg).
- At `restricted_origin` overlever ekte `TaskService.submit` (testen bruker ekte skjema og kø, men en falsk `submit` uten policy).
- Eierens HTTP-ruter og `/control` mot ekte ruter.
