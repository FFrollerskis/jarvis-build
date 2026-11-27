# WP-EV0: authority-herding FØR eieren signerer sikkerhetskonstitusjonen (HF2 EV-0)

**Status (2026-11-27): BYGGET OG TESTET (rene tester + ekte Postgres lokalt) - IKKE MERGET, IKKE DEPLOYET, IKKE KJØRT MOT NAS-en, INGENTING ER `VERIFIED`.**
Branch `claude/wp-ev0-authority-hardening`. Beslutninger og spørsmål føres av lead/arkitekt (denne grenen rører ikke `DECISIONS_AND_ASSUMPTIONS.md`, `OPEN_QUESTIONS.md`, `FINDINGS_LEDGER.md`, `PROJECT_STATUS.md`).
`CORE_DEPENDENCY_DECISION_REQUIRED=false` (ingen ny leverandør, ingen ny connector; D-64 uberørt). Migrasjon: **280** (eneste). Nye flagg/miljøvariabler: **ingen** (se §3).
**Ingen privatnøkkel er laget, lest eller brukt. Ingenting er signert. `SelfModificationService` konstrueres fortsatt ikke (D-397 frosset).** Alt som er bygget er et bibliotek eller en kontroll: ingen Evolution-tjeneste kjører, og ingenting nedenfor endrer oppførselen i drift.
Statusord: WIRED (kjører i drift) · DORMANT (bygget og testet, men ingen konsument) · BUILT_UNWIRED (bygget som verktøy/bibliotek, ikke koblet) · PARTIAL · DEFERRED (med begrunnelse) · BLOCKED_EXTERNAL (krever en eier-/ekstern handling) · NOT VERIFIED (ikke kjørt/bevist her).

## 0. Det eieren må vite først

**Ikke signer konstitusjonen før denne pakken er merget til `main` og du har vurdert utkastverdiene i §5 punkt 2.** Manifestet er det eneste stedet som sier hva Evolution aldri kan røre og hvor mye den kan bruke. Endres det etter at du har signert, må du lage en ny versjon og signere på nytt. Pakken herder derfor manifestet og kontrollene rundt det FØR første signering.
Alle tall i `config/evolution/constitution.v1.json` er **konservative utkast, ikke beslutninger**. Verktøyet nekter å signere så lenge utkast-markørene står igjen (`UNSIGNED-DRAFT` i `issued_by`, UTKAST-merknaden), og nekter å signere verdier som kjøretiden ville avvist.

## 1. Hva er bygget

