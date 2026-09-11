# PROJECT STATUS

**Oppdatert:** 2026-09-10 (branch `claude/ua8-personal-digital-twin-core`, base `main=5df11e5add901f3fff10c2ef266c40e3e35e3f48`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Aktiv oppgave: D-131a - autoritets-hardening av PR #79 (samme PR, samme branch)

TASK_ID `D131-PR79-AUTHORITY-HARDENING-20260910-A` (ARCHITECT_TASK, kommentar 5614384228 på issue
#68). En NY uavhengig arkitektkontroll av gjeldende HEAD (`7f4753a8`) - ikke en gjentakelse av review
5149129191, som gjaldt `acc118e0` - bekreftet at D-131 sine funn om transaksjonsatomisitet,
location-purge/FK, erasure og scope/membership er bearbeidet, men fant **tre nye sikkerhetsblokkere i
selve auth-fiksen**. Rettet som ÉN sammenhengende, reviewbar runde på SAMME PR #79.
`MERGE_AUTHORIZED=false` - ingen merge, ingen self-approval.

**Fikset:**

1. **Samtalekontinuitet er skilt fra autorisasjonsbevis.** `/chat`/`/brief` slo opp `person_id` +
   den MUTABLE `last_device_id` fra en rå sesjons-ID og satte `auth_strength: "signed"`. Nå utstedes
   et serverutstedt, avgrenset og revokerbart **grant** (ny tabell `session_grants`, migrasjon
   `053_session_grants.sql`, ny `SessionGrantService`), bundet til én bevist enhet, ett autorisert
   memory space, én kanal og et utløp. Databasen lagrer kun SHA-256 av tokenet. Grantet bærer en
   fingerprint av enhetsnøkkelen som re-verifiseres ved HVERT kall, så tilbakekalling OG rotasjon
   dreper utestående grants strukturelt. `/chat`-kroppen er nå `{grant_token, message, provider?}` og
   `/brief` `{grant_token}` - ingen identitetsbærende felt igjen. `SessionService.getActive()` er
   FJERNET. Alle reelle kallere oppdatert: voice-gateway, `JarvisClient.swift` (+ iOS/Watch-appene,
   som hadde `client` som computed property og derfor kastet beviset mellom kallene), web-dev-demoen.
2. **Innrullering krever eksplisitt eier-/bootstrap-autoritet.** `/devices/register` autoriserte seg
   med `resolveIdentity()` (verifiserer EKSISTENS, ikke AUTENTISERING) + `ON CONFLICT DO UPDATE` av
   `public_key_pem` - en caller med kun offentlige ID-er kunne skrive sin egen nøkkel og deretter
   «bevise» enheten. Ny `DeviceEnrollmentService` krever nå enten proof-of-possession fra en allerede
   innrullert enhet (samme person/tenant), eller en engangs, kortlevd billett
   (`device_enrollment_tickets`) fra en lokal eier-handling: `pnpm --filter @jarvis/api enroll-ticket`
   (bruker eksisterende admin-DB-credentials - ingen ny credential, ingen hardkodet bypass).
   `registerDevice()` → `registerDeviceTrusted()` + eierskapsgard som hindrer overtakelse av en
   `device_id` som tilhører en annen prinsipal.
3. **Avslag muterer ikke lenger sesjonen.** Hele autorisasjonen (medlemskap/enhet/space → sesjon →
   grant → ALLOW-audit) kjører nå i ÉN transaksjon i den DELTE `authorizeProvenDevice()`, brukt av
   BÅDE `ChannelSessionAuthority` og `VoiceSessionAuthority` (voice hadde identisk rekkefølgefeil).
   Avslag returnerer før første skriving eller ruller alt tilbake; avslags-auditen skrives i egen
   transaksjon, nonce-konsumering rulles bevisst ikke tilbake. `channel` valideres nå mot
   `ChannelSchema` (ny grunn `unknown_channel`), ikke bare `typeof === "string"`.

**Kvalitetsporter (denne runden) - hva som FAKTISK er bevist, og hvor:**

Lokalt, faktisk kjørt og grønt på denne Windows-maskinen:

- `pnpm install --frozen-lockfile`: ren, lockfile uendret.
- `pnpm -r run typecheck`: 27/27 pakker grønt.
- `pnpm run build`: exit 0.
- `pnpm -w lint`: rent, 0 feil/advarsler.
- Manuell hemmelighetsskann av full diff: ingen reelle treff (kun eksisterende
  embedded-Postgres-testfixturer som `test-superuser-pw`, uendret mønster).

IKKE bevist lokalt - MILJOEBLOKKERT, ikke en regresjon:

Alle testfiler som starter embedded Postgres kan IKKE kjøres i denne økten.
`initdb`/`pg_ctl` nekter å starte fordi prosessen eier et administrator-token:

    Execution of PostgreSQL by a user with administrative permissions is not
    permitted. The server must be started under an unprivileged user ID to
    prevent possible system security compromises.

Verifisert: `WindowsPrincipal.IsInRole(Administrator)` = True for skallet som
kjører testene. Konsekvensen er at `beforeAll` henger til embedded-postgres sin
egen oppstartsventing løper ut (~122 s per fil) og vitest rapporterer ALLE
testene i filen som **skipped** - ikke passed, og ikke failed. En full
arbeidsområde-kjøring i denne økten er derfor MILJOE-INVALID som bevis, i begge
retninger. Den ble stoppet kontrollert etter 97/235 filer nettopp fordi den ikke
kunne bevise noe.

`--hookTimeout` endrer ikke dette: ventingen ligger i embedded-postgres sin egen
oppstartslogikk, ikke i vitest sin hook-timeout.

Tre filer feilet ekte (ikke skipped) i den stoppede kjøringen, alle med
`docker_spawn_failed: spawnSync ...docker.cjs EFTYPE` - Docker-/subprosess-
tester som ikke er berørt av denne diffen i det hele tatt:
`modules/tool-gateway/test/docker-transport.test.ts` (12),
`modules/tasks/test/sandbox-docker-extra-env.test.ts` (5),
`apps/api/test/worker-coding-wiring.test.ts` (8). Samme miljøklasse (Windows-
spawn), ikke verifisert mot ren base lokalt - CI avgjør.

Målrettet kjøring av de 12 direkte berørte testfilene (kommando og logg i
øktens scratch, `affected.log`) bekrefter nøyaktig dette bildet:

    Test Files  10 failed | 2 passed (12)
         Tests  37 passed | 103 skipped (140)

De 2 grønne er de eneste som IKKE trenger Postgres:
`apps/voice-gateway/test/ua7-voice-session-authority.test.ts` (19/19) og
`apps/voice-gateway/test/d30-foundation.test.ts` (18/18). De 10 øvrige feiler
alle identisk med `Error: Hook timed out in 120000ms` i `beforeAll` - altså
embedded Postgres som aldri startet, ikke en assertion som slo feil.

AUTORITATIV VERIFIKASJON: GitHub Actions (Linux) på eksakt denne HEAD-en. Det er
den eneste kjøringen i denne runden som faktisk kan starte Postgres og kjøre
D-131-regresjonene. Resultatet står i CLAUDE_REPORT på issue #68 og i PR #79.

Ny `apps/api/test/d131-authority-hardening-e2e.test.ts` (24 tester, ekte HTTP +
ekte `createApiServer()` + ekte Postgres under ekte NOSUPERUSER/NOBYPASSRLS-
rolle) dekker: per-enhet-autoritet ved kanalbytte (eldre klient IKKE
re-attribuert), tilbakekalt/rotert nøkkel, utløpt og tilbakekalt grant, rå
sesjons-ID mot BÅDE `/chat` og `/brief`, transport uten enhetsbevis, anonym
innrullering/rotasjon uten nøkkelendring (full `devices`-snapshot), engangs-
billett, fremmed `device_id`, og for funn 3 en `expectNoMutation()`-hjelper med
BYTE-IDENTISK før/etter-snapshot av BÅDE `sessions` OG `session_grants` (ikke
`COUNT(*)`) for ukjent space med/uten eksisterende sesjon, ugyldig kanal-enum,
kryss-person, kryss-tenant, replay, ugyldig signatur og smuglede felt.
**Status: skrevet og typecheck-/lint-grønn, men IKKE kjørt lokalt (se over).**

- Eksisterende D-131-regresjoner bevart og oppdatert til den nye kontrakten
  (session-authority-e2e, fase3-e2e, voice-e2e, d123-voice-session-authority,
  channel-session-authority, fase8-device, channel-session-continuity-dedupe).

**Ikke gjort (bevisst):** Q-34 gateway-audit, D-108/provider-live, nye eksterne credentials, merge,
deploy, self-approval, ny PR, mikroslices.

Full detalj: **D-131a** i DECISIONS_AND_ASSUMPTIONS.md (D-131 er forrige runde og står uendret).

## Blokkeringer

**Lokalt testmiljø (Windows) er invalid for embedded Postgres - IKKE en kodeblokkering.**
`initdb`/`pg_ctl` nekter å starte under et administrator-token, og alle Postgres-baserte testfiler
rapporteres derfor som `skipped` etter ~122 s. Full arbeidsområde-verifikasjon skjer i GitHub
Actions (Linux) på eksakt PR-HEAD. Tiltak for senere økter: kjør testsuiten fra et IKKE-forhøyet
skall, eller i Docker/WSL. Ingen kode- eller testendring kreves.

`MERGE_AUTHORIZED=false` fra oppgaven: PR #79 forblir draft og kan ikke merges før en NY uavhengig
arkitektkontroll har godkjent eksakt ny HEAD/base og gitt en separat guarded two-parent mergeordre.

## Neste oppgave

1. Uavhengig arkitektkontroll av den nye HEAD-en på PR #79 (CI må være grønn på eksakt den SHA-en).
2. Etter godkjent merge + fersk post-merge CI på merge-SHA + bevist trygg lokal main-sync: egen,
   dedikert cross-domene-audit-slice for Q-34 FØR en generisk `gateway.ts`-fiks vurderes.
3. Deretter: re-derivere neste STØRSTE TRYGGE SAMMENHENGENDE leveranse fra faktisk repo-/masterplan-
   status (ikke anta en fast rekkefølge).
