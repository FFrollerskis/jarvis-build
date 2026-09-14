# PROJECT STATUS

**Oppdatert:** 2026-09-14 (branch `claude/d132-worker-recovery-reconciliation`, PR #80 draft, base
`main=c67a7ba792b8d655a26379655ffec31b353b7101`). Aktiv ordre: **D-141**
(`D141-PR80-FENCED-LEASE-PG-IDENTITY-RECOVERY-20260914-A`, issue #68 kommentar 5657788710,
`SUPERSEDES=D140-PR80-LEASE-IDENTITY-HOST-RECOVERY-20260914-A`). D-139 og D-140 er superseded.
`MERGE_AUTHORIZED=false`, `ARCHITECT_MERGE_APPROVED=false`, `SELF_APPROVAL=false` - PR #80 er IKKE merget.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Fase A - fenced, ABA-sikker portleie (ferdig, testet)

D-139 sin leie var atomisk, men ikke fenced. Den skrev til ÉN sti per port og tok over med `renameSync`,
som er UBETINGET: den flytter det som ligger der NÅ, ikke det kalleren inspiserte. ABA-fletningen:
P1 leser leie L → P2 leser L, tar over, skriver etterfølger S → P1 `rename`-r stien og river vekk S.
I tillegg tok D-139 over enhver leie fra en ANNEN vert fordi pid-en «ikke betyr noe der» - fail-OPEN.

Nå: leien for port P er filen med HØYEST generasjon blant `P.<gen>.lease`, og overtakelse er
`open(P.<gen+1>.lease, "wx")` - betinget av den EKSAKTE generasjonen kalleren inspiserte
(`takeOverGeneration`). En taper oppretter ingenting og river ingenting. `release()` sletter kun sitt
EGET filnavn; en etterfølger har per konstruksjon et annet navn og kan derfor ikke nås. Opprydding
fjerner kun STRENGT LAVERE generasjoner. Kryssvert-leier tas kun over ved verifiserbart utløpt
heartbeat, ellers fail-closed. Rejected-port-utelukkelsen fra `39f1025` er beholdt uendret.

## Fase B - PostgreSQL-protokollbevis (ferdig, testet mot ekte postgres)

D-139 krevde en TCP-forbindelse til 127.0.0.1 etter `start()` - og beviste i sin egen test at en
generisk `net.createServer()` tilfredsstilte kravet. Det er check-to-bind-motstanderen i ren form.

`assertPostgresIdentityIPv4` krever nå ekte PostgreSQL-autentisering med instansens EGNE credentials
pluss `inet_server_addr() = 127.0.0.1` (IPv4-socketen spesifikt), `inet_server_port() = leid port` og
en `pg_postmaster_start_time()` som ikke er eldre enn vår egen oppstart. Feil identitet er endelig
umiddelbart - den kan ikke vente seg til et ja. Feiler beviset: instansen stoppes, KUN dens egen leie
frigjøres, porten utelukkes, og neste kandidat prøves bundet. `assertPostgresBoundIPv4` er fjernet.

## Fase C - kontrollplan-portene er uendret

Proveniens-, dirty-, kø- og restart-gatene fra D-135/D-136/D-139 B er ikke rørt. Hele
`ops/claude-worker`-suiten er kjørt på nytt som regresjonskontroll: 715/715, null skipped.

## Fase D - kvalitet og CI

Lokalt (Windows-vert, ekte embedded PostgreSQL 16): fenced leie 44/44, PostgreSQL-identitet 8/8,
claude-worker 715/715 (24 filer), full repo-suite 4150/4195 (247 filer, 241 gronne). `pnpm -w lint` grønn,
`pnpm -r run typecheck` grønn, `node --check` grønn på 51 worker-runtime-`.mjs`, `git diff --check` ren,
gitleaks 8.24.3 over hele historikken (339 commits) uten funn.

