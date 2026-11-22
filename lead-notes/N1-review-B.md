TS: 2026-11-22T11:16:22.257Z
VERDICT: MERGE ETTER FIKSER. Jeg fant 1 HIGH (utførelseslåsen omgås via nøstede `executive`-kall) og 1 MEDIUM (produksjonsoppkoblingen av låsen er uten test). I tillegg 4 LOW og 6 INFO. K1, K2 og K5-env er bekreftet uten funn.

Alt er kjørt på 96999794 i `n1-rev-b` som `su postgres` med `--maxWorkers=2`. Kilden er urørt: `git status --short` er tom og HEAD er uendret. Probemappe: `/tmp/lead/N1-review-B-probes/`.

## Funn (rangert; fil:linje mot 96999794)

**HIGH-1: K6-låsen omgås av nøstede kall.**
- `ExecutiveService.getControlSurfaceStatus` (`modules/executive/src/service.ts:414-418`) og `getDelegationBoard` (`:430-434`) henter `finance.get_kill_switch` via `requireData` uten `servingModel`. `gateway.ts:795` leser bare `request.servingModel`.
- Begge verktøyene står på web_chat (`chat-read-tier.ts:83-84`). `transport.ts:104-111` returnerer resultatet uten `isCloudServed`-sjekk.
- Med låsen PÅ og ekte `servedByCloudModel` får en anthropic-tur `data.finance_kill_switch {enabled, enabled_by_person_id, enabled_at, disabled_at, reason (fritekst), updated_at}`. Det gjelder både via ToolGateway og via ekte `MeshToolExecutor`.
- Direkte `finance.get_kill_switch` fra samme modell nektes. Transporten så det nøstede kallet med `servingModel=null`.
- JARVIS-101 nevner «nødbryter-tilstand» eksplisitt, og H2/M2 (`restrictFinance`, `security.ts:93`) holder samme tilstand tilbake fra sky i kontrollsentrene. `owner_control`-delen av svaret (frosne connectorer med fritekstbegrunnelse) kan i tillegg nevne finansleverandører. Fiksen dekker ikke den delen.
- Repro: `zz-n1-review-b-lock.test.ts` LK5. Begge testene er grønne, og det betyr at lekkasjen finnes.
- Fiks: `fix-high1/fix-high1.patch`, 21 endrede linjer i 3 filer.
  - Servicemetodene tar `{ withholdFinance }` og hopper over det nøstede finance-kallet.
  - Transporten sender `withholdsFinanceFromCloud(context?.servingModel)`, som er `withholdFinanceFromCloud && isCloudServed`.
  - `main.ts` setter `withholdFinanceFromCloud: restrictedContextGuard.enabled`. Flagg AV gir identisk oppførsel.
- Målt med patchen påført:
  - LK5-fiks (2 tester): sky får ingen `reason` og ingen nøstet finance-kall; lokal og eier-rute får fullt svar.
  - N1-testene 60/60 grønne.
  - `tsc` for `executive` og `api` gir exit 0.
  - 595 av 596 tester grønne. Den ene røde var min egen patch-kommentar som nevnte flaggnavnet; guard-env-vakten fanget den, og patchen er rettet.
- Anbefalt i tillegg:
  - En generell invariant-test: alle web_chat-tildelte verktøy kalt som sky med låsen PÅ skal aldri kalle en `finance*`-transport. Den ville ha fanget dette.
  - Vurder å bære `servingModel` gjennom nøstede kall (AsyncLocalStorage, som `call-signal.ts`).

**MEDIUM-1: lokalitetspredikatet i `main.ts:451` er ikke testet.**
- Byggerens lås-tester bruker en egen test-lokal predikat (`LOCAL = {gemma_local, ollama, local_llm}`). Produksjonens `!servedByCloudModel(...)` kjøres aldri i en N1-test.
- Mutant R41 (predikat snudd) og R42 (alltid lokal) overlever alle 7 N1-testfilene. R42 gjør låsen inert. Tekstvaktene i `wpn1-guard-env` pinner bare `{ servedLocally: `.
- Fiks:
  - Flytt predikatet til `restricted-context-guard.ts` som `FINANCE_EXECUTION_LOCK`.
  - Test det mot ekte register: gemma_local/ollama/local_llm gir true; anthropic/openai/gemma_hosted/hermes/kimi/tom/ukjent gir false.
  - Oppdater regex-pinnen i guard-env.

