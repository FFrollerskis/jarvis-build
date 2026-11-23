# Kontobytte for GitHub: det du må gjøre på NAS-en og i GitHub (D-478, D-479, WP-A1)

Status: `BUILT` (kodestandardene) og `NOT VERIFIED` (ingenting av dette er kjørt mot ekte GitHub eller NAS). Eieren byttet GitHub-konto 2026-11-22 (D-478): `tsworkflow/jarvisbuild` er frosset og kan ikke skrives til; koden bor nå i **`FFrollerskis/jarvis-build`**.

## 1. Hva koden gjør nå (WP-A1, D-479)

- Standard repo er `CANONICAL_GITHUB_REPO` (`packages/contracts/src/github-repo.ts`) = `FFrollerskis/jarvis-build`. Den brukes når `JARVIS_GITHUB_REPO` ikke er satt, er tom eller er ugyldig (ikke `eier/navn`). **Din egen gyldige `JARVIS_GITHUB_REPO` vinner alltid.** En ugyldig verdi erstattes stille av standarden (ingen advarsel logges): sjekk at verdien er `eier/navn`.
- Standarden gjelder **GitHub-verktøyene**: repolåsen for modellstyrte kall (Q-50 B), oppløsning av repo-navn, daglig oppsummering (var hardkodet), connector-testen, mesh-verktøyet `read_github_issues`, og selvmodifikasjon. De bruker alle samme funksjon (`configuredGithubRepoFromEnv`), så de kan ikke peke ulike steder.
- **Kodejobber og GitHub App-modus har bevisst INGEN standard** (de skriver branches): de krever eksplisitt `JARVIS_GITHUB_REPO` eller `JARVIS_GIT_ALLOWED_REPOS` og feiler lukket uten. En ugyldig verdi stopper oppstarten av api og worker (`allowed_repos_invalid`).
- Akseptansescriptet `ops/job-runner/acceptance.sh` nekter HARDT det nåværende produksjonsrepoet og det gamle repoet som akseptanserepo, også med `.git`/`/`-alias og store bokstaver (en akseptanse pusher en ekte branch; JARVIS-117 c). I tillegg nektes `JARVIS_GITHUB_REPO`, men bare hvis variabelen er eksportert i shellet du kjører scriptet fra (scriptet leser ikke `.env`). Live-skriptet `github-app-live.ts` nekter de samme repoene som `--sandbox-repo`.
- Standarden gir **ingen tilgang** til noe: GitHub-kall trenger fortsatt en credential som er utstedt for repoet. Uten den feiler GitHub-verktøyene synlig (404/403), aldri stille.

## 2. FØR du oppdaterer NAS med denne koden

1. **Bytt `origin` i NAS-checkouten.** Alle `git pull`-trinnene i runbookene (`NAS_UPDATE_*`, `UA0_NAS_ACCEPTANCE`, `JOB_RUNNER`, `WPC4_VALUE_CENTER`, `WPG4_SITUATION_BRIDGES`, `WPI_CONNECTOR_SDK`) går mot `origin`, og den peker fortsatt på det gamle repoet som ikke lenger får nye commits:
   ```
   cd <NAS-checkouten>        # mappenavnet jarvisbuild kan beholdes (backup-skript og stier bruker det)
   git remote set-url origin https://github.com/FFrollerskis/jarvis-build.git
   git fetch origin && git remote -v && git status
   ```
   Historikken er den samme (nytt repo er en fork av det gamle), så `git pull` fungerer videre. NAS-en trenger tilgang til det nye repoet (offentlig lesing går uten innlogging).
2. **Kunnskapskilder (kun hvis du har en `github`-kilde i `JARVIS_KNOWLEDGE_SOURCES`).** En GitHub-kilde er låst til `JARVIS_GITHUB_REPO` (standarden er nå det nye repoet). Står kilden fortsatt på `tsworkflow/jarvisbuild` når workeren starter med ny kode og `JARVIS_GITHUB_REPO` tom, **avvises HELE kildelisten** (også fil-, Drive- og e-postkilder): workeren logger bare `knowledge_sources_config_rejected` og registrerer ingen kilder. Gjør ett av disse FØR oppdateringen: (a) endre kildens `repo` til `FFrollerskis/jarvis-build` og sett `JARVIS_GITHUB_REPO=FFrollerskis/jarvis-build`, eller (b) sett midlertidig `JARVIS_GITHUB_REPO=tsworkflow/jarvisbuild` til kilden er byttet. Kildens identitet er `id`-en du selv har gitt den i konfigurasjonen (ikke repo-navnet): bytter du repo under samme `id`, blandes gammelt og nytt innhold. Fjern den gamle kilden via sletting (erasure) og opprett en ny med ny `id`. Sjekk workerloggen etter oppstart.

