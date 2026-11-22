TS: 2026-11-22T11:24:45.742Z
VERDICT: MERGE ETTER FIKSER - 0 HIGH, 2 MEDIUM (M1: utførelseslåsens lokalitetsprediktat i `main.ts` er ikke kjørbart testet, dekkes før merge; M2: bakgrunnsjobb-levering fra en låst tur lagres umerket, reprodusert, fiks før aktivering), 5 LOW/INFO.

Jeg fant ingen vei der en merket eller låst-avledet historikkrad når en skymodell via `conversation.ts` (12 000 tilfeldige observasjoner, 0 lekkasjer). Flagg AV er observasjonsmessig identisk med en uavhengig regenerert `main` (20 254 observasjoner, 0 forskjeller). Funnene gjelder testhull i en sikkerhetskontroll og to kanter i merkingen.

## Metode
- Worktree `n1-rev-a` @`96999794`. Sporede filer gjenopprettet etter hver mutant, probene flyttet ut, `git status --short` tom.
- Uavhengig `main`-kopi via `git archive ec3e684e` i `/tmp/lead/N1-review-A-probes/main-copy` (ingen refs rørt). Byggerens harness og scenarier kjørt uendret mot den.
- Egen seedet generator med 4000 blandede og 6000 skynære scenarier. Historikker på 0-24 rader har tilfeldige merker og norske finans-/helsefraser. Dekker hurtigbane, råd, overstyring, feilbaner, strømming, dagstak og minnevarianter, begge flater.
- Kjøring: `su postgres -s /bin/bash -c '... pnpm exec vitest run --maxWorkers=2 apps/api/test/zz-n1-review-a-*.test.ts'`. Filene ligger i `worktree-final/` og kopieres inn i testmappene.

## Funn (rangert; fil:linje mot HEAD)
**M1 MEDIUM: K6-prediktatet i produksjon er ikke testet kjørbart.** `apps/api/src/main.ts:451`.
- W01 (`!servedByCloudModel` invertert: lokal nektes, sky slipper), W02 (`=> true`: låsen virker aldri) og W07 (`=> false`) overlever alle 8 N1-testfiler (98 tester, 0 drept av 6 overlevende).
- `wpn1-guard-env.test.ts` sjekker bare tekstprefikset `servedLocally: `. Gateway-testene bruker egne prediktat.
- Logikken er riktig i dag. Jeg kjørte uttrykket mot alle 10 `DEFAULT_PROFILES`: `local_llm`, `gemma_local`, `ollama` og `scripted` er lokale. `openai`, `anthropic`, `gemini`, `gemma_hosted`, `kimi` og `hermes` er sky. `""`, `" "`, ukjent og `GEMMA_LOCAL` er sky.
- Reproduksjon: `zz-n1-review-a-wiring.test.ts` er grønn på HEAD og dreper W01/W02/W07.
- Fiks (0 prod-endring): ta wiring-proben inn som test. Alternativt eksporter `financeLockServedLocally` fra `restricted-context-guard.ts`, bruk den i `main.ts` (guard-env-regexen matcher fortsatt), og enhetstest mot `DEFAULT_PROFILES` pluss ukjent/blank/store bokstaver (ca. 15 linjer).

**M2 MEDIUM (aktiveringsblokker, DEFERRED i runbooken): jobb-levering umerket.** `main.ts:773` -> `chat-jobs.ts:194`.
- Leveringen lagres med tre argumenter, umerket, selv når jobben ble startet av en LÅST tur. Signalet `cloud.restricted` finnes allerede (`conversation.ts:1188-1201`).
- Reproduksjon på ekte Postgres: `zz-n1-review-a-delivery.test.ts` (3 grønne). Låst jobbstart merkes, to skyturer skyver merkene ut av vinduet, og `sweepDeliveries` med `main.ts` sin egen lambda gir `restricted=false`. Neste Anthropic-kall bærer leveringsteksten: `M2: neste skytur pref=anthropic ... bærer leveringen: true`.
- Kontroll: samme rad lagret med `{restricted:true}` holdes utenfor skyvarianten.
- Avgrensning: tittelen er de første 70 tegnene av forespørselen (`main.ts:1426`), så tekstklassifisereren fanger de fleste. Hullet er lås fra minne/utvalg, stikkord etter tegn 70 og nøytral parafrase i resultatet.
- Fiks (ca. 40-60 linjer + DB-test): `delegateBackground.run(..., { cloudAllowed, restricted: cloud.restricted === true })` -> felt i `ToolInvocationContext` (som `contentOrigin`) -> `restricted_origin` i `contract.input.data` -> `sweepDeliveries` kaller `saveMessage(..., { restricted: true })`, og `main.ts:773` sender `opts` videre.

