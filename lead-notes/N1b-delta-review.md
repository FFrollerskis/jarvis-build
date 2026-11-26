TS: 2026-11-26T04:56:48.333Z
VERDICT: MERGE. 0 HIGH og 0 MEDIUM: begge MEDIUM-funnene (Sikkerhet-senteret, `get_infra_status`/`infra`) og alle LOW fra runde 1 er lukket og bevist, bortsett fra A80 som er delvis. Tre nye LOW gjenstår. Ingen av dem åpner en lekkasje i standardkonfig, og alt er DORMANT bak flagget. Jeg anbefaler en liten fiks-runde 2 før NAS-aktivering, ikke som merge-blokker.

Tipp `616a8977`. Begge worktrees er løsrevne, og `git status` er tom etter alle kjøringer (verifisert). Alt er kjørt som `postgres` med `--maxWorkers=2`, `--bail=1` og `timeout -k 5`.

## 1) Tidligere funn -> status
- **A M-1 Sikkerhet-senteret: LUKKET.**
  - A sin delta-probe D1 gir 37/37 (vakt PÅ: sky/ukjent/blank filtrert, lokal/eier full).
  - B D6 gir 8/8: `get_control_center{security}`, `get_security_center`, oversikt, nøstet, `null` og FLAGG AV = H2.
  - B D11 (probes2) ga «ekte forskjeller = []» for sky/ukjent/blank/null. Én probe-egenkontroll er rød, se punkt 5.
  - Mutantene D01-D10, D49, N01-N04 og N09-N11 er drept.
- **A M-2 = B F1 `get_infra_status` + `infra`-situasjoner: LUKKET.**
  - B D1 gir 14/14: kilden leses ikke, køen er uten `infra`/`spend`, og enkeltoppslag gir kun merke uten `external_id`.
  - D11-D13, D16, D17, D51, N10 og N16 er drept.
- **A L-1 `telnyx.get_account_info`: LUKKET.** Kun merke, og leverandøren kalles ikke (B D7 8/8). D30-D33, D52, D53, N21, N22 og N24 er drept. De øvrige leverandørverktøyene er DEFERRED/akseptert i begrensning 26, og det har jeg ikke re-revidert. Hull i videresending av argumenter: se 2c.
- **A L-2 testhull:**
  - A71 -> D26 drept (`wpn1b-oracle`).
  - A24 -> D41 drept.
  - A53 -> D42 og A55 -> D44 drept.
  - A52/A54 -> D43/D45 er drept av en feilet atferdstest (`ExecutiveAccessDeniedError`). Runneren merket dem TECHNICAL, men de er kills.
  - **A80 DELVIS:** D46 (liste) og D47 (Set) er drept av structure G, men D48 overlever. D48 er en regex-literal `/^(ollama|gemma|hermes)/i` i `run-rate.ts`.
- **A L-3 = B F2 `null`: LUKKET.** B D2 gir 13 uleselige former × 6 K2-stier, finanslås og nøstet, alle sky. A ALS gir 19/19. D18 er drept.
- **B F3 setteren: LUKKET.** `runWithModelScope` finnes ikke i pakke-API (B D3), og dyp import gir `ERR_PACKAGE_PATH_NOT_EXPORTED`. D20, D21, D22, D55 og E05-E07 (= C36, C41 ×2) er drept av structure A/H.
- **B F4 orakel i `list_connector_maintenance`: LUKKET** for plasstjeling og minuttsum.
  - Sky-svaret er uendret med 5+1 nye finansrader (B D4, test 1-2 grønne).
  - D23-D29, N18 og N19 er drept.
  - Id-håndteringen i samme sti er ny LOW-1.
- **B F5:**
  - C15/C16 -> E01/E02 drept av `wpn1b-oracle`.
  - C23/C24 -> E03/E04 drept av `withhold-before-read` A (spion).
  - C20/C21 er ekvivalente: E08 overlevde begge passene, og F34/F35 hos byggeren er det samme.
