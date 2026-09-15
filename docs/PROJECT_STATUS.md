# PROJECT STATUS

**Oppdatert:** 2026-09-15 (branch `claude/d145-merge-transition-provenance` = PR #81, base
`main=0c803bf1c1724413dc8e8071a7aabe7fd52562e4`). Aktiv ordre: **D-152**
(`D152-PR81-ZERO-WRITE-REFUSED-SNAPSHOT-20260915-A`, issue #68 kommentar 5678564408,
`SUPERSEDES=D151-PR81-ATOMIC-AUTHORITY-SNAPSHOT-20260915-A`, `ARCHITECT_REVIEW_ID=5208613949`).
`MERGE_AUTHORIZED=false`, `ARCHITECT_MERGE_APPROVED=false`, `SELF_APPROVAL=false`.

PR #80 er MERGET (merge-SHA `0c803bf1`). PR #81 er ÅPEN og DRAFT og inneholder D-145 + D-146 + D-147
+ D-148 + D-149 + D-150 + D-151 + D-152 som én sammenhengende kontrollplan-leveranse. D-152 gjør det
D-151 plasserte riktig, men skrev gjennom: et ubrukelig autoritets-snapshot er nå en EKTE
null-skrive-beslutningsgrense.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Defekten (ferdig, testet)

D-151 flyttet kompletthets-spørsmålet øverst i syklusen og gjorde det fatalt for HELE syklusen.
Plasseringen er riktig. Men selve refusjonsgrenen kalte `reportStatus`, og `reportStatus` er ikke en
observasjon - den er TRE skrivinger, alle verifisert i koden på `44407ee1`:

1. **`postComment` PUBLISERER TIL KONTROLL-ISSUEN.** Kontroll-issuen er køens EGEN INNGANG. En syklus
   som nettopp hadde erklært at den ikke kunne lese den issuen, la likevel til i den - og hver senere
   syklus leser den kommentaren tilbake som en del av SITT autoritets-snapshot. Én flaky
   `gh api --paginate` ble dermed et permanent, globalt synlig artefakt forfattet av en syklus uten
   noen som helst autoritet.
2. **`postComment` SKRIVER FØRST EN BODY-FIL INN I `scratchRoot`** og oppretter katalogen hvis den
   mangler - scratch-aktivitet som holdets egen melding SAMTIDIG påstod ikke hadde skjedd.
3. **`recordPostedStatus` APPENDER TIL DEDUPLISERINGSJOURNALEN.** Det er durabel beslutningstilstand,
   og den avgjør FRAMTIDEN: når nøkkelen er journalført, undertrykkes det samme funnet i
   `statusRepeatHours`. En ubevist lesning kjøpte seg altså stille seks timers taushet om en tilstand
   som til da kan ha blitt reell og genuint verdt å rapportere.

## Rettelsen (ferdig, testet)

**Alle tre skrivingene er fjernet fra refusjonsgrenen** i den ekte eide worker-stien (`runOwned` i
`ops/claude-worker/worker.mjs`). Ingen `reportStatus`, ingen `postComment`, ingen
`recordPostedStatus`, ingen scratch-katalog. Det som står igjen er den eneste kategorien som ikke kan
korrumpere en senere beslutning: LOKALT APPEND-ONLY BEVIS. Logg og health-journal skrives på denne
verten, leses aldri tilbake som autoritet, og er nøyaktig det en operatør trenger for å se at
workeren holdt og hvorfor.

**Beviset navngir refusjonen og påstår aldri en posting.** Health-eventen
`control_authority_snapshot_unusable` bærer nå `snapshot_reason`, `snapshot_detail`, `held: true`,
`exit: 4` og - positivt formulert, slik at beviset er FALSIFISERBART i stedet for bare taust om hva
det ikke gjorde - `status_comment_posted: false`, `posted_status_recorded: false`,
`durable_state_written: false`. Loggen sier eksplisitt at INGEN GitHub-kommentar ble postet og INGEN
dedup-oppføring registrert, og navngir det holdte TRANSIENT-utfallet (exit 4).

**Grensen står strukturelt der den stod.** Snapshotet tas fortsatt i `runOwned` rett etter auth- og
lesebeviset og FØR recovery, rekonsiliasjon, kø-seleksjon, retirering, supersession,
task-state-persistering, worktree-/scratch-/repo-handling, transition-lesning, prompt-bygging og
barne-spawn. `cmdDryRun` skrev allerede ingenting og er uendret.

**Komplett-snapshot-stien er IKKE svekket.** Forbudet gjelder å skrive FRA EN SYKLUS SOM BEVISTE AT
DEN IKKE KUNNE LESE - ikke å skrive i det hele tatt. Legitim status-/rapport-posting etter et bevist
komplett snapshot er uendret og fortsatt dekket, dedupliseringen inkludert.

**Ny TEST-ONLY fault `control_read_unproven`.** `READ_UNPROVEN` er snapshotets vern mot en lesning
INGEN GIKK GOD FOR, og `fetchIssueCommentsDetailed` leverer alltid kompletthetsbevis i dag - funnet er
derfor unåbart utenfra prosessen og finnes for å hindre en FRAMTIDIG kaller eller refaktorering i
stille å gjeninnføre den svakere kontrakten. Det er nøyaktig situasjonen den etablerte
`JARVIS_WORKER_FAULT`-konvensjonen allerede dekker. Bare lesningens FORM forfalskes; snapshot-fangst,
refusjon, bevis og exit er den ekte, uendrede kodestien, og armeringen annonseres høylytt i logg og
health som alle andre faults.

