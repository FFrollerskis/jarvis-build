# Felles verifiseringsøkt HF1/HF2 (WP-J3, D-450)

Denne runbooken er manuset for økten der Tobias og Claude **sammen** går fra «bygget og testet mot fakes» til «observert på NAS-en». Den bygger ingenting nytt: hver blokk peker til runbooken som allerede har trinnene, sier hva som regnes som bestått, og hvilken evidensfil som skal lages.
Lukkingsmatrisen ([../CLOSURE_MATRIX_HF1_HF2.md](../CLOSURE_MATRIX_HF1_HF2.md)) er fasit for hva som finnes; **ingenting blir `VERIFIED` uten at en evidensfil i `docs/evidence/` er lenket** (vakt: `modules/core/test/wpj-closure-matrix.test.ts`). Hva bare du kan gjøre (nøkler, valg, fysiske ting): [../OWNER_ACTIONS_HF1_HF2.md](../OWNER_ACTIONS_HF1_HF2.md).

## 0. Spilleregler (les før du starter)

1. **Ingen hemmeligheter i chat.** Aldri lim inn tokens, nøkler, `.env`-innhold eller PEM-filer. Alle skript under rapporterer «satt/ikke satt» og kvitterer ikke verdier. Ser du en hemmelighet i utdata: stopp, ikke send den, si fra – den er brent og roteres.
2. **Én blokk om gangen, og ett flagg om gangen.** Å slå på en dormant funksjon = én linje i `.env` + `docker compose ... up -d api worker` (se NAS_UPDATE_HF1_HF2 «Hvis noe går galt»). Går blokken dårlig: fjern linjen igjen før du går videre.
3. **Sandbox først (D-41, blast radius).** Akseptanse kjøres kun mot sandbox-/test-ressurser: eget test-repo (aldri produksjonsrepoet `FFrollerskis/jarvis-build` og heller ikke det gamle `tsworkflow/jarvisbuild`), en uviktig Cloudflare-sone, Stripe testmodus, en testmappe i Drive. Dette sier ingenting om produksjonens tilgangsnivå – det er bare omfanget av selve testen.
4. **`PASS` betyr bare «denne målingen var som forventet akkurat nå på denne koden».** Det er ikke det samme som at en rad er lukket. Rader flyttes av Claude i en PR etter økten, og bare med evidensfil.
5. **Det vi ikke har kjørt sier vi at vi ikke har kjørt.** `NOT VERIFIED`, `UNKNOWN`, `SKIP` og `MANUELL` er aldri «bestått». Feilet noe: det blir en issue og raden beholder status.
6. **`HARD_EXTERNAL_BLOCKER`** (manglende credential som ikke finnes trygt, betaling/kjøp, fysisk handling bare du kan gjøre, ekstern juridisk aksept): blokken hoppes over og raden står som `BLOCKED_EXTERNAL`. Resten av økten fortsetter.
7. **Kostnad varsles før den oppstår.** De få stegene som koster penger (ekte Claude-kjøring i job-runneren J13, mesh-røyktest mot skymodeller) står merket «kostnad» under; kostnadstakene er uendret.
8. **NAS-en må stå på den merget commit-en** (`main`), ikke på en feature-branch: git-SHA står i hver evidensfil, og en evidens fra feil kode beviser ingenting om koden vi lukker.
9. **`node` (Node 22) på NAS-en** trengs for evidens-opptakeren og for full H12-skanning (`node --version`). Mangler den: kjør `ops/acceptance/nas-hf1-hf2-gate.sh` direkte (H12 blir da `WARN`, aldri `PASS`) og lim kun den hemmelighetsfrie utdataen i chat – evidensfilen lages i så fall fra `--stdin`, merket «håndlimt av eier».

## 1. Slik tas evidens