CI er den AUTORITATIVE porten for disse seks filene: de kjorer paa Linux i `build-test`, der ingen
av de tre vertsartefaktene finnes. Fersk gronn kjoring paa NOYAKTIG denne HEAD-en kreves for
`build-test`, `windows-git-auth` og `gitleaks` - en kjoring paa en tidligere head teller ikke.
Run-ID-ene rapporteres i CLAUDE_REPORT paa issue #68, ikke her (en dokumentoppdatering ville flyttet
HEAD og ugyldiggjort nettopp den kjoringen).

**Seks testfiler feiler lokalt paa Windows-verten - alle PRE-EKSISTERENDE, ingen av dem rorer koden
denne oppgaven endret:**

| Fil | Feil | Bevis for at den er pre-eksisterende |
|---|---|---|
| `modules/tool-gateway/test/docker-transport.test.ts` (12) | `docker_spawn_failed: spawnSync ... docker.cjs EFTYPE` | identisk 12/12 paa uendret `39f1025` i egen baseline-worktree |
| `apps/api/test/worker-coding-wiring.test.ts` (8) | samme `.cjs`-spawn-klasse | identisk 8/8 paa uendret `39f1025` |
| `modules/tasks/test/sandbox-docker-extra-env.test.ts` (5) | samme `.cjs`-spawn-klasse | identisk 5/5 paa uendret `39f1025` |
| `modules/tasks/test/claude-code-agent.test.ts` (4) | fake CLI-binaer kan ikke spawnes paa Windows -> `failed` i stedet for `completed` | samme spawn-klasse; embedded Postgres startet fint |
| `modules/business/test/ua3-live-pool-separation.test.ts` (2) | kildeinspeksjons-assertsjoner sammenligner mot LF, filen er sjekket ut med CRLF | ren CRLF-artefakt; `modules/business/scripts/` er ikke rort av denne diffen |
| `modules/finance/test/vipps-service.test.ts` (14) | Vipps-tilstandsmaskin, ingen port/identitet involvert | **54/54 gronne ISOLERT paa NOYAKTIG dette treet** - kryssfil-rekkefolge i full suite, ikke en regresjon |

Baseline-worktreet kunne ikke brukes for de tre siste: den dype scratch-stien traff Windows sin
stigrense (`could not load library ... dict_snowball.dll: The filename or extension is too long`) i
initdb. Det sies her som det er, i stedet for aa presenteres som et bevis det ikke er.

## Fase E - transaksjonell host-recovery

**IKKE utfort enda - den er gatet.** Fase E kjores kun dersom fase A-D passerer OG fersk exact-head CI
er gronn. Rekkefolge naar porten aapner: ren primaer-checkout paa eksakt endelig remote HEAD ->
repository-eid `install.ps1 -WhatIf` -> staged/transaksjonell/hash-verifisert install uten
quiescence-bypass -> verifiser runtime payload/import-closure og eksakte hasher (inkl.
`lib/queue.mjs`, `lib/worktree.mjs`, `lib/provenance.mjs`) -> read-only worker/supervisor-status uten
parser-/modulfeil -> FORST DA enable de EKSISTERENDE supervisor- og worker-schedulene -> bevis fersk
queue-poll -> post HOST_RECOVERY_RECEIPT. Ved enhver feil: la schedulerne staa `Disabled` og bevar
staging/backups/logger. Ingen prosess termineres.

**Naa:** `JarvisClaudeWorker` og `JarvisWorkerSupervisor` er begge `Disabled`. Deployet
`pr80-4315c631-20260914` er fortsatt det som ligger paa hosten - altsaa FRA FOER denne endringen.

## Blokkeringer

Ingen kjente blokkeringer i koden. To ting ligger utenfor det jeg kan avgjore selv:

1. **Merge.** `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` i D-141. PR #80 merges ikke
   for en NY `ARCHITECT_TASK` eksplisitt godkjenner det mot eksakt HEAD/base.
2. **Fase E.** Gatet paa fersk gronn exact-head CI, som ikke kan vaere gronn for denne committen er
   pushet og kjort.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av PR #80 mot faktisk diff/tester/CI. Ingen merge uten en ny
`ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` og eksakt HEAD/base-guard.
