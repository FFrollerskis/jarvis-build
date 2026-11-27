# WP-MC8a: schemaklassifisering, migrasjonslint og negativ org-A/B-fixture (HF3 MC-8 del a)

**Status (2026-11-26): BYGGET OG TESTET MOT EKTE (EMBEDDED) POSTGRES - IKKE KJØRT MOT NAS-en, INGENTING ER `VERIFIED`.**
Branch `claude/wp-mc8a-schema-classification` (base `main` = `a5ef98b3`). Beslutning: føres i beslutningsloggen av lead/arkitekt (forslag i §11); denne grenen rører ikke `DECISIONS_AND_ASSUMPTIONS.md` eller andre delte dokumenter.
`CORE_DEPENDENCY_DECISION_REQUIRED=false` (ingen leverandør, ingen connector; D-64 uberørt). **Migrasjon: ingen. Flagg: ingen. Runtime-kode: uendret** (kun verktøy og tester). `.github/` er ikke rørt (beskyttet sti): CI-kobling er en senere eierhandling (§9).
Statusord: LUKKET HER / PARTIAL / DEFERRED / NOT VERIFIED / BLOCKED_EXTERNAL.

## 1. Oversikt

| Krav | Status | Kode | Test |
|---|---|---|---|
| K1 klassifiseringsmodell (frosset baseline + annotasjon i nye migrasjoner) | LUKKET HER | `modules/core/src/db/schema-classes.baseline.json`, `modules/core/src/testing/schema-classes/{directives,manifest,analysis}.ts` | `mc8a-schema-classes-static.test.ts` (62), `mc8a-schema-classes-db.test.ts` (4) |
| K2 lint-regler per klasse (ORG_OWNED/USER_OWNED/GLOBAL/PLATFORM, DEFINER-allowlist) | LUKKET HER | `schema-classes/{catalog,rules,run}.ts` | samme + mutantene |
| K3 utvid, ikke dupliser; `pnpm check:schema-classes` | LUKKET HER | rotens `package.json`, `modules/core/scripts/check-schema-classes.ts`; `remediation-2-schema-invariants.test.ts` A og B leser nå manifestet | `remediation-2-schema-invariants.test.ts` (22), CLI-tester i static-filen |
| K4 negativ org-A/B-fixture | LUKKET HER (173 av 173 ORG_OWNED atferdsbevist, 0 kun katalogbevist; se §7) | `schema-classes/isolation.ts`, `test/fixtures/isolation-factories/` | `mc8a-tenant-isolation-matrix.test.ts` (7) |
| K5 funn uten stille fiks | LUKKET HER (5 funn i baseline; ingen skjemaendring, §8) | manifestets `exceptions` | `mc8a-schema-classes-db.test.ts` |
| K6 mutanter (minst 25) | LUKKET HER (54 skjema-mutanter: 54 drept av linten, 13 også av atferdsharnisken, 0 overlevende; i tillegg 36 kodemutanter av biblioteket selv, §9b) | - | `mc8a-schema-class-mutants.test.ts` (56 tester inkl. 2 kontroller) |
| K7 runbook + forslag til byggeregler | LUKKET HER (dette dokumentet, §10) | `docs/runbooks/WPMC8A_SCHEMA_CLASSIFICATION.md` | `mc8a-schema-classes-doc.test.ts` |

## 2. Klassene og reglene

I Jarvis er organisasjon = tenant (D-21): en ORG_OWNED-tabell er en tenant-eid tabell med `tenant_id` (ingen ny `org_id`-kolonne). Hver tabell har NØYAKTIG én klasse.

