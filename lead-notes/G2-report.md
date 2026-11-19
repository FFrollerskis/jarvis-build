TS: 2026-11-18T23:47:50.025Z
**WP-G2 (D-464) UA-8 Personal Digital Twin – sluttrapport**

`CORE_DEPENDENCY_DECISION_REQUIRED=false` (ingen bil-leverandør valgt; et aggregat-API ville utløst den). `HARD_EXTERNAL_BLOCKER`: ingen utløst. Live-delene er `BLOCKED_EXTERNAL` (under).

**Gren:** `claude/wp-g2-personal` @ `d91d2197fdfe97b4cba64e8e726735cf517a4016`. 11 commits over `b2d43703`, 68 filer, +9642/−38.
**Pushet: NEI.** Ett forsøk ga `remote: credential service temporarily unavailable` / HTTP 503, og er ikke gjentatt.
Commits:
- `0280ae22` P1a
- `64415034` P1b
- `9a154b6e` og `85fb3634` P1c
- `24dc94c1` P1d
- `594b8ae7` P2g
- `cde37d86` docs
- `082e2ffd` P2f
- `0c579479` P2e
- `6d20994f` og `d91d2197` fix (guardedFetch og signal-vakter)

Ikke rebaset: `integration/post-merge-test-2` står nå på `d09dfc32`. Tørrkjørt merge gir kun to additive konflikter, `apps/api/src/main.ts` og `modules/tool-gateway/src/tool-manifest.ts` (behold begge sider). Alle fil:linje under er relative til `/home/user/jarvisbuild/.claude/worktrees/agent-a02e8e7b2fb1d34c4/`.

**Bygget** (alt `DORMANT` bak `JARVIS_PERSONAL_*`; flagg AV = identisk med main; ingenting `VERIFIED`)
- **P1a Kritiske hjemmehandlinger:** `DORMANT`. 8 klasse D-verktøy `home-assistant.critical_{lock,alarm,cover,valve,switch,scene,script,climate_mode}` + `read_critical_state`.
  - Eierens mål-allowlist, preflight, readback av faktisk sluttilstand (SUCCESS/MISMATCH/UNKNOWN), journal (mig. 125), umiddelbart varsel.
  - Gamle `lock_set`/`alarm_set` fjernes når flagget er på.
  - Ingen lemping av step-up (Q-G2-1).
- **P1b Bil:** `DORMANT`; live `BLOCKED_EXTERNAL`. Leverandørnøytral `CarAdapter` + falsk adapter + kontraktskit. `car.{lock,unlock,climate_set,charge_set}` + `read_vehicle_state` i samme D-kjede. Uten adapter feiler alt lukket.
- **P1c Familie/delte rom:** `DORMANT`, `PARTIAL`.
  - Dedikert sirkel-tenant (Q-15-hullet), roller, invitasjon/tilbakekall.
  - Deling kun fra subjektet selv (DB-CHECK); barn ser/deler aldri helse.
  - «På vegne av» kun med prinsipalens delegasjon (utløp påkrevd); felles lister/kalender.
  - 26 ruter `/personal/family/*`; mig. 126–127; slettekjeden dekker tabellene.
- **P1d Helse-inntak:** `DORMANT`; appen `BLOCKED_EXTERNAL`. `POST /personal/health/ingest`.
  - 10 lukkede metrikker verifisert mot Apples dokumentasjon 2026-11-18.
  - Idempotent på HealthKit-uuid, fail-closed retensjon (mig. 128). Kun rute, aldri verktøy.
