# WP-N1: «begrenset»-merking av samtalehistorikken + utførelseslås for finansverktøy (JARVIS-101 / Q-66 / Q-64 pkt 3) - slik bruker og verifiserer du det

**Formål:** et LOKALT svar fra en tur som er låst til `SECRET_RESTRICTED` (helse/finans, D-378) skal aldri kunne følge med samtalehistorikken til en senere tur som går til en SKYmodell. Før N1 klassifiserte
`conversation.ts` historikken kun etter TEKST: et svar uten stikkord (leverandørnavn, nødbryter-tilstand, AI-kost, en saldo i omskrevet form) fra en tur som var låst av verktøyutvalget (D-381), Finans-/Verdi-senteret eller
minnet, lå som en vanlig rad og ble sendt videre. N1 lagrer et **«begrenset»-merke** på meldinger fra låste turer (`messages.restricted`), lar klassifiseringen lese det, og gir `finance`/`finance_*` en **utførelseslås** mot skymodeller
(Q-64 pkt 3: de hadde kun en utvalgslås).

**Status (ærlige ord - ingenting er VERIFIED før du har kjørt NAS-stegene under):**
- Alt er **WIRED bak ÉTT flagg og DORMANT som standard** (`JARVIS_RESTRICTED_CONTEXT_GUARD`, AV). Flagg AV er identisk med main (bevist av en differensialtest mot en ren `origin/main`, se Bevis).
- Testet mot embedded Postgres som app-rollen (RLS) og mot falske modeller; **NOT VERIFIED** mot NAS, ekte Ollama/Anthropic og ekte data.
- **PARTIAL / DEFERRED** (egne punkter under «Kjente begrensninger»): gamle rader forblir umerket (backfill DEFERRED), bakgrunnsjobb-leveringen merkes ikke, merket **smitter** (se målingen), verktøyresultater midt i en tur klassifiseres ikke.

## Hva er bygget
| # | Del | Hvor |
|---|---|---|
| K1 | Migrasjon 140: `messages.restricted boolean NOT NULL DEFAULT false`; app-rollen får `UPDATE` KUN på denne kolonnen (kolonne-nivå), en trigger gjør merket enveis (en begrenset melding kan aldri gjøres ubegrenset); RLS uendret | `modules/core/src/db/migrations/140_messages_restricted.sql` |
| K2 | `MessageStore.save(identity, role, content, opts?: { restricted })` (uten valget: samme SQL og revisjon som før), `markRestricted(identity, messageId)` (idempotent, kun egen tenant og egen sesjon, revisjon uten innhold), `history()` returnerer `restricted` | `modules/core/src/services/message-store.ts` |
| K3 | Motoren merker låste turer: brukermeldingen via `markRestricted` FØR modellkallet, og ALLE assistentlagringer for turen via én `saveAssistant` | `apps/api/src/conversation.ts`, `restricted-context-guard.ts` (`RestrictedTurnMarker`) |
| K4 | Klassifiseringen leser merket: `partitionHistoryBySensitivity`/`withholdSensitiveMessages` behandler `restricted === true` som `SECRET_RESTRICTED` uansett tekst; en merket rad som blir værende i konteksten løfter turen (lokal modell); skyvarianten (Q-51 D) holder dem utenfor; den lokale reserveruten får hele historikken | `modules/model-gateway/src/content-sensitivity.ts`, `conversation.ts` (`resolveTurnRouting`, `cloudVariantFor`) |
| K5 | Flagget (kun eksakt `on`), én parser, kun `SERVICE_ENV.api` + generert compose + `.env.example` | `restricted-context-guard.ts`, `infra/local/service-env.mjs`, `wpn1-guard-env.test.ts` |
| K6 | Utførelseslås for `finance`/`finance_*` mot skymodell/ukjent modell i `ToolGateway.execute()` | `modules/tool-gateway/src/gateway.ts` (`financeExecutionLock`), `tool-manifest.ts` (`isFinancialNamespace`), `tool-failure.ts` |

