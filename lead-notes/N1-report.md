TS: 2026-11-22T10:30:14.316Z
# WP-N1 sluttrapport (bygger)

Gren `claude/wp-n1-restricted-history`, HEAD `96999794`, base `7de8924f`. Ingen push. Ingen andre grener eller refs rørt. Arbeid kun i worktreen `n1`.

## 1. Sammendrag og status
- **Bygget og testet:** K1–K8. K9 er overholdt: i `docs/` er kun `docs/runbooks/WPN1_RESTRICTED_HISTORY.md` ny, ingen delte docs rørt.
- **DORMANT:** alt ligger bak `JARVIS_RESTRICTED_CONTEXT_GUARD` (kun eksakt `on`, AV som standard).
- **Flagg AV er identisk med main:** differensialtest mot en ren `origin/main` (`ec3e684e`) viser 127 scenarier × web/tale × 2 AV-varianter = 508 sammenligninger, 0 forskjeller.
- **Kontroll:** med flagget PÅ avviker 102 av 254 scenario/flate-kombinasjoner, så testen oppdager forskjell.
- **JARVIS-101 er reprodusert og lukket.** Med flagg AV følger det lokale svaret til neste skytur. Med flagg PÅ gjør det ikke det, også mot ekte Postgres og med produksjonens verktøyutvalg (4 nøytrale finansfraser uten stikkord).
- **PARTIAL/DEFERRED:**
  - backfill av gamle rader
  - merking av bakgrunnsjobb-levering
  - smitten (D-3 / Q-1)
  - verktøyresultater midt i en tur
  - AI-kost (Q-64 pkt 1)
- **NOT VERIFIED:** alt mot NAS, ekte Ollama/Anthropic og ekte data (pkt 10).

## 2. Commits (10)
```
0468eec2 feat: migrasjon 140 messages.restricted + MessageStore.markRestricted (K1, K2)
0cd14d6f feat: partisjonsfunksjonene leser restricted-merket (K4, rene funksjoner)
40317508 feat: flagg JARVIS_RESTRICTED_CONTEXT_GUARD (parser, manifest, compose, hurtigbane-tabell, markør) (K5)
5791338d feat: utførelseslås for finance/finance_* mot skymodeller (K6, Q-64 pkt 3)
30a65c53 feat: samtalemotoren merker låste turer og leser merket (K3, K4, K5) + differensialtest flagg AV == main
50cbfcab test: mutantsettet (46 mutanter, 45 drepte, 1 ekvivalent) + dybdeforsvarstest for markRestricted (K7e)
e1c0971f test: motor mot ekte Postgres, dekningstest for utførelseslåsen, lekkasje med produksjonens verktøyutvalg (K7)
28b868ce docs: runbook WPN1_RESTRICTED_HISTORY.md (K8)
0cbd8c69 fix: flaggavlesingen flyttet bort fra ToolGateway-konstruksjonen i main.ts (fullsuite-funn: ua3-wiring-vakten)
96999794 docs: runbook - fullsuite-resultat, regresjonen som ble funnet og rettet, statiske kontroller
```
Alle har begge trailerne (`Co-Authored-By` og `Claude-Session`).

## 3. Filer (26, +2758/−40)
- **DB og kjerne:**
  - `modules/core/src/db/migrations/140_messages_restricted.sql`
  - `modules/core/src/services/message-store.ts`
- **Klassifisering:** `modules/model-gateway/src/content-sensitivity.ts`.
- **Verktøygateway:**
  - `modules/tool-gateway/src/gateway.ts`
  - `modules/tool-gateway/src/tool-manifest.ts`
  - `modules/tool-gateway/src/tool-failure.ts`
- **API:**
  - `apps/api/src/conversation.ts`
  - `apps/api/src/restricted-context-guard.ts` (ny)
  - `apps/api/src/main.ts`
  - `apps/api/src/tool-turn-route.ts`
- **Flaggoppsett:**
  - `infra/local/service-env.mjs`
  - `infra/local/docker-compose.yml` (1 generert linje)
  - `.env.example`