- **B F6 dokumentasjon: LUKKET.**
  - `at` står riktig i 7c/7g (D39 og B-D01 drept).
  - B D8 kjørte 19 SQL-snutter mot en migrert DB uten feil.
  - Tallet 30 er låst (D38 og B-D02 drept).
  - Begrensning 6 og I5 står nå som «IKKE lukket generelt».
- **B F7: LUKKET** som ærlig tekst. 7h-7k teller ikke fra `audit_events`. I6 og begrensning 7 sier at workeren ikke har noen lås; `worker-main.ts:216` og `:534-538` stemmer med koden.

## 2) Nye funn i deltaet (rangert)
**LOW-1: ukjente fritekst-id-er slipper gjennom stamme-svartelisten (B sitt nye LOW, bekreftet).**
- Hvor: `modules/tool-gateway/src/finance-withheld.ts:37` (`FINANCE_STEM`) og `:48-53` (`isFinanceConnectorId`). Samme predikat brukes i `apps/api/src/run-rate.ts:127` og `security.ts:201` (frosne koblinger), og i `modules/executive/src/finance-withheld.ts:29` (`owner_control`).
- Kommentaren i `run-rate.ts:119-121` kaller det «tillatelsesliste», men det er en svarteliste.
- Id-ene er fri tekst: `connector_maintenance_log.connector_id` (migrasjon 077) og `record_connector_maintenance` (`z.string().min(1).max(80)`), og `owner_controls.freeze_connector` (`modules/owner-controls/src/transport.ts:237`, `z.string()`).
- Probe B D4: sky ser `["github","slack","bankid","betaling","kasse","regnskap","stripeapi"]`.
- Min regex-kjøring (`/(^|[^a-z])(finance|…|bank)([^a-z]|$)/i`) viser at `sparebank1`, `paypal`, `klarna`, `adyen`, `tripletex`, `visma`, `revolut`, `dnb`, `nets`, `faktura` og `mystripe` også er synlige.
- Alvorlighet LOW, ikke MEDIUM. Det krever at eieren selv skriver en id utenfor registeret. Sky ser bare id, `event_kind` og minutter (`reason` er `null`), og det er ingen regresjon mot main. Det bryter likevel «ukjent = finans» (Q-64 pkt 1 / D-477).
- Minimal fiks (validert ved midlertidig anvendelse, filene gjenopprettet):
  ```ts
  // finance-withheld.ts: legg til
  const KNOWN_NON_FINANCE = new Set(CONNECTOR_REGISTRY.filter((c) => c.category !== "finance")
    .flatMap((c) => [c.id, ...(c.live_test ? [c.live_test.tool_id] : [])]));
  export const isKnownNonFinanceConnectorId = (id: unknown) =>
    typeof id === "string" && KNOWN_NON_FINANCE.has(id.trim()) && !isFinanceConnectorId(id);
  // run-rate.ts:127 -> .filter((id) => isKnownNonFinanceConnectorId(id))
  ```
  - Resultat: D4 gir `["github","slack"]`, og 5 filer / 302 byggertester er grønne (`oracle`, `derived-table`, `before-read`, `d421`, `wph0-integration-center`). Kommando: `python3 /tmp/lead/N1b-review-C/fixcheck-d.py`.
  - Samme hjelper (og en tilsvarende for credential-refs) bør brukes i `security.ts:201` og `executive/finance-withheld.ts:29`; det har jeg ikke validert. Alternativ: dokumentert aksept som ny begrensning 27 pluss Q.

**LOW-2: runbook (`docs/runbooks/WPN1_RESTRICTED_HISTORY.md`).**
- Steg 7m (l.243) og 7n (l.244) mangler «kun test-tenant/syntetiske data».
  - 7m slår vakten AV, så en skytur får finansinnhold med vilje.
  - 7n fryser en «TEST-kobling» i den ekte tenanten.
  - Bare 7h sier «TEST-tenant (aldri produksjon)». Alle skyturene i 7g-7q kjører mot den ekte tenanten, så dette bør settes som felles forbehold.