## Flagg og aktiveringsrekkefølge
| Flagg | Slår på | Gjelder |
|---|---|---|
| `JARVIS_RESTRICTED_CONTEXT_GUARD=on` | (1) merking av låste turer, (2) klassifiseringen leser merket, (3) utførelseslåsen for `finance`/`finance_*`, (4) minneuttrekket får ikke merkede rader som kontekst | api-prosessen (worker/voice/browser/migrate leser det aldri) |

Kun den eksakte verdien `on` slår det på (`true`/`1`/`ON` gir AV). Settes i `.env` og krever restart av api: `docker compose -f infra/local/docker-compose.yml up -d api`. Det når containeren fordi det står i `SERVICE_ENV.api`
(`wpn1-guard-env.test.ts` låser det, inkl. at ingen annen kode leser navnet). Ved oppstart logges `{"msg":"restricted_context_guard","enabled":true|false}`.

**Rekkefølge (Q-66 alternativ A):**
1. Kjør NAS-verifiseringen under (steg 1-4) med flagget AV: migrasjon 140 anvendt, kolonne og rettigheter riktige.
2. Slå på `JARVIS_RESTRICTED_CONTEXT_GUARD=on` og kjør steg 5-7 (prøveløpet).
3. FØRST DERETTER (eller i samme restart, aldri før/uten) `JARVIS_CONTROL_CENTER_FINANCE=on` og `JARVIS_CONTROL_CENTER_VALUE=on` (WP-H1/H2: de ventet på N1).
4. Ikke slå på noe av dette på en maskin der en lavtillits-enhet er innrullert, se Q-71 (JARVIS-111) - uavhengig av N1.

## `messages.save`-tabellen (K3): ALLE steder som lagrer en melding
Funnet med `grep` etter `.save(identity`, `messages.save`, `saveMessage`, `MessageStore(` og `INSERT INTO messages` over `apps`, `modules`, `packages`, `infra`, `ops` (produksjonskode og skript; testene setter inn rader direkte). Strukturvakter i `wpn1-engine-guard.test.ts`
feiler hvis et nytt sted dukker opp eller et `saveAssistant`-kall ikke gir markøren videre.

