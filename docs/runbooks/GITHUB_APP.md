# GitHub App-autentisering for Jarvis (WP-C3, Q-45 b / D-35)

**Status: BYGGET OG ENHETSTESTET MOT EN LOKAL FAKE GITHUB - IKKE VERIFISERT MOT EKTE GITHUB.** Ingenting under er kjørt av Claude mot github.com. Hele
oppsettet nedenfor er eierhandlinger (Tobias). Akseptansescriptet `modules/tool-gateway/scripts/github-app-live.ts` sier `NOT VERIFIED` til du har kjørt det
og sluttlinjen er `GITHUB_APP_LIVE_STATUS=VERIFIED`.

## Hva dette er, og hva som er uendret

I dag bruker Jarvis en PAT (`JARVIS_GITHUB_TOKEN`): langlevd og knyttet til en brukerkonto. Med en GitHub App får Jarvis i stedet et **installasjonstoken**:
KORTLEVD (1 time), **repo-scopet** (kun repoene du har konfigurert) og utstedt av en nøkkel som kan roteres uten å røre brukerkontoen din. Q-45 (b) i
`docs/OPEN_QUESTIONS.md` ba om nettopp dette.

Dette er en bedre AUTENTISERINGSMETODE bak den eksisterende GitHub-adapteren - ikke en ny leverandør (CLAUDE.md regel 12) og ingen endring i hva Jarvis kan
(regel 11 / D-41): alle 23 `github.*`-handlinger, risikoklassene A-D, preflight/readback, kill switch, tilbakekalling, rate-limit-kontrolleren og repo-/allowlist-
reglene er uendret. Verdien bak `JARVIS_GITHUB_TOKEN` byttes bare ut.

| | PAT (i dag) | GitHub App (WP-C3) |
|---|---|---|
| Levetid | til du roterer den | 1 time, fornyes automatisk (5 min før utløp) |
| Scope | alt PAT-en rekker | kun `JARVIS_GIT_ALLOWED_REPOS`, ellers `JARVIS_GITHUB_REPO` (aldri «alle repoer») |
| Identitet | din brukerkonto | `<app-navn>[bot]` (handlinger tilskrives App-en) |
| Rate limit | din brukers kvote | installasjonens egen kvote (min. 5 000/t; vokser med repoer/brukere opp til 12 500/t) |
| Lagring | `JARVIS_GITHUB_TOKEN` | privatnøkkel i **vaulten** (`JARVIS_GITHUB_APP_PRIVATE_KEY`); tokens kun i minnet |

## Før du begynner

- Du eier kontoen/organisasjonen som har Jarvis-repoet (`tsworkflow/jarvisbuild`), og kan opprette en GitHub App der.
- Du har tilgang til Infisical (eller dashbordet) og til `.env` på NAS-en (`/volume1/jarvisbuild-data/jarvisbuild`).
- Beholder du PAT-en under overgangen: Jarvis bruker den IKKE i App-modus med mindre du eksplisitt slår på fallback (steg 6).

## Steg 1 - Opprett GitHub App-en (github.com)

Innstillinger -> **Developer settings** -> **GitHub Apps** -> **New GitHub App** (for en organisasjon: organisasjonens Settings -> Developer settings).

| Felt | Verdi |
|---|---|
| GitHub App name | kort og unik (maks 34 tegn), f.eks. `jarvis-tobias` |
| Homepage URL | hva som helst gyldig, f.eks. repo-adressen |
| Callback URL / Setup URL | tomme |
| Request user authorization (OAuth) during installation | **av** |
| Enable Device Flow | **av** |
| Webhook -> **Active** | **av** (Jarvis bruker ikke webhooks) |
| Permissions | se tabellen under (Repository permissions) |
| Where can this GitHub App be installed? | **Only on this account** |

Trykk **Create GitHub App**.

### Rettigheter (Repository permissions) - FULL kapabilitet jf. D-41