## 3. Det bare du kan gjøre (aldri send nøkler i chat)

1. **Credential for det nye repoet.** Velg ÉN av:
   - **GitHub App (anbefalt, WP-C3):** følg [GITHUB_APP.md](GITHUB_APP.md) steg 1-6, men installer App-en på `FFrollerskis/jarvis-build` (installasjonen på den gamle kontoen virker ikke for det nye repoet). Hent ny installasjons-id; privatnøkkelen lagres i vaulten som før.
   - **PAT:** opprett en fin-granulert PAT på kontoen `FFrollerskis` med tilgang kun til `jarvis-build` og legg den i vaulten som `JARVIS_GITHUB_TOKEN` (erstatter den gamle verdien).
2. **`.env` på NAS-en:** sett `JARVIS_GITHUB_REPO=FFrollerskis/jarvis-build`. (Tom verdi gir standarden bare for GitHub-verktøyene og selvmodifikasjon; kodejobber og App-modus krever den eksplisitt, se avsnitt 1, og I App-modus er den påkrevd: `GITHUB_APP_SCOPE_UNDEFINED` ellers.) Står `JARVIS_GIT_ALLOWED_REPOS` i `.env`, bytt oppføringen til det nye repoet. Restart `api` og `worker`.
3. **Kodejobber (job-runner):** i `/etc/jarvis/job-runner.json` legg det nye repoet i `runner.allowed_repos` og `runner.git_credentials` (kapittel 8 i [JOB_RUNNER.md](JOB_RUNNER.md)) **med små bokstaver** (`ffrollerskis/jarvis-build`; store bokstaver gir `config_invalid:runner.allowed_repos:entry_invalid`); fjern det gamle når du er ferdig. Opprett et NYTT **sandbox-repo** under `FFrollerskis` til akseptansen (`ACCEPTANCE_REPO`) og legg det i samme lister. Akseptansen nekter produksjonsrepoet uansett.
4. **Valgene i Q-77** (merge-fullmakt, arkitektens tilgang, Actions og grenbeskyttelse): se [OPEN_QUESTIONS.md](../OPEN_QUESTIONS.md). Slå på Actions i forken (fanen Actions) for å få CI.

## 4. Verifisering (setter først da statusen `VERIFIED` per punkt)

| # | Sjekk | Forventet |
|---|---|---|
| 1 | `git -C <NAS-checkouten> remote -v` | `origin` peker på `FFrollerskis/jarvis-build` |
| 2 | Dashbordet: Integrasjoner -> GitHub -> live-test | `LIVE` mot `FFrollerskis/jarvis-build` (connector-testen leser issues i det konfigurerte repoet) |
| 3 | Chat: «list åpne PR-er» | svarer om `FFrollerskis/jarvis-build`; et spørsmål om `tsworkflow/jarvisbuild` avvises av repolåsen (med mindre du har satt `JARVIS_GITHUB_ALLOW_OTHER_REPOS=true`) |
| 4 | Daglig oppsummering (`jarvis-build`-kilden) | GitHub-issues fra det nye repoet, ikke fra det gamle |
| 5 | Workerloggen etter oppstart | ingen `knowledge_sources_config_rejected` |
| 6 | `ACCEPTANCE_REPO=FFrollerskis/jarvis-build ops/job-runner/acceptance.sh` (uten `--dry-run`; vernet kjører etter tørrkjøringen) | avvises med «PRODUKSJONSREPOET» (exit 2) før noe røres |

## 5. Det som IKKE er gjort (DEFERRED; krever dine valg i Q-77)

- Arbeidsløkken for arkitekten (`ops/claude-worker`: `repoOwner`/`trustedAuthor` er fortsatt `tsworkflow` i eksempel-konfigen) og kontrollkøen (issue #68 i det gamle repoet): ikke flyttet. Å endre `trustedAuthor` flytter en tillitsgrense og gjøres bare etter en navngitt beslutning (Q-77 pkt 1c).
- `infra/job-runner/job-runner.example.json` har fortsatt et sandbox-repo under den gamle kontoen som eksempel; sett inn ditt nye sandbox-repo i den faktiske konfigen.
- Historiske dokumenter, beslutninger og tester som nevner `tsworkflow/jarvisbuild` er bevisst ikke omskrevet (historikk).
- Ingen advarsel logges når `JARVIS_GITHUB_REPO` er ugyldig (standarden brukes stille); en oppstartsadvarsel er ikke bygget.