| Krav | Hva | Hvor | Status | Test |
|---|---|---|---|---|
| K1 Manifest-skjema | Strengt `budget_caps` med 12 påkrevde heltallsfelt: kostnadstak i øre pr. kalendermåned for hver av fem kategorier (radar, eval, redteam, shadow, review) pluss TOTAL, eier-tid i minutter (pr. uke og pr. autonom endring), deploys pr. døgn og pr. UTC-time, auto-merger og eier-forslag pr. døgn. Harde tak i koden (`BUDGET_HARD_CEILINGS`) som selv et signert manifest ikke kan overskride. Koherens: kategoriene summerer til høyst totalen, timer ≤ døgn, minutter pr. endring ≤ ukebudsjett. `schema_version` 2, valgfri `notes`. Kjøretiden skiller `constitution_weakened` (tak/sonder/E3-handlinger) fra `constitution_invalid` (skjema/koherens). | `modules/self-modification/src/constitution.ts` (`BudgetCapsSchema`, `BUDGET_HARD_CEILINGS`, `buildConstitution`), `config/evolution/constitution.v1.json` | Verifisering ved oppstart: WIRED (uendret, kun logging). Håndhevelse av takene: DORMANT (ingen konsument). | `ev0-budget-caps.test.ts`, `constitution.test.ts` |
| K2 Beskyttede stier og sonder | Utvidet liste over sonder (`REQUIRED_PROTECTED_PROBES`) og hardkodede forbudte mønstre (`FORBIDDEN_PATH_PATTERNS`, alle uavhengige av store/små bokstaver); 13 påkrevde E3-handlinger (inkl. `self_approve_change`, `rotate_break_glass_key`, `modify_protected_path_manifest`). Stinormalisering `protectionKey` (NFKC, små bokstaver, `\` → `/`, `.`-segmenter, etterfølgende punktum/mellomrom, `..`, absolutt/`~`, `:`, kontrolltegn, 8.3-kortnavn og tom sti = ugyldig = E3). E1-allowlisten er fortsatt eksakt og skiller store/små bokstaver. Paritetstest mellom manifest, hardkodede mønstre og de gamle reglene. | `src/policy.ts`, `src/constitution.ts` (`classify`, `matchesRule`), `src/evolution/common.ts` (`sensitiveTouches`) | Kontrollene er WIRED der klassifisering allerede brukes; Evolution-motoren som bruker dem er frosset. | `ev0-protected-paths.test.ts`, `policy.test.ts`, `constitution.test.ts` |
| K3 Endringstype → minsteklasse | `kind` (10 typer) er påkrevd i endringsforslag. Minsteklasse: prompt/personality/routing E1; config/code E0; schema/dependency/credential/network/protected-adjacent E2; ukjent type E3. Stiene avslører typen uavhengig av det forslaget erklærer. Kundevendt personlighet krever eier. Avhengighet/credential/nettverk krever verifisert primærkilde også med harmløse stier. Utrullingsporten bruker samme gulv; for de fem gamle typene er årsakene byte-identiske (differensialtest). | `src/evolution/change-kind.ts`, `src/evolution/proposal.ts`, `src/evolution/release-gate.ts` | DORMANT | `ev0-change-kind.test.ts`, `ev3-5-proposal-radar.test.ts`, `ev8-10-release-heal-memory.test.ts` |
| K4 Migrasjonsgate | Rein tilstandsmaskin: expand → compatible_code → backfill → verify → switch → contract; hver fase er egen endring og eget deploy, alltid E2, destruktivt kun i `contract`, `contract` tidligst 168 timer etter `switch`, alle fakta må være nøyaktig `true`, tilstanden utledes fra endringsregisteret (aldri fra forslaget). Et forslag som berører skjema uten gyldig trinn avvises. | `src/evolution/migration-gate.ts`, `src/evolution/proposal.ts` | BUILT_UNWIRED. SQL-skanner (automatisk deteksjon av destruktiv SQL): DEFERRED. | `ev0-migration-gate.test.ts` (inkl. uttømmende sekvenstest) |
| K5 Budsjettlås mot forbruk | `BudgetLock` teller deploys pr. døgn og pr. time (endringsregisteret), kostnad pr. kategori og total pr. måned og eier-tid pr. uke og pr. endring (forbruksregisteret). Ukjent/ugyldig teller, ugyldig grense eller ugyldig klokke = nektet (`budget_check_failed`), aldri 0. Nytt append-only, hash-kjedet register `evolution_usage_ledger` (migrasjon 280) med klasse `UsageLedger`. | `src/budget-lock.ts`, `src/usage-ledger.ts`, `modules/core/src/db/migrations/280_evolution_usage_ledger.sql` | DORMANT. **Ingen skriver til registeret ennå** (modellkostnad og eier-tid måles ikke inn) og ingen tjeneste kaller låsen. | `ev0-budget-lock-usage.test.ts`, `ev0-usage-ledger-db.test.ts` (ekte Postgres), `budget-lock.test.ts` |
| K6 PROJECT_STATUS-generator | Genererer Evolution-blokken (planlagt tak, faktisk forbruk, run-rate, eier-tid) fra det SIGNERTE manifestet og et forbruksbilde. Det som ikke er målt står som «ikke målt», aldri 0. Usignert/ikke-verifisert manifest vises som UTKAST; avvist manifest gir exit 2 uten tak. `--check` avslører en foreldet blokk (versjon og SHA-256 av takene). Skriver aldri `issued_by`. | `src/evolution/status-block.ts`, `ops/evolution/project-status-block.ts`, `ops/evolution/fixtures/` | BUILT_UNWIRED (verktøy kjørt av en person). Blokken er IKKE satt inn i `docs/PROJECT_STATUS.md` (delt dokument, lead/docs). | `ev0-status-block.test.ts`, `ops/evolution/test/project-status-block.test.mjs` |
| K7 CODEOWNERS/regelsett og signering | `sign-constitution.mjs` nekter å signere utkast og verdier over harde tak, og har `summary`/`check`. CODEOWNERS genereres fra de beskyttede stiene i manifestet. Regelsett-utkast for `main`. Alt ligger under `ops/security/` (ikke `.github/`, som er en beskyttet sti Jarvis ikke kan endre). | `ops/security/sign-constitution.mjs`, `ops/security/github-governance/` | Signeringsverktøyet: BUILT_UNWIRED (kjøres av eieren, offline). CODEOWNERS/regelsett: utkast, `enforcement: disabled`, BLOCKED_EXTERNAL (aktivering er en eier-handling) og NOT VERIFIED mot en ekte GitHub-konto. | `ops/security/test/sign-constitution.test.mjs`, `ops/security/test/github-governance.test.mjs` |
| K8 Oppstartssjekk uendret | `apps/api/src/ev0-boot.ts` er IKKE endret; kun testen A2 forventer manifestversjon 2. | `apps/api/test/ev0-boot.test.ts` | WIRED (uendret) | samme |

Delte lister for den nye globale tabellen (ingen `tenant_id`, ingen RLS): `RLS_EXEMPT` i `modules/core/test/remediation-2-schema-invariants.test.ts`, `EXPECTED_NO_RLS` i `ops/acceptance/nas-ua0-gate.sh` (+ fixture og tall «10» i `UA0_NAS_ACCEPTANCE.md`) og en rad i `docs/security/PROCESSING_INVENTORY.md`.

## 2. Beslutninger i utkastet som eieren kan nedlegge veto mot

- **PC2:** takene (øre/minutter) ligger i det SIGNERTE manifestet; `docs/PROJECT_STATUS.md` er en generert visning, ikke en kilde. Harde tak i koden følger ADR-001 §2.3 pkt 4 (Evolution totalt høyst 1000 kr/måned).
- **Kategori-tak:** hver kategori har samme harde tak som totalen (100 000 øre); begrensningen er at summen ikke overstiger totalen.
- **Eier-tid i minutter** (ikke timer): heltall, grov nok og enkel å summere.
- **Observasjonsvindu 168 timer** (`MIGRATION_CONTRACT_MIN_OBSERVATION_HOURS`) er en kodekonstant, ikke et manifestfelt: å endre det er en kodeendring (E2).
- **Foreslått, ikke bygget (PC7):** «deterministisk systemvedlikehold» som egen endringsklasse. Dette er kun et forslag til lead/eier.

## 3. Flagg og miljøvariabler

Ingen nye. Den eneste relevante, eksisterende variabelen er `JARVIS_CONSTITUTION_PUBKEY_SHA256` (festet nøkkelfingeravtrykk, D-411). Forslag til senere (bygges først når en konsument kobles): `JARVIS_CONSTITUTION_MIN_VERSION` (sende `minVersion` inn i `verifyConstitution`; i dag sendes den ikke fra oppstartssjekken, så rollback-vernet er ikke koblet i drift) og et flagg som slår på håndhevelse av taket i en Evolution-tjeneste.
Flagg AV / ingen konsument = oppførsel uendret i forhold til `main`: de eksisterende flatene er pinnet med differensialtester (utrullingsporten 20 480 kombinasjoner; signeringsverktøyet mot `buildConstitution` over 400 mutasjoner).

## 4. Migrasjon 280 (`evolution_usage_ledger`)

- **Hva:** global (uten `tenant_id`/RLS), append-only, hash-kjedet tabell for målt forbruk (`spend`: øre pr. kategori) og eier-tid (`owner_time`: minutter), hver rad knyttet til målingen den kommer fra (`source_ref`) og til konstitusjonens digest. Triggere hindrer UPDATE/DELETE/TRUNCATE; `jarvis_app` har kun SELECT og INSERT; `seq` og `entry_hash` settes av databasen under en advisory-lås. `evolution_usage_ledger_verify()` regner kjeden på nytt og returnerer første ødelagte `seq` (NULL = hel kjede). Mønsteret er endringsregisteret (migrasjon 075).
- **Kjøring:** vanlig migrator ved oppstart. Ingen manuell handling og ingen datamigrering (tabellen er tom).
- **NAS-kontroll etter utrulling (NOT VERIFIED):**
  ```
  docker compose -f infra/local/docker-compose.yml exec -T postgres psql -U postgres -d jarvis -c "SELECT evolution_usage_ledger_verify();"
  docker compose -f infra/local/docker-compose.yml exec -T postgres psql -U postgres -d jarvis -c "SELECT count(*) FROM evolution_usage_ledger;"
  ```
  Forventet: `verify` gir tomt (NULL) og `count` gir 0. `ops/acceptance/nas-ua0-gate.sh` skal fortsatt være grønn (nå 10 dokumenterte tabeller uten RLS).
- **Rollback-vurdering:** rent additiv (expand), og ingen eksisterende kode leser tabellen. Forover-only: fjern bruken i koden og la tabellen stå. Ikke `DROP` (append-only er hele poenget; en nedtrekking krever at triggerne fjernes først).
- **Avgrensning (NOT VERIFIED):** en databaseadministrator med tilgang til triggerne kan skrive om hele kjeden (samme som 075); eksterne signerte sjekkpunkter er neste slice. Tabellen inneholder ingen personopplysninger (kun kategori, beløp, endrings-ID, målereferanse, digest).

## 5. Eier-handlinger i riktig rekkefølge (alt `NOT VERIFIED` mot NAS-en)

0. **Merge:** PR-en for `claude/wp-ev0-authority-hardening` merges av eieren (to-forelder merge-commit). Claude merger ikke.
1. **Oppdater NAS-en** (hent `main`, bygg, `up -d`). Migrasjon 280 kjører. Kontroller som i §4. `docker compose ... logs api | grep ev0_` viser fortsatt `ev0_constitution_boot` som `not_verified` (forventet: manifestet er usignert).
2. **Vurder verdiene** i tabellen i `EV0_CONSTITUTION_SIGNING.md` punkt 2 (kostnad pr. kategori og totalt, eier-tid, deploys, auto-merger). Alt kan senkes uten risiko; å heve senere krever ny versjon og ny signatur.
3. **Fyll inn** `issued_by` (nøytral rolle-ID, aldri et personnavn: repoet er offentlig), fjern UTKAST-merknaden, kjør `node ops/security/sign-constitution.mjs summary` og `... check` (exit 0 = klart).
4. **Lag nøkkelpar og signer, OFFLINE** (`keygen`, `sign`, `verify`; privatnøkkelen forlater aldri din maskin). Legg `constitution.v1.sig` og den OFFENTLIGE nøkkelen i repoet via en eier-PR.
5. **Fest fingeravtrykket** (`fingerprint`) som `JARVIS_CONSTITUTION_PUBKEY_SHA256` i NAS-`.env`, start API-et på nytt og kontroller at loggen sier `ev0_constitution_boot` `verified` med versjon 2.
6. **PROJECT_STATUS-blokken** (valgfritt, anbefalt): sett inn markørene `<!-- EVOLUTION_STATUS_BEGIN -->` og `<!-- EVOLUTION_STATUS_END -->` i `docs/PROJECT_STATUS.md` én gang for hånd, og kjør generatoren (§6).
7. **CODEOWNERS/regelsett** (valgfritt, eier-beslutning): følg `ops/security/github-governance/README.md`. Les fallgruvene først (en enkelt eier kan låse seg ute; Actions må være på før påkrevde sjekker kan rapportere).

## 6. PROJECT_STATUS-generatoren

```
node --experimental-transform-types ops/evolution/project-status-block.ts                       # blokken til stdout
node --experimental-transform-types ops/evolution/project-status-block.ts --pinned <fingeravtrykk> --write docs/PROJECT_STATUS.md
node --experimental-transform-types ops/evolution/project-status-block.ts --check docs/PROJECT_STATUS.md   # exit 1 = foreldet/manglende blokk
```
Exit-kontrakt: 0 ok · 1 `--check` fant avvik · 2 bruksfeil, ugyldig/svekket manifest, ugyldig forbruksbilde eller IO-feil. `--usage <fil.json>` leser et forbruksbilde (se `ops/evolution/fixtures/status-block.example.input.json`); uten det står alt faktisk forbruk som «ikke målt». Før manifestet er signert og nøkkelen er festet vises blokken som UTKAST. Generatoren leser aldri en privatnøkkel og skriver kun til filen som gis med `--write`.

## 7. Kjente begrensninger, DEFERRED og NOT VERIFIED

- **Ingen konsument:** `BudgetLock`, `UsageLedger` og migrasjonsgaten er ikke koblet til noen tjeneste (selvendring er frosset, D-397). Ingen kode skriver målt modellkostnad eller eier-tid til registeret ennå; «ikke målt» er derfor det ærlige tallet inntil målekoden finnes (DEFERRED, eget arbeidspaket).
- **Rollback-vern i oppstarten er ikke koblet:** `verifyConstitution` støtter `minVersion`, men `ev0-boot.ts` sender den ikke. Et eldre, gyldig signert manifest kan derfor i dag legges tilbake uten at oppstartssjekken reagerer (forslag: `JARVIS_CONSTITUTION_MIN_VERSION`).
- **Migrasjonsgate:** kun logikk. Ingen SQL-skanner (DEFERRED) og ingen kobling til deploy-pipeline; skjemaendringer oppdages via stier (`.sql`, `migrations/`) og forslagets `data_impact`-erklæring.
- **Stale sondenavn beholdt:** tre av de opprinnelige sondene samsvarer ikke med en fil på disk (`modules/policy/src/gateway.ts`, `modules/core/src/db/migrations/001_init.sql`, `docs/security/SECURITY_MODEL.md`). De står igjen som monotont gulv (en sonde fjernes aldri uten at manifestet avvises), og de riktige navnene (`001_identity.sql`, `docs/SECURITY_MODEL.md` m.fl.) er lagt til ved siden av.
- **GitHub-utkast:** feltnavn og plankrav (`allowed_merge_methods`, `~DEFAULT_BRANCH`, `evaluate`, kodeeier-krav) er ikke kontrollert mot en ekte konto (`unverified`). Aktivering er BLOCKED_EXTERNAL.
- **NAS:** ingenting er kjørt mot NAS-en (migrering, oppstartslogg, UA-0-gaten). Se §4 og §5 for kommandoene.

## 8. Rollback

- **Kode:** revert merge-commiten med en NY revert-commit (aldri `reset`/force). Manifestet er ikke signert, så det finnes ingen signatur å trekke tilbake; etter signering krever enhver endring en ny versjon og ny signatur (se `EV0_CONSTITUTION_SIGNING.md`, «Endre senere»).
- **Database:** se §4 (tabellen står, er ubrukt og tom).
- **Generatoren:** fjern markørblokken fra `PROJECT_STATUS.md` (ren dokumentasjon).
- **CODEOWNERS/regelsett:** sett regelsettet til `disabled` og fjern `.github/CODEOWNERS` via en eier-PR.

## 9. Tester og vakter

Kjør som en vanlig bruker (den innebygde Postgres-en nekter å starte som root). De nye og berørte testene:
```
pnpm exec vitest run modules/self-modification/test ops/security/test ops/evolution/test ops/acceptance/test \
  apps/api/test/ev0-boot.test.ts modules/core/test/remediation-2-schema-invariants.test.ts
pnpm -r run typecheck && pnpm lint && pnpm check:containment
```
`ev0-usage-ledger-db.test.ts` og `budget-lock.test.ts` kjører mot ekte Postgres (migrasjon 280 inkludert). Skann diffen for hemmeligheter med gitleaks før push (CI har jobben `gitleaks`).

**Kjøringer ved byggetidspunktet (2026-11-27, lokalt, ikke NAS):** 231 nye tester i 11 filer (`ev0-budget-caps` 17, `ev0-protected-paths` 24, `ev0-change-kind` 21, `ev0-migration-gate` 38, `ev0-budget-lock-usage` 27, `ev0-usage-ledger-db` 14, `ev0-status-block` 32, `ev0-classify-layers` 14, `sign-constitution` 14, `github-governance` 11, `project-status-block` 19).
Hele `modules/self-modification/test` pluss guardtestene (migrasjonskoding/-rekkefølge, skjema-invarianter, behandlingsinventar, erasure-dekning) og `apps/api`-testene for Evolution/oppstart: 954 tester, alle grønne bortsett fra én sandkasse-avhengig (`break-glass-guard`: `.gitignore`-testen feiler som `postgres`-bruker pga. «dubious ownership», og er grønn som root). `ops/*`-testene: 215 grønne. `typecheck`, `lint` og `check:containment` er grønne.
**Mutasjonstest (sikkerhetskoden):** 139 mutanter (grenseverdier, fjernede kontroller, snudde sammenligninger, svekkede mønstre, SQL-regler) over `constitution.ts`, `policy.ts`, `change-kind.ts`, `common.ts`, `proposal.ts`, `release-gate.ts`, `migration-gate.ts`, `budget-lock.ts`, `usage-ledger.ts`, `status-block.ts`, `sign-constitution.mjs`, `codeowners.mjs`, `project-status-block.ts` og migrasjon 280. Første kjøring: 128 drept, 10 overlevde, 1 ugyldig mutant (syntaksfeil i selve mutasjonen). Ni av de ti overlevende var testhull (reglenes semantikk for prefix/suffix, de uavhengige lagene i `classify`, den gamle policyens egen allowliste, `sensitiveTouches.invalid`, typegulvet utledet fra stier, `change_id` til migrasjonsgaten) og er lukket med nye tester (`ev0-classify-layers.test.ts`, B6, C11, C12, I9) og drept ved ny kjøring; den ugyldige mutanten er rettet og drept. **Én mutant overlever og er ekvivalent:** kategorivalideringen i `BudgetLock.checkCategorySpend` er duplisert av grensesjekken rett etter (en ukjent kategori gir en udefinert grense og nektes uten noen registeroppslag), så fjerning av den første sjekken endrer ikke observerbar oppførsel (forsvar i dybden).