| Klasse | Betydning | Hva linten krever |
|---|---|---|
| `ORG_OWNED` | rader tilhører én tenant | `tenant_id` NOT NULL, FK til `tenants` (direkte, eller sammensatt FK til en annen forankret ORG_OWNED-tabell), btree-indeks med `tenant_id` først, ENABLE + FORCE RLS, PERMISSIVE policy(er) for runtime-rollen som dekker SELECT/INSERT/UPDATE/DELETE (en `FOR ALL`-policy dekker alle fire), hver med `USING`/`WITH CHECK` strengt `tenant_id = current_setting('jarvis.tenant_id', ...)` og eksplisitt `WITH CHECK` |
| `USER_OWNED` | rader tilhører en person på tvers av tenants (i dag kun `people`) | ingen `tenant_id`; ENABLE + FORCE RLS; dekning for alle fire kommandoer; policyen refererer `jarvis.tenant_id` (medlemskap) eller `jarvis.person_id` |
| `GLOBAL` | delt, tenant-fri referanse-/bokføringsdata | ingen tenant-nyttelast (`tenant_id`, `person_id`, FK til `tenants`/`people`) uten `tenant-payload="<begrunnelse>"`; runtime-rollen kan KUN lese |
| `PLATFORM` | plattform-/eier-/infrastrukturtilstand | runtime-rollen (`jarvis_app`) har INGEN tilgang (ingen GRANT, heller ikke kolonne-GRANT eller via PUBLIC) |

Gjelder alle klasser: ingen `TRUNCATE`/`REFERENCES`/`TRIGGER` til runtime-rollen (TRUNCATE omgår RLS; REFERENCES er et eksistensorakel på tvers av tenants), runtime-rollen eier ingen tabell, kun ordinære tabeller i `public` (ingen visning/partisjon/fremmed tabell/annet skjema), ingen policy med `true` for en ikke-betrodd rolle. Skjemaomfattende: runtime-rollen og alle medlemmer er NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE/NOREPLICATION og kan ikke opprette objekter i `public`; hver `SECURITY DEFINER`-funksjon står på allowlisten (default deny), er eid av en rolle uten superuser/BYPASSRLS, har låst `search_path` (pg_catalog først, pg_temp sist) og ingen PUBLIC-EXECUTE.

Regel-ID-ene (stabile; brukes i unntak, meldinger og tester). *Struktur*-regler kan aldri ha unntak; *katalog*-regler på en tabell kan ha et begrunnet baseline-unntak (kun for frosne tabeller).

- Struktur: `manifest_invalid`, `unclassified_table`, `class_declared_twice`, `annotation_for_frozen_table`, `annotation_unknown_table`, `baseline_stale_table`, `baseline_grew`, `directive_malformed`, `unsupported_ddl`, `dynamic_create_table`, `static_db_mismatch`, `frozen_migration_changed`, `frozen_migration_missing`, `frozen_migration_added`, `migration_file_name_invalid`, `definer_directive_missing`, `definer_directive_unknown`, `exception_stale`.
- Katalog (kan ha baseline-unntak): `unmanaged_relation`, `app_dangerous_privilege`, `owner_is_runtime`, `policy_true`, `org_no_tenant_id`, `tenant_id_nullable`, `tenant_fk_missing`, `tenant_index_missing`, `rls_not_forced`, `policy_coverage_missing`, `policy_scope`, `policy_with_check_missing`, `user_has_tenant_id`, `user_policy_context`, `global_tenant_payload`, `global_app_write`, `platform_app_access`.
- Katalog (aldri unntak): `runtime_role_unsafe`, `runtime_create_in_public`, `definer_not_allowlisted`, `definer_allowlist_stale`, `definer_owner_privileged`, `definer_search_path`, `definer_public_execute`.

### Krav fra HF3 §9.2/§17.2 (D-MC-34) mot regler og tester

| Krav | Regler | Bevis |
|---|---|---|
| tenant-kolonne NOT NULL + FK + indeks | `org_no_tenant_id`, `tenant_id_nullable`, `tenant_fk_missing`, `tenant_index_missing` | mutantene M13-M16, N02 |
| ENABLE + FORCE RLS | `rls_not_forced` | M01, M02, N03 |
| policyer per kommando med WITH CHECK, ingen `true` | `policy_coverage_missing`, `policy_scope`, `policy_with_check_missing`, `policy_true` | M03-M12, M38, M43, N08 |
| ingen eier/BYPASSRLS som runtime | `owner_is_runtime`, `runtime_role_unsafe`, `runtime_create_in_public`, `app_dangerous_privilege` | M17-M24, M42 |
| tenant-kontekst server-side i transaksjonen | ikke en skjemaregel: `set_config(..., true)` i `withTenantTransaction`; harnisken setter kontekst på samme måte | `data-foundation.test.ts`, matrisen |
| SECURITY DEFINER default deny | `definer_*` | M25-M29, M41, N09 |
| negativ A/B-fixture | `assertTenantIsolation` | matrisen: 173 av 173 |
| PLATFORM uleselig for appen / GLOBAL uten tenant-nyttelast | `platform_app_access`, `global_*` | M30-M32, M39, M40, N04-N06, N11 |

