TS: 2026-11-22T16:43:32.607Z
VERDICT: MERGE - NF-3 (R3-1), `jobOrigin`-INFOen (R3-2) og testhullet K29/K30 (R3-3) er lukket med kjørt bevis. Jeg fant ingenting over INFO i deltaen.

HEAD `f1aa33e8`, ren før og etter, 1 vitest-arbeider. N1-settet er 226/226 i 17 filer, tsc `apps/api` exit 0, eslint på de 7 endrede filene exit 0, og migrasjon 140 er uendret.

## Funn -> status
| Funn | Status | Bevis |
|---|---|---|
| R3-1 / NF-3 (LOW) | LUKKET, BEKREFTET | Min gamle NF-3-probe er nå rød: radene er `[["user",true],["assistant",true]]`. Mine nye prober: dagstak, lokal gemma og låst jobb gir `[true,true]` og 1 revisjonsrad, og neste skytur får verken resultat eller spørsmål. Ulåst jobb gir `[false,false]` uten lås. |
| Skytur | `withheld`, ingen lås, BEKREFTET | Id og liste: `withheld` uten `restricted`-nøkkel, rader `[false,false]`, 0 revisjonsrader. |
| Feltet forfalskes? | NEI, BEKREFTET | `{"restricted":true}` i tittel, resultat eller feil gir ingen nøkkel og ingen lås. Feltet kommer kun fra `restricted_origin` (true og "true"); false, "false", 1, "TRUE", null og manglende nøkkel gir det ikke. Kilden stemples av executoren. |
| Utkuttet output | LUKKET, BEKREFTET | Med `maxOutputChars=120` låser lokalt kall `[true,true]`, og skykall låser ikke. Realistisk case med standard 20 000 tegn: 8 jobber, 7 med 4,5k feiltekst, den låste eldst. Outputen kuttes ved 20 000 tegn, feltet ligger i den avkuttede halen, og fail-closed låser likevel. |
| Eierens ruter og vakt AV | byte-like main, BEKREFTET | Overlegg av origin/main `chat-jobs.ts`: 28 vakt-AV-observasjoner er byte-like (10 930 B). Med vakt PÅ er eierruten (ingen `servingModel`) byte-lik. Lokal modell er lik main pluss `restricted` kun på de låste jobbene. De fire motorfilene overlagt: to vakt-AV-tester grønne, kontrolltest rød som forventet. |
| R3-2 `jobOrigin` mangler (INFO) | LUKKET, BEKREFTET | Min gamle D4 (vakt PÅ, ingen `jobOrigin`) gir nå `[true,true]`; den gamle påstanden `[false,false]` feiler. Vakt AV uendret. |
| R3-3 / K29, K30 | LUKKET, BEKREFTET | Kjørende, feilet og avbrutt låst jobb gir `[true,true]`, vanlig jobb `[false,false]`. K29/K30 og M133/M134 drept. |

## Nye funn
1. **INFO (teststyrke, BEKREFTET):** låsen i `trackedExecutor` (`conversation.ts:696`) er riktig i produksjonskoden, men atferdstestene i motorløpet bruker kun `gemma_local` og `anthropic`.
   - Repro: mutanter som hardkoder leverandøren (`call.provider === "gemma_local"` eller `!== "anthropic"`) dør kun av den eksakte kildepinnen i `wpn1-job-status` D. Når «kildevakt»-testene utelates via `-t`, overlever begge (G19, G20). Kontrollmutanten G06 (lås hoppet over) dør fortsatt.
   - Minimal fiks: kjør lås- og ingen-lås-testene over alle lokale leverandører (`gemma_local`, `ollama`, `local_llm`, `scripted`) og flere sky-/ukjente leverandører. Ikke blokkerende.
2. **INFO (byggeren har dokumentert dette):** med `JARVIS_TOOL_TURN_MODEL=off` låser enhver tur som leser en restricted-origin-jobb, også en liste der bare én av de 8 siste er låst. Det er streng, ikke løs, oppførsel.

## Mutanter
- **Mine:** 22 mot alle 17 N1-filer (Q01-Q20 pluss K29/K30). Alle 22 drept av assertion, 0 overlevende, 0 ugyldige. De dekker:
  - feltet ikke satt, satt for vanlig jobb, satt på skyview, satt for eierrute og satt med vakt AV;
  - `lock()` hoppet over, lås for skykall, kildesjekk fjernet, listesjekk fjernet og `some`→`every`;
  - utkuttet output fail-open, truthy i stedet for `=== true`, id og liste glemmer markeringen, tilbakehold beregnet på `undefined`;
  - `jobOrigin`-mangel fail-open, den gamle `marker && jobOrigin`-grenen og oppslagsfeil fail-open.
- **Byggerens 20** (M120-M135 pluss de oppdaterte M98, M99, M100, M103): 20/20 drept. M132 dør av et exception i seksjon B, ikke av en assertion; de øvrige 19 av assertion. Alle 20 mønstre er gyldige.
- **Totalt kjørt av meg:** 42 mutanter. Byggerens øvrige 102 og M48 (ekvivalent) er ikke kjørt på nytt.

## Ikke verifisert
- En ekte lokal modell (Ollama) som faktisk kaller `get_task_status` i en ulåst tur (steg 7f), NAS og flagg PÅ i full api-oppstart. Mine prober bruker falske modeller, ekte `MeshToolExecutor`, `ConversationEngine` og embedded Postgres.
- Leads full suite på `f1aa33e8` (pågår til ca. 17:20Z). Jeg har kun kjørt N1-settet, mine prober, differensialene, mutantene, tsc for `apps/api` og eslint på 7 filer, ikke hele repoet.

Prober og logger ligger i `/tmp/lead/N1-review-B-probes/`: `zz-n1-review-b-r3.test.ts`, `zz-n1-review-b-r3-flagoff.test.ts`, `mutants-r3.mjs`, `mutants-r3.log`, `mutants-builder4.log`.
