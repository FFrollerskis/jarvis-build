# Kontobytte for GitHub: det du må gjøre på NAS-en og i GitHub (D-478, D-479, WP-A1)

Status: `BUILT` (kodestandardene) og `NOT VERIFIED` (ingenting av dette er kjørt mot ekte GitHub eller NAS). Eieren byttet GitHub-konto 2026-11-22 (D-478): `tsworkflow/jarvisbuild` er frosset og kan ikke skrives til; koden bor nå i **`FFrollerskis/jarvis-build`** (forken het `FFrollerskis/jarvisbuild` før omdøpingen, og GitHub videresender det gamle navnet).

## 1. Hva koden gjør nå (WP-A1, D-479)

- Standard repo er `CANONICAL_GITHUB_REPO` (`packages/contracts/src/github-repo.ts`) = `FFrollerskis/jarvis-build`. Den brukes når `JARVIS_GITHUB_REPO` ikke er satt, er tom eller er ugyldig (ikke `eier/navn`). **Din egen gyldige `JARVIS_GITHUB_REPO` vinner alltid.** En ugyldig verdi erstattes stille av standarden (ingen linje i loggen), men kontrollsenteret viser den: Autoritet -> Eksterne begrensninger -> «GitHub-repo-lås» sier hvilket repo som gjelder og om det kommer fra `JARVIS_GITHUB_REPO` eller er standarden, og gir **WARN** hvis det fortsatt er det gamle repoet.
- Standarden gjelder **GitHub-verktøyene**: repolåsen for modellstyrte kall (Q-50 B), oppløsning av repo-navn, daglig oppsummering (var hardkodet), connector-testen, mesh-verktøyet `read_github_issues`, og selvmodifikasjon. De bruker alle samme funksjon (`configuredGithubRepoFromEnv`), så de kan ikke peke ulike steder.
- Forkortelsen `jarvisbuild` (D-429: modellen sier bare «jarvisbuild») blir `<eier>/jarvisbuild` og avvises nå av repolåsen, fordi repoet heter `jarvis-build`. Modellen får svar om hvilket repo som er tillatt og kan prøve igjen.
- **Kodejobber og GitHub App-modus har bevisst INGEN standard** (de skriver branches): de krever eksplisitt `JARVIS_GITHUB_REPO` eller `JARVIS_GIT_ALLOWED_REPOS` og feiler lukket uten. En ugyldig verdi stopper oppstarten av api og worker (`allowed_repos_invalid`).
- **Produksjonsvern for akseptanse og live-skript (JARVIS-117 c):** `ops/job-runner/acceptance.sh` nekter HARDT det nåværende repoet, forkets tidligere navn (`FFrollerskis/jarvisbuild`), det gamle repoet og `JARVIS_GITHUB_REPO` (fra shellet du kjører fra OG fra `.env` i repoets rot, eller filen i `ACCEPTANCE_ENV_FILE`) som akseptanserepo, også som `.git`/`/`-alias, med store bokstaver og med blanke. En akseptanse pusher en ekte branch; det finnes ingen overstyring. `ACCEPTANCE_REPO` gjøres om til små bokstaver (`runner.allowed_repos` krever det). Live-skriptene `github-app-live.ts` (`--sandbox-repo`) og `ua5-github-live.ts` (repo er PÅKREVD, ingen standard) nekter samme sett.
- Standarden gir **ingen tilgang** til noe: GitHub-kall trenger fortsatt en credential som er utstedt for repoet. **Repoet er offentlig**, så LESING kan lykkes selv med en credential som ikke er utstedt for det; SKRIVING feiler (403/404) uten riktig credential. En GitHub-lesing som feiler er synlig: connector-testen viser feil, og den daglige oppsummeringen viser «GitHub-issues utilgjengelige» i stedet for å late som det ikke finnes issues.
- **Offentlig repo = større injeksjonsflate:** PR-titler og issue-tekst fra hvem som helst når modellen via leseverktøyene som UBETRODD data (regel 7), og handlinger krever fortsatt bekreftelse og repolåsen. Det er ingen kodefeil, men flaten er større enn for et privat repo; vurder privat repo hvis du ikke vil ha den.

## 2. FØR du oppdaterer NAS med denne koden

