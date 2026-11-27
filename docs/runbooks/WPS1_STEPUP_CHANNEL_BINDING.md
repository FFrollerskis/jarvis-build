# WP-S1 (D-497, JARVIS-111, Q-71): server-side kanalbinding for step-up (runbook)

**Status: `DORMANT` for håndhevelsen (`enforce` slås på kun av eieren med `JARVIS_STEPUP_CHANNEL_BINDING=enforce`; standard er `observe`, som er atferdsidentisk med main pluss revisjonsrader) og `NOT_VERIFIED`** (ingenting er kjørt mot en ekte NAS, en ekte iPhone/Watch/Mac eller et ekte nettleser-/talegateway-oppsett; alt er bevist mot ekte embedded Postgres, ekte HTTP-ruter og kildevakter lokalt).

Ordforråd (kun disse brukes): `WIRED`, `DORMANT`, `BUILT_UNWIRED`, `PARTIAL`, `DEFERRED`, `BLOCKED_EXTERNAL`, `NOT_BUILT`, `NOT_VERIFIED`. Ingenting her er `VERIFIED`: det krever et kjørt artefakt fra eierens NAS (§11).

## 0. Hva er bygget (K1-K6)

| Krav | Hva | Status | Hvor |
|---|---|---|---|
| K1 | Lukket enhetstype (`devices.device_kind`) + kilde (`device_kind_source`), expand/contract, backfill fra gammel etikett, revisjon, databasevakt | `WIRED` (migrasjon 149; `NOT_VERIFIED` på NAS) | `modules/core/src/db/migrations/149_device_kind_channel_binding.sql` |
| K2 | Håndhevelse i den delte autorisasjonskjernen: typen leses under SAMME radlås som nøkkelen; `observe`/`enforce`; revisjon; dybdeforsvar i `SessionGrantService.verify()` | `WIRED` i `observe` (standard, aktiv); `enforce` `DORMANT` | `modules/core/src/services/device-authority.ts`, `session-grant-service.ts`, `device-service.ts` (`lockDeviceKeyOn`) |
| K3 | Innrulling: billetten bærer typen; klienten kan ikke velge/endre den; typeendring kun via billett; regel R-B mot lav->høy re-nøkling; re-innrullingsvei for `legacy_unknown` | `WIRED` | `modules/core/src/services/device-enrollment-service.ts`, `apps/api/src/enroll-ticket-main.ts`, `ops/nas/enroll-device.sh` |
| K4 | Fail-closed flaggkobling: høyrisiko-flaggene har INGEN effekt uten `enforce`, med årsaken `stepup_binding_not_enforced` i status og logg | `WIRED` (virker i `observe`, altså som standard) | `packages/contracts/src/stepup-binding.ts`, `apps/api/src/main.ts`, `apps/api/src/server.ts` (`/infra/status`) |
| K5 | Tester (alle kanal x type-kombinasjoner, ende-til-ende i begge moduser, samtidighet, mutanter) | Se §10 | `modules/core/test/wps1-*`, `apps/api/test/wps1-*`, `packages/contracts/test/*` |
| K6 | Dette dokumentet | ferdig | `docs/runbooks/WPS1_STEPUP_CHANNEL_BINDING.md` |

Ikke bygget (bevisst, byggeordren): per-kanal nøkkelpar (alternativ C), ny autentiseringsleverandør, org-/medlemskapsendringer, `.github/`. Ingen ny leverandør eller bibliotek (Ed25519-enhetsnøklene er Jarvis-eide og uendret): `CORE_DEPENDENCY_DECISION_REQUIRED=false`.

## 1. Problemet og løsningen i korte trekk

`POST /session/authorize` tok `channel` fra klienten og ga `auth_strength: "signed"` til enhver gyldig enhetssignatur, uansett kanal. Step-up (`ownerStepUpDenial`) godtar `signed` fra `web`, `desktop`, `api` og `mobile`. En innrullert lavtillits-enhet (klokke, talegateway, Telegram-bro) med en gyldig nøkkel kunne dermed PÅSTÅ `web` og få en økt som oppfyller step-up for kritiske hjem-/bilhandlinger, pengekjeden, skymål, hendelsesabonnementet og eierkontrollene.

Løsningen er at **serveren, ikke klienten, bestemmer hvilke kanaler en enhet kan få en økt for**:

1. Hver enhet har en **lukket type** (`device_kind`) som KUN serveren setter, fra innrullingsbilletten eieren utsteder.
2. En server-side tabell (`DEVICE_KIND_CHANNELS`, ÉN kilde i `packages/contracts/src/device-kind.ts`) sier hvilke kanaler en type kan autorisere.
3. `authorizeProvenDevice` (delt av `/session/authorize` og `/voice/session/authorize`) leser typen under SAMME `FOR UPDATE`-lås som nøkkelfingeravtrykket og **nekter** en kanal som ikke hører til typen (`channel_not_allowed_for_device_kind`, aldri en stille nedgradering), uten å røre sesjon eller grant.
4. `OWNER_STEP_UP_CHANNELS` forblir en egen regel: kanal -> step-up er POLICY, type -> kanal er AUTORISASJON, og de to komponerer. Konstanten er flyttet til `@jarvis/contracts` og re-eksporteres uendret fra `@jarvis/tool-gateway` (samme navn, samme mengde).

## 2. Mappingen enhetstype -> tillatte kanaler (D-497 pkt 1, med kodebevis)

| Type | Kanaler | Step-up-kanal? | Begrunnelse (kodebevis) |
|---|---|---|---|
| `iphone` | `mobile` | ja (`mobile`) | iOS-appen ber om `mobile` (`apps/mobile/Sources/JarvisiOS/JarvisApp.swift`) |
| `mac`, `windows` | `desktop` | ja (`desktop`) | `ChannelSchema` har `desktop` (D-292); ingen desktop-klient finnes i repoet ennå (typene er reservert for den: `DEFERRED`) |
| `web_browser` | `web`, `voice` | ja (`web`) | `dashboard.html`/`index.html`/`control.html` bruker `web`; **`voice.html` beviser SAMME enhetsnøkkel mot talegatewayen** (`/voice/session/authorize`, kanal `voice`) - uten `voice` ville taleflaten i nettleseren slutte å virke i `enforce`. `voice` oppfyller aldri step-up og er en smalere flate enn `web`, så en høytillits-type som i tillegg kan velge `voice` gir ingen eskalering |
| `watch` | `watch` | nei | `apps/mobile/Sources/JarvisWatch/WatchApp.swift` |
| `voice_gateway` | `voice` | nei | `apps/voice-gateway/src/server.ts` kaller `/voice/session/authorize` |
| `telegram_gateway` | `telegram` | nei | reservert for en bro med enhetsnøkkel; dagens Telegram-vei (`modules/core/src/services/telegram-owner-authority.ts`) bruker ikke enhetsbevis og er urørt |
| `api_client` | `api` | ja (`api`) | eierens egne skript/CLI-klienter (flater som `docs/runbooks/FINANCE_D_CHAIN.md` henter grant via `/session/authorize`) |
| `service` | `system` | nei | `system` er aldri step-up; jobb-/tjeneste-identiteter (`systemIdentity`) |
| `legacy_unknown` | alle kanaler UNNTATT `web`, `desktop`, `api`, `mobile` (altså `watch`, `voice`, `system`, `telegram`, `slack`, `discord`, `twilio`) | **aldri** | dagens oppførsel for kanaler som ikke er step-up, men aldri en økt som oppfyller step-up før enheten er innrullert på nytt med en type (D-497 pkt 3) |

**Invariant (låst av `packages/contracts/test/device-kind.test.ts`):** ingen type med en lavtillits-rolle (`watch`, `voice_gateway`, `telegram_gateway`, `service`) har en step-up-kanal, og `legacy_unknown` har ingen. En ny (type, kanal)-kombinasjon må inn i tabellen OG i testens eksplisitte forventningstabell; en endring feller testen.

Avvik fra byggeordrens utgangspunkt (begrunnet over, forslag til D-tekst i rapporten): (a) `web_browser` har `voice` i tillegg til `web`; (b) `slack`/`discord`/`twilio` tillates av INGEN lukket type (ingen kodevei bruker dem med enhetsbevis; de er transporter, D-292/D-294/D-295), bare av `legacy_unknown` (dagens oppførsel).

Fail-closed: en type eller kanal som ikke står i de lukkede listene (f.eks. en verdi lest fra databasen som ikke skulle kunne stå der) er ALDRI tillatt (`channelAllowedForDeviceKind`).

## 3. Modus og den fail-closed flaggkoblingen (D-497 pkt 4)

`JARVIS_STEPUP_CHANNEL_BINDING` (kun api-containeren leser den; `infra/local/service-env.mjs`, `.env.example`):

| Verdi | Virkning |
|---|---|
| usatt / tom / `observe` (STANDARD) | Atferden er identisk med main: ingen kanal nektes. Der `enforce` ville nektet, skrives revisjonsraden `identity.channel_binding_would_deny` (`decision` `ALLOW`). Høyrisiko-flaggene under har INGEN effekt (se under) |
| `enforce` | En kanal som ikke hører til typen nektes (`403 {ok:false, reason:"channel_not_allowed_for_device_kind"}`), revidert som `identity.denied`. Høyrisiko-flaggene virker som før |
| alt annet (`enforced`, `ENFORCE`, ` enforce`, `on`, `true`, ...) | Behandles som `observe` OG meldes som `invalid_value` i status. Aldri `enforce` ved en feiltolkning; oppstarten krasjer ikke. Dette er trygt fordi flaggene under bare får effekt i `enforce`: en skrivefeil kan aldri skru noe PÅ |