## 3. Slik klassifiserer du en NY tabell

1. Gi migrasjonen et nummer OVER 148 (lead tildeler; filene ≤ 148 er frosset og sjekksum-låst: rediger dem aldri).
2. Skriv en `-- jarvis-class:`-linje i SAMME fil for hver `CREATE TABLE` (plain DDL, `snake_case`, skjema `public`; ingen `RENAME`, visninger, partisjoner eller `CREATE TABLE` via `EXECUTE`).
3. ORG_OWNED, komplett mal (alt under må være på plass; en FOR ALL-policy dekker alle fire kommandoer):

```sql
-- jarvis-class: org_example ORG_OWNED
CREATE TABLE org_example (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants (tenant_id),
  payload     text NOT NULL DEFAULT ''
);
CREATE INDEX org_example_tenant_idx ON org_example (tenant_id);
ALTER TABLE org_example ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_example FORCE ROW LEVEL SECURITY;
CREATE POLICY org_example_tenant ON org_example
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON org_example TO jarvis_app;  -- kun det tabellen trenger; aldri TRUNCATE/REFERENCES/TRIGGER
```

   Tabeller med minnerom legger i tillegg en RESTRICTIVE `..._space`-policy (som 008/017/019 gjør). Én policy per kommando (separate SELECT/INSERT/UPDATE/DELETE) er også gyldig så lenge hver er strengt tenant-avgrenset og INSERT/UPDATE har eksplisitt `WITH CHECK`.
4. GLOBAL (kun lesing for appen), PLATFORM (ingen GRANT til `jarvis_app`) og USER_OWNED følger tabellen i §2. En GLOBAL-tabell som med vilje bærer tenant-nyttelast annoteres `-- jarvis-class: <tabell> GLOBAL tenant-payload="<begrunnelse, minst 10 tegn>"`.
5. Ny `SECURITY DEFINER`-funksjon: `-- jarvis-definer: <navn>(<argumenttyper>) reason="<begrunnelse>"` i samme fil, eid av `jarvis_definer`, `SET search_path = pg_catalog, public, pg_temp`, `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE` kun til de som trenger det (mønster: 064/073/108). Signaturen er Postgres' kanoniske tekst (`text`, `integer`, `text[]`).
6. Kjør `pnpm check:schema-classes --static` (sekunder, ingen database), deretter DB-testene (§6).
7. Policyer som slår opp en foreldrerad (som `incident_diagnosis_evidence`) trenger en rad-fabrikk, ellers feiler A/B-matrisen med «kontroll-insert feilet»: legg `export const iso: Record<string, RowFactory> = { ... }` (relaksert fixture-DB) eller `export const strict = { ... }` (streng DB med ekte constraints) i `modules/core/test/fixtures/isolation-factories/<pakke>.ts` (EN fil per pakke - ingen delt fil, ingen flettekonflikt).
8. Erasure-dekning (`d395-erasure-coverage`) for nye tenant-tabeller gjelder som før.

Unntak for en NY tabell finnes ikke: et brudd rettes i migrasjonen (testet av N06/N10: selv et unntak som matcher bruddet nøyaktig avvises som `manifest_invalid`).

## 4. Annotasjonsformatet

```
-- jarvis-class: <tabell> <GLOBAL|USER_OWNED|ORG_OWNED|PLATFORM> [tenant-payload="<begrunnelse>"]
-- jarvis-definer: <navn>(<typer>) reason="<begrunnelse>"
```

