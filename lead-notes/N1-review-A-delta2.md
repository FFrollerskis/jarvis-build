TS: 2026-11-22T15:28:44.129Z
VERDICT: MERGE - N1, N2 og N3 er lukket med egen kjørt bevisføring, flagg AV er fortsatt lik ren main (28 000 obs, 0 avvik), og jeg fant ingenting nytt over INFO/LOW.

**Metode:** worktree n1-rev-a @b60bceb6, én vitest-arbeider, treet ren før og etter (`git status` tom, probene i `/tmp/lead/N1-review-A-probes/p3/`). Byggerens 17 N1-filer på ren HEAD: 211 grønne. Typecheck (core, model-gateway, tool-gateway, executive, api) og eslint på de 15 endrede `.ts`-filene ga exit 0. De 7 endrede produksjonsfilene, inkludert `server.ts`, laster under `node --experimental-transform-types`. Tre røde i min første probekjøring var feil i proben (listen er per eier, og brukerraden lagres først med 3 args). De er rettet og gir ingen produktfeil.

## Dine funn -> status
| Funn | Status | Bevis |
|---|---|---|
| N1 bekreftelsesbanen | LUKKET | Min C1 på nytt over EKTE `createApiServer` `/confirmations` (egen harness), se under. |
| N2 `get_task_status` | LUKKET | D1 snudd, se under. |
| N3 E07n | LUKKET | `servedLocally: financeLockServedLocally,` (`main.ts:1173`). K35 (`() => true`) og K36 (annen inline-regel) er drept av `wpn1-guard-env`: én forekomst, ingen `servedByCloudModel` i kode i main/worker-main, kun 4 filer i `apps/api/src` bruker den. |
| N4 `system_status` | Uendret, bevisst | Lead-beslutning, runbook begrensning 12. |

**N1 (punkt 1).**
- Kortet har grunnene `[untrusted_output:email.search, restricted_turn]`. Etter godkjenning er `restricted_origin=true` i kontrakten, leveringen lagres `restricted=true` (4 args), og neste anthropic-tur bærer den ikke.
- Byggerens rutetest er ekte nok. `server.ts:1425-1475` kjører uendret mot ekte Postgres, ConfirmationStore, ToolGateway, `TaskService.submit` med policy og MeshToolExecutor med guards. Kun `grants.verify` og `identity.resolveIdentity` er enkle. Dekker ikke ekte grant-signatur, step-up eller rate limit.
- Flagg AV (A3):
  - Kortets `taint_reasons` og `summary` er uendret, og bindingen er uavhengig av grunner.
  - Rutesvaret har samme 5 nøkler uten `taint_reasons`.
  - Ingen `restricted_origin`.
  - `approveAndTake` kalles kun fra `server.ts:1455`.
- Lesere: Sikkerhet-senteret (`security.ts:120`) teller `cardinality(taint_reasons) > 0`. Alle gate-kort har allerede minst én grunn, så telleren er uendret. Autoritet-senteret (`authority.ts:613`) viser kun teksten.
- De tre tilpassede testene er strengere, ikke svakere: `toEqual` er beholdt og eksakte `taint_reasons` er pinnet (`["owner_action_tier"]`, `[COUNCIL_PROPOSAL_TAINT]`, `["wpf1"]`). Ingen andre `toEqual` på `approveAndTake` finnes.
- Ventende kort fra ulåst tur gjenbrukt av låst tur (A4): reprodusert, samme kort, `confirmation_pending`, ingen `restricted_origin`. Ingen restlekkasje, fordi jobbparametrene er byte-like det som ble foreslått i den ulåste turen. Omvendt (låst kort gjenbrukt av ulåst tur) er strengere.

