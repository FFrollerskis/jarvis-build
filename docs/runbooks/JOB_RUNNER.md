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
| Container faktisk isolert, OOM/PID/tidsavbrudd, nettverk deny-by-default, brannmurregler, reclaim etter ekte krasj, systemd-oppstart, image-bygging | **NOT VERIFIED** - `acceptance.sh` J03-J10 på verten |
| Ekte Claude Code-kjøring fra containeren via proxyen | **NOT VERIFIED** - `ACCEPT_LIVE_CLAUDE=1 ... acceptance.sh` (J13) |
| Ekte push til GitHub, branch protection, PAT-rettigheter | **NOT VERIFIED / EIER** - J11 og M01 |

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
                                   CONNECT-only, allowlist github.com / api.github.com / api.anthropic.com :443, SSRF-/DNS-rebinding-sikker
```

* Worker kan be om: opprett jobb for **ett repo i allowlisten**, kjør en kommando (argv, ingen shell), publiser en `jarvis/…`-branch, slett jobben.
  Worker kan **ikke** sende docker-flagg, mounts, image, nettverk, stier eller credentials.
* Jobb-containeren ser: `/work` (arbeidskopi uten `origin`), en tmpfs `/home/job`, en tmpfs `/tmp`, og nett kun via proxyen. Ingenting annet.
* `base.git`, `verify.git`, `out.bundle` ligger i `private/` ved siden av `work/` og er **aldri montert** i containeren.

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
4. **git-credentialen** (fine-grained PAT, ett repo) leses fra en fil som kun `jarvis-runner` kan lese, ved hver bruk, og leveres som env til **ett**
   git-kall via runnerens egen `credential.helper` (scopet til eksakt protokoll + vert + repo-sti; følger ingen redirect). Den skrives aldri til disk,
   argv, `.git/config`, logg eller container.
5. **Nettverk:** jobbnettverket er `--internal` (ingen rute ut) med `enable_icc=false`. Docker lar likevel containere på et internt nett nå tjenester på
   *verten* via bridge-adressen; derfor setter `setup-network.sh` en INPUT-kjede som slipper inn **kun** `tcp <gateway>:<proxy-port>`.

| Angrepsflate | Hva en kompromittert agent kan prøve | Hva som stopper det |
|---|---|---|
| Container-escape via flagg | be API-et om `--privileged`, `-v /:/host`, annet image/nettverk | API-skjemaet har ingen slike felt (ukjente felt avvises); argv bygges av én delt funksjon fra root-eid policy |
| git-feller i `/work` | `core.fsmonitor`, hooks, `url.*.insteadOf`, `uploadpack.packObjectsHook` | verten kjører aldri git i `/work`; bundle verifiseres i ferskt repo med `core.hooksPath=/dev/null`, ingen systemconfig, tom HOME |
| Stjele PAT | lese env/fil/prosesser i containeren | credentialen finnes ikke i containeren; ligger `0400` hos `jarvis-runner` |
| Skrive til `main`/andre branches | `git push` selv, eller be om publish til `main` | containeren har ingen credential og ingen vei til GitHub utenom proxyens CONNECT; runneren pusher kun `refs/heads/jarvis/<id>` (aldri force/sletting) |
| Smugle inn CI-/hook-filer | endre `.github/workflows`, `.gitmodules`, `.gitattributes`, `.git/…` | stiregler (hard `.git`-sperre også NTFS-varianter, konfigurerbar nekteliste, gitlink/submodul avvist) |
| SSRF via proxyen | `CONNECT 169.254.169.254:80`, `localhost:5432`, DNS-rebinding | kun allowlist `vert:port`; proxyen slår opp DNS selv, krever kun offentlige adresser og kobler til den validerte IP-en |
| Nå verten fra containeren | SSH/SMB/NAS-grensesnitt på bridge-adressen | INPUT-kjeden i `setup-network.sh` (NOT VERIFIED til J07) |
| Tømme ressurser | minnebombe, fork-bombe, evig prosess, enorm output | `--memory` uten swap, `--pids-limit`, tidsavbrudd dreper hele containeren, output-tak, maks samtidige jobber, TTL |
| Fylle disken | skrive uendelig mye (eller millioner av filer) i `/work` | **IKKE begrenset av runneren** - en bind-mount har ingen kvote og `docker --storage-opt` gjelder ikke den. Tak finnes bare for `/tmp` og `/home/job` (tmpfs). Legg `base_dir` på et eget volum/filsystem med kvote (kapittel 14) |
| Utnytte worker→runner | gjette socket/token | socket `0660` (gruppe `jarvis-job-clients`), bearer i konstant tid, ingen feilsvar som skiller ukjente ruter før autentisering |

## 3. Forutsetninger på NAS-en (kontroller før du begynner)

Alle kommandoer kjøres fra `/volume1/jarvisbuild-data/jarvisbuild` (se `NAS_UPDATE_2026-10-07.md` for innlogging). Kjør ett steg om gangen, lim inn
utdata, og stopp ved første avvik.

```
cd /volume1/jarvisbuild-data/jarvisbuild && git pull
node --version                      # MÅ være v22 eller nyere PÅ VERTEN (ikke bare i containerne)
git --version                       # >= 2.39
sudo docker version --format '{{.Server.Version}}'
sudo docker info --format '{{.SecurityOptions}}'   # skal IKKE inneholde name=userns (uid i containeren må være lik uid på verten for /work) og ikke name=rootless
sudo iptables -V                    # nf_tables- eller legacy-variant er begge greit
systemctl --version | head -1
getent group docker                 # må finnes
getent passwd 10001 || echo "uid 10001 er ledig (bra)"
sudo ss -ltn | grep ':3128 ' || echo "port 3128 er ledig (bra)"
ip -4 route | grep '172.30.77' || echo "subnett 172.30.77.0/24 er ledig (bra)"
```

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
   Forhåndsvisning uten root: `infra/job-runner/install-host.sh --stage --prefix /tmp/jr-stage`. Skriptet overskriver **aldri** `/etc/jarvis/job-runner.json`,
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
   docker compose --env-file .env -f infra/local/docker-compose.yml -f infra/job-runner/docker-compose.job-runner.yml up -d worker
   ```
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
  ```
  Worker leser filen ved hver forespørsel. Får worker likevel `unauthorized`, start worker på nytt:
  ```
  docker compose --env-file .env -f infra/local/docker-compose.yml -f infra/job-runner/docker-compose.job-runner.yml up -d --force-recreate worker
  ```

## 6. Akseptanse på verten

```
cd /volume1/jarvisbuild-data/jarvisbuild
export ACCEPTANCE_REPO=tsworkflow/jarvis-d103-acceptance
sudo -E ops/job-runner/acceptance.sh                              # J01-J09, J11, J12 (J09/J10/J13 gir SKIP uten flaggene under)
sudo -E ops/job-runner/acceptance.sh --with-restart --with-ttl    # J09: SIGKILL på runneren + restart. J10: venter på TTL (sett runner.max_job_lifetime_s=60 midlertidig)
read -rsp "ANTHROPIC_API_KEY (vises ikke): " ANTHROPIC_API_KEY; echo; export ANTHROPIC_API_KEY ACCEPT_LIVE_CLAUDE=1
sudo -E ops/job-runner/acceptance.sh                              # J13: liten ekte Claude Code-kjøring via proxyen (koster noen øre); unset ANTHROPIC_API_KEY etterpå
ops/job-runner/acceptance.sh --dry-run                            # kun sjekklisten, rører ingenting
sudo chown -R "$(id -u):$(id -g)" ops/acceptance/out              # evidensfilene ble skrevet av root
```

* `ACCEPTANCE_REPO` er **påkrevd** og må stå i `runner.allowed_repos`. Scriptet nekter alt annet (aldri et stille standardrepo, aldri produksjonsrepoet): J11 pusher en ekte
  branch `jarvis/accept-<tid>` til sandbox-repoet. Slett den etterpå.
* Kjøres som root (`sudo -E`): scriptet trenger å lese tokenfilen og `base_dir`, skrive til socketen, bruke docker og (for J09) styre systemd. Uten root gir enkelte sjekker `FAIL`/`SKIP` med forklaring. API-nøkkelen og `ACCEPTANCE_REPO` leses fra miljøet og skrives aldri ut; legg aldri nøkkelen på kommandolinjen.
* Evidens skrives til `ops/acceptance/out/job-runner-acceptance-<tid>.md` (git-ignorert, ingen hemmeligheter - bearer-tokenet sendes via en `0600`-headerfil, aldri i argv).
  Exit 1 hvis minst én sjekk er `FAIL`. **`SKIP` og `MANUELL` er ikke bestått.** Lim utskriften inn i chatten, så vurderer jeg den.
* `PASS` betyr kun at *denne* målingen var som forventet *nå* på *denne* verten.

Sjekkene (samme ID-er som i `acceptance.sh`; `--dry-run` skriver dem):

| Sjekk | Viser | Krever |
|---|---|---|
| `J01_filrettigheter` | config root-eid; token/PAT uten tilgang for andre; socket `0660`; kataloger private | root |
| `J02_helse` | API svarer med riktig token; feil token gir 401 | - |
| `J03_container_per_jobb` | to jobber = to separate, kjørende containere merket `jarvis.role=job`; borte etter DELETE | docker |
| `J04_docker_inspect` | `privileged=false`, read-only rootfs, `cap-drop ALL`, `no-new-privileges`, ikke-root, minne/CPU/PID, kun jobbnettverket, kun `/work` montert, ingen `docker.sock`, ingen forbudte env | docker |
| `J05_inne_i_containeren` | uid, `CapEff=0`, ingen `docker.sock`, read-only rootfs, `noexec` tmpfs, ingen vertsmapper/hemmelighets-env, ingen git-remote/credential | docker |
| `J06_ressursgrenser` | minnegrense (OOM), PID-grense, tidsavbrudd dreper containeren | docker |
| `J07_nettverk_deny_by_default` | ingen direkte rute ut; vertsporter utilgjengelige unntatt proxyen; github OK, fremmed/privat/metadata nektet; kun CONNECT; jobb-containere når ikke hverandre; IPv6-observasjon | docker, brannmur |
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
| 2 | Uten privileged | `ops/job-runner/test/container-spec.test.mjs`, `ops/job-runner/test/docker-cli-argv.test.mjs` | `J04_docker_inspect` | BYGGET |
| 3 | Ingen Docker-socket montert | `ops/job-runner/test/container-spec.test.mjs`, `ops/job-runner/test/infra.test.mjs` | `J04_docker_inspect`, `J05_inne_i_containeren` | BYGGET |
| 4 | Ingen host-home/SSH/generelle secrets montert | `ops/job-runner/test/container-spec.test.mjs`, `ops/job-runner/test/api.test.mjs`, `ops/job-runner/test/credentials.test.mjs` | `J01_filrettigheter`, `J04_docker_inspect`, `J05_inne_i_containeren` | BYGGET |
| 5 | Kun jobb-workspace tilgjengelig | `ops/job-runner/test/container-spec.test.mjs`, `ops/job-runner/test/lifecycle.test.mjs` | `J04_docker_inspect`, `J05_inne_i_containeren` | BYGGET |
| 6 | Ikke-root der praktisk | `ops/job-runner/test/container-spec.test.mjs`, `ops/job-runner/test/infra.test.mjs`, `ops/job-runner/test/lifecycle.test.mjs` | `J04_docker_inspect`, `J05_inne_i_containeren` | BYGGET |
| 7 | Unødvendige capabilities fjernet | `ops/job-runner/test/container-spec.test.mjs`, `ops/job-runner/test/docker-cli-argv.test.mjs` | `J04_docker_inspect`, `J05_inne_i_containeren` | BYGGET |
| 8 | CPU/minne/PID/timeout-grenser testet | `ops/job-runner/test/container-spec.test.mjs`, `ops/job-runner/test/lifecycle.test.mjs`, `ops/job-runner/test/api.test.mjs` | `J04_docker_inspect`, `J06_ressursgrenser`, `J10_ttl` | BYGGET |
| 9 | Nettverk deny-by-default eller jobb-allowlist | `ops/job-runner/test/egress-proxy.test.mjs`, `ops/job-runner/test/infra.test.mjs`, `ops/job-runner/test/lifecycle.test.mjs`, `ops/job-runner/test/config.test.mjs` | `J04_docker_inspect`, `J07_nettverk_deny_by_default` | BYGGET |
| 10 | Kun jobbspesifikke tokens injisert | `ops/job-runner/test/credentials.test.mjs`, `ops/job-runner/test/credential-source.test.mjs`, `ops/job-runner/test/api.test.mjs` | `J01_filrettigheter`, `J04_docker_inspect`, `J05_inne_i_containeren`, `J12_logger_uten_hemmeligheter` | BYGGET |
| 11 | Cancellation stopper faktisk container/prosess | `ops/job-runner/test/lifecycle.test.mjs` | `J08_kansellering` | BYGGET |
| 12 | Crash/reclaim testet i ekte runtime | `ops/job-runner/test/lifecycle.test.mjs` | `J09_reclaim_etter_krasj` | DELVIS |
| 13 | To workers kan ikke ferdigstille samme lease | `modules/tasks/test/d393-worker-lease.test.ts`, `modules/tasks/test/fase6-worker.test.ts` | — | UTENFOR_WP |
| 14 | Minst én ekte kodejobb job→sandbox→agent→branch→tests→commit→push→PR | `ops/job-runner/test/publish.test.mjs`, `modules/tasks/test/wpc1-coding-host-runner.test.ts`, `modules/tasks/test/wpc1-host-job-runner-client.test.ts` | `J11_ende_til_ende_publish`, `J13_live_claude` | DELVIS |
| 15 | Kun jobb-branch kan pushes | `ops/job-runner/test/publish.test.mjs`, `ops/job-runner/test/api.test.mjs` | `J11_ende_til_ende_publish` | BYGGET |
| 16 | `main` beskyttet mot autonom push/merge | `ops/job-runner/test/publish.test.mjs` | `J11_ende_til_ende_publish`, `M01_github_beskyttelse` | EIER |
| 17 | PR krever menneskelig merge | `modules/tasks/test/pr-publisher.test.ts`, `modules/tasks/test/fase6-worker.test.ts` | `M01_github_beskyttelse` | EIER |
| 18 | Force-push/sletting av beskyttet branch utilgjengelig for worker-mandat | `ops/job-runner/test/publish.test.mjs` | `M01_github_beskyttelse` | EIER |
| 19 | Klasse D/policy/kill-switch regresjonstestet i ekte miljø | — | — | UTENFOR_WP |
| 20 | Gitleaks på produsert branch/artifacts | `ops/job-runner/test/credentials.test.mjs` | `J12_logger_uten_hemmeligheter` | DELVIS |
| 21 | Dokumentert i PROJECT_STATUS | — | — | UTENFOR_WP |

Merknader til tabellen:

* **12** er bevist med fake docker (oppstartsavstemming fjerner containere merket `jarvis.role=job` og UUID-kataloger). Ekte krasj mot ekte Docker er J09 (`--with-restart`).
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
| `allowed_repos` | **påkrevd** | liste `owner/repo` (små bokstaver); alt annet gir 403 |
| `git_credentials` | **påkrevd** | `{ "owner/repo": { "token_file": "/etc/jarvis/git-token-…" } }` - ett PAT per allowlistet repo |
| `branch_prefix` | `jarvis/` | publiserte branches må starte med dette (ender alltid på `/`, så `main` er umulig) |
| `clone_depth`, `clone_timeout_ms` | `50`, `300000` | grunn henting av base-branchen |
| `publish` | se under | grenser for publisering |
| `git_identity` | `jarvis-worker`, `worker@jarvis.local` | forfatter/committer i containeren |
| `sweep_interval_s` | `15` | hvor ofte TTL-rydderen kjører |

**`runner.publish`:** `max_bundle_bytes` (67108864), `max_commits` (20), `max_files` (500), `deny_paths` (`.github/`, `.gitmodules`, `.gitattributes`), `timeout_ms` (180000).

**`egress_proxy`** (proxy-tjenesten)

| Nøkkel | Standard | Betydning |
|---|---|---|
| `listen_host` | **påkrevd** | jobbnettverkets gateway-IP (aldri `0.0.0.0`) |
| `listen_port` | `3128` | 1024-65535 |
| `allow` | `github.com:443`, `api.github.com:443`, `api.anthropic.com:443` | eksakte `vert:port` (kun DNS-navn, aldri IP-literal) |
| `allowed_client_cidrs` | **påkrevd** | jobbnettverkets subnett (første oppføring leses også av `setup-network.sh`) |
| `max_connections`, `max_connections_per_client` | `64`, `16` | samtidige tunneler |
| `idle_timeout_ms`, `connect_timeout_ms`, `max_tunnel_ms` | `120000`, `10000`, `3600000` | tidsavbrudd |

**Miljøvariabler (worker-siden)** - kun stier og modus, aldri hemmeligheter: `JARVIS_JOB_RUNNER` (`host`), `JARVIS_JOB_RUNNER_SOCKET`, `JARVIS_JOB_RUNNER_TOKEN_FILE`;
`JARVIS_JOB_RUNNER_GID` (numerisk gid, kun for overriden). Alt annet (image, nettverk, grenser, repoer) bestemmes av filen over og kan ikke settes fra worker.

## 9. API (Unix-socket, `Authorization: Bearer <token>`)

| Kall | Body | Svar |
|---|---|---|
| `GET /v1/health` | - | `200 {status:"ok", api_version, active_jobs, max_jobs}` |
| `POST /v1/jobs` | `{repo, base_branch?, env?, task_id?, tenant_id?}` | `201 {job_id, workdir:"/work", head_sha, base_branch, expires_at}` |
| `POST /v1/jobs/:id/exec` | `{argv:[…], timeout_ms?, env?}` | `200 {code, stdout, stderr, truncated, timed_out}` (tidsavbrudd: `code` 124, containeren er drept og jobben `terminated`) |
| `POST /v1/jobs/:id/publish` | `{branch}` | `200 {branch, commit_sha, base_sha, commits, files_changed}` |
| `DELETE /v1/jobs/:id` | - | `200 {deleted:true,state:"gone"}` (idempotent) eller `202 {deleted:false,state:"cleanup_pending"}` |

`env`-navn kan ikke være credentials/git-konfig/proxy/`PATH`/`HOME`/`LD_*`/`DOCKER_*`/vault-navn; verdier legges i containeren som miljø (aldri i argv). Feil har alltid formen
`{error:"<stabil kode>", detail?:"<renset>"}`: `unauthorized` 401, `unknown_field`/`invalid_request`/`env_name_forbidden`/`branch_invalid` 400, `repo_not_allowed` 403, `job_not_found` 404,
`job_busy`/`job_terminated`/`job_not_ready` 409, `too_many_jobs` 429, `no_changes`/`path_denied`/`bundle_*` 422, `git_credential_unavailable` 403/502/504, `git_network_failed`/`push_failed`/`push_rejected`/
`container_*_failed` 502, `docker_unavailable`/`job_network_not_internal`/`job_network_missing` 503, `bundle_timeout` 504.

## 10. Nettverk og brannmur (D-32 port 9) - detaljer

* `setup-network.sh` oppretter `jarvis-jobs` med `--internal`, `--subnet`, `--gateway`, bridge `br-jarvis-jobs` og `enable_icc=false` (jobb-containere når ikke hverandre). Det **sletter eller omskaper aldri**
  et eksisterende nettverk: avviker det (ikke internt, feil subnett, `icc` på), feiler skriptet og forklarer.
* **Hvorfor INPUT-regler?** Dockers dokumentasjon («Gateway modes») sier at containere på et internt nettverk kan nå tjenester på verten som lytter på bridge-adressen (også tjenester som lytter på «any»). Uten reglene
  kunne en jobb nå SSH, NAS-grensesnitt og SMB. Kjeden `JARVIS-JOBS-IN` slipper inn kun `tcp <gateway>:<proxy-port>` og avviser resten, og hoppet `-i br-jarvis-jobs -j JARVIS-JOBS-IN` ligger øverst i `INPUT`
  (settes inn først, deretter fjernes eventuelle duplikater - aldri et vindu uten dekning). Reglene røres bare i denne kjeden (`iptables-restore --noflush`).
* **Etter en brannmur-reload eller NAS-oppdatering** som tømmer `INPUT` (ufw/firewalld/UGOS): kjør `sudo infra/job-runner/setup-network.sh` (eller restart `jarvis-egress-proxy`, som gjør det som `ExecStartPre`) og deretter
  `acceptance.sh` J07. `sudo infra/job-runner/setup-network.sh --check` viser om reglene finnes.
* **nftables-vert uten `iptables`:** skriptet krever `iptables` (nft-varianten fungerer). Tilsvarende regler i `nft` (**ikke testet**):
  ```
  table inet jarvis_jobs { chain input { type filter hook input priority -10; policy accept;
      iifname "br-jarvis-jobs" ip daddr 172.30.77.1 tcp dport 3128 accept
      iifname "br-jarvis-jobs" meta l4proto tcp reject with tcp reset
      iifname "br-jarvis-jobs" reject with icmp type port-unreachable } }
  ```
* **IPv6:** nettverket opprettes uten `--ipv6`, og reglene dekker IPv4. At containeren ikke har en ikke-loopback IPv6-adresse er **ikke verifisert**; J07 skriver tallet (forventet 0) som observasjon. Er det ikke 0, må tilsvarende `ip6tables`-regler legges til.
* **Alternativ uten vertsprosess som lytter på bridgen:** kjør proxyen som en container på både jobbnettverket og et vanlig nett, og bruk Dockers `isolated` gateway-modus for jobbnettverket. Det er bare **beskrevet**, ikke bygget eller testet.
* Proxyen svarer kun på `CONNECT vert:port` (200 for allowlist, 403/400 ellers, 405 for vanlig HTTP). Den logger aldri innhold, kun `vert:port` og årsak.

## 11. Hva runneren verifiserer før den pusher (publish)

Hvert trinn feiler lukket, og ingen git kjøres mot agentens katalog: (1) headeren i bundlen parses strengt (versjon 2, nøyaktig én ref `HEAD`, nøyaktig én forutsetning = basecommit, `PACK`-signatur);
(2) bundlen hentes inn i et ferskt bare-repo; (3) `git fsck --strict` (fetch fsck-er *ikke* bundler - målt); (4) SHA = headerens, etterkommer av basen, ingen merge-commits, ≤ `max_commits`;
(5) endrede stier: `.git`-komponenter (også NTFS-varianter/usynlige tegn), nekteliste (`.github/` osv.), submodul/gitlink avvist, ≤ `max_files`, ingen tomme endringer; (6) `git push <sha>:refs/heads/<prefiks><id>` uten force, uten sletting,
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
| `git_credential_unavailable` (403/502) | PAT-fil mangler, feil eier/modus, feil format, repo ikke i `git_credentials` | `ls -l /etc/jarvis/git-token-*` (skal være `-r-------- jarvis-runner`) |
| `git_network_failed` ved opprettelse | proxy/DNS/PAT feil, eller GitHub utilgjengelig fra verten | `sudo journalctl -u jarvis-job-runner -n 50`; test `git ls-remote` manuelt som `jarvis-runner` uten å skrive token noe sted |
| `path_denied`, `bundle_*`, `no_changes` ved publish | endring rammet en regel (kapittel 11) | les `detail`; fjern `.github/`-endringer, del opp i færre commits/filer |
| `push_rejected`/`push_failed` | GitHub avviste (branch protection, PAT-rettigheter, eksisterende branch med annen historikk) | sjekk PAT og branchnavn; runneren bruker aldri force |
| Runner/proxy stopper rett etter oppstart med `git_could_not_start`, `spawn EPERM` eller lignende | systemd-filteret `SystemCallFilter=@system-service` er for stramt for en eldre systemd (mangler `clone3` i `@system-service`) | kontroller `systemctl --version`; som siste utvei kommenter ut de to `SystemCallFilter`/`SystemCallErrorNumber`-linjene i enheten (svekker herdingen - dokumentér det) og `sudo systemctl daemon-reload` |
| Mange rester av `jarvis-job-…`-containere | runner krasjet midt i opprydding | restart runneren: oppstartsavstemmingen fjerner alt merket `jarvis.role=job` og alle UUID-kataloger |

* **Nødstopp:** `sudo systemctl stop jarvis-job-runner jarvis-egress-proxy` og `sudo docker ps -aq --filter label=jarvis.role=job | xargs -r sudo docker rm -f`. Worker feiler da lukket.
* **Logger:** `sudo journalctl -u jarvis-job-runner -u jarvis-egress-proxy`. Strukturert JSON; hendelser: `runner_started`, `job_created`, `job_published`, `job_removed`, `reconcile_done`, `request_rejected`,
  `job_create_failed`, `git_credential_source_failed`, `client_gone_during_operation`, `sweep_failed`, `egress_proxy_started`. Env-verdier, argv, tokens og credentials logges aldri (navn med `token/secret/env/argv/…` droppes, kjente hemmeligheter maskeres).
* **Avinstaller:** stopp og deaktiver enhetene, fjern `/etc/systemd/system/jarvis-*.service`, `/opt/jarvis-job-runner`, `/var/lib/jarvis-job-runner` (jobbkataloger og socket-katalogen), `docker network rm jarvis-jobs`, `sudo iptables -D INPUT -i br-jarvis-jobs -j JARVIS-JOBS-IN` (og `-F`/`-X JARVIS-JOBS-IN`),
  og slett PAT-filene. Fjern `-f infra/job-runner/docker-compose.job-runner.yml` fra worker-kallet.

## 13. `container`-modus (`JARVIS_JOB_RUNNER=container`) - ikke anbefalt

Den eldre veien kjører `docker` i **samme prosess** som worker og krever dermed en docker-klient og -socket i worker-containeren, som bevisst ikke finnes (Del 2). I tillegg skrives git-credential-helperen til workerens `tmpdir()`,
mens git kjøres via `docker exec` i en annen container (Q-46 punkt 5: «latent brukket»). Modusen er beholdt uendret for en worker som kjører direkte på en vert, men den er ikke verifisert og ikke anbefalt. Bruk `host`.

## 14. Åpne punkter (ingenting av dette er bygget)

* **GitHub App-identitet (Q-45b / WP-C3):** i dag en fine-grained PAT per repo. `GitCredentialSource { tokenFor(repoSlug) -> Promise<string> }` er et injiserbart grensesnitt (strukturelt likt WP-C3 sin kontrakt), og tokens opp til 8192 tegn
  godtas (`ghs_<APPID>_<JWT>`). To veier til en kortlevd App-token er mulige og **ikke valgt**: (a) en vertsside kilde som leser App-privatnøkkelen fra en `0400`-fil hos `jarvis-runner`, eller (b) at worker/api henter tokenet og sender det i jobbforespørselen.
  (b) gjør at worker igjen håndterer en git-credential (om enn kortlevd) og krever en API-utvidelse - en eier-/arkitektbeslutning.
* **Diskkvote per jobb finnes ikke.** Agenten kan fylle `/work` (bind-mount) til volumet er fullt, og samme volum kan være delt med Postgres/backup på NAS-en. Minimum: sett `runner.base_dir` (og dermed `StateDirectory`)
  på et eget filsystem/dataset med fast størrelse eller prosjektkvote (ext4/xfs `prjquota`), og kjør `df` mot det i overvåkingen. Å la runneren måle og drepe jobber over en grense er **ikke bygget** (et raskt skrivende program fyller disken mellom to målinger).
* Ingen støtte for Windows/PC-utvikling (kun Linux med systemd/Docker); utviklingsmaskinen bruker fortsatt prosess-sandboxen.
* Per-repo egress-allowlist og per-repo ressursgrenser finnes ikke (én policy for alle repoer).
* Ekte Docker-isolasjon, brannmur, systemd og GitHub er ikke verifisert (se toppen). Verifiser med `acceptance.sh`.
