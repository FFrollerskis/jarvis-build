TS: 2026-11-25T20:16:43.289Z
WP-N1b er bygget og pushet til `claude/wp-n1b-finance-serving-model` (HEAD `ebc85c388683d9d55a5294f59db5c8e50194fd10`, origin = FFrollerskis/jarvis-build). Ingenting er verifisert mot NAS, og alt ligger bak det eksisterende flagget (AV som standard). Jeg har ikke åpnet PR og ikke merget.

Ingen `CORE_DEPENDENCY_DECISION_REQUIRED`, ingen `HARD_EXTERNAL_BLOCKER`. Ingen nye flagg, ingen migrasjon, ingen pinned baseline oppdatert.

## Gren og commits (10 foran origin/main, 28 filer, +2236/−112; produksjonskode ca. 600 linjer)
```
ebc85c38 docs: runbook: tasksSource/open_tasks er ikke modellnåbare
45032475 docs: K3/K6 runbook (tabell, aktiveringsrekkefølge, NAS-steg)
b7184d2e test: K4f mutantsett (39 mutanter)
0a15a3f8 test: K2/K4 kartleggingstabell, enhetstester, strukturvakter
efae3c2f feat: K2 run_rate
8cb34c6f feat: K2 executive
2f0e6eb7 feat: K2 conversation-graph
84eda34c feat: K2 business
da57d674 feat: K2 tool-gateway (nøytralt merke og klassifisering)
7e835320 feat: K1 servingModel gjennom nøstede kall
```

## Status per punkt
- **K1 ferdig (WIRED, DORMANT).** `model-scope.ts` er en `AsyncLocalStorage` etter mønster fra `call-signal.ts`. `ToolGateway.execute()` er nå en tynn omslag (`gateway.ts:786-800`) rundt `executeCall` med uendret kropp.
  - Skopet settes kun når utførelseslåsen er injisert (vakten på). Vakt AV går rett til kroppen.
  - Et ytre sky-skop løsnes aldri. Lokalitetsvedtaket tas én gang med `servedByCloud`, som kaller `financeLockServedLocally`, og ingen fjerde kopi finnes.
  - Ingen modell gir full tilgang; ukjent eller blank leverandør regnes som sky.
  - Executive sin egen per-tjeneste-holdback (`service.ts:435,460`) er beholdt som dybdeforsvar (ELLER-ledd).
  - Rød-først: før gatewayintegrasjonen feilet 10 av 16 tester.
- **K2 ferdig for 23 stier (WIRED, DORMANT).** For sky/ukjent modell holdes finansavledet innhold tilbake ved utførelse, med et fast nøytralt svar (`finance_withheld` + `note_no`, uten sifre, id-er, tellinger eller leverandørnavn). Merket er alltid med på håndterte stier, også når ingenting ble fjernet. Lokal modell og eierens ruter får alt.
- **K3 ferdig.** Aktiveringsrekkefølge og NAS-steg 7g–7m i runbooken. `JARVIS_CONTROL_CENTER_FINANCE`/`_VALUE` først etter at 7g–7m er kjørt. Alt står som NOT VERIFIED til du har kjørt dem.
- **K4 ferdig.** Detaljer under Tester.
- **K5.** Ingen nye flagg. Env-drift, D-420, connector-sdk, `wph1-flag-off-selection-baseline` og `wph2-flag-off-main-parity` er grønne. To N1-tester er tilpasset (se Sikkerhetsflater).
- **K6.** `docs/runbooks/WPN1_RESTRICTED_HISTORY.md` oppdatert (ny seksjon, tabell, byggetabell K7/K8, steg, begrensning 6/12/13/14/19 og nye 20–24, bevis, NOT VERIFIED). De delte docs er ikke rørt.

## Kartleggingstabell (alle stier kunne lekke til sky før N1b; bevist av vakt-AV-kontrollen i hver rad)
- **R01–R06, business:**
  - `list_open_loops`, `get_attention_queue`: filtrert.
  - `read_open_loop`: kun merket.
  - Daglig brief: kilden filtrert.
  - Ukebrief: SQL-hvitliste, tallene bygges på resten.
  - `get_calibration_report`: filtrert før rapporten bygges.
- **R07–R12, executive:**
  - `get_attention_queue`: `spend`-situasjoner ut før rangering. `get_attention_item`: kun merket.
  - `get_capability_status`, `get_connector_status`: finans ut, oppsummering på resten.
  - `get_control_surface_status`, `get_delegation_board`: finanskoblinger ut, alle fritekst-begrunnelser `null`, `spend`-pauser og autonomibindinger ut.
