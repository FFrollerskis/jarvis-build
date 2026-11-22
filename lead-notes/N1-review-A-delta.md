TS: 2026-11-22T13:59:46.098Z
VERDICT: MERGE ETTER FIKSER - M1, M2 (hurtigbane og modelldrevet uten bekreftelse) og L1-L6 er lukket med kjørt bevis, men to smale restlekkasjer av M2-klassen (N1 bekreftelsesbanen, N2 `get_task_status`) bør fikses før aktivering. Ingen HIGH.

Flagget er AV som standard. N1 og N2 er derfor aktiveringsblokkere, og de kan også tas i en runde 2 etter dormant merge.

**Metode:** worktree n1-rev-a @17949ceb, én vitest-arbeider, kun egne prosesser. Treet er ren før og etter (`git status --short` tom, HEAD uendret, probene flyttet ut). Byggerens N1-sett på ren HEAD: 15 filer, 177 grønne. Typecheck (core, model-gateway, tool-gateway, executive, api) og eslint på de 27 endrede `.ts`-filene ga exit 0.

## Dine tidligere funn -> status
| Funn | Lukket? | Bevis |
|---|---|---|
| M1 K6-prediktat ikke testet | JA | `financeLockServedLocally` og `FINANCE_EXECUTION_LOCK` (`restricted-context-guard.ts:28,33`). `wpn1-lock-predicate` kjører mot alle 10 DEFAULT_PROFILES og mot blank/ukjent/STORE/feil type. W01n (invertert), W02n (`true`), W03n (`false`) og W07n (lambda) er drept i fase 1 av den filen. main.ts-variantene W08n-W10n (ubetinget, fjernet, inline) er drept av guard-env. |
| M2 levering umerket | JA for hurtigbane og modelldrevet uten bekreftelse; ÅPEN i bekreftelsesbanen (N1) | Ekte `TaskService.submit` (ekte PolicyGateway, PgTaskQueue, DB): kontrakten har `restricted_origin:true`, leveringen lagres `restricted=true` (4 args), og neste anthropic-tur bærer den ikke (A1). Flagg AV: ingen nøkkel, 3 args (A2). Ulåst med flagg PÅ: ingen nøkkel (A3). Forfalsket `restricted_origin`/`restrictedOrigin`/`restricted`/nested context avvises `invalid_parameters`. Det trusted merket kan ikke fjernes (B1, B2). Ekte `MeshToolExecutor` med guards og `turn.restricted` via ekte `attachTurn`+`lock` gir merket (B3). |
| L1 testhull (C08, C09, C11, D07, T03/T04) | JA | C08n, C09n, S04n/S05n (D07) og X03n/X04n (T03/T04) er drept av navngitte tester i `wpn1-council-fast` og `wpn1-message-store-sql`. C11-linjen finnes ikke lenger fordi låsen ligger før start; L01n/L04n er drept. |
| L2 FAST-tabell | JA, men bred (N4) | Fem intensjoner låses før rapporten leses. T01n-T04n er drept. Prober: status, self_diagnosis, ytelse, cost og verdi gir rader [true,true]; evolusjon, hjelp og jobb* låses ikke. |
| L3 smitte-tekst / «bruk Claude» | JA | Tekst i `tool-turn-route.ts:82`. X01 (alternativ b) er drept, og X01n/X02n (tekstvariantene) er drept. `wpn1-explicit-cloud-restricted` kjører ekte `AiRouter`. |
| L4 lås før jobbstart | JA | F1: `markRestricted` kaster, `delegate`=0 og ingen assistentrad. F1b (`false`) gir samme. F2: mark kommer før assistentlagring. Flagg AV (F3/F3b): ingen mark, jobb startet, 3 args. L01n og L04n er drept. |
| L5 flagg AV-detaljer | JA | Runbook linje 112-113 dokumenterer `history()`/migrasjon 140 og logglinjen. Flagg AV mot ren main er målt under. |
| L6 stempling | JA | `wpn1-stamping-structure`: ST1 (fjernet), ST2 (feil leverandør) og ST3 (fra modell-args) er drept. GW2/GW3 (gateway-lås) er drept. |

**Flagg AV == main (punkt 6):**
- Min dump mot ren main ec3e684e: 8 000 (flagg utelatt) + 8 000 (eksplisitt false) + 12 000 (skynære) observasjoner, 0 avvik.
- Det samme orakelet dreper flagg-AV-mutantene L03n (602/8000) og Z17 (268/8000).
- Egne invarianter, flagg PÅ, 12 000 obs: 0 lekkasjer, 0 rekkefølge-/fullstendighetsbrudd (8 560 låste turer, 1 198 på hurtigbane). Flagg PÅ mot AV på umerket historikk gir 0 forskjeller (12 000 sammenligninger). Uten unntak gir 354 avvik, alle fra det nye feltet `delegate.restricted`.
- SQL: `save` med 3 args, `{}`, `{restricted:false}` og `{restricted:undefined}` gir samme setningsfølge som `git show ec3e684e`. `"true"`, `"false"`, 0, 1, null, `""`, `{}` og `[]` lagres begrenset (fail-closed, bevisst avvik).