- Linjekommentar (`--`) på toppnivå i samme migrasjonsfil som oppretter tabellen/funksjonen; én linje per tabell/funksjon; klassen med STORE bokstaver; `public.`-prefiks er tillatt; begrunnelser har minst 10 tegn; `tenant-payload` kun for GLOBAL.
- En linje som ligner (`-- jarvis-class` uten kolon, `jarvis_class:`, ukjent klasse, annet skjema, rester etter linjen) er `directive_malformed` - aldri stille ignorert.
- Direktiver i filer ≤ 148 leses ikke (de er frosset); en annotasjon for en frossen tabell er `annotation_for_frozen_table`.

## 5. Baseline-manifestet (`modules/core/src/db/schema-classes.baseline.json`)

Frosset gjennom migrasjon 148 (`frozen_through_migration`): **183 tabeller** = 173 `ORG_OWNED` + 1 `USER_OWNED` (`people`) + 2 `GLOBAL` (`capabilities`, `schema_migrations`) + 7 `PLATFORM`. `schema_migrations` opprettes av migratoren selv (`bootstrap_tables`), ikke av en `.sql`-fil. Filen er generert fra et migrert skjema (katalogutdrag + klasseheuristikk: `tenant_id` + FORCE RLS = ORG_OWNED, RLS uten `tenant_id` = USER_OWNED, resten håndgjennomgått) og deretter håndgjennomgått; hver ikke-opplagt klasse har et notat (`class_notes`).

- `frozen_migrations`: SHA-256 per frosne migrasjonsfil (121 filer), samme sjekksum som migratoren (CRLF normalisert). CI ser dermed en redigert gammel migrasjon (`frozen_migration_changed`), en fjernet (`frozen_migration_missing`) og en innsatt i den frosne rekken (`frozen_migration_added`) - migratoren ser det kun på en database som allerede har anvendt filen.
- `definer_allowlist`: de 6 eksisterende DEFINER-funksjonene med begrunnelse (nye annoteres i sin migrasjon).
- `exceptions`: de 29 KJENTE bruddene i dag (§8), hver med regel + tabell + presis detalj + begrunnelse + funn-ID. Et unntak må matche et FAKTISK brudd nøyaktig, og et unntak som ikke lenger brytes SKAL fjernes (`exception_stale`).
- **Baseline kan bare krympe:** `exception_ceiling` (totalt og per regel) kan ikke overskrides (`manifest_invalid`), tabeller fra nye migrasjoner kan aldri stå i baseline (`baseline_grew`) eller ha unntak, og en droppet tabell må fjernes (`baseline_stale_table`).
- Ingen regenereringsbryter (som `JARVIS_UPDATE_SCOPE_FK_BASELINE`) finnes bevisst: manifestet endres kun for å FJERNE oppføringer (når et funn er rettet i en ny migrasjon) - da senkes `exception_ceiling` i samme commit. Å heve taket eller legge til en tabell er en synlig, bevisst endring som arkitekten må se.
- `scope-fk-baseline.json` er uendret og TOM (testet av remediation-2 D).

`remediation-2-schema-invariants.test.ts` leser nå DEFINER-allowlisten (A) og listen over tabeller uten RLS-plikt (B, = GLOBAL/PLATFORM) fra manifestet i stedet for to håndholdte lister. Semantikken i B er justert slik at en GLOBAL/PLATFORM-tabell MED RLS er lov (ekstra vern): hver tabell uten FORCE RLS må være klassifisert GLOBAL/PLATFORM og bære ingen `tenant_id`; «tabell med RLS som står i unntakslisten» er ikke lenger en feil. C og D er uendret. `d395-erasure-coverage` er uendret (erasure er en annen dimensjon enn klasse).

## 6. Kjøre lokalt

Alle DB-kommandoer MÅ kjøres som en vanlig bruker (embedded Postgres nekter root). Node 22; se BUILD-RULES §2 for miljøvariabler.

