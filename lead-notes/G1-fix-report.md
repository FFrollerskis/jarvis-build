TS: 2026-11-19T00:16:43.664Z
WP-G1 (D-463) fiks-runden er ferdig, og alle HIGH- og MEDIUM-funnene er rettet (B-M4 bare delvis). Grenen er ikke pushet: ett forsøk ga 503.

**HEAD:** `d79b0434` på `claude/wp-g1-comms`. Det er 19 commits over `4b2dfce7` (43 filer, +2775/−302), og arbeidsmappen er ren. Basegrenen er urørt. Push-forsøket svarte «credential service temporarily unavailable». Alt ligger lokalt, ingen PR er opprettet.

## Funn
Hvert funn har en test som feller gammel kode. Mutasjonsbeviset (koden satt tilbake og testen sett rød) står i hver commit-melding.

**LUKKET**
- **A-H1** `2ebf0945`: sju lese-handlinger fikk effekt «write» og stoppet oppstart (`EFFECT_OVERRIDES`). Test `manifest-all-flags` bygger manifestet for alle 16 flaggkombinasjoner.
- **A-H2** `63261ccb`: ratetak er atomiske (to advisory-låser, ny telling og INSERT i én transaksjon). Test `caps-atomic` med ekte `Promise.all`; mutantene uten lås, uten ny telling, 24 t-vindu og ACTIVE_STATUSES feller den.
- **B-H1** `5cde9c9e`: `contacts_sync` binder aldri til en annen kontakts identitet, og ny `contacts_unlink` kan angres med `restore`. Test `contacts`.
- **B-H2** `91581bc3`: STOP og dedupe skrives i én transaksjon, og lange hendelsesnøkler hashes. Test `stop-atomic`.
- **A-M1, L3, L4** `81bee4d5`: WhatsApp-lyd sender AI-opplysningen som egen tekstmelding først. Media-URL må være kanonisk, og TwiML har `voice` og avviser XML-ugyldige tegn. Tester `disclosure-media` og `adapters-extra`.
- **A-M2** `a3977c1f`: `purpose_basis` for kald mottaker (se lederavgjørelser). Test `purpose-basis`.
- **A-M3 og A-M7** `ca44cbc9`: tenant-bred STOP (se lederavgjørelser). Test `stop-scope`.
- **A-M4 og A-M5** `27203ef6`: journalfeil etter akseptert sending blir `outcome_unknown`, og idempotensnøkkelen er bundet til forespørselens fingeravtrykk. Test `outbound-integrity`.
- **A-M6** `2ed4f6a5`: `edit_message` har levende preflight, og reklameord-regelen gjelder også redigering. Test `outbound-integrity`.
- **B-M1** `3bdc9dfa`: `contacts_update` endrer bare oppgitte felt (lese-endre-skriv på fersk kontakt). Test `contacts`.
- **B-M2** `987cbb03`: reply-sveipet roterer, tar kjente avsendere først, maks 10 per kanal og 8 ukjente. Test `reply-sweep`.
- **B-M3** `6a9b6c6a`: `meeting_delete` har minimal preflight (`{exists, meeting_id}`), og full lesing er ny `meeting_get`. Test `meetings`.
- **B-M5** `6016f676`: per-IP-grensen nøkles på normalisert sti, også eksisterende `AUTH_ROUTES`. Test i `wpg1-comms-routes` med rå `node:http`.
- **B-M6** `1e8e1c83`: retensjonssveipet kjører ved oppstart og validerer webhook-tenanten. Tester `retention` og `wpg1-comms-routes`.
- **LOW** `99a6d408` og `208d2f4f`:
  - rom-sjekk i rute-laget
  - samme konto i to rom gir ryddig feil
  - WhatsApp-knappsvar leses
  - samtidig møte-ingest gir dedupe
  - de seks overlevende mutantene fra A er drept
  - tom hemmelighet gir 503
  - `.env.example` rettet
  - `contacts_search` sender oppvarmingskall (verifisert via søk)

**DELVIS**
- **B-M4** `7f122bed`: møteutdraget rammes inn som ubetrodd sitat i oppfølgingen. Proveniensfelt på `business_followups` og `identity.display_name` er DEFERRED, siden det trenger migrasjon og Business-endring.

**ÅPEN** (bevisst, listet i `docs/runbooks/WPG1_COMMS.md` §10)
- DB-trigger sjekker ikke `source` ved løfting av en eier-registrert avmelding. DELETE-grant og rom-CHECK mangler også. Alt dette trenger migrasjon.
- Usaltet innholds-hash.
- `identity_link` teller som relasjonsbevis uansett `match_method`.
- Ratetak er per memory space, ikke på tvers av rom.
- Europe/Oslo uten helligdager, land- eller nummertypeliste.
- Slack `ok:false` med `fatal_error` er tvetydig.
- L5: policy-avslag regexes som `auth_failed` i connector-helse (delt kode).
- Twilio-gjenspilling etter 30 dager (ingen signert tidsstempel).
- Konfliktforslag for kontakter lagres ikke.
- UVERIFISERT: WhatsApp-knappfelt og `Polly.Liv`-stemmen.

## Lederavgjørelser bygget
1. **`purpose_basis`:** en kald mottaker (ingen innkommende siste 7 dager og ingen løst identitet) krever en lukket liste på fem verdier og valgfritt notat (maks 200 tegn).
   - Gjelder også AI-samtale.
   - Mangler det, feiler sendingen lukket med `purpose_basis_required`.
   - Grunnlaget journalføres i `recipient_proof` og står i eier-varselet.
   - Det er formulert som lovens påvisbarhetskrav (mfl. §15), ikke som eier-sperre. Reklameord blokkerer uansett grunnlag.
