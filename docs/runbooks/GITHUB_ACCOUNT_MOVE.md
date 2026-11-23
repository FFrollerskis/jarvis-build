# Kontobytte for GitHub: det du må gjøre på NAS-en og i GitHub (D-478, D-479, WP-A1)

Status: `BUILT` (kodestandardene) og `NOT VERIFIED` (ingenting av dette er kjørt mot ekte GitHub eller NAS). Eieren byttet GitHub-konto 2026-11-22 (D-478): `tsworkflow/jarvisbuild` er frosset og kan ikke skrives til; koden bor nå i **`FFrollerskis/jarvis-build`**.

## 1. Hva koden gjør nå (WP-A1, D-479)

- Standard repo er `CANONICAL_GITHUB_REPO` (`packages/contracts/src/github-repo.ts`) = `FFrollerskis/jarvis-build`. Den brukes bare når `JARVIS_GITHUB_REPO` ikke er satt (eller er ugyldig, uten `eier/navn`-form). **Din egen `JARVIS_GITHUB_REPO` vinner alltid.**
- GitHub-låsen for modellstyrte kall (Q-50 B), oppløsningen av repo-navn, daglig oppsummering (var hardkodet), connector-testen og mesh-verktøyet `read_github_issues` bruker alle samme standard, så de kan ikke peke ulike steder.
- Akseptansescriptet `ops/job-runner/acceptance.sh` nekter nå HARDT det nåværende produksjonsrepoet, det gamle repoet og en eventuell `JARVIS_GITHUB_REPO` som akseptanserepo (en akseptanse pusher en ekte branch; JARVIS-117 c).
- Standarden gir **ingen tilgang** til noe: GitHub-kall trenger fortsatt en credential som er utstedt for repoet (steg 2). Uten den feiler GitHub-verktøyene synlig (404/403), aldri stille.

## 2. Det bare du kan gjøre (aldri send nøkler i chat)

1. **Credential for det nye repoet.** Velg ÉN av:
   - **GitHub App (anbefalt, WP-C3):** følg [GITHUB_APP.md](GITHUB_APP.md) steg 1-6, men installer App-en på `FFrollerskis/jarvis-build` (installasjonen på den gamle kontoen virker ikke for det nye repoet). Hent ny installasjons-id; privatnøkkelen lagres i vaulten som før.
   - **PAT:** opprett en fin-granulert PAT på kontoen `FFrollerskis` med tilgang kun til `jarvis-build` og legg den i vaulten som `JARVIS_GITHUB_TOKEN` (erstatter den gamle verdien).
2. **`.env` på NAS-en:** sett `JARVIS_GITHUB_REPO=FFrollerskis/jarvis-build` (eller la den stå tom for standarden). I App-modus er den påkrevd (`GITHUB_APP_SCOPE_UNDEFINED` ellers). Står `JARVIS_GIT_ALLOWED_REPOS` i `.env`, bytt oppføringen til det nye repoet. Restart `api` og `worker`.
3. **Kodejobber (job-runner):** i `/etc/jarvis/job-runner.json` legg det nye repoet i `runner.allowed_repos` og `runner.git_credentials` (kapittel 8 i [JOB_RUNNER.md](JOB_RUNNER.md)) **med små bokstaver** (`ffrollerskis/jarvis-build`; store bokstaver gir `config_invalid:runner.allowed_repos:entry_invalid`); fjern det gamle når du er ferdig. Opprett et NYTT **sandbox-repo** under `FFrollerskis` til akseptansen (`ACCEPTANCE_REPO`) og legg det i samme lister. Akseptansen nekter produksjonsrepoet uansett.
4. **Kunnskapskilde `github:`** (hvis du har satt opp en GitHub-kilde i kunnskapsbasen): kildens id er `github:<eier/repo>` og skal aldri endres etter første synk (se `.env.example`). Å bytte repo betyr å fjerne den gamle kilden via sletting (erasure) og opprette en ny for `FFrollerskis/jarvis-build`.
5. **Valgene i Q-77** (merge-fullmakt, arkitektens tilgang, Actions og grenbeskyttelse): se [OPEN_QUESTIONS.md](../OPEN_QUESTIONS.md). Slå på Actions i forken (fanen Actions) for å få CI.

## 3. Verifisering (setter først da statusen `VERIFIED` per punkt)

| # | Sjekk | Forventet |
|---|---|---|
| 1 | Dashbordet: Integrasjoner -> GitHub -> live-test | `LIVE` mot `FFrollerskis/jarvis-build` (connector-testen leser issues i det konfigurerte repoet) |
| 2 | Chat: «list åpne PR-er» | svarer om `FFrollerskis/jarvis-build`; et spørsmål om `tsworkflow/jarvisbuild` avvises av repolåsen (med mindre du har satt `JARVIS_GITHUB_ALLOW_OTHER_REPOS=true`) |
| 3 | Daglig oppsummering (`jarvis-build`-kilden) | GitHub-issues fra det nye repoet, ikke fra det gamle |
| 4 | `ACCEPTANCE_REPO=FFrollerskis/jarvis-build ops/job-runner/acceptance.sh` (uten `--dry-run`; vernet kjører etter tørrkjøringen) | avvises med «PRODUKSJONSREPOET» (exit 2) før noe røres |

## 4. Det som IKKE er gjort (DEFERRED; krever dine valg i Q-77)

- Arkitekt-løkken (`ops/claude-worker`: `repoOwner`/`trustedAuthor` er fortsatt `tsworkflow` i eksempel-konfigen) og kontrollkøen (issue #68 i det gamle repoet): ikke flyttet. Å endre `trustedAuthor` flytter en tillitsgrense og gjøres bare etter en navngitt beslutning (Q-77 pkt 1c).
- `infra/job-runner/job-runner.example.json` har fortsatt et sandbox-repo under den gamle kontoen som eksempel; sett inn ditt nye sandbox-repo i den faktiske konfigen.
- Historiske dokumenter, beslutninger og tester som nevner `tsworkflow/jarvisbuild` er bevisst ikke omskrevet (historikk).