- **Tester:**
  - `modules/core/test/wpn1-messages-restricted.test.ts`
  - `modules/model-gateway/test/wpn1-restricted-history.test.ts`
  - `modules/tool-gateway/test/wpn1-finance-execution-lock.test.ts`
  - `apps/api/test/wpn1-*.test.ts` (5 filer)
  - `apps/api/test/support/n1-engine-harness.ts`, `n1-scenarios.ts`, `wpn1-mutants.mjs`
  - `apps/api/test/fixtures/wpn1-main-engine-baseline.json`
- **Runbook:** `docs/runbooks/WPN1_RESTRICTED_HISTORY.md`.

## 4. Design-valg og antakelser (D-forslag)
- **D-1 Datamodell.**
  - `messages.restricted boolean NOT NULL DEFAULT false`.
  - App-rollen får `UPDATE` kun på kolonnen (kolonne-GRANT). En enveis-trigger hindrer at en begrenset melding blir ubegrenset, også for superbruker. RLS er uendret.
  - `save(..., {restricted})` er bakoverkompatibel: uten valget er SQL og revisjon uendret.
  - `markRestricted` er idempotent og gjelder kun egen tenant og egen sesjon.
  - Revisjonen `message.restricted_marked` bærer bare melding-id, aldri innhold.
- **D-2 Når merkes.**
  - Brukermeldingen lagres umerket (rutingen er ukjent) og merkes via `markRestricted` rett etter at turen er avgjort låst, FØR modellkallet.
  - Alle assistent-, feil-, avbrudds- og budsjettstopp-svar lagres begrenset fra første stund via ÉN `saveAssistant` (strukturvakt i testene).
  - «Låst» betyr at det som faktisk sendes i første forsøk er SECRET_RESTRICTED: D-381-utvalg, tekst, minne eller en merket rad i konteksten.
  - En trygg skyvariant merkes ikke. Faller den tilbake til lokal reserve, låses turen da (`fellBackToFullView`).
- **D-3 Smitte (bokstavelig lesning av K3).**
  - En tur som er låst bare på grunn av et ARVET merke, merker også sine egne rader.
  - Målt: etter én låst tur er 6 av 6 påfølgende turer låst og merket. Kjeden brytes først av to trygge skyverktøyturer på rad.
  - Dette er strengest og følger ordlyden i K3. Det er ingen personvernrisiko, men skyverktøyturer får tynn historikk (merknad «uten N tidligere meldinger») og lokale reserver feiler heller enn å falle til sky. Se Q-1.
- **D-4 Klassifisering (K4).**
  - `messageSensitivity` i `content-sensitivity.ts` tolker eksakt `restricted === true` som SECRET_RESTRICTED uansett tekst.
  - Par-regel, hale og `protect` er uendret. Nøkkelordlistene er urørt. Signaturene er valgfrie og bakoverkompatible.
  - En merket rad som blir værende i konteksten løfter turen (årsak `history:restricted`).
  - `cloudVariantFor` har belt-og-seler-sjekk. Lokal reserve får hele historikken.
  - `wireMessages()` fjerner feltet før data krysser til en leverandør.
  - `recentTurnsBefore` (minneuttrekkets kontekst) utelater merkede rader.
- **D-5 Hurtigbane.**
  - `cost_report` og `value_report` merkes: Q-64 pkt 1 er ikke avgjort, så strengeste regel gjelder.
  - `delegate_background` merkes kun når ruteavgjørelsen er låst uten trygg skyvariant, eller ikke kan leses (`routing_unreadable`, fail-closed).
  - Øvrige intensjoner merkes ikke. Tabellen er et `Record` over alle intensjoner, så en ny intensjon kompilerer ikke før den er vurdert.
- **D-6 Flagg.**
  - Én parser (`parseRestrictedContextGuard`, eksakt `on`). Flagget står kun i `SERVICE_ENV.api`, generert compose og `.env.example`.
  - Skannetest: ingen annen kode kjenner navnet.
  - Flagg AV: `save` kalles med 3 argumenter, merker i historikken ignoreres helt, og gatewayen får ingen lås.