- 7n krever `JARVIS_CONTROL_CENTER_SECURITY=on`, men steg 3 (l.45) og steg 8 (l.248) forbyr kontrollsenter-flaggene før 7g-7q er kjørt. Det er sirkulært. Presiser at SECURITY slås på midlertidig kun for 7n.
- l.45 grupperer fortsatt Sikkerhet under «bygges uten finansavledet tilstand». Etter FIX-1 filtreres det (R24). Rett ordlyden.
- Begrensning 6/7, I5/I6, R24a/b/R25 (l.152-154), `at` i 7c/7g og tallet 30 stemmer med koden.

**LOW-3: testhull som fortsatt overlever (8 klynger).** Alle er LOW eller INFO; ingen er lekkasje i dag.
- a) `isCloudWithheldAttentionDomain` (`finance-withheld.ts:77`) har ingen enhetstest for ikke-streng eller normalisering (D14/N15, D15/N14). `situations.domain` er fritekst med kun `CHECK(length>0)`. Fiks: kopier assertions fra `wpn1b-finance-withheld.test.ts:84-86`.
- b) Telnyx-innpakningen (`:93-94`): `signal`, `context` og parametre til eier/lokal er ikke pinnet (D34-D36/N23). Spionen i `wpn1b-provider-tools.test.ts` registrerer bare `action`. Fiks: assert at alle fem argumenter er identiske.
- c) Oversikten `get_control_center` uten `center` mangler `finance_withheld` uten at noen test feiler (D50/N12; `transport.ts:174`). Runbook R23 (l.151) sier «+ merke».
- d) `main.ts:819`-ledningen av `financeGuard` er bare tekst-pinnet. N07 er drept bare av tekstvakten, og N08 (spredningen flyttet etter kallet, teksten uendret) overlever alt. Fiks: pin plasseringen inne i `registerControlCenters({…})`, eller gjør `financeGuard` til et påkrevd boolean i `ControlCenterWiring` så utelatelse blir en typefeil.
- e) `reason: null` for sky i vedlikeholdsloggen er ikke pinnet (N17). `allowed` kan byttes med en navneliste uten at noen test feiler (N20, stamme/namespace-delen er uten integrasjonstest). Fiks: legg `finance_stripe`, `bank_x` og et ukjent id-radpar i R22-fixturen.
- f) D48: lokalitetsvakten G teller bare siterte literaler, ikke regex/prefiks. Fiks: tell også `\b(ollama|gemma_local|local_llm|local_vision|scripted)\b` i kode med eksakt tillatelsesliste.
- g) D05: steg 8-listen over flagg er ikke pinnet av `wpn1b-runbook.test.ts`.

**INFO:** tre kommentarer refererer testfiler som ikke finnes.
- `modules/tool-gateway/src/finance-withheld.ts:9` -> `wpn1b-finance-withheld-note.test.ts`; riktig er `wpn1b-finance-withheld.test.ts`.
- `modules/tool-gateway/src/model-scope.ts:9` og `:20` -> `wpn1b-model-scope-structure.test.ts`; riktig er `wpn1b-structure.test.ts` (A) og `wpn1b-model-scope.test.ts`.