**LOW**
- **L1:** R27 overlever. `delegationCloudDecision`-catch (`routing_unreadable`) merkes ikke i noen test, selv om runbooken lover fail-closed.
- **L2:** R31 og R32 overlever. Lås-unntak for `jobContract` og `approval` fanges ikke. R35 overlever også: reason-literalen `finance_withheld_from_cloud_model` er ikke pinnet, men NAS-SQL i runbooken (steg 7) peker på den.
- **L3:** R08 overlever. `GRANT UPDATE (restricted) ... TO PUBLIC` fanges ikke. Byggerens A-test sjekker bare `jarvis_app`. Min probe sjekker alle grantees.
- **L4:**
  - Merket kan ikke fjernes uten superbruker-DDL (`ALTER TABLE messages DISABLE TRIGGER messages_restricted_monotonic`). Det finnes ingen runbook-nullstilling mot «smitten».
  - App-rollen kan også fjerne et merke med DELETE og ny INSERT (018-grant, kun egen tenant). Enveis gjelder bare UPDATE. Begge deler bør stå i runbooken.

**INFO**
- **I1:** `history()` (`message-store.ts:78`) leser `restricted` uavhengig av flagget. «Flagg AV == main» forutsetter derfor migrasjon 140. Compose har `api depends_on migrate: service_completed_successfully`, så rekkefølgen er sikret.
- **I2:** `save({restricted:"true"})` eller `1` gir ubegrenset rad (fail-open for JS-kallere uten TS-typer).
- **I3:** Eksistens-orakel for en skymodell: `finance_stripe.get_balance` gir `finance_withheld…`, mens ukjent handling og ukjent navnerom gir `unknown_tool`. Ingen innhold lekker. Tidsprofil: median 1,4 ms mot 1,5 ms for gyldige mot ugyldige parametre.
- **I4:** Act-nivå-finans fra en skymodell stopper på bekreftelsesporten før låsen (`mesh-bridge.ts:512-535`). Probe: `CONFIRMATION_REQUIRED`, ingen transport, kort opprettes. Godkjente kort utføres uten `servingModel` (`server.ts:1454`), og modellen ser aldri resultatet. Låsen rammer i praksis bare lese-nivået (25 handlinger).
- **I5:** Afledet finansmetadata utenfor `finance*`-låsen er ikke undersøkt. Eksempler: `get_capability_status` og `connector_health` navngir finanskoblinger, og `business.get_business_brief` har en finans-seksjon. Innholdet er IKKE verifisert.
- **I6:** Workeren har ingen lås (flagget er api-only; dokumentert). Bakgrunnsflaten har ingen `finance*` (`tool-manifest.ts:272+`), så dybdeforsvar er svakere, men ikke et hull.

## K6-motstriden og stempling

Behold «fravær av `servingModel` = uendret». Det er nødvendig for `/confirmations`, `/finance/actions` og `/control`, og kode-lesing viser at de kaller uten `servingModel`. H1 viser likevel at «fravær» også oppstår i nøstede kall under en skytur.

| Sti | Stempler? | Bevis |
|---|---|---|
| Vanlig tur via `MeshToolExecutor` | JA, alltid (`mesh-bridge.ts:549`); forfalsket `arguments` påvirker ikke | LK6 |
| Eneste modell-executor | `trackedExecutor` og `cloudScreenedExecutor` er kun wrappers | grep |
| Nøstede kall (`executive` → `finance`) | NEI | LK5, HIGH-1 |
| Rask bane, `/confirmations`, `/finance/actions`, situations-plan | NEI, ingen modell i løkka | kode-lesing |
| Worker og chat-jobs | stempler via `MeshToolExecutor`; bakgrunnsflate uten `finance*` | kode-lesing |

Alt i tabellen unntatt LK5/LK6 er kode-lesing og grep, ikke probe.