- **D-7 Utførelseslås.**
  - `FinanceExecutionLock.servedLocally` er koblet til leverandørregisteret (`servedByCloudModel`, som H1/H2). Låsen ligger tidlig i `ToolGateway.execute()`, før parametervalidering, policy og transport.
  - Mønsteret hentes via `isFinancialNamespace` (ÉN kilde, ikke duplisert liste).
  - Sky eller ukjent modell nektes fail-closed: manglende predikat, kast, ikke-`true` og blank leverandør gir alle nekt.
  - Uten `servingModel` (eier-ruter, `/control`) og for lokal modell er alt uendret.
  - Årsak `finance_withheld_from_cloud_model` i vanlig `tool.denied`-revisjon (aldri innhold). Modellen får en kort norsk «holdt tilbake»-merknad uten tall, id-er, tellinger eller leverandørnavn.
- **D-8 Fail-closed ved merkefeil.** Kan brukermeldingen ikke merkes, feiler turen FØR modellkallet (`restricted_marking_failed`). Prisen er tilgjengelighet ved DB-feil.
- **D-9** `localOnlyNote` (D-447) får årsaken `history:restricted`. Den vises bare til eieren og fjernes av `stripSystemNotes`.
- **D-10** Bakgrunnsjobb-levering (`ChatJobs.sweepDeliveries`) merkes ikke (DEFERRED). Gamle rader forblir `false` (backfill DEFERRED).

## 5. `messages.save`-tabellen (full versjon i runbooken)
| Sted | Merkes? |
|---|---|
| `handleScanned` brukermelding | JA når turen er låst. Merkes via `markRestricted` før modellkallet. |
| `saveAssistant` (alle 8 assistentlagringer, ÉN inngang) | JA når turen er låst. Ellers uendret 3-arg-kall. |
| Hurtigbane `cost_report`/`value_report` | JA (Q-64 pkt 1, strengeste regel) |
| Hurtigbane `delegate_background` | JA kun når ruten er låst eller uleselig. Ellers NEI. |
| Hurtigbane, øvrige intensjoner | NEI (ingen finans-/helsedata) |
| Normalt svar (med/uten verktøy) | JA når det som faktisk sendes er SECRET_RESTRICTED. Skyvariant NEI. Fallback til lokal reserve JA. |
| `BudgetExceededError`, `ClaudeBudgetBlockedError`, avbrutt, stream avbrutt | JA i en låst tur |
| Rådet: ikke konfigurert / vurdering | JA når meldingen eller handlingsutvalget er SECRET_RESTRICTED |
| `main.ts` `saveMessage` (jobb-levering) | NEI (DEFERRED/PARTIAL) |
| `MessageStore.save`/`markRestricted`, `ContextBuilder` | bærer valget / leser kun |

## 6. Tester (kjørt som `su postgres`, `--maxWorkers=2`, `timeout -k 5`)
Totalt 98 N1-tester, alle grønne også i den fulle kjøringen:
- `wpn1-messages-restricted.test.ts`: 19 (ekte Postgres).
- `wpn1-restricted-history.test.ts`: 17 (inkl. 3000 tilfeldige historikker mot en orakelkopi av main-algoritmen).
- `wpn1-finance-execution-lock.test.ts`: 13 (ekte Postgres).
  - Alle 97 produksjonsdefinisjoner for finans nektes for sky uten transportkall.
  - Fail-closed-varianter, lokal og uten-modell uendret.
  - Ekte `MeshToolExecutor`.
- `wpn1-execution-lock-coverage.test.ts`: 3. Låsen dekker nøyaktig H1s akseptert-valg-kun-lås-mønster over produksjonsmanifestet.
- `wpn1-guard-env.test.ts`: 9.
- `wpn1-flag-off-differential.test.ts`: 7 (508 sammenligninger, 0 forskjeller).
- `wpn1-engine-guard.test.ts`: 28.
  - Lekkasje AV/PÅ, også med produksjonsvelger.
  - Alle lagringssteder.
  - Feil-, avbrudds- og budsjettbaner.
  - Fallback, fail-closed og smitte målt.
  - Strukturvakter.
