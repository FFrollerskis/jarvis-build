TS: 2026-11-22T13:54:04.019Z
VERDICT: MERGE ETTER FIKSER - alle mine tidligere funn er lukket med kjørt bevis, men fiks-runden lar resultatet av en LÅST jobb nå skymodeller (`tasks.get_task_status`) og lagres umerket (hurtigbanens `jobbstatus`).

Grunnlag: worktree `n1-rev-b`, HEAD `17949ceb`, ren før og etter. Delta `96999794..17949ceb` er 29 filer (+1584/-75), og migrasjon 140 er uendret. Alt er dormant bak flagget (default AV). Jeg brukte maks 1 vitest-arbeider. Ingenting er verifisert mot NAS eller ekte modell (NOT VERIFIED).

## Dine tidligere funn -> status
| Funn | Lukket? | Bevis |
|---|---|---|
| HIGH-1 nøstede kall omgår låsen (F-B1) | JA, BEKREFTET | D1-prober (3): sky (anthropic/ukjent/tom/STORE) får `finance_kill_switch_withheld:true` og ingen nøstet finance-transport; lokal og eier-rute får alt uten merke. Mine LK5-lekkasje/fiks-prober er grønne på HEAD (29/29). |
| (HIGH-1, flagg AV) | JA, BEKREFTET | Transporten kaller med ETT argument for lokal, eier og flagg AV, og med `{withholdFinance:true}` kun for sky + vakt PÅ. Ingen nye felter (D02-D06 drept). |
| (HIGH-1, byggerens merke) | AKSEPTABELT | Uten merket leses `null` som «ingen nødbryter». Merket settes kun når avlesningen holdes tilbake. |
| (HIGH-1, generell invariant C) | SOLID | Alle web_chat-verktøy kalt som sky: >60 nås, 0 finance*-transportkall. Jeg muterte den med nye nøstede kall i fire andre executive-metoder: D25, E04, E05 (dynamisk tool_id), E06 (svelget feil), E01b, E03b. Alle drept. E02 ble drept av kildevakt D. |
| (HIGH-1, kartlegging) | BEKREFTET | Grep i `modules/*/src` og `apps/api/src`: finance*-id navngis kun i executive/service.ts og finance-actions.ts (eierrute). `finance_${action}` i server.ts:1508 er en step-up-etikett, ikke et verktøy-id. |
| MEDIUM-1 prediktat utestet (R41/R42) | JA, BEKREFTET | `FINANCE_EXECUTION_LOCK`/`financeLockServedLocally` ligger i restricted-context-guard.ts. `wpn1-lock-predicate.test.ts` kjører mot alle 10 DEFAULT_PROFILES: lokale local_llm/gemma_local/ollama/scripted, sky openai/anthropic/gemini/gemma_hosted/kimi/hermes. Tom/blank/ukjent/STORE er også med. D07-D10 og M68-M70/M86 drept. |
| L1 `routing_unreadable` umerket (R27) | JA, BEKREFTET | D26 drept (conversation.ts). |
| L2 lås-hull (R31/R32/R35) | JA, BEKREFTET | D11 (jobContract), D12 (approval) og D13 (reason-literal) drept. |
| L3 kolonne-ACL (R08) | JA, BEKREFTET | Test via `pg_attribute.attacl` for alle roller inkl. PUBLIC. D14 drept. |
| L4 merke kan fjernes via DELETE+INSERT/superbruker | JA (dokumentert) | Runbook rollback-del. Migrasjon 140 er byte-lik. |
| I2 `save()` med undefined/false/annet | JA, BEKREFTET | `save()` er fail-closed. SQL pinnet mot ordrett main-kopi, `{restricted:undefined}` og `{restricted:false}` gir samme SQL. Jeg grepet alle `save`/`saveMessage`-callere. D15/D16 drept. |
| I1, I3-I6 | DELVIS | Kun dokumentasjon (jeg har lest runbooken). Ingen kodeendring forventet. |

## Ny kode: ingen funn utover NF-1
- **F-A2-kjeden er solid (BEKREFTET).** Parametre kan ikke forfalske `restrictedOrigin`/`restricted_origin` (strengt zod, D3). Et innsendt `restricted_origin` via `/tasks/submit` er inert, fordi `delegated_from_chat` er reservert og sveipet ignorerer ikke-delegerte. Merket kan ikke fjernes (ingen kode omskriver `tasks.contract`).
- **Failed og cancelled jobber (D3):** leveres begrenset når starten var låst. Ikke-låst start gir tre argumenter.
- **Tredje setter-mutanter** (D19-D22: connector-health-sweep, follow-up-push, ubetinget MeshToolExecutor og ubetinget transport) er drept. Kildevaktene låser setterne til main.ts 1, gateway.ts 1 og mesh-bridge.ts 1.
- **Flagg AV:** kontrakt uten nøkkel, ToolGateway uten lås og identiske kallformer. D22 og D24 gir ingen avvik.
- **Overlegg av origin/main-filer** (conversation.ts, tool-turn-route.ts, content-sensitivity.ts, message-store.ts): de to flagg-AV-differensialtestene er grønne, og kontrolltesten er rød som forventet (1 failed | 6 passed).
- **Statisk:** tsc exit 0 for core, tool-gateway, model-gateway, executive og api. eslint på 28 endrede filer exit 0. Containment OK.
- **Tester:** N1-settet er 177/177 i 15 filer. Delta-prober 7/7 (D2 og D4 er skrevet som lekkasjebevis, så grønn = lekkasje bekreftet).