## Byggerens påstander -> dom

| Påstand | Dom | Bevis |
|---|---|---|
| K1 `boolean NOT NULL DEFAULT false`, ingen omskriving, gamle rader false | BEKREFTET | 20 000 rader fra 139 til 140: `relfilenode` 22950 før og etter, `attmissingval={f}`, alle rader false, andre kjøring `[]`. PG 16.14 (prod: `pgvector:pg16`). |
| K1 RLS, FORCE og policy uendret | BEKREFTET | `pg_class` og `pg_policies`; R10 drept |
| K1 kolonne-GRANT kun `restricted` | BEKREFTET | 6 kolonner alene og sammen med `restricted`, `ON CONFLICT DO UPDATE`: alle permission denied. `GRANT` fra app-rollen gir ingenting. |
| K1 enveis-trigger | BEKREFTET | true til false blokkert også via uttrykk, CASE, upsert og multirad. Trigger, funksjon og RLS kan ikke slås av eller erstattes, og `session_replication_role` kan ikke settes (13 forsøk). |
| K1 migrasjonsvakter og urørte eldre migrasjoner | BEKREFTET | d124, d395-migrator, migration-order, q21, remediation-2, d420: 6 filer, 189 tester. `git diff 7de8924f` viser kun ny `140`. |
| K1 sletting, erasure, retensjon, UPDATE-fixtures | BEKREFTET | erasure-service, d395-erasure-coverage, retention og `wpc4-value-source-db` (UPDATE `created_at`) er grønne. FK uten cascade. |
| K2 `save()` bakoverkompatibel | BEKREFTET | Uten-valg-grenen er uendret i diffen og gir `{role}` i revisjonen. |
| K2 `markRestricted`: idempotent, egen tenant og sesjon, ikke orakel | BEKREFTET | 10 inputvarianter (ukjent, annen tenant eller sesjon, tom, SQL-lignende, 1 MB, unicode, null, undefined, tall) gir false uten revisjon. 30 parallelle kall gir én revisjonsrad. NUL-byte kaster i driveren. |
| K2 revisjon uten innhold, rekkefølge | BEKREFTET | `message.saved`, `message.restricted_marked`, `message.saved` med kun `{role}`, `{message_id}`, `{role, restricted:true}`. Riktig tenant, sesjon og person. |
| K2 `history()` | BEKREFTET | Samme id-rekkefølge som main-SQL for limit 1, 3, 7 og 20; alltid boolean. |
| K5-env flagg kun i `SERVICE_ENV.api` | BEKREFTET | api har det; worker, migrate, voice og browser har det ikke. |
| K5-env compose uten drift | BEKREFTET | `rewriteCompose(file) === file`; én linje, i api-blokken (`docker-compose.yml:490`). |
| K5-env kun eksakt `on`, én parser | BEKREFTET | `git grep`: navnet står kun i parser, manifest, compose, `.env.example` og en SQL-kommentar. Parser-mutantene R20-R22 drept. |
| K5-env wiring- og kildetekstvakter etter `0cbd8c69` | BEKREFTET | 112 filer, 1737 tester grønne på 96999794 (257 s). |
| Flagg AV == main | BEKREFTET | Se under. |
| K6 fail-closed | BEKREFTET | 20 `servingModel`-varianter mot ekte register. Kun `undefined`, gemma_local, ollama og local_llm slipper gjennom; anthropic, openai, gemma_hosted, hermes og kimi nektes, og alle ugyldige former nektes. |
| K6 nekt før sideeffekter | BEKREFTET | Ingen `policy.authorize`, `secrets.get`, transport eller `tool_executions`. Én `tool.denied`-rad med `payload {}`. Samme idempotensnøkkel fra en lokal kjøring gir nektelse. Mutant R29 (lås etter policy) drept. |
| K6 `isFinancialNamespace` eneste kilde og 97 definisjoner | BEKREFTET | `integrations.ts` har 97 `finance*`-definisjoner, alle dekket. Ingen `restricted`/`financial` utenfor navnerommene i `firstWaveTools`. |
| K6 merknad uten tall, id-er og leverandørnavn | BEKREFTET | Hele strengen sjekket mot sifre, leverandør- og modellnavn, valuta og uuid. |
| K6 lokal og eier-rute uendret | BEKREFTET (gateway) | `/confirmations` og `/finance/actions` kalt via gateway uten modell. Ikke prøvd mot ekte HTTP-ruter. |
| K6 dekker alle veier | FEIL | HIGH-1. |
| K7b DB-tester (K7a differensialtest under) | BEKREFTET | 18 filer, 278 tester grønne, inkludert alle N1-filer. |
| K7d lås-tester | DELVIS | De er grønne, men predikatet i produksjon er uprøvd (MEDIUM-1), og unntak og literal er ikke pinnet (L2). |
| K7e byggerens mutanter | BEKREFTET | `wpn1-mutants.mjs` kjørt verbatim: `TOTALT 46 DREPT 45 OVERLEVDE ["M48"]`. M48 er ekvivalent under dagens kall-rekkefølge. |
| K7a/K5 flagg AV == main, ikke tautologi | BEKREFTET | Jeg la origin/main (`ec3e684e`) sine `conversation.ts`, `tool-turn-route.ts`, `content-sensitivity.ts` og `message-store.ts` midlertidig oppå grenen. De to «flagg AV er identisk med main»-testene ble grønne, og kontrolltesten (flagg PÅ avviker) ble rød som forventet. Fixturen er altså ekte main. Mutantene R43-R48 ble drept. |
| K9 delte docs urørt, trailers | BEKREFTET | Kun `docs/runbooks/WPN1_RESTRICTED_HISTORY.md`; alle 10 commits har begge trailerne. |