```bash
pnpm check:schema-classes --static     # kun filer + manifest + annotasjoner (ingen DB; også som root); ca. 1 s
pnpm check:schema-classes              # statisk + katalogsjekk mot en MIGRERT embedded Postgres (ca. 4 s); exit 0 grønt, 1 brudd, 2 kunne ikke kjøre
pnpm check:schema-classes --verbose    # lister også de kjente baseline-unntakene; --json for maskinlesbar rapport
pnpm exec vitest run modules/core/test/mc8a-schema-classes-static.test.ts    # 62 tester, ingen DB
# som postgres-bruker (DB):
pnpm exec vitest run --maxWorkers=2 modules/core/test/mc8a-schema-classes-db.test.ts modules/core/test/mc8a-tenant-isolation-matrix.test.ts modules/core/test/mc8a-schema-class-mutants.test.ts
```

Katalogreglene kan ikke kjøres statisk: RLS settes i de gamle migrasjonene via `EXECUTE format(...)`-løkker i DO-blokker, så kun et migrert skjema forteller hva som faktisk gjelder. `--static` er forhåndssjekken (klassifisering, annotasjoner, frosne filer, baseline-invarianter); som root uten `--static` avslutter kommandoen med kode 2 og en klar melding i stedet for å hoppe over katalogsjekken.

## 7. Negativ org-A/B-fixture (K4)

`assertTenantIsolation(env, tabell, fabrikk?)` (`@jarvis/core/testing`) seeder to tenants (A, B) og beviser med runtime-rollen (et LOGIN-medlem av `jarvis_app`, NOSUPERUSER/NOBYPASSRLS, aldri en superbruker), hver gang med en KONTROLL (egen tenant virker) så beviset ikke er vakuøst:

| Operasjon | Angrep som må feile | Kontroll |
|---|---|---|
| `read` | under kontekst A: 0 B-rader (filtrert og ufiltrert telling), og omvendt B->A | egne A-rader er synlige |
| `noContext` | uten tenant-kontekst: 0 rader synlige, og insert avvist av RLS | - |
| `insert` | en B-rad under kontekst A avvises av RLS (`row-level security`) | en egen A-rad godtas |
| `update` | `UPDATE ... WHERE tenant_id = B` endrer 0 rader | A-rader kan oppdateres |
| `updateMove` | `UPDATE SET tenant_id = B` (uten WHERE) avvises av WITH CHECK | - |
| `delete` | `DELETE ... WHERE tenant_id = B` sletter 0 rader | A-rader kan slettes |

Uten WHERE i flytte-angrepet fordi Postgres legger SELECT/ALL-policyens `USING` på den nye raden så snart en UPDATE har en WHERE som leser kolonner - det skjuler et manglende eller for vidt `WITH CHECK` (funnet under bygging, mutant M04). Har runtime-rollen ikke GRANT for en operasjon, rapporteres den som `denied_by_grant` (ærlig: ingen RLS-bevis for akkurat den delen; typisk append-only-tabeller). Unik-brudd på kontroll-insert er bevis for at RLS slapp raden gjennom (WITH CHECK evalueres før indeksinnsetting; tabeller med én rad per tenant).

**Radene:** lages automatisk fra katalogen (NOT NULL-fyll, `tenant_id`, minnerom-kolonne fra RESTRICTIVE-policyen) mot en KORTLIVET fixture-database der de 778 CHECK- og 438 FK-constraintene er droppet og de 43 brukertriggerne er slått av (`stripForIsolation`; triggere som leser `jarvis.tenant_id`/`jarvis.memory_spaces` ville holdt seg PÅ: ingen finnes i dag, og de avslåtte leser kun erasure-flagget `jarvis.erasure_in_progress`). RLS, policyer, GRANT, eierskap, FORCE og DEFINER er uberørt: `fingerprintRls` beviser at fingeravtrykket er IDENTISK med den strenge databasen (testet). 11 tabeller bevises i tillegg mot den STRENGE databasen med ekte, gyldige rader og alle constraints (`isolation-factories/real-rows.ts`), og samme tabeller gir samme utfall i fixture-databasen.