**Flaggene som er koblet (verifisert mot koden; en vakttest feller en ny/utelatt flagg):**

| Gruppe | Flagg | Kilde i koden |
|---|---|---|
| `personal` | `JARVIS_PERSONAL_HOME_CRITICAL`, `JARVIS_PERSONAL_CAR`, `JARVIS_PERSONAL_FAMILY`, `JARVIS_PERSONAL_HEALTH_INGEST`, `JARVIS_PERSONAL_APPLE_DAV`, `JARVIS_PERSONAL_FINANCE_READ`, `JARVIS_PERSONAL_CONTEXT` | `modules/tool-gateway/src/personal/flags.ts` |
| `growth_write` | `JARVIS_GROWTH_WRITE_PLATFORMS` (liste) | `modules/growth/src/write/config.ts` |
| `comms_outbound` | `JARVIS_COMMS_OUTBOUND`, `JARVIS_COMMS_VENDOR_READS`, `JARVIS_COMMS_CALLS`, `JARVIS_COMMS_CONTACTS`, `JARVIS_COMMS_MEETINGS` (de fire siste krever den første, ellers stopper oppstarten) | `modules/comms/src/config.ts` |
| `situation_signals` | `JARVIS_SITUATION_SIGNALS` (hovedbryteren; underflaggene gjelder kun under den) | `modules/situations/src/flags.ts` |

Uten `enforce` fjernes disse fra den EFFEKTIVE miljø-kopien (`applyStepUpBindingGate`) FØR de fire flaggfamiliene leser den (`apps/api/src/main.ts` gir aldri `process.env` til dem; en kildevakt låser det). Hvert flagg eieren faktisk hadde slått på meldes med årsaken **`stepup_binding_not_enforced`**:

* i oppstartsloggen (`{"msg":"stepup_channel_binding", mode, enforced, invalid_value, blocked:[{flag, group, reason}]}`; skrives når modus er `enforce`, ved blokkerte flagg eller ugyldig verdi), og
* i `POST /infra/status` (grant-autentisert; KUN for den suverene eieren) som feltet `stepup_binding`.

Ingen krasj og ingen stille suksess: flagget står på, men kapabiliteten finnes ikke, og status sier hvorfor. **VIKTIG ved oppdatering:** har du ALLEREDE slått på noen av flaggene over, slutter de å ha effekt til du har satt `enforce` (de vises som blokkerte). De er AV som standard og anbefalingen (Q-71) har vært å ikke slå dem på før denne pakken, så dette er forventet.

Modusen vises ikke som eget element i et kontrollsenter (kun i `/infra/status`-svaret og loggen; `PARTIAL`). Enhetstype og kilde vises per enhet i kontrollsenteret «Autoritet» (enhetslisten).

## 4. Slik håndheves det (K2)

`authorizeProvenDevice` (`modules/core/src/services/device-authority.ts`), i denne rekkefølgen, alt i ÉN transaksjon:

1. full autorisasjon (`checkAuthorizationOn`);
2. `lockDeviceKeyOn`: `SELECT public_key_pem, device_kind, device_kind_source ... FOR UPDATE` og eksakt treff mot fingerprinten som ble bevist (D-131b);
3. `channelAllowedForDeviceKind(<typen fra den LÅSTE lesingen>, kanal)`. I `enforce` avslås det HER: ingen sesjon, ingen grant, ingen skriving (revisjonsraden `identity.denied` med `{mode, device_kind, channel}` skrives i en egen transaksjon etterpå);
4. først deretter sesjon + grant; i `observe` skrives `identity.channel_binding_would_deny` i samme transaksjon som grantet.

Ingen TOCTOU: en samtidig typeendring eller nøkkelrotasjon for samme enhet serialiseres mot autorisasjonen av radlåsen.

**Dybdeforsvar:** `SessionGrantService.verify()` (som alle grant-baserte ruter går gjennom) nekter i `enforce` et grant hvis kanal ikke lenger hører til enhetens type slik den står NÅ (`channel_not_allowed_for_device_kind`, revidert som `session_grant.denied`). Et grant utstedt i `observe` (eller før en typeendring) slutter dermed å virke umiddelbart når du slår på `enforce`, i stedet for å leve ut de 15 minuttene. I `observe` er `verify()` uendret.

## 5. Innrulling (K3)

**Reglene (alle håndheves i `DeviceEnrollmentService`, ikke i klienten):**