- **P2e Apple Kalender/Påminnelser/Kontakter:** bygget mot FALSK server, `DORMANT`, `PARTIAL`; live `BLOCKED_EXTERNAL`; EventKit `DEFERRED`. 6 eier-kun-ruter `/personal/dav/{collections,list,get,create,update,delete}`. Allowlist, etag, readback, step-up, revisjon før mutasjon, `guardedFetch`.
- **P2f Personlig økonomi:** `DORMANT`, `PARTIAL`. `POST /personal/finance/read` (accounts/balances/transactions) over eksisterende `bank_*` i `personal`-rommet. Ingen verktøy, skriving eller betaling.
- **P2g:** `deriveTimeContext`/`detectTrips` er `BUILT_UNWIRED`. Sesjonskontinuitet er PASS uten bygging (eksisterende SessionService/grants; bevis `modules/core/test/channel-session-authority.test.ts`).
- **Flagg (standard):**
  - AV: `JARVIS_PERSONAL_{HOME_CRITICAL,CAR,FAMILY,HEALTH_INGEST,FINANCE_READ,APPLE_DAV}`.
  - Tom (fail closed): `_HOME_TARGETS`, `_CAR_TARGETS`, `_APPLE_DAV_ACCOUNTS`.
  - Ventetid: `_HOME_SETTLE_MS` 20000, `_CAR_SETTLE_MS` 60000.
  - Vault-refs: `_HOME_ALARM_CODE`, `_CAR_CREDENTIAL`, `_APPLE_DAV_USER`/`_APP_PASSWORD`.
  - `_CONTEXT` er reservert uten effekt.
  - Alle står i `SERVICE_ENV.api` og regenerert compose. Migrasjoner 125–128 (129–132 ubrukt).

**D-41-revisjon (kort; full tabell i runbook §2–§7)**

| Del | Leverandør tilbyr / verifisert | Bygget | Klasse | Eier/delegert |
|---|---|---|---|---|
| HA | REST states/services, verifisert mot HA-dok.; ett langlivet token uten scope-deling | 8 mutasjoner + lesing | D (lesing A) | kun eier, ingen modellflate |
| Bil | `unverified` (ingen leverandør) | kontrakt + 4 + lesing, falsk | D | kun eier |
| Apple Health | kun HealthKit på enhet, verifisert | kun serverside | – | egen person |
| iCloud DAV | app-passord (krever 2FA); CalDAV/CardDAV uten E2E. Kun søkesammendrag (support.apple.com er ikke tilgjengelig herfra); endepunkter/dialekt `unverified`. Oppgraderte Reminders trolig IKKE over CalDAV (BusyCal/2Do) | CRUD for 3 slag | les A, endre B, slett C (alle step-up) | kun eier |
| Neonomics | `unverified` (D-111 gjelder) | kun lesing av egen kopi | A (begrenset) | kun eier |

Ingen ny connector i `CONNECTOR_REGISTRY`; `SKELETON_BASELINE` er urørt.

**DEFERRED / BLOCKED_EXTERNAL**
- Q-60 lokalagent: ikke bygget.
- iPhone/Watch-app og transportvei; bil-leverandør (D-64); live iCloud og app-passord; EventKit.
- DAV: samtaleverktøy, gjentakende serier, iTIP, oppdagelse, UID-oppslag når filnavn ≠ `<uid>.ics`.
- Helse: overlapp for kumulative prøver, retensjonsrute, egen helse i samtale.
- Familie: provisjonerings-CLI og verge-tilgang.
- Økonomi: personlig bankkobling (`NOT VERIFIED`) og samtale-tilgang (Q-64/Q-66).
- Autonomi-unntak (Q-G2-1) og journal-retensjon.

