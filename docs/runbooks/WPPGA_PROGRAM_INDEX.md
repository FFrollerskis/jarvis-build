# WP-PGA: programindeksen (PG1), programportene og ORL (PG3) og feilkode-registeret (DX0)

**Status:** BUILT_UNWIRED. Ingen kjøretidskode importerer programmodulen (testen `program-index-repo.test.ts` vokter det), ingen migrasjon, ingen nye pakker, ingen endringer under `.github/`.
Vakten står i modus **report** (funn skrives ut, men feiler ikke bygget). Å slå på håndhevelse er én verdi (§5). HF6 §24 er **ikke adoptert** som styrende (ADR-001, Q-43): indeksen er et
nytt, separat dokument og endrer ikke `docs/CANONICAL_SPEC.md`.

## 1. Hva dette er (og ikke er)

- En **maskinlesbar indeks over programmets komponenter** (hvem eier hvilken tabell, migrasjon, kontraktfil, hendelsestype, compose-tjeneste og katalog), en **skanner** som finner dobbelt eierskap,
  uavhengige duplikater og utdaterte påstander, og en **modus-bryter** som lar eieren innføre håndhevelse uten ny kode.
- **Programportene** (17 stk.) og **Operational Readiness Levels** (ORL0-ORL5) som data: alle står `OPEN` i dag. En port kan bare stå `PASS` med gjenverifiserbar evidens, og åpnes igjen av seg selv
  når en bundet komponents kontrakt endres etter evidensen.
- **Feilkode-registeret** (DX0): stabile koder `NAVNEROM.NAVN` i `packages/contracts/src/error-codes.ts`, med mapping fra eksisterende årsaksstrenger.
- Det er **ikke** en kjøretidstjeneste, ikke et styringsvedtak og ikke en erstatning for beslutningsloggen. Indeksen sier hva som finnes; den bestemmer ingenting.

## 2. Filene

| Sti | Innhold |
| --- | --- |
| `config/program/manifest.json` | Planversjoner og adopsjonsstatus, dekningsroter, modus (`guard.mode`), eksklusive navn, reserverte prefikser, regelen mot ACTIVE-tilstand i læringstabeller. |
| `config/program/components/<id>.json` | **Én fil per komponent** (sharding: parallelle pakker berører ulike filer, ingen delt JSON å konflikte i). |
| `config/program/gates/G01.json ... G17.json`, `config/program/orl/ORL0.json ... ORL5.json` | Portene og nivåene (tittel, eget bestå-kriterium, bundne komponenter, status, evidens, historikk). |
| `config/program/baseline.json` | Kjente brudd. Kan bare krympe (§5). Tom i dag. |
| `packages/contracts/src/program/*` | Skjema (Zod), SQL-lesing, skanner, baseline, porter, lasting, verktøy. **Ikke** eksportert fra `@jarvis/contracts`. |
| `packages/contracts/scripts/program-index.ts` | Kommandolinjen (§3). |
| `ops/acceptance/record-gate-evidence.mjs` | Inngang for porteregistrering (§6), samme mønster som `record-evidence.mjs`. |

Skjemaet (`schema.ts`) er `.strict()`: et ukjent felt er en feil. Eier er alltid en **rolle** (`owner` eller `platform_operator`), aldri et personnavn; dette er et offentlig repo.

## 3. Kommandoer

Kjøres fra repo-roten (`node --experimental-transform-types`, som øvrige skript):

```
node --experimental-transform-types packages/contracts/scripts/program-index.ts report [--json] [--max <n>]
node --experimental-transform-types packages/contracts/scripts/program-index.ts index
node --experimental-transform-types packages/contracts/scripts/program-index.ts fingerprint [<id>...] [--write] [--bump patch|minor|major]
node ops/acceptance/record-gate-evidence.mjs <G01..G17|ORL0..ORL5> <PASS|FAIL|OPEN> --reason "tekst" --by <owner|platform_operator> [--evidence docs/evidence/<fil>.md] [--write]
```

`report` gir exit 1 ved rød dom. `fingerprint` er en tørrkjøring uten `--write` (exit 1 ved avvik). `gate` er en tørrkjøring uten `--write`. Felles valg: `--root <mappe>`.

**Porteregistrering skal gå via `ops/acceptance/record-gate-evidence.mjs`**: den slipper kun `gate` igjennom, kjører uten skall og nekter en `--reason` som ligner en hemmelighet eller har skjulte tegn (samme redigering som `record-evidence.mjs`; begrunnelsen havner i en committet fil i et offentlig repo). `program-index.ts gate` direkte har ikke den sjekken.

## 4. Slik legger du til eller endrer en komponent

1. Lag/rediger `config/program/components/<komponent-id>.json` (id på formen `familie.navn`, filnavnet må være `<id>.json`). Bruk en eksisterende skjerv som mal.
2. **Én eier per tabell.** Ny tabell: legg den i `state_store.tables` hos nøyaktig én komponent, og kreve migrasjonsfilen i `state_store.migrations`. En migrasjon som endrer en annen komponents tabell
   må også kvitteres av den komponenten (en kontraktendring uten indeksendring er et funn).