1. Billetten BÆRER typen (`device_enrollment_tickets.device_kind`); eieren velger den med `--kind` når billetten utstedes. `--kind` er **påkrevd uten standard** i CLI-en (`apps/api/src/enroll-ticket-main.ts`; feil -> kode 2 før noe kobles til databasen). Typen valideres mot den lukkede listen UTEN `legacy_unknown`.
2. Klientens `device.kind` er en valgfri, PÅSTÅTT etikett som kun revideres (`claimed_kind`, `claimed_kind_matches` i `device.enrolled`); den kan aldri påvirke typen.
3. `device_proof` (en allerede innrullert enhet vitner for en annen) **endrer aldri typen**: en eksisterende enhet beholder typen og kilden, en NY enhet blir `legacy_unknown` (`unclassified`).
4. **Regel R-B:** en enhet UTEN step-up-kanal kan ikke re-nøkle en ANNEN eksisterende enhet som HAR en (ellers kunne en kompromittert klokke/talegateway overta en iPhone/Mac/nettleser og dermed omgå bindingen). Re-nøkling av seg selv og nye enheter er tillatt. `observe` skriver `device.enrollment_would_deny`; `enforce` nekter med `authorizing_device_kind_not_allowed`.
5. En billett uten type (kun billetter utstedt før migrasjon 149 eller via API uten type) BEVARER en eksisterende enhets type; en ny enhet blir `legacy_unknown`.
6. Å endre typen på en EKSISTERENDE enhet skjer KUN ved å utstede en ny billett med riktig `--kind` og `--device <id>` og rulle enheten inn på nytt. Billett-utstedelsen krever databaseadmin på vertsmaskinen (`migrate`-tjenesten), altså det samme som en break-glass-handling; det finnes ingen HTTP-rute som endrer en type (D-497 pkt 2: «eksisterende step-up eller break-glass» er dermed oppfylt ved den strengere veien).
7. Målraden låses (`FOR UPDATE`) FØR typen bestemmes (lås-rekkefølge billett -> enhetsrad, samme som `FamilyService.endMembership`), en ny enhet skrives som ren innsetting (`insert_only`), og en enhet som ble tilbakekalt i vinduet avslås (`device_revoked`). Ingen vranglås, ingen tapt typeendring.
8. **Databasevakt:** triggeren `devices_kind_guard` avviser enhver UPDATE som endrer `device_kind`/`device_kind_source` uten den transaksjons-lokale variabelen `jarvis.device_kind_change = 'on'`, som kun `DeviceService.registerDeviceOn` setter (og nullstiller rett etter skrivingen), og revideres alltid (`device.kind_changed`). Det er en vakt mot FEIL kodeveier, ikke mot en kompromittert api-prosess (den har allerede skrivetilgang).

**Alle innrullingsveier er dekket** (en kildevakt i `apps/api/test/wps1-stepup-gate-wiring.test.ts` låser at KUN disse skriver `devices`/lager billetter):

| Vei | Hvordan typen settes |
|---|---|
| `POST /devices/register` (`DeviceEnrollmentService.enroll`) | Billetten bærer typen; `device_proof` endrer aldri typen |
| `apps/api/src/enroll-ticket-main.ts` (CLI) | `--kind` påkrevd |
| `ops/nas/enroll-device.sh` (kun nettlesere) | `--kind web_browser` er fast |
| `apps/web` (`index`/`dashboard`/`voice`/`control`) | sender `kind: "web"` som påstått etikett (kun revisjon); typen kommer fra billetten |
| iOS-kontrakt (`apps/mobile`) | sender `kind` som påstått etikett (kun revisjon); hint-tekstene viser `--kind iphone`/`--kind watch`. Swift-koden er IKKE kompilert her (ingen Xcode i miljøet): `NOT_VERIFIED` |
| `apps/api/src/seed.ts` | eksplisitt type med kilden `trusted_provisioning` (`jarvis-core` = `service`, talegateway-enheten = `voice_gateway`, `dev-web` = `web_browser` utenfor produksjon); ingen av seed-radene har en nøkkel og kan derfor ikke autorisere noe |

**Billett per enhetstype (eierens kommando på vertsmaskinen):**

```
# nettleser (dashbord/tale): skriptet setter --kind web_browser selv
ops/nas/enroll-device.sh https://<adressen-nettleseren-bruker> dashboard

# alle andre typer: CLI-en via migrate-tjenesten (den har admin-databasetilgangen)
docker compose --env-file .env -f infra/local/docker-compose.yml run --rm --no-deps migrate \
  node --experimental-transform-types apps/api/src/enroll-ticket-main.ts --kind <iphone|mac|windows|watch|voice_gateway|telegram_gateway|api_client|service|web_browser> [--device <device_id>]
```

Billetten vises kun i terminalen, er engangs og lever 15 minutter. Lim den aldri inn i chat.

## 6. Migrasjon 149 (K1)