**L1 LOW: testhull i motoren (alle overlever hele N1-settet).**
- C08: rådet med D-381-handlingsutvalg (`conversation.ts:921`, `councilSensitivity` -> `contentSensitivity`).
- C09: `routing_unreadable` fail-closed (`:1149`).
- C11: jobb ikke startet men låst (`:1193`).
- D07: SQL-teksten til flagg-AV-`save` er ikke pinnet (`message-store.ts:42`).
- T03/T04: ingen test av at `history:restricted`-merknaden er uten tall og leverandørnavn (`tool-turn-route.ts:78`).
- Koden er riktig; mine prober er grønne på HEAD. `council`-, `fast`- og `sql`-probene dreper C08, C09, C11, C13 og D07.
- Fiks: ta probene inn, og legg til `expect(/\d/.test(localOnlyNote(["history:restricted"]))).toBe(false)`.

**L2 LOW: `FAST_INTENT_RESTRICTED` (`restricted-context-guard.ts:30-32`) er inkonsekvent mot egen regel.**
- Tabellen sier at status, selvdiagnose og SLO ikke bærer finansdata. Men `slo_report` kan inneholde «Kostnad per kall økte fra 3 til 6.7 øre (+122 %)».
- Kjørt mot ekte `detectDrift` + `composeSloReport` (`slo-cost.mjs`). Selvdiagnosen får det samme via `slo-source.ts:121` (lest, ikke kjørt).
- Dette er AI-kost i øre, samme klasse som `cost_report`/`value_report` som er merket under «strengeste regel». Lav risiko (Q-64 pkt 1).
- Fiks: dokumenter i runbook pkt 6, eller merk betinget når svaret inneholder « øre».

**L3 LOW: smitte (D-3) er nødvendig taint-propagering, men uten utløp.**
- Måling, 60 kjeder x 30 turer etter én låst tur:

| Turblanding | Låst PÅ | Låst main |
|---|---|---|
| Ren prat, `hva koster du` som start | 100 % | 0 % |
| Ren prat, verktøylås som start | 100 % | 10 % |
| 30/50/100 % verktøyturer | 7/4/0 % | 7/5/0 % |

- Skyverktøyturer er uendret (562/562, 920/920, 1800/1800). Første ulåste tur ligger på median 2 med blanding.
- Mutant X01 («ikke merk turer låst kun av arvet merke») får taint-proben til å feile. Oppfølgingens svar «TOK-A2» når Anthropic allerede i T3, fordi parregelen skyver T1-merket ut av vinduet. Byggerens alternativ (b) lekker derfor; behold (a).
- To rettelser: `tool-turn-route.ts:80` («Dette varer til emnet ikke lenger er blant de siste meldingene») er usant når kjeden fornyes. Og eksplisitt «bruk Claude» vil feile mot `SECRET_RESTRICTED` så lenge kjeden varer (D-378). Det siste er resonnert fra routerens regel, ikke testet.

**L4 LOW: verste utfall ved feilet merking.** Probe `zz-n1-review-a-db.test.ts`.
- Turen kaster før modellkallet (begge feilmodi, alle baner). Men brukerraden står igjen umerket uten svar, og neste skytur sender spørsmålet «hvordan går det med kontoen min?» til Anthropic. Kun spørsmålsteksten, ikke svar. Samme ved prosessdød mellom save og merking.
- På hurtigbanen er jobben allerede startet når `lock()` kaster (`conversation.ts:430`).
- Dokumenter i runbook pkt 8. Full fiks krever å lagre brukerraden etter rutingen, og er ikke nødvendig.

**L5 INFO: flagg AV er ikke byte-identisk i to detaljer.**
- `history()` leser alltid `restricted` (`message-store.ts:78`). SQL = main + `, restricted`, så api-image krever migrasjon 140 selv med AV. Compose har `depends_on: migrate: service_completed_successfully`, så OK i drift, men det står ikke i rollback-delen.
- Én ny oppstartslogg: `{"msg":"restricted_context_guard","enabled":false}` (`main.ts:414`).
- Skrivesetningene (6 varianter av `save`) er identiske med mains klasse, fanget med falsk pool.