| Sted | Hva | Merkes? | Begrunnelse |
|---|---|---|---|
| `conversation.ts` `handleScanned`: `messages.save(identity, "user", text)` | brukermeldingen | **JA** (når turen er låst) - lagres umerket (rutingen er ukjent), merkes med `markRestricted` så snart turen er avgjort låst, FØR modellkallet | brukermeldingen kan gjengi det følsomme uten stikkord; merkes på nytt (idempotent) hvis en skyvariant faller tilbake til den strenge lokale visningen |
| `saveAssistant` (alle assistentlagringer i motoren; to grener) | svar | **JA** når turen er låst, ellers uendret (tre argumenter) | én eneste inngang, så ingen sti kan glemme merket |
| ↳ hurtigbane-svar (`handleFastIntent`) | status, selvdiagnose, SLO, evolusjon, jobbstyring, hjelp, lys | **NEI** (ingen finans-/helsedata i svaret) | verifisert: ingen `finance`-referanse i selvdiagnose/SLO/evolusjon; tabellen `FAST_INTENT_RESTRICTED` er uttømmende (`Record` over alle intensjoner) |
| ↳ hurtigbane: `cost_report`, `value_report` | AI-kost i øre | **JA** | Q-64 pkt 1 er ikke avgjort: STRENGESTE regel (AI-kost er finans) gjelder. Svarer du «nei» (driftsdata), sett begge til `false` i `FAST_INTENT_RESTRICTED` |
| ↳ hurtigbane: `delegate_background` («… i bakgrunnen») | startmelding for jobb | **JA** når ruteavgjørelsen er låst til `SECRET_RESTRICTED` uten trygg skyvariant (eller kan ikke leses: `routing_unreadable`, fail-closed); **NEI** ellers (også når eieren selv ba om lokal modell) | samme beregning som chatten (`delegationCloudDecision`) |
| ↳ normalt svar, også med verktøy | modellsvar + rutemerknader | **JA** når det som faktisk sendes i første forsøk er `SECRET_RESTRICTED` (verktøyutvalg-lås D-381, tekst, minne `health`/`special`, dagstak med følsom historikk, merket rad i konteksten); **NEI** for en trygg skyvariant; **JA** hvis skyvarianten feiler og den lokale reserven svarer med hele historikken | merket følger det som FAKTISK ble sendt, ikke det som ble forsøkt |
| ↳ `BudgetExceededError` («Modellkall stoppet av budsjettvakten») | feilsvar | **JA** i en låst tur, ellers NEI | alle meldinger for turen, også feilsvar (fail-closed) |
| ↳ `ClaudeBudgetBlockedError` (WP-B4) | feilsvar | **JA** i en låst tur, ellers NEI | som over |
| ↳ avbrutt av bruker / strøm avbrutt | delvis tekst + markør | **JA** i en låst tur, ellers NEI | delvis tekst fra en lokal modell kan gjengi det følsomme |
| ↳ `runCouncil`: «AI-rådet er ikke konfigurert» | fast tekst | **JA** hvis meldingen alene er `SECRET_RESTRICTED`, ellers NEI | rådet kjørte ikke, men meldingen kan gjelde et begrenset emne |
| ↳ `runCouncil`: vurderingen | rådets svar (+ forslag) | **JA** når rådets sensitivitet er `SECRET_RESTRICTED` (melding eller handlingsutvalgets finanslås), ellers NEI | rådet får aldri samtalehistorikken, så en merket historikk alene låser ikke rådet |
| `main.ts` `saveMessage` → `ChatJobs.sweepDeliveries` | bakgrunnsjobbens leveringsmelding (asynkront, i opprinnelig økt) | **NEI (DEFERRED/PARTIAL)** | ikke en del av turen og uten tilgang til opphavsturens sensitivitet; bakgrunnsflaten har ingen `finance_*`-verktøy, og en jobb med finans-/helseord holdes lokal (D-449) og klassifiseres på tekst som før. Å merke ALLE lokale jobbleveringer ville låst de fleste samtaler lokalt. Oppfølger: bær opphavsturens lås i kontrakten (`restricted_origin`) og merk leveringen (Q-forslag i rapporten) |
| `MessageStore.save` / `markRestricted` | selve lagringen | bærer valget | se K2 |
| `ContextBuilder.build`, `MessageStore.history` | KUN lesing | - | leser `restricted` |

**Hvem leser historikken (alle tre håndterer merket):** `ConversationEngine.handleScanned` → `resolveTurnRouting` (klassifisering, løft, skyvariant), `delegationCloudDecision` (samme beregning for bakgrunnsjobber), og `recentTurnsBefore`
(siste turer som DATA til minneuttrekket, D-386: merkede rader utelates med vakten på). `memory/src/export.ts` (eierens egen eksport) og `value-source.ts` (kun telling) berøres ikke.

## Hva «låst tur» betyr, og hva som merkes
En tur er låst når det som FAKTISK sendes i første forsøk har sensitivitet `SECRET_RESTRICTED`: `tool_selection:SECRET_RESTRICTED` (D-381), `text:finance`/`text:health`/`text:secret`, `memory_space:health`, `memory_sensitivity:special`, eller
`history:restricted` (en merket rad ble værende i de nylige radene). Reglene for partisjonering (D-384/Q-51 D) er uendret: eldre merkede rader (utenfor de fire siste) holdes utenfor sammen med paret, de nylige beholdes og låser turen lokalt,
og skyvarianten tar bort merkede rader, parene deres og HELE halen fra den første følsomme/merkede raden i det nylige vinduet. Ved lås logges `{"msg":"n1_restricted_turn_locked","reasons":[...]}` (kun faste årsakskoder, aldri innhold).