* `devices.device_kind` (lukket CHECK: `iphone`, `mac`, `windows`, `web_browser`, `watch`, `voice_gateway`, `telegram_gateway`, `api_client`, `service`, `legacy_unknown`; standard `legacy_unknown`) og `devices.device_kind_source` (`unclassified`, `legacy_label`, `enrollment_ticket`, `trusted_provisioning`; standard `unclassified`) + CHECK-invarianten `legacy_unknown` <=> `unclassified`. `device_enrollment_tickets.device_kind` (standard `legacy_unknown`).
* Expand/contract: den gamle fritekst-`kind` er UENDRET (ingen eksisterende rad eller kode brytes; en rå INSERT uten type blir `legacy_unknown` = minste tillit).
* Backfill (`lower(btrim(kind))`, SAMME avbildning som `deviceKindFromLegacyLabel`; låst av test): `web` -> `web_browser`, `voice` -> `voice_gateway`, og de lukkede navnene selv (`iphone`, `mac`, `windows`, `web_browser`, `watch`, `voice_gateway`, `telegram_gateway`, `api_client`, `service`); ALT annet (`phone`, `pc`, `mobile`, `desktop-agent`, `api`, ...) er tvetydig og blir `legacy_unknown`. Avledede typer får kilden `legacy_label` (= utledet av en gammel, KLIENT-oppgitt etikett; IKKE verifisert av en eier-handling).
* Revisjon: én rad `device.kind_classified` per enhet (`actor_kind=system`, `process=migrate-149`, `legacy_kind` avkortet).
* Eksisterende, ikke-konsumerte billetter blir `legacy_unknown` (billettene lever 15 minutter).
* RLS/erasure: ingen ny tabell; kolonnene ligger på eksisterende tenant-eide tabeller (erasure-/RLS-vaktene er uendret grønne).
* **Rollback-vurdering:** forover-only (migratoren har ingen ned-migrasjoner), men trygg: eldre kode ignorerer kolonnene, og standardverdiene tilfredsstiller CHECK for rader eldre kode skriver. Atferd rulles tilbake ved å sette `JARVIS_STEPUP_CHANNEL_BINDING` tilbake til `observe` (§9).

## 7. Utrullingsrekkefølge (eierhandling; NAS-trinn)

Alle trinn er eierens og `NOT_VERIFIED` til de er kjørt. Test-/akseptanseløp skal bruke en sandbox-tenant og testenheter.

1. **Sikkerhetskopi** etter vanlig rutine. Oppdater koden; `migrate`-tjenesten kjører migrasjon 149. Ingenting endres i atferd (modus `observe`).
2. **List enhetene** (admin-bruker, rå SQL; RLS gjelder ikke for admin):

   ```
   docker compose -f infra/local/docker-compose.yml exec -T postgres psql -U postgres -d jarvis -c \
     "SELECT tenant_id, person_id, device_id, kind AS gammel_etikett, device_kind, device_kind_source, revoked_at IS NOT NULL AS tilbakekalt, created_at
        FROM devices ORDER BY tenant_id, person_id, created_at;"
   ```

   Kontrollsenteret «Autoritet» viser samme (type, kilde, om enheten kan gi step-up).
3. **Gjennomgå hver enhet:** `device_kind_source = 'legacy_label'` er utledet av en gammel, klient-oppgitt etikett: bekreft at typen er riktig. `legacy_unknown`: kan IKKE gi step-up i `enforce`. Hver enhet som skal ha step-up (din iPhone, Mac, nettleser) og hver lavtillits-enhet (Watch, talegateway, Telegram-bro) bør rulles inn på nytt med riktig `--kind` (§5); da får den kilden `enrollment_ticket`. Lavtillits-enheter som står som `legacy_unknown` fungerer videre på sine egne kanaler (`watch`, `voice`, `telegram`, `system`) uten re-innrulling, men kan aldri gi step-up.
4. **Observer** (modus `observe`, standard) i en periode du velger, med alle enhetene i vanlig bruk. Hver rad under er et (enhet, kanal)-par som ville blitt nektet i `enforce`:

   ```
   docker compose -f infra/local/docker-compose.yml exec -T postgres psql -U postgres -d jarvis -c \
     "SELECT device_id, payload->>'device_kind' AS type, payload->>'channel' AS kanal, count(*) AS antall, max(at) AS sist
        FROM audit_events WHERE type = 'identity.channel_binding_would_deny'
       GROUP BY device_id, payload->>'device_kind', payload->>'channel' ORDER BY max(at) DESC;"
   ```

   Null rader i en representativ periode (iPhone, Watch, tale, Telegram, nettleser, skript) = klar. Hver rad fikses ved å rulle enheten inn på nytt med riktig type, eller ved å rette klienten som ber om feil kanal. Se også `device.enrollment_would_deny` (en lavtillits-enhet som ville nektet å re-nøkle en høytillits-enhet).
