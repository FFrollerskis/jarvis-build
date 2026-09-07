# PROJECT STATUS

**Oppdatert:** 2026-09-07 (branch `claude/worker-self-recovery-20260907`, base
`main=94e4aaa528477fbdc87ce8f4f6c37cb9d3bebb1d`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her.

## Aktiv fase/oppgave

**Infrastrukturreparasjon: `WORKER-SELF-RECOVERY-20260907`** (byggeordre 5563608364 +
scope-oppdatering 5563627689 på issue #68). **Eksplisitt bestilt av eieren, IKKE en masterplan-slice
og IKKE en ny produktkapabilitet.** Ingen faseport er passert, ingen UA-slice er startet, ingen
sannhetsflagg for produktet er flippet. Full begrunnelse: D-126 i DECISIONS_AND_ASSUMPTIONS.md.

## Hva som ble reparert - og hvorfor det stoppet loopen

Fire uavhengige, produksjonsobserverte feil i den lokale worker-loopen:

| # | Feil | Konsekvens |
|---|------|-----------|
| A | Claude skrev ACK-/report-kladd INN i repoet; `.claude-ack-d125-merge.md` ble liggende | dirty-guarden blokkerte hver eneste påfølgende kjøring, permanent |
| B | `processed_task_ids.push()` kjørte uansett utfall | `spawnSync claude ETIMEDOUT` ble registrert som «ferdig»; D125-arbeidet forsvant |
| C | Låsen brukte pid + fast aldersbudsjett | frisk 50-minutters jobb kunne erklæres stale; gjenbrukt pid så levende ut |
| D | Ingen retry-grense, ingen synlig status | blokkert worker gikk stille ut med **exit 0** |

I tillegg: en håndskrevet wrapper-patch fra mobil innførte et fremmed tegn, ga ParserError og stoppet
alt **uten at noe rapporterte det**. Bekreftet ved inspeksjon av faktisk disk - den foreslåtte
patchen var aldri installert.

## Hva som faktisk ble bygget

Ny sporet kilde i **`ops/claude-worker/`** (13 `.mjs`-moduler, 8 `.ps1`-skript, 2 config-eksempler,
README). Se README.md der for full runbook.

- **A.** Kladd utenfor repoet ved konstruksjon; gammel kladd karantenes FØR dirty-guarden, men kun
  ved fullt ankret filnavn + innholds-/provenienssjekk + `TASK_ID` kjent for workeren. Aldri
  symlink/reparse point/sporet/ukjent fil. Hash før og etter. Bundet manifest med stier og hasher,
  aldri innhold. **Ingen** `git clean/reset/stash`, ingen `.gitignore`-skjuling.
- **B.** Timeout/exit≠0/spawn-feil/manglende report gir ALDRI «processed». Fullført krever matchende
  betrodd `CLAUDE_REPORT` for eksakt `TASK_ID` med terminal `STATUS`. Atomisk state med backup;
  ulesbar primær + backup ⇒ workeren NEKTER å kjøre framfor å miste replay-beskyttelse.
- **C.** Én lås dekker preflight → karantene → dispatch → alle state-skriv. Levende eier avgjøres av
  prosessidentitet (pid + starttid + host) og heartbeat. Aktiv lås ryddes ALDRI automatisk. Orphan
  Claude-barn sjekkes før retry, så to Claude-prosesser aldri overlapper.
- **D.** Bundet backoff med hardt tak; deduplisert `CLAUDE_WORKER_STATUS` på issue #68. Exit-koden er
  aldri 0 når noe er blokkert (0 frisk / 3 blokkert / 4 forbigående / 1 fatal).
- **E.** Kun allerede autoriserte tasks; ingen oppfunnet neste arbeid.
- **F.** Egne health-hendelser per steg, så «scheduleren kjørte» aldri forveksles med «arbeidet ble
  fullført». `node worker.mjs health` svarer på det faktiske spørsmålet.
- **Supervisor** (autorisert av scope-oppdateringen, ÉN recovery-supervisor - aldri en andre
  implementasjons-worker): egen state/lås/logg, kun lesende observasjon av worker-oppgaven, ankret
  `ARCHITECT_CONTROL`-skjema med kun `STATUS` og `RESTART_WORKER`, unik `COMMAND_ID`,
  host-/worker-binding, kort utløp, avvisning av redigerte/replayede kommentarer, døgnbudsjett og
  backoff. **Avbryter aldri levende arbeid, avslutter aldri en prosess.**

## Kvalitetsporter

- **103 nye tester, alle grønne lokalt:** `npx vitest run ops/claude-worker/test` →
  **7 filer / 103 tester passed**. Dekker alle åtte akseptansetestene i byggeordren + de seks i
  scope-oppdateringen som kan dekkes med fixtures: den eksakte D125-ACK-filen (hash bevart, tre blir
  ren, dispatch mulig), ukjent fil / sporet endring / symlink / reparse point / kollisjon, timeout og
  exit≠0 markerer ikke processed, exit 0 uten matchende report er ikke fullført, krasj etter
  report/PR/merge rekonsilieres uten duplikat-effekt, samtidige invokasjoner dispatcher én gang,
  levende langtidsjobb forveksles ikke med stale lås, korrupt/avbrutt state gjenopprettes uten å
  slette historikk, backoff-utmatting gir synlig deduplisert status, og supervisor-avvisning av
  replay/utløp/feil forfatter/feil host/vilkårlig kommando.
- `npx eslint ops/ eslint.config.mjs`: **rent.**
- `node --check` på alle 13 `.mjs`-filer: **rent.**
- **Én ekte sikkerhetsfeil funnet av testene og rettet:** `Authorization:\s*\S+` konsumerte kun
  skjemaet («Bearer») og lot selve credentialet stå igjen i klartekst i logg/kommentar. Nå redigeres
  hele linjen bort.
- **`.ps1`-verifisering:** alle 8 skript er verifisert **ren ASCII og balansert** statisk via Node.
  **Ekte PowerShell-AST-parsing ble IKKE kjørt** - PowerShell-kjøring krevde godkjenning som ikke
  ble gitt i denne økten. `verify-scripts.ps1` er levert i repoet nettopp for dette og MÅ kjøres på
  hosten før installasjon.
- **Full produktsuite ble IKKE kjørt** i denne økten (endringene rører ingen produktkode; kun
  `vitest.config.ts` include og `eslint.config.mjs` er endret utenfor `ops/`). CI på eksakt endelig
  HEAD rapporteres med run-id i `CLAUDE_REPORT` på issue #68.

## Flagg-status - alt uverifisert til det er bevist på hosten

`WORKER_SELF_RECOVERY_VERIFIED=false` · `SUPERVISOR_INSTALLED=false` ·
`REMOTE_RESTART_VERIFIED=false` · `REBOOT_PERSISTENCE=UNVERIFIED` ·
`SOURCE_CHANGED=true` · `DEPLOYED_TO_HOST=false`.

**Kildeendring er IKKE deployment.** Den kjørende workeren på hosten er fortsatt v1 med alle fire
feilene. Ingenting er installert, registrert eller startet av denne økten.

Uendret av denne oppgaven: `UA7_COMPLETE=false`, `UA7_ACCEPTANCE_4=PARTIAL`,
`Q32_POINT1=OPEN_EXTERNAL_OWNER_ACTION`, `D108_COMPLETE=false`, `UA6_COMPLETE=false`,
`NEW_PROVIDERS_ADDED=0`, `NEW_CREDENTIALS_OR_SCOPES=0`, `CORE_DEPENDENCY_DECISION_REQUIRED=false`.

## Normativ endring som MÅ bekreftes i review

D-120 sa «ren infrastruktur ... derfor INGEN kode i dette repoet» / «ALDRI committet i dette repoet».
Byggeordren ba samtidig om å utvide en «existing tracked source/install flow» (som ikke fantes) og om
draft-PR med tester og CI - strukturelt umulig for en usporet kilde, og usporet håndredigering er
nettopp ParserError-årsaken. **D-126 endrer derfor KUN «ingen kode i repoet»-klausulen:** kilden
spores i `ops/claude-worker/`, utenfor pnpm-workspacet og produktbygget; KJØRETIDEN ligger fortsatt
utenfor repoet i `%USERPROFILE%\.jarvis-claude-worker\`. Avviser arkitekten dette, må en annen
leveransekanal utpekes - da kan reparasjonen ikke leveres som en reviewbar PR.

## Blokkeringer

- **Ekte PowerShell-parse-verifisering ikke kjørt** (godkjenning ikke gitt i økten). Må kjøres på
  hosten: `.\verify-scripts.ps1`.
- **Installasjon avventer bevisst uavhengig arkitekt-review** (byggeordren krever det eksplisitt før
  aktivering av endret worker-logikk).
- `HARD_EXTERNAL_BLOCKER=false`.

## Neste oppgave

1. Uavhengig ChatGPT-arkitekt-review av PR-en (INGEN self-approval, `ARCHITECT_MERGE_APPROVED=false`).
2. Etter godkjent review, på hosten i rekkefølge: `.\verify-scripts.ps1` → `.\install.ps1 -WhatIf` →
   `.\install.ps1` → config-filer → `node worker.mjs status` / `run --dry-run` →
   `.\install-task.ps1` → `.\install-supervisor.ps1`.
3. Endelig akseptanse krever, i tillegg til fixture-testene: deployerte skript-hasher/versjon, en
   ekte planlagt kjøring som fullfører en ufarlig autorisert probe, og en ekte
   `RESTART_WORKER`-kvittering. Først da kan `WORKER_SELF_RECOVERY_VERIFIED`, `SUPERVISOR_INSTALLED`
   og `REMOTE_RESTART_VERIFIED` settes true - individuelt, aldri samlet.

Ingen påstand om at alle framtidige feil er umulige. Reparasjonen fjerner fire konkrete, observerte
feilmoduser og gjør resten synlige i stedet for stille.
