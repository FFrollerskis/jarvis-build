# PROJECT STATUS

**Oppdatert:** 2026-09-15 (branch `claude/d157-merge-transition-tree-proof`, base
`main=6f1c980c3493c6f68fe97bb2c8f045b4d196af75`). Aktiv ordre: **D-157**
(`D157-MERGE-TRANSITION-TREE-PROOF-HARDENING-20260915-A`, issue #68 kommentar 5686632375).
`MERGE_AUTHORIZED=false`, `ARCHITECT_MERGE_APPROVED=false`, `SELF_APPROVAL=false`.

PR #80, #81 og #82 er MERGET (PR #82 → merge-SHA `6f1c980c`, som er dagens `main` og denne taskens
base). Denne ordren retter workerens verifiserer for autoriserte merge-overganger som ÉN sammenhengende
kontrollplan-leveranse. PR #83 er URØRT, og UA-9 er ikke påbegynt.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Defekten (ferdig, rettet, testet)

D-145 beviste «mergen innførte ikke innhold som aldri ble reviewet» med

    merge-commitens tre === godkjent head sitt tre

(`MERGE_TRANSITION.TREE_MISMATCH`, håndhevet i `verifyMergeTransition` steg 5). Den likheten holder
KUN når branchen allerede inneholder hver commit på sin base - nøyaktig topologien D-144-fiksturet
tilfeldigvis hadde. Den er IKKE en invariant for en normal merge: en branch kuttet før senere
base-commits gir en korrekt merge-commit som bærer BÅDE den reviewede head-deltaen OG base-only
innhold, så treet skiller seg fra head sitt tre av konstruksjon.

**D-156 er beviset.** Lest ferskt fra remote i denne tasken (PR #82, base `091ba091`, head
`170e5810`, merge `6f1c980c`, review `5211287259` på nøyaktig godkjent head, post-merge-CI-run
`34995709114` grønn på merge-SHA):

    merge-tre  eef13c74...   head-tre  64815377...        -> IKKE LIKE
    compare(base...head)     status=diverged  ahead_by=3  behind_by=17

Branchen lå 17 commits bak. Den gamle regelen kalte det
`..._so_the_merge_introduced_unreviewed_content` og holdt fullføringsporten (worker-status
5684346209) på en merge som var nøyaktig den autoriserte. En kontrollplan-port som refuserer korrekt
historikk er ikke «streng» - den er GAL, og den lærer operatøren å rute rundt porten.

## Rettelsen (ferdig, testet)

Ny ren løvmodul `ops/claude-worker/lib/merge-delta.mjs`. Spørsmålet var aldri «er treene like?», men:
innførte mergen, på den autoriserte basen, NØYAKTIG den uavhengig reviewede endringen for den eksakte
godkjente head-en - og ingenting annet? Det avgjøres fra to SHA-adresserte sammenlikninger:

    MERGE-DELTA     compare(parent1 ... mergeSha)              hva mergen faktisk gjorde
    REVIEWED-DELTA  compare(expectedBase ... expectedHead)     hva ordren autoriserte

`parent1` leses av MERGE-COMMIT-OBJEKTET selv, etter at det allerede er bevist likt `expectedBase`.
INVARIANTEN: de to deltaene må være IDENTISKE, fil for fil og felt for felt - filnavn, status,
rename-kilde, RESULTERENDE BLOB-SHA, linjetall og patch-tekst.

**Strengt sterkere enn tre-likhet.** Konfliktløsning som ikke var dekket av reviewen (omskrevet eller
droppet hunk, fil fra feil side) endrer `compare(parent1...merge)` og avvises som
`DELTA_CONTENT_MISMATCH`; en ekstra fil smuglet inn i merge-treet avvises som
`DELTA_FILE_SET_MISMATCH`. Blob-SHA sammenliknes per fil, så innholdslikhet hviler IKKE på patch-tekst
(binærfiler og for store filer dekkes fortsatt); mangler både blob-sha og patch, avvises filen som
`DELTA_FILE_UNVERIFIABLE` i stedet for å sammenlikne to null-verdier som «like». Og ÉN regel dekker
BEGGE topologier: head inneholder allerede base, og head divergert fra base.

**Struktur og fail-closed.** Merge-deltaen må være forankret i merge-commitens EGEN første forelder og
mergen må STRENGT NEDSTAMME fra den (`merge_base === parent1`, `status=ahead`, `behind_by=0`) - rebase,
force-pushet erstatning og syntetisk historikk feiler strukturelt. Filside PÅ remote-taket (300) eller
flere filer rapportert enn returnert er `DELTA_TRUNCATED`. Kappet COMMIT-liste nedgraderer bare den
REDUNDANTE ende-identitets-kryss-sjekken, og det navngis eksplisitt i beviset. Tom reviewed-delta
avvises. Ulest sammenlikning er UKJENT, aldri «stemmer».

**Bevisst ikke gjort:** PR-ens egen fil-liste (`pulls/<n>/files`) leses IKKE - den er en muterbar
projeksjon hvis diff-base GitHub står fritt til å regne om, og den tilfører ingenting når den
reviewede deltaen allerede er en ren funksjon av de to SHA-ene ordren navngir. `TREE_MISMATCH` er
FJERNET, ikke beholdt som død konstant. Begge treene bæres fortsatt i beviset, men eksplisitt merket
«trees (evidence only)».