5. **Slå på håndhevelse:** sett `JARVIS_STEPUP_CHANNEL_BINDING=enforce` i `.env` og start `api` på nytt. Kontroller i `POST /infra/status` (eier) at `stepup_binding.mode` er `enforce` og `blocked` er tom; sjekk oppstartsloggen (`stepup_channel_binding`).
6. **Først deretter** slå på høyrisiko-flaggene du vil ha (§3), ett om gangen, og kontroller `blocked` er tom. De følger egne runbooks (`WPG2_PERSONAL.md`, `WPD3_GROWTH_WRITES.md`, `WPG1_COMMS.md`, `WPG4_SITUATION_BRIDGES.md`).
7. **Aksepttest (sandbox):** rull inn en testenhet med `--kind watch` og forsøk `POST /session/authorize` med `channel: "web"`: forventet `403 channel_not_allowed_for_device_kind`; med `channel: "watch"`: forventet `200`. Gjenta med `--kind web_browser`: `web` og `voice` gir `200`, `mobile` gir `403`.
8. **Ikke lås deg ute:** kontrollhandlinger (kill switch, tilbakekall, frys) krever step-up fra en enhet med en eier-kanal. Ha minst én enhet med riktig type (`web_browser`, `iphone`, `mac` eller `windows`) innrullert FØR `enforce`. Mister du den: vertsmaskinens break-glass (`docs/runbooks/EV0_BREAK_GLASS.md`) og en ny billett (§5) er veien tilbake; `observe` (§9) gjenoppretter dagens atferd umiddelbart.

**Rette en type uten ny innrulling (kun databaseadmin, host-nivå):** transaksjons-lokal tillatelse, og endringen revideres automatisk (`device.kind_changed`):

```
BEGIN;
SELECT set_config('jarvis.device_kind_change', 'on', true);
UPDATE devices SET device_kind = 'iphone', device_kind_source = 'trusted_provisioning'
 WHERE tenant_id = '<tenant>' AND device_id = '<device_id>';
COMMIT;
```

(`legacy_unknown` MÅ ha kilden `unclassified`, alle andre typer en annen kilde; CHECK avviser ellers.) Foretrekk billett-veien: den gir kilden `enrollment_ticket` og rullerer nøkkelen.

## 8. Revisjonshendelser

| Type | Når | `decision` | Nyttelast |
|---|---|---|---|
| `identity.channel_binding_would_deny` | `observe`: kanalen ville blitt nektet i `enforce` | `ALLOW` | `{mode, device_kind, channel}` |
| `identity.denied` (`reason=channel_not_allowed_for_device_kind`) | `enforce`: kanalen nektet | `DENY` | `{mode, device_kind, channel}` |
| `session_grant.denied` (`reason=channel_not_allowed_for_device_kind`) | `enforce`: et eksisterende grant brukt mot en kanal typen ikke tillater | `DENY` | - |
| `device.enrolled` | innrulling lyktes | `ALLOW` | `enrollment_method`, `rotated`, `revoked_grants`, `device_kind`, `device_kind_source`, `previous_device_kind`, `kind_changed`, `source_changed`, `claimed_kind`, `claimed_kind_matches` |
| `device.enrollment_would_deny` | `observe`: regel R-B ville nektet | `ALLOW` | `{mode, authorizing_device_kind, target_device_kind}` |
| `device.enrollment_denied` (`reason=authorizing_device_kind_not_allowed`) | `enforce`: regel R-B nektet | `DENY` | som over |
| `device.kind_classified` | migrasjon 149, én per enhet | `ALLOW` | `{device_kind, device_kind_source, legacy_kind}` |
| `device.kind_changed` | databasevakten: HVER endring av type/kilde, uansett kodevei | `ALLOW` | `{from, to, from_source, to_source}` |

Etiketter fra klienten er ubetrodd tekst: de vises avkortet (maks 40 tegn) og kun med synlig ASCII (`displayKindLabel`). Ingen hemmeligheter og intet nøkkelmateriale skrives.

## 9. Rollback

1. **Atferd:** sett `JARVIS_STEPUP_CHANNEL_BINDING=observe` (eller fjern linjen) og start `api` på nytt. Kanalnektelsen stopper umiddelbart (også for eksisterende grants). Høyrisiko-flaggene blir blokkert igjen (fail-closed) og vises i `blocked`: slå dem av i `.env` hvis de ikke skal stå på.
2. **Kode:** en eldre api-versjon (uten denne pakken) kjører mot skjema 149 uten problemer (§6). Migrasjonen rulles ikke tilbake.
3. **Data:** typene/kildene står urørt og er revisjonsført; en feil type rettes via billett (§5) eller admin-SQL (§7).

## 10. Tester og mutanter (K5)