**Ingenting av D-145..D-151 er svekket.** Uforanderlig ordrebinding, unik uredigert autoritet, ingen
eksekverbare same-id-oppdateringer, obligatorisk merge-overgangs-/closeout-/navngitt-CI-bevis,
strenge dirty-/proveniens-/isolasjonsporter og kun normal two-parent merge når det er separat
autorisert - alt står uendret.

## Bevis

- Ny `worker-refused-snapshot-zero-write.test.mjs` **11/11** mot EKTE `worker.mjs run` som ekte
  OS-prosess over et EKTE git-repo.
- Hver refusjonssak - lesefeil, AVKORTET side, INKOMPLETT lesning som skjuler en same-id-duplikat, og
  UBEVIST lesning - PRE-SEEDER hver durabel flate refusjonen ikke skal røre (worker-state,
  state-backup, dedup-journal for postet status, en task-worktree med UCOMMITTED arbeid, og en
  claim-fil) og asserterer hver av dem BYTE-IDENTISK etterpå. Null kommentar-POST-er, null
  review-kall, null transition-lesninger, kontroll-issuen byte-identisk, null prompt, null barn, null
  worktree/claim for den ventende ordren, repo-HEAD/arbeidstre/refs uendret og INGEN
  `.git/FETCH_HEAD`. Exit er det navngitte TRANSIENT-resultatet 4.
- En FULL REKURSIV DIGEST av hele worker-roten før og etter beviser at de ENESTE stiene som endret seg
  er de tillatte append-only-flatene, og at hver av dem bare VOKSTE (gamle bytes fortsatt eksakt
  prefiks) - så en durabel skriving innført senere dukker opp som en uventet endret sti uten at noen
  test må forutse den. Lås-hovedboken (`<lockFile>.d/<generasjon>.claim`) er eksplisitt listet, ikke
  stille filtrert, og assertert STRENGERE enn «ignorer»: en refusert syklus kan APPENDE en ny
  generasjon og kan ikke endre eller fjerne en eksisterende.
- Egne saker: refusjonen bruker IKKE opp dedup-budsjettet (to påfølgende refusjoner lar journalen stå
  urørt begge ganger), oppretter INGEN scratch-katalog, gjør INGEN krasj-recovery og lar en abandonert
  IN_PROGRESS-task stå, og loggen navngir funnet, «HOLDING the whole cycle», «NO GitHub comment was
  posted» og «EXIT: 4 (TRANSIENT)» uten noensinne å si «Posted status comment».
- Positive kontroller: komplett lesning dispatcher normalt og fullfører tasken; legitim status-posting
  etter en KOMPLETT lesning poster fortsatt nøyaktig én kommentar OG journalfører fortsatt
  dedup-nøkkelen; en refusert syklus undertrykker IKKE neste syklus sin legitime rapport.
- **MUTASJONSTEST (bevis på at testene har tenner):** å gjeninnføre ett eneste `reportStatus`-kall i
  refusjonsgrenen får **9 av 11** til å feile, mens nøyaktig de to positive kontrollene som skal
  fortsette å virke, fortsatt passerer.

## Blokkeringer

1. **Forhøyet sesjon (uendret fra D-143/D-145..D-151).** Claude Code kjører FORHØYET, og PostgreSQL
   nekter å starte under en administrator-konto. Lokalt feiler dessuten tester utenfor
   `ops/claude-worker` på den pre-eksisterende Windows-`.cjs`-spawn-klassen (`EFTYPE`). Begge klassene
   er uavhengige av denne endringen - den er avgrenset til `ops/claude-worker` + docs - og er GRØNNE på
   Linux-CI, som er den autoritative porten.
2. **To worker-testfiler kan ikke PARSES lokalt på Windows (pre-eksisterende, IKKE rørt her).**
   `deploy-cli.test.mjs` og `supervisor-run.test.mjs` feiler lokalt med
   `SyntaxError: Invalid or unexpected token` allerede ved import, så de rapporterer «no tests» - de
   kjørte altså IKKE i det lokale løpet. Verifisert årsak: de er de to ENESTE testfilene som
   `import`-erer en entrypoint med shebang (`ops/claude-worker/deploy.mjs`, `supervisor.mjs`), og på
   denne Windows-utsjekkingen har shebang-linjen CRLF (`#!/usr/bin/env node\r\n`) - vitest/esbuild sin
   shebang-håndtering bryter på det. Begge filene er ASCII, passerer `node --check`, er URØRT av D-152
   (begge testfilene OG begge entrypointene er umodifiserte), og er GRØNNE på Linux-CI (LF) på eksakt
   PR-head. Klassen er miljøspesifikk, ikke en regresjon fra denne endringen, og er bevisst ikke
   «fikset» her: det ville krevd å røre urelaterte entrypoints/`.gitattributes` utenfor D-152s mandat.
   Autoritativt bevis for disse to filene er CI.
3. **Embedded-Postgres-flake (eksplisitt avdekket, IKKE rørt her).** Den tilbakevendende 16-prosess/
   16-port-flaken i repo-suiten utenfor `ops/claude-worker` er fortsatt kjent og udekket. Ingen dekning
   er svekket, hoppet over eller nøytralisert for å oppnå grønn CI.
4. **Merge.** `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` i D-152. PR #81 merges ikke
   før en NY `ARCHITECT_TASK` eksplisitt godkjenner det mot eksakt HEAD/base.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av PR #81 mot faktisk diff/tester/CI på eksakt NYTT endelig HEAD.
Ingen merge uten en ny `ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` og eksakt HEAD/base-guard.
