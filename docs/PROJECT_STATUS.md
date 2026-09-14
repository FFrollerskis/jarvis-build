# PROJECT STATUS

**Oppdatert:** 2026-09-14 (branch `claude/d132-worker-recovery-reconciliation`, PR #80 draft, base
`main=c67a7ba792b8d655a26379655ffec31b353b7101`). Aktiv ordre: **D-143**
(`D143-PR80-DISTRIBUTED-FENCING-HOST-RECOVERY-20260914-A`, issue #68 kommentar 5670343618,
`SUPERSEDES=D142-PR80-DURABLE-LEASE-EPOCH-RECOVERY-20260914-A`). D-139 til D-142 er superseded.
`MERGE_AUTHORIZED=false`, `ARCHITECT_MERGE_APPROVED=false`, `SELF_APPROVAL=false` - PR #80 er IKKE merget.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Fase A - kryssvert-overtakelse fjernet (ferdig, testet)

D-141/D-142 tok over en kryssvert-leie naar `now > heartbeat_at_ms + ttl_ms`. Den slutningen holder
ikke: `heartbeat_at_ms` er skrevet med den FREMMEDE vertens wall clock og ble maalt mot VAAR. Uten en
bevist kontrakt for bundet klokkeavvik er det en antakelse, ikke en observasjon - og den feiler i den
farlige retningen: en kontender med en klokke som gaar for fort «observerer» en frisk leie som
forlatt og stjeler en port i aktiv bruk.

**Valgt arkitektur: fail closed for ALLE kryssvert-eiere.** D-143 tilbød enten dette eller en ekte
delt, autoritativ expiry-/lock-tjeneste. Leiekatalogen er vertslokal (`os.tmpdir()`), saa distribuert
overtakelse loeser et problem vi ikke har; en delt tjeneste ville gitt ny driftsavhengighet og en
distribuert protokoll vi maatte bevise, for null gevinst.

- `reclaimVerdict` gir ÉTT verdikt for enhver leie eid av en annen vert: `HELD_REMOTE_OWNER`
  (`held_remote_owner_fail_closed`) - uavhengig av heartbeat, ttl, lesbarhet og lokal pid-liveness.
- `RECLAIMABLE_EXPIRED`, `HELD_REMOTE_HEARTBEAT_VALID` og `HELD_REMOTE_UNVERIFIABLE` er FJERNET, ikke
  beholdt som døde verdikter som kunne lest som om de fortsatt styrte noe.
- Eneste avgrensning: en fjern GRAVSTEIN er fortsatt ledig. En eier som eksplisitt ga slipp er ikke
  et gjett om liv.
- TTL beholdes, men er ikke lenger overtakelsesgrunnlag for NOEN. Den brukes kun av en eier mot sine
  EGNE tidsstempler i `verifyOwnership()` - samme prosess, samme klokke.

Samme-vert-oppførsel er uendret: levende pid stjeles aldri, død og gammel nok kan tas over, og
release/heartbeat/reclaim er fortsatt betinget av eksakt epoke/eier/inkarnasjon. Durable
aldri-nullstilte epoker, gravsteiner, høyvannssjekk etter sikret sti, katalog-inkarnasjon, bounded
retry og rejected-port-utelukkelse fra D-142 er bevart uendret.

**Bevis: 71/71, null skipped.** Nytt i D-143: klokkeskjev i BEGGE retninger (en time foran og en time
bak gir samme svar), verdikt bevist uavhengig av `now` over seks størrelsesordener, EKTE DELT
leiekatalog med offer og raider i SAMME katalog (D-142 brukte to uavhengige kataloger og beviste
dermed ikke dette), og at intet intervall i den offentlige livssyklusen har to autoritative eiere -
etterfølgeren finnes først NÅR forgjengeren er fenced. Bevart og re-kjørt: reset-ABA, flersyklus
epoke-unikhet, stale multiprosess-kontensjon, release/heartbeat/etterfølger-kapløp, katalog-
reinkarnasjon.

## Fase B - kontrollplanen uendret

`ops/claude-worker` er ikke endret. Full suite kjørt som regresjonskontroll: **24 filer, 715/715**,
null skipped. Proveniens, dirty-completion, kø-rekkefølge ved stale head, isolerte task-worktrees,
kanoniske terminalstatuser og den strikte primær-worktree-porten er uberørt.

## Fase C - kvalitet og CI

Lokalt grønt: leiesuiten 71/71, `ops/claude-worker` 715/715, `pnpm -w lint`, `pnpm -r run typecheck`,
`node --check` på 51 worker-runtime-`.mjs`, `git diff --check`. gitleaks 8.24.3 over hele historikken:
ingen funn (36 `--no-git`-treff er alle i git-ignorerte, usporede `.env`/`.env.bak.*`).

**BLOKKERING FOR LOKALT POSTGRES-BEVIS (uendret).** Claude Code-sesjonen kjører FORHØYET (`High
Mandatory Level`, Administrator), og PostgreSQL nekter å starte under en administrator-konto:

    Execution of PostgreSQL by a user with administrative permissions is not permitted.

Bevist å være en egenskap ved SESJONEN, ikke ved endringen: uendret baseline-kode fra `ee3c902` feiler
identisk. `runas /trustlevel` ble avvist av Claude Code sin auto-mode. **For å gjenopprette lokalt
Postgres-bevis må Claude Code startes i et IKKE-forhøyet terminalvindu.** 116 av 247 testfiler krever
ekte embedded PostgreSQL og kunne ikke kjøres. De 131 kjørbare gav **2628/2653**; alle 25 feil er den
pre-eksisterende Windows-`.cjs`-spawn-klassen fra D-141 med identiske tall (12+8+5).

CI på Linux er den AUTORITATIVE porten for disse filene. Fersk grønn kjøring på NØYAKTIG endelig HEAD
kreves for `build-test`, `windows-git-auth` og `gitleaks`; tidligere CI på `09cc204` teller ikke.
Run-ID-ene rapporteres i CLAUDE_REPORT på issue #68, ikke her (en dokumentoppdatering ville flyttet
HEAD og ugyldiggjort nettopp den kjøringen).

## Fase D - transaksjonell host-recovery

**IKKE utført - den er gatet.** Kjøres kun når fase A-C passerer OG fersk exact-final-head CI er
grønn. Rekkefølge: ren primær-checkout på eksakt endelig remote HEAD -> repository-eid
`install.ps1 -WhatIf` -> staged/transaksjonell/hash-verifisert install uten quiescence-bypass ->
verifiser runtime payload/import-closure og eksakte hasher -> read-only worker/supervisor-status uten
parser-/modulfeil -> FØRST DA enable de EKSISTERENDE supervisor- og worker-schedulene -> bevis fersk
queue-poll -> post HOST_RECOVERY_RECEIPT. Ved enhver feil: la schedulerne stå `Disabled` og bevar
staging/backups/logger. Ingen prosess termineres.

**Nå:** `JarvisClaudeWorker` og `JarvisWorkerSupervisor` er begge `Disabled`. Hosten kjører fortsatt
deployet fra før denne endringen.

## Blokkeringer

1. **Forhøyet sesjon.** Ingen lokale ekte-PostgreSQL-bevis. Krever at Claude Code startes
   ikke-forhøyet. CI dekker det i mellomtiden.
2. **Merge.** `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` i D-143. PR #80 merges ikke
   før en NY `ARCHITECT_TASK` eksplisitt godkjenner det mot eksakt HEAD/base.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av PR #80 mot faktisk diff/tester/CI. Ingen merge uten en ny
`ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` og eksakt HEAD/base-guard.
