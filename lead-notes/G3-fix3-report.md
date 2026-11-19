TS: 2026-11-19T22:44:39.314Z
Alle sju punkt er gjort og committet, men tillegget «Mikro-runde 3» kom ikke inn i `/tmp/lead/G3-fix2-report.md`: Write-verktøyet avviste skrivingen («Subagents should return findings as text, not write report files»). Jeg omgikk ikke blokkeringen. Teksten under er tillegget, klart til å limes inn øverst i rapportfilen. Ingenting er VERIFIED mot virkeligheten.

# Mikro-runde 3 (G3, etter DELTA2-reviewene mot `c0981991`)

Gren `claude/wp-g3-vision`, base `c09819918c049b1031ad308e7b3cec32b0396dce`, **ny HEAD `7388d9ea1677bbcf3fd43216466a40c5c1067224`** (6 commits, arbeidstreet rent, ingen rebase eller PR). Migrasjonene 133–137 er uendret, og delte docs (DECISIONS, OPEN_QUESTIONS, FINDINGS_LEDGER, CLOSURE_MATRIX, PROJECT_STATUS) er ikke rørt. Alt er testet mot embedded Postgres og falske kilder.

| # | Funn | Commit | Testbevis | Mutasjonsbevis |
|---|---|---|---|---|
| 1 | A LOW-E1: ordtelling i JS og CHECK 133 var ulik. NBSP + mellomrom + «a b c d» ga 23514. Lukket ved at JS teller på ASCII-mellomrom; SQL er uendret. | `801a6fcb` | `g3-label-locale` 21→26: tre nye sveip over hele Unicode-rommet i begge locales (kodepunkt ved kanten av og limt mellom ord av en fire-ords etikett), eksplisitte strenger, seedet fuzz på 30 000 strenger mot selve CHECK-en. Fuzzen gir 0 avvik i begge retninger. Den gamle JS-regelen avviker på 2 929 av dem, 1 937 i den farlige retningen. `g3-pure` 31→32. | 8 mutanter. T2 og T5, som overlevde hele G3-settet, er nå felt av både `g3-label-locale` og `g3-migrations`. T2/T5 overlevde `g3-migrations` til jeg la strengene dit. |
| 2 | A LOW-E2: HA-stripping. `accesstoken`/`ACCESSTOKEN` ble beholdt (regresjon), `auth_failed` strippet (falsk positiv). Nå normalisert nøkkel mot eksplisitt `SECRET_NAMES`. | `848740a2` | `d388-connectors-v2` 29→32: 52 navn strippes, falske positiver beholdes (snake og camelCase). Orakel mot den gamle regelen: 768 nøkler strippes fortsatt, 1 152 i den tilsiktede egenskapsklassen beholdes. | 10 mutanter. H9 (camelCase deles ikke) overlevde først og ble felt etter nye camelCase-tester. |
| 3 | A LOW-E3 og B LOW-E1: svelget inventarhopp. Nå teller, strukturert logglinje, poller-summary, upload-respons og status. | `237feaa5` | Hopp telles per hendelse og rapporteres først etter commit. Nytt: `outcome.inventory_skipped`, `pipeline.stats()`, `/vision/status.ingest`, `PollSummary.inventory_label_*`, upload-respons `outcome.inventory_skipped` (et tall), og én logglinje `vision_inventory_skipped` per hendelse (kode og tall, aldri etikettinnhold). Tester: `g3-label-locale` +2, `g3-ha-pipeline` +1, `g3-poller` +2, `wpg3-vision-routes` +1, `wpg3-vision-runtime-db` +1. | 15 mutanter, bl.a. «tell ved tilbakerulling», «ingen logg», «upload alltid 0». |
| 4 | B LOW-E2: lett vedlikehold uten databasegrenser og med stille overlappvakt. Lukket uten å røre `createPool`. | `0ada029b` | Ny `apps/api/src/vision-db-limits.ts`: `limitedPool` og `runWithDbLimits` gir hver vedlikeholdstransaksjon `SET LOCAL statement_timeout` 5 min og `lock_timeout` 15 s (også `pool.query`). Starttid-vakt: kjøring over 30 min regnes forlatt og kan erstattes, høyst 2 forlatte om gangen. Hoppede tikk er synlige: `/vision/status.maintenance.light_run` {`running_since`, `skipped_ticks`, `abandoned_runs`} og en rate-begrenset logglinje. Tester: `wpg3-vision-db-limits` 6 (ny), `wpg3-vision-runtime-db` 10→19. Tabell-lås som hengning: lett og full kjøring feiler med «lock timeout» i stedet for å henge. | 20 mutanter. W8 overlevde først og ble felt etter en ny test. |
| 5 | B LOW-E3: `purgeStaleTemp` gikk hele roten (`lost+found` ga permanent `failed:1`) og avkortet stille ved 200 000 oppføringer. | `6939a051` | `purgeStaleTemp(olderThanMs, { prefix, maxEntries })` går nå kun `snapshots/`. Avkorting er synlig: `truncated` gir `temp_files_truncated` i status og logglinjen `vision_temp_purge_truncated`, uten å bli en sveipefeil. `g3-storage-hardening` 12→18 (`lost+found`-lignende mappe med chmod 000, avkorting på/over/under grensen), `g3-lifecycle` +1. | 12 mutanter. |
| 6 | B LOW-E4: mutant F22. `$`-ankeret fantes allerede, så fiksen er bare en test. | `6939a051` | Fem gamle navn som starter som temp-filer men ikke er det (`.bak`, `-1`, `x`, 13 hex-tegn, store hex-tegn) skal stå. | F22 og F22b felt. |
| 7 | INFO docs | `7388d9ea` | DPIA §6.10 presisert: «nøyaktig samme kodepunkter» gjelder 135 og 133 sammen med en bokstav, ikke 133 alene (9 459 kodepunkt, ett-veis og uskyldig). §6.21 og runbook §2: foreldremapper blir også 0700 (rekursiv mkdir; B målte `x/y/z` = 700). Dessuten: temp-sveip kun `snapshots/`, vedlikeholdsvakt, nye statusfelt, overlappvakt per prosess, runbook §9 testtall. | – |

