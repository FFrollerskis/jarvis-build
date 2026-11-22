TS: 2026-11-22T15:33:54.377Z
VERDICT: MERGE - alle mine runde-1-funn (NF-1 a/b, NF-2) og reviewer A sin bekreftelsesbane er lukket med kjørt bevis. Ett nytt LOW (NF-3, samme klasse som Q-8) og noen INFO blokkerer ikke, siden alt er DORMANT bak flagget.

Grunnlag: worktree `n1-rev-b`, HEAD `b60bceb6`, ren før og etter, maks 1 vitest-arbeider. Delta `17949ceb..b60bceb6` er 17 filer (+1064/-49). Migrasjon 140 er uendret (`git diff -- migrations` = 0 linjer). Ingenting er verifisert mot NAS eller ekte modell.

## Dine funn -> status
| Funn | Lukket? | Bevis |
|---|---|---|
| NF-1(a) `get_task_status` (MEDIUM) | JA, BEKREFTET | Mine nye prober: 12 sky-/ukjente/feilformede modellformer og 7 skyleverandører via ekte `MeshToolExecutor` får `withheld`, nøytral tittel, `result_text`/`error` null, merknad uten sifre. Gjelder både id og liste, fullført og feilet. Lokal og eier-rute får alt, ikke-låst jobb er uendret, og blandet liste filtreres per jobb. |
| NF-1(b) hurtigbanens `jobbstatus` (MEDIUM) | JA, BEKREFTET | D4 snudd: låst jobb gir rader `[true,true]` (også `JOBBSTATUS` med store bokstaver og mellomrom). Ikke-låst jobb og vakt AV gir `[false,false]` uten oppslag, og oppslagsfeil gir `[true,true]`. |
| NF-2 / D18 (LOW) | JA, BEKREFTET | Failed/cancelled-test i `wpn1-job-delivery`. Min D18-mutant (R36), R37 og M109 er nå drept. |
| Reviewer A sin bekreftelsesbane (MEDIUM) | JA, BEKREFTET | Kortet bærer `restricted_turn`, `approveAndTake` gir grunnene, og rutens setter er kun `tasks.delegate_background_task` med grunnen. Mine prober: fingeravtrykk og binding er uavhengige av grunnene, og sannhetstabellen for `confirmationRestrictsOrigin` holder. Byggerens ekte-HTTP-test (13) er grønn. R26-R35 og M110-M117 drept. |
| Andre veier til `result_text`/`error`/`title` | STEMMER, BEKREFTET (grep) | `operations.list_tasks` leser tabellen `operations_tasks` (ikke `tasks`). `todoist` og video-`get_task_status` er eksterne. Daglig brief (`tasksSource`) går kun til `POST /brief` og Telegram (eier). `open_tasks` har ingen leser. Kontrollsentrene velger kun tellinger/metadata (`has_error` boolean). `business.get_business_brief` bruker ikke `tasksSource`. |
| Flagg AV uendret mot main | BEKREFTET | Se differensialene under. |
| INFO: kildevakt D, invariant C, `personal.finance_read` | DOKUMENTERT | Kun lest i runbook, begrensning 13-14. |

Setter-vakten og eksakt-form-testene:
- **Setter-vakt:** jeg teller selv tre settere (`main.ts:1441`, `mesh-bridge.ts:559`, `server.ts:1465`) pluss videreformidleren `gateway.ts:935`. Min fjerde setter i `follow-up-push.ts` (R33), en andre i `server.ts` (R34) og en variantform i `finance-actions.ts` (R35) slår alle ut vakten, som M117 også gjør.
- **De tre tilpassede eksakt-form-testene:** de er ikke svekket. De pinner nå eksakte `taint_reasons` (`["owner_action_tier"]`, `[COUNCIL_PROPOSAL_TAINT]`, `["wpf1"]`). Ingen annen test deep-equaler den gamle formen, og `server.ts` er eneste produksjonskaller.

Flagg-AV-differensialer:
- **`chat-jobs.ts` fra origin/main overlagt grenen:** 28 observasjoner (list/get, `get_task_status` for sky/lokal/uten modell, sveip med 3 argumenter, kontraktnøkler) gir byte-like JSON (12784 B).
- **`mesh-bridge.ts` og `confirmation-store.ts` fra main overlagt:** 13 kortobservasjoner (kortrader, sammendrag, fingeravtrykk, godkjenning og utførelse) er byte-like. Eneste forskjell er `taint_reasons` i `approveAndTake`.
- **De fire motorfilene overlagt (som før):** de to flagg-AV-testene er grønne og kontrolltesten er rød (1 failed / 6 passed).
- **Statisk:** tsc exit 0 for core, tool-gateway, model-gateway, executive og api. eslint på 16 endrede filer er exit 0, og containment er OK.
- **Tester:** N1-settet er 211/211 i 17 filer.