3. **Kontrakt:** `contract.files` er filene hvis innhold definerer kontrakten (for en modul: `src/index.ts`). Etter en endring: `fingerprint <id> --write [--bump minor]`, som oppdaterer
   fingeravtrykk og `changed_at`, og en kontraktendring øker `contract.version`.
4. **Planlagt arbeid** står som `runtime_state: "planned"` uten tabeller/migrasjoner; tabeller som ikke finnes ennå står i `planned_tables`. Pågående pakker føres i `pending_work` uten antatte detaljer.
5. Kjør `report`. Funn er konkrete (regel og emne) og peker på hva som må rettes.

Skannerreglene (`SCAN_RULES`, 30): `plan_unknown`, `plan_active_conflict`, `decision_ref_missing`, `path_missing`, `table_orphan`, `table_multi_owner`, `table_unknown`, `planned_table_exists`,
`planned_table_multi_owner`, `runtime_table_conflict`, `migration_duplicate_create`, `dir_uncovered`, `service_orphan`, `service_multi_owner`, `service_unknown`, `migration_unclaimed`,
`migration_unknown`, `migration_not_acknowledged`, `contract_file_unclaimed`, `contract_fingerprint_mismatch`, `event_multi_owner`, `event_consumer_unknown`, `dependency_unknown`,
`dependency_unsatisfied`, `dependency_on_planned`, `workspace_dependency_undeclared`, `exclusive_name_violation`, `reserved_prefix_violation`, `active_state_in_learning_table`, `evidence_invalid`.
Portregler: `gate_set_incomplete`, `gate_unknown_component`, `gate_stale`, `gate_evidence_invalid`, `gate_prerequisite_violation`. Lastingen gir `data_invalid`, `stray_file`, `shard_filename_mismatch`.
Funn-id er `<regel>:<emne>`.

## 5. Modus og baseline (rapport først, så håndhevelse)

- `guard.mode` i `manifest.json` er `report` (standard) eller `enforce`. Miljøvariabelen `PROGRAM_INDEX_MODE` kan **bare stramme inn**: `enforce` vinner alltid, `report` kan aldri svekke et
  `enforce`-manifest. En ugyldig verdi (typo, annen casing, blanke) er et brudd (exit 1), aldri en stille `report`.
- **Report:** nye funn skrives ut og feiler ikke. **Enforce:** funn utenfor baselinen feiler bygget.
- **Rød i begge moduser:** ugyldige/løse/feilnavngitte datafiler, ufullstendig portsett, **baseline-vekst** (en oppføring som ikke står i den frosne `BASELINE_ORIGIN` i `src/program/baseline-origin.ts`) og
  **foreldede baseline-oppføringer** (bruddet er rettet, men oppføringen står igjen). Baselinen kan derfor bare krympe, og vekst krever en bevisst endring i to filer med en navngitt beslutning.
- Å slå på håndhevelse: sett `guard.mode` til `enforce` (én verdi), evt. kun lokalt `PROGRAM_INDEX_MODE=enforce`.
- **CI-kobling er en eierhandling** (ingen `.github/`-endring i denne pakken): legg `node --experimental-transform-types packages/contracts/scripts/program-index.ts report` til som steg, og
  `PROGRAM_INDEX_MODE=enforce` når eieren har besluttet håndhevelse. Testene `program-index-*.test.ts` kjører allerede med den vanlige vitest-kjøringen.

## 6. Porter og ORL

- Status: `OPEN`, `PASS`, `FAIL`. **PASS krever en `evidence_ref`:** sti under `docs/evidence/`, sha256 av filen, git-SHA koden stod på, tidspunktet evidensen ble til (`verified_at` og kilden
  `evidence_header`/`flag`/`registration_time`) og et øyeblikksbilde av de bundne komponentenes kontraktfingeravtrykk. Evidensfilen lages med `ops/acceptance/record-evidence.mjs`.
- **Foreldelse (staleness):** den effektive statusen er `OPEN` igjen hvis evidensfilen mangler eller har endret hash, en bundet komponents `changed_at` er **senere** enn `verified_at`, dens fingeravtrykk
  avviker fra øyeblikksbildet, eller et øyeblikksbilde mangler. Skanneren melder `gate_stale` / `gate_evidence_invalid`; tellingene i rapporten bruker den effektive statusen.
- **Registrering:** `record-gate-evidence.mjs ... --write` legger til én `OperationalGateChanged`-nyttelast i `history` (append-only, ubrutt kjede) og setter `status`/`evidence_ref` i den ene filen
  (atomisk skriving). Den nekter blant annet: uendret status, evidens utenfor `docs/evidence/`, symlenke, fil over 1 MB, evidens **eldre enn en bundet komponents siste kontraktendring**, kontraktfiler
  som er endret uten oppdatert fingeravtrykk, og ORL-PASS der en forutsetning ikke står som PASS nå. Evidensfilens innhold er ubetrodd: kun den faste toppteksten leses, resten hashes.