**Testbevis (HEAD `d91d2197`)**
- `pnpm -r run typecheck` exit 0; `pnpm lint` exit 0; `pnpm check:containment` OK.
- gitleaks over 11 commits: `no leaks found`.
- Målrettet som postgres-bruker: 19 WP-G2-filer, 277 tester grønne (tool-gateway 128, context+erasure+health 52, api 97).
- Vaktbatch (207 filer, 3104 tester) fant 2 regresjoner fra meg: `d436-guarded-fetch-coverage` (rå `fetch`) og `wpk-call-signal` E. Begge er rettet i koden, ingen vakt er svekket. Re-kjøring av `modules/tool-gateway/test`: 1968 av 1971 grønne, kun F10a–c røde.
- **Full suite** (én gang, under flock, `--exclude embedded-postgres-ipv4-contention*`, logg `/tmp/lead/logs/g2-full-suite.log`): 890 filer, 15287 tester; 887 filer og 15282 tester grønne.
- De 5 røde er kjente sandkasse-feil: `wpc3-review1-hardening` F10a/b/c, `break-glass-guard` .gitignore, `nas-ua0-gate` «friskt system».
- `wph1`/`wph2`-baselinene, manifest-vakten, D-420, `d395`-erasure, schema-invarianter og env-drift er grønne uten fixture-endring.

**Sikkerhetsflater for uavhengig review (fil:linje)**
- **D-kjede og mål-allowlist:**
  - `modules/tool-gateway/src/personal/critical-ops.ts:76` (fabrikk)
  - `home-critical.ts:76,157`
  - `home-critical-transport.ts:35`
  - `car-critical.ts:46,145`
- **Utførelse/journal:**
  - `action-executor.ts:85`
  - `action-journal.ts:70`
  - `modules/core/src/db/migrations/125_personal_action_journal.sql:43,75,81`
- **Rute-porter:** `apps/api/src/personal-routes.ts:78` (dispatch), `:102` (`healthIntakeDenial`), `:227–236` (familie step-up), `:260–277` (eier, så step-up på mutate).
- **Familieautoritet:**
  - `modules/context/src/family/service.ts:353,411,456`
  - `permissions.ts:26`
  - `126_family_circle.sql:110,150`
  - Usikker: datatenant-pekeren har ingen FK (scope-FK-baselinen forbyr kryss-tenant-FK) og verifiseres i tjenesten.
- **Helse:** `modules/health/src/intake.ts:66`, `validation.ts:11`, mig. 128.
- **Økonomi:** `apps/api/src/personal-finance-read.ts:57`.
- **DAV:**
  - `modules/tool-gateway/src/personal/apple-dav.ts:42,54` (allowlist), `:137,216` (injeksjon, ingen datatap), `:368` (href-SSRF), `:543,572` (tak, `guardedFetch`, redirect).
  - `apps/api/src/personal-dav.ts:66–97` (eier, step-up, revisjon før, utførelse, revisjon etter).
- **Wiring:** `apps/api/src/personal-wiring.ts:56` (flagg-gating; eksekutor bygges etter at alle domener er registrert) og én linje i `apps/api/src/main.ts`.
- **Usikkerhet:** readback og UNKNOWN-håndtering er kun bevist mot fakes (HA, bil og DAV). Flertenant-lekkasje er testet mot embedded Postgres, ikke mot et ekte oppsett.

**D-464 (oppdatert tekst)**
D-464 (WP-G2, UA-8 Personal Digital Twin, resterende deler; byggepausen opphevet i D-470): BYGGET som `DORMANT`/`NOT VERIFIED` på `claude/wp-g2-personal` (mig. 125–128, ingen ny connector). Kritiske HA-handlinger (8) er klasse D med eierens mål-allowlist, readback av faktisk sluttilstand og journal. Bil går via leverandørnøytral `CarAdapter` uten valgt leverandør (D-64). Familie/delte rom er et eget autoritetslag i en dedikert sirkel-tenant (Q-15), der deling kun kan gis av subjektet og barn aldri deler helse. Helse-inntak (10 lukkede metrikker), Apple CalDAV/CardDAV og personlig økonomi-lesing er KUN eier-/enhetssignerte ruter, aldri verktøy (Q-64/Q-66 er fortsatt åpne for samtale-tilgang). Kontekstavledninger er rene funksjoner (`BUILT_UNWIRED`), og sesjonskontinuitet er PASS med eksisterende tjenester. Alt ligger bak `JARVIS_PERSONAL_*` (AV), og strengeste step-up (Q-55/D-468) er uendret uten autonomi-unntak. Konsekvens: ingenting er `VERIFIED`. Live krever eierens enhet, konto eller leverandørvalg. Q-60, verge-tilgang, provisjonerings-CLI og samtaleverktøy er ikke bygget.

