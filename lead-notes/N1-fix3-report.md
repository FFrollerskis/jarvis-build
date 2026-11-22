TS: 2026-11-22T16:27:12.488Z
# WP-N1 fiks-runde 3 (siste): sluttrapport (bygger)

Ny HEAD er `f1aa33e8` (base `99d3db49`, 5 nye commits, begge trailerne). Treet er rent. Det er ikke pushet, jeg har ikke kjørt hele suiten, og av docs er kun `docs/runbooks/WPN1_RESTRICTED_HISTORY.md` rørt. Alt er DORMANT bak flagget og **NOT VERIFIED** mot NAS og ekte modell.

## Commits
```
72682630 fix:  R3-1/R3-2 lokal ulåst verktøytur låses ved restricted-origin-jobb; jobbstatus fail-closed uten jobOrigin
4257ec04 test: R3-1/R3-2/R3-3 beskyttelsesbevis (B sin NF-3-probe snudd, A sin C4)
8dc91e14 test: 16 nye mutanter M120-M135 + eierens ChatJobs-views pinnet
a44480a1 test: M98/M99/M100/M103 oppdatert (mønstrene ble ugyldige av R3-1/R3-2)
f1aa33e8 docs: runbook fiks-runde 3
```

## Per funn
- **R3-1: FIKSET.**
  - **Viewet:** det uholdte viewet for en LOKAL modell bærer `restricted: true` for en restricted-origin-jobb (id og liste). Feltet settes av `ChatJobs.present` fra kontrakten, aldri fra tekst. Kun med vakt på og et modellvendt kall.
  - **Låsen:** `trackedExecutor` låser turen med `tool_output:tasks.get_task_status` når outputen kommer fra den kilden og bærer feltet. Gjelder ikke skykall. Brukerraden merkes, og alle svar lagres begrenset.
  - **Ekstra fail-closed (avvik):** en utkuttet output (`maxOutputChars`) regnes også som bærer. En lang liste kan ha skjult feltet.
  - **Uendret:** eierens ruter, vakt AV (byte-lik main, to-argument-kall), jobber uten merket og skyviewet (`withheld`, ingen lås). Kaster merkingen, feiler turen med `restricted_marking_failed`.
  - **Bevis:** `wpn1-job-status.test.ts` seksjon E. Reviewer B sin probe gir nå rader `[true,true]`, og neste skytur bærer verken resultat eller spørsmål.
  - **Verdt å vite:** `JARVIS_TOOL_TURN_MODEL=off` er en gyldig konfigurasjon der alle verktøyturer er lokale og ulåste, så dette er normalløpet der.
- **R3-2: FIKSET.** Vakt på og `jobOrigin` mangler gir lås. Vakt AV er uendret. Bevis i job-status B og engine-guard (harnessen fikk `RunOptions.jobOrigin`).
- **R3-3: FIKSET.** Kjørende, feilet og avbrutt LÅST jobb gir `[true,true]`, vanlig jobb `[false,false]`. K29/K30 drept (M133/M134).
- **R3-4: FIKSET** (kun runbook, ingen kode): begrensning 16–19, begrensning 4 med ett unntak, K3c-rad, `messages.save`-tabell, «låst tur»-årsaker, NAS-steg 7f.

## Tester
- **N1:** 226 grønne i 17 filer (var 211). `wpn1-job-status` gikk fra 13 til 27 og `wpn1-engine-guard` fra 31 til 32.
- **`apps/api/test`:** hele mappen 228 filer / 3398 tester grønne.
- **`modules/executive`, `tool-gateway` og `model-gateway`:** 219 filer / 3657 tester. Kun de tre kjente `wpc3-review1-hardening` F10a/b/c er røde.
- **Lead sin suite på `b60bceb6`:** 992 filer, 16866 tester, de samme fem kjente røde.
- `pnpm -r run typecheck`, `pnpm lint` og `pnpm check:containment`: exit 0.

## Mutanter
- **122 totalt:** 121 drept av assertion, M48 ekvivalent som før, 0 tekniske brudd.
- **16 nye (M120–M135), alle drept.**
  - R3-1: feltet ikke satt, ikke lest, satt for vanlig jobb, satt med vakt AV, satt for eierens rute og `ChatJobs` uten valg, `lock()` hoppet over, kildesjekk fjernet, utkuttet output fail-open, skyviewet bærer feltet, listen glemmer markeringen, skykall med utkuttet output låser.
  - R3-2: fail-open uten `jobOrigin`, grenen kjører med vakt AV.
  - R3-3: K29/K30.
- **Fire runde-2-mutanter ble ugyldige** (M98/M99/M100/M103: mønstrene var omskrevet av R3-1/R3-2). Jeg oppdaterte mønstrene i `wpn1-mutants.mjs` (testene er uendret) og kjørte dem på nytt, alle drept. Den fulle kjøringen ga 117 drept og de fire ugyldige. De fire ble kjørt separat etter oppdateringen, så det finnes ikke én sammenhengende grønn kjøring av alle 122.

## Avvik fra ordren
- Eksisterende tester tilpasset: lokal modell får `restricted: true`, eierens rute det gamle viewet, og kallformen er nå `[3,2,3]`.
- Kildevakt-pinnene i `wpn1-job-delivery` er per rolle, og setter-pinnene er uendret.

## NOT VERIFIED
- En ekte lokal modell (Ollama) i en ulåst verktøytur (steg 7f). Testene bruker falske modeller, ekte `MeshToolExecutor`, `ConversationEngine` og embedded Postgres.
- NAS og flagg PÅ i full api-oppstart via compose.
- Alle runbook-steg 1–8 og 7b–7f.