- **R13/R14/R14b, R23:** Autoritet, Integrasjoner og AI holdes tilbake helt. Oversikten lister dem under `withheld`.
- **R15, R18–R20, R16:** kun merket for `get_value_report`, `get_self_diagnosis`, `get_ai_mesh_status`, `get_evolution_report` og `run_rate.get_cost_overview`.
- **R17:** `get_slo_report` uten kostnadsdrift, rapporten komponert på nytt.
- **R21a/b, conversation_graph:** `read_cross_channel_attention` og `read_cross_channel_commitment_view` bruker SQL-hvitliste. Disse leste `business_open_loops` uten typefilter.
- **R22:** `list_connector_maintenance` uten finanskoblinger.
- **Vurdert uten endring:**
  - Navnerom: `finance*` (låsen), `tasks.get_task_status` (N1), H2-sentrene, `get_infra_status`, CRM/contract/operations/product/support (ingen beløpsfelt), eksterne leverandører.
  - Ikke modellnåbare: `personal.finance_read` (kildevakt E), `tasksSource`/`open_tasks`.
  - Skrivehandlingene på åpne løkker: bare bak bekreftelseskortet (strukturtest F).

## Antakelser (forslag til D-482)
1. Skopet settes kun med vakten på; vakt AV er byte-lik main.
2. Et ytre sky-skop vinner alltid over en eksplisitt modell i et nøstet kall; et lokalt skop kan strammes.
3. Ingen modell betyr full tilgang (eier, hurtigbane, system).
4. `marketing_spend_anomaly` regnes som finansavledet (strengeste). Én linje å snu.
5. Filtrering skjer per løkketype, ikke per innhold, fordi `reason` er fritekst.
6. AI-kost i øre regnes som finans (Q-64 pkt 1, strengeste regel).
7. Hele sentrene Autoritet/Integrasjoner/AI holdes tilbake, ikke per seksjon.
8. Rapporter med fritekst fra leserne holdes tilbake helt.
9. `owner_control`: fritekst-begrunnelser er alltid `null` for sky; finanskoblinger og -credentials fjernes.
10. Enkeltoppslag av et finanselement gir merket, ikke «ikke funnet» (id-orakel akseptert).
11. SQL-hvitliste: en ukjent løkketype utelates (fail-closed).
12. Skriveekko på åpne løkker er uendret.
13. Lokal modell får alt, men svaret dens kan lagres umerket (JARVIS-116 (e)).
14. `growth.*` er DEFERRED.
15. Ingen nye flagg, ingen migrasjon.

## Tester (som OS-bruker `postgres`, maks 2 arbeidere)
- **5 nye filer, 218 tester, alle grønne** (`wpn1b-model-scope` ×2, `-finance-derived-table`, `-finance-withheld`, `-structure`).
  - Samtidighet: 126 kall (sky/lokal/ingen) i K1-testen og 100 blandede kall i tabelltesten, uten kryssing.
  - Tabelltesten kjører hver rad for sky/ukjent/blank (holdt tilbake), lokal/eier (full) og flagg AV (som main).
  - `wpn1b-structure` (25): lesere pinnet per fil og alle 54 verktøynavnerom på modellflatene klassifisert; hver handling i business/executive/run_rate/conversation_graph er plassert og har en tabellrad.
- **Rød mot main-oppførsel (K2):** med den sentrale lesningen satt til aldri å holde tilbake (B09) feiler 71 av 151 tabelltester.
- **Mutanter:** `N1B_RUN_AS=postgres node apps/api/test/support/wpn1b-mutants.mjs` gir 39 mutanter, alle drept av en feilet assertion. Ingen overlevende, ingen tekniske brudd, ingen ugyldige. Ingen ekvivalente, så ingenting å forklare.
- **Regresjon:**
  - conversation-graph/business/executive: 66 filer / 1221 tester grønne.
  - tool-gateway + N1-settet + `wpn1*`: 166 filer / 2526 tester, kun de tre kjente `wpc3-review1-hardening` F10a/b/c røde.
  - `wph1`/`wph2` og vaktene (executive-parity, env-drift, d420, connector-sdk): 40 filer / 882 grønne.
  - Hele `apps/api/test` + `modules/situations/test`: 262 filer / 4091 grønne.
  - Ingen full suite fra meg.
- `wpn1-flag-off-differential` og `wpn1-main-engine-baseline.json` er uendret og grønne.

## Statiske sjekker
`pnpm -r --workspace-concurrency=2 run typecheck`, `pnpm lint` (etter å ha fjernet én ubrukt konstant i mutantfilen) og `pnpm check:containment` har alle exit 0. Gitleaks over `origin/main..HEAD` ga «no leaks found» (siste kjøring før siste push).