**Lukkingsmatrise UA-8 (forslag) og NAS**
- Bygget (`DORMANT`/`NOT VERIFIED`): kritiske hjemmehandlinger, falsk bil-adapter, familie/delte rom (`PARTIAL`), helse-inntak, Apple DAV (falsk server), økonomi-lesing, kontekstfunksjoner (`BUILT_UNWIRED`), sesjonskontinuitet PASS.
- Gjenstår: Q-60, iPhone/Watch-app, bil-leverandør, live iCloud/EventKit, personlig bankkobling, provisjonering/verge, samtale-tilgang til helse/økonomi. Gate: fysisk iPhone/Watch/bil + Q-G2-1..7.
- NAS-verifisering steg for steg (alt `NOT VERIFIED`): runbook §10, steg 1–7.

**Eierspørsmål** (full tekst med anbefaling i runbook §12)
- **Q-G2-1:** autonome bindinger for kun risikoreduserende handlinger? Anbefaling: ja via navngitt D-beslutning per handling; aldri opplåsing/åpning/avarmering.
- **Q-G2-2:** bil-leverandør? Anbefaling: bilmerkets eget API først; et aggregat-API er `CORE_DEPENDENCY_DECISION_REQUIRED`.
- **Q-G2-3:** sirkel-tenant, provisjonerings-CLI, verge-tilgang og rettslig grunnlag for barn? Anbefaling: dedikert tenant; ingen deling av barns helse før juridisk vurdering.
- **Q-G2-4:** transportvei og retensjon for helse-inntak? Anbefaling: egen tunnel, ingen tredjepartsrelé, 365 dager.
- **Q-G2-5:** tenant/samtykke for personlig bankkobling og utførelseslås for begrensede verktøy? Anbefaling: bruk ruten nå; bygg lås + N1-merking før samtale-tilgang.
- **Q-G2-6:** iCloud (databehandler) eller selv-hostet CalDAV på NAS-en, og påminnelser? Anbefaling: test mot egen test-Apple-ID eller selv-hostet server; utvid PROCESSOR_REGION_MATRIX og DPIA før live; påminnelser via EventKit.
- **Q-G2-7:** retensjon for journal og samtykke-poster? Anbefaling: 12 måneder for journal; samtykke-poster beholdes til sirkelen/personen slettes.

**Avvik fra briefen**
- «private-rommet» er tolket som `personal` (det finnes ikke et rom som heter private).
- Familie er en dedikert sirkel-tenant, et designvalg.
- `JARVIS_PERSONAL_CONTEXT` er reservert uten effekt.
- Apples hjelpesider kunne ikke hentes (verten er ikke i sandkassens nett); iCloud-revisjonen bygger på søkesammendrag.
- `pnpm-lock.yaml` er håndredigert for `@jarvis/context` som apps/api-avhengighet. Frakoblet `pnpm install --frozen-lockfile` feiler på en urelatert manglende tarball. Verifiser med `pnpm install --frozen-lockfile` på en maskin med nett.
- Ingen vakt er svekket eller utvidet.

Dokumenter (absolutte stier):
- `/home/user/jarvisbuild/.claude/worktrees/agent-a02e8e7b2fb1d34c4/docs/runbooks/WPG2_PERSONAL.md`
- `/home/user/jarvisbuild/.claude/worktrees/agent-a02e8e7b2fb1d34c4/docs/UA8_PERSONAL_TWIN_DPIA.md` (§9)
- `/home/user/jarvisbuild/.claude/worktrees/agent-a02e8e7b2fb1d34c4/docs/security/PROCESSING_INVENTORY.md`