## Utførelseslåsen for `finance`/`finance_*` (K6)
Med flagget på nekter `ToolGateway.execute()` ethvert kall til `finance`/`finance_*` (mønsteret `FINANCIAL_NAMESPACES` i `tool-manifest.ts`, via `isFinancialNamespace`) når `servingModel` (stemplet av adapteren, aldri fra parametere) er en **skymodell eller en ukjent modell**.
Det skjer TIDLIG (før parametervalidering, policy og transport: ingenting hentes eller utføres) og gir en vanlig `tool.denied`-revisjonsrad med årsaken `finance_withheld_from_cloud_model` (aldri innhold, aldri parametre). Modellen får en kort norsk
«holdt tilbake»-merknad uten sifre, tellinger, id-er eller leverandørnavn (`tool-failure.ts`). **Fail-closed:** ingen `servedLocally`, et kast, en verdi som ikke er eksakt `true`, og en `servingModel` uten gyldig leverandørnavn regnes som sky.
**Uendret:** uten `servingModel` (eierens HTTP-ruter, `/control`, eier-godkjent bekreftelse) og for en LOKAL modell (D-378 pkt 2: får hele resultatet). Lokalitet kommer fra leverandørregisteret (`servedByCloudModel`, samme som chattens verktøyskjerm og Finans-senteret).
H1-invarianten (`wph1-restricted-tools-invariant.test.ts`) lister `finance_*` som «akseptert valg-kun-lås»: det er flagg-AV-tilstanden (main). `wpn1-execution-lock-coverage.test.ts` låser at låsen dekker nøyaktig de samme verktøyene.

## NAS-verifisering (kjør i rekkefølge; flagg AV til steg 5)
1. **Migrasjon 140 anvendt** (kjøres av `migrate`-tjenesten ved `docker compose up -d`; additiv):
   `docker compose -f infra/local/docker-compose.yml exec -T postgres psql -U postgres -d jarvis -c "SELECT name, applied_at FROM schema_migrations WHERE name = '140_messages_restricted.sql';"` → forvent én rad.
2. **Kolonne og standard:** `... -c "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'restricted';"` → `boolean | NO | false`.
3. **Rettigheter og enveis-trigger:** `... -c "SELECT has_column_privilege('jarvis_app','messages','restricted','UPDATE') AS kan_merke, has_column_privilege('jarvis_app','messages','content','UPDATE') AS kan_endre_innhold, (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'messages'::regclass AND tgname = 'messages_restricted_monotonic') AS trigger;"` → `t | f | 1`.
4. **Alle eksisterende rader er umerket:** `... -c "SELECT restricted, count(*) FROM messages GROUP BY 1;"` → kun `f`. Flagget er AV: sjekk `docker compose -f infra/local/docker-compose.yml logs api | grep restricted_context_guard` → `"enabled":false`.
5. **Slå på og restart:** `JARVIS_RESTRICTED_CONTEXT_GUARD=on` i `.env`, `docker compose -f infra/local/docker-compose.yml up -d api`. Kontroller `docker compose -f infra/local/docker-compose.yml exec api printenv JARVIS_RESTRICTED_CONTEXT_GUARD` → `on`, og loggen `"enabled":true`.
6. **Prøveløp (web-chat fra en signert enhet, ny melding for hvert):** (a) «hvordan går det med kontoen min?» (velger finansverktøy → låst lokalt; teksten har ingen stikkord). Forvent i loggen `n1_restricted_turn_locked` med `tool_selection:SECRET_RESTRICTED`, og i databasen at de to siste radene er merket:
   `... -c "SELECT role, restricted, left(content, 40) FROM messages ORDER BY created_at DESC LIMIT 2;"` → begge `t`. (b) Deretter «list åpne PR-er på tsworkflow/jarvisbuild»: forvent svar fra skymodellen med merknaden «Svart på skymodellen uten 2 tidligere meldinger» og at de to nye radene er `f`.
   (c) Revisjon: `... -c "SELECT type, count(*) FROM audit_events WHERE type IN ('message.restricted_marked') GROUP BY 1;"` (én per merket brukermelding; nyttelasten har kun melding-id-en).
7. **Utførelseslåsen (valgfritt, krever at en skymodell kaller verktøyet):** be en skytur om «kall finance_neonomics__list_bank_accounts direkte». Forvent at modellen får «holdt tilbake»-merknaden og at
   `... -c "SELECT count(*) FROM audit_events WHERE type = 'tool.denied' AND reason = 'finance_withheld_from_cloud_model';"` øker. En lokal tur (D-378) skal fortsatt få resultatet.