Verifisert mot GitHubs offisielle dokumentasjon 2026-10-09 (endepunkt -> påkrevd rettighet, fra de genererte dataene i GitHubs åpne docs-repo `github/docs`, se «Kilder»).
«Metadata: Read-only» gis automatisk og er påkrevd. UI-navnene under er hentet fra samme kilde - avviker GitHubs
grensesnitt, følg GitHubs egen veiledning og behold nivået.

| Rettighet i GitHub-UI | Nivå | Brukes til (Jarvis-handling, risikoklasse) | Endepunkter (verifisert) |
|---|---|---|---|
| **Metadata** | Read-only (alltid) | `read_repo_meta` (A) | `GET /repos/{o}/{r}` |
| **Contents** | **Read and write** | lese: `list_branches`, `get_branch`, `get_commit` (A) - skrive: `create_branch` (B), `delete_branch` (D), `merge_pr` (D) - og **git clone/push** i kodejobber (push = `git:push_branch`, C; kodejobbens git-token ber KUN om denne rettigheten og er scopet til ETT repo, se «Sikkerhetsmodell») | `GET branches/commits`: les; `POST/DELETE git/refs`, `PUT pulls/{n}/merge`: **write** |
| **Pull requests** | **Read and write** | `list_pull_requests`, `get_pull_request` (A); `create_pr` (C); `update_pr`, `request_reviewers` (B); kommentarer/etiketter på PR-er | `GET/POST /pulls`, `PATCH /pulls/{n}`, `POST requested_reviewers` |
| **Issues** | **Read and write** | `read_issues` (A); `create_issue`, `update_issue`, `set_labels` (B); `comment_on_issue` (C) | `GET/POST /issues`, `PATCH /issues/{n}`, `/comments`, `/labels` (Issues ELLER Pull requests, avhengig av om nummeret er en issue eller PR) |
| **Actions** | **Read and write** | les: `list_workflow_runs`, `get_workflow_run`, `list_workflow_jobs` (A) - skriv: `rerun_workflow_run`, `cancel_workflow_run`, `dispatch_workflow` (C) | `GET actions/runs...`: les; `POST rerun/cancel/dispatches`: **write** |
| **Commit statuses** | Read-only | kun selvmodifikasjonens CI-sjekk (`getCombinedCiStatus`) - **frosset (D-397), kan utelates nå** | `GET commits/{ref}/status` |
| **Checks** | Read-only | som over (`check-runs`) - **frosset (D-397), kan utelates nå** | `GET commits/{ref}/check-runs` |
| **Workflows** | Read and write - **VALGFRI, AV som standard** | skal `github.*`-handlingene (f.eks. `create_branch`) kunne endre filer under `.github/workflows/`? GitHub krever da denne rettigheten i tillegg (dokumentert som «additional permission» for `POST/PATCH git/refs`, `PUT/DELETE contents`, `releases`). Uten den avvises push av workflow-filer - det er normalt ønsket. **Kodejobbens git-token ber aldri om Workflows (kun Contents, review F2): en kodeagent kan dermed ikke pushe workflow-filer, selv om du gir installasjonen rettigheten.** | - |

Risikoklassene (A-D) styrer HVORDAN en handling utføres (preflight, readback, audit, godkjenning) - aldri OM du har kapabiliteten. Sovereign owner-modus for klasse D er
uendret. Mangler en rettighet, feiler tilsvarende handlinger med `github_api_error_403:Resource not accessible by integration`; akseptansescriptet melder det som WARN
(«mangler for FULL kapabilitet»).

**IKKE implementert i Jarvis ennå (D-41: DEFERRED, ikke stille utelatt):** releases (Contents), branch protection/rulesets/collaborators/deploy keys (Administration),
webhooks (Webhooks), miljøer/secrets/variables, Dependabot- og code-scanning-varsler, Pages/Packages/Projects/Discussions, direkte fil-API (`PUT contents`; filendringer
går via git i kodejobber). Be IKKE om disse rettighetene før en slik handling bygges - legg dem til da (og godkjenn endringen, se «Endre rettigheter»).