**L6 INFO: kjente kanter bekreftet, ikke nye.**
- Verktøyresultater midt i en tur (runbook #4). `servingModel`-fravær gir uendret oppførsel (`gateway.ts:795`, Q-8), og stemples kun i `mesh-bridge.ts:549`.
- Forslag: en `trackedExecutor`-hook som låser ved `memory.search` med `special`/helse, og en strukturtest «hver modell-løkke gir `servingModel`».
- Ekvivalente mutanter: C05, G02, G05, C33 og M48.

## Byggerens påstander -> dom
| Påstand | Dom | Bevis |
|---|---|---|
| K3 alle låste turer/baner merkes FØR modellkall | BEKREFTET | 12 000 obs: 8010 låste (648 hurtigbane), 0 brudd. DB: 48 samtidige turer, 18 låste, 0 brudd. C01, C14, C16, C20-C32 drept |
| K3 enumerasjon av `save`-steder | BEKREFTET | Egen grep + flerlinjes-grep: kun `message-store.ts` (INSERT), `conversation.ts:396/970-971`, `main.ts:773` |
| K3 fail-closed (`restricted_marking_failed`) | BEKREFTET | Falsk butikk og ekte PG: kast/`false` gir ingen modellkall og ingen svarrad (vanlig, hurtig, råd, strøm). Verste utfall: L4 |
| K3 jobb-levering DEFERRED | DELVIS | M2 reprodusert; signalet finnes |
| K4 umerkede rader uendret (par/hale/`protect`) | BEKREFTET | 40 000 historikker, HEAD mot mains EKTE fil, 0 forskjeller |
| K4 merket rad ≡ følsom tekst; løft; skyvariant; reserve | BEKREFTET | 7306 sammenligninger (3653 historikker med merker), 0 forskjeller. 12 000 obs, 0 lekkasjer. C21 drept |
| K4 `restricted` kun eksakt `true` | BEKREFTET | Rå verdier (7 typer) i motor-probe; C05 drept |
| K5 kun eksakt `on` | BEKREFTET | 22 varianter kjørt, kun `on` gir true. G01, F01-F03 drept |
| K5 flagg AV == main | BEKREFTET (motor, skriving), DELVIS (lesing) | Baseline regenerert uavhengig, 254/254 identisk. 20 000 egne obs, 0 forskjeller (flagg utelatt og `false`). L5 |
| K5 én parser, api-only, compose | BEKREFTET | grep. Compose == `rewriteCompose(compose)`. Flagget står kun i `api` |
| K6 kobling motor -> gateway | DELVIS | `servingModel` stemples i `mesh-bridge.ts:549` (lest). Prediktatet riktig (kjørt) men uten kjørbar test (M1) |
| K7a differensialtest solid | BEKREFTET | Se Mutasjoner |
| K7c motortester | DELVIS | Solide, men L1-hull |
| K7e «45/46 drept» | DELVIS | Runneren teller non-zero exit som drept. Mine 67 har navngitt første feil |
| K8 runbook | DELVIS | Tabell, flagg og begrensninger stemmer med koden. Mangler L2, L5 og L4-presisering |
| K9, commits | BEKREFTET | 10 commits med begge trailere; kun runbook-doc endret |

Jeg leste K1/K2 og K6 (gateway/DB) bare; reviewer B dekker dem.

## Mutasjoner
80 unike mutanter, 111 kjøringer. Alle har navngitt første feilende test; ERROR/INVALID er 0.
- **Mot byggerens N1-tester (67):** 55 drept, 12 overlevde. Ekvivalente: C05, G02, G05, C33. Testhull: C08, C09, C11, W01, W02, D07, T03, T04. W01, W02, C08, C09, C11 og T03 re-kjørt mot ALLE 8 N1-filer (98 tester): 0 drept.
- **Mine prober dreper:**
  - C05, C08, C09, C11, C13, W01, W02, W07, X01 (9/9).
  - D07 (SQL-proben).
  - T03/T04 er ikke dekket; assertionen i L1 foreslås.
- **Differensialtesten alene:** R01-R08 (8 av 8 flagg-AV-endringer) drept.
  - R09 (parser) nås ikke fra differensialen; G01/F01-F03 dreper den via guard-env.
  - R10 er ekvivalent, R11 er en no-op-kontroll.
- **Cross-engine-dump mot ekte `main`:** C03, C04, R03, R04 og R06 drept (4597, 2528, 1031, 7476 og 113 av 8000 obs avviker).
- **Tenne-sjekk av mine egne egenskaper (13 mutanter, kun mine props):** 8 drept (C06, C07, C12, C14, C16, S01-S03). Overlevende:
  - C03/C04 dekkes av dump-diff.
  - S04/S05 og C21 dekkes av byggerens tester.

## Ikke verifisert av meg
- NAS, ekte Postgres på NAS, ekte Ollama/Anthropic og ekte `ModelGateway`/`router.ts`. Alle modellkall her er falske, og `SECRET_RESTRICTED` -> kun lokal er eksisterende router-kode (D-81) som jeg ikke har kjørt.
- Full suite, `pnpm lint` og `check:containment` (lead). Mine kjøringer på HEAD: typecheck (core, model-gateway, tool-gateway, api) exit 0 og eslint på endrede filer exit 0.
- Flagg PÅ i full api-oppstart via compose. Jeg har kun vist at alle 10 endrede produksjonsfiler laster under `node --experimental-transform-types` (10/10).
- Ekte minneekstraksjon (testet mot falsk `ingest`).
- `selectSurfaceTools`' D-389-semantikk for oppfølginger utover byggerens A2-test (min harness bruker en fast velger).
- UI/dashbord.

## Probe-mappe
`/tmp/lead/N1-review-A-probes/` inneholder:
- Prober i `worktree-final/` (`zz-n1-review-a-*.test.ts`, `zz-n1-review-a-gen.ts`). Hjelpefilen for `sql`-proben ligger som `main-message-store.ts.txt`: kopier den til `modules/core/src/services/zz-n1-review-a-main-message-store.ts`.
- `mutate.py` til `mutate6.py`, `dumpmut.py`, `mutants*.json/log`, `dump-*.json`, `main-copy/`, `probes-clean.log`, `delivery.log`, `x01.log` og `typecheck.log`.
