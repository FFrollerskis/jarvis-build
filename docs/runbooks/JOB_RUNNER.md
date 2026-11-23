# Vertsside job-runner for kodejobber (WP-C1) - installasjon, akseptanse og drift

**Formål (D-32 / Q-45a / Q-46 punkt 5):** kodejobber kjører i en egen, kastbar Docker-container per jobb, startet av en liten **tilsynt tjeneste på
verten** (ikke av worker). Worker har ingen Docker-socket og kjører aldri kode selv. **git-credentialen finnes aldri i jobb-containeren:** klone og
push skjer på verten med tjenestens egen credential, og ingenting git kjører mot en katalog agenten kan skrive i.

**Ærlighet først.** Alt som er merket BYGGET/BEVIST under er kjørt i CI/sandbox mot en *fake* `docker` og ekte `git`. **Ingenting er kjørt mot ekte Docker,
systemd, brannmur eller GitHub.** Det er `NOT VERIFIED` til du har kjørt `ops/job-runner/acceptance.sh` på NAS-en (kapittel 6) og lest resultatet.
Inntil da gjelder D-32 som før: workers er utviklings-/testklare, ikke produksjonsverifiserte autonome workers.

| | Status |
|---|---|
| Runner-tjenesten (API, livssyklus, publisering), egress-proxy, worker-klient, `coding.ts`-integrasjon | **BYGGET**, tester i `ops/job-runner/test/` og `modules/tasks/test/wpc1-*.test.ts` |
| `docker create`-argv parses av ekte Docker-CLI (uten daemon) | **BEVIST** (`docker-cli-argv.test.mjs`; hoppes over der `docker` mangler) |
| Containerkonfigurasjonen den EKTE Docker-CLI-en bygger av runnerens flagg (privileged=false, cap-drop ALL, read-only, kun `/work`, ingen docker.sock, grenser, exec-`Cmd` ordrett) | **BEVIST mot en falsk Engine API** (`docker-engine.test.mjs`; hoppes over uten `docker`) - fortsatt IKKE mot en ekte daemon |
| Container faktisk isolert, OOM/PID/tidsavbrudd, nettverk deny-by-default, brannmurregler, reclaim etter ekte krasj, systemd-oppstart, image-bygging | **NOT VERIFIED** - `acceptance.sh` J03-J10 på verten |
| Ekte Claude Code-kjøring fra containeren via proxyen | **NOT VERIFIED** - `ACCEPT_LIVE_CLAUDE=1 ... acceptance.sh` (J13) |
| Ekte push til GitHub, branch protection, PAT-rettigheter | **NOT VERIFIED / EIER** - J11 og M01 |
| Gjennomgang og rettelser etter to uavhengige sikkerhetsreviews av PR #322 (A: runner/git/credentials, B: proxy/container/installasjon/worker-klient; ingen HØY, seks MIDDELS og flere LAV) | **BYGGET** og mutasjonssjekket i repoet (kapittel 17); **NOT VERIFIED** mot ekte Docker, systemd/cgroup, brannmur og GitHub |
| Kortlevd git-token fra worker i jobbforespørselen (`source: request`, GitHub App/WP-C3; **AV som standard**, valgt per repo av deg) | **BYGGET**, tester i `ops/job-runner/test/request-token.test.mjs` og `modules/tasks/test/wpc1-host-job-runner-token.test.ts` (ekte git mot en autentiserende smart-HTTP-server); **NOT VERIFIED** mot ekte GitHub App, ekte Docker og ekte worker-container - kapittel 15 |

---

## 1. Slik henger det sammen

```
Jarvis worker (container, ingen docker.sock)                    VERTEN (NAS), tilsynt av systemd
  HostJobSandboxRunner  --Unix-socket + bearer (fil)-->  jarvis-job-runner  (bruker jarvis-runner, i docker-gruppen)
     create / exec / publish / delete                         |  policy KUN fra /etc/jarvis/job-runner.json (root-eid)
                                                              |  1. git clone/fetch i en fersk base.git (runnerens credential, renset env)
                                                              |  2. docker create/start  ->  jobb-container (read-only, cap-drop ALL, ikke-root,
                                                              |       kun /work montert, jobbnettverk --internal)
                                                              |  3. publish: git bundle LAGET I CONTAINEREN -> verifisert i ferskt bare-repo
                                                              |       -> push <sha>:refs/heads/jarvis/<id> med runnerens credential
jobb-container --HTTPS_PROXY--> jarvis-egress-proxy (bruker jarvis-egress, uten docker)
                                   CONNECT-only, allowlist (standard KUN api.anthropic.com:443), SSRF-/DNS-rebinding-sikker
```

* Worker kan be om: opprett jobb for **ett repo i allowlisten**, kjør en kommando (argv, ingen shell), publiser en `jarvis/…`-branch, slett jobben.
  Worker kan **ikke** sende docker-flagg, mounts, image, nettverk, stier eller credentials i `env`. Den ENESTE credentialen som kan komme fra worker er et kortlevd `git_token` i klone-/publish-forespørselen,
  og kun for repoer du selv har satt til `source: request` i den root-eide konfigen (kapittel 15); standard er at worker aldri håndterer en git-credential.
* Jobb-containeren ser: `/work` (arbeidskopi uten `origin`), en tmpfs `/home/job`, en tmpfs `/tmp`, og nett kun via proxyen. Ingenting annet.
* `base.git`, `verify.git`, `out.bundle` ligger i `private/` ved siden av `work/` og er **aldri montert** i containeren.
* **Hva en jobb faktisk kan kjøre:** imaget har Node 22, npm og git (+ Claude Code). Testløpere utover `node --test`/`node <fil>`/`npm test` (`pytest`, `go`, `cargo`, `make`, `pnpm`, `yarn`) finnes **ikke**
  i imaget, og nettet er begrenset til api.anthropic.com (standard) - så `npm install`/`pnpm install` kan ikke hente pakker. Repoer som trenger installasjon før testene kan ikke testes her uten at du
  enten legger `registry.npmjs.org:443` til i `egress_proxy.allow` (utvider angrepsflaten: pakkeregisteret blir en mulig kanal ut og kilde til kjørbar kode) eller bygger et eget image med ferdige avhengigheter
  (**ikke bygget**). Sandbox-repoet til akseptansen skal derfor ha en test uten avhengigheter. En manglende kommando gir exit 127 og en feilet kodejobb (lukket), aldri en stille suksess.

## 2. Tillitsmodell - les dette før du installerer

1. **`jarvis-runner` er i `docker`-gruppen og er dermed effektivt root på verten.** systemd-herdingen i enheten begrenser bare selve Node-prosessen.
   Sikkerheten hviler på at runner-koden **aldri** tar imot flagg, mounts, image, nettverk eller stier fra API-et, og at koden og policyen ikke kan endres
   av tjenesten selv.