Alle DB-tester kjører mot ekte embedded Postgres med RLS-app-rolle og MÅ kjøres som OS-bruker `postgres` (maks 2 arbeidere, `timeout -k 5`):

```
su postgres -s /bin/bash -c 'export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=/opt/node22/bin:$PATH NODE_OPTIONS=--max-old-space-size=2048; cd <worktree> && timeout -k 5 900 pnpm exec vitest run --maxWorkers=2 <filer>'
```

| Fil | Dekker |
|---|---|
| `packages/contracts/test/device-kind.test.ts`, `wps1-contracts.test.ts` | hele tabellen type x kanal (110 kombinasjoner), invarianter, fail-closed, etikett-avbildning (samme som SQL), kontrakter |
| `packages/contracts/test/stepup-binding.test.ts` | modusparser, flaggregister, fail-closed port |
| `modules/core/test/wps1-channel-binding.test.ts` | `enforce` for alle 110 kombinasjoner, `observe` identisk med main (alle gir grant) + revisjon, ingen sideeffekt ved avslag, fail-closed, `voice`-autoriteten, TOCTOU/samtidighet |
| `modules/core/test/wps1-grant-verify.test.ts` | `verify()`-dybdeforsvar (110 kombinasjoner), observe uendret, typeendring etter utstedelse |
| `modules/core/test/wps1-enrollment-kind.test.ts` | billetten bærer typen, typeendring kun via billett, `device_proof`-matrisen (10x10), R-B, databasevakten, samtidighet (vranglås/tapt oppdatering/kappløp) |
| `modules/core/test/wps1-migration-149.test.ts` | migrasjon oppover fra main-skjemaet (backfill, CHECK, revisjon, trigger) |
| `modules/tool-gateway/test/wps1-step-up-composition.test.ts` | KUN fem (type, kanal)-par kan oppfylle step-up; G2/F1/E1/G4/eierkontroll nekter fortsatt lavtillits-kanaler |
| `apps/api/test/wps1-session-authorize-e2e.test.ts` | `/session/authorize` og `/voice/session/authorize` ende-til-ende (HTTP + embedded Postgres) i begge moduser, angrepet fra JARVIS-111, innrulling over HTTP |
| `apps/api/test/wps1-stepup-gate-wiring.test.ts` | registeret dekker NØYAKTIG flaggene koden leser, `enforce`/`observe`-effekt, flagg AV ≡ main (differensial mot de rå parserne), `main.ts` gir aldri rå `process.env`, miljø-/compose-vakter, kun innrullingsstien skriver typen |
| `apps/api/test/wps1-enroll-ticket-cli.test.ts`, `wps1-authority-center-device-kind.test.ts` | CLI krever `--kind`; kontrollsenteret viser type/kilde |
| `apps/api/test/remediation-2-control-plane-auth.test.ts` (H3) | `stepup_binding` i `/infra/status` er kun for den suverene eieren |

**Mutanter (120 unike, hver mutant er en enkelt kodeendring som skal felle minst ett test-trinn):** 119 drepte, 1 overlevende som er **ekvivalent**. Mutantene er laget for hånd mot selve sikkerhetsreglene (ikke tilfeldige operatorer), kjørt som egen harness som muterer filen på plass, kjører de relevante testfilene (`--bail=1`) og skriver originalinnholdet tilbake (aldri `git checkout`/`stash`).

| Gruppe | Antall | Hva som muteres | Drept |
|---|---|---|---|
| `DK01`-`DK19` | 19 | `DEVICE_KIND_CHANNELS` (en type får en kanal for mye/lite, `legacy_unknown` får step-up, lavtillits-typer får `web`/`api`), fail-closed (`true` ved ukjent), etikett-avbildningen, billettlisten | 18 (+1 ekvivalent, se under) |
| `SB01`-`SB13`, `LG01`-`LG05` | 18 | modusparser (case/trim/ugyldig verdi = enforce), den fail-closed porten (snudd, flagg fjernes ikke, mangler i registeret, blokkering meldes ikke, delt `process.env`), status og oppstartslogg | 18 |
| `DA01`-`DA12`, `IS01` | 13 | autorisasjonskjernen: håndhever aldri / alltid / feil kanal / konstant type, sideeffekter før avslag, observe-revisjon fjernet / feil `decision` / uten nyttelast, standard `enforce` | 13 |
| `DS01`-`DS10` | 10 | `FOR UPDATE` fjernet (TOCTOU), GUC-tillatelsen (satt tom / aldri nullstilt), kilde, `insert_only`, validering, konstant type | 10 |
| `SG01`-`SG04` | 4 | `verify()`-dybdeforsvaret (av / snudd / uten type / også i observe) | 4 |
| `DE01`-`DE20` | 20 | innrulling: billettens type ignorert, regel R-B (selv-unntak, null-mål, `||`/`&&`, enforce kaster ikke, alltid tillatt), `RETURNING`, `insert_only`, tilbakekalt-i-vinduet, revisjonsfelter, billett uten type nullstiller typen, klientetikett vinner | 20 |
| `RS01`-`RS03`, `MG01`-`MG10` | 13 | kontraktenes årsakskoder og migrasjonen (backfill-avbildning, CHECK-ene, triggeren, revisjonen, standardverdier) | 13 |
| `AP01`-`AP15`, `SD01`-`SD03` | 18 | `main.ts` (rå `process.env` til en flaggfamilie, modus ikke til en tjeneste, porten leser tomt miljø, logg/status skjult), `/infra/status` for ikke-eier, `service-env`, kontrollsenter, billett-CLI, seed-typer | 18 |
| `RB01`-`RB05` | 5 | selve runbooken (mappingtabell, flaggtabell, SQL-kolonne, billettliste, `legacy_unknown`-påstand) | 5 |