2. **STOP tenant-bred:** nøkkelen er tenant, navnerom og identifikator. Navnerommet `tel` dekker sms, whatsapp og phone, og registeret leses på tvers av kontoer og rom.
   - Innkommende STOP til ikke-autorisert konto registreres.
   - `record_opt_out` validerer `account_ref` og registrerer alltid tenant-bredt, aldri som stille no-op.
3. **B-H1:** konflikt gir hopp over og `contacts_conflict`. Ny klasse C `contacts_unlink` med `restore`. Rollback-tekst og DPIA §10.5 er rettet.

**Avvik og valg**
- START opphever kun SAMME kanal, og kun avmeldinger registrert av stopp-ord eller leverandørfeil. Du spesifiserte ikke START, så jeg valgte det konservative.
- Konflikter rapporteres i synk-resultatet, men lagres ikke som forslag.
- Ingen ny migrasjon, for å unngå nummerkollisjon ved integrasjon.
- Ratetak er per rom.

## Tester og kommandoer
Alt kjørt som `postgres` med `HOME=/tmp/pg-home`, maks 2 workers.
- **Målrettet** (comms, graf, rute, erasure): 24 filer / 325 tester grønne. Comms-modulen har 21 filer / 275 tester.
- **Vaktbatch** (env-drift, wph1/wph2, part3-manifest, model-surface, connector-registry, connector-sdk-vakt, compose-isolasjon, schema-invariants, inventar, erasure/*, ruter): 28 filer / 303 tester grønne.
- **Typecheck** `pnpm -r --workspace-concurrency=2 run typecheck`: 35 av 36 prosjekter, exit 0.
- **Lint** `pnpm lint`: exit 0.
- **Containment** `pnpm check:containment`: holder.
- **Gitleaks** `4b2dfce7..HEAD`: 19 commits, ingen funn.
- **Full suite** (én gang, flock, uten `embedded-postgres-ipv4-contention*` som i runde 1; logg `/tmp/lead/logs/g1-fix-full-suite.log`): 862 filer, 14 561 tester, 14 555 grønne og 6 røde.
  - Fem er de kjente sandkasse-feilene: `wpc3-review1-hardening` F10a/b/c, `break-glass-guard` og `nas-ua0-gate` «friskt system».
  - Den sjette er `modules/incidents/test/repair.test.ts` («B: INGEN completed…»), som feilet med ENOTEMPTY på rmdir av `/tmp/jarvis-job-*` under last. Kjørt alene på samme HEAD ble den 4/4 grønn, og grenen rører ikke modulen.
  - Ingen kode eller docs er endret etter suiten.

## Oppdatert D-463-tekst (kun endringer)
«En felles deterministisk utgående policy står foran hver NY (`comms.*`) utsendelse (de eldre `twilio/telnyx/whatsapp/slack/discord.notify` omgår den, DEFERRED), med mottakerens eget TENANT-BREDE STOP-register (per normalisert identifikator på tvers av kontoer, rom og kanaler som deler nummer; START gjelder kun samme kanal), eierens erklærte `purpose_basis` for første kontakt med kald mottaker (fail-closed, journalført, ingen godkjenningssperre), atomiske ratetak og forespørselsbundet idempotensnøkkel. Google Contacts lenker aldri stille mellom personer (konflikt hoppes over, reversibel `contacts_unlink`). Godtatte møteforpliktelser innrammes som ubetrodd utdrag (DELVIS: proveniensfelt DEFERRED).» Regel 4 for innkommende hendelser betyr kilde og `ingest_id`, ikke person eller sesjon.

## Nye eierspørsmål (med anbefaling)
1. **`purpose_basis`:** er de fem verdiene riktig liste, og holder en eier-erklæring som påvisbarhet? Anbefaling: behold fail-closed, og la en jurist gå gjennom listen mot mfl. §15 før noe flagg slås på.
2. **Tenant-bred STOP:** skal START på én kanal løfte hele navnerommet (SMS-START åpner WhatsApp)? Anbefaling: nei (dagens regel). En eier-registrert STOP kan aldri løftes av mottaker.
3. **Kontakter:** lagre konfliktforslag, og la `contact_sync`-lenker ikke telle som relasjonsbevis («varm») for første kontakt? Anbefaling: ja til begge i en oppfølger. I dag regnes en lenket kontakt som kjent.
4. **Proveniensfelt og samlemigrasjon:** trigger-source, saltet innholds-hash, DELETE-grants og rom-CHECK. Anbefaling: én migrasjon i neste integrasjonsvindu.
5. **Eldre `*.notify`-verktøy under policyen:** egen D-beslutning. Anbefaling: ja, de omgår STOP og tak i dag.
6. **Verifiser i sandbox:** WhatsApp-knappfelt og `Polly.Liv`-stemmen (runbook §6).

Dokumentasjonen (runbook §10, DPIA §10.2–10.7 og behandlingsoversikten) er oppdatert i `d79b0434`. Delte docs er ikke rørt.
- `/home/user/jarvisbuild/.claude/worktrees/agent-aea9aa2c106dc3965/docs/runbooks/WPG1_COMMS.md`
- `/home/user/jarvisbuild/.claude/worktrees/agent-aea9aa2c106dc3965/docs/UA7_COMMUNICATIONS_DPIA.md`
- `/home/user/jarvisbuild/.claude/worktrees/agent-aea9aa2c106dc3965/docs/security/PROCESSING_INVENTORY.md`