2. **Kode og policy er root-eid.** Koden installeres under `/opt/jarvis-job-runner` (root, `0644`/`0755`); policyen er `/etc/jarvis/job-runner.json`
   (root-eid, ikke skrivbar for gruppe/andre - ellers nekter tjenesten å starte). Ukjente nøkler avvises. Testflagg (file://-remote, hopp over uid-sjekk)
   finnes **ikke** i konfigskjemaet.
3. **Agenten (Claude Code i containeren) er ubetrodd.** Den kan skrive hva som helst i `/work`, inkludert `.git/config` og `.git/hooks`. Derfor kjører
   verten **aldri** `git` i `work/`: publisering = `git bundle` laget *inne i containeren*, hentet inn i et fersk bare-repo (`verify.git`) som låner
   basens objekter, `fsck --strict`, og kun den verifiserte SHA-en pushes.
4. **git-credentialen** (standard, `source: file`: fine-grained PAT, ett repo) leses fra en fil som kun `jarvis-runner` kan lese (modus `0400`; åpnere filer nektes), ved hver bruk, og leveres som env til **ett**
   git-kall via runnerens egen `credential.helper` (scopet til eksakt protokoll + vert + repo-sti; følger ingen redirect). Den skrives aldri til disk,
   argv, `.git/config`, logg eller container. Valgfritt per repo (`source: request`, kapittel 15) leverer worker i stedet et kortlevd, repo-scopet installasjonstoken i selve forespørselen;
   da gjelder de samme reglene for hvor det kan havne, og i tillegg: det brukes til **én** operasjon, mellomlagres aldri og lagres aldri i jobben.
5. **Nettverk:** jobbnettverket er `--internal` (ingen rute ut) med `enable_icc=false`. Docker lar likevel containere på et internt nett nå tjenester på
   *verten* via bridge-adressen; derfor setter `setup-network.sh` en INPUT-kjede som slipper inn **kun** `tcp <gateway>:<proxy-port>`.

| Angrepsflate | Hva en kompromittert agent kan prøve | Hva som stopper det |
|---|---|---|
| Container-escape via flagg | be API-et om `--privileged`, `-v /:/host`, annet image/nettverk | API-skjemaet har ingen slike felt (ukjente felt avvises); argv bygges av én delt funksjon fra root-eid policy |
| git-feller i `/work` | `core.fsmonitor`, hooks, `url.*.insteadOf`, `uploadpack.packObjectsHook` | verten kjører aldri git i `/work`; bundle verifiseres i ferskt repo med `core.hooksPath=/dev/null`, ingen systemconfig, tom HOME |
| Stjele PAT | lese env/fil/prosesser i containeren | credentialen finnes ikke i containeren; ligger `0400` hos `jarvis-runner` |
| Forfalske forfatter/committer | `git commit --author`, `GIT_AUTHOR_*`, `commit-tree` - en commit som ser ut som en annen persons arbeid | verten sjekker at ALLE commits har `runner.git_identity` som forfatter og committer, ellers `bundle_invalid` / `commit_identity_not_allowed` (A-F4) |
| Skrive til `main`/andre branches | `git push` selv, eller be om publish til `main` | containeren har ingen credential og ingen vei til GitHub utenom proxyens CONNECT; runneren pusher kun `refs/heads/jarvis/<id>` (aldri force/sletting) |
| Smugle inn CI-/hook-/attributtfiler | endre `.github/workflows`, `.gitmodules`, `.gitattributes` (også i en undermappe: `* -diff` skjuler endringer for en reviewer), `.lfsconfig` (LFS-url mot en fremmed server), `.git/…` | stiregler (hard `.git`-sperre også NTFS-varianter, konfigurerbar nekteliste som gjelder PÅ ALLE NIVÅER for oppføringer med én komponent, gitlink/submodul avvist); avkortet git-utdata feiler lukket (kapittel 11) |
| SSRF via proxyen | `CONNECT 169.254.169.254:80`, `localhost:5432`, DNS-rebinding | kun allowlist `vert:port`; proxyen slår opp DNS selv, krever kun offentlige adresser og kobler til den validerte IP-en |
| Nå verten fra containeren | SSH/SMB/NAS-grensesnitt på bridge-adressen | INPUT-kjeden i `setup-network.sh` (NOT VERIFIED til J07) |
| Tømme ressurser | minnebombe, fork-bombe, evig prosess, enorm output | `--memory` uten swap, `--pids-limit`, tidsavbrudd dreper hele containeren, output-tak, maks samtidige jobber, TTL |
| Tømme VERTENS minne via pakken runneren parser | en delta-bombe: 16 kB git-pakke som ekspanderer til GiB når verts-git løser deltaen (målt: 1,52 GiB, publish 54 s) | vertsside git som leser agentens objekter kjører under `prlimit --as` (`git_memory_limit_mb`, standard 1024) og feiler rent FØR det allokeres; enheten har `MemoryMax=`/`OOMPolicy=continue` (kapittel 16, punkt 4). **NOT VERIFIED** mot ekte systemd |
| Blokkere en jobbplass for alltid | lage noe verten ikke kan rydde: et katalogtre dypere enn PATH_MAX (4096 **bytes**, også med flerbyte-tegn), filnavn som ikke er gyldig UTF-8 (kan ikke adresseres som en JavaScript-streng), kataloger uten tilgang, millioner av filer i én katalog - jobben ville blitt `cleanup_pending` for alltid | `forceRemoveTree` (`lib/fsutil.mjs`) bruker GNU `chmod -R u+rwx` + `rm -rf --one-file-system` (fd-relativt, ingen sti-/UTF-8-grense, følger aldri symlenker, krysser aldri filsystemgrenser) i stedet for en egen vandring; nekter roten og toppnivåkataloger; tidsavbrudd 15 min. Fortsatt **ikke** bygget: diskkvote (neste rad) |
| Fylle disken | skrive uendelig mye (eller millioner av filer) i `/work` | **IKKE begrenset av runneren** - en bind-mount har ingen kvote og `docker --storage-opt` gjelder ikke den. Tak finnes bare for `/tmp` og `/home/job` (tmpfs). Legg `base_dir` på et eget volum/filsystem med kvote (kapittel 14) |
| Utnytte worker→runner | gjette socket/token | socket `0660` (gruppe `jarvis-job-clients`), bearer i konstant tid, ingen feilsvar som skiller ukjente ruter før autentisering |
| Worker (feil eller kompromittert) sender et git-token | levere en credential runneren ikke skal ta imot, sende en annen hemmelighet som «token», få tokenet inn i containeren/loggen/svaret | tas kun imot for repoer med `source: request` (ellers 403); formkontroll `ghs_`/`ghp_`/`github_pat_` 20-8192 tegn; avvises i `env`; én operasjon, aldri mellomlagret/lagret; kun env til `ls-remote`/`fetch`/`push`; redigert fra feildetaljer og logg også når git skriver det på stderr (kapittel 15) |

## 3. Forutsetninger på NAS-en (kontroller før du begynner)

Alle kommandoer kjøres fra `/volume1/jarvisbuild-data/jarvisbuild` (se `NAS_UPDATE_2026-10-07.md` for innlogging). Kjør ett steg om gangen, lim inn
utdata, og stopp ved første avvik.

```
cd /volume1/jarvisbuild-data/jarvisbuild && git pull
node --version                      # MÅ være v22 eller nyere PÅ VERTEN (ikke bare i containerne)
git --version                       # >= 2.39 (funksjonelt gulv). PATCHNIVÅET kan ikke avgjøres av versjonsstrengen: se «git-patchnivå» under
prlimit --version | head -1         # MÅ finnes som /usr/bin/prlimit (util-linux): runneren begrenser minnet til vertsside git med den (A-F3), og nekter å starte uten
/bin/rm --version | head -1         # MÅ være «GNU coreutils» (runneren rydder agent-skrevne trær med /bin/rm og /bin/chmod; busybox/BSD støtter ikke --one-file-system)
sudo docker version --format '{{.Server.Version}}'
sudo docker info --format '{{.SecurityOptions}}'   # skal IKKE inneholde name=userns (uid i containeren må være lik uid på verten for /work) og ikke name=rootless
ls -l /var/run/docker.sock          # gruppen skal være docker (runneren får tilgang via SupplementaryGroups=docker)
command -v "$(sudo docker info --format '{{.InitBinary}}')" || echo "docker-init MANGLER - containerne startes med --init"
sudo docker info 2>&1 | grep -i 'swap'   # «No swap limit support» betyr at --memory-swap ikke kan håndheves (J04 melder «swap tillatt»)
sudo iptables -V                    # nf_tables- eller legacy-variant er begge greit
systemctl --version | head -1
getent group docker                 # må finnes
getent passwd 10001 || echo "uid 10001 er ledig (bra)"
sudo ss -ltn | grep ':3128 ' || echo "port 3128 er ledig (bra)"
ip -4 route | grep '172.30.77' || echo "subnett 172.30.77.0/24 er ledig (bra)"
curl -sSI --max-time 10 https://github.com | head -1    # verten må nå github.com:443 DIREKTE (runneren videreformidler ikke vertens proxy-miljø)
```

* **git-patchnivå (A-F7, ÅPENT GAP - ikke håndhevet i kode):** runneren krever kun git >= 2.39 (major.minor). Distro-bygg tilbakeporterer sikkerhetsfikser uten å endre versjonsstrengen (Debian 12 melder `2.39.5`, Ubuntu 24.04 melder `2.43.0` selv når pakken er patchet), så et strengt oppstrøms patchnivåkrav ville avvist
  patchede bygg. Kontroller derfor PAKKEN, ikke tallet: `apt changelog git | grep -E 'CVE-20(24-(32002|32004|32020|32021|32465|50349|52006)|25-(27613|27614|46334|46835|48384|48385|48386))'` (Debian/Ubuntu), eller bruk en oppstrøms utgave på eller over nivåene under. Verifisert mot git sine offisielle release notes (`Documentation/RelNotes/`, 2026-10-10):
  mai 2024 (CVE-2024-32002/-32004/-32020/-32021/-32465): 2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4, 2.44.1, 2.45.1; januar 2025 (CVE-2024-50349/-52006): 2.40.4, 2.41.3, 2.42.4, 2.43.6, 2.44.3, 2.45.3, 2.46.3, 2.47.2, 2.48.1; juli 2025 (CVE-2025-27613/-27614/-46334/-46835/-48384/-48385/-48386): 2.43.7, 2.44.4, 2.45.4, 2.46.4, 2.47.3, 2.48.2, 2.49.1, 2.50.1.
  Oppstrøms er dermed ingen 2.39-2.42-utgave fullt oppdatert (siste rad finnes først fra 2.43.7); en slik vert er avhengig av distroens backports. Hvilke av disse banene runneren faktisk eksponerer: ingen rekursiv klone og ingen submoduler (`submodule.recurse=false`, gitlink avvist), lokal klone kun fra runnerens EGEN `base.git` (`--no-hardlinks`), URL-er bygges av en validert slug (ingen kontrolltegn). Det er en nedmildring, ikke et bevis. Nye sikkerhetsutgaver etter 2026-10-10 er IKKE vurdert.
* **Mangler Node 22 på verten:** installer siste v22 LTS fra <https://nodejs.org/en/download> (Linux x64-tarball), kontroller sjekksummen mot `SHASUMS256.txt`
  fra samme sted, pakk ut under `/opt/node22` og lag `sudo ln -s /opt/node22/bin/node /usr/local/bin/node`. Enheten starter `/usr/bin/env node`, og
  systemd-PATH inneholder `/usr/local/bin`. (Node trengs *kun* for runner/proxy; jobb-imaget har sin egen Node.)
* **Er `172.30.77.0/24` opptatt:** velg et annet privat /24, og sett det **likt** i `egress_proxy.listen_host` (gateway = `.1`), `egress_proxy.allowed_client_cidrs`
  og `runner.egress_proxy_url` i `job-runner.json` (kapittel 4, steg 4).
* UGOS er Debian-basert; at `systemd`, `iptables` og `docker` oppfører seg som over er **ikke verifisert**.

## 4. Installasjon (eierens steg)

1. **Installer tjenestene** (kopierer kode til root-eide stier, lager brukerne `jarvis-runner` (uid 10001) og `jarvis-egress`, gruppen `jarvis-job-clients`,
   enhetene og et bearer-token som aldri vises; røres aldri på nytt):
   ```
   sudo infra/job-runner/install-host.sh
   ```
   Forhåndsvisning uten root: `infra/job-runner/install-host.sh --stage --prefix /tmp/jr-stage`. Skriptet AVVISER (exit 2) en symlenke i stedet for `/var/lib/jarvis-job-runner` eller `sock/` (tjenestebrukeren eier dem og kunne ellers latt et root-skript endre modus/eier på et annet sted, B-L2): undersøk, fjern lenken manuelt og kjør på nytt, helst med tjenestene stoppet. Skriptet overskriver **aldri** `/etc/jarvis/job-runner.json`,
   PAT-filer eller et eksisterende token. Kjør det på nytt etter hver `git pull` som endrer `ops/job-runner/` (ryddet og kopiert på nytt).

2. **Bygg jobb-imaget** (krever utgående nett fra verten: Docker Hub + npm; base-imaget er pinnet til digest og Claude Code til 2.1.286 med integritet i lockfilen):
   ```
   sudo infra/job-runner/build-job-image.sh
   ```
   Skriptet kjører en selvtest med samme begrensninger som runneren og skriver ut `image-ID: sha256:<64 hex>`. Noter den.

3. **Lag PAT og legg den i en fil bare runneren kan lese.** I GitHub: fine-grained token, *Resource owner* `tsworkflow`, **kun ett repo** (til akseptansen:
   sandbox-repoet `jarvis-d103-acceptance`), rettigheter **Contents: Read and write** og **Pull requests: Read and write** (Metadata: Read følger med) - ingenting annet
   (ikke Administration, ikke Workflows), kort utløpsdato. Lim aldri tokenet inn i chat eller på kommandolinjen:
   ```
   sudo bash -c 'umask 277; read -rsp "Lim inn PAT (vises ikke): " T; echo; printf "%s" "$T" > /etc/jarvis/git-token-jarvis-d103-acceptance'
   sudo chown jarvis-runner:root /etc/jarvis/git-token-jarvis-d103-acceptance
   sudo chmod 0400 /etc/jarvis/git-token-jarvis-d103-acceptance
   ```
   Worker-containeren skal **ikke** kunne lese denne filen (modus `0400`, eier `jarvis-runner`). `acceptance.sh` J01 kontrollerer det.

4. **Lag policyen** (root-eid, `0644`) og sett inn image-ID-en fra steg 2. En uendret kopi av eksempelet nekter å starte (plassholder-image):
   ```
   sudo cp /etc/jarvis/job-runner.example.json /etc/jarvis/job-runner.json
   sudo chown root:root /etc/jarvis/job-runner.json && sudo chmod 0644 /etc/jarvis/job-runner.json
   sudo nano /etc/jarvis/job-runner.json     # sett runner.image; sjekk allowed_repos + git_credentials; evt. nettverk (steg 3 i kapittel 3)
   ```
   Konfigreferanse: kapittel 8. Når du legger til et repo: ny PAT-fil, én oppføring i `allowed_repos` **og** i `git_credentials`, og repoet må også stå i
   `JARVIS_GIT_ALLOWED_REPOS` hos worker.

5. **Start** (proxyen først; den oppretter jobbnettverket og brannmurreglene som `ExecStartPre`):
   ```
   sudo systemctl enable --now jarvis-egress-proxy
   sudo systemctl enable --now jarvis-job-runner
   systemctl is-active jarvis-egress-proxy jarvis-job-runner
   sudo journalctl -u jarvis-job-runner -n 20 --no-pager        # forventet: «runner_started»
   sudo infra/job-runner/setup-network.sh --check               # endrer ingenting; forventet: «jobbnettverket er klart»
   ```
   Starter ikke runneren, står årsaken som en stabil kode i journalen (f.eks. `config_must_be_owned_by_root`, `job_network_not_internal`,
   `container_user_must_equal_service_uid`, `docker_unavailable`, `placeholder_not_replaced`). Se kapittel 12.

6. **Koble worker til runneren** (valgfri compose-override som KUN monterer socket-katalogen og tokenfilen read-only; ingen Docker-socket):
   ```
   echo "JARVIS_JOB_RUNNER_GID=$(getent group jarvis-job-clients | cut -d: -f3)" >> .env
   grep -E '^JARVIS_CLAUDE_BIN=' .env || echo "JARVIS_CLAUDE_BIN=claude" >> .env     # stien gjelder INNE I jobb-containeren (imaget har /usr/local/bin/claude); en vertssti virker ikke
   docker compose --env-file .env -f infra/local/docker-compose.yml -f infra/job-runner/docker-compose.job-runner.yml up -d worker
   ```
   `JARVIS_CLAUDE_BIN` er navnet på Claude Code-programmet slik det kjøres **inne i jobb-containeren** (`claude`); står den tom eller peker på en vertssti, feiler hver jobb med `claude_code_not_configured` eller exit 127. `ANTHROPIC_API_KEY` leveres av worker til containeren som env ved opprettelse (aldri i argv eller logg).
   Overriden setter `JARVIS_JOB_RUNNER=host`, `JARVIS_JOB_RUNNER_SOCKET` og `JARVIS_JOB_RUNNER_TOKEN_FILE`. **Bruk begge `-f`-flaggene ved hver senere oppdatering**;
   uten overriden faller worker tilbake til lukket tilstand (trygt, men kodejobber feiler med `job_container_runner_not_configured`).
   Mangler `/var/lib/jarvis-job-runner/sock` eller tokenfilen, nekter compose å starte worker (`create_host_path: false`) - aldri en stille tom mount.
   **Hvorfor ligger socketen ikke under `/run`?** En bind-mount i worker peker på selve katalog-inoden. Under `/run` med `RuntimeDirectory=` fjerner systemd katalogen ved hver stopp/omstart, og worker ville
   sett en slettet katalog til den ble startet på nytt. `sock/` er derfor persistent og slettes aldri av runneren eller systemd (reboot, krasj og omstart er trygge, og worker kan starte før runneren).

7. **GitHub (eier):** `main` i sandbox-repoet **og** i produksjonsrepoet skal ha branch protection: krev pull request, blokker force-push og sletting, også for administratorer.
   PR-en skal merges av et menneske. `acceptance.sh` kan ikke sjekke dette for deg (M01 er manuell).

## 5. Roter token og PAT

* **PAT:** skriv ny verdi til samme fil (steg 3). Leses ved hver bruk - ingen omstart. Slett den gamle i GitHub.
* **Bearer-token (worker ↔ runner):** skriv *til den eksisterende filen* (samme inode - tokenfilen er en enkelt-fil-mount i worker, så `mv` ville gi worker en foreldet fil):
  ```
  sudo bash -c 'umask 037; node -e "process.stdout.write(require(\"crypto\").randomBytes(32).toString(\"hex\")+\"\n\")" > /etc/jarvis/job-runner.token'
  sudo systemctl reload jarvis-job-runner       # SIGHUP: runneren leser tokenet på nytt; kjørende jobber berøres ikke
  sudo journalctl -u jarvis-job-runner -n 5 --no-pager | grep -E 'token_reloaded|token_reload_failed'   # BEKREFT alltid
  ```
  **Feiler lukket (A-F5):** er den nye filen ugyldig (for kort, ugyldige tegn, feil modus, mangler), logges `token_reload_failed_all_requests_denied` og runneren avviser ALT med 401 - også det gamle tokenet - til du har rettet filen og kjørt `reload` på nytt (eller restartet). Før en feilet rotasjon lot det gamle tokenet virke videre uten at du merket det.
  Worker leser filen ved hver forespørsel. Får worker likevel `unauthorized`, start worker på nytt:
  ```
  docker compose --env-file .env -f infra/local/docker-compose.yml -f infra/job-runner/docker-compose.job-runner.yml up -d --force-recreate worker
  ```

## 6. Akseptanse på verten

```
cd /volume1/jarvisbuild-data/jarvisbuild
export ACCEPTANCE_REPO=<din-konto>/jarvis-d103-acceptance   # et eget SANDBOX-repo under kontoen din (det gamle tsworkflow/jarvis-d103-acceptance er frosset; kontobytte D-478)
sudo -E ops/job-runner/acceptance.sh                              # J01-J09, J11, J12 (J09/J10/J13 gir SKIP uten flaggene under)
sudo -E ops/job-runner/acceptance.sh --with-restart --with-ttl    # J09: SIGKILL på runneren + restart. J10: venter på TTL (sett runner.max_job_lifetime_s=60 midlertidig)
read -rsp "ANTHROPIC_API_KEY (vises ikke): " ANTHROPIC_API_KEY; echo; export ANTHROPIC_API_KEY ACCEPT_LIVE_CLAUDE=1
sudo -E ops/job-runner/acceptance.sh                              # J13: liten ekte Claude Code-kjøring via proxyen (koster noen øre); unset ANTHROPIC_API_KEY etterpå
ops/job-runner/acceptance.sh --dry-run                            # kun sjekklisten, rører ingenting
sudo chown -R "$(id -u):$(id -g)" ops/acceptance/out              # evidensfilene ble skrevet av root
```

* `ACCEPTANCE_REPO` er **påkrevd** og må stå i `runner.allowed_repos`. Scriptet nekter alt annet (aldri et stille standardrepo, aldri produksjonsrepoet): J11 pusher en ekte
  branch `jarvis/accept-<tid>` til sandbox-repoet. Slett den etterpå.
* **Står sandbox-repoet som `{ "source": "request" }`** i `git_credentials` (kapittel 15), må du også sette `ACCEPTANCE_GIT_TOKEN_FILE=<fil>`: en fil (`0600`/`0400`, bare du) med ETT kortlevd, repo-scopet
  token for sandbox-repoet (`ghs_…`; lag det rett før kjøringen, et installasjonstoken varer 1 time og `--with-ttl` kan vare lenger). Scriptet sender det som `git_token` ved hver klone og publish via en `0600`
  body-fil (aldri i argv), og J12 leter etter det i journalen. Slett filen etterpå. For et `file`-repo er variabelen en feil (scriptet avbryter): slik kan et token aldri sendes til et repo som ikke har bedt om det.
* **Grinder (B-L5, D-479):** produksjonsrepoet nektes HARDT selv om det står i `allowed_repos`: det nåværende (`FFrollerskis/jarvis-build`), det gamle frosne (`tsworkflow/jarvisbuild`) og en eventuell `JARVIS_GITHUB_REPO` i miljøet (se [GITHUB_ACCOUNT_MOVE.md](GITHUB_ACCOUNT_MOVE.md)). `J06` (minne- og gaffelbombe) kjøres bare hvis `J04` er PASS (grensene er bevist med `docker inspect`), ellers SKIP. `--with-restart` SIGKILLer den LEVENDE runneren og krever `ACCEPT_CONFIRM_RESTART=yes` (eller at du skriver `RESTART` på terminal); `J09` hoppes over hvis runneren har aktive jobber.
  `J04` sjekker i tillegg daemonens `SecurityOptions` (seccomp aktiv, ikke `userns`/`rootless`) og at containeren ikke er `seccomp=unconfined`/`apparmor=unconfined`; `J05` sjekker `Seccomp: 2` og `NoNewPrivs: 1` inne i containeren (B-L4). `J07` leser allowlisten fra den faktiske konfigfilen (standard kun `api.anthropic.com:443`) og forventer 403 for `github.com`/`api.github.com` med mindre du har åpnet dem.
* Kjøres som root (`sudo -E`): scriptet trenger å lese tokenfilen og `base_dir`, skrive til socketen, bruke docker og (for J09) styre systemd. Uten root gir enkelte sjekker `FAIL`/`SKIP` med forklaring. API-nøkkelen og `ACCEPTANCE_REPO` leses fra miljøet og skrives aldri ut; legg aldri nøkkelen på kommandolinjen.
* Evidens skrives til `ops/acceptance/out/job-runner-acceptance-<tid>.md` (git-ignorert, ingen hemmeligheter - bearer-tokenet sendes via en `0600`-headerfil, aldri i argv).
  Exit 1 hvis minst én sjekk er `FAIL`. **`SKIP` og `MANUELL` er ikke bestått.** Lim utskriften inn i chatten, så vurderer jeg den.
* `PASS` betyr kun at *denne* målingen var som forventet *nå* på *denne* verten.

Sjekkene (samme ID-er som i `acceptance.sh`; `--dry-run` skriver dem):

| Sjekk | Viser | Krever |
|---|---|---|
| `J01_filrettigheter` | config root-eid; token/PAT uten tilgang for andre; socket `0660`; kataloger private | root |
| `J02_helse` | API svarer med riktig token; feil token gir 401; et ukjent felt (`image`) og et env-navn utenfor allow-listen (`PATH`) avvises 400 før noe opprettes | - |
| `J03_container_per_jobb` | to jobber = to separate, kjørende containere merket `jarvis.role=job`; borte etter DELETE | docker |
| `J04_docker_inspect` | `privileged=false`, read-only rootfs, `cap-drop ALL`, `no-new-privileges`, ikke-root, minne/CPU/PID, kun jobbnettverket, kun `/work` montert, ingen `docker.sock`, ingen forbudte env | docker |
| `J05_inne_i_containeren` | uid, `CapEff=0`, ingen `docker.sock`, read-only rootfs, `noexec` tmpfs, ingen vertsmapper/hemmelighets-env, ingen git-remote/credential | docker |
| `J06_ressursgrenser` | minnegrense (OOM), PID-grense, tidsavbrudd dreper containeren | docker |
| `J07_nettverk_deny_by_default` | ingen direkte rute ut; ingen DNS-oppslag av eksterne navn; vertsporter utilgjengelige unntatt proxyen; hver oppføring i `egress_proxy.allow` (standard `api.anthropic.com:443`) gir 200, `github.com:443`/`api.github.com:443` gir 403 med mindre DU har åpnet dem (da rapporteres det som ADVARSEL); fremmed/privat/metadata nektet; kun CONNECT; jobb-containere når ikke hverandre; IPv6-observasjon | docker, brannmur |
| `J08_kansellering` | DELETE midt i en kjørende `exec` dreper containeren umiddelbart | docker |
| `J09_reclaim_etter_krasj` | `--with-restart`: SIGKILL på runneren; etter restart er rest-containere og -kataloger borte | root, systemd |
| `J10_ttl` | `--with-ttl`: TTL-rydderen fjerner en jobb | docker |
| `J11_ende_til_ende_publish` | jobb → commit i container → publish → branch `jarvis/accept-…` i sandbox-repoet; `main`/beskyttede navn/`.github`/ingen endringer avvist | GitHub, PAT |
| `J12_logger_uten_hemmeligheter` | journal for begge tjenester har ingen token/PAT-treff; gitleaks hvis tilgjengelig | journalctl |
| `J13_live_claude` | `ACCEPT_LIVE_CLAUDE=1`: ekte Claude Code `-p` fra containeren via proxyen til `api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `M01_github_beskyttelse` | MANUELL: branch protection på `main`, PAT-rettigheter (kun ett repo, ingen admin), PR krever menneskelig merge | du |

Etter akseptansen: kjør **én ekte kodejobb gjennom Jarvis** mot sandbox-repoet (be Jarvis gjøre en liten endring), kontroller at en PR dukker opp som du må merge selv, at
`sudo journalctl -u jarvis-job-runner` viser `job_created` og `job_published`, og at `sudo docker ps -a --filter label=jarvis.role=job` er tom etterpå.

## 7. D-32: de 21 portene og hva som beviser dem

Kolonnen «Repo-bevis» er tester som kjøres i CI/sandbox (fake docker, ekte git); «Vertsbevis» er sjekker i `ops/job-runner/acceptance.sh` som kjøres av deg på NAS-en. Status:
`BYGGET` (kode + repo-bevis finnes; vertsbevis gjenstår), `DELVIS` (deler bevist, deler ikke), `EIER` (GitHub-/verts-innstilling du må gjøre), `UTENFOR_WP` (ikke WP-C1 sitt ansvar).
Ingen port er «lukket» før vertsbeviset er kjørt og lest.

| Port | D-32-krav | Repo-bevis | Vertsbevis | Status |
|---|---|---|---|---|
| 1 | Egen kastbar container per jobb | `ops/job-runner/test/lifecycle.test.mjs`, `ops/job-runner/test/container-spec.test.mjs` | `J03_container_per_jobb` | BYGGET |
| 2 | Uten privileged | `ops/job-runner/test/container-spec.test.mjs`, `ops/job-runner/test/docker-cli-argv.test.mjs`, `ops/job-runner/test/docker-engine.test.mjs` | `J04_docker_inspect` | BYGGET |
| 3 | Ingen Docker-socket montert | `ops/job-runner/test/container-spec.test.mjs`, `ops/job-runner/test/infra.test.mjs`, `ops/job-runner/test/docker-engine.test.mjs` | `J04_docker_inspect`, `J05_inne_i_containeren` | BYGGET |
| 4 | Ingen host-home/SSH/generelle secrets montert | `ops/job-runner/test/container-spec.test.mjs`, `ops/job-runner/test/api.test.mjs`, `ops/job-runner/test/credentials.test.mjs`, `ops/job-runner/test/docker-engine.test.mjs`, `ops/job-runner/test/adversarial.test.mjs` | `J01_filrettigheter`, `J04_docker_inspect`, `J05_inne_i_containeren` | BYGGET |
| 5 | Kun jobb-workspace tilgjengelig | `ops/job-runner/test/container-spec.test.mjs`, `ops/job-runner/test/lifecycle.test.mjs`, `ops/job-runner/test/docker-engine.test.mjs` | `J04_docker_inspect`, `J05_inne_i_containeren` | BYGGET |
| 6 | Ikke-root der praktisk | `ops/job-runner/test/container-spec.test.mjs`, `ops/job-runner/test/infra.test.mjs`, `ops/job-runner/test/lifecycle.test.mjs` | `J04_docker_inspect`, `J05_inne_i_containeren` | BYGGET |
| 7 | Unødvendige capabilities fjernet | `ops/job-runner/test/container-spec.test.mjs`, `ops/job-runner/test/docker-cli-argv.test.mjs`, `ops/job-runner/test/docker-engine.test.mjs` | `J04_docker_inspect`, `J05_inne_i_containeren` | BYGGET |
| 8 | CPU/minne/PID/timeout-grenser testet | `ops/job-runner/test/container-spec.test.mjs`, `ops/job-runner/test/lifecycle.test.mjs`, `ops/job-runner/test/api.test.mjs`, `ops/job-runner/test/docker-engine.test.mjs`, `ops/job-runner/test/adversarial.test.mjs` | `J04_docker_inspect`, `J06_ressursgrenser`, `J10_ttl` | BYGGET |
| 9 | Nettverk deny-by-default eller jobb-allowlist | `ops/job-runner/test/egress-proxy.test.mjs`, `ops/job-runner/test/infra.test.mjs`, `ops/job-runner/test/lifecycle.test.mjs`, `ops/job-runner/test/config.test.mjs`, `ops/job-runner/test/docker-engine.test.mjs`, `ops/job-runner/test/adversarial.test.mjs` | `J04_docker_inspect`, `J07_nettverk_deny_by_default` | BYGGET |
| 10 | Kun jobbspesifikke tokens injisert | `ops/job-runner/test/credentials.test.mjs`, `ops/job-runner/test/credential-source.test.mjs`, `ops/job-runner/test/api.test.mjs`, `ops/job-runner/test/adversarial.test.mjs` | `J01_filrettigheter`, `J04_docker_inspect`, `J05_inne_i_containeren`, `J12_logger_uten_hemmeligheter` | BYGGET |
| 11 | Cancellation stopper faktisk container/prosess | `ops/job-runner/test/lifecycle.test.mjs`, `ops/job-runner/test/adversarial.test.mjs`, `ops/job-runner/test/docker-engine.test.mjs` | `J08_kansellering` | BYGGET |
| 12 | Crash/reclaim testet i ekte runtime | `ops/job-runner/test/lifecycle.test.mjs`, `ops/job-runner/test/fsutil.test.mjs`, `ops/job-runner/test/docker-engine.test.mjs` | `J09_reclaim_etter_krasj` | DELVIS |
| 13 | To workers kan ikke ferdigstille samme lease | `modules/tasks/test/d393-worker-lease.test.ts`, `modules/tasks/test/fase6-worker.test.ts` | — | UTENFOR_WP |
| 14 | Minst én ekte kodejobb job→sandbox→agent→branch→tests→commit→push→PR | `ops/job-runner/test/publish.test.mjs`, `modules/tasks/test/wpc1-coding-host-runner.test.ts`, `modules/tasks/test/wpc1-host-job-runner-client.test.ts` | `J11_ende_til_ende_publish`, `J13_live_claude` | DELVIS |
| 15 | Kun jobb-branch kan pushes | `ops/job-runner/test/publish.test.mjs`, `ops/job-runner/test/api.test.mjs`, `ops/job-runner/test/adversarial.test.mjs` | `J11_ende_til_ende_publish` | BYGGET |
| 16 | `main` beskyttet mot autonom push/merge | `ops/job-runner/test/publish.test.mjs` | `J11_ende_til_ende_publish`, `M01_github_beskyttelse` | EIER |
| 17 | PR krever menneskelig merge | `modules/tasks/test/pr-publisher.test.ts`, `modules/tasks/test/fase6-worker.test.ts` | `M01_github_beskyttelse` | EIER |
| 18 | Force-push/sletting av beskyttet branch utilgjengelig for worker-mandat | `ops/job-runner/test/publish.test.mjs` | `M01_github_beskyttelse` | EIER |
| 19 | Klasse D/policy/kill-switch regresjonstestet i ekte miljø | — | — | UTENFOR_WP |
| 20 | Gitleaks på produsert branch/artifacts | `ops/job-runner/test/credentials.test.mjs` | `J12_logger_uten_hemmeligheter` | DELVIS |
| 21 | Dokumentert i PROJECT_STATUS | — | — | UTENFOR_WP |

Merknader til tabellen:

* **12** er bevist med fake docker (oppstartsavstemming fjerner containere merket `jarvis.role=job` og UUID-kataloger, også trær agenten har gjort uryddelige: ugyldige UTF-8-navn, dypere enn PATH_MAX, modus 000). Ekte krasj mot ekte Docker er J09 (`--with-restart`).
* **2-8, 11** har i tillegg et bevis mot den EKTE Docker-CLI-en (`docker-engine.test.mjs`): CLI-en kjøres mot en falsk Engine API og vi leser containerkonfigurasjonen den sender (privileged=false, cap-drop ALL, read-only, no-new-privileges, grenser, kun `/work` bind-montert, ingen docker.sock, exec-`Cmd` ordrett, `rm -f -v`). Det er fortsatt IKKE bevis for at en ekte daemon håndhever det (J04-J08).
* **13, 19, 21** er ikke runner-ansvar: lease er allerede bevist i Fase 6-testene (kjøres mot embedded Postgres), policy-/kill-switch-regresjon i ekte miljø hører til UA-0/UA-5-akseptansen
  (`ops/acceptance/nas-ua0-gate.sh`), og PROJECT_STATUS oppdateres av koordinator (levert som DOCS_FRAGMENT).
* **14** er DELVIS: hele kjeden worker → runner → container → bundle → verifisert push er bevist i repoet med fake docker og ekte git; en ekte Claude Code-kjøring, ekte GitHub-push og PR er J11/J13 + «én ekte kodejobb» (kapittel 6).
* **16-18** avhenger av *GitHub-innstillinger du setter* (kapittel 4, steg 7): branch protection og PAT-rettigheter. Runneren pusher kun `refs/heads/jarvis/<id>`, aldri med `+`/force og aldri tom kilde (sletting), men
  det som faktisk hindrer en administrator-PAT i å røre `main` er GitHub. Derfor `EIER`.
* **20** er DELVIS: runnerens logger er bevist uten hemmeligheter i repoet; gitleaks på den pushede branchen kjører i repoets CI på PR-en, og J12 kjører gitleaks lokalt hvis det er installert (og `GH_TOKEN` med lesetilgang er satt).

## 8. Konfigurasjonsreferanse (`/etc/jarvis/job-runner.json`)

`version` må være `1`. Ukjente nøkler avvises på hvert nivå. Filen leses kun ved oppstart (endring = `sudo systemctl restart jarvis-job-runner jarvis-egress-proxy`).
Miljøvariabelen `JARVIS_JOB_RUNNER_CONFIG` (satt i enhetene) peker på filen.

**`runner`** (jobb-tjenesten)

| Nøkkel | Standard | Betydning |
|---|---|---|
| `socket_path` | `/var/lib/jarvis-job-runner/sock/runner.sock` | Unix-socket (modus `0660`); aldri TCP. Katalogen `sock/` er **persistent** (`0750`, laget av `install-host.sh`, slettes aldri) - se under |
| `socket_group` | (primærgruppen) | gruppenavn eller gid som eier socketen |
| `token_file` | **påkrevd** | bearer-token (fil, `0640 root:jarvis-job-clients`) |
| `base_dir` | `/var/lib/jarvis-job-runner/jobs` | jobbkataloger (`0700`); smalt tegnsett (brukes i `--mount`) |
| `docker_bin`, `git_bin`, `docker_host` | `/usr/bin/docker`, `/usr/bin/git`, (ingen) | kjørbare filer og valgfri `unix:///…`-socket. `docker_bin` må være selve CLI-binæren, ikke et skallskript (jobb-env videreføres til docker-prosessen for `-e NAVN`) |
| `git_memory_limit_mb`, `prlimit_bin` | `1024`, `/usr/bin/prlimit` | 256-65536. Adresserom-grense (`prlimit --as`) for hvert LOKALT vertsside git-kall som leser agentens objekter (`fetch` av bundle = `index-pack`, `fsck`, `rev-parse`, `merge-base`, `rev-list`, `diff-tree`) - en delta-bombe feiler da med «Out of memory» i stedet for å ta vertens minne. Må være minst `publish.max_bundle_bytes` (MiB) + 256, ellers nekter oppstart. Nettverkskall (base-henting, `ls-remote`, `push`) er IKKE begrenset: credential-helperen er Node og trenger ca. 750 MiB adresserom bare for å starte. `prlimit_bin` må finnes og virke (selvtest ved oppstart: `git_memory_limit_unusable`) |
| `image` | **påkrevd** | `sha256:<64 hex>` (lokal image-ID) eller `navn@sha256:<digest>`; nullet plassholder avvises |
| `network` | **påkrevd** | dedikert jobbnettverk (aldri `host`/`bridge`/`none`/`default`); må være `--internal` ved oppstart og før hver jobb |
| `egress_proxy_url` | **påkrevd** | `http://<gateway-ip>:<port>` (IP-literal) |
| `user` | `10001:10001` | uid:gid i containeren (ikke root); **uid må være runnerens uid** (runneren må eie filene agenten skriver) |
| `memory`, `cpus`, `pids_limit`, `tmpfs_size` | `1g`, `1.0`, `256`, `256m` | `--memory` (swap = minne), `--cpus`, `--pids-limit` 16-32768, tmpfs for `/tmp` og `/home/job` |
| `max_concurrent_jobs` | `2` | 1-16; plass reserveres synkront (to samtidige POST kan aldri ta siste plass) |
| `max_job_lifetime_s` | `3600` | 60-86400; TTL-rydderen dreper og fjerner eldre jobber |
| `default_exec_timeout_ms`, `max_exec_timeout_ms` | `60000`, `900000` | tidsavbrudd per `exec`; overskridelse dreper hele containeren |
| `max_output_bytes` | `2097152` | tak på stdout/stderr per `exec` (2 MiB) |
| `max_body_bytes` | `262144` | tak på API-forespørsel (256 KiB) |
| `allowed_repos` | **påkrevd** | liste `owner/repo` (små bokstaver; repo-navnet kan ikke starte med `-`, det ville vært et git-flagg); alt annet gir 403 |
| `git_credentials` | **påkrevd** | én oppføring per allowlistet repo: `{ "token_file": "/etc/jarvis/git-token-…" }` (PAT i fil = `source: file`, **standard**) eller `{ "source": "request" }` (kortlevd token fra worker, kapittel 15). Nøyaktig én kilde per repo |
| `branch_prefix` | `jarvis/` | publiserte branches må starte med dette (ender alltid på `/`, så `main` er umulig) |
| `env_allow` | `["ANTHROPIC_API_KEY"]` | allow-liste over env-NAVN en jobb kan få (create og exec); alt annet gir `env_name_forbidden`. Hvert navn må i tillegg bestå deny-listen (`PATH`, `LD_*`, `DOCKER_*`, proxy, credentials ... kan aldri åpnes). Tom liste = ingen env. Se kapittel 16, punkt 2 |
| `clone_depth`, `clone_timeout_ms` | `50`, `300000` | grunn henting av base-branchen |
| `publish` | se under | grenser for publisering |
| `git_identity` | `jarvis-worker`, `worker@jarvis.local` | forfatter/committer i containeren |
| `sweep_interval_s` | `15` | hvor ofte TTL-rydderen kjører |

**`runner.publish`:** `max_bundle_bytes` (67108864), `max_commits` (20), `max_files` (500), `deny_paths` (`.github/`, `.gitmodules`, `.gitattributes`, `.lfsconfig`), `timeout_ms` (180000).

**Slik leses `deny_paths` (som `.gitignore`):** en oppføring med ÉN komponent (`.gitattributes`, `.lfsconfig`, `.github/`, `secrets/`) treffer en fil eller mappe med det navnet på ALLE nivåer (`src/.gitattributes`, `pakke/.github/workflows/x.yml`) og alt under; en oppføring med sti (`ci/secrets/`, `infra/prod`) gjelder kun fra repo-roten. En avsluttende `/` er kosmetisk. Sammenligningen er uavhengig av store/små bokstaver, usynlige tegn og etterfølgende punktum/mellomrom, og NTFS-kortnavn
(`gitatt~1`, `gitatt~2`, `gi7d29~1`, `gitmod~1`, `gi7eba~1`, `lfscon~1`, `github~1` ...) regnes som navnet de står for. Lignende navn (`foo.gitattributes.md`, `docs/gitmodules.txt`) treffes ikke. `.gitignore` står bevisst IKKE på standardlisten: den kan ikke skjule en allerede committet endring, kun hindre fremtidige `git add`. Du kan ikke uttrykke «bare i roten» for en enkelt komponent (strengere er trygt); en `.`-komponent i oppføringen avvises (ville blitt en stille no-op).

**`runner.git_credentials[repo]`:** `source` (`file` er standard når `token_file` står; `request` = worker leverer et kortlevd token i forespørselen) og `token_file` (påkrevd for `file`, **forbudt** for `request`: tvetydig = nektet, aldri en
stille fallback fra den ene kilden til den andre). Ukjente nøkler og alle andre verdier for `source` (også `null`/tom streng/annen case) gir `ConfigError`, og tjenesten starter ikke. Endring krever `sudo systemctl restart jarvis-job-runner`.

**`egress_proxy`** (proxy-tjenesten)

| Nøkkel | Standard | Betydning |
|---|---|---|
| `listen_host` | **påkrevd** | jobbnettverkets gateway-IP (aldri `0.0.0.0`) |
| `listen_port` | `3128` | 1024-65535 |
| `allow` | `api.anthropic.com:443` | eksakte `vert:port` (kun DNS-navn, aldri IP-literal). **Standard er KUN Anthropic (B-M3):** `github.com:443`/`api.github.com:443` må du legge til selv, og det åpner en eksfiltreringsvei (kapittel 16, punkt 8) |
| `max_connections`, `max_connections_per_client` | `64`, `16` | samtidige tunneler. I tillegg (ikke konfigurerbart): tak på RÅ tilkoblinger per klient-IP = 2 x `max_connections_per_client` (avvises før noe er lest), header-timeout 5 s og request-timeout 10 s (B-L1), så én jobb ikke kan fylle alle plasser med halvsendte forespørsler |
| `allowed_client_cidrs` | **påkrevd** | jobbnettverkets subnett (første oppføring leses også av `setup-network.sh`) |
| `idle_timeout_ms`, `connect_timeout_ms`, `max_tunnel_ms` | `120000`, `10000`, `3600000` | tidsavbrudd |

**Miljøvariabler (worker-siden)** - kun stier og modus, aldri hemmeligheter: `JARVIS_JOB_RUNNER` (`host`), `JARVIS_JOB_RUNNER_SOCKET`, `JARVIS_JOB_RUNNER_TOKEN_FILE`;
`JARVIS_JOB_RUNNER_GID` (numerisk gid, kun for overriden). Alt annet (image, nettverk, grenser, repoer) bestemmes av filen over og kan ikke settes fra worker.

## 9. API (Unix-socket, `Authorization: Bearer <token>`)

| Kall | Body | Svar |
|---|---|---|
| `GET /v1/health` | - | `200 {status:"ok", api_version, active_jobs, max_jobs}` |
| `POST /v1/jobs` | `{repo, base_branch?, env?, task_id?, tenant_id?, git_token?}` | `201 {job_id, workdir:"/work", head_sha, base_branch, expires_at}` |
| `POST /v1/jobs/:id/exec` | `{argv:[…], timeout_ms?, env?}` | `200 {code, stdout, stderr, truncated, timed_out}` (tidsavbrudd: `code` 124, containeren er drept og jobben `terminated`) |
| `POST /v1/jobs/:id/publish` | `{branch, git_token?}` | `200 {branch, commit_sha, base_sha, commits, files_changed}` |
| `DELETE /v1/jobs/:id` | - | `200 {deleted:true,state:"gone"}` (idempotent) eller `202 {deleted:false,state:"cleanup_pending"}` |

`env`-navn må stå i `runner.env_allow` (standard: KUN `ANTHROPIC_API_KEY`) og i tillegg bestå deny-listen (credentials/git-konfig/proxy/`PATH`/`HOME`/`LD_*`/`DOCKER_*`/vault-navn kan aldri åpnes); verdier legges i containeren som miljø (aldri i argv).
**Én forespørsel per forbindelse:** alle svar har `Connection: close`, så en ekstra (rørlinjet) forespørsel på samme forbindelse behandles aldri - den kunne ikke blitt besvart og ville etterlatt en jobb ingen kjenner id-en til.
`git_token` finnes KUN i `POST /v1/jobs` (klone) og `POST /v1/jobs/:id/publish` (push) - aldri i `exec`, `DELETE` eller `env` (ukjent felt) - og er **påkrevd** for repoer med `source: request` og **forbudt** for `file`-repoer. Form: `ghs_`/`ghp_`/`github_pat_` + `[A-Za-z0-9_.-]`,
20-8192 tegn. Det brukes til ÉN operasjon: tokenet fra klonen gjenbrukes aldri til publish (worker sender et fersk). Verdien ekkoes aldri i et svar eller en feil. Feil har alltid formen
`{error:"<stabil kode>", detail?:"<renset>"}`: `unauthorized` 401, `unknown_field`/`invalid_request`/`env_name_forbidden`/`branch_invalid` 400, `repo_not_allowed` 403, `job_not_found` 404,
`job_busy`/`job_terminated`/`job_not_ready` 409, `too_many_jobs` 429, `git_token_invalid`/`git_token_required`/`git_token_in_env` 400, `git_token_not_accepted` 403, `no_changes`/`path_denied`/`bundle_*` 422, `git_credential_unavailable` 403/502/504, `git_network_failed`/`push_failed`/`push_rejected`/
`container_*_failed` 502, `docker_unavailable`/`job_network_not_internal`/`job_network_missing` 503, `bundle_timeout` 504. `env_values_limit_exceeded` 400 (over 64 ulike hemmelige env-verdier eller 256 KiB per jobb, A-F8); `bundle_invalid` med detalj `commit_identity_not_allowed` 422 (A-F4). `git_output_truncated` (status følger trinnet, detalj = trinnets kode) = vertsside git ga mer utdata enn taket; trinnet feiler lukket i stedet for å tolke en avkortet liste som komplett.

## 10. Nettverk og brannmur (D-32 port 9) - detaljer

* `setup-network.sh` oppretter `jarvis-jobs` med `--internal`, `--subnet`, `--gateway`, bridge `br-jarvis-jobs` og `enable_icc=false` (jobb-containere når ikke hverandre). Det **sletter eller omskaper aldri**
  et eksisterende nettverk: avviker det (ikke internt, feil subnett, `icc` på), feiler skriptet og forklarer.
* **Hvorfor INPUT-regler?** Dockers dokumentasjon («Gateway modes») sier at containere på et internt nettverk kan nå tjenester på verten som lytter på bridge-adressen (også tjenester som lytter på «any»). Uten reglene
  kunne en jobb nå SSH, NAS-grensesnitt og SMB. Kjeden `JARVIS-JOBS-IN` slipper inn kun `tcp <gateway>:<proxy-port>` og avviser resten, og hoppet `-i br-jarvis-jobs -j JARVIS-JOBS-IN` ligger øverst i `INPUT`
  (settes inn først, deretter fjernes eventuelle duplikater - aldri et vindu uten dekning). Reglene røres bare i denne kjeden (`iptables-restore --noflush`).
* **Etter en brannmur-reload eller NAS-oppdatering** som tømmer `INPUT` (ufw/firewalld/UGOS): kjør `sudo infra/job-runner/setup-network.sh` (eller restart `jarvis-egress-proxy`, som gjør det som `ExecStartPre`) og deretter
  `acceptance.sh` J07. `sudo infra/job-runner/setup-network.sh --check` viser om reglene finnes.
* **nftables-vert uten `iptables`:** skriptet krever `iptables` (nft-varianten fungerer). Tilsvarende regler i `nft` (syntaks sjekket med `nft -c -f` i nftables 1.0.9 i sandboxen - **ikke** lastet inn i en ekte brannmur og ikke testet på verten;
  verdiene må tilsvare `egress_proxy` i konfigen):
  ```
  table inet jarvis_jobs {
    chain input {
      type filter hook input priority -10; policy accept;
      iifname "br-jarvis-jobs" ip daddr 172.30.77.1 tcp dport 3128 accept
      iifname "br-jarvis-jobs" meta l4proto tcp reject with tcp reset
      iifname "br-jarvis-jobs" reject with icmp type port-unreachable
    }
  }
  ```
* **Adressevalidering i proxyen:** DNS-svaret vurderes på BYTENE, ikke teksten: IPv4 innebygd i IPv6 (IPv4-mappet `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96`, SIIT `::ffff:0:a.b.c.d`, 6to4 `2002::/16`) sjekkes mot IPv4-reglene uansett om adressen skrives i hex, full form eller punktdesimal (en tidligere tekst-regex slapp `64:ff9b::7f00:1` gjennom). I tillegg er hele `2001::/23` (Teredo, benchmarking, ORCHID m.fl.), dokumentasjon, SRv6, lokal NAT64, site-local og IPv4-kompatible adresser nektet.
* **IPv6 (B-L3):** nettverket opprettes uten `--ipv6`. `setup-network.sh` setter i tillegg en `ip6tables`-kjede `JARVIS-JOBS-IN6` (kun `DROP`) med hopp øverst i `INPUT` for jobbnettverkets bridge, idempotent og med `--check`; mangler `ip6tables`, advares det (ikke fatalt). At containeren ikke har en ikke-loopback IPv6-adresse er **ikke verifisert**; J07 skriver tallet (forventet 0) som observasjon.
* **FORWARD er Dockers (B-L3, gap):** `setup-network.sh` rører bare `INPUT`. Isolasjonen mot trafikk gjennom verten (`FORWARD`) hviler på at Docker selv blokkerer et `--internal` nett; den er **ikke** testet her (J07 prøver direkte TCP ut og mellom containere).
* **Reglene settes bare ved proxy-start (B-L3, gap):** `ExecStartPre` kjører `setup-network.sh`, men en brannmur-reload (ufw/firewalld/UGOS) som tømmer `INPUT` åpner hullet igjen uten at noe merker det. Mottiltak: `sudo infra/job-runner/setup-network.sh --check` (endrer ingenting, exit 1 ved avvik) i en timer du selv eier og varsler på, f.eks. en `systemd`-timer/cron hvert 5. minutt, og `systemctl restart jarvis-egress-proxy` etter hver reload. Timeren er **ikke levert eller testet**.
* **Alternativ uten vertsprosess som lytter på bridgen:** kjør proxyen som en container på både jobbnettverket og et vanlig nett, og bruk Dockers `isolated` gateway-modus for jobbnettverket. Det er bare **beskrevet**, ikke bygget eller testet.
* Proxyen svarer kun på `CONNECT vert:port` (200 for allowlist, 403/400 ellers, 405 for vanlig HTTP). Den logger aldri innhold, kun `vert:port` og årsak.

## 11. Hva runneren verifiserer før den pusher (publish)

Hvert trinn feiler lukket, og ingen git kjøres mot agentens katalog: (1) headeren i bundlen parses strengt (versjon 2, nøyaktig én ref `HEAD`, nøyaktig én forutsetning = basecommit, `PACK`-signatur);
(2) bundlen hentes inn i et ferskt bare-repo; (3) `git fsck --strict` (fetch fsck-er *ikke* bundler - målt); (4) SHA = headerens, etterkommer av basen, ingen merge-commits, ≤ `max_commits`;
(5) endrede stier: `.git`-komponenter (store/små bokstaver, usynlige tegn, etterfølgende punktum/mellomrom, NTFS-kortnavnet `git~1`, alternative datastrømmer = enhver komponent med `:`), nekteliste (`.github/`, `.gitmodules`, `.gitattributes`, `.lfsconfig` osv. - på ALLE nivåer for oppføringer med én komponent, også etterfølgende punktum/mellomrom og NTFS-kortnavn som `github~1`, `gitmod~1`, `gitatt~2`), submodul/gitlink avvist, ≤ `max_files`, ingen tomme endringer. `diff-tree`-utdataene leses med et tak utledet av `max_files` (maks `max_files + 1` oppføringer à 4196 byte): en diff innenfor grensen avkortes aldri, og AVKORTET git-utdata (uansett trinn) er en feil (`git_output_truncated`, for diff-tree `bundle_too_many_files` med detalj `diff_output_truncated`), aldri en «komplett» liste - ellers ville stier etter kuttpunktet aldri blitt sjekket mot nektelisten. Trinn 2-5 kjører under `prlimit --as` (`git_memory_limit_mb`); (6) `git push <sha>:refs/heads/<prefiks><id>` uten force, uten sletting,
med runnerens credential. Ingenting av dette er kjørt mot ekte GitHub (J11).

## 12. Drift og feilsøking

| Symptom | Sannsynlig årsak | Tiltak |
|---|---|---|
| Kodejobb feiler med `job_container_runner_not_configured:…` | worker mangler `JARVIS_JOB_RUNNER=host`/socket/token (overriden ikke brukt) | kapittel 4, steg 6 |
| `host_job_runner_error:unreachable` | runner ikke startet, eller worker mangler gruppen/mounten | `systemctl status jarvis-job-runner`; `sudo ls -ld /var/lib/jarvis-job-runner/sock` (skal være `drwxr-x--- jarvis-runner jarvis-job-clients`); `JARVIS_JOB_RUNNER_GID` |
| `host_job_runner_error:unauthorized` | token endret uten at worker så det | kapittel 5 |
| Runner starter ikke: `config_must_be_owned_by_root` / `config_writable_by_group_or_others` | feil eier/modus på `job-runner.json` | `sudo chown root:root …; sudo chmod 0644 …` |
| `runner.image:placeholder_not_replaced` | eksempelkonfigen er ikke tilpasset | kapittel 4, steg 2 og 4 |
| `container_user_must_equal_service_uid` | `runner.user` har annen uid enn `jarvis-runner` | sett `user` til `<uid for jarvis-runner>:<gid>` (`id jarvis-runner`) |
| `job_network_not_internal` / `job_network_missing` | nettverket mangler eller er omkonfigurert | `sudo infra/job-runner/setup-network.sh`; ikke-internt nett må fjernes manuelt (`docker network rm jarvis-jobs`) |
| `git_credential_unavailable` (403/502) | PAT-fil mangler, feil eier/modus (åpnere enn `0400`/`0600` nektes), feil format, repo ikke i `git_credentials` | `ls -l /etc/jarvis/git-token-*` (skal være `-r-------- jarvis-runner`) |
| `git_token_required` (400) | repoet står som `source: request`, men worker sendte ikke token (worker uten `gitCredentialSource`, eller GitHub App ikke aktiv) | kapittel 15; eller sett repoet tilbake til `token_file` og restart runneren |
| `git_token_not_accepted` (403) | worker sendte token for et repo som står som `source: file` (standard) | sett repoet til `{ "source": "request" }` og restart runneren, eller fjern kilden hos worker |
| `git_token_invalid` / `git_token_in_env` (400) | tokenet er ikke `ghs_`/`ghp_`/`github_pat_` 20-8192 tegn, eller samme verdi lå i jobb-`env` | worker-bug: tokenet ekkoes aldri, så se worker-loggen (`host_job_runner_error:…`) |
| `host_job_runner_error:git_credential_unavailable:<kode>` (fra worker, status 0) | kilden hos worker (GitHub App) kastet, hang (30 s) eller ga et uvelformet token; ingenting ble sendt til runneren | `<kode>` er en stabil kode (f.eks. `GITHUB_APP_…`), aldri kildens melding; se WP-C3-runbooken for GitHub App |
| `env_name_forbidden` (400) ved opprettelse eller `exec` | worker sendte et env-navn som ikke står i `runner.env_allow` (standard kun `ANTHROPIC_API_KEY`), eller navnet stoppes av deny-listen | åpne navnet i `env_allow` KUN hvis det er ufarlig, og `sudo systemctl restart jarvis-job-runner`; `PATH`/`HOME`/`LD_*`/`DOCKER_*`/proxy/credential-navn kan aldri åpnes (oppstart nektes) |
| `bundle_fsck_failed` (422) ved HVER publish | `fsck --strict` sjekker også basens objekter (lånt via alternates): et gammelt objekt med f.eks. gruppe-skrivbar filmodus (100664) i de siste `clone_depth` commitene feiler strengt | se `detail`; skriv aldri om historikk for dette. Sett `clone_depth` lavere, eller rapporter det - dette er en funksjonell begrensning, ikke en sikkerhetsfeil |
| `git_network_failed` ved opprettelse | proxy/DNS/PAT feil, eller GitHub utilgjengelig fra verten | `sudo journalctl -u jarvis-job-runner -n 50`; test `git ls-remote` manuelt som `jarvis-runner` uten å skrive token noe sted |
| `path_denied`, `bundle_*`, `no_changes` ved publish | endring rammet en regel (kapittel 11) | les `detail`; fjern `.github/`-endringer, del opp i færre commits/filer |
| `bundle_fetch_failed` med «Out of memory» i detaljen | `prlimit --as` stoppet en pakke som vil ekspandere til mer enn `git_memory_limit_mb` (delta-bombe, eller et reelt stort objekt) | en legitim stor fil (> ca. 200 MiB) krever høyere `git_memory_limit_mb` (og `MemoryMax=` i enheten); ellers er avvisningen riktig |
| `git_output_truncated` (422/502) | et git-trinn ga mer utdata enn taket (for diff-tree: flere filer/lengre stier enn `publish.max_files` tillater) | del opp endringen; for diff-tree vises det som `bundle_too_many_files` |
| Runner starter ikke: `git_memory_limit_unusable` / `git_memory_limit_not_configured` | `prlimit` mangler, er ikke `runner.prlimit_bin`, eller git kan ikke kjøre under grensen | `prlimit --version`; installer util-linux; kontroller `git_memory_limit_mb` (≥ 256 og ≥ bundle-tak + 256) |
| `bundle_invalid` / `commit_identity_not_allowed` | en commit har en annen forfatter/committer enn `runner.git_identity` (agenten brukte `--author`, `GIT_AUTHOR_*`, cherry-pick av andres commit e.l.) | agenten skal committe med den faste identiteten i containeren; avvisningen er riktig |
| `env_values_limit_exceeded` (400) | en jobb har sendt over 64 ulike hemmelige env-verdier eller over 256 KiB samlet (A-F8) | worker-bug eller angrep; verdiene dedupes, så ordinær bruk (én nøkkel) når aldri taket |
| Runner starter ikke: `another_instance_is_listening` | en annen runner lytter på samme socket | stopp den først; en nektet instans rører ikke den første sine jobber (A-F6) |
| `install-host.sh` avslutter med «er en symlenke: avviser» | `/var/lib/jarvis-job-runner` eller `sock/` er byttet ut med en lenke | undersøk, fjern lenken manuelt, kjør på nytt (B-L2) |
| `push_rejected`/`push_failed` | GitHub avviste (branch protection, PAT-rettigheter, eksisterende branch med annen historikk) | sjekk PAT og branchnavn; runneren bruker aldri force |
| `container_start_failed` med «docker-init» i detaljen | Docker-installasjonen mangler `docker-init` (brukes av `--init`) | installer/gjenopprett `docker-init` ved siden av `dockerd`; ikke fjern `--init` fra koden |
| J04 melder «swap tillatt» | kjernen mangler swap-accounting, så `--memory-swap` ignoreres (OOM kan utsettes av vertens swap) | aktiver `swapaccount=1` på kjernen eller slå av vertens swap; ellers aksepter og dokumentér avviket |
| Runner/proxy stopper rett etter oppstart med `git_could_not_start`, `spawn EPERM` eller lignende | systemd-filteret `SystemCallFilter=@system-service` er for stramt for en eldre systemd (mangler `clone3` i `@system-service`) | kontroller `systemctl --version`; som siste utvei kommenter ut de to `SystemCallFilter`/`SystemCallErrorNumber`-linjene i enheten (svekker herdingen - dokumentér det) og `sudo systemctl daemon-reload` |
| Mange rester av `jarvis-job-…`-containere | runner krasjet midt i opprydding | restart runneren: oppstartsavstemmingen fjerner alt merket `jarvis.role=job` og alle UUID-kataloger i `base_dir` |
| Jobb blir stående som `cleanup_pending` (DELETE gir 202) | `docker rm -f` feilet (daemon henger), eller `rm` feilet/ble tidsavbrutt (disk, rettigheter) | `sudo journalctl -u jarvis-job-runner \| grep -E 'job_(container|dir)_remove_failed'` (årsaken er en stabil kode: `rm_failed`, `rm_timeout`, `rm_not_runnable`, `still_exists`; aldri filnavn); TTL-rydderen prøver hvert `sweep_interval_s`. Ugyldige navn og dype trær er ikke lenger en årsak |

* **Nødstopp:** `sudo systemctl stop jarvis-job-runner jarvis-egress-proxy` og `sudo docker ps -aq --filter label=jarvis.role=job | xargs -r sudo docker rm -f`. Worker feiler da lukket.
* **Logger:** `sudo journalctl -u jarvis-job-runner -u jarvis-egress-proxy`. Strukturert JSON; hendelser: `runner_started`, `job_created`, `job_published`, `job_removed`, `reconcile_done`, `request_rejected`,
  `job_create_failed`, `git_credential_source_failed`, `client_gone_during_operation`, `sweep_failed`, `egress_proxy_started`. Env-verdier, argv, tokens og credentials logges aldri (navn med `token/secret/env/argv/…` droppes, kjente hemmeligheter maskeres).
* **Avinstaller:** stopp og deaktiver enhetene, fjern `/etc/systemd/system/jarvis-*.service`, `/opt/jarvis-job-runner`, `/var/lib/jarvis-job-runner` (jobbkataloger og socket-katalogen), `docker network rm jarvis-jobs`, `sudo iptables -D INPUT -i br-jarvis-jobs -j JARVIS-JOBS-IN` (og `-F`/`-X JARVIS-JOBS-IN`),
  og slett PAT-filene. Fjern `-f infra/job-runner/docker-compose.job-runner.yml` fra worker-kallet.

## 13. `container`-modus (`JARVIS_JOB_RUNNER=container`) - ikke anbefalt

Den eldre veien kjører `docker` i **samme prosess** som worker og krever dermed en docker-klient og -socket i worker-containeren, som bevisst ikke finnes (Del 2). I tillegg skrives git-credential-helperen til workerens `tmpdir()`,
mens git kjøres via `docker exec` i en annen container (Q-46 punkt 5: «latent brukket»). Modusen er beholdt uendret for en worker som kjører direkte på en vert, men den er ikke verifisert og ikke anbefalt. Bruk `host`.

## 14. Åpne punkter (ingenting av dette er bygget)

* **GitHub App-identitet (Q-45b / WP-C3):** standard er fortsatt en fine-grained PAT per repo (`source: file`). `GitCredentialSource { tokenFor(repoSlug) -> Promise<string> }` er et injiserbart grensesnitt (strukturelt likt WP-C3 sin kontrakt), og tokens opp til 8192 tegn
  godtas (`ghs_<APPID>_<JWT>`). Av de to veiene til en kortlevd App-token er **(b) bygget som opt-in per repo** (kapittel 15: worker henter tokenet og sender det i jobbforespørselen); **(a)** (en vertsside kilde som leser App-privatnøkkelen fra en `0400`-fil hos `jarvis-runner`) er
  **ikke bygget** - den ville holdt App-nøkkelen utenfor worker helt, men gjort runneren til en GitHub-klient. Koblingen i `apps/api/src/worker-main.ts` er **ikke gjort** i WP-C1 (GitHub App-koden ligger på WP-C3-grenen): se kapittel 15, «Slik kobler du det».
* **Diskkvote per jobb finnes ikke.** Agenten kan fylle `/work` (bind-mount) til volumet er fullt, og samme volum kan være delt med Postgres/backup på NAS-en. Minimum: sett `runner.base_dir` (og dermed `StateDirectory`)
  på et eget filsystem/dataset med fast størrelse eller prosjektkvote (ext4/xfs `prjquota`), og kjør `df` mot det i overvåkingen. Å la runneren måle og drepe jobber over en grense er **ikke bygget** (et raskt skrivende program fyller disken mellom to målinger).
* Ingen støtte for Windows/PC-utvikling (kun Linux med systemd/Docker); utviklingsmaskinen bruker fortsatt prosess-sandboxen.
* Per-repo egress-allowlist og per-repo ressursgrenser finnes ikke (én policy for alle repoer).
* **Beskyttelsen mot syscalls og prosess-escape hviler på Docker-standardprofilene (seccomp, evt. AppArmor) (B-L4):** runneren sender ingen egen `--security-opt seccomp=...`. `acceptance.sh` J04/J05 sjekker at de er i kraft (`Seccomp: 2`, `NoNewPrivs: 1`, daemonens `SecurityOptions`), men en daemon med `--seccomp-profile` eller `userns-remap` endrer bildet; runner-uid i containeren må være lik vertens uid (derfor ingen `userns`).
* **Jobb-imaget (B-L8):** apt/dpkg fjernes etter bygging. IKKE løst: `/work` er ikke `noexec` (testløpere må kunne kjøre repo-kode, og en bind-mount tar ikke per-mount-flagg i `--mount`), og `git clone https://github.com/…` virker i containeren hvis DU har åpnet github.com i allowlisten (kapittel 16, punkt 8).
* Ekte Docker-isolasjon, brannmur, systemd og GitHub er ikke verifisert (se toppen). Verifiser med `acceptance.sh`.

## 15. Kortlevd git-token fra worker (GitHub App, `source: request`) - valgfritt, AV som standard

**Hva det er.** Standard (`source: file`) holder git-credentialen helt utenfor worker: en PAT i en fil bare runneren leser. Med GitHub App-autentisering (WP-C3, runbooken `GITHUB_APP.md` på WP-C3-grenen) finnes det en bedre credential:
et installasjonstoken som varer 1 time og er scopet til ETT repo. Det henter worker, og runneren kan ikke selv utstede det uten å få App-privatnøkkelen. Derfor kan du **per repo** sette `{ "source": "request" }` i `git_credentials`:
worker sender da et fersk token som `git_token` i `POST /v1/jobs` (klone) og et NYTT i `POST /v1/jobs/:id/publish` (push).

**Hva du godtar ved å slå det på.** Worker håndterer igjen en (kortlevd) git-credential. Worker har allerede App-nøkkelen (den ligger i vaulten worker leser), så runneren mister ingen sikkerhet den hadde, men det er en tillitsutvidelse du velger selv, repo for repo, i en root-eid fil.
Runneren kan IKKE kontrollere at tokenet faktisk er scopet til repoet (ingen introspeksjon mot GitHub): det er GitHubs ansvar. Runneren bruker det uansett kun til å klone akkurat det allowlistede repoet og pushe `refs/heads/jarvis/<id>` dit.

**Hva som er bevist i repoet** (`ops/job-runner/test/request-token.test.mjs`, `modules/tasks/test/wpc1-host-job-runner-token.test.ts`; ekte git mot en lokal smart-HTTP-server som krever Basic-auth og logger et fingeravtrykk av passordet per operasjon):

* policyen er fail-closed og sjekkes FØR noe reserveres: `request`-repo uten token = 400, `file`-repo med token = 403; ingen jobb, katalog, container, docker-kall eller nettverkskall ved avvisning;
* klone bruker token A og push bruker token B (aldri A til push); tokenet fra klonen gjenbrukes ikke, og ligger ikke i jobbtilstanden;
* tokenet står aldri i argv til noe git-kall, og leveres kun som env til `ls-remote`, `fetch` mot remote og `push` - ikke til `init`, lokal klone, `fsck`, `rev-list` e.l.;
* tokenet finnes ikke i docker-argv/-env, containeren, arbeidsmappen, `.git/config`, filsystemet, loggen eller noe svar - heller ikke når en server **reflekterer passordet** i en git-protokollfeil slik at git skriver hele tokenet på stderr (da er det `[REDACTED]`);
* et token for ett repo virker ikke mot et annet (serveren binder credentials til repo-sti), også med to samtidige jobber;
* 900 og 8192 tegn gjennom hele kjeden body -> env -> credential-helper -> git -> `Authorization`;
* formkontroll: kun `ghs_`/`ghp_`/`github_pat_` (en feilsendt Anthropic-nøkkel, bearer-token e.l. blir aldri et passord til github.com), 20-8192 tegn, smalt tegnsett (ingen linjeskift/`:`/`@`/`/`), samme verdi i `env` avvises;
* hemmelighetsregisteret er tellende: kortlevde tokens hoper seg ikke opp, og en avsluttet jobb tar ikke bort redigeringen for en annen jobb med samme env-hemmelighet;
* worker-klienten feiler lukket ved enhver kildefeil (kaster, henger, uvelformet svar) uten å gjengi kildens melding.

**Slik slår du det på (alle fire steg):**

1. GitHub App-autentisering er aktiv hos worker (WP-C3: `JARVIS_GITHUB_APP_ID`, `JARVIS_GITHUB_APP_INSTALLATION_ID`, privatnøkkel i vaulten) og akseptert med WP-C3-scriptet. Appen må ha minst *Contents: Read and write* og *Pull requests: Read and write* på sandbox-/produksjonsrepoet.
2. `/etc/jarvis/job-runner.json`: `"git_credentials": { "owner/repo": { "source": "request" } }` - **uten** `token_file` for det repoet. PAT-filen for det repoet kan slettes når du er fornøyd.
3. `sudo systemctl restart jarvis-job-runner` (konfigen leses kun ved oppstart; en feil i den nektes med en stabil kode i journalen).
4. **Slik kobler du det** (ikke gjort i WP-C1, fordi GitHub App-koden ligger på WP-C3-grenen): i `apps/api/src/worker-main.ts` gis kilden til runner-oppløseren, **kun når App-modus faktisk er aktiv**:
   `resolveJobSandboxRunner(process.env, { gitCredentialSource: <App-modus aktiv> ? guardGitCredentialSource(githubAuth.gitCredentialSource(…), () => ownerControls.isRevokedDurable("JARVIS_GITHUB_TOKEN")) : undefined })` (vakten gjør at eierens tilbakekalling stopper utstedelsen, B-M2). Gis en kilde i PAT-modus (WP-C3 sin `gitCredentialSource()` returnerer da PAT-en), sender worker PAT-en til runneren, og et `file`-repo avviser den
   (`git_token_not_accepted`) - jobben feiler lukket, aldri et stille bytte. Verdien av `JARVIS_JOB_RUNNER_*` er uendret.

**`revoke_credential` i host-modus (B-M2):** eierens per-credential-tilbakekalling (`owner_controls.revoke_credential` på `JARVIS_GITHUB_TOKEN`, WP-C3 F3) stopper nå også kodejobber i host-modus: `coding.ts` sjekker den FØR runneren får beskjed om å klone og FØR publish (tilbakekalt = `git_auth_revoked`, sjekken feiler = `git_auth_revocation_check_failed`), og `guardGitCredentialSource` (host-job-runner.ts) vokter kilden for `source: request` slik at ingen utstedelse skjer for en tilbakekalt credential.
**Men runnerens EGEN PAT-fil på verten er uavhengig av Jarvis** og berøres ikke av `revoke_credential`: den stopper nye jobber og publish fra Jarvis, ikke selve runneren. For å stoppe runneren helt fjerner eller roterer DU filen (kommandoer): `sudo mv /etc/jarvis/git-token-<repo> /etc/jarvis/git-token-<repo>.revoked` (neste klone/push feiler med `git_credential_unavailable`) og slett/roter tokenet i GitHub; eller `sudo systemctl stop jarvis-job-runner`.

**Slik slår du det av:** sett repoet tilbake til `{ "token_file": "/etc/jarvis/git-token-…" }` (ny PAT-fil, `0400`, eid av `jarvis-runner`), restart runneren, og la worker mangle kilden. Kjørende jobber berøres ikke av en konfigendring før restarten.

**Ikke verifisert / ikke bygget:**

* **NOT VERIFIED** mot en ekte GitHub App (installasjonstoken, scope, utløp, 401 midt i en lang jobb), ekte Docker og en ekte worker-container. Verifiser ved å sette sandbox-repoet til `source: request`, lage et token med WP-C3-scriptet og kjøre
  `ACCEPTANCE_GIT_TOKEN_FILE=<fil> ACCEPTANCE_REPO=… sudo -E ops/job-runner/acceptance.sh` (kapittel 6), og deretter én ekte kodejobb gjennom Jarvis.
* Tokenet er i prosessminnet hos runneren (og i env hos git-/helper-barneprosessene) mens operasjonen pågår; JavaScript kan ikke nullstille strenger. Enheten har `LimitCORE=0`, så en krasj skriver ingen minnedump med tokenet.
* Redigeringen er verdibasert (nøyaktig streng): et token som git skriver i en annen koding (base64/URL-kodet) ville ikke bli fanget. Git kjøres uten `GIT_TRACE*`/`GIT_CURL_VERBOSE` (renset env), så det skjer ikke i dag.
* Et token utløper etter 1 time. En kodejobb som tar lenger enn det mellom klone og publish er uproblematisk (publish får et NYTT token), men én enkelt operasjon som varer > 1 time (klone/push av en enorm bundle) ville feile; grensene `clone_timeout_ms`/`publish.timeout_ms` (5 / 3 min) ligger langt under.

## 16. Sikkerhetsantagelser - angrip disse først (til den uavhengige gjennomgangen)

Dette er hva sikkerheten FAKTISK hviler på, og hva som med vilje IKKE er løst. Alt er `NOT VERIFIED` mot ekte Docker/systemd/brannmur/GitHub til `acceptance.sh` er kjørt (kapittel 6).

1. **Tillitsgrensen er runner-koden, ikke systemd-herdingen.** `jarvis-runner` er i `docker`-gruppen = effektivt root. Ingen API-felt kan bli docker-flagg, mount, image, nettverk eller sti (flaggene bygges av `buildJobContainerCreateArgs` fra root-eid policy;
   ukjente felt avvises). En ny rute, et nytt felt eller en `exec`-variant som tar flagg bryter hele isolasjonen. Koden og policyen er root-eide og skrivebeskyttet for tjenestebrukeren. Kildekodevaktene i `adversarial.test.mjs` (gruppe J) låser at kun
   `lib/process.mjs` starter prosesser (uten shell), at ingen flagg-literaler finnes utenfor den delte spesifikasjonen, og at ruteflaten er nøyaktig de fem dokumenterte.
2. **Jobb-env settes i miljøet til den vertsside `docker`-klienten** (`-e NAVN` leser verdien derfra, så den holdes utenfor argv). Et navn klienten eller libc tolker (`LD_PRELOAD`, `GCONV_PATH`, `LOCPATH`, `GODEBUG`, `TMPDIR` ...) kunne påvirket en prosess med
   docker-gruppe. Forsvaret er nå to lag: (a) en **allow-liste** (`runner.env_allow`, standard kun `ANTHROPIC_API_KEY`) som vertsadmin eier, og (b) den delte **deny-listen** (`HOST_RUNNER_FORBIDDEN_ENV` i `modules/tasks/src/job-container-spec.mjs`), som også gjelder hvert navn
   i allow-listen ved oppstart (en admin kan ikke ved en feil åpne for `PATH`/`LD_*`/`DOCKER_*`/credentials). Åpner du flere navn, eier du risikoen. **Verdiene** er ikke et problem (docker-klienten tolker dem ikke). Det ryddigste ville vært å holde verdiene helt utenfor
   klientens miljø med `--env-file`, men `--env-file /dev/stdin` VIRKER IKKE fra Node (måling: `spawn` gir barneprosessen en socketpair, og `open("/dev/stdin")` på en socket gir ENXIO); en env-fil må være en vanlig fil (helst tmpfs), og det er **ikke bygget**.
3. **Container-uid = runner-uid (10001)** (påkrevd for at runneren kan rydde filene agenten skriver). PID-navnerommet skiller prosessene, men en kjerne-/runtime-escape gir runnerens uid, dvs. docker-gruppen og lesetilgang til PAT-filene (`0400`) og prosessminnet.
4. **Vertens git leser agent-kontrollert pakkedata** (`fetch` av bundle, `fsck --strict`, `diff-tree`, `rev-list`) i et ferskt bare-repo uten hooks/config/checkout. En minnefeil i git ville gitt kode som runner-uid. Nedmildring: git >= 2.39, `transfer.fsckObjects`, bundle-/commit-/fil-grenser og
   tidsavbrudd. **Minne (A-F3, målt av reviewer):** agenten velger pakkens innhold, og en delta-bombe (16,7 kB -> 1,52 GiB) tok 1,6 GB av vertens ledige minne og 54 s; en deklarert størrelse på 12,9 GB ga ren OOM-feil under `prlimit --as=3GiB`. To lag: (a) hvert LOKALE git-kall som leser agentens objekter kjører under `prlimit --as=<git_memory_limit_mb>`
   (standard 1024 MiB; bevist med ekte git og ekte `prlimit` i `memory-limit.test.mjs`: en 95 x 16 MiB-bombe feiler på sekunder med «Out of memory, malloc failed» FØR noe allokeres, mens en 400 MiB-bombe slipper gjennom en grense på 1024 MiB og stoppes av 384 MiB), og (b) hele enheten har `MemoryHigh=1536M`, `MemoryMax=2G`, `MemorySwapMax=0` og `OOMPolicy=continue` (kjernens OOM-killer tar det største barnet, git;
   runneren overlever i stedet for at enheten stoppes og alle jobber ryddes). Tallene er satt for standardoppsettet (2 samtidige jobber, 64 MiB bundle): øker du `max_concurrent_jobs`, `publish.max_bundle_bytes` eller `git_memory_limit_mb`, øk `MemoryMax=` tilsvarende. **NOT VERIFIED:** systemd/cgroup-effekten (kun enhetsfilen er testet; kontroller på verten at grensene er innstilt: `systemctl show jarvis-job-runner -p MemoryMax -p MemoryHigh -p MemorySwapMax -p OOMPolicy`) og en ekte `git push` mot GitHub.
   Begrensninger: nettverkskall (base-henting, `ls-remote`, `push`) er IKKE under `prlimit` fordi credential-helperen er Node (ca. 750 MiB adresserom bare for å starte); `push` kjører først etter `fsck --strict` har lest hvert objekt under grensen. En pakke som faktisk komprimerer lagres komprimert (≤ `max_bundle_bytes`), og delta-ekspansjon skjer i minnet, ikke på disk. **Ikke** nedmildret: diskbruk fra agentens `/work` (ingen kvote, kapittel 14). Selv om «containeren» fikk skrive i runnerens private mappe (worst case, testet i `adversarial.test.mjs` F), leser verts-git aldri `base.git/config`/hooks under publish.
5. **Opprydding av agent-skrevne trær** skjer med `/bin/chmod -R u+rwx` og `/bin/rm -rf --one-file-system` (GNU coreutils, fd-relativt). Det er det eneste vertsprogrammet som røres av hvordan agenten har strukturert filsystemet (ugyldige UTF-8-navn, dybde > PATH_MAX, modus 000, millioner av filer er testet).
   Antagelsen er at coreutils håndterer dette riktig og at `install-host.sh` fant GNU-varianten; en feil gir `cleanup_pending` (jobbplassen holdes), aldri en sti utenfor treet. Roten og toppnivåkataloger nektes.
6. **Socket-autorisasjon = filrettigheter + delt bearer.** Alle i gruppen `jarvis-job-clients` kan kalle alle endepunkt; jobb-id (UUIDv4) er eneste skille mellom jobber (ingen eierskap per klient), og alle kan fylle `max_concurrent_jobs` eller holde de 32 tilkoblingene åpne (30 s tidsavbrudd per forespørsel).
7. **Kortlevd token fra worker (`source: request`, kapittel 15):** runneren kan ikke kontrollere scope/utløp (ingen introspeksjon); redigeringen er verdibasert; tokenet ligger i prosessminnet hos runneren og i env hos git-/helper-barnene mens operasjonen pågår;
   en kompromittert worker kan allerede lage tokens (den har App-nøkkelen), så runneren begrenser KUN hva den selv bruker tokenet til (klone det allowlistede repoet, pushe `refs/heads/jarvis/<id>`, aldri force/sletting).
8. **Egress-proxyen er den eneste veien ut av jobb-containeren, og hva den slipper gjennom er en eksfiltreringsflate (B-M3 - tidligere undervurdert).** Standard allowlist er nå KUN `api.anthropic.com:443`; `github.com`/`api.github.com` er **ikke** med, fordi klone og push skjer
   på verten og containeren ikke trenger dem. Proxyen ser bare `CONNECT vert:port` (TLS er ugjennomsiktig): den kan ikke se eller begrense HVILKEN nøkkel/token som brukes eller HVA som sendes, bare hvilken vert. Konsekvenser, ærlig:
   * **Åpner du `github.com`/`api.github.com` (`egress_proxy.allow`)**: en prompt-injisert agent, eller repo-kode som `test_command` kjører i containeren, kan bruke HVILKEN SOM HELST PAT/API-nøkkel den finner i injisert tekst (en angriper-eid, ikke jobbens) til å pushe hele det private repoet - med full historikk - til en angriper-eid GitHub-repo, eller laste opp via API-et. Båndbredden er høy (hele repoet), ikke lav.
     J07 rapporterer det som ADVARSEL hvis du har åpnet dem. Åpne dem bare for et repo der dette er akseptabelt.
   * **`api.anthropic.com` alene har samme restrisiko, mindre åpenbar:** jobbens egen `ANTHROPIC_API_KEY` er i containerens miljø (Claude Code trenger den), og en angriper-nøkkel fra injisert tekst kan brukes mot Messages-API-et eller Files-API-et med vedlegg (opptil hundrevis av MB per fil) til å lagre kode i en angriper-eid Anthropic-konto.
     Allowlisten kan ikke skille nøkler fra hverandre; det eneste tekniske svaret ville vært en TLS-terminerende proxy som kun slipper Messages-endepunktet med jobbens egen nøkkel - **ikke bygget**. Ubetrodd kode/tekst som agenten leser (issues, filer, avhengigheter) er derfor en reell vei for å få kode ut. Mildnende: kun repoer der dette er akseptabelt i `allowed_repos`; ingen secrets i repoet; kort levetid på nøkkelen; lav `max_job_lifetime_s`.
   * Det finnes ingen per-repo egress-allowlist (kapittel 14): allowlisten gjelder alle jobber.
   **Runnerens egen** utgående trafikk (git mot github.com, docker mot sin socket) er ikke begrenset av brannmur: en kompromittert runner kan nå hva verten kan nå.
9. **Logg og feil er sanitert, ikke bevist tomme for alle kodinger.** Kjente hemmeligheter (bearer, env-verdier, git-token) redigeres som eksakte strenger i logg, feildetaljer og `exec`-output; en hemmelighet i annen koding (base64/URL-kodet) fanges ikke.
   Interne stier (`base_dir`, installasjonskatalogen) erstattes i git-/docker-feildetaljer med `<jobs>`/`<runner>`; det er best-effort (agentens egen `exec`-output er agentens og scrubbes ikke).
10. **Repoet kjører agentens kode i CI.** Runneren nekter endringer i `.github/` (workflows), men agenten kan endre `package.json`-skript, testfiler og byggekonfig som en eksisterende workflow kjører på pull request / push. `.github/workflows/ci.yml` bruker i dag ingen `secrets.*` og har begrenset `permissions`;
    holder du det slik (og krever menneskelig merge + branch protection), er CI en uskyldig mottaker. Legger du secrets i en workflow som kjører på `jarvis/**`-branches, er det en angrepsvei runneren ikke kan stenge.
11. **Én runner per Docker-daemon.** Oppstartsavstemmingen fjerner ALLE containere merket `jarvis.role=job`; en andre runner mot samme daemon ville fått sine jobber fjernet.
12. **Nettverket kontrolleres før hver jobb, ikke under den.** `--internal` verifiseres ved oppstart og før hver `create`; en omkonfigurering midt i en kjørende jobb fanges først ved neste. Brannmurreglene (INPUT-kjeden) må gjenopprettes etter en brannmur-reload (kapittel 10).
13. **Én forespørsel per forbindelse.** Node kan ha lest en rørlinjet forespørsel før forbindelsen ble lukket; den behandles ikke (testet), men en klient som bevisst åpner mange forbindelser kan holde alle 32 opptatt (se punkt 6).
14. **Bevisste redundanser (A-F10, mutanter som ikke kan drepes fordi to lag gjør det samme):** `GIT_ALLOW_PROTOCOL` i miljøet OG `-c protocol.*.allow` på kommandolinjen (M37), og `core.hooksPath=/dev/null` OG et verts-git som aldri kjører i en katalog med hooks (M45). Begge lagene beholdes med vilje (forsvar i dybden); fjernes det ene, skal det andre fortsatt holde, og ingen test kan skille dem.