**Ingenting av D-134..D-152 er svekket.** Eksakt-SHA-autorisasjon, ordnet two-parent-struktur,
avvisning av squash/rebase, påkrevd review på eksakt head, påkrevd post-merge-CI med eksakte
jobb-identiteter på eksakt merge-SHA, uforanderlig ordrebinding, unik uredigert autoritet,
commit-proveniens, den smale «kun merge-commiten»-unnskyldelsen, dirty-/isolasjonsportene og «ingen
self-approval» står uendret. En flyttet HEAD er fortsatt kun en OBSERVASJON. En vanlig ikke-merge-task
koster fortsatt NULL remote-kall. `WORKER_VERSION` `2.1.0` → `2.2.0`; `lib/merge-delta.mjs` lagt til
deploy-payloaden (ESM-closure-testen fanget utelatelsen umiddelbart).

## Bevis

- Ny `merge-delta.test.mjs` **32/32**, bygget på PR #82s EKTE topologi og SHA-er. Positiv diverged-sak,
  up-to-date-sak under SAMME regel, og adversarielle negativer: ekstra fil, droppet fil, endret hunk,
  ulik blob med IDENTISK patch, endret linjetall/status/rename-kilde, uverifiserbar fil, feil
  forankring, merge bak sin egen forelder, feil merge-base, feil ende av intervall, flyttet base/head,
  ufullstendig SHA, uleselig/aldri-spurt sammenlikning, filside PÅ taket, filtall større enn returnert,
  kappet commit-liste som KUN nedgraderer kryss-sjekken, tom delta.
- `merge-transition.test.mjs` **60/60** inkl. ny D-157-blokk som kjører PR #82s tre-ulikhet gjennom
  HELE porten og likevel krever hver øvrige garanti. `postmerge-evidence.test.mjs` **70/70**.
- `worker-merge-transition.test.mjs` **46/46** mot EKTE `worker.mjs run` som ekte OS-prosess over et
  EKTE git-repo, med ny D-157-blokk **8/8** som gjenskaper den divergerte topologien med EKTE
  git-objekter: merge-treet beregnes av `git merge-tree --write-tree`, og BEGGE sammenlikningene
  utledes av samme `compareProjection` fra de virkelige objektene - så porten passerer bare dersom git
  er enig, og ingen fikstur kan «bli enig med» en bug. Blokken asserterer fiksturet FØR bruk, at
  `parent1->merge` per ekte git ER den reviewede deltaen, at tasken FULLFØRER med
  `merge_tree_sha !== head_tree_sha`, og at den FORTSATT holdes ved ureviewet innhold, uleselig
  sammenlikning og et område som inneholder mer enn merge-commiten.
- Den gamle «extra content»-saken er flyttet fra `TREE_MISMATCH` til `DELTA_FILE_SET_MISMATCH` - dit
  innholdet faktisk dukker opp.
- Full `ops/claude-worker`-akseptanse **39/39 filer, 1259/1259 tester**. Repo-`lint` og
  repo-`typecheck` rene.

## Blokkeringer

1. **Flake, ærlig rapportert.** `worker-crash-recovery.test.mjs` feilet to ganger under full parallell
   last (ULIKE tester, exit 3 og exit 4) og passerte deretter isolert **56/56** og i en full ren
   kjøring. Suiten spawner ekte OS-prosesser med timeouts og er lastfølsom, og den når ikke den
   endrede kodestien (en vanlig ikke-merge-task gjør null transition-lesninger). Ingen dekning er
   svekket, hoppet over eller nøytralisert.
2. **Forhøyet sesjon (uendret fra D-143/D-145..D-152).** Claude Code kjører FORHØYET, og PostgreSQL
   nekter å starte under en administrator-konto; lokalt feiler dessuten tester utenfor
   `ops/claude-worker` på den pre-eksisterende Windows-`.cjs`-spawn-klassen (`EFTYPE`). Begge klassene
   er uavhengige av denne endringen - den er avgrenset til `ops/claude-worker` + docs.
3. **To worker-testfiler kan ikke PARSES lokalt på Windows (pre-eksisterende, IKKE rørt her).**
   `deploy-cli.test.mjs` og `supervisor-run.test.mjs` feiler lokalt ved import fordi de er de eneste
   som `import`-erer en entrypoint med shebang, og shebang-linjen har CRLF på denne utsjekkingen.
   Urørt av D-157; autoritativt bevis for disse to filene er Linux-CI.
4. **Embedded-Postgres-flake (eksplisitt avdekket, IKKE rørt her).** Fortsatt kjent og udekket i
   repo-suiten utenfor `ops/claude-worker`.
5. **Merge.** `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` i D-157. Denne PR-en merges
   ikke før en NY `ARCHITECT_TASK` eksplisitt godkjenner det mot eksakt HEAD/base.
6. **D-156-rekonsiliasjon er BEVISST utsatt (per ordren).** D-156s beholdte record rekonsilieres
   først etter at denne fiksen er uavhengig reviewet, merget, post-merge-testet og deployet.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av denne draft-PR-en mot faktisk diff/tester/CI på eksakt HEAD. Deretter,
i rekkefølge: merge (egen `ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` og eksakt HEAD/base-guard),
deploy av worker `2.2.0`, så D-156-rekonsiliasjon - og først deretter UA-9.