## Nye funn
**NF-3 LOW (BEKREFTET med probe): en LOKAL modell i en ULÅST verktøytur får rått jobbview, og svaret lagres umerket.**
- **Kode:** `chat-jobs.ts:362-372` gir råviewet til lokal modell. `conversation.ts:609-622` (dagstak nådd gir lokal verktøytur) og `:685-693` (`trackedExecutor` låser ikke på verktøyoutput) gjør at turen aldri låses.
- **Repro:** `/tmp/lead/N1-review-B-probes/zz-n1-review-b-r2-nf3.test.ts`. Grønn betyr lekkasje: assistentraden er `restricted=false`, og neste Anthropic-tur får teksten i historikken. Resultatteksten er med vilje uten stikkord, siden merket finnes for det klassifisereren ikke fanger.
- **Betingelser:** restricted-origin-jobb, lokal ulåst verktøytur (dagstak, `JARVIS_TOOL_TURN_MODEL=off` eller fallback), og et senere skykall innen vinduet. Standardoppsettet sender verktøyturer til sky, så sannsynligheten er lav.
- **Minimal fiks:**
  - Sett en trusted boolean (`restricted: true`) i det uholdte viewet for restricted-origin-jobber (kun med vakt PÅ).
  - La `trackedExecutor` kalle `marker.lock(["tool_output:tasks.get_task_status"])` når outputen har den.
  - Alternativt: dokumenter som akseptert rest under Q-8.

**INFO:**
- **Kobling mellom `jobOrigin` og vakten:** `conversation.ts:1241` hopper stille over låsen hvis `jobOrigin` mangler selv med `restrictedContextGuard: true`. Min gamle D4-probe viser `[false,false]` for en slik motor (BEKREFTET). Kun `main.ts` kobler dem, pinnet av kildevakt. Fiksforslag: fail-closed (lås) når `jobOrigin` mangler.
- **Setter-vaktens skannerom:** den dekker `{apps,modules,packages}/*/src`, ikke `modules/*/scripts/*.ts` (operatørskript, ikke API-prosessen).
- **Kort fra ulåst tur:** gjenbrukt av en senere låst tur får ikke merket. Jeg er enig med byggerens vurdering, siden parametrene er byte-like.
- **`jobbstatus` låser uavhengig av jobbens status:** strengeste regel, som bygger sier.

## Mutanttall
- **Mine nye mot ny kode:** R01-R37 (jobbresultat-tilbakehold, list vs get, fail-open ved ukjent modell, `withheld` med flagg AV, `main.ts`-oppkobling, `jobbstatus`-lås, `isRestrictedOrigin`, `restricted_turn`-vei, `restrictedOrigin`-settere, D18). Alle 37 drept (37 assertion), 0 tekniske, 0 overlevende, 0 ugyldige.
- **Byggerens M92-M119:** alle 28 kjørt gjennom min 1-arbeider-klassifiserer, 28/28 drept (28 assertion).
- **16 eldre byggermutanter som treffer filer endret i runde 2** (M18, M19, M52, M71, M72, M75, M77, M78, M83-M87, M89-M91): 16/16 drept (M91 via matcherfeil i A3, som før).
- **Totalt kjørt av meg denne runden:** 44 av 106 av byggerens mutanter. M48 (ekvivalent) er ikke kjørt på nytt.

## Ikke verifisert
- NAS, ekte Ollama/Anthropic, flagg PÅ i full api-oppstart via compose, alle runbook-steg (inkl. 7d/7e).
- `/confirmations` med ekte grant/identitet og dashbordet. Byggerens test bruker en enkel grant-løser; resten er ekte (Postgres, `TaskService.submit` med policy, `MeshToolExecutor`).
- Tidspunktet for lekkasjen ende-til-ende (vindu utløpt eller ny økt), samt NF-3 med ekte lokal modell. Proben bruker en falsk modellgateway.
- Leads full suite på `b60bceb6` pågikk fortsatt 15:30Z. Jeg kjørte kun N1-settet, `tsc` for 5 pakker og eslint på 16 filer, ikke hele repoet.
- M48-ekvivalens (byggerens påstand).

Mine prober og logger ligger i `/tmp/lead/N1-review-B-probes/`: `zz-n1-review-b-r2.test.ts`, `zz-n1-review-b-r2-flagoff.test.ts`, `zz-n1-review-b-r2-cards.test.ts`, `zz-n1-review-b-r2-nf3.test.ts`, `mutants-r2.mjs`, `mutants-r2.log`, `mutants-builder3.log`, `mutants-builder3-old.log`, `obs-*.json`.