**Dekning (matrisen skriver tallene ut i `[mc8a-iso]`-linjene):** ORG_OWNED-tabeller 173 -> atferdsbevist 173 (161 auto-syntetisert, 1 forelder-fabrikk i fixture-DB, 11 fabrikk mot streng DB), kun katalogbevist 0; alle seks bevis `proven` for 115; 58 tabeller har minst én operasjon avvist av GRANT (listet i utskriften). `people` (USER_OWNED) har egen test (lesing via medlemskap, ingen UPDATE/DELETE-GRANT, INSERT uten medlemskap er det dokumenterte unntaket F5). GLOBAL/PLATFORM: observert tilgang med runtime-rollen (SELECT/INSERT/UPDATE/DELETE-probe) må stemme NØYAKTIG med klassen og baseline-unntakene; de 7 PLATFORM-tabellene skrives ut som `KJENT ÅPEN (MC8a-F1)`. Tabeller fra NYE migrasjoner er med automatisk (matrisen leser klassene fra klassifiseringen); kun en policy som slår opp foreldrerader trenger en fabrikk (§3 punkt 7). Mangler et bevis for en tabell, feiler matrisen med tabellnavn og operasjon - det er ingen «grønn uten dekning».

## 8. Funn (K5): ekte hull i eksisterende skjema, registrert i baseline, IKKE rettet her

Ingen migrasjon i denne pakken. Lead tildeler nummer/pakke; forslagene er `NOT VERIFIED` mot NAS-databasen (tellinger må sjekkes der før en SET NOT NULL).

| Funn | Hva | Forslag (ny migrasjon) |
|---|---|---|
| `MC8a-F1` (7 tabeller, `platform_app_access`) | `owner_control_state`, `evolution_change_ledger`, `github_rate_limit_state`, `scheduler_state`, `self_modification_requests`, `situation_domain_pauses`, `telegram_poll_state` er PLATFORM-tilstand, men `jarvis_app` (rollen ALLE tjenester kjører som) har SELECT/INSERT/UPDATE/DELETE i ulike kombinasjoner (eksakt sett per tabell i manifestet). Enhver kodevei med tenant-kontekst kan lese/skrive dem; beskyttelsen er kun applikasjonskode (kill switch og frys er blant dem). | En egen plattform-DB-rolle (HF3 MC-5a) som tjenestene for disse tabellene kobler til med, deretter `REVOKE` fra `jarvis_app` per tabell og fjerning av unntaket (`exception_ceiling` ned). Til da: akseptert gjeld. |
| `MC8a-F2` (`tenant_id_nullable`) | `wallester_webhook_events.tenant_id` er nullable (webhook før tenant-ruting). Appen kan ikke sette inn NULL-rader (WITH CHECK) og NULL-rader er usynlige for alle policyer, så ingen lekkasje - men regelen brytes. | `ALTER TABLE wallester_webhook_events ALTER COLUMN tenant_id SET NOT NULL` etter pre-flight `count(*) WHERE tenant_id IS NULL = 0` (og `ON DELETE`-semantikk vurdert). |
| `MC8a-F3` (`tenant_fk_missing`) | `audit_events.tenant_id` har ingen FK til `tenants` (ulikt `cost_events`). Trolig for at append-only revisjonsbevis ikke skal blokkeres eller kaskaderes av tenant-sletting (erasure-baselinen kaller den `APPEND_ONLY_EVIDENCE`) - ikke bekreftet i dokumentasjonen. | Eierbeslutning: aksepter som design (da endres regelen eksplisitt, ikke baseline), eller `ADD CONSTRAINT ... FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) NOT VALID` + `VALIDATE` (blokkerer sletting av en tenant som har revisjonsrader). |
| `MC8a-F4` (19 tabeller, `tenant_index_missing`) | `approvals`, `artifacts`, `commitments`, `deadlines`, `decisions`, `device_enrollment_tickets`, `embeddings`, `family_events`, `goal_key_results`, `incident_diagnosis_evidence`, `incident_repair_tasks`, `knowledge_embeddings`, `memory_item_entities`, `memory_versions`, `organizations`, `person_tenants`, `projects`, `relations`, `rooms` har ingen btree-indeks med `tenant_id` først (oppslag går via nøkkel/forelder). Ytelse (RLS-filteret kan gi seq-scan), ikke isolasjon. | Én migrasjon med `CREATE INDEX <t>_tenant_idx ON <t> (tenant_id)` per tabell (migrasjoner kjører i en transaksjon, så ikke `CONCURRENTLY`; de store tabellene `embeddings`/`memory_versions` bygges i rolig tidsrom). |
| `MC8a-F5` (`policy_true`) | `people_via_membership` har `WITH CHECK (true)` (dokumentert D-364/Q-44): en tenant-kontekst kan opprette en person FØR medlemskapet finnes; raden er usynlig inntil medlemskap finnes. | Allerede kjent/akseptert; strammes sammen med identitets-/medlemskapsskjemaet (HF3 MC-2). |