1. **Bytt `origin` i NAS-checkouten.** Alle `git pull`-trinnene i runbookene (`NAS_UPDATE_*`, `UA0_NAS_ACCEPTANCE`, `JOB_RUNNER`, `WPC4_VALUE_CENTER`, `WPG4_SITUATION_BRIDGES`, `WPI_CONNECTOR_SDK`) går mot `origin`, og den peker fortsatt på det gamle repoet som ikke lenger får nye commits (resultatet blir en stille «Already up to date», og ingenting av dette når NAS-en):
   ```
   cd <NAS-checkouten>        # mappenavnet jarvisbuild kan beholdes (backup-skript og stier bruker det)
   git remote set-url origin https://github.com/FFrollerskis/jarvis-build.git
   git fetch origin && git remote -v && git status
   ```
   Historikken er den samme (nytt repo er en fork av det gamle), så `git pull` fungerer videre. NAS-en trenger tilgang til det nye repoet (offentlig lesing går uten innlogging).
2. **Kunnskapskilder (kun hvis du har en `github`-kilde i `JARVIS_KNOWLEDGE_SOURCES`).** En GitHub-kilde er låst til `JARVIS_GITHUB_REPO` (standarden er nå det nye repoet). Står kilden fortsatt på `tsworkflow/jarvisbuild` når workeren starter med ny kode og `JARVIS_GITHUB_REPO` tom, **avvises HELE kildelisten** (også fil-, Drive- og e-postkilder): workeren logger bare `knowledge_sources_config_rejected` og registrerer ingen kilder. Gjør ett av disse FØR oppdateringen: (a) endre kildens `repo` til `FFrollerskis/jarvis-build` og sett `JARVIS_GITHUB_REPO=FFrollerskis/jarvis-build`, eller (b) sett midlertidig `JARVIS_GITHUB_REPO=tsworkflow/jarvisbuild` til kilden er byttet. Kildens identitet er `id`-en du selv har gitt den i konfigurasjonen (ikke repo-navnet): bytter du repo under samme `id`, blandes gammelt og nytt innhold. Fjern den gamle kilden via sletting (erasure) og opprett en ny med ny `id`. Sjekk workerloggen etter oppstart.
3. **Står `.env` fortsatt på det gamle repoet** (`JARVIS_GITHUB_REPO=tsworkflow/jarvisbuild`), virker lesing, men ingenting nytt havner i det nye repoet; den første skrivingen feiler. Kontrollsenteret gir WARN på «GitHub-repo-lås» i det tilfellet (se avsnitt 1). Rett verdien i avsnitt 3 under.

## 3. Det bare du kan gjøre (aldri send nøkler i chat)

1. **Credential for det nye repoet.** Velg ÉN av:
   - **GitHub App (anbefalt, WP-C3):** en GitHub App tilhører kontoen som oppretter den. Opprett App-en på nytt under kontoen `FFrollerskis` ([GITHUB_APP.md](GITHUB_APP.md) steg 1-6, «Only on this account»); du får en **ny App-id og en NY privatnøkkel** (lagres i vaulten som før, men med den nye verdien), og App-en installeres på `FFrollerskis/jarvis-build`. Installasjonen/nøkkelen fra den gamle kontoen virker ikke for det nye repoet.
   - **PAT:** opprett en fin-granulert PAT på kontoen `FFrollerskis` med tilgang kun til `jarvis-build` og legg den i vaulten som `JARVIS_GITHUB_TOKEN` (erstatter den gamle verdien).