- `wpn1-engine-db.test.ts`: 2 (ekte Postgres/RLS, audit-rekkefølge `saved → restricted_marked → saved`).

Øvrige kjøringer:
- Regresjonsbatch 1: 65 filer / 1375 tester, grønt. Dekker hele `modules/model-gateway/test`, migrasjonsvakter (d124, d395-migrator, migration-order, remediation-2-schema-invariants), env-drift, compose-isolasjon og containment-test.
- Regresjonsbatch 2 (etter rettingen): 84 filer / 1247 tester, grønt. Alle filer som leser `main.ts`/`worker-main.ts` pluss alle N1-filer.
- På HEAD `0cbd8c69`, kjørt som `su postgres`:
  - `pnpm -r run typecheck`: exit 0
  - `pnpm lint`: exit 0
  - `pnpm check:containment`: exit 0

## 7. Mutanter
`N1_RUN_AS=postgres node apps/api/test/support/wpn1-mutants.mjs` (`--list` viser settet). Filen gjenopprettes alltid.
- **46 mutanter: 45 drept, 0 ugyldige.** Overlevende: M48 (belt-og-seler-sjekken i `cloudVariantFor`), begrunnet ekvivalent fordi `withholdSensitiveMessages` allerede tar alle merkede rader.
- M52–M54 (som berører `main.ts`/flaggoppsettet) er kjørt på nytt etter flyttingen: alle drept.
- Dekning:
  - fjern merking, merk bare assistent, merk bare bruker
  - hopp over reserve
  - snu par-regel (2 steder), glem halen, lekk gjennom `protect`
  - ignorer merket, ikke-eksakt `true`
  - flagg-AV-lekkasje, løft ikke turen
  - lekk merket til modell
  - fail-open (marking og lås)
  - lås fjernet eller svekket, over-lås
  - 8 DB-mutanter: sesjonsavgrensning, idempotens, trigger, grant, revisjon med innhold, tenant-klausul

## 8. Full suite (én kjøring, under flock)
- **Kommando:** `flock /tmp/fullsuite.lock pnpm exec vitest run --maxWorkers=2 --exclude "**/embedded-postgres-ipv4-contention*"` som `postgres`, på `28b868ce`.
- **Resultat:** 983 filer / 16753 tester. 16747 grønne, 6 røde. Varighet 3209 s.
- **Fem er de kjente sandkassefeilene:**
  - `wpc3-review1-hardening` F10a/b/c
  - `break-glass-guard`
  - `nas-ua0-gate` «friskt system»
- **Den sjette var en regresjon fra N1.** `modules/business/test/ua3-business-events-host-run-wiring.test.ts` låser at kun kommentarer står mellom `readSecretProvider` og gateway-konstruksjonen i `main.ts`, og N1 hadde satt flaggparsingen der.
- **Rettet i `0cbd8c69`.** Blokken ligger nå etter `aiCouncil`, uten atferdsendring. Første forsøk på rettingen brøt `wpf1-review-source-guards` (kommentaren nevnte `new ToolGateway(` bokstavelig), også fanget og rettet.
- **Verifisert uten ny full suite:** batch 2 (84 filer / 1247 tester) og de statiske kontrollene på HEAD er grønne.

## 9. Kjente begrensninger og åpne punkter (Q-forslag)
- **Q-1 Smitte/levetid (D-3).**
  - Alternativer: (a) behold, strengest og anbefalt til første NAS-måling; (b) ikke merk turer som kun er låst av arvet merke; (c) levetid på merket; (d) «ny samtale»-nullstilling.
  - Risiko ved (b): et svar utledet fra merket innhold kan slippe ut når merket glir ut av vinduet.
  - Mål først med loggen `n1_restricted_turn_locked` (kun årsakskoder).