Observasjon (ikke et funn mot en regel): append-only-triggerne (`audit_events`, `events`, `memory_versions`, finans-tabellene, comms-journalene) har en omgåelse via sesjonsinnstillingen `jarvis.erasure_in_progress` som enhver sesjon kan sette; det harde vernet er GRANT/RLS, ikke triggeren (relevant for HF3 MC-13 hash-kjedet revisjon).

## 9. NOT VERIFIED og kjente begrensninger

- **NOT VERIFIED mot NAS-databasen:** alt er kjørt mot embedded Postgres 16 med migrasjonene 001-148. Produksjonsrollen `jarvis_runtime` (medlem av `jarvis_app`) sjekkes av katalogsjekken kun hvis den finnes i databasen som sjekkes; eieren kjører `pnpm check:schema-classes`-logikken mot en restore av NAS-databasen som et senere trinn (mal: `ops/backup/nas-restore-verify.sh`).
- **CI-kobling gjenstår (eierhandling):** `.github/` er beskyttet og IKKE rørt (Actions er av). Foreslått steg etter «Containment invariants»: `pnpm check:schema-classes --static` (krever ikke DB), og katalogsjekken kjøres allerede av `pnpm test` (alle fem `mc8a-*`-filene; tre av dem starter embedded Postgres) på en ikke-root runner.
- Linten ser ikke minnerom-policyene (RESTRICTIVE `..._space`): intern minnerom-isolasjon innen en tenant dekkes av eksisterende tester (blant annet remediation-2 D4) og er ikke org-isolasjon.
- Statisk analyse forstår kun vanlig DDL (se §3 punkt 2); alt annet avvises i nye filer. Dynamisk tabelloppretting i en DO-blokk avvises (`dynamic_create_table`); katalogsjekken er sannheten uansett.
- «Atferdsbevist» betyr: bevist på en fixture-database uten datagyldighets-constraints (fingeravtrykk-identisk for RLS/GRANT) og, for 11 tabeller, også med ekte constraints. En ekte rad med uvanlig innhold kan i teorien oppføre seg annerledes i en trigger som leser tenant-innstillingen; slike triggere holdes PÅ av `stripForIsolation` (ingen i dag).
- Transitiv tenant-forankring: en tabell er `tenant_fk_missing`-fri også når `tenant_id` kun er forankret via en sammensatt FK `(tenant_id, ...)` til en forankret ORG_OWNED-forelder (bevisst; 7 tabeller i dag).
- Én intermittent, uavhengig observasjon: `remediation-2-device-revocation-session.test.ts` (urørt) kan melde en «Unhandled Rejection» (FATAL 57P01) ved nedstenging av embedded Postgres i noen kjøringer; testene i filen er grønne.

## 9b. Mutasjonstest av biblioteket selv (kodemutanter)

