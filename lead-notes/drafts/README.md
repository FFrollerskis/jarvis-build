# PR-dag: sjekkliste og rekkefølge (kun for den dagen GitHub virker igjen)

Alt i denne mappen er utkast skrevet offline. Ingenting er postet. Fakta er hentet fra `docs/DECISIONS_AND_ASSUMPTIONS.md` (D-459, D-463..D-466, D-471..D-476) på docs-grenen og fra `git`-målinger gjort 2026-11-20.

## 0. Forutsetninger (sjekk FØR første push)
- `git remote -v` må peke på `https://github.com/tsworkflow/jarvisbuild.git`; ellers STOPP og spør Tobias.
- `git fetch origin`; `origin/main` var `ec3e684e` (PR #335). Har main flyttet seg: merge `origin/main` inn i hver gren før push (vanlig merge, ALDRI rebase/force/reset).
- `git push --dry-run` virker og GitHub MCP (`mcp__github__*`) er tilkoblet. Hvis ikke: fortsatt `HARD_EXTERNAL_BLOCKER`.
- Pushes IKKE: `integration/*`, `worktree-agent-*`, `review-k`, `main`, og hjelperefene `wp-b4-backup-before-history-fix` / `wp-b4-rewrite`.
- `claude/lead-notes-2026-11` kan pushes som vanlig gren (sporbarhet), men får ALDRI PR og merges ALDRI til main.
- Sesjonsgrenen `claude/hva-skjer-hvordan-ligger-0z3ztp` (`ec3e684e` = `origin/main`) er 0 commits foran `origin/main`, men 591 commits foran den ELDRE eksterne sesjonsgrenen (`origin/claude/hva-skjer-hvordan-ligger-0z3ztp` = `c29aaf92`, 2026-10-05, PR #254). Det er det Stop-hooken teller. En push er en REN fast-forward (verifisert: `c29aaf92` er forfader til HEAD, 0 commits kun på den eksterne), den bærer ingen av mine endringer, og den er den billigste forbindelsestesten: GJØR DEN FØRST (`git push -u origin claude/hva-skjer-hvordan-ligger-0z3ztp`).

## 1. Avhengigheter (målt med `git merge-base --is-ancestor` og `git rev-list --count`)
- K, H1 og I er uavhengige av hverandre og av resten. H2 inneholder H1.
- B3, D3, B4 og G1 inneholder de endelige tipsene til K, H1, H2 og I; de er søsken (ingen av dem inneholder de andre helt).
- G2 og G3 inneholder dessuten B3 og D3 (endelige tips); de mangler 4 av B4s endelige commits og inneholder ikke G1.
- G4 inneholder K, H1, H2, I, B3, D3 og B4 (endelige tips), og TIDLIGERE versjoner av G1/G2/G3 (mangler 9, 23 og 26 av deres endelige commits).
- Docs-grenen (`claude/d471-d474-konsolidering`, 12 commits, 7 filer) inneholder ALLE beslutninger D-459..D-476, Q-63..Q-75 og JARVIS-101..115; WP-grenene har dem ikke.
- D-470-commiten `776f0ae8` ligger allerede på `origin/claude/d470-byggepause-opphevet` (PR #336: ikke verifisert, GitHub var utilgjengelig).

## 2. Anbefalt rekkefølge (alt som draft-PR, én om gangen mot `main`)
| # | Gren | Utkast | Venter på |
|---|------|--------|-----------|
| 1 | `claude/wp-k-ledger-rester` | pr-01 | – |
| 2 | `claude/wp-h1-control-centers` | pr-02 | – |
| 3 | `claude/wp-i-connector-sdk` | pr-04 | – |
| 4 | `claude/wp-h2-control-centers` | pr-03 | H1 merget |
| 5 | `claude/wp-b3-evolution-centers` | pr-05 | K, H1, H2, I merget |
| 6 | `claude/wp-d3-growth-writes` | pr-06 | K, H1, H2, I merget |
| 7 | `claude/wp-b4-claude-budget-pacing` | pr-07 | K, H1, H2, I merget |
| 8 | `claude/wp-g1-comms` | pr-08 | K, H1, H2, I merget |
| 9 | `claude/wp-g2-personal` | pr-09 | B3, D3 og G1 merget (+ testtilpasning `ca13dace`) |
| 10 | `claude/wp-g3-vision` | pr-10 | B3, D3 merget |
| 11 | `claude/wp-g4-situation-bridges` | pr-11 | B3, D3, B4, G2, G3 merget (+ testtilpasning `87b49a65`) |
| 12 | `claude/d471-d474-konsolidering` | pr-12 | oppdater `PROJECT_STATUS.md` først (se §4) |

Siden grenene er stablet via integrasjonsmerger viser PR-diffen mot `main` først kun egen endring når forgjengerne er merget. Åpnes PR-er tidligere, skriv i PR-teksten at diffen inneholder forgjengerne.

## 3. Per gren (kommandoer)
```
git fetch origin
git switch <gren>                      # eller en scratch-worktree
git merge --no-edit origin/main        # kun hvis main har flyttet seg (to-forelder-merge; ingen rebase)
pnpm -s typecheck && pnpm -s lint      # + de gren-spesifikke testene
/tmp/gitleaks-bin/gitleaks detect --source . --no-banner --log-opts="origin/main..HEAD"   # skal gi 0 funn
git push -u origin <gren>              # feiler det med nettverksfeil: prøv opptil 4 ganger med backoff
# deretter: opprett DRAFT-PR (mcp__github__create_pull_request, draft=true) med pr-NN-*.md som body, og
# kall subscribe_pr_activity for PR-en.
```
Testtilpasninger som må inn i riktig PR (som egne commits; begge er kun testfiler):
- **G2-PR:** `git cherry-pick ca13dace` (`apps/api/test/wpg1-comms-routes.test.ts`: kildevakten tåler `personal.filterTools`/`personal.tools`). Gjøres etter at G1 er i main og main er merget inn i G2-grenen. (`ca13dace` ligger også allerede i G4-grenens historikk.)
- **G4-PR:** `git cherry-pick 87b49a65` (`modules/situations/test/wpg2-autonomy-step-up.test.ts`: godtar både G4s og G2s bind-tid-feil, og beviser at `gateway.execute` på `critical_lock` gir `step_up_required:signed_device_session`). Gjøres etter at G2 er i main og main er merget inn i G4-grenen.
Nye kommits får trailerne `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` og `Claude-Session: https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4`.

## 4. Før docs-PR-en (pr-12)
- `docs/PROJECT_STATUS.md`: fjern/oppdater BLOKKERING-punktet («Ingen PR er opprettet og ingenting er merget etter D-470») og skriv inn PR-numrene; oppdater «Push- og PR-rekkefølge».
- `docs/OWNER_ACTIONS_HF1_HF2.md` §7: fjern GitHub-punktet hvis det er løst.
- Kjør dokumentvaktene på nytt (18 filer/292 tester på `integration/post-merge-test-2` @95380285).

## 5. Merge (kun når ALT dette er oppfylt)
- En `ARCHITECT_TASK` i issue #68 postet av repo-eieren med `ARCHITECT_MERGE_APPROVED=true`, eksakt `PR_NUMBER`, `EXPECTED_HEAD_SHA`, `EXPECTED_BASE_SHA` og `MERGE_METHOD=merge`; ELLER Tobias' eksplisitte stående fullmakt i en interaktiv økt (D-192). Ingen av delene er gitt til nå.
- CI grønn, alle tester består, ingen åpne sikkerhetsfunn eller review-tråder, eksakt HEAD-/base-guard rett før merge, kun to-forelder-merge (aldri squash/rebase), ingen selv-godkjenning som eneste kontroll.
- `HARD_EXTERNAL_BLOCKER` (credential som ikke finnes trygt, betaling, fysisk host-handling, juridisk aksept) stopper og varsler Tobias direkte.

## 6. Etter push
- Post `CLAUDE_REPORT` i issue #68 (kladd: `CLAUDE_REPORT-issue68.md`, versjon B).
- Oppdater `STATE.md` og `docs/PROJECT_STATUS.md`; avslutt den timevise sjekken når PR-ene er merget eller lukket.

## 7. Øvelse av rekkefølgen (gjort 2026-11-20, lokalt)
Hele PR-rekkefølgen er øvd som lokale to-forelder-merger fra `origin/main` (`ec3e684e`) i en temporær worktree. Sluttreet er IDENTISK med treet til `integration/post-merge-test-2` (`95380285`, full-suite-verifisert). Konfliktkart, løsninger og `git rerere`-cache: `rehearsal/CONFLICTS.md`, `rehearsal/resolve_lib.py`, `rehearsal/rr-cache.tgz`. Mellomtilstandene ligger som lokale `refs/rehearsal/*` (pushes ALDRI); de er ikke testet, så GitHub CI per PR avgjør dem.