Evidens-opptakeren (WP-J2, PR #320) kjører **én kommando uten skall** (ingen pipe/redirect i argumentene), redigerer kjente hemmelighetsformer i både utdata og kommandolinje, og skriver `docs/evidence/<dato>-<id>.md` med kommando, exit-kode, git-SHA/branch, tid og utdata. Filen overskrives aldri.

```
node ops/acceptance/record-evidence.mjs <id> --note "kort merknad" -- <kommando> [argumenter ...]
<kommando som skriver til stdout> | node ops/acceptance/record-evidence.mjs <id> --stdin
```

- `<id>` er et vanlig navn (2–61 tegn: bokstaver, tall, `.`, `_`, `-`). Vi bruker `hf-<blokk>-<hva>` som under. `--timeout-s N` (standard 600) for lange kjøringer.
- Opptakeren **vurderer ikke** utfallet; vurderingen («Resultat», «Gjelder matriserad(er)») fylles ut av oss etterpå.
- **Les filen før den forlater NAS-en.** Redigeringen er mønsterbasert: en hemmelighet uten kjent form fanges ikke (gitleaks i CI er andre lag).
- **Vei til repoet:** (a) lim filen inn i chatten, så committer Claude den på en `claude/evidens-<dato>`-branch (anbefalt – NAS-en trenger ikke skrivetilgang); eller (b) `git switch -c evidens/<dato> && git add docs/evidence && git commit && git push` fra en maskin med skrivetilgang. Evidensfiler committes aldri på `main` direkte.
- Interaktive steg (f.eks. `read -rsp` for en nøkkel) kan ikke ligge inni opptakeren (stdin er lukket): sett miljøvariabelen i terminalen først (`export …`), kjør så opptakeren – barneprosessen arver den. Skriv aldri nøkkelen på kommandolinjen.

## 2. Anbefalt rekkefølge og anslag (anslag, ikke målt)

| Økt | Blokker | Anslått tid | Risiko | Kostnad |
|---|---|---|---|---|
| **A – les-økten** | 0 baseline · 1 chat-observasjon · 2 backup · 4 Value Center · 10 kontrollsentre · 11 Evolution-rapport | 60–90 min | lav (kun lesing og dormant-flagg som kan rulles tilbake) | ingen |
| **B – sandbox-skriving** | 3 job-runner · 5 GitHub App · 6 AI Mesh · 7 hendelser og Cloudflare · 8 finans (testmodus) | 2–3 t | middels (skriver mot test-ressurser; kan stoppes med `/infra/pause` og kill switch) | noen øre (J13, mesh-røyktest) |
| **C – kunnskap og business, kun testdata** | 9 kunnskapskilder · 12 Business OS | 60–90 min | middels (blokk 9: kun syntetiske testdokumenter i et eget rom; blokk 12: kun testdata i en egen test-tenant – aldri ekte dokumenter eller kundedata) | ingen |

Du kan ta dem i andre rekkefølger, men Blokk 0 er alltid først og kjøres på nytt hvis noe er endret mellom øktene.

## 3. Blokkene

Hver blokk: **Mål** · **Krever** (fra OWNER_ACTIONS) · **Slik** · **Bestått når** · **Evidens** · **Hvis det feiler** · **Rader**.

### Blokk 0 – Baseline (alltid først)

- **Mål:** vite at NAS-en kjører den merget koden, at migrasjonene er anvendt og at ingenting hemmelig står i loggene, FØR vi slår på noe.
- **Krever:** NAS-oppdateringen i [NAS_UPDATE_HF1_HF2.md](NAS_UPDATE_HF1_HF2.md) er gjort.
- **Slik:** `JARVIS_BACKUP_DIR=/volume1/jarvisbuild-data/backups/encrypted node ops/acceptance/record-evidence.mjs hf-0-gate -- ops/acceptance/nas-hf1-hf2-gate.sh` (porten kjører UA-0-porten først, `H01`).
- **Bestått når:** exit 0 (ingen `FAIL`, minst én `PASS`, ikke flere `UNKNOWN` enn `PASS`), `H02` (migrasjoner) og `H12` (ingen hemmelighetsformer i loggene – full skanning med opptakerens mønsterliste, krever `node` på verten; uten den er H12 bare `WARN`) er `PASS`. `WARN`/`UNKNOWN` er IKKE bestått og leses linje for linje og forklares – kjent og akseptert (f.eks. `constitution_unsigned` før EV-0 er signert) vs. nytt. UA-0-linjene som ikke er `PASS` vises med prefikset `UA-0>` og ligger også i evidensfilen; et grønt UA-0-sammendrag med `WARN`/`UNKNOWN` gir `H01` = `WARN`. `H07` er `PASS` bare når backup, restore-verifisering og off-site alle er `ok` og statusfilen er under 36 timer gammel (`failed`/`failing` = `FAIL`; `never`/`never_run`/`not_configured`/`pending` = `WARN`).
- **Evidens:** `hf-0-gate`.
- **Hvis det feiler:** stopp økten. `H12` med treff = rotér det som lekket før noe annet. `H02` rød = migrasjon mangler (les `migrate`-loggen). Exit 2 = docker/compose svarer ikke (kjør som en bruker med docker-tilgang, for eksempel med `sudo`); exit 3 = de fleste sjekkene kunne ikke bekreftes (ingen `PASS`, eller flere `UNKNOWN` enn `PASS`) – ikke en kjøring å bygge på.
- **Rader:** UA0-RUNRATE (delvis), generell «NAS kjører HF1/HF2-koden».

### Blokk 1 – Chat-observasjon av det som er `WIRED`

- **Mål:** se at observatoriet svarer i vanlig chat, og at tallene stemmer med virkeligheten.
- **Slik (i chat på NAS-dashbordet, signert enhet):** «hva er galt med deg» (EV-1 selvdiagnose) · «hvor bra yter du» (EV-2 SLO; chat-, bakgrunns- og verktøymålene trenger minst 10 målinger siste 24 t, så «ikke nok data» er riktig uten normal bruk) · «hva har du hjulpet meg med» (Value Center, se blokk 4) · «hvordan står AI-mesh-en?» (D4; en leverandør regnes som «bevist live» når den er `LIVE` nå eller har minst ett vellykket kall siste 7 døgn, så har chatten brukt tre leverandører siste uke står det «oppfylt» som observasjon, og røyktesten i blokk 6 er det som gir evidens) · «driftsstatus» (E1, forventet tom/rolig før hendelser; «status på driften» virker også, men skriv aldri «bedriften»: ordet arves til verktøyutvalget i tre meldinger, og den lille lokale modellen kan da velge forretningsverktøy i stedet for `executive.get_infra_status`, slik det skjedde 2026-10-10; verktøyet krever eier og enhetssignert økt, og et avslag står som `tool.denied` i revisjonsloggen). De tre første går på hurtigbanen (uten AI-modell, så svaret kommer på brøkdeler av et sekund og er likevel målt, ikke ferdigtekst); AI-mesh- og driftsspørsmålene besvares av en modell som velger et verktøy, og tar noen sekunder. Kopier svarene inn i chat til meg. Ikke be om en bakgrunnsjobb rett etter svar med kostnader i: økonomi i de siste meldingene tvinger lokal modell.
- **Bestått når:** hvert svar kommer uten feil, viser ukjent som ukjent (aldri påstått friskt uten måling), og nevner `constitution_unsigned`/åpne WARN akkurat slik porten gjorde.
- **Evidens:** svarene limes inn i chat; jeg lager `hf-1-chat-observasjon` fra utdraget (`--stdin`), merket «håndlimt av eier» – det er svakere enn en kjørt kommando og skrives slik.
- **Rader:** EV-1, EV-2 (SLO-mål godkjennes separat av deg), EV-12 (kun skygge), EV-16, EV-17, EV-19. EV-12, EV-16, EV-17 og EV-19 leses i evolusjonsrapporten («hvordan utvikler du deg»), som ikke er en av de fem spørsmålene over; spør om den i tillegg (gjort 2026-10-10, se «Utført» under).
- **Utført 2026-10-10 (delvis, WARN):** fire av fem spørsmål observert ([docs/evidence/2026-10-10-hf-1-chat-observasjon.md](../evidence/2026-10-10-hf-1-chat-observasjon.md)), og evolusjonsrapporten («hvordan utvikler du deg») observert uten feil ([docs/evidence/2026-10-10-hf-1-chat-observasjon-2.md](../evidence/2026-10-10-hf-1-chat-observasjon-2.md)). **Gjenstår:** E1 (spørsmålet «driften» traff forretningsverktøyene og er IKKE observert; spør «driftsstatus») og kryssjekk av verdirapportens tall (Telegram, Anthropic).

### Blokk 2 – Backup, restore og off-site (WP-C2)

- **Mål:** bevise at krypterte sett finnes, kan leses, og at en restore faktisk fungerer – på NAS og (separat) på maskinen med privatnøkkelen.
- **Krever:** off-site-mål og heartbeat-URL er DINE valg (`BLOCKED_EXTERNAL` til du har valgt); cron installert; statusmappen montert. Se [../remediation/BACKUP_RESTORE_RUNBOOK.md](../remediation/BACKUP_RESTORE_RUNBOOK.md).
- **Slik:** `node ops/acceptance/record-evidence.mjs hf-2-backup-nas -- ops/backup/acceptance-ops.sh nas /volume1/jarvisbuild-data/backups/encrypted` (exit 0 = alt bestått, 3 = ikke lukket). På maskinen med privatnøkkelen: `ops/backup/acceptance-ops.sh drill ~/jarvis-drill --identity <nøkkelfil> --from-offsite` (fyll inn RTO/RPO). Så gate-linjene `H07` (backup-status) på nytt.
- **Bestått når:** `acceptance-ops.sh nas` gir 0; `drill` gir 0 og RTO/RPO er skrevet; selvdiagnose-området «Backup» er ikke `UNKNOWN`.
- **Evidens:** `hf-2-backup-nas`, `hf-2-restore-drill` (kjøres der nøkkelen er; filen kommer via chat).
- **Hvis det feiler:** raden står som den er; full produksjons-restore er ikke skriptet (kjent, `DEFERRED`).
- **Rader:** UA-0 OPS-RUNTIME (Fase 10), EV-20 (off-site restore bevist → `OFFSITE_RESTORE`).
- **Utført 2026-10-12 (delvis):** cron installert (`sudo crontab -u`), `acceptance-ops.sh nas` kjørt: PASS=5 / FAIL=0 / ikke satt opp=3 (exit 3), off-site rclone → Google Drive sha256-bekreftet, statuseksport montert, gammel nattjobb fjernet. Evidens (håndlimt av eier): [hf-1-ops-runtime-nas](../evidence/2026-10-12-hf-1-ops-runtime-nas.md). **Gjenstår:** heartbeat (O04/O07), RPO/RTO-mål (Q-62), `drill --from-offsite` med privatnøkkel, Google-opprydding og nøkkel-escrow (Q-61), og chat-test av «Backup»-området.

### Blokk 3 – Vertsside job-runner (WP-C1, D-32) – sandbox

- **Mål:** D-32-portene 1–21 på NAS-en, og én ekte kodejobb som ender som en PR du selv må merge.
- **Krever:** installasjon på verten ([JOB_RUNNER.md](JOB_RUNNER.md) §3–§4), sandbox-repo i `runner.allowed_repos`, `ACCEPTANCE_REPO=<owner/test>`; branch protection og PAT-rettigheter (M01) er manuelle punkter.
- **Slik:** [JOB_RUNNER.md](JOB_RUNNER.md) §6: `sudo -E ops/job-runner/acceptance.sh`, så `--with-restart --with-ttl`, så (kostnad: noen øre) `ACCEPT_LIVE_CLAUDE=1` med nøkkelen satt i miljøet. Evidens: `sudo chown -R "$(id -u):$(id -g)" ops/acceptance/out` og la opptakeren kjøre scriptet. Så én ekte jobb mot sandbox-repoet gjennom Jarvis i chat («… i bakgrunnen»).
- **Bestått når:** J01–J12 `PASS` (J13 `PASS` hvis kjørt), `SKIP`/`MANUELL` er listet og forklart, journalen har `job_created` + `job_published`, `docker ps -a --filter label=jarvis.role=job` er tom etterpå, og PR-en fra sandbox-repoet dukker opp.
- **Evidens:** `hf-3-jobrunner-accept`, `hf-3-jobrunner-e2e` (PR-lenke + journalutdrag).
- **Hvis det feiler:** `JARVIS_JOB_RUNNER` av igjen; produksjonsrepoet røres aldri (scriptet nekter det hardt).
- **Rader:** D-32, Fase 6 (Workers), V3-forutsetning (D-32-leddet).

### Blokk 4 – Value Center og V2-oppfølging (WP-C4)

- **Mål:** tallene i «Verdi og bruk» stemmer med virkeligheten, og V2-pushen sender høyst én melding.
- **Slik:** [WPC4_VALUE_CENTER.md](WPC4_VALUE_CENTER.md) «Verifisering»: åpne «Verdi og bruk» (eller si «hva har du hjulpet meg med»), sammenlign «Daily Brief levert» med antall briefer på Telegram siste 7 døgn; `docker compose ... logs api | grep v2_push` viser `v2_push_disabled` uten flagget. Så (frivillig) `JARVIS_V2_PUSH_ENABLED=true`: frys connector `telegram` en stund → forventet ÉN `send_blocked`, ingen `followup.push_*`-rader; opphev frysen → én melding.
- **Bestått når:** tall stemmer (du bekrefter hvilke du sjekket), og push-forsøket gir nøyaktig det som står over.
- **Evidens:** `hf-4-value-report`, `hf-4-v2-push` (loggutdrag + `SELECT … FROM audit_events WHERE type LIKE 'followup.push_%'`).
- **Rader:** UA0-RUNRATE, V1, V2.

### Blokk 5 – GitHub App (WP-C3) – sandbox

- **Mål:** kortlevde, repo-scopede tokens i stedet for PAT, bevist mot GitHub.
- **Krever:** App opprettet etter [GITHUB_APP.md](GITHUB_APP.md) steg 1–6; et eget, tomt test-repo App-en er installert på.
- **Slik:** steg 7 i runbooken: `node --env-file=.env --experimental-transform-types modules/tool-gateway/scripts/github-app-live.ts --key-file ./nokkel.pem --sandbox-repo <owner/test>` via opptakeren. Deretter dashbord → Integrasjoner → GitHub → «Test tilkobling», og `executive.get_connector_status` (forventet `auth: app`, «kortlevd repo-scopet identitet: ja»).
- **Bestått når:** sluttlinjen er `GITHUB_APP_LIVE_STATUS=VERIFIED` (ikke «kun autentisering»), grenen ble slettet av scriptet, og ingen token står i utdata.
- **Evidens:** `hf-5-github-app-live`.
- **Hvis det feiler:** PAT står uendret (`JARVIS_GITHUB_APP_ID` fjernes = rollback).
- **Rader:** D-35 (GitHub App), UA-5 (del), EV-17-faktaene er fortsatt `BUILT_UNWIRED`.

### Blokk 6 – AI Mesh (WP-D4) – kostnad: noen øre

- **Mål:** «≥3 live providers med fallback og kost-synlighet».
- **Krever:** Kimi- og Hermes-nøkler (og gemma_local oppe) – eier-handling; ingen verktøy aktiveres før røyktesten har gått.
- **Slik:** [AI_MESH_ACCEPTANCE.md](AI_MESH_ACCEPTANCE.md) steg 1–4: først «hvordan står AI-mesh-en?» (steg 1, ingen penger), så `docker compose --env-file .env -f infra/local/docker-compose.yml exec -T api node --experimental-transform-types modules/model-gateway/scripts/mesh-live-smoke.ts --db --tools --parallel --out /tmp/mesh-smoke.json`, så statusverktøyet på nytt. `JARVIS_MESH_TOOLS_VERIFIED` settes først etter at `--tools` har gått.
- **Bestått når:** de fire punktene i runbookens §0 holder (≥3 bevist live, fallback observert, kost synlig, ingen hemmeligheter).
- **Evidens:** `hf-6-mesh-smoke` (røyktestens `--out`-fil + statussvaret).
- **Hvis det feiler:** `JARVIS_CHAT_CANDIDATES` fjernes → standardkjeden som før.
- **Rader:** UA-1 AI Mesh, EV-12 (grunnlag for bake-off).

### Blokk 7 – Hendelser og Cloudflare/Infra (WP-E1) – sandbox-sone

- **Mål:** hendelsesløkka og skymålene, bevist mot en SANDBOX-sone og testprosjekter – aldri produksjons-DNS.
- **Krever:** Cloudflare-token med minste rettigheter og `JARVIS_CLOUDFLARE_MUTATION_ZONES=<sandbox-sone-id>` (kun den); migrasjon 096–098 anvendt; eier-grant + signert enhet (alle skymål-mutasjoner krever det).
- **Slik:** [CLOUDFLARE_CONNECTOR.md](CLOUDFLARE_CONNECTOR.md) §6 (8 steg: token, lesing, create/update/delete DNS med readback, gjenoppretting, drift-vern, sonegrense, pause, revisjon mot Cloudflares audit-logg), [INFRA_CONTROLLED_TARGETS.md](INFRA_CONTROLLED_TARGETS.md) §5 (Langfuse/Infisical – kontrollér at ingen hemmelig verdi står i svaret), [INCIDENT_LIFECYCLE.md](INCIDENT_LIFECYCLE.md) §6 (opprett → kvitter → historikk; annen person → `403 owner_required`; `VERIFIED` uten deterministisk grunnlag avvises).
- **Bestått når:** hver mutasjon gir `verification_outcome: SUCCESS`, en `infra_executions`-rad med før/etter/diff og en Telegram-melding; `POST /infra/pause` gir `infra_paused`; en skriving mot sone utenfor listen gir `cloudflare_zone_not_authorized`.
- **Evidens:** `hf-7-cloudflare-sandbox`, `hf-7-infra-targets`, `hf-7-incident-lifecycle` (sammendrag fra `infra_executions`; ingen token).
- **Hvis det feiler:** `/infra/pause`, fjern token fra `.env`. Produsentene (`JARVIS_INCIDENT_PRODUCERS_ENABLED`) slås på sist og kan fjernes uavhengig.
- **Rader:** UA-5 (Cloudflare, Langfuse/Infisical/Postgres som mål, hendelser), EV-9 (stigen mot ekte funn).

### Blokk 8 – Finans D-kjede (WP-F1) – kun testmodus

- **Mål:** at de fire pengehandlingene bare går via klasse D + step-up, og at en testbetaling går gjennom hele kjeden og avstemmes.
- **Krever:** `JARVIS_STRIPE_TEST_SECRET_KEY` (testnøkkel, aldri live). Alle andre leverandører er `BLOCKED_EXTERNAL` til du leverer egne konti (Vipps, Neonomics, Wallester, Fiken).
- **Slik:** [FINANCE_D_CHAIN.md](FINANCE_D_CHAIN.md) §8: `node --env-file=.env --experimental-transform-types modules/finance/scripts/stripe-real-payment-acceptance-host-run.ts`, så eierveien (§2) mot en testintensjon og Telegram-varselet, så avstemmingen (§6). **Sett aldri `JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE=true`** i denne økten – det poster en permanent regnskapspost.
- **Bestått når:** testbetalingen går kun etter signert godkjenning, «ukjent utfall» gir aldri en ny betaling (§4), `finance-reconcile-sweep` rapporterer riktig, og en pengehandling fra chat/modell nektes.
- **Evidens:** `hf-8-stripe-test-chain`, `hf-8-reconcile`.
- **Rader:** UA-6 Finance (D-kjeden), UA0-AUTHORITY.

### Blokk 9 – Kunnskapskilder (WP-D1) – syntetiske testdokumenter i et eget rom

- **Mål:** fem kilder i samme retrieval, rom-isolasjon og skyskjerm (helse/`special` holdes tilbake), uten tverr-tenant-treff.
- **Krever:** `JARVIS_KNOWLEDGE_SOURCES` + `JARVIS_KNOWLEDGE_FS_ROOTS` (+ montering), Drive-OAuth hvis Drive brukes; bruk KUN en egen testmappe og et eget rom med **syntetiske dokumenter** (finn på innholdet; ingen ekte dokumenter, ingen helse-, økonomi- eller kundeinnhold).
- **Slik:** [KNOWLEDGE_SOURCES.md](KNOWLEDGE_SOURCES.md) §8 (6 steg): loggene `knowledge_source_synced`; spør «hva står det i dokumentene mine om …?»; spør fra et annet rom (forventet ingen treff); legg en oppdiktet helse-aktig tekst i testmappen og se «holdt tilbake»-merknaden for skymodell; ugyldig konfig → `knowledge_sources_config_rejected`; telling i databasen.
- **Bestått når:** første sync `created > 0`, deretter `unchanged`; ingen treff på tvers av rom eller tenant; helse-treff vises ikke for sky. Å tømme en kilde krever å fjerne den (runbook §7) – en tom/umontert rot tombstoner ingenting.
- **Evidens:** `hf-9-knowledge-sync`, `hf-9-knowledge-search` (håndlimt chat-utdrag + loggutdrag). Evidensfiler committes til git, og redigeringen fanger ikke personopplysninger: lim aldri utdrag fra ekte dokumenter, bare de syntetiske testdokumentene, tellinger, tilstander og loggnavn.
- **Rader:** UA-2 Knowledge, Q-26 (påstandsverifisering – skrive-handlingene har ingen eier-rute ennå).

### Blokk 10 – Kontrollsentre (WP-H0)

- **Mål:** ett panel for integrasjon/autoritet/AI/agenter/drift/verdi, og at pause/tilbakekall av en modellleverandør virker uten omstart.
- **Slik:** [WPH0_CONTROL_CENTER.md](WPH0_CONTROL_CENTER.md) «Verifiser på NAS» (6 steg): pause anthropic → svar fra lokal modell uten nye Anthropic-rader i `cost_events`; samme i worker; gjenoppta (signert enhet); avbryt en bakgrunnsjobb (`task.cancelled`); kill switch aktivér/opphev.
- **Bestått når:** alle seks steg gir forventet resultat; en ikke-eier eller svak økt får ikke handlingene.
- **Evidens:** `hf-10-control-pause`, `hf-10-control-cancel`, `hf-10-kill-switch` (SQL-/logg-utdrag).
- **Rader:** UA-11 (panelet), JARVIS-087.

### Blokk 11 – Evolution-rapporten (WP-B1/B2) og Safety Constitution

- **Mål:** EV-0 signert og festet (så `constitution_unsigned` forsvinner), radar-kildene valgt, og rapportseksjonene lest mot virkeligheten.
- **Krever:** offline signering ([EV0_CONSTITUTION_SIGNING.md](EV0_CONSTITUTION_SIGNING.md)), break-glass øvd ([EV0_BREAK_GLASS.md](EV0_BREAK_GLASS.md)); radar: `JARVIS_RADAR_SOURCES` (inert uten).
- **Slik:** signér og fest fingeravtrykk → restart → «hva er galt med deg» viser EV-0 verifisert; sett radar-kilder → første sveip i rapporten (kun status per kilde, aldri innhold); kjør `ops/evolution/dependency-check.ts` mellom to commits (EV-7).
- **Bestått når:** oppstartssjekken er grønn uten `constitution_unsigned`; radar viser status per kilde; dependency-check gir exit 0 eller et funn du forstår.
- **Evidens:** `hf-11-ev0-boot`, `hf-11-radar-first-sweep`, `hf-11-dependency-check`.
- **Rader:** EV-0, EV-3, EV-7 (skriptet er ikke koblet til CI – `DEFERRED`), EV-4/EV-21 (deterministiske selvtester, ikke LLM-eval).

### Blokk 12 – Business OS (WP-D2) – egen test-tenant

- **Mål:** bedrifts-tenant, lead-/mulighetsoppdatering og produktbruk/churn mot **testdata**, før noe kundedata kommer inn.
- **Krever:** beslutning om tenant-topologi og hvem som er suveren der (Q-48; se OWNER_ACTIONS «Beslutninger»); `ops/nas/provision-business-tenant.sh`; `JARVIS_OWNER_EXTRA_TENANTS` bare hvis du har besluttet at eierens egne jobber skal være suverene der.
- **Slik:** [WPD2_BUSINESS_OS.md](WPD2_BUSINESS_OS.md) §5 (5 steg): migrasjon 089–091 anvendt; dry-run og `--confirm` for tenant; `ops/nas/product-usage.sh import …` uten og med `--confirm` (samme kommando igjen = «allerede lagret»); webhook kun hvis slått på (signert `curl` = 200, endret kropp = 401); kobl en konto, vent ≥ 30 dagers stillhet i testdata, se `customer_churn_risk`-loopen.
- **Bestått når:** hvert steg gir forventet utfall; churn-loopen bærer aldri kontoreferansen i klartekst (nøkkelen er en digest); webhook-ruten gir 404 så lenge `JARVIS_PRODUCT_USAGE_TENANT_ID` ikke er satt (dormant), 503 hvis den er satt men hemmeligheten mangler/er for kort, og 401 ved feil signatur.
- **Evidens:** `hf-12-business-tenant`, `hf-12-usage-import`, `hf-12-churn-loop`.
- **Rader:** UA-3 Business OS, V4 (delvis).

## 4. Etter økten

1. **Evidens inn i repoet:** Claude committer filene på `claude/evidens-<dato>` og åpner en draft-PR (aldri direkte på `main`).
2. **Matrisen:** i samme PR flytter jeg bare de radene der en evidensfil dekker hele påstanden til `VERIFIED` (med lenke). Delvis dekning blir `PARTIAL` med presis tekst om hva som mangler. Feilet blokker blir issues, ikke «nesten».
3. **Rapport (≤ 15 linjer):** hva som ble `VERIFIED`, hva som står igjen og hvorfor (`BLOCKED_EXTERNAL`/`DEFERRED`/feilet), og hva som er neste.
4. **Opprydding:** fjern midlertidige flagg du ikke vil beholde, slett sandbox-grener/-poster som står igjen, slett eventuelle token-filer (`ACCEPTANCE_GIT_TOKEN_FILE`), og roter alt som ved et uhell havnet i chat.

## 5. Det økten IKKE dekker (står som det står i matrisen)

Fysiske kjøringer og eksterne leverandører: ≥ 100 norske lydprøver (D-30, [../VOICE_BENCHMARK.md](../VOICE_BENCHMARK.md)), Apple/Xcode/iPhone/Watch ([../APPLE_PHASE8_CHECKLIST.md](../APPLE_PHASE8_CHECKLIST.md)), Home Assistant-instans, ekte Vipps/Neonomics/Wallester/Fiken, Google Ads developer token, Meta-verifisering. Og det som ikke er bygget ennå (Growth-skriving, Comms, Personal, Vision, Situation-broer, Connector SDK, kontrollsentrene utover H0, kostmodell EV-22/23): de står som `NOT_BUILT`/`DEFERRED` i matrisen og verifiseres først når de er bygget.