Utover de 54 skjema-mutantene (K6) er selve lint-/harnisk-koden mutasjonstestet manuelt: 36 enlinjes kodemutanter (f.eks. `OR` som `some` i `isTenantScoped`, DELETE ut av kommandokravet, FORCE ignorert, runtime-medlemmer ikke sjekket, partiell indeks godtatt, transitiv forankring fjernet, `<` i stedet for `<=` ved frosset grense, sjekksum ikke sammenlignet, direktivgrammatikk, nestede kommentarer, E-strenger, dollar-sitater, manifesttak/sortering, og alle seks bevis i A/B-harnisken). Første kjøring: 24 drept, 12 overlevende. Overlevende pekte på ni REELLE testhull (DELETE-dekning, skrivbar GLOBAL ved DELETE/UPDATE, `pg_temp` sist, kolonne-REFERENCES, kolonne-SELECT på PLATFORM, grensen ved 148, frossen tabell uten klasse, nestede kommentarer, asymmetrisk policy som kun lekker B->A) og et svakt utsagn (angreps-insert skulle melde LEKKASJE, ikke bare «avvist av noe annet»), som er lukket med nye tester (M38-M43, N11 og to statiske tester; `behaviorLeak` krever at harnisken melder LEKKASJE). Etter fiksen: **34 av 36 drept, 2 overlevende som er REDUNDANTE sjekker**: filtrert telling av B-rader og ufiltrert telling (`C28`, `C36`) oppdager nøyaktig de samme lekkasjene, så hver for seg er hver av dem unødvendig for alle skjema-mutantene; de er beholdt som forsvar i dybden. Skriptet ligger utenfor repoet (kjørt manuelt); mutantlisten og resultatet står i rapporten til bygger.

## 10. Forslag til tilføyelse i BUILD-RULES.md (§1, migrasjoner)

> **Ny tabell => klasseannotasjon.** Hver `CREATE TABLE` i en NY migrasjon (> 148) får `-- jarvis-class: <tabell> <ORG_OWNED|USER_OWNED|GLOBAL|PLATFORM>` i samme fil; hver ny `SECURITY DEFINER`-funksjon får `-- jarvis-definer: <signatur> reason="..."`. ORG_OWNED krever `tenant_id` NOT NULL + FK til `tenants` + indeks, ENABLE + FORCE RLS, strengt tenant-avgrensede policyer for SELECT/INSERT/UPDATE/DELETE med eksplisitt WITH CHECK og GRANT uten TRUNCATE/REFERENCES/TRIGGER (mal: `docs/runbooks/WPMC8A_SCHEMA_CLASSIFICATION.md` §3). Kjør `pnpm check:schema-classes --static` og de tre `mc8a-*`-DB-filene (`-db`, `-matrix`, `-mutants`; som postgres-bruker) før «ferdig»; baseline-unntak kan aldri utvides (nye brudd rettes i migrasjonen); policyer som slår opp foreldrerader trenger en fabrikk i `modules/core/test/fixtures/isolation-factories/<pakke>.ts`.

## 11. Forslag til beslutninger/spørsmål (lead fører dem)

1. D-forslag: skjemaklassifisering som obligatorisk port (§3); org = tenant (ingen `org_id`-kolonne); klassene og reglene i §2; baseline frosset gjennom 148 med unntak som bare kan krympe; annotasjon i migrasjonsfilen (ikke en delt JSON).
2. D-forslag: GLOBAL er skrivebeskyttet for appen (en skrivbar global tabell er en kryss-tenant-kanal); PLATFORM har ingen app-GRANT; kun ordinære tabeller i `public`.
3. D-forslag: tenant-isolasjon bevises atferdsmessig for HVER ORG_OWNED-tabell (A/B-matrisen) og et katalogbevis (lint) - ingen tabell kun på policytekst.
4. Q-forslag: F1 (plattform-DB-rolle, MC-5a), F3 (FK på `audit_events`: design eller hull?), F4 (indekser: egen migrasjon).
5. Ledger-forslag: DA7 `PARTIAL` -> `BUILT_WIRED` for lint/manifest/matrise (DORMANT som CI-port inntil eieren kobler `pnpm check:schema-classes` inn); DA8 `PARTIAL` (matrisen finnes og kjører i `pnpm test`; navngitt akseptansematrise for secret/cache/session gjenstår i MC-8b).

## 12. Tilbakerulling

Ingen migrasjon, ingen flagg, ingen runtime-endring: `git revert` av commitene i grenen. Eneste endring i eksisterende filer er `remediation-2-schema-invariants.test.ts` (A og B leser manifestet), barrel-eksporten i `modules/core/src/testing/index.ts` og ett script i rotens `package.json`.
