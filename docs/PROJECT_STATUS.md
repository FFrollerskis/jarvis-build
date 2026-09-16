# PROJECT STATUS

**Oppdatert:** 2026-09-16 (branch `claude/d157-merge-transition-tree-proof`, PR **#84**, base
`main=6f1c980c3493c6f68fe97bb2c8f045b4d196af75`). Aktiv ordre: **D-159**
(`D159-PR84-D158-RECOVERY-CLOSEOUT-20260916-A`, issue #68 kommentar 5702547705), som
**SUPERSEDES** den blokkerte `D158-PR84-SAME-FILE-MERGE-PROOF-HARDENING-20260915-A`.
`MERGE_AUTHORIZED=false`, `SELF_APPROVAL=false`, `HOST_ACCEPTANCE_REQUIRED=false`.

D-158 brukte opp 4/4 worker-forsøk på timeout og ble parkert BLOCKED med krav om frisk TASK_ID. Den
etterlot seg IKKE ufullført arbeid: task-worktreet var RENT på `f1962729`, og alle tre commitene over
den autoriserte basen bærer D-134-trailere (`f196272`/`478d238` → D-158, `2b8c7d4` → D-157). Det D-158
aldri produserte var sin TERMINALE RAPPORT, ikke sin implementasjon. **D-159 er rekonsiliasjon og
lukking av det eksisterende arbeidet** - ingen replay fra bunnen, ingen forkasting, ingen
reset/clean/stash/rebase/branch-erstatning/force-push.

PR #84 rettes fortsatt **på plass** og forblir DRAFT og UMERGET. PR #83/UA-9 og PR #85/UA-10 er URØRT.

Leveransen på denne branchen har nå tre deler, alle på samme PR: selve D-158-rettelsen, **REVIEW-FIX 1**
etter arkitekt-review 5216915623 (`CHANGES_REQUIRED`, P1 - beviset arvet vertens git-konfigurasjon), og
**D-159 / REVIEW-FIX 2** etter arkitekt-review 5217710904 (`CHANGES_REQUIRED`, P1, mot eksakt head
`f1962729` - bevisets arbeidskatalog var et delt, kryss-task navnerom). Se egne seksjoner under.

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

## REVIEW-FIX i samme leveranse (ferdig, testet) - innhold i repoet fikk velge en kommando

Uavhengig arkitekt-review **5216915623** på PR #84 (`RESULT=CHANGES_REQUIRED`, P1, mot head `478d238c`)
bekreftet at samme-fil-falsknegativen var lukket, og fant ÉN kontrollplan-blocker i selve
erstatningsbeviset: `spawnGit` sendte INGEN eksplisitt `env`, så hver git-invokasjon arvet vertens
miljø, mens `gitMergeTree` bare pinnet fem skalarer.

**Verifisert empirisk, ikke resonnert om - og verifikasjonen er en TEST, ikke en engangsmåling.** En
COMMITTET `.gitattributes` med `*.txt merge=evil`, pluss `merge.evil.driver` definert i vertens config,
får `git merge-tree --write-tree` til å KJØRE den kommandoen. Dette er ikke beskrevet i en kommentar, det
KJØRES i `merge-tree-proof.test.mjs` («THE DEFECT, EXECUTED»): testen merger de samme to ekte commitene
slik den ufiksede koden gjorde det, og asserterer at driveren faktisk skrev markørfila
(`existsSync(marker) === true`) - og deretter at den isolerte porten ikke gjør det. Repo-innhold som
velger en vertsdefinert kommando inne i en sikkerhetsport er **kodeeksekvering**, ikke en falsk negativ.
(Målingen som først avdekket dette viste også at denne vertens SYSTEM-config setter `core.autocrlf=true`
og `filter.lfs.*`, altså at «det forventede treet» var en funksjon av hvilken maskin som regnet det ut.)

**Tre lag, ingen av dem betrodd alene:**

1. **ISOLER** (`withGitEnv`/`isolatedGitEnv`): hver invokasjon som REGNER UT eller LESER beviset kjører
   med `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_SYSTEM`/`GIT_CONFIG_GLOBAL` mot en fil som skrives TOM hver
   kjøring, `GIT_ATTR_NOSYSTEM`, `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME` mot en tom katalog, og med
   `GIT_CONFIG_PARAMETERS`/`_COUNT`/`_KEY_n`/`GIT_DIR`/`GIT_WORK_TREE`/`GIT_ATTR_SOURCE` m.fl. FJERNET.
   Env-en er opt-in per kall - alle andre kallsteder arver miljøet som før, fordi en generell sanering
   stille ville endret hvordan workeren AUTENTISERER. **FETCH-en beholder bevisst vertsmiljøet:** den
   trenger vertens credentials, regner ikke ut noe, og `git fetch <url> <sha>` er innholdsadressert - en
   omskrevet URL eller en fiendtlig helper kan bare få den til å FEILE, aldri bytte ut innhold.
2. **VALIDER:** effektiv config listes med origin (`config --list --show-origin -z`), og HVER oppføring
   må komme fra proof-storets EGEN config og stå på en smal allowlist, ellers
   `MERGE_TREE_CONFIG_NOT_ISOLATED` med nøyaktig nøkkel og origin i beviset. En `include.path` løses opp
   til sin EGEN origin og blir dermed synlig; et gjenbrukt/stale store avvises i stedet for å gjelde; en
   fremtidig git som skriver en ny nøkkel gir et AVSLAG (trygg retning). Stale `$GIT_DIR/info/attributes`
   fjernes fra det gjenbrukte storet.
3. **AVVIS AMBIGUITET:** en driver kan være BEDT OM uten å være definert, og git faller da STILLE tilbake
   til innebygd merge (målt) - et ANNET tre enn på en maskin som har driveren. Derfor leses hver
   `.gitattributes` i base-, head- og merge-base-treet, og `merge=<navn>` utenfor git sine innebygde
   `text`/`binary`/`union` gir `MERGE_TREE_DRIVER_REQUESTED`. Makroer (`[attr]`) og nestede attributtfiler
   dekkes; kommentarer og vanlige attributter (`text=auto`, `-merge`, `merge=union`, `binary`) gjør det ikke.

I tillegg pinnes `merge.default=text`, `merge.renormalize=false` og `core.attributesFile` (tom fil) på
kommandolinjen. `config_isolated`/`custom_merge_drivers` er `null` til de faktisk er fastslått, og
UTTALT `false` og UUTTALT `null` avvises likt - et uspurt spørsmål er ikke et nei.

`WORKER_VERSION` forblir **`2.3.0`**: den er aldri deployet noe sted, så det finnes ingen deployment å
skille FRA, og en 2.4.0 for en draft-rettelse ville registrert en versjon som aldri kjørte.

**Ingenting av D-134..D-157 er svekket.** Eksakt-SHA-autorisasjon, PR-registrert merge-SHA, ordnet
two-parent-struktur, avvisning av squash/rebase, påkrevd review på eksakt head, påkrevd pre- og
post-merge-CI med eksakte jobb-identiteter på eksakt merge-SHA, uforanderlig ordre-/task-binding,
commit-proveniens, den smale «kun merge-commiten»-unnskyldelsen, dirty-/isolasjonsportene og «ingen
self-approval» står uendret. En flyttet HEAD er fortsatt kun en OBSERVASJON. En vanlig ikke-merge-task
koster fortsatt NULL remote-kall og null git-beregning. `WORKER_VERSION` `2.2.0` → `2.3.0`;
`lib/merge-tree-proof.mjs` og `lib/merge-tree.mjs` lagt til deploy-payloaden.

## D-159 / REVIEW-FIX 2 (ferdig, testet) - bevisets arbeidskatalog tilhører ÉN task

Arkitekt-review **5217710904** mot eksakt head `f1962729` bekreftet at REVIEW-FIX 1 var lukket, og fant
én gjenstående isolasjons-/proveniens-blocker (P1):

    mergeProofStorePath(cfg)  ->  join(cfg.scratchRoot, "merge-proof.git")
    mergeProofEnvPaths(cfg)   ->  join(cfg.scratchRoot, "merge-proof-env")

Et DELT, KRYSS-TASK navnerom - gjenbrukt mellom kjøringer, med env-filene trunkert,
`objects/info/alternates` overskrevet og `info/attributes` tvangsfjernet.

**Å isolere og allowliste KONFIGURASJONEN sier ingenting om hvem som eier FILENE.** Tre konsekvenser:
tilstand en annen task etterlot seg er INPUT til denne sikkerhetsporten (og allowlisten er ikke et
generelt svar - alternates, attributes og objektdatabasen er ikke config); porten SLETTER og TRUNKERER
stier den ikke kan bevise at den eier, som er det ene ordren forbyr overalt ellers i workeren; og to
samtidige tasks deler ett store, så ingen av dem kan si hvem beviset beskriver.

**Rettelsen - eierskap er et sjekket faktum, ikke en navnekonvensjon.** Begge katalogene ligger nå under
`join(scratchRoot, taskId)`, taskens EGEN autoriserte scratch-katalog (den samme `worker.mjs` allerede
gir barnet), og eierskapet fastslås FØR noe opprettes, skrives eller fjernes:

- **CLAIM** - en katalog som ikke finnes opprettes og stemples med `jarvis-merge-proof-owner.json`, som
  navngir nøyaktig denne task-iden og `kind` (`merge-proof-store` / `merge-proof-env`).
- **PROVE** - en katalog som ALLEREDE finnes må bære den markøren, og den må navngi denne eksakte
  task-iden og kind. Fremmed markør, umarkert katalog, uleselig/feilformet markør, feil `kind` og ukjent
  fremtidig markør-versjon feiler alle LUKKET, **uten å slette, trunkere eller overskrive noe**. Et
  RESUME av SAMME task finner sin egen markør og gjenbruker objektene sine, så gjenbruk forblir additiv.
  Den eneste skrivingen inn i en katalog som allerede finnes er markøren selv med `wx`, så den kan ikke
  overskrive en annen attempts markør; read-back avgjør eierskapet i begge tilfeller.
- **CONTAIN** - to uavhengige lag mot omdirigering: hver eksisterende sti-komponent fra `scratchRoot` og
  nedover må være en EKTE katalog, aldri en symlink/junction/reparse-point (sjekket FØR opprettelse,
  fordi rekursiv `mkdir` følger en lenke som allerede er der), og etterpå må `realpathSync` av det som
  ble claimet fortsatt ligge inne i `realpathSync(scratchRoot)`. En TASK_ID som ikke er et gyldig
  sti-segment er ikke en task-id: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` utelukker `.`/`..`, begge
  separatorene, drivbokstav, UNC-prefiks og ADS-`:`.

**Og den rene avgjøreren sjekker bindingen på nytt.** `computeMergeTree` tar `taskId` fra autorisasjonen
(den uforanderlige admitterte ordren) og ekkoer `store_owned`/`store_owner_task_id` inn i posten;
`verifyMergeTreeProof` tar `taskId` og avviser fire adskilte ting med `MERGE_TREE_STORE_NOT_TASK_OWNED`:
ingen task navngitt, eierskap NEKTET, eierskap aldri UTTALT (`null` avvises likt som `false`), og bevis
laget for en ANNEN task. Eierskapsspørsmålet stilles FØR alt annet om resultatet, fordi det avgjør om
resten av posten i det hele tatt beskriver denne taskens arbeid.

**Ingenting er svekket.** Det eksakte fulltre-beviset, base-only-hunker, konfliktdeteksjon, avvisning av
manuell konfliktløsning, git-config-/driver-isolasjonen fra REVIEW-FIX 1, eksakt autorisert base/head,
ordnet two-parent-topologi, uavhengig review på eksakt head, eksakt påkrevd pre-merge-CI, eksakte
post-merge-CI-jobbidentiteter på eksakt merge-SHA, uforanderlig task-/ordre-binding, proveniens/
isolasjon, dirty-worktree-portene og «ingen self-approval» står alle uendret. `WORKER_VERSION` forblir
`2.3.0` - fortsatt aldri deployet, så det finnes ingen deployment å skille FRA.

## Bevis

- **Modellen er verifisert mot EKTE historikk før én linje kode ble skrevet:**
  `git merge-tree --write-tree 091ba091 170e5810` → `eef13c740e69b11c2e1007b2a6b9303e3eda393d`, som er
  nøyaktig treet GitHubs egen merge-commit `6f1c980c` peker på. Altså PR #82s divergerte
  17-commits-bak-topologi, reprodusert eksakt av modellen som nå håndhever.
- **D-159-bevis (REVIEW-FIX 2), målt mot det EKTE filsystemet - bytes før og etter:**
  `merge-tree-proof.test.mjs` **88/88** (var 63/63) med en ny D-159-blokk som dekker: begge katalogene
  stemplet med egen markør under `scratchRoot/<TASK_ID>`; to ulike task-ider som får hvert sitt store,
  der ingen av dem avgjør den andre; umarkert eksisterende store AVVIST med **null byte endret** og
  ingen markør skrevet inn i det; store eid av en ANNEN task avvist med den andres arbeid intakt;
  uleselig, ukjent-versjon og feil-`kind` markør avvist uten å erstattes; umarkert ENV-katalog avvist
  uten at filene trunkeres (og storet aldri nådd); store OG env OG task-rot nådd gjennom
  junction/symlink avvist med **null skrevet på den andre siden av lenken**; sti-komponent som er en FIL
  avvist; en tabell av 14 sti-escape-forsøk (`..`, `a/b`, `a\b`, `C:evil`, tom, blank, `null`, tall …)
  som alle avvises **og ikke bringer én katalog til eksistens**; resume av samme task som beholder det
  et tidligere forsøk hentet; og at stale `info/attributes` fortsatt fjernes - men kun fra storet den
  eier. `merge-transition.test.mjs` **80/80** (var 77/77, tre nye refusjonssaker i den omkringliggende
  porten). `worker-merge-transition.test.mjs` **53/53** (var 51/51) med to nye ende-til-ende-tester mot
  EKTE `worker.mjs run`: at den ekte porten faktisk regner i `scratchRoot/<TASK_ID>` med markør (og at
  den gamle delte plasseringen ikke lenger opprettes i det hele tatt), og at den HOLDES med
  `MERGE_TREE_STORE_NOT_TASK_OWNED` når katalogen tilhører en annen task - uten at den andres filer
  eller markør røres. `postmerge-evidence.test.mjs` **60/60** uendret grønn.
- **REVIEW-FIX 1-bevis:** `merge-tree-proof.test.mjs` **63/63** (var 45/45), inkludert en test som
  **KJØRER DEFEKTEN**: samme to ekte commiter, merget slik den ufiksede koden merget dem, kjører faktisk
  driveren og skriver markørfila (`existsSync(marker) === true`) - og deretter at den isolerte porten
  verken kjører den (`existsSync(marker) === false`) eller aksepterer mergen, at vertens globale config
  aldri når beregningen (`config_isolated === true`, `foreign_config === []`), at env-injisert
  `GIT_CONFIG_KEY_0` strippes, at `include.path` og en ikke-allowlistet nøkkel i storet avvises, at stale
  `info/attributes` fjernes, at nestede attributtfiler og `[attr]`-makroer fanges, og at vanlige
  attributter (`text=auto`, `-merge`, `merge=union`, `binary`) fortsatt PASSERER.
  `merge-transition.test.mjs` **77/77** (var 73/73) med fire nye refusjonssaker i den omkringliggende
  porten. `postmerge-evidence.test.mjs` **60/60** og `worker-merge-transition.test.mjs` **51/51** uendret
  grønne etter rettelsen.
- Grunnleveransens egne saker (var 45/45 før review-fixen, nå del av de 63). Ren-verifikator-grener drevet eksakt, pluss EKTE
  git-topologier der git regner ut trærne: forskjellige filer PASS; **ikke-overlappende hunker i samme
  fil PASS** (den refuserte saken); base allerede inneholdt av head PASS; overlappende hunker BLOCKED
  som konflikt; manuelt løst konflikt presentert som normal merge BLOCKED; ekstra fil, droppet hunk,
  endret hunk, **endret base-only-hunk**, endret filmodus alle BLOCKED; squash og feil/reverserte
  foreldre BLOCKED fra objektet; manglende objekt, forkortet SHA og uleselig repo BLOCKED; fetch fra
  feil origin nektet. To isolasjonstester asserterer at repoets objektlager, refs, HEAD og `status` er
  BIT-IDENTISKE før og etter beregningen, og at et eksisterende scratch-lager gjenbrukes, ikke slettes.
  En tredje isolasjonstest asserterer at **rename-deteksjon er pinnet**: samme to commiter gir samme
  forventede tre selv når VERTENS globale config slår rename-deteksjon AV (etter review-fixen er en slik
  nøkkel i proof-storets EGEN config ikke lenger overstyrt, men et AVSLAG - egen test). Verifisert som ikke-vakuøs ved
  å fjerne pinningen - da blir en fullt gyldig «base omdøper filen, head redigerer den under sitt gamle
  navn»-merge rapportert som KONFLIKT, altså samme falsk-negativ-klasse D-158 lukker, gjennom en annen dør.
- `merge-transition.test.mjs` **77/77**, `postmerge-evidence.test.mjs` **60/60**.
- `worker-merge-transition.test.mjs` **51/51** mot EKTE `worker.mjs run` som ekte OS-prosess over et
  EKTE git-repo, inkludert en ny **D-158-REGRESJONSBLOKK**: den bygger samme-fil/ikke-overlappende
  topologi av ekte commiter, **KJØRER D-157s EGEN PROJEKSJONS-LIKHETSREGEL** (bevart som
  `d157ProjectionEquality` i fiksturene, kun som vitne for en lukket bug) og asserterer at den FEILER
  på `blobSha` for `shared.txt` - og deretter at den RETTEDE porten FULLFØRER nøyaktig samme merge.
  Samme blokk holder fortsatt porten når den reviewede hunken droppes, og når de samme to sidene
  kolliderer i en ekte konflikt.
- Full `ops/claude-worker`-akseptanse, målt på nytt mot DENNE nøyaktige treet etter D-159 (2026-09-16):
  **37/39 filer, 1309/1309 tester GRØNNE** (varighet 1328,71 s). De to filene som ikke er grønne er
  `deploy-cli.test.mjs` og `supervisor-run.test.mjs`, og de FEILER VED LASTING (null tester kjørt) - se
  blokkering 3. Begge er urørt av D-159: `git diff f1962729 --` mot dem er TOM. D-157-rapporten oppga
  «39/39 filer, 1259/1259»; **det reproduserer ikke i dette miljøet**, og det rapporteres som det er i
  stedet for å omskrives til en pass.
- **Prosess-timeout-flaken, ISOLERT i stedet for bortforklart.** Hver kjøring som inkluderer
  `merge-tree-proof.test.mjs` rapporterer én unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"`.
  Det er en RAPPORTØR-RPC-timeout mellom vitest sin worker og hovedprosessen, ikke en testfeil, og den
  koster INGEN dekning: hver eneste test i hver slik kjøring ble kjørt og passerte (1309/1309 fullt,
  281/281 fokusert, 88/88 for fila alene). Lokalisert ved re-kjøring: fraværende i
  `worker-merge-transition` alene (51/51, 199 s) og i tre tunge suiter D-159 ikke rører i det hele tatt
  (`worker-crash-recovery` + `worker-task-worktree` + `worker-crash-provenance`, 97/97, 429 s). Den er
  IKKE innført av de nye D-159-testene: den var allerede der da fila fortsatt hadde D-158s egne 63
  testkropper. **Ikke bevist pre-eksisterende** på det umodifiserte `f1962729`-treet - det ville krevd å
  mutere en annen tasks worktree - og rapporteres som målt, ikke som påstått. Ingenting er svekket eller
  hoppet over for å få den til å forsvinne.
- Repo-`lint` (`eslint .`) og repo-`typecheck` (`pnpm -r run typecheck`) rene.

## Blokkeringer

1. **Merge.** `MERGE_AUTHORIZED=false` og `SELF_APPROVAL=false` i D-159. PR #84 merges ikke
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
   **Uendret av D-159:** begge filene er fortsatt byte-identiske med `f1962729`.
4. **Embedded-Postgres-flake (eksplisitt avdekket, IKKE rørt her).** Fortsatt kjent og udekket i
   repo-suiten utenfor `ops/claude-worker`.
5. **D-156-rekonsiliasjon er BEVISST utsatt (per ordren).** D-156s beholdte record rekonsilieres først
   etter at denne fiksen er uavhengig reviewet, merget, post-merge-testet og deployet.
6. **Deploy.** Worker `2.3.0` er IKKE deployet. Den kjørende workeren er fortsatt en eldre versjon.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av denne draft-PR-en mot faktisk diff/tester/CI på eksakt HEAD. Deretter,
i rekkefølge: merge (egen `ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` og eksakt HEAD/base-guard),
deploy av worker `2.3.0`, så D-156-rekonsiliasjon - og først deretter UA-9.