**N2 (punkt 2).**
- Sky-stemplet kall via ekte `MeshToolExecutor` + `cloudScreenedExecutor` får `withheld` og ingen resultattekst. `gemma_local` får resultatet.
- Seks sky/ukjente varianter holdes tilbake både med id og i listen: anthropic, openai, ukjent leverandør, tom, `GEMMA_LOCAL`, ` gemma_local`. De får nøytral tittel, `result_text` og `error` = null, og ingen del av forespørselen.
- Kjørende og feilet låst jobb er også tilbakeholdt.
- Lokale leverandører og eier uten `servingModel` får alt uten `withheld`-nøkkel. Ulåst jobb er uendret for sky.

## Øvrig delta (punkt 4-5)
- **`jobbstatus`:** låser før svaret lagres (bruker- og assistentrad `[true,true]`, 3 args for brukerraden og 4 for assistenten). Lås også for kjørende, feilet og avbrutt jobb. Oppslagsfeil gir lås. Ukjent jobb gir «Fant ikke jobben» uten oppslag. Flagg AV: radene er umerket, 3 args, oppslaget kalles aldri.
- **Flagg AV == main:**
  - Dump mot ren main ec3e684e: flagg utelatt 8 000, eksplisitt false 8 000 og skynære 12 000 observasjoner, 0 avvik.
  - SQL-pinnene 16/16 grønne. `message-store.ts` er uendret i runde 2.
  - `ChatJobs.list/get` og transportens `get_task_status`-svar er byte-like en ordrett kopi av main sin `chat-jobs.ts`, også for en jobb med `restricted_origin`. Den ekstra SQL-kolonnen lekker ikke, siden `toView` bygger eksplisitte felt.

## Nye funn (rangert)
1. **LOW, testhull, ikke lekkasje.** K29 og K30 overlever alle 17 N1-filer (`conversation.ts`, `jobbstatus`-låsen).
   - Låsen kan snevres inn til `status === "completed"` eller «har resultat» uten at noe feiler. Påstanden «uavhengig av status» er ikke pinnet.
   - Min C4-probe dreper begge. Lekkasjemessig er de nær-ekvivalente, siden kun ferdige jobber har resultattekst i svaret.
   - Minimal fiks: ta C4 inn som test (kjørende, feilet og avbrutt LÅST jobb gir rader `[true,true]`).
2. **INFO, kjent kant (runbook linje 11, Q-8).** En lokal, IKKE-låst verktøytur (fallback, dagstak eller «kun lokale modeller») får hele viewet fra `get_task_status` og lagrer svaret umerket. Resonnert fra koden, ikke reprodusert.
3. **INFO.** `restricted_turn` vises som tekst i Autoritet-senterets kortfakta (1 bit metadata, intet innhold). Ikke verifisert om senteret er modell-synlig.

## Mutanter (punkt 6)
- **36 nye** mot runde-2-koden: confirmation-banen K01-K11, withheld-logikk og predikat K12-K26 og K41/K42, jobbstatus-lås K27-K30, main-oppkobling K32-K36.
- 34 drept av en feilet assertion: 6 i raske tester (`wpn1-lock-predicate` 4, `wpn1-guard-env` 2) og 28 i DB-testene (`wpn1-job-status` 18, `wpn1-confirmation-path` 10).
- 2 overlevende (K29, K30, se funn 1). 0 tekniske brudd, 0 ugyldige.
- K29 og K30 er drept av min egen C4-probe.

## Ikke verifisert
- NAS, ekte Ollama/Anthropic og kjeden motor -> ekte `ModelGateway`.
- Flagg PÅ i full api-oppstart via compose (`main.ts`-oppkoblingen er kun regex-pinnet).
- `/confirmations` med ekte grant-signatur, step-up og rate limit.
- Dashbord og Autoritet-/Sikkerhet-senter i UI.
- Leveringsvinduets ende-til-ende-tidspunkt (jeg testet i samme sesjon).
- Den lokale ulåste verktøyturen (funn 2).
- Lead sin fullsuite, `pnpm lint` og `check:containment`.