## Mutasjoner

- **Mine:** 49 kjørt, 40 drept (39 av assertion, 1 tilfeldig: R18 `history` LIMIT), 9 overlevde, 0 ugyldige. Kjører: `mutate.mjs` + `mutants-b.mjs`.
- **Byggerens 46** gjennom min klassifiserende kjører: 45 drept, alle av assertion (ingen tekniske brudd), M48 overlevde.

Overlevende av mine:

| Mutant | Vurdering |
|---|---|
| R41, R42 | testhull, MEDIUM-1 |
| R27 | testhull, L1 |
| R31, R32, R35 | testhull, L2 |
| R08 | testhull, L3 |
| R11 (trigger også på INSERT) | ekvivalent: `OLD` er NULL på INSERT i PG16, så betingelsen blir NULL |
| R49 (truthy `restricted`) | ekvivalent for typede kallere; se I2 |

## Andre kjøringer

- **Typecheck:** `tsc --noEmit` for core, tool-gateway, model-gateway, executive og api: exit 0 uten feil.
- **Lint:** `eslint` på de 21 endrede ts/mjs-filene: exit 0.
- **Containment:** `pnpm check:containment`: exit 0.

## Ikke verifisert av meg

- NAS, ekte Ollama/Anthropic, ekte finansdata og runbook-steg 1-8: NOT VERIFIED.
- Lås PÅ mot de ekte HTTP-rutene (`/control` og `/finance/actions`), og full api-oppstart via compose med flagg PÅ.
- Hele suiten, `pnpm -r run typecheck` og `pnpm lint` (jeg kjørte kun de berørte pakkene og de endrede filene).
- Motorsemantikken i K3 og K4, og smitte-effektene: reviewer As område.
- Om andre grener også tar migrasjonsnummer 140 (kollisjon gir `migration_prefix_duplicate`). Det må lead sjekke.
- Spesialistdelegering (`delegate_code_task`) fra en låst tur klassifiseres kun på oppgavetekst. Det er utenfor N1, og jeg har ikke undersøkt det videre.

Filer i `/tmp/lead/N1-review-B-probes/`: `zz-n1-review-b-db.test.ts`, `zz-n1-review-b-lock.test.ts`, `zz-n1-review-b-acttier.test.ts`, `mutants-b.mjs`, `mutate.mjs`, `mutants-builder*.mjs`, `overlay-main.mjs`, `fix-high1/fix-high1.patch` og `*.log`. Patchen legges på med `patch -p1` mot repo-roten.