## 3) Mutanter (kjørt / drept / overlevd)
- **Byggerens** (F01-F36 + B60/B61, og B01-B51): 75 / 73 / 2. De to er F34/F35 (ekvivalente). Logg: `/tmp/lead/N1b-review-B-probes/mutants-builder-delta{,-B}.log`; ikke kjørt om av meg.
- **A, før avbruddet** (D01-D40, `mutate2.py`): 40 / 35 / 5. Overlevende: D14, D15, D34, D35, D36.
- **A, av meg** (D41-D55, `mutate3.py`): 15 / 13 / 2. Overlevende: D48, D50.
- **A, av meg** (E01-E08, `mutate5.py`, C-seriens survivors i ny form): 8 / 7 / 1. Overlevende: E08 (ekvivalent, C20).
- **B** (`node mutants-B2.mjs`, N01-N31 + D01-D06): `TOTALT 37 DREPT (atferd) 26 KUN-STRUKTUR ["N07"] OVERLEVDE [N05,N06,N08,N12,N14,N15,N17,N20,N23,D05]`. Altså 37 / 27 / 10.
- **Reviewermutanter samlet:** 100 / 82 / 18.
  - Av de 18 overlevende er 3 ekvivalente: N05 og N06 (alle registerets finans-id-er og refs inneholder en stamme) og E08.
  - De øvrige 15 danner 8 testhull-klynger (LOW-3 a-g).
  - Alle gamle overlevende (A71, A24, A53/A55, C15/C16, C23/C24, C36, C41) er nå drept. A80 er delvis (D48).

## 4) Flagg AV = main
Tall fra A sine kjøringer på tippen, pluss min omregning:
- `zz-n1b-review-a-flagoff`: 154 scenarier × 2 mot en ordrett main-kopi av `gateway.ts`. Resultat, SQL, transportkontekst og mikrotask-tick (45 kombinasjoner) er byte-like. FIX-9-avviket er borte.
- Snapshot 57 scenarier × 5 modellklasser = 285 oppføringer, 13 produksjonsfiler byttet inn fra `71a31d8b`.
  - Jeg regnet det på nytt fra `snap2-*.json`: 20 rå diffs (klokkeminutt og `db_bytes`), 0 etter normalisering.
  - `finance_withheld` forekommer i 0 av 285 på begge sider.
- Mutanter som bryter identiteten er drept: D02 (`strict` uavhengig av vakten, atferd), N09 og N11 (atferd), D09 (tekstvakt), D19/N25 (løsrevet `execute`).
- Filer og fixtur: ingen `skip`/`only`/`todo` er lagt til siden `ebc85c38`. `fixtures/` er urørt.
- Ingen tidligere assertion er svekket. Fjernede `expect`-linjer i `wpn1b-structure`/`derived-table` følger FIX-endringene.
- Regresjon på tippen (A, `logs/base-n1b-tip.log`): 16 filer / 504 tester grønne, `EXIT=0`. Det er de 10 N1b-filene (442) pluss 6 N1/H-filer.

## 5) Ikke verifisert av meg
- NAS, ekte Ollama/Anthropic, ekte transporter (Gmail/MCP/browser), ekte Telnyx-svar (kun kodelesing) og workeren (kun lest).
- Byggerens rød-først-påstand (54 av 431 røde mot `ebc85c38`-kode). I stedet gir 82 drepte mutanter mot tippen tilsvarende bevis.
- Byggerens brede regresjonssett (171/2750, 66/1221, 40/882, 267/4315) og hele suiten.
- `pnpm typecheck`, `lint`, `check:containment` og gitleaks.
- De andre leverandørverktøyene i begrensning 26 (kun lest, ikke re-revidert).
- Probes2 D11: én av ti tester feiler, og det er probens egen støykontroll (30 støystier > 25, kun `sky`). Støystiene er revisjonsaggregatene `events_*`/`denied_*` i seksjon 0 (= begrensning 25), så D11 kan ikke skille frys-tellingen fra støy.
  - `Tests 1 failed | 9 passed (10)`; D11 «ekte forskjeller» = `[]` ×4, kontroll (lokal ser forskjellen) og D12 ×4 grønne.

Probe-mapper:
- `/tmp/lead/N1b-review-A-probes/` (`logs/mutation-delta2.log` og `mutation-delta3.log`; `mutate3.py`, `mutate5.py`)
- `/tmp/lead/N1b-review-B-probes/`
- `/tmp/lead/N1b-review-C/` (`mutants-B2.log`, `probes2.log`, `fixcheck-d.py` og `.log`, `runbook-tip.md`)