8. **Først nå** `JARVIS_CONTROL_CENTER_FINANCE=on` / `_VALUE=on` (runbook WPH1/WPH2).

**Rollback:** sett flagget til `off` (eller fjern det) og `docker compose -f infra/local/docker-compose.yml up -d api`. Kolonnen og alle merker blir stående (migrasjoner er forover-kun), men ignoreres helt: motoren leser dem ikke, `messages.save` kalles med tre argumenter, og utførelseslåsen er borte.
Eksisterende merker blir liggende og er gyldige hvis du slår flagget på igjen.

## Kjente begrensninger og åpne punkter (ærlig)
1. **Smitte (målt, `wpn1-engine-guard.test.ts` E):** en tur som er låst - også kun fordi en merket/følsom rad ligger i de fire siste - merker sine egne rader, som holder neste tur låst. Etter ÉN låst tur forblir ren prat låst og merket (målt: 6 av 6 turer). Kjeden brytes først når to
   verktøyturer på rad går via den trygge skyvarianten (de merkes ikke). Ren prat prøver først `gemma_local` (den gratis hostede Gemma er kun for ikke-private samtaler), og en låst tur holdes uansett på lokale modeller (D-378), så effekten er: skyverktøyturer får en tynn historikk med merknaden «uten N tidligere meldinger», og lokale reserver feiler heller enn å falle til sky.
   Siden en sesjon er personens kontinuerlige samtale på tvers av kanaler (`SessionService`), finnes ingen «ny samtale»-knapp som nullstiller. Alternativ (ikke bygget): utløp/levetid på merket, eller ikke merke turer som kun er låst av et ARVET merke - men da kan et svar på en oppfølging (utledet fra merket innhold) slippe til skyen
   når merket har gled ut av vinduet. Det er en avveining for deg (Q-forslag i rapporten).
2. **Gamle rader er umerket** (kolonnen er `false` for alt fra før migrasjonen). Idempotent backfill-kommando er **DEFERRED**; tekstklassifiseringen gjelder for dem som før.
3. **Bakgrunnsjobb-leveringen merkes ikke** (tabellen over, **DEFERRED**).
4. **Verktøyresultater midt i en tur klassifiseres ikke** (Q-52 B er ikke valgt): en lokal tur som leser `memory.search`-treff fra helse-rommet merkes etter turens RUTING (minneblokken og tekst), ikke etter hva et senere verktøykall hentet.
5. **Minne er utenfor scope:** den NÅVÆRENDE meldingen skrives fortsatt til minnet og uttrekket klassifiseres på tekst (D-386/Q-52); N1 utelater kun merkede RADER fra uttrekkets kontekst.
6. **AI-kost:** `get_value_report`, AI-senteret og Autoritet/Integrasjoner viser fortsatt finansavledet tilstand til skymodeller (Q-64 pkt 1/2, uendret fra H1/H2); N1 merker bare hurtigbane-svarene `cost_report`/`value_report`.
7. **Utførelseslåsen ligger kun i api-prosessen** (flagget er api-only). Workeren har ingen modellflate med finansverktøy (bakgrunnsflaten er lese-minimum uten `finance_*`), så det er dybdeforsvar, ikke et hull; legg flagget i workerens manifest hvis det endres.
8. **Fail-closed koster tilgjengelighet:** kan brukermeldingen ikke merkes (databasefeil, rad ikke funnet i egen tenant/sesjon), feiler turen FØR modellen kalles og ingen assistentrad lagres (`restricted_marking_failed` / databasefeilen).
9. **`localOnlyNote` (D-447)** har en ny årsak (`history:restricted`: «de siste meldingene hørte til en tur som ble holdt lokalt»); den fjernes som alle rutemerknader fra historikken før klassifisering (`stripSystemNotes`) og har ingen ord klassifisereren reagerer på.

