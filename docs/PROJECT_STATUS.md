# PROJECT STATUS

**Oppdatert:** 2026-09-14 (branch `claude/d132-worker-recovery-reconciliation`, PR #80 draft, base
`main=c67a7ba792b8d655a26379655ffec31b353b7101`). Aktiv ordre: **D-142**
(`D142-PR80-DURABLE-LEASE-EPOCH-RECOVERY-20260914-A`, issue #68 kommentar 5666781419,
`SUPERSEDES=D141-PR80-FENCED-LEASE-PG-IDENTITY-RECOVERY-20260914-A`). D-139, D-140 og D-141 er superseded.
`MERGE_AUTHORIZED=false`, `ARCHITECT_MERGE_APPROVED=false`, `SELF_APPROVAL=false` - PR #80 er IKKE merget.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Fase A - durabelt, aldri-nullstilt epoch-hoeyvannsmerke (ferdig, testet)

D-141 sin fencing var betinget av den eksakte generasjonen kalleren inspiserte - men generasjonen ble
utledet av filene som laa der, og `release()` SLETTET filen. Slapp den siste eieren, startet telleren
paa 1 igjen. Reprodusert mot UENDRET `ee3c902`: C gjenbrukte generasjon 1, forsinket A fikk eierskap
paa generasjon 2, og C sin leiefil ble revet vekk.

Tre uavhengige egenskaper lukker det:

1. **Gravstein.** `release()` skriver `state: "released"` paa sin EGEN sti i stedet for aa slette.
   Navnerommet for en port toemmes aldri, saa epoken og stien er brukt opp for alltid. Katalogen
   vokser ikke: opprydding fjerner strengt lavere epoker, saa det ligger én fil per port.
2. **Hoeyvannssjekk etter sikret sti.** At `wx` ga oss stien er ikke nok - oppryddingen etterlater et
   hull en forsinket aktoer ellers kunne fylt UNDER en gyldig eier med hoeyere epoke. Hoeyvannsmerket
   verifiseres etter at stien er sikret; en taper trekker seg og fjerner KUN sin egen fil.
3. **Katalog-inkarnasjon.** `.lease-dir-id` gjoer at en aktoer fra en slettet/gjenskapt leiekatalog
   feiler LUKKET i stedet for aa prune en fersk eier vekk.

`verifyOwnership()`/`assertOwned()` FENCER en eier som er forbigaatt, har mistet/faatt erstattet filen
sin, eller har sovet forbi sin EGEN TTL. En fenced eier roerer aldri disk igjen. En LEVENDE lokal eier
tas aldri over, heller ikke ved utloept heartbeat. Bounded retry, eier-identitet, rejected-port-
utelukkelse og leie i hele databasens levetid er uendret.

**Bevis: 65/65, null skipped** - deterministisk reset-ABA, 12 fulle sykluser uten epoke-/sti-gjenbruk,
6 sekvensielle PROSESSER med epoke 1->6, gjentatt ekte multiprosess-kontensjon (3 runder x 8),
release/heartbeat/reclaim mot etterfoelger, reinkarnert katalog, samme-vert levende/fersk-doed/
gammel-doed, kryssvert gyldig/uverifiserbar/utloept, zombie-selvfornyelse, oversubscription.

## Fase B - PostgreSQL-protokollbevis og kontrollplan (bevart)

D-141 B er uendret og koblet paa fencingen i begge retninger: `lease.assertOwned()` kjoeres ETTER
identitetsbeviset (et bevis tatt mens vi var fenced er ikke et eierskap), og en ny eier som moeter en
gammel, fortsatt kjoerende postmaster faar beviset avvist og forkaster porten. Proveniens-, dirty-,
koe- og restart-gatene fra D-135/D-136/D-139 B er ikke roert: `ops/claude-worker` 24 filer, **715/715**,
null skipped.

`describeError()` retter en ekte feil funnet underveis: `embedded-postgres` avviser med `undefined` paa
Windows, og `(err as Error).message` ble da en TypeError som ERSTATTET den ekte aarsaken.

## Fase C - kvalitet og CI

Lokalt groent: leiesuiten 65/65, `ops/claude-worker` 715/715, `pnpm -w lint`, `pnpm -r run typecheck`,
`node --check` paa 51 worker-runtime-`.mjs`, `git diff --check`. gitleaks 8.24.3 fant 36 treff - ALLE i
`.env` og `.env.bak.*`, som er git-ignorerte og USPOREDE lokale filer; null treff i sporet innhold.

**BLOKKERING FOR LOKALT POSTGRES-BEVIS.** Alle tester som starter EKTE embedded PostgreSQL kunne
IKKE kjoeres i denne oekten. Claude Code-sesjonen kjoerer FORHOEYET (`High Mandatory Level`,
Administrator), og PostgreSQL nekter aa starte under en administrator-konto:

    Execution of PostgreSQL by a user with administrative permissions is not permitted.

Dette er en egenskap ved SESJONEN, ikke ved endringen - UENDRET baseline-kode fra `ee3c902` feiler
IDENTISK i samme oekt (samme refusjon, samme maskerte TypeError). `runas /trustlevel` for aa kjoere
ikke-forhoeyet ble avvist av Claude Code sin auto-mode. **For aa gjenopprette lokalt Postgres-bevis maa
Claude Code startes i et IKKE-forhoeyet terminalvindu.** Konsekvens: den fulle repo-suiten kan ikke
sammenlignes med D-141 sin lokale kjoering, og de to NYE A.3-bevisene mot ekte PostgreSQL er ikke
observert groenne lokalt.

CI er den AUTORITATIVE porten for disse filene - den kjoerer paa Linux i `build-test` uten dette
problemet. Fersk groenn kjoering paa NOEYAKTIG endelig HEAD kreves for `build-test`, `windows-git-auth`
og `gitleaks`. Run-ID-ene rapporteres i CLAUDE_REPORT paa issue #68, ikke her (en dokumentoppdatering
ville flyttet HEAD og ugyldiggjort nettopp den kjoeringen).

## Fase D - transaksjonell host-recovery

**IKKE utfoert - den er gatet.** Kjoeres kun dersom fase A-C passerer OG fersk exact-head CI er groenn.
Rekkefoelge: ren primaer-checkout paa eksakt endelig remote HEAD -> repository-eid `install.ps1 -WhatIf`
-> staged/transaksjonell/hash-verifisert install uten quiescence-bypass -> verifiser runtime payload/
import-closure og eksakte hasher -> read-only worker/supervisor-status uten parser-/modulfeil -> FOERST
DA enable de EKSISTERENDE supervisor- og worker-schedulene -> bevis fersk queue-poll -> post
HOST_RECOVERY_RECEIPT. Ved enhver feil: la schedulerne staa `Disabled` og bevar staging/backups/logger.
Ingen prosess termineres.

**Naa:** `JarvisClaudeWorker` og `JarvisWorkerSupervisor` er begge `Disabled`. Deployet paa hosten er
`pr80-ee3c902f-20260914`, altsaa FRA FOER denne endringen.

## Blokkeringer

1. **Forhoeyet sesjon.** Ingen lokale ekte-PostgreSQL-bevis i denne oekten. Krever at Claude Code
   startes ikke-forhoeyet. CI daekker det i mellomtiden.
2. **Merge.** `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` i D-142. PR #80 merges ikke
   foer en NY `ARCHITECT_TASK` eksplisitt godkjenner det mot eksakt HEAD/base.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av PR #80 mot faktisk diff/tester/CI. Ingen merge uten en ny
`ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` og eksakt HEAD/base-guard.