## Nye funn (rangert)
**N1 MEDIUM (smal): bekreftelsesbanen mister `restricted_origin`.**
- Hvor: `mesh-bridge.ts:517-535` (confirmation_required) og `server.ts:1454-1461` (`approveAndTake` og `gateway.execute` uten `restrictedOrigin`).
- Repro: `p2/zz-n1-review-a2-chain.test.ts` C1. En LÅST og TAINTED web_chat-tur delegerer via ekte `MeshToolExecutor` med guards og `ConfirmationStore`. Etter godkjenning etter server.ts-sekvensen har kontrakten ingen `restricted_origin`, leveringen lagres `restricted=false`, og neste anthropic-tur bærer den (`bærer leveringen=true`).
- Taint er realistisk: `get_task_status` er `output_trust=untrusted`, e-post og GitHub likeså, og voice er untrusted input (C2).
- Byggerens test B kjører executoren uten `guards`, så banen ble aldri kjørt. Påstanden «Q-4 BYGGET (modelldrevet)» er derfor kun DELVIS.
- Fiks (prototypet, repro blir grønn: `restricted_origin=true`, levering `restricted=true`, 0 skylekkasje):
  1. `mesh-bridge.ts:517`: legg `"restricted_turn"` i `reasons` når `turn?.restricted===true`.
  2. `confirmation-store.ts` (`approveAndTake`, linje 332): returner `taint_reasons`.
  3. `server.ts:1458`: send `restrictedOrigin:true` når `tasks.delegate_background_task` og grunnen finnes. Kildevakten går da fra 2 til 3 steder.
- Server.ts-linjen er replisert i proben, ikke kjørt via HTTP. `CouncilProposalGate` foreslår kun act-nivå og er ikke berørt.

**N2 LOW-MEDIUM: `tasks.get_task_status` gir resultatet av en `restricted_origin`-jobb uskjermet til skymodell.**
- Hvor: `chat-jobs.ts:299`. `cloudScreenedExecutor` skjermer kun minne og kunnskap.
- Repro: D1. Leveringen er lagret begrenset, men en sky-tur som kaller `get_task_status` via ekte `MeshToolExecutor` + `cloudScreenedExecutor` (som chatten) får resultatteksten (`true`). Det omgår M2-fiksen når leveringsraden har glidd ut av 4-radersvinduet.
- Fiks (ikke prototypet): fjern `result_text` og sett `result_withheld:true` for jobber med `restricted_origin` når `context.servingModel` er sky, kun med vakten på. Ca. 15 linjer og en test.

**N3 LOW (testhull): mutant E07n overlever.**
- `main.ts:1173` (executive `servedLocally`) er en tredje inline-kopi av prediktatet og er ikke pinnet av noen N1-test. guard-env:90 sjekker kun gateway-signaturen, og H1/H2-testene bygger egne kopier.
- `() => true` der slår av både H2-tilbakeholdet og F-B1 uten at noe feiler.
- Fiks: bruk `financeLockServedLocally` og pinn det (2 linjer).

**N4 INFO: `system_status` er bred, men ikke en lekkasje.**
- Kjørt mot ekte `composeSelfDiagnosis` og `renderSelfDiagnosisNo` med `maxFindings:3`:
  - Frisk tilstand gir ingen øre.
  - Kostnad per kall 3 til 6.7 øre gir «Kostnad per kall økte fra 3 til 6.7 øre (+122 %)» i kortformen.
  - Tre andre advarsler foran gir ingen øre.
- Svaret kan altså bære AI-kost, men bare ved DEGRADED drift. Låsen er ubetinget, så hver «status» merkes.
- Smitte etter én «status» (40 kjeder x 20 turer, flagg PÅ mot AV): ren prat 100 % mot 0 % merket. Skykall er identiske (0/0, 599/599, 800/800), og skyverktøyturer er uendret (255/255, 800/800).
- Kostnaden er kun merking og at opptil 4 rader holdes ute av skyvarianten. Valgfri innstramming: lås etter lesing bare når svaret matcher `/\søre\b/`, og behold ubetinget lås for cost og value.

## Mutanter
- **70 nye mot den nye koden** (restricted-plumbing, `attachTurn`, lås før jobbstart, SLO/status-tabell, `save`-normalisering, nøstet executive, stempling, gateway-lås), kjørt mot byggerens 15 filer i to trinn (9 raske, 6 DB).
  - 67 drept av en feilet assertion: 41 i de raske, 26 i DB-settet. Navngitt første feil ligger i `p2/mutants7.json`, `mutants8.json` og `mutants9.json`.
  - 0 tekniske brudd, 0 ugyldige.
- **3 overlevende:**
  - A02n er ekvivalent. `attachTurn` kalles før noen `lock()` (`conversation.ts:400-410`), så grenen er død.
  - Z18 er ekvivalent. `userMarked` er ren optimalisering, og `markRestricted` er idempotent uten ny revisjon.
  - E07n er N3, et reelt hull.
- Kryss-motor-orakelet mot ren main dreper L03n og Z17 (se over).

## Ikke verifisert
- NAS, ekte Ollama/Anthropic, ekte `ModelGateway`. Kjeden motor -> ModelGateway er ikke kjørt; kun `AiRouter.plan` er testet av bygger.
- `main.ts` kjørt: den parser under `node --experimental-transform-types --check`, men wiring er kun regex-pinnet. Flagg PÅ i full api-oppstart via compose.
- `/confirmations` over HTTP (sekvensen er replisert), N2-fiksen (ikke prototypet), `server.ts`-delen av N1-fiksen.
- Full suite, `pnpm lint` og `check:containment` (lead), UI/dashbord, ekte minneekstraksjon.
- Jobber startet før aktivering og jobbresultatets eget innhold (byggerens Q-4-rest) er ikke vurdert utover N2.

**Probe-mappe:** `/tmp/lead/N1-review-A-probes/p2/`. Probene ligger i `worktree-final2/` (kopieres inn i `apps/api/test` og `modules/core/test`). Der finnes også `mutate7.py`, `mutate8.py` og `mutate9.py`, `*.json`/`*.log`, `status-ore.mjs`, `proto-n1.py` og `dump-head2-*.json`.