## Steg 2 - Noter App-id

På App-ens innstillingsside (**Edit** ved siden av App-en) står **App ID** (tall) og **Client ID** (`Iv…`). GitHub anbefaler client-id som `iss` i JWT-en; begge virker.
Du setter ÉN av dem som `JARVIS_GITHUB_APP_ID`. Ikke hemmelig.

## Steg 3 - Generer privatnøkkel

Samme side: **Private keys -> Generate a private key** (nyere UI: **Credentials -> Key pairs -> New key**). En `.pem`-fil lastes ned (`BEGIN RSA PRIVATE KEY`, PKCS#1).

- GitHub lagrer kun den offentlige delen. Mister du filen, generer en ny (maks 25 nøkler; nøkler utløper ikke - de slettes manuelt).
- Dette er den mest verdifulle hemmeligheten i oppsettet. Den skal ligge i vaulten (steg 5), aldri i repoet, aldri i chat, aldri i `.env`/compose.
- `.gitignore` ignorerer alle `*.pem`-filer (uansett navn, også `nokkel.pem` i eksemplene under), slik at nøkkelfilen ikke kan committes ved et uhell hvis den ligger i repo-mappen (unntak: den
  OFFENTLIGE konstitusjonsnøkkelen `config/evolution/constitution.pub.pem`). Det er et sikkerhetsnett, ikke lagringsstedet: legg likevel filen utenfor repoet og slett den etter steg 7.

## Steg 4 - Installer App-en på ETT repo

App-ens side -> **Install App** -> velg kontoen -> **Only select repositories** -> velg **kun Jarvis-repoet** -> **Install**.

- Velg IKKE «All repositories». Jarvis ber uansett kun om de konfigurerte repoene, men en lekket nøkkel kunne ellers utstede tokens for alle repoer på kontoen.
- App-en har alltid minst lesetilgang til offentlige repoer (GitHub-regel). Oppretter App-en selv repoer, får den automatisk tilgang til dem.
- **Installasjons-id** er tallet i adressen til installasjonens innstillingsside (`…/settings/installations/<id>`). Er du usikker: kjør
  `node --env-file=.env --experimental-transform-types modules/tool-gateway/scripts/github-app-live.ts --list-installations --key-file ./nokkel.pem`
  - den skriver `JARVIS_GITHUB_APP_INSTALLATION_ID=<id>` for hver installasjon App-en har.

## Steg 5 - Lagre privatnøkkelen i vaulten

Navn: **`JARVIS_GITHUB_APP_PRIVATE_KEY`**. Verdi: hele PEM-filen.

- **Anbefalt - Infisical:** åpne Infisical-prosjektet (miljøet `INFISICAL_ENV`, normalt `dev`), legg til secret `JARVIS_GITHUB_APP_PRIVATE_KEY`, lim inn hele filen (flerlinje støttes
  der). Dette er stedet et flerlinje-PEM hører hjemme.
- **Alternativ - dashbordet:** Integrasjoner -> GitHub -> raden `JARVIS_GITHUB_APP_PRIVATE_KEY` -> lim inn -> **Lagre**. Passordfeltet fjerner linjeskift; Jarvis bygger PEM-en opp igjen
  fra en enlinjes innliming (og tåler bokstavelige `\n` og anførselstegn). Får du `GITHUB_APP_KEY_INVALID`, lim inn i stedet filen base64-kodet på én linje (`base64 -w0 nokkel.pem`,
  macOS: `base64 -i nokkel.pem`) - Jarvis kjenner igjen begge formene.
- **Ikke** som `.env`-/compose-variabel: et flerlinje-PEM overlever ikke som env-verdi, og nøkkelen ville ligget i containerens miljø (`docker inspect`). Compose videresender den derfor
  **bevisst ikke** (testet i `apps/api/test/wpc3-github-app-wiring.test.ts`). Både `api` og `worker` leser den fra Infisical ved hver signering (workeren beholder Infisical-maskinidentiteten).
- Slett den nedlastede `.pem`-filen når verifiseringen (steg 7) er ferdig, eller legg den i passordbehandleren din.
- Kun krav: RSA, minst 2048 bit, ukryptert. Passordbeskyttet/EC/Ed25519/for liten nøkkel avvises med `GITHUB_APP_KEY_INVALID`.

## Steg 6 - `.env` på NAS-en og restart

```
JARVIS_GITHUB_APP_ID=<App ID eller Client ID>
JARVIS_GITHUB_APP_INSTALLATION_ID=<installasjons-id>
JARVIS_GITHUB_REPO=FFrollerskis/jarvis-build      # PÅKREVD i App-modus: tokenet utstedes kun for dette repoet (kontobytte D-478: se GITHUB_ACCOUNT_MOVE.md)
# JARVIS_GIT_ALLOWED_REPOS=FFrollerskis/jarvis-build,FFrollerskis/annet   # valgfritt: flere repoer (har forrang over JARVIS_GITHUB_REPO)
# JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK=true    # VALGFRITT og kun under overgangen - se under
```

```
cd /volume1/jarvisbuild-data/jarvisbuild
docker compose --env-file .env -f infra/local/docker-compose.yml up -d api worker
```

Regler Jarvis følger (testet):

- **Ingen konfig = PAT som før.** Er verken `JARVIS_GITHUB_APP_ID` eller `JARVIS_GITHUB_APP_INSTALLATION_ID` satt, er alt uendret (kjeden returneres uendret).
- **Én av dem satt = App-modus.** Delvis/ugyldig konfig (manglende id, ugyldig API-base, ingen repo-scope, manglende nøkkel) feiler **lukket og høylytt**: `github.*`-kall avvises med
  `credential_unavailable`, loggen får `github_app_auth_failed`/`github_app_config_invalid`, og connector-statusen viser feilkoden. Jarvis faller **aldri** stille tilbake til PAT.
- **PAT-fallback er av.** Slå den på KUN ved behov: `JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK=true` (eksakt «true» med små bokstaver og uten mellomrom - «TRUE», «1» og «yes» teller ikke). Bruken logges (`github_app_pat_fallback_used`, warn) - **ratebegrenset til
  maks én linje per minutt**, ikke én linje per bruk - og statusen viser løpende `pat_fallback.active`; den gjelder aldri når GitHub ga noe annet enn forespurt (`GITHUB_APP_SCOPE_MISMATCH`).
- `JARVIS_GITHUB_API_BASE`: KUN `https://api.github.com` godtas (tomt = standard). Alt annet - annen vert, port, sti, http - feiler lukket med `GITHUB_APP_CONFIG_INVALID`, fordi
  App-JWT-en (som kan utstede installasjonstokens) ellers kunne sendes til en vilkårlig mottaker ved en endret miljøvariabel. Ingen redirects følges på kall som bærer JWT eller
  installasjonstoken. `GithubTransport` og git bruker uansett api.github.com/github.com. **GitHub Enterprise Server er ikke støttet (DEFERRED).**

## Steg 7 - Verifiser (dette er det som gjør statusen VERIFIED)

Fra din PC (eller der du har repoet og `.env`), med PEM-filen:

```
node --env-file=.env --experimental-transform-types modules/tool-gateway/scripts/github-app-live.ts --key-file ./nokkel.pem
```

Standardmodus skriver ingenting i noe repo: validerer nøkkelen, leser installasjonen (repoutvalg, rettigheter), utsteder ETT repo-scopet token og kontrollerer at det dekker nøyaktig
repoet ditt, sammenligner rettighetene mot full kapabilitet (manglende = WARN), kaller `GET /rate_limit`, **revokerer** tokenet og skanner egen utskrift etter token/JWT/privatnøkkel.

Vil du også bevise skriving og git: pek på et **TEST-repo** App-en er installert på. Scriptet **nekter produksjonsrepoet** (alt i `JARVIS_GIT_ALLOWED_REPOS`/`JARVIS_GITHUB_REPO` og standardrepoet
`tsworkflow/jarvisbuild`, uansett skrivemåte) og avslutter med `NOT VERIFIED (--sandbox-repo er et produksjonsrepo)` uten å kontakte GitHub - det finnes ingen overstyring (D-41: akseptanseløp begrenses til
sandbox-ressurser). Legg derfor et eget, tomt test-repo til i installasjonen (Configure -> Repository access) FØR du kjører dette, og fjern det igjen etterpå. Sandbox-tokenet utstedes av en egen klient som
KUN kan utstede for test-repoet:

```
node --env-file=.env --experimental-transform-types modules/tool-gateway/scripts/github-app-live.ts --key-file ./nokkel.pem --sandbox-repo tsworkflow/test-repo
```

Det lager én kjøre-unik gren `jarvis-app-live-<tid>` (aldri main/master/production), leser repo/grener/PR-er/workflow-kjøringer, kjører `git ls-remote` (tokenet går kun via git-prosessens
miljø), og sletter grenen – alltid, også ved feil. Står det «slett den manuelt», gjør det.

Sluttlinjen: `GITHUB_APP_LIVE_STATUS=VERIFIED` (exit 0) eller `NOT VERIFIED (...)` (exit 1 = feil, 2 = ikke konfigurert/mangler nøkkel). `VERIFIED (kun autentisering ...)` betyr at
skrive-/git-kapabilitet ikke er bevist – kjør med `--sandbox-repo`. Lim utskriften (den inneholder ingen hemmeligheter) inn i chatten.

Deretter i dashbordet: Integrasjoner -> GitHub -> **Test tilkobling**. (Merk: «konfigurert» (✓) i dashbordet betyr at oppsettet er komplett - gyldig konfig og en brukbar privatnøkkel i vaulten - ikke at GitHub svarer akkurat nå. Statusvisninger, helse-sveipen og `get_connector_status` utsteder aldri et installasjonstoken; helsen står i `health` og `auth.detail.last_error`.) `executive.get_connector_status` viser nå `auth`: metode `app`, installasjons-id, når tokenet utløper, hvilke repoer det
dekker, tildelte rettigheter og siste feilkode – og «kortlevd repo-scopet identitet: ja» (`short_lived` og `scoped`). «Ja» er et bevis, ikke et løfte: det står `app_pending` og `false`
til en utstedelse faktisk har lyktes siden oppstart, og `false` igjen ved ugyldig konfig, siste utstedelse feilet eller aktiv PAT-fallback. Aldri selve tokenet.

## Steg 8 - Fase ut PAT-en

Når steg 7 er VERIFIED og Jarvis har kjørt normalt en stund: fjern `JARVIS_GITHUB_TOKEN` fra Infisical og `.env`, fjern `JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK`, og **revoker PAT-en på GitHub**
(Settings -> Developer settings -> Personal access tokens). Restart `api` og `worker`.

## Nøkkelrotasjon og nødtilbakekalling

- **Rotasjon uten nedetid:** generer en NY privatnøkkel (steg 3), lagre den i Infisical under samme navn, kjør steg 7, og slett den gamle nøkkelen på GitHub. Jarvis leser nøkkelen på nytt
  ved hver utstedelse (innen ~1 time, eller restart `api`/`worker` for umiddelbar effekt). **Kjent begrensning:** `GitHubAppAuth.invalidate()` (forkaster cachede tokens og ventetid) finnes, men er IKKE koblet til noen
  rotasjonshendelse - tokens som allerede er utstedt med den gamle nøkkelen lever til de utløper (maks ~1 time). Slik rotasjonen er satt opp merker Jarvis ikke at nøkkelen er byttet før neste utstedelse; restart er den eneste
  måten å få umiddelbar effekt på.
- **Lekkasje mistenkt:** slett nøkkelen på GitHub (alle tokens den kunne mint, kan ikke fornyes), og vurder **Suspend** av installasjonen (Settings -> Applications/GitHub Apps -> Configure).
  Allerede utstedte tokens dør senest etter 1 time. Du kan også tilbakekalle credentialen i Jarvis (`owner_controls.revoke_credential` på `JARVIS_GITHUB_TOKEN`) – det stopper alle `github.*`-kall
  OG kodejobbenes git-credential FØR noe token utstedes (kodejobber sjekker tilbakekallingen ved jobbstart, før clone og før push; en jobb som stoppes feiler med `git_auth_revoked`; statusvisninger utsteder aldri et token).
  Kill switch og frys stopper `github.*`-kall før utstedelse (policy vurderes først), og kodejobber ved jobbstart og PÅ NYTT rett før push – en kill switch som slås på midt i en jobb stopper dermed push, men en clone som
  allerede pågår fullføres. Tilbakekallingen i Jarvis påvirker ikke tokens som allerede er utstedt (maks 1 time) – de dør av seg selv, eller når du sletter nøkkelen/suspenderer installasjonen på GitHub.
- **Endre rettigheter:** endrer du App-ens rettigheter på github.com, må installasjonseieren **godkjenne endringen** i installasjonen før tokens får dem. Kjør steg 7 på nytt.

## Rollback til PAT

Fjern `JARVIS_GITHUB_APP_ID` og `JARVIS_GITHUB_APP_INSTALLATION_ID` fra `.env` (og sørg for at `JARVIS_GITHUB_TOKEN` er satt), restart `api` og `worker`. Alt er som før WP-C3.

## Feilsøking (kode -> årsak -> tiltak)

| Kode | Årsak | Tiltak |
|---|---|---|
| `GITHUB_APP_CONFIG_INVALID` | App-id/installasjons-id/API-base ugyldig, eller bare én av id-ene satt | rett `.env`; la `JARVIS_GITHUB_API_BASE` stå tom (kun `https://api.github.com` godtas) |
| `GITHUB_APP_SCOPE_UNDEFINED` | ingen `JARVIS_GITHUB_REPO` / `JARVIS_GIT_ALLOWED_REPOS` | sett `JARVIS_GITHUB_REPO=owner/repo` |
| `GITHUB_APP_KEY_MISSING` | nøkkelen finnes ikke i vaulten | steg 5 |
| `GITHUB_APP_KEY_INVALID` | ikke RSA / < 2048 bit / passordbeskyttet / ødelagt innliming | last ned ny nøkkel; bruk base64-varianten |
| `GITHUB_APP_AUTH_FAILED` (401) | feil App-id, slettet/feil nøkkel, eller verten har > 5 s klokkeavvik som ikke lot seg rette | sjekk App-id og at nøkkelen er fra DENNE App-en; sjekk NTP på verten (status viser `clock_skew_ms`) |
| `GITHUB_APP_INSTALLATION_NOT_FOUND` (404) | feil installasjons-id, eller App-en er avinstallert | `--list-installations` |
| `GITHUB_APP_INSTALLATION_SUSPENDED` | installasjonen er suspendert | opphev suspensjonen på github.com |
| `GITHUB_APP_FORBIDDEN` (403) | GitHub nektet utstedelse | sjekk installasjonen og kontoens status |
| `GITHUB_APP_REQUEST_REJECTED` (422) | repoet er ikke i installasjonen, eller rettigheter utover det installasjonen har | legg repoet til i installasjonen / juster rettighetene |
| `GITHUB_APP_SCOPE_MISMATCH` | GitHub svarte med noe annet enn forespurt (avvist; aldri PAT-fallback) | meld fra – dette skal ikke skje |
| `GITHUB_APP_RATE_LIMITED` | GitHub ba oss vente | Jarvis prøver igjen etter `Retry-After`; ingen handling |
| `GITHUB_APP_UNAVAILABLE` | nettverk/timeout/5xx etter 3 forsøk | sjekk GitHub status og nettverket |
| `GITHUB_APP_RESPONSE_INVALID` | svaret mangler gyldig token/utløpstid, er ikke JSON, er urimelig stort, eller er en redirect (`unexpected_redirect_http_3xx` - følges aldri) (typisk en mellomvare/proxy som endrer svaret) | sjekk proxy/brannmur mellom NAS og api.github.com; meld fra hvis det vedvarer |
| `github_api_error_403:Resource not accessible by integration` (i en `github.*`-handling) | App-en mangler rettigheten handlingen krever | tabellen over; godkjenn endringen i installasjonen |

**Ventetid etter feil:** Jarvis prøver ikke å utstede på nytt umiddelbart etter en feil fra GitHub. Vinduet dobles for hver påfølgende feil på samme repo-scope: 5, 10, 20, 40, 80, 160 s og så 5 min
(5xx starter på 10 s; rate limit følger GitHubs `Retry-After`), og nullstilles av første vellykkede utstedelse. Lokale feil (manglende/ugyldig nøkkel, manglende repo-scope) har ingen ventetid. Har du rettet
årsaken på github.com og vil ha effekt med en gang, restart `api`/`worker` (nullstiller ventetiden).

Alt står også i `executive.get_connector_status` (`auth.detail.last_error`) og i api-/worker-loggen som `github_app_*`-linjer.

## Sikkerhetsmodell (det en reviewer bør angripe)

- JWT: RS256, `iat` = nå − 60 s, `exp` = nå + 9 min (GitHub tillater maks 10), `iss` = App-id/client-id; lages på nytt per forsøk og lagres aldri. Klokkeskjev rettes fra `Date`-headeren (én umiddelbar gjentakelse).
- Tokenet er alltid `repositories`-begrenset; svaret kontrolleres mot det som ble forespurt (`repository_selection: selected`, nøyaktig de repoene, rettigheter ikke utover forespurt). Avvik = avvist + ingen fallback.
- Den konfigurerte repo-listen (`JARVIS_GIT_ALLOWED_REPOS`, ellers `JARVIS_GITHUB_REPO`) er en ALLOWLIST som håndheves i selve klienten (`GitHubAppAuth`), ikke bare av kallerne: et eksplisitt scope utenfor
  listen avvises uten nettverkskall (`GITHUB_APP_SCOPE_MISMATCH`, aldri PAT-fallback) og rører verken status eller ventetid. En oppføring med eier binder svaret til den eieren. Rapportert utløp
  (`token_expires_at`) er det Jarvis faktisk bruker (kappet til ~65 min), ikke det GitHub eventuelt påstår.
- Installasjonstokens caches i minnet til 5 min før `expires_at` (felles pågående utstedelse per scope), og forkastes ved 401. Hverken JWT, nøkkel eller token havner i logg, feilmeldinger, status, audit eller `JSON.stringify`/`inspect`
  (adversarielle tester med en fiendtlig server som ekkoer dem). `withSecretRedaction` i kodejobbene redigerer nylig utstedte tokens ut av feilmeldinger.
- Utgående kall går via `guardedFetch` (rå-URL-sjekk + timeout); API-basen er `https://api.github.com` og ingen annen vert, og redirects følges aldri på kall med JWT/token
  (loopback-http finnes kun som testflagg i koden, ikke som miljøvariabel).
- Git: kodejobber får et token scopet til det ene repoet jobben gjelder (`GitCredentialSource.tokenFor`) med minste rettighet (kun Contents: write; ikke «alle rettigheter installasjonen er gitt»), hentet RETT FØR hver
  git-nettverksoperasjon (clone og push) – ikke én gang ved jobbstart – kun i git-underprosessens miljø, og credential-helperen er fortsatt begrenset til github.com + dette repoet. Feiler utstedelsen, feiler jobben
  lukket (`git_auth_unavailable:<kode>`) før noe klones; tilbakekalt credential gir `git_auth_revoked`, og en tilbakekallingssjekk som selv feiler gir `git_auth_revocation_check_failed` (fail-closed).
- GitHub kan i dag levere installasjonstokens i et nytt, lengre format (`ghs_<APP-ID>_<JWT>`, utrullet fra april 2026). Jarvis antar aldri 40 tegn.

## Kjente begrensninger (ærlig)

- **Connector-tokenet er ikke nedskalert (bevisst, D-41).** `github.*`-handlingene (dashbordet, bekreftede handlinger, chatten) bruker standard-scope-tokenet: alle repoer i `JARVIS_GIT_ALLOWED_REPOS` og alle rettigheter
  installasjonen er gitt, fordi eieren skal ha maksimal kapabilitet. Det er KUN kodejobbens git-credential (clone/push i en sandbox med en kodeagent) som er nedskalert til ett repo og Contents: write. PR-opprettelsen etter
  push (`github.create_pr`) går via ToolGateway med connector-credentialen, ikke med git-tokenet.
- Den frosne `SelfModificationService` (D-397, ikke konstruert i produksjon) har sin egen `resolveGitToken`-søm og ville fått standard-scope-tokenet hvis den tines – kobles til `tokenFor` da.
- Loggføring av PAT-fallback og utstedelsesfeil er ratebegrenset (maks én linje per kode per minutt); status viser løpende tilstand.
- `GitHubAppAuth.invalidate()` er ikke koblet til nøkkelrotasjon (se «Nøkkelrotasjon»); restart er veien til umiddelbar effekt.
- **Akseptansescriptet dekker ikke kodejobbens snevre git-token ennå (`PARTIAL`).** `github-app-live.ts` utsteder standard-scope-tokenet (og kjører `git ls-remote` med det). `contents: write`-tokenet kodejobbene bruker
  (`GitHubAuth.gitCredentialSource`) er testet mot fake-GitHub og stubbet `api.github.com`, men utstedes første gang mot ekte GitHub av den første kodejobben etter aktivering. Feiler det, står koden i `tasks.last_error`
  (`git_auth_unavailable:<kode>`) og i `auth.detail.last_error` i `get_connector_status` (se feilsøkingstabellen); midlertidig utvei er «Rollback til PAT» eller `JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK=true`.
- Ikke verifisert mot ekte GitHub (se toppen): alt over er testet mot en lokal fake GitHub og stubbet `api.github.com`.

## Kilder (offisiell dokumentasjon, lest 2026-10-09 fra GitHubs åpne docs-repo `github/docs`)

- Generating a JSON Web Token (JWT) for a GitHub App - krav til `RS256`, `iat`/`exp`/`iss`.
- Generating an installation access token for a GitHub App; REST «Create an installation access token for an app» (`POST /app/installations/{installation_id}/access_tokens`: `repositories`, `permissions`, 201/401/403/404/422, utløp 1 time).
- Managing private keys for GitHub Apps (PKCS#1, opptil 25 nøkler, lagring).
- Registering a GitHub App; Installing your own GitHub App; Reviewing and modifying installed GitHub Apps; Choosing permissions for a GitHub App (inkl. «Choosing permissions for Git access»: HTTP-basert Git krever «Contents»,
  «Workflows» kun for `.github/workflows` - grunnlaget for kodejobbens minste-rettighet-token) og at `permissions` i utstedelsesforespørselen kan snevre inn tokenet men aldri utvide det utover det installasjonen har.
- Rate limits for the REST API (installasjonstokens: 5 000/t minimum, opptil 12 500/t).
- Rettighetstabellen (endepunkt -> rettighet) er generert fra `src/github-apps/data/fpt-2022-11-28/server-to-server-permissions.json` i samme repo.

**Ikke verifisert (ærlig):** UI-navigasjonen (menynavn/knapper) er gjengitt fra dokumentasjonen, ikke prøvd i GitHubs grensesnitt; hele flyten er ikke kjørt mot ekte GitHub; Infisical-lagring og dashbord-liming er ikke prøvd med
ekte PEM på NAS-en; GHES er ikke støttet.