- **Foreldet PASS:** gjenåpne først (`... OPEN --reason "foreldet etter kontraktendring" --write`), ta ny evidens, og registrer `PASS` på nytt: to forståelige overganger i historikken.
- ORL-nivåene er kumulative (`requires_orl`, `requires_gates`). Hendelsen `OperationalGateChanged` er kun en **typekontrakt** (`contract_only`): ingen produsent eller konsument finnes ennå.
- Mange porter har `external: true`: de krever NAS-kjøring, pilot eller eier-signoff som ikke kan kodes i repoet. Disse står `OPEN` til evidens finnes.

## 7. Feilkode-registeret (DX0)

- Koder har formen `NAVNEROM.NAVN` i elleve navnerom (`AUTH_TENANT`, `SECRET_IDENTITY`, `MODEL_ROUTING`, `TOOL_CONNECTOR`, `DB_DATA`, `WORKER_INFRA`, `MEMORY_RETRIEVAL_EXPERT`, `LEARNING_EVAL`,
  `VOICE_DEVICE_UI`, `FINANCE_SIDE_EFFECT`, `SECURITY`). Hver kode har eier (en komponent-id i indeksen), alvorlighet, gjentakbarhet og status. En kode endres eller fjernes aldri; den utfases
  (`deprecated` med `replaced_by`).
- `legacy` kobler eksisterende årsaksstrenger (policy-journal, verifisereren, migratoren m.fl.) til kodene. Testen `error-codes.test.ts` har en fastlåst snapshot (stabilitet), en lint (format, duplikater,
  de 59 eksemplene fra planen) og en **driftvakt** som leter etter at hver kartlagt streng fortsatt finnes i kilden; den følger samme modus som resten (report skriver ut, enforce feiler).
- Legge til en kode: legg den til i `error-codes.ts`, kartlegg evt. eksisterende årsaksstrenger, oppdater snapshotet bevisst i samme commit.

## 8. Sikkerhet og flater

- **Lesing:** `fs-loader.ts` er den eneste modulen som leser filsystemet (kun vanlige filer, ingen symlenker, 1 MB-tak for JSON og 8 MB for hashede filer, kun repo-relative stier).
- **Skriving:** kun `fingerprint-tool.ts` (komponentskjerver) og `gate-recorder.ts` (port-/nivåfiler): én fil per endring, validert mot skjemaet først, atomisk (midlertidig fil + rename).
- Ingen nettverk, ingen databasetilgang, ingen hemmeligheter, ingen runtime-flagg. Ingen personnavn eller selskapsnavn i dataene (offentlig repo); eier er en rolle.

## 9. Kjente grenser

- SQL-lesingen ser `CREATE`/`ALTER`/`DROP`/`RENAME` etter at kommentarer og strenger er blankt ut (inkl. dollar-siterte blokker). **Dynamisk SQL** (`EXECUTE format(...)`) er usynlig; repoet bruker hjelpefunksjoner
  i migrasjonene 078-080 som skanneren ikke ser inni.
- Eksklusive navn og reserverte prefikser er **navnebaserte** (prefiks + understrek), ikke semantiske. Tre eksisterende tabeller har ordet «commitment» i navnet (`commitments`, `comms_meeting_commitments`,
  `finance_recurring_commitments`) og flagges ikke; forholdet til den planlagte forpliktelseskomponenten må avklares med en navngitt beslutning før den bygges (notat på `jx.commitments`).
- Kolonnenavn sjekkes ikke mot eksklusive navn: et `*_id`-felt er normalt en referanse til sannhetskilden.
- Hemmelighetssjekken av `--reason` er et mønsterfilter (som evidens-opptakeren): en hemmelighet uten kjent form og uten nøkkelord fanges ikke. Les begrunnelsen før den committes.
- Kontraktfingeravtrykk dekker bare filene som er listet i `contract.files`. Endringer andre steder (f.eks. en delt hjelper) fanges ikke.
- Pakker under bygging (S1, T1, MC8a, SEC2, OPS2a) er ført som `planned`/`pending_work` uten antatte detaljer; indeksen oppdateres når de er flettet.

## 10. Verifisering

```
pnpm exec vitest run packages/contracts/test/error-codes.test.ts packages/contracts/test/program-index-*.test.ts ops/acceptance/test/record-gate-evidence.test.mjs
PROGRAM_INDEX_MODE=enforce pnpm exec vitest run packages/contracts/test/program-index-repo.test.ts
node --experimental-transform-types packages/contracts/scripts/program-index.ts report
```

## 11. Eierhandlinger og forslag (ikke utført her)

1. Beslutte når `guard.mode` skal bli `enforce`, og legge `report` inn som CI-steg.
2. Forslag til tillegg i `docs/remediation/ADR-001-dokumenthierarki.md` og en D-tekst: programindeksen som eget, ikke-styrende dokument inntil HF6 §24 er adoptert.
3. Forslag (ikke utført): legg `config/program/` til i selvmodifikasjonens forbudte stier, slik at selvendring ikke kan skrive til indeksen.
4. Avklare de tre «commitment»-tabellene (§9) før den planlagte forpliktelseskomponenten bygges.