## Nye funn (rangert)
**NF-1 MEDIUM (BEKREFTET, probe D2 og D4): resultatet av en LÅST jobb er fortsatt tilgjengelig for skymodeller.** Kun leveringsmeldingen merkes.
- **(a)** `apps/api/src/chat-jobs.ts:106-114` (`toView`) og `:299` (`get_task_status`, id og liste) returnerer `result_text`/`error`/`title` uten å bruke `restricted_origin`. Et sky-stemplet kall får teksten fra den lokale modellen, også via ekte `MeshToolExecutor` (`provider: "anthropic"`).
  - Repro: `/tmp/lead/N1-review-B-probes/zz-n1-review-b-delta.test.ts`, D2.
  - BEKREFTET at verktøyet gir teksten til et sky-kall. Når en slik tur faktisk kjøres (vindu utløpt eller ny økt) er ikke kjørt ende-til-ende.
- **(b)** `apps/api/src/conversation.ts:1230-1235` og `restricted-context-guard.ts:65` (`task_status: false`): hurtigbanens `jobbstatus <id>` gjengir `Resultat: ${JSON.stringify(result)}`. Bruker og svar lagres som `restricted=false` (D4: rader `[false,false]`), og den neste skyturen ser dem i historikken.
- **Ikke dekket av runbookens DEFERRED** (linje 125 gjelder jobber startet før flagget og resultatinnhold fra jobber som selv leser data). Dette er en annen kanal.
- **Minimal fiks:** velg `restricted_origin` i `ChatJobs.list/get`. Gi `TasksDelegateTransport` en vakt-styrt `servedLocally` (samme mønster som `withholdFinanceFromCloud`, `financeLockServedLocally`). For sky/ukjent modell returneres `result_text:null`, `error:null` og `withheld:true` for restricted-origin-jobber. Flagg AV skal ikke endres. På hurtigbanen låses/merkes turen før svaret lagres når jobben er restricted-origin.
- **Alternativ:** dokumenter det som akseptert rest (Q-4) og slå ikke på flagget før det er lukket. Dormant merge er forsvarlig under det forbeholdet. Kjørbar test: D2/D4 snudd.

**NF-2 LOW (BEKREFTET): testhull D18.** Ingen repo-test pinner at failed/cancelled jobber fra låst start leveres begrenset. Mutanten `row.restricted_origin === "true" && view.status === "completed"` på `chat-jobs.ts:200` overlever. Koden er riktig i dag, siden min D3-probe er grønn. Fiks: ta D3 (failed og cancelled gir `restricted=true`) inn i `wpn1-job-delivery.test.ts`.

**INFO:**
- Kildevakt D matcher kun literal `tool_id:\s*"finance…"`. Dynamiske og posisjonsformede kall fanges bare av kjøringen C (E05 beviser at C fanger dem). C forutsetter at nye verktøy står på `SURFACE_TOOL_GRANTS.web_chat` og at `sampleParams` når transporten.
- Mine første E01/E03 overlevde fordi mutantene brukte fabrikkert identitet og kallet ble avvist før transporten. De er ugyldige, omskrevet som E01b/E03b og drept. Dette er ikke en testsvakhet.
- M76 og M91 er drept av en matcherfeil i A3 (`toBeGreaterThanOrEqual(undefined)`), som min kjører klassifiserer som OTHER. Det er ekte drap.
- `personal.finance_read` (eier-HTTP, ingen modell, flagg DORMANT) ligger utenfor låsen. Det er byggerens Q-9.

## Mutanttall
- **Mine nye mot ny kode:** 33 gyldige (D01-D27 pluss E02, E04, E05, E06, E01b, E03b). 32 drept (alle assertion-drap), 1 overlever (D18). 2 ugyldige forkastet (E01, E03).
- **Mine 9 overlevere fra runde 1** (R08, R11, R27, R31, R32, R35, R41, R42, R49):
  - R08, R27, R31, R32, R35, R41 og R42 er nå drept via D14, D26, D11-D13 og D07-D10.
  - R49 har omvendt semantikk (fail-closed) og er dekket av D15/D16.
  - R11 er uendret: migrasjon 140 er byte-lik og ikke del av deltaen.
- **Byggerens kjører (78 mutanter):** jeg kjørte alle 78 via 1-arbeider-adapter, siden kjøreren hardkoder 2. Alle 32 nye M60-M91 er drept (30 assertion, 2 matcherfeil). Av de 46 gamle er 45 drept. M48 overlever (byggeren: ekvivalent; jeg har ikke bevist det selv, DELVIS).

## Ikke verifisert
- NAS, ekte Ollama/Anthropic og ekte data, samt alle runbook-trinn (1-8, 7b, 7c).
- Flagg PÅ i full api-oppstart via compose.
- Eierens HTTP-ruter (`/control`, `/finance/actions`) med lås PÅ.
- At `restricted_origin` overlever ekte `TaskService.submit` med policy (også NOT VERIFIED hos byggeren). Nøkkelen følger samme `input.data`-vei som den fungerende `delegated_from_chat`.
- Full suite og `pnpm -r typecheck` / `pnpm lint` for hele repoet: jeg kjørte 5 pakker og 28 filer, leadens kjøring dekker resten.
- Engine-semantikk K3/K4 (reviewer A).
- Om andre grener bruker migrasjonsnummer 140.
- Ende-til-ende tidspunkt for NF-1 (vindu/ny økt).

Filer: prober, mutantdefinisjoner og logger ligger i `/tmp/lead/N1-review-B-probes/`: `zz-n1-review-b-delta.test.ts`, `mutants-delta.mjs`, `mutants-delta2.mjs`, `mutants-delta3.mjs`, `mutants-delta4.mjs`, `mutants-delta.log`, `mutants-builder2.log`, `overlay-main-delta.log`, `n1-all-head.log`, `old-probes-head.log`.