- **Q-2 AI-kost (Q-64 pkt 1).** Svarer eieren «nei», sett `cost_report`/`value_report` til `false` i `FAST_INTENT_RESTRICTED`. `get_value_report`, AI-senteret og Autoritet/Integrasjoner viser fortsatt finansavledet tilstand til sky (Q-64 pkt 1/2, uendret).
- **Q-3 Backfill (DEFERRED).** Idempotent kommando for gamle rader. D-381-utvalgslåser kan ikke rekonstrueres, så kun tekstbasert backfill er mulig. Anbefaling: hopp over.
- **Q-4 Jobb-levering.** Bær opphavsturens lås i jobbkontrakten (`restricted_origin`) og merk leveringen. I dag klassifiseres den på tekst, og D-449 holder jobber med finans-/helseord lokale.
- **Q-5 Worker.** Flagget er api-only. Legg `financeExecutionLock` og flagg i workerens manifest hvis worker får en modellflate med `finance_*`.
- **Q-6 Verktøyresultater og minne.**
  - Verktøyresultater midt i en tur klassifiseres ikke (Q-52 B ikke valgt).
  - Minne er utenfor scope: meldingen skrives fortsatt til minnet og uttrekket klassifiseres på tekst (D-386).
- **Q-7 Baseline-fixtur.** Den er festet til main `ec3e684e` som innhold, ikke som levende referanse. En legitim senere flagg-AV-endring av motoren gjør differensialtesten rød til fixturen regenereres bevisst (fremgangsmåte i testens hode).
- **Q-8 Stempling av `servingModel`.** Den stemples i dag kun i `mesh-bridge.ts` (videreført i `chat-jobs.ts`). En fremtidig modellsti som glemmer å stemple, omgår låsen.

## 10. NOT VERIFIED
- Migrasjon 140 og kolonne/trigger/grant på NAS-databasen.
- Oppførsel med ekte Ollama/Anthropic (leverandørstemplet `provider` som lokalitetskilde).
- At ekte finans-/helseturer (Neonomics, helse-rom) låses og merkes slik testene antar.
- At eierens HTTP-ruter og `/control` fortsatt får finansdata med lås på. Testet mot gatewayen, ikke mot de ekte rutene.
- Runbook-steg 1–8 (NAS-prøveløpet, med «hvordan går det med kontoen min?» som nøytral frase) er IKKE kjørt.
- Flagg PÅ i en full api-oppstart via compose er IKKE kjørt (kun enhets-/integrasjonstester og kildevakter).
- Effekten av smitten på daglig bruk.

## 11. Motstrid og uklarheter (ikke valgt stille)
1. **K6 mot seg selv.** Ordren sier både «manglende `servingModel` regnes som sky» og «eierens HTTP-ruter og `/control` uten modell er uendret». De kan ikke begge gjelde. Jeg valgte at fravær av `servingModel` er uendret; fail-closed gjelder resten (se D-7). Lead bør bekrefte, jf. Q-8.
2. **K3 mot Q-66-intensjonen.** K3 sier ikke noe om arvet lås; den bokstavelige lesningen gir smitte (D-3).
3. **H1-invarianten er utdatert med flagg PÅ.** `wph1-restricted-tools-invariant` lister `finance_*` som «akseptert valg-kun-lås». Det stemmer for flagg AV, men ikke med flagg PÅ. Den nye dekningstesten låser likheten.
4. **Kildetekst-vakter i `main.ts`.** Flere wiring-tester låser kildetekst i `main.ts` (ua3: ingen setninger mellom `readSecretProvider` og gateway-konstruksjonen; wpf1: `indexOf("new ToolGateway(")`). WP-er som endrer `main.ts` må kjøre ALLE testfiler som leser `main.ts`, ikke bare `apps/api`. Jeg gjorde ikke det før fullsuiten.

## 12. Forslag til delte docs (lead samler)
- **JARVIS-101 / Q-66 A / Q-64 pkt 3:** bygget WIRED, DORMANT, NOT VERIFIED.
- **Flagg PÅ:** aktiveres først etter runbook-steg 1–8, og sammen med eller før `JARVIS_CONTROL_CENTER_FINANCE` og `_VALUE`.
- **D-forslag:** D-1 til D-10 over.
- **Q-forslag:** Q-1 til Q-8 over.