Til sammen 65 mutanter, alle felt, kjørt med `timeout -k 5`, `--bail=1` og 2 workers.

## Testtall og porter
- **Statisk:** typecheck alle pakker, lint og `check:containment`, alle exit 0.
- **Vaktbatch som `postgres`:** 290 filer / 4 761 tester, 4 758 grønne og de 3 kjente `wpc3-review1-hardening` F10a/b/c. For at `--bail=1` ikke skulle stoppe batchen ved de kjente feilene ble den filen kjørt separat: 289 filer / 4 716 tester grønne med bail, og den filen alene 42 grønne / 3 røde, identisk med forrige runde. Forrige batch: 289 filer / 4 723 tester, så +38 tester og +1 fil.
- **G3-filer (nå, forrige i parentes):** `g3-label-locale` 28 (21), `g3-storage-hardening` 18 (12), `g3-pure` 32 (31), `g3-migrations` 29, `g3-pipeline` 28, `g3-lifecycle` 23 (22), `g3-ha-pipeline` 7 (6), `g3-poller` 17 (15), `g3-guards` 39, `wpg3-vision-runtime` 84, `wpg3-vision-routes` 26 (25), `wpg3-vision-runtime-db` 19 (9), `wpg3-vision-db-limits` 6 (ny), `d388-connectors-v2` 32 (29).
- **Hemmeligheter:** gitleaks 8.24.3 over `c0981991..HEAD` (6 commits): no leaks found.
- **Full suite er ikke kjørt.**

## Avvik og merknader
1. Punkt 6 er bare en test, fordi ankeret fantes. Alle F22-lookalikes er nye.
2. Punkt 4 er gjort som både databasegrenser og starttid-vakt, siden en vakt uten grenser kunne tømt poolen. Verdiene er konstanter, ikke nye env-variabler. `VisionRuntimeDeps.maintenance` er en testinjeksjon. Hele visjonskjøretiden bruker nå den begrensede poolen, som er gjennomsiktig utenfor `runWithDbLimits`.
3. `inventory_skipped` og `PollSummary.inventory_label_*` er satt bare når > 0, så eksisterende former er uendret. Nye påkrevde statusfelt: `ingest`, `maintenance.light_run`, `temp_files_truncated`.
4. Bonus (A INFO-E7a): `poller.ts` `codeOf` skiller nå `db_` fra `os_`.
5. Ikke gjort: A INFO-E6 (nøstede HA-hemmeligheter, `user:pass@` i URL), A INFO-E4 (bare lead kan bekrefte at ingen varig DB har kjørt tidligere 133–136-varianter), B INFO-E7.
6. Testkjøringer etterlater `jarvis-vision-*`-mapper i `/tmp` (rundt 1 500 siden første runde, ingen `rm -rf` brukt). Reviewer B sine `/tmp/jarvis-revb3-many-*` er ikke rørt. Ingen mapper med modus 000 er igjen.

## D-465, én linje per endring
1. `labels.ts`: `isStorableObjectLabel` teller ord og trimmer på ASCII-mellomrom.
2. `label-sweep.ts`, `g3-label-locale`, `g3-migrations`, `g3-pure`: nye sveip, eksplisitte strenger og fuzz.
3. `home-assistant-transport.ts`: eksplisitt `SECRET_NAMES`, bar `auth`, utvidede egenskapsord.
4. `pipeline.ts`: `InventorySkips`, `inventory_skipped`, `stats()` og `vision_inventory_skipped` etter commit.
5. `poller.ts`: summerer hopp i `merge()`, og `codeOf` fikset.
6. `vision-routes.ts`: nye felt `ingest`, `light_run`, `temp_files_truncated` og `inventory_skipped` i upload-svaret.
7. `vision-db-limits.ts` (ny) og `vision-runtime.ts`: begrenset pool, vakt (30 min, maks 2 forlatte), synlige hoppede tikk.
8. `storage.ts`, `snapshots.ts`, `sweep.ts`: temp-sveip kun `snapshots/`, synlig avkorting.
9. `g3-storage-hardening`: F22-lookalikes.
10. DPIA §6.10/§6.16/§6.21 og runbook §2/§4/§9.

**Push:** ett forsøk mot `origin`, avvist med 503 («credential service temporarily unavailable»). Ikke gjentatt. Alle 6 commits ligger kun lokalt.

**Logger:** `/tmp/lead/logs/g3-mr3-*.log` (static-gate, guard-batch, wpc3-known, mutations-*, secret-scan, docs-sensitive). Reproduksjonsskript ligger i `/tmp/claude-0/-home-user-jarvisbuild/f781b90f-9fc6-545a-b2ea-055acc984b23/scratchpad/mr3/` (`genspecs_1.py`–`genspecs_5.py`, `runmut3.sh`, `static3.sh`).