Første kjøring (102 mutanter) etterlot 9 overlevende; 8 var testhull og er lukket med nye tester (visningsetikettens avkorting, `describeStepUpBinding`, validering i koden, `device.enrolled`-revisjonen per vei, CHECK-ene og SQL/TS-listene, billett-CLI mot ekte database, oppstartsloggens betingelse) og kontrollert med en ny kjøring.

**Ekvivalent overlevende (`DK16`):** regex-en `^[A-Za-z_]{1,32}$` i `deviceKindFromLegacyLabel` er ren forsvarsdybde. Etter regex-en slås etiketten opp i en LUKKET tabell med rene ASCII-nøkler (maks 16 tegn), så en etikett som slipper gjennom en mer tolerant regex (`^\S{1,32}$`) kan aldri treffe en nøkkel og gir `legacy_unknown` uansett: utfallet er identisk for alle innganger (det finnes ingen Unicode-tegn som blir en ASCII-nøkkel av `toLowerCase()` for de nøklene som finnes). Regex-en beholdes fordi den holder TS-avbildningen byte-lik SQL-avbildningen også om en fremtidig nøkkel skulle inneholde en bokstav med en Unicode-lookalike (f.eks. Kelvin-tegnet); `packages/contracts/test/wps1-labels-status.test.ts` låser dagens oppførsel for lookalike-tegn.

## 11. Kjente begrensninger, `DEFERRED`/`PARTIAL`, `NOT_VERIFIED` og eierhandlinger

* **`NOT_VERIFIED`:** hele rekken er ikke kjørt på NAS, mot en ekte iPhone/Watch/Mac, en ekte nettleser-/talegateway- eller Telegram-bro. Swift-endringene (kommentarer og hint-tekster) er ikke kompilert.
* **Eierhandlinger (NAS):** kjør migrasjonen, list og gjennomgå enhetene (§7), rull inn enhetene på nytt med riktig `--kind`, observer, sett `enforce`, kontroller `/infra/status`, aksepttest i sandbox, deretter høyrisiko-flaggene.
* **Kompromittert enhet med step-up-type:** en kompromittert iPhone/Mac/nettleser er fortsatt eier-nivå (uendret). Bindingen forhindrer at en LAVTILLITS-enhet påstår en eier-kanal; den gjør ikke en eier-enhet mindre mektig. Per-kanal nøkkelpar (alternativ C) er `NOT_BUILT`.
* **En enhet har én type:** en `web_browser` kan velge `web` eller `voice` fritt (begge er bundet til samme nøkkel). `voice` oppfyller aldri step-up, så ingen eskalering, men en nettleser-enhet kan også starte tale-økter uten å bytte nøkkel.
* **`slack`/`discord`/`twilio`:** ingen lukket type tillater dem; bare `legacy_unknown` beholder dem (dagens oppførsel). Ingen kodevei bruker dem med enhetsbevis. Egne typer er `DEFERRED` til en slik vei finnes.
* **`mac`/`windows`/`telegram_gateway`/`api_client`:** typene og kanalene er bygget og testet, men ingen førstepartsklient i repoet bruker dem ennå (desktop-agent, Telegram-bro med enhetsnøkkel, eier-skript): `BUILT_UNWIRED` på klientsiden.
* **Typeendring via HTTP:** finnes ikke (`DEFERRED`; den strengere host-veien er valgt bevisst, §5 pkt 6).
* **Modusvisning i UI:** `PARTIAL` (kun `/infra/status` og logg; typen vises per enhet i kontrollsenteret).
* **Eksisterende dokumenter** som beskriver «klient-påstått kanal» som åpent forbehold (`WPG2_PERSONAL.md`, UA8-DPIA, `OPEN_QUESTIONS` Q-71, `FINDINGS_LEDGER` JARVIS-111) må oppdateres av den som fører dem etter review.
