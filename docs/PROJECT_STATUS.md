# PROJECT STATUS

**Oppdatert:** 2026-09-17 (branch `claude/d166-cross-worker-task-admission`, base
`main=14a12fd170ace732ee7bcfc8e879a61540db1982`). Aktiv ordre: **D-166**
(`D166-PR83-POSTMERGE-CLOSEOUT-ADMISSION-EXCLUSIVITY-20260917-A`, issue #68 kommentar 5706963440,
`SUPERSEDES=D165-PR83-D164-PROVENANCE-RECONCILIATION-20260917-A`).
`MERGE_AUTHORIZED=false`, `SELF_APPROVAL=false`. PR #86 er IKKE berørt av denne ordren.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Del 1 - PR #83 post-merge-closeout (ferdig, verifisert)

Alle guards verifisert mot ferske remote-lesninger FØR noen mutasjon:

- `main` = `14a12fd170ace732ee7bcfc8e879a61540db1982` = `EXPECTED_MAIN_SHA`.
- PR #83: `closed`, `merged=true`, head `c7bc3a4edb5868405843c7ded34484bc9d0fc68e`,
  base `639730c5c14ba6175e91b09606abc4d9dd24fb8a`, merge-SHA `14a12fd1…` - alle eksakt som guardet.
  Merget 2026-09-17T01:16:36Z av `tsworkflow`.
- Merge-committen har NØYAKTIG to ordnede foreldre: `639730c5…` (base) så `c7bc3a4e…` (PR-head).
  Normal two-parent merge; ikke squash (som gir én forelder), ikke rebase (som ville erstattet head).
- Review **5229954341** er SISTE eksplisitte mergebeslutning på PR #83, submittet på eksakt
  `commit_id=c7bc3a4e…`, med `MERGE_AUTHORIZED=true`, `ARCHITECT_MERGE_APPROVED=true` og
  `CLAUDE_SELF_APPROVAL=false`. Den erstatter tilbakekallingen i review 5229873848.
- PR #86: `open`, `draft=true`, `merged=false`, head `9b51bf719c50aabfd390d6e6c4c514a0f713bdac`,
  base `639730c5…`, `updated_at=2026-09-17T00:03:45Z` - uendret, og uendret ved sluttkontroll.

**Post-merge-CI: GRØNN på eksakt merge-SHA.** Run **35169923716** (`CI`, event `push`, attempt 1,
`head_sha=14a12fd1…`): `build-test` success, `windows-git-auth` success, `gitleaks` success. Det er
den ENESTE workflow-run på den SHA-en (API-spørring på `head_sha`, ikke et utvalg). Ingen rerun og
ingen omgåelse; kjøringen ble ventet ut, ikke forsert.

## Del 2 - cross-worker admission exclusivity (ny, bygget og bevist)

**Defekten, observert på ekte data.** `acquireLock` gir gjensidig utelukkelse per LÅSEFIL, ikke per
TASK_ID. To worker-deployments har to låsefiler, og kjernen serialiserer ingenting mellom to stier
som aldri møtes - så begge kan lese samme kontroll-issue, velge samme ordre og dispatche hvert sitt
barn. Det skjedde: issue #68 har to `CLAUDE_ACK` (5706901949 kl. 01:12:27Z og 5706911174 kl.
01:13:41Z) og to `CLAUDE_REPORT` (5706914372, 5706934609) for D-165.

**Rettelsen.** Ny `ops/claude-worker/lib/task-admission.mjs`: en append-only, versjonert leie per
TASK_ID i en DELT rot utledet fra kontrollplan-identiteten
(`<home>/.jarvis-worker-admission/<owner>__<repo>__issue<N>`, overstyrbar med `admissionRoot`,
`assertOutsideRepo`-vaktet). Primitivet er gjenbrukt fra `lock.mjs` framfor gjenoppfunnet:
`publishExclusive` (create-if-absent), slik at
**CAS(observert versjon V) = opprett `<V+1>.lease` create-if-absent** - kjernen kårer vinneren.

Leien tas i `runTask` FØR autoritetsporten, ordrebindingen, enhver tilstandsrad, karantenen,
dirty-vakten, worktreet, enhver GitHub-skriving og ethvert barn. En TAPER etterlater null ACK, null
rapport, null statuskommentar, null worktree, null branch, null scratch og null tilstandsskriving.

Overtakelse krever ALLE TRE: eieren beviselig borte (pid vekk, eller annen `start_time` - som er hva
en reboot produserer), leien EKSPLISITT utløpt (`now > lease_expires_at_ms`, samme vert, én klokke),
og en vellykket CAS mot nøyaktig observert versjon. En LEVENDE eier overtas ALDRI - heller ikke med
utløpt leie. En leie eid av en ANNEN VERT reklameres aldri, uansett tidsstempler (D-143 uendret).
`terminal`-tilstanden er durabel task-id-dedupe: den overlever reboot, tapt `state.json` og en fersk
deployment-rot. Ingenting slettes, trunkeres eller overskrives som prosessen ikke selv opprettet.

**`STATUS=PASS`** (og `PASSED`) er lagt til `TERMINAL_STATUS_ALIASES`. Ukjente statuser er uendret:
`recognised: false`, fortsatt fail-closed parkering. Fiksen løsner ingenting.

## Del 3 - bevis

- `ops/claude-worker/test/task-admission.test.mjs`: **28/28**, null skipped. Flerprosess-testene
  asserter på EFFEKT-KATALOGEN - hvilke `ack`/`worktree`/`remote`/`report`-filer som faktisk ble
  opprettet av hvem som helst - ikke på hva hver prosess sier om seg selv, så en kontendent som
  lyver, krasjer eller aldri blir skedulert ikke kan skjule en sideeffekt. 2 og 10 ekte samtidige
  OS-prosesser gir nøyaktig 1 eier og 1 av hver effekt med null overlapp; krasj før ACK og krasj
  etter ACK; reboot-durabilitet; terminal dedupe mot 10 ferske prosesser; parser-regresjon.
- Full `ops/claude-worker`-suite kjørt som regresjonskontroll; tallene står i CLAUDE_REPORT på
  issue #68 (en dokumentoppdatering ville flyttet HEAD og ugyldiggjort nettopp den kjøringen).
- `pnpm -w lint` og `pnpm -r run typecheck`: rene. `node --check` på alle endrede `.mjs`: OK.

## Blokkeringer

1. **Merge.** `MERGE_AUTHORIZED=false` i D-166. Denne leveransen merges ikke uten en NY
   `ARCHITECT_TASK` med eksakt HEAD/base-guard, etter uavhengig arkitekt-review.
2. **Tolkning av ordrepunktet «ingen endring i repoet».** Worker-koden ligger i `ops/claude-worker` i
   DETTE repoet, ikke i et separat styrt repo, og workerens deploy-mekanisme deployer FRA repoet - så
   den veien ville krevd en usporbar, ureviewbar endring på verten, i strid med D-134 og prosjektets
   sporbarhetsregel. Leveransen ligger derfor på egen branch som draft-PR; `main`, PR #83 og PR #86
   er uberørt. Se D-166 punkt H.
3. **Ingen host-deploy utført.** Den nye admission-porten er IKKE rullet ut på verten i denne
   oppgaven. Supervisor/worker er ikke stoppet, startet eller endret.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av denne branchen mot faktisk diff/tester/CI. PR #86 / UA-10 P1 er
neste masterplanleveranse og er fortsatt urørt draft.
