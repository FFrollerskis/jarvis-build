# PROJECT STATUS

**Oppdatert:** 2026-09-16 (branch `claude/d157-merge-transition-tree-proof`, PR **#84**, base
`main=6f1c980c3493c6f68fe97bb2c8f045b4d196af75`). Aktiv ordre: **D-158**
(`D158-PR84-SAME-FILE-MERGE-PROOF-HARDENING-20260915-A`, issue #68 kommentar 5688709953).
`MERGE_AUTHORIZED=false`, `ARCHITECT_MERGE_APPROVED=false`, `SELF_APPROVAL=false`.

D-158 retter PR #84 **på plass**, som ÉN sammenhengende kontrollplan-leveranse. PR #84 forblir DRAFT og
UMERGET. PR #83/UA-9 og PR #85/UA-10 er URØRT - ikke startet, ikke endret, ikke merget, ikke autorisert.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Defekten (ferdig, rettet, testet) - samme feil, andre gang

D-157 erstattet D-145s tre-likhet med en EFFEKTIV-ENDRINGS-sammenlikning: GitHub-projeksjonene

    compare(parent1 ... mergeSha)              hva mergen gjorde
    compare(expectedBase ... expectedHead)     hva ordren autoriserte

måtte være like fil for fil og felt for felt, inkludert RESULTERENDE BLOB-SHA og patch-tekst.

Det er sant for topologien D-157s fiksturer hadde - base og head endrer FORSKJELLIGE FILER - og usant
for en like alminnelig topologi: **base og head endrer hver sin IKKE-OVERLAPPENDE HUNK I ÉN OG SAMME
TEKSTFIL.** Den korrekte merge-bloben for den filen inneholder BEGGE sider, så den kan ikke være lik
head sin blob, så de to projeksjonene kan ikke være like, og porten returnerer
`DELTA_CONTENT_MISMATCH` for en gyldig, konfliktfri, korrekt autorisert merge.

**Mønsteret er det egentlige funnet.** Begge de to forrige reglene påstod en LIKHET med noe annet - et
tre den skulle være lik, en diff den skulle se ut som - og en likhet må utledes på nytt for hver
topologi. Det er nøyaktig slik hver av dem fikk en topologi den var gal for.

## Rettelsen (ferdig, testet) - regn mergen ut på nytt

Ny ren løvmodul `ops/claude-worker/lib/merge-tree-proof.mjs` + ny beregningsmodul
`ops/claude-worker/lib/merge-tree.mjs`. Spørsmålet er ikke lenger «ligner mergen på X», men:

> Er denne merge-commiten DEN mergen av de to commitene som ble autorisert?

Det forventede treet påstås ikke - det BEREGNES fra de to uforanderlige autoriserte objektene med git
sin egen tre-veis-merge, uten utsjekk og uten working tree, og så avgjør ÉN identitet:

    tree(mergeCommit) === merge3(expectedBase, expectedHead)

Hver topologi er den SAMME påstanden - head som allerede inneholder sin base, head 17 commits bak,
forskjellige filer, forskjellige hunker i samme fil. Det finnes ingen case-analyse igjen å ta feil av.

**Strengt sterkere enn begge forgjengerne.** En tre-ID er HELE treet: hver sti, hver filmodus,
symlinker, gitlinks og binærinnhold ligger inni den. Ingenting må enumereres, så ingenting kan glemmes.
Ekstra fil, droppet eller endret reviewet hunk, endret FILMODUS og - avgjørende - **endret
BASE-ONLY-hunk** avvises alle. Det siste var BEGGE forgjengerne strukturelt blinde for: base-only
innhold finnes hverken i `base...head` eller i `parent1...merge`.

**Merge-commiten leses som et EKTE OBJEKT**, ikke som en projeksjon. API-ets tre og foreldre kreves
fortsatt, og kreves å være ENIG (`MERGE_COMMIT_OBJECT_DISAGREES`), så de to er en kryss-sjekk på
hverandre i stedet for at den ene erstatter den andre.

**Ingen mutasjon av brukerens arbeid, som en STRUKTURELL egenskap.** `merge-tree --write-tree` skriver
treet, så dette kan ikke gjøres med lesninger alene. Det gjøres derfor i et objektlager workeren EIER:
et bart repo under `cfg.scratchRoot` - som `config.mjs` allerede asserterer ligger UTENFOR `repoPath` -
med `objects/info/alternates` pekt på det primære objektlageret, som gjør hvert objekt klonen allerede
har LESBART uten å kopiere det og uten å skrive til det. Ingen utsjekk, ingen index, ingen ref skrevet,
ingenting stashet/reset/cleanet. Et objekt som mangler lokalt hentes PER EKSAKT SHA fra repoets eget
`origin` - verifisert med `remoteMatchesRepo` først - uten refspec, så også den operasjonen kun LEGGER
TIL objekter.

**Alt som ikke er et fullstendig, entydig, konfliktfritt resultat er UKJENT/BLOCKED:** manglende objekt,
git som ikke kan utføre mergen, konflikt, en beregning som svarte om ANDRE commiter enn de autoriserte,
uleselig merge-commit-objekt. `conflicted: null` er ikke `false` - en IKKE-UTTALT konflikt avvises.
`computeMergeTree` kaster aldri; en port som krasjer har ikke bestemt noe. Exit-koden alene er bevisst
ikke troende: `git merge-tree` avslutter med 1 BÅDE for en ekte konflikt og for et objekt den ikke kunne
laste, så «konflikt» konkluderes kun fra beviset på at git faktisk merget (en tre-ID på første linje).
**Determinisme på tvers av verter er pinnet, ikke antatt.** `core.autocrlf=false`/`core.eol=lf` pinnes,
så de samme to commitene ikke kan merge til ulike trær på Windows og Linux - og av samme grunn pinnes
`merge.renames=true`/`diff.renames=true`/`merge.renameLimit=7000` (git sine EGNE standardverdier;
pinningen finnes for å hindre at vertens config flytter svaret, ikke for å velge et annet svar enn
standarden). Rename-deteksjon endrer det mergede TREET: en rename mergen SER er en rename innholdet
følger, mens en den ikke ser blir en delete pluss en add. Verifisert empirisk, ikke antatt - med
pinningen fjernet gir topologien «base omdøper filen, head redigerer den under sitt gamle navn» en
KONFLIKT for en fullt gyldig merge på en vert med `merge.renames=false`, altså nøyaktig den
falsk-negativ-klassen D-158 finnes for å lukke, gjennom en annen dør. `-c` slår repo-, global- og
system-config. Siden ethvert avvik uansett gir MISMATCH/BLOCKED, fjerner hardningen kun FALSKE
NEGATIVER og kan aldri gjøre et avslag om til en pass.

**Fjernet, ikke beholdt som død kode:** `lib/merge-delta.mjs`, `github.mjs::compareCommits` og
`compare`-ruten i fake-`gh`. Ingenting i `lib/` leser lenger en sammenlikning. Head-treet bæres fortsatt
i beviset, men eksplisitt merket «head tree (evidence only)».

**Ingenting av D-134..D-157 er svekket.** Eksakt-SHA-autorisasjon, PR-registrert merge-SHA, ordnet
two-parent-struktur, avvisning av squash/rebase, påkrevd review på eksakt head, påkrevd pre- og
post-merge-CI med eksakte jobb-identiteter på eksakt merge-SHA, uforanderlig ordre-/task-binding,
commit-proveniens, den smale «kun merge-commiten»-unnskyldelsen, dirty-/isolasjonsportene og «ingen
self-approval» står uendret. En flyttet HEAD er fortsatt kun en OBSERVASJON. En vanlig ikke-merge-task
koster fortsatt NULL remote-kall og null git-beregning. `WORKER_VERSION` `2.2.0` → `2.3.0`;
`lib/merge-tree-proof.mjs` og `lib/merge-tree.mjs` lagt til deploy-payloaden.

## Bevis

- **Modellen er verifisert mot EKTE historikk før én linje kode ble skrevet:**
  `git merge-tree --write-tree 091ba091 170e5810` → `eef13c740e69b11c2e1007b2a6b9303e3eda393d`, som er
  nøyaktig treet GitHubs egen merge-commit `6f1c980c` peker på. Altså PR #82s divergerte
  17-commits-bak-topologi, reprodusert eksakt av modellen som nå håndhever.
- Ny `merge-tree-proof.test.mjs` **45/45**. Ren-verifikator-grener drevet eksakt, pluss EKTE
  git-topologier der git regner ut trærne: forskjellige filer PASS; **ikke-overlappende hunker i samme
  fil PASS** (den refuserte saken); base allerede inneholdt av head PASS; overlappende hunker BLOCKED
  som konflikt; manuelt løst konflikt presentert som normal merge BLOCKED; ekstra fil, droppet hunk,
  endret hunk, **endret base-only-hunk**, endret filmodus alle BLOCKED; squash og feil/reverserte
  foreldre BLOCKED fra objektet; manglende objekt, forkortet SHA og uleselig repo BLOCKED; fetch fra
  feil origin nektet. To isolasjonstester asserterer at repoets objektlager, refs, HEAD og `status` er
  BIT-IDENTISKE før og etter beregningen, og at et eksisterende scratch-lager gjenbrukes, ikke slettes.
  En tredje isolasjonstest asserterer at **rename-deteksjon er pinnet**: samme to commiter gir samme
  forventede tre selv når lagerets egen config slår rename-deteksjon AV. Verifisert som ikke-vakuøs ved
  å fjerne pinningen - da blir en fullt gyldig «base omdøper filen, head redigerer den under sitt gamle
  navn»-merge rapportert som KONFLIKT, altså samme falsk-negativ-klasse D-158 lukker, gjennom en annen dør.
- `merge-transition.test.mjs` **73/73**, `postmerge-evidence.test.mjs` **60/60**.
- `worker-merge-transition.test.mjs` **51/51** mot EKTE `worker.mjs run` som ekte OS-prosess over et
  EKTE git-repo, inkludert en ny **D-158-REGRESJONSBLOKK**: den bygger samme-fil/ikke-overlappende
  topologi av ekte commiter, **KJØRER D-157s EGEN PROJEKSJONS-LIKHETSREGEL** (bevart som
  `d157ProjectionEquality` i fiksturene, kun som vitne for en lukket bug) og asserterer at den FEILER
  på `blobSha` for `shared.txt` - og deretter at den RETTEDE porten FULLFØRER nøyaktig samme merge.
  Samme blokk holder fortsatt porten når den reviewede hunken droppes, og når de samme to sidene
  kolliderer i en ekte konflikt.
- Full `ops/claude-worker`-akseptanse, målt på nytt i denne attempten (2026-09-16):
  **37/39 filer, 1257/1257 tester GRØNNE** (varighet 1181 s). De to filene som ikke er grønne er
  `deploy-cli.test.mjs` og `supervisor-run.test.mjs`, og de FEILER VED LASTING (null tester kjørt) - se
  blokkering 3. Begge er urørt av D-158 og byte-identiske med HEAD. D-157-rapporten oppga «39/39 filer,
  1259/1259»; **det reproduserer ikke i dette miljøet**, og det rapporteres som det er i stedet for å
  omskrives til en pass.
- Repo-`lint` (`eslint .`) og repo-`typecheck` (`pnpm -r run typecheck`) rene.

## Blokkeringer

1. **Merge.** `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` i D-158. PR #84 merges ikke
   før en NY `ARCHITECT_TASK` eksplisitt godkjenner det mot eksakt HEAD/base.
2. **Forhøyet sesjon (uendret fra D-143/D-145..D-157).** Claude Code kjører FORHØYET, og PostgreSQL
   nekter å starte under en administrator-konto; lokalt feiler dessuten tester utenfor
   `ops/claude-worker` på den pre-eksisterende Windows-`.cjs`-spawn-klassen (`EFTYPE`). Begge klassene
   er uavhengige av denne endringen - den er avgrenset til `ops/claude-worker` + docs.
3. **To worker-testfiler kan ikke PARSES lokalt på Windows (pre-eksisterende, IKKE rørt her).**
   `deploy-cli.test.mjs` og `supervisor-run.test.mjs` feiler ved LASTING med
   `SyntaxError: Invalid or unexpected token` når de importerer henholdsvis `../deploy.mjs` og
   `../supervisor.mjs`. Diagnostisert byte for byte i denne attempten: de tre CLI-inngangspunktene
   (`deploy.mjs`, `supervisor.mjs`, `worker.mjs`) er de eneste filene med `#!`-shebang, og på denne
   Windows-utsjekkingen slutter shebang-linjen med CRLF (`"#!/usr/bin/env node\r\n"`), som vites
   shebang-stripping ikke håndterer. Kilden er gyldig ESM - `node --check` OG en ekte `import()` av
   begge lykkes. Reproduserer med `--no-cache`, så ingen stale vite-cache.
   **Beviskjede for at D-158 ikke er årsaken:** alle fire involverte filer er byte-identiske med HEAD
   (`git diff HEAD` tom) og ble sist endret under D-126; `supervisor-run.test.mjs` importerer
   `lib/github.mjs` - en fil DENNE tasken endrer - på linje 21 UTEN feil og feiler først på linje 23 på
   den uendrede `supervisor.mjs`, og `deploy-cli.test.mjs` feiler på linje 22 før den i det hele tatt
   når `lib/deploy.mjs`. Ingen fiks gjort: å endre `vitest.config.ts` eller de tre inngangspunktene ville
   vært «urelatert opprydding», som ordrens grensepunkt 6 forbyr. **DEFERRED - egen arkitekt-beslutning.**
   Autoritativt bevis for disse to filene er Linux-CI, der linjeskiftene er LF.
4. **Embedded-Postgres-flake (eksplisitt avdekket, IKKE rørt her).** Fortsatt kjent og udekket i
   repo-suiten utenfor `ops/claude-worker`.
5. **D-156-rekonsiliasjon er BEVISST utsatt (per ordren).** D-156s beholdte record rekonsilieres først
   etter at denne fiksen er uavhengig reviewet, merget, post-merge-testet og deployet.
6. **Deploy.** Worker `2.3.0` er IKKE deployet. Den kjørende workeren er fortsatt en eldre versjon.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av denne draft-PR-en mot faktisk diff/tester/CI på eksakt HEAD. Deretter,
i rekkefølge: merge (egen `ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` og eksakt HEAD/base-guard),
deploy av worker `2.3.0`, så D-156-rekonsiliasjon - og først deretter UA-9.