## Sikkerhetsflater til uavhengig review
- **`modules/tool-gateway/src/model-scope.ts:51,59-60`:** tapt skop betyr full tilgang, altså feil i den farlige retningen (begrensning 24). Lesere står kun i per-kall-kode etter `await` mot ekte `pg`-pool. `gateway.ts:786-800` er omslaget (ambient-vinner-regelen), og `gateway.ts:834` er låsen som nå ser den effektive modellen.
- **Klassifiseringen** (`tool-gateway/src/finance-withheld.ts:35-68`, `business/src/open-loop-types.ts:50-90`): fail-closed, men `isFinanceConnectorId("")` er `false`.
- **SQL-hvitlistene** (`business-brief.ts:185,190,194`, `conversation-graph/src/service.ts:915-931`) og transportene (`conversation-graph/src/transport.ts:139-155`, `business/src/transport.ts:250-310`).
- **`executive/src/transport.ts`** (11 lesere, bl.a. `:46-48`, `:85-232`), `executive/src/service.ts:435,460` og de tre formingsfunksjonene i `executive/src/finance-withheld.ts:26-66`.
- **`GUARDED_CLOUD_WITHHELD_CENTERS`** (`control-center/tools.ts:96`) og `apps/api/src/run-rate.ts:158-165`.
- **Tilpassede eksisterende N1-tester:** `wpn1-nested-finance-lock.test.ts:177-180,252-262` (B1/C3 beskrev «lås PÅ + executive-vakt AV» som hull; det er nå lukket sentralt, så forventningen er snudd) og `wpn1-stamping-structure.test.ts:34-38`. Ingen differensialtest eller baseline er rørt.

## Motsigelser jeg fant (rapportert, ikke valgt stille)
- `loopFamily()` sier at `marketing_spend_anomaly` er «growth», mens situasjonsbroen (`spend`) og Finans-senteret regner den som økonomi. Jeg valgte strengeste.
- H2-notatene for Finans/Verdi/Evolusjon har sifre og referanser («D-378»). De nye notatene er sifferfrie. H2-notatene er uendret.
- Q-64 pkt 1 anbefaler «nei» (AI-kost er driftsdata), men strengeste regel gjelder til du svarer.

## Åpne punkter og Q-forslag (nummereres av lead)
- **Q-N1b-1:** Er AI-kost i øre finans? «Nei» (anbefalt i Q-64) frigjør `get_value_report`, `get_cost_overview`, `get_ai_mesh_status`, `get_evolution_report`, SLO-drift og AI-senteret, med én linje per sti.
- **Q-N1b-2:** Er kampanjeutgift fra Growth-kjernen finans? «Ja» betyr at `growth.*` (budsjett, utgift, CAC, ROAS) trenger samme tilbakehold (egen WP); «nei» betyr `marketing_spend_anomaly: false`. I dag er løkketeksten tilbakeholdt mens kampanjetallene er lesbare for sky (DEFERRED, begrensning 21).
- **Q-N1b-3:** Skal Autoritet/Integrasjoner/AI i stedet bygges finansfritt (`restrictFinance`), slik at skyen får en nyttig visning? I dag holdes de tilbake helt.
- **Q-N1b-4:** Lokal modell leser full finansavledet innhold, men verktøyturen er ikke låst, så svaret kan følge historikken til en senere skytur (JARVIS-116 (e), begrensning 22). Trengs en trusted markør som R3-1?
- **Q-N1b-5:** Skal executive sin per-tjeneste-holdback fjernes etter NAS-steg 7g? Anbefaling: behold.
- **Q-N1b-6:** Churn (antall forfalte kundefakturaer fra produktbruk) og helse-situasjoner har samme mønster, men er ikke finans. Bør klassifiseres separat.

## Foreslått status JARVIS-116
- **(b) `servingModel` gjennom nøstede kall:** WIRED + DORMANT, kode-lukket. NOT VERIFIED på NAS (steg 7g og 7l).
- **(a) avledet finansmetadata:** PARTIAL. De 23 stiene er WIRED + DORMANT (sky/ukjent kan ikke lese). DEFERRED: `growth.*`, minne/kunnskap (d), lokalt umerket svar (e). NOT VERIFIED (steg 7h–7k).
- **(c)–(j):** uendret, ikke bygget.
- **Ikke verifisert mot NAS:**
  - at sky faktisk får det nøytrale svaret;
  - at lokal modell og `/control` fortsatt får alt;
  - at skopet overlever i alle ekte transporter;
  - at samtidige forespørsler ikke blandes på NAS;
  - at ekte modeller oppfører seg som de falske i testene.