## Bevis (kommandoer og tall; `su postgres` for DB-tester, maks 2 vitest-arbeidere)
```
pnpm exec vitest run --maxWorkers=2 modules/core/test/wpn1-messages-restricted.test.ts modules/model-gateway/test/wpn1-restricted-history.test.ts modules/tool-gateway/test/wpn1-finance-execution-lock.test.ts apps/api/test/wpn1-*.test.ts
```
- `wpn1-messages-restricted.test.ts` (19, ekte Postgres): kolonne/standard, RLS uendret, kolonne-nivå UPDATE, enveis-trigger (også for superbruker), erasure-DELETE uendret, `save`/`markRestricted` (idempotent også samtidig, egen sesjon, egen tenant også uten RLS), revisjon uten innhold, `history`.
- `wpn1-restricted-history.test.ts` (17): partisjonsfunksjonene, par/hale/`protect`, kun eksakt `true`, og differensial mot en orakelkopi av `origin/main`-algoritmen over 3000 tilfeldige historikker.
- `wpn1-finance-execution-lock.test.ts` (13, ekte Postgres og alle 97 produksjonsdefinisjoner for finans) + `wpn1-execution-lock-coverage.test.ts` (3).
- `wpn1-flag-off-differential.test.ts` (7): **127 scenarier x web/tale x to AV-varianter = 508 sammenligninger mot en baseline generert fra ren `origin/main` (ec3e684e): 0 forskjeller.** Kontrolltest: med flagget PÅ avviker minst 90 av 254 (oppdager forskjell).
  Baseline regenereres kun bevisst (fremgangsmåten står i testens hode; scenariosettet i `apps/api/test/support/n1-scenarios.ts` er kilden).
- `wpn1-engine-guard.test.ts` (28) og `wpn1-engine-db.test.ts` (2, ekte Postgres): lekkasjen JARVIS-101 reprodusert (flagg AV) og rettet (flagg PÅ) - også med PRODUKSJONENS verktøyutvalg (`selectSurfaceTools`) for fire nøytrale finansfraser uten stikkord -, alle lagringssteder, feil-/avbrudds-/budsjettbaner, tilbakefall, fail-closed, smitten målt, strukturvakter.
- **Mutanter:** `N1_RUN_AS=postgres node apps/api/test/support/wpn1-mutants.mjs` (46 mutanter; `--list` skriver settet). 45 drepte; den ene overlevende (M48, belt-og-seler-sjekken i `cloudVariantFor`) er ekvivalent (se filen).
- **Hele suiten** (én kjøring, `pnpm exec vitest run --maxWorkers=2 --exclude "**/embedded-postgres-ipv4-contention*"` under `flock /tmp/fullsuite.lock`, som OS-bruker `postgres`, på `28b868ce`): 983 filer, 16753 tester, 16747 grønne, 6 røde. Fem er de kjente sandkassefeilene (`wpc3-review1-hardening` F10a/b/c, `break-glass-guard`, `nas-ua0-gate` «friskt system»);
  den sjette var en REGRESJON fra N1 (`ua3-business-events-host-run-wiring.test.ts` låser at kun kommentarer står mellom `readSecretProvider` og gateway-konstruksjonen i `main.ts`), rettet i `0cbd8c69` og verifisert med en målrettet kjøring av alle 84 testfiler som leser `main.ts`/`worker-main.ts` + alle N1-tester (1247 tester, alle grønne). Alle 98 N1-tester var grønne i den fulle kjøringen.
- `pnpm -r run typecheck`, `pnpm lint` og `pnpm check:containment`: exit 0 på `0cbd8c69`.

## NOT VERIFIED (må gjøres på NAS)
Migrasjon 140 og kolonne-/trigger-/grant-tilstanden på NAS-databasen; at en ekte lokal modell (Ollama) og Anthropic faktisk oppfører seg som de falske i testene (leverandørstemplet `provider` som lokalitetskilde); at en ekte finans-/helsetur (Neonomics, helse-rom) låses og merkes slik
prøveløpet forventer; at eierens egne HTTP-ruter og `/control` fortsatt får finansdata med låsen på (testet mot gatewayen, ikke mot de ekte rutene); effekten av smitten på daglig bruk.