2. **`.env` på NAS-en:** sett `JARVIS_GITHUB_REPO=FFrollerskis/jarvis-build`. (Tom verdi gir standarden bare for GitHub-verktøyene og selvmodifikasjon; kodejobber og App-modus krever den eksplisitt, se avsnitt 1, og i App-modus er den påkrevd: `GITHUB_APP_SCOPE_UNDEFINED` ellers.) Står `JARVIS_GIT_ALLOWED_REPOS` i `.env`, bytt oppføringen til det nye repoet. **Gjenskap `api` og `worker` med `docker compose up -d`** (en vanlig `restart` leser ikke ny `.env`).
3. **Kodejobber (job-runner):** i `/etc/jarvis/job-runner.json` legg det nye repoet i `runner.allowed_repos` og `runner.git_credentials` (kapittel 8 i [JOB_RUNNER.md](JOB_RUNNER.md)) **med små bokstaver** (`ffrollerskis/jarvis-build`; store bokstaver gir `config_invalid:runner.allowed_repos:entry_invalid`); fjern det gamle når du er ferdig. Opprett et NYTT **sandbox-repo** under `FFrollerskis` til akseptansen (`ACCEPTANCE_REPO`; store bokstaver i variabelen er greit, scriptet gjør dem om) og legg det i samme lister. Akseptansen nekter produksjonsrepoet uansett.
4. **Issues i forken.** GitHub slår Issues AV i forker. Connector-testen og den daglige oppsummeringen leser issues (`read_issues`) og får da vanligvis `410` fra GitHub (avledet fra GitHubs dokumentasjon, ikke kjørt mot ekte GitHub): testen viser feil, og oppsummeringen sier «GitHub-issues utilgjengelige». Slå på Issues (Settings -> General -> Features -> Issues) hvis du vil ha dem; det er ellers forventet at de to feiler. (Kontrollkøen i issue #68 ligger fortsatt i det gamle repoet, Q-77 pkt 2.)
5. **Rydd bort den gamle credentialen** når det nye repoet virker: slett den gamle PAT-en og den gamle App-privatnøkkelen fra vaulten (Infisical), og hvis du fortsatt kan logge inn på den gamle kontoen, tilbakekall dem også der. De er verdiløse for det nye repoet, men er fortsatt hemmeligheter.
6. **Valgene i Q-77** (merge-fullmakt, arkitektens tilgang, Actions og grenbeskyttelse): se [OPEN_QUESTIONS.md](../OPEN_QUESTIONS.md). Slå på Actions i forken (fanen Actions) for å få CI.

## 4. Verifisering (setter først da statusen `VERIFIED` per punkt)

| # | Sjekk | Forventet |
|---|---|---|
| 1 | `git -C <NAS-checkouten> remote -v` | `origin` peker på `FFrollerskis/jarvis-build` |
| 2 | Kontrollsenteret: Autoritet -> Eksterne begrensninger -> «GitHub-repo-lås» | `OK`, «Låst til FFrollerskis/jarvis-build» (WARN betyr gammelt repo eller åpnet lås) |
| 3 | Dashbordet: Integrasjoner -> GitHub -> live-test (krever Issues PÅ i forken, avsnitt 3 pkt 4) | `LIVE` mot `FFrollerskis/jarvis-build` (connector-testen leser issues i det konfigurerte repoet) |
| 4 | Chat: «list åpne PR-er» | svarer om `FFrollerskis/jarvis-build`; et spørsmål om `tsworkflow/jarvisbuild` avvises av repolåsen (med mindre du har satt `JARVIS_GITHUB_ALLOW_OTHER_REPOS=true`) |
| 5 | Daglig oppsummering (`jarvis-build`-kilden; krever Issues PÅ) | GitHub-issues fra det nye repoet, ikke fra det gamle (uten Issues: «GitHub-issues utilgjengelige») |
| 6 | Workerloggen etter oppstart | ingen `knowledge_sources_config_rejected` |
| 7 | `ACCEPTANCE_REPO=FFrollerskis/jarvis-build ops/job-runner/acceptance.sh` (uten `--dry-run`; vernet kjører etter tørrkjøringen) | avvises med «PRODUKSJONSREPOET» (exit 2) før noe røres |

## 5. Det som IKKE er gjort (DEFERRED; krever dine valg i Q-77)

- Arbeidsløkken for arkitekten (`ops/claude-worker`: `repoOwner`/`trustedAuthor` er fortsatt `tsworkflow` i eksempel-konfigen) og kontrollkøen (issue #68 i det gamle repoet): ikke flyttet. Å endre `trustedAuthor` flytter en tillitsgrense og gjøres bare etter en navngitt beslutning (Q-77 pkt 1c).
- `infra/job-runner/job-runner.example.json` har fortsatt et sandbox-repo under den gamle kontoen som eksempel; sett inn ditt nye sandbox-repo i den faktiske konfigen.
- Historiske dokumenter, beslutninger, evidens-runbooks (D103/D105) og tester som nevner `tsworkflow/jarvisbuild` er bevisst ikke omskrevet (historikk).
- Ingen linje logges ved oppstart når `JARVIS_GITHUB_REPO` er ugyldig (standarden brukes stille); kontrollsenteret viser det i stedet.
- Forkets tidligere navn (`FFrollerskis/jarvisbuild`) er bare lagt til i produksjonsvernene (akseptanse og live-skript). Repolåsen trenger det ikke: den er strengere og avviser alt som ikke er det konfigurerte repoet.
