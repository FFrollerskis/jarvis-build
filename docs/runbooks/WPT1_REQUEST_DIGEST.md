# WP-T1: forespørselsavtrykk, nøkkelkrav og ledger-avstemming i ToolGateway (JARVIS-102, 103, 105)

**Status (2026-11-26): BYGGET OG TESTET MOT EKTE (embedded) POSTGRES, EKTE LOKALE HTTP-SERVERE OG FAKES - IKKE KJØRT MOT NAS-en, IKKE DEPLOYET, INGENTING ER `VERIFIED`. Alt som kan slås av/på er `DORMANT` (flagg AV).**
Gren `claude/wp-t1-request-digest`. Migrasjoner: **153** (`153_tool_executions_request_digest.sql`) og **154** (`154_tool_executions_reconcile.sql`). `CORE_DEPENDENCY_DECISION_REQUIRED=false` (ingen ny leverandør; D-64 uberørt).
Grunnlag: Q-65 pkt 1 og Q-63 pkt 7 er besvart «ja» (D-496/D-497). Funn: JARVIS-102, JARVIS-103, JARVIS-105 i [FINDINGS_LEDGER.md](../remediation/FINDINGS_LEDGER.md) (denne grenen rører ikke de delte dokumentene; foreslått ny status står i leveranserapporten).

## 1. Oversikt

| Krav | Funn | Hva er bygget | Statusord | Standard |
|---|---|---|---|---|
| K1 | JARVIS-102 | `request_digest`: ÉN delt, testet modul `packages/contracts/src/request-digest.ts` med 14 publiserte testvektorer (§3) | `WIRED` (brukt av gatewayen når modus er `observe`/`enforce`) | modulen har ingen bivirkning |
| K2 | JARVIS-102 | Migrasjon 153: nullbar `tool_executions.request_digest` (format: 64 små hex-tegn). Eldre rader = `NULL` (aldri bakfylt) | `WIRED` (kolonnen finnes; fylles kun når modus ≠ `off`) | `NULL` |
| K3 | JARVIS-102 | `idempotency_key_reuse_mismatch`: samme nøkkel + ulik digest avvises og utføres aldri (§4) | `DORMANT` | `off` = main |
| K4 | JARVIS-102 | `ToolDefinition.idempotency: required / optional / none` + deterministisk liste med begrunnelse + vakttest (§5) | merking `WIRED`, håndhevelse `DORMANT` | `off` = main |
| K5 | JARVIS-103 | Avstemming/utløp av `reserved`/`unverified`, eierens kø og avgjørelse, migrasjon 154 (§6) | `DORMANT` | AV |
| K6 | JARVIS-105 | Infra-journal: ukjent klasse D-utfall = `high`; akseptert-men-uverifisert Docker-utfall = UKJENT (§7) | `WIRED` (ingen flagg: rettelsen gjelder alltid) | PÅ |

Ikke bygget (avgrenset av byggeordren): `real_transport`-bro i connector-SDK, endring av klasse D-godkjenningsprotokollen (utover at digesten kan gjenbrukes), endring av org-/tenant-modellen, ny leverandør.

## 2. Flagg og miljøvariabler

| Variabel | Prosess | Standard | Gyldige verdier | Virkning |
|---|---|---|---|---|
| `JARVIS_TOOL_REQUEST_DIGEST` | api, worker | tom = `off` | `off` / `observe` / `enforce` (store/små bokstaver og mellomrom ignoreres). En ukjent verdi STOPPER oppstarten av api og worker | §4. Leses per kall (gatewayen), og valideres ved oppstart |
| `JARVIS_TOOL_LEDGER_RECONCILE` | api | tom = `off` | `off` / `on`. En ukjent verdi (typo) STOPPER oppstarten av api | slår på det daglige sveipet og rutene `/tool-ledger/queue` og `/tool-ledger/resolve` (§6) |
| `JARVIS_TOOL_LEDGER_RESERVED_TTL_MINUTES` | api | 60 | heltall 15-10080 | alder før en `reserved`-rad regnes som ukjent utfall. Leses/valideres KUN med `on`; ugyldig verdi stopper oppstarten |
| `JARVIS_TOOL_LEDGER_UNVERIFIED_TTL_HOURS` | api | 24 | heltall 2-2160 | alder før en `unverified`-rad krever eierens avgjørelse. Samme valideringsregel |
| `JARVIS_TOOL_LEDGER_RECONCILE_HOUR` | api | 5 | 0-23 | klokkeslett for det daglige sveipet (`DailyScheduler`-jobben `tool-ledger-reconcile`) |

Variablene står i `.env.example` (kommentert, AV), `infra/local/service-env.mjs` og er generert inn i `infra/local/docker-compose.yml`. `JARVIS_TOOL_REQUEST_DIGEST` går til api og worker (begge kjører gatewayen);
de fire ledger-variablene går KUN til api (sveipet og rutene kjører der; worker leser dem ikke). Ingen hemmeligheter.

## 3. Digest-spesifikasjon (versjon 1)

### 3.1 Definisjon

```
body    = { v: 1, tool_id, action, parameters, tenant_id, person_id }
digest  = hex( SHA-256( UTF-8( canonical(body) ) ) )
```

`parameters` er forespørselens parametre UTEN toppnivåfeltet `idempotency_key` og UTEN felt en definisjon har utelatt (`ToolDefinition.digest_exclude_parameters`, kun toppnivå). `idempotency_key` er forespørselens identitet
(retry-korrelasjon), aldri nyttelast. Digesten dekker IKKE `memory_space`, økt, enhet, kanal eller tidspunkt (flyktige). Den dekker tenant og person: samme nøkkel brukt av en annen person i samme tenant er en annen forespørsel.

`canonical(x)`:

- objekter: nøklene sorteres på UTF-16-kodeenheter (ikke locale, ikke kodepunkt), ingen mellomrom; lister beholder rekkefølgen;
- tekst: `JSON.stringify` (kun nødvendig escaping; øvrige tegn står som UTF-8); tall: ECMAScript Number-til-tekst (`1e+21`, `1e-7`, `5e-324`, `-0` blir `0`);
- `null`, `true`, `false`, tom tekst, tom liste og `{}` er alle forskjellige fra fravær; en egenskap som er `undefined` utelates (som `JSON.stringify`).

**ÉN kanonisering.** Serialiseringen er den eksisterende `canonicalStringify` (`packages/contracts/src/canonical.ts`) - den samme som godkjenningenes `parameters_hash` (`hashApprovalParameters`), bekreftelseskortets fingeravtrykk og forretningsloggens
`request_hash`. Den er UENDRET (en endring ville brutt signerte godkjenninger og lagrede hasher). Den nye modulen legger kun til STRENG VALIDERING før serialisering og definisjonen av hva digesten dekker; på det strenge domenet er
`canonicalizeStrict(v) === canonicalStringify(v)` (låst av test over 1000 seedede verdier). `parametersDigest(p)` er eksponert og er lik `hashApprovalParameters(p)` for parametre uten `idempotency_key`. Det er altså én kanonisering og to hash-domener
(parametre alene for godkjenningen, hele forespørselen for ledgeren); en fremtidig Approval v2 (WP-MC7) binder DENNE digesten uten ny kanonisering (ikke bygget her).

### 3.2 Avvisning (fail-closed)

`RequestDigestError` (kode + sti, aldri verdien): `non_finite_number` (NaN, ±Infinity), `cycle`, `too_deep` (dybde over 64), `undefined_in_array` (`undefined` eller hull i lister), `lone_surrogate` (ensomt surrogat i tekst, nøkkel eller identitetsfelt: kan ikke representeres i UTF-8, og dermed ikke hos en annen implementasjon),
`unsupported_type` (bigint, symbol, funksjon, og NØSTEDE ikke-rene verdier: Date, Map, Set, klasseinstanser, accessor-egenskaper og symbolnøkler), `not_plain_object` (selve `parameters` er ikke et rent objekt: liste, null, tekst, tall, Map, Date, klasseinstans; sti `$.parameters`) og `invalid_input` (`tool_id`, `action`, `tenant_id` eller `person_id` er ikke en ikke-tom tekst).
I praksis avviser Policy Gateways skjema (`ToolCallSchema`) NaN, `undefined` i lister og lignende FØR gatewayen (`invalid_tool_call`); digest-avvisningene gjelder det som slipper forbi (Infinity, ensomme surrogater, klasseinstanser, accessorer, dybde over 64).

### 3.3 Unicode og tall (bevisst valg, A-1)

INGEN Unicode-normalisering: NFC- og NFD-formen av samme tekst er ULIKE forespørsler (ulik digest, se `unicode_nfc`/`unicode_nfd`). Begrunnelse: (a) en digest som folder normaliseringsformer avhenger av hver plattforms Unicode-tabeller (en signerende enhet på en annen
versjon kan gi en annen digest for tegn tildelt senere), (b) det som utføres er bytene gatewayen sender - å binde en foldet form ville latt to forskjellige leverandørstrenger (filnavn, adresser) gjelde som «samme godkjenning». Samme valg som RFC 8785.
Konsekvens: en gjentakelse med de SAMME bytene gir alltid samme digest; en omkodet gjentakelse (annen normaliseringsform) avvises som ulik nyttelast. En avsender som vil være normaliseringsuavhengig normaliserer selve forespørselen før den sendes.

### 3.4 Testvektorer

Vektorene er publisert i `REQUEST_DIGEST_TEST_VECTORS` (`packages/contracts/src/request-digest.ts`). `canonical` er HÅNDSKREVET og `digest` er SHA-256 av den over `node:crypto` - ingen av dem er utledet av `requestDigest`; testen
(`packages/contracts/test/request-digest.test.ts`) sammenligner alle tre veier. En annen implementasjon (for eksempel enheten som signerer en Approval v2) skal gi NØYAKTIG disse. Felles inndata for alle unntatt `other_*`, `definition_excluded_field` og `other_tool_action`:
`tool_id=calendar`, `action=create_event`, `tenant_id=tenant-a`, `person_id=person-1`.

| Navn | Hva det viser | SHA-256 (hex) |
|---|---|---|
| `simple` | Sorterte nøkler, ingen mellomrom; UTF-8-tekst står som den er. | `c1e72ee8b353e2e2b3a2cb18b4378c3aa1cd3792c033ffc62431d716102d846e` |
| `empty_parameters` | Ingen parametre: `parameters` er `{}`. | `ea760d0d9c6c716826c311c016205c3e5fd9d7420d3404eb66b4ae7233d50e02` |
| `nested_scrambled_order` | Nøkler i vilkårlig rekkefølge, nøstede objekter og lister (listerekkefølgen bevares), null og boolske verdier. | `dc93af9fb21dd44fb3dc6558f8ade915b1baf062f5901998ba2c8df6d0202833` |
| `idempotency_key_excluded` | `idempotency_key` på toppnivå inngår ikke i digesten. | `983ab0f63f843ed28907fefd9374c04f07dd4ae43901876dae2db371951f5f85` |
| `null_bool_empty` | Tom tekst, tom liste, false og null er alle forskjellige fra fravær. | `e2d475e17c0cbb0da7ee9abddc9cd92b9a71ee12ac1b5594d21e63bdf7ab654b` |
| `other_tool_action` | Annet verktøy (`email`) og annen handling (`send`) gir annen digest. | `9b6525cf8ffb771d78b73b890fd7d9f512d67682d3cf8bc854e57e6c07998220` |
| `other_tenant` | Samme parametre som `simple`, annen tenant (`tenant-b`). | `907d5e6f6e9e6da0059c88ddbe9b563f403e27230acfdb0b337b6c590261f7f4` |
| `other_person` | Samme parametre som `simple`, annen person (`person-2`). | `de84cde5e0f3c9c036d6e2975cc0c119b3a4f27f7e84e7fa69606f80fc46a95c` |
| `unicode_nfc` | Bokstaven é som ETT kodepunkt (U+00E9, NFC). | `2348686296cc3f7816d4d5754ab5dbb7b10d4945a6cfcc434ffa770f8be3cb3e` |
| `unicode_nfd` | `e` + U+0301 (NFD): samme tekst som `unicode_nfc`, men ULIK digest (ingen normalisering). | `5977119e13cc0176b4fdfc738c92928c9cf859b79706ab9a199b508e5765f610` |
| `unicode_escaping` | Emoji (astralt kodepunkt), anførsel, backslash, tab, linjeskift, U+0001 (skrives som backslash + u0001) og U+2028 (skrives som det er). | `318134c4dd83c0e777557a8b1b9d66e332d5e2e7ea0fbd668bf371ffbd8aea63` |
| `key_sort_utf16` | Nøkler sorteres på UTF-16-kodeenheter: U+1F600 (kodeenhet 0xD83D) kommer FØR U+FF5E, selv om kodepunktet er større. | `3903e66b3ea3117250014af1c3a09d9ba21d6d8b61b3d500af4da1681e8e0ad7` |
| `numbers_ecmascript` | Tall som ECMAScript Number-til-tekst: 1e+21, 1e-7, 5e-324, -0 blir 0, heltall uten desimal. | `14abc31ec2284ecd5dab6ef6cb793b9e319fe26ca18590eeb791e8e0e4d8c8d4` |
| `definition_excluded_field` | Et per-definisjon-utelatt felt (`value`) inngår ikke (og heller ikke `idempotency_key`). Verktøy `owner_controls.set_connector_credential`. | `4ae33023ab08c879a4c664582d2b4ab26c7e15461f857c0aaede26f5e7c70291` |

Kanoniske strenger (UTF-8) for vektorene som kan skrives lesbart her; SHA-256 av nøyaktig denne teksten gir digesten i tabellen:

```
simple                    {"action":"create_event","parameters":{"start":"2026-11-26T10:00:00Z","title":"Møte"},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}
empty_parameters          {"action":"create_event","parameters":{},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}
nested_scrambled_order    {"action":"create_event","parameters":{"alpha":"first","mid":[{"p":2,"q":1},[]],"zeta":{"a":{"x":null,"y":false},"b":[3,2,1]}},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}
idempotency_key_excluded  {"action":"create_event","parameters":{"title":"Møte"},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}
null_bool_empty           {"action":"create_event","parameters":{"empty":"","flag":false,"list":[],"none":null},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}
other_tool_action         {"action":"send","parameters":{"body":"Tekst","subject":"Hei","to":"recipient-1"},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"email","v":1}
other_tenant              {"action":"create_event","parameters":{"start":"2026-11-26T10:00:00Z","title":"Møte"},"person_id":"person-1","tenant_id":"tenant-b","tool_id":"calendar","v":1}
other_person              {"action":"create_event","parameters":{"start":"2026-11-26T10:00:00Z","title":"Møte"},"person_id":"person-2","tenant_id":"tenant-a","tool_id":"calendar","v":1}
unicode_nfc               {"action":"create_event","parameters":{"name":"café"},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}
numbers_ecmascript        {"action":"create_event","parameters":{"big":123456789012345680000,"frac":1.5,"huge":1e+21,"int":42,"max":1.7976931348623157e+308,"min":5e-324,"neg":-5,"negzero":0,"small":0.000001,"tiny":1e-7,"zero":0},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}
definition_excluded_field {"action":"set_connector_credential","parameters":{"connector_id":"example","credential_ref":"EXAMPLE_REF"},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"owner_controls","v":1}
```

`unicode_nfd`, `unicode_escaping` og `key_sort_utf16` er ikke gjengitt (kombinerende tegn, kontrolltegn og astrale tegn overlever ikke alle redigeringsverktøy); de står i modulen og er låst av testen.

## 4. Moduser og utrulling (K2/K3)

### 4.1 Hva hver modus gjør

Modus leses PER KALL fra `JARVIS_TOOL_REQUEST_DIGEST` (eller `ToolGatewayOptions.requestDigestMode`). Mismatch avgjøres i selve reserve-transaksjonen mot ledger-raden (atomisk mot samtidige kall), FØR noen statusgren, uavhengig av radens status
(`reserved`, `succeeded`, `failed`, `unverified`, og de nye statusene i §6): en avvist gjenbruk utfører aldri noe, kaller aldri en leverandør og rører ikke raden.

| Situasjon | `off` (standard) | `observe` | `enforce` |
|---|---|---|---|
| Digest beregnes og lagres på nye rader | nei (ingen ny kolonne i spørringene, ingen ekstra spørring: SQL er byte-lik main) | ja | ja |
| Nøkkel gjenbrukt, ULIK digest | som før (lagret resultat / replay) | som før + revisjonsrad `tool.idempotency_key_reuse_observed` («ville avvist») | AVVIST `idempotency_key_reuse_mismatch` + revisjonsrad `tool.idempotency_key_reuse_mismatch`; ingenting utføres |
| Nøkkel gjenbrukt, lagret rad uten digest (legacy), SAMME verktøy og handling | som før | som før + `tool.idempotency_legacy_row` | som før + `tool.idempotency_legacy_row` |
| Nøkkel gjenbrukt, lagret rad uten digest, ANNET verktøy eller handling | som før | `tool.idempotency_key_reuse_observed` | AVVIST (verktøy/handling er sikkert en annen forespørsel) |
| Handling merket `required` kalt uten nøkkel | som før | `tool.idempotency_key_missing_observed` | AVVIST `idempotency_key_required` |
| Parametre som ikke kan digestes (§3.2) | som før | `tool.request_digest_invalid_observed`; kjøres uten digest | AVVIST `request_digest_invalid:<kode>` |

Revisjonsradene bærer kun korte avtrykk (16 hex av SHA-256) av nøkkelen og digesten, lagret/innkommende verktøy og handling, lagret status og modus - aldri nøkkelen, parametrene eller verdier. Klasse D: et avvist duplikat sender ingen eier-varsling.
Nødbrytere (kill switch, selvgjenopprettings-handlinger) er unntatt nøkkelkravet uansett modus og definisjon.

### 4.2 Utrulling: `off` -> `observe` -> `enforce` (eierhandling på NAS)

Rekkefølgen er bindende: `enforce` skal aldri slås på før en `observe`-periode er lest.

1. **Deploy** (som øvrige oppdateringer, se [NAS_UPDATE_HF1_HF2.md](NAS_UPDATE_HF1_HF2.md)): `migrate`-tjenesten kjører 153 og 154 (additive; ingen data røres). Kontroller at begge er anvendt:
   `sudo docker compose --env-file .env -f infra/local/docker-compose.yml exec -T postgres sh -c 'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-jarvis}" -tA -c "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 12"'`
   skal blant annet liste `153_tool_executions_request_digest.sql` og `154_tool_executions_reconcile.sql`. Flaggene er fortsatt AV: atferden er uendret.
2. **Observe**: sett `JARVIS_TOOL_REQUEST_DIGEST=observe` i `.env` og start api OG worker på nytt. Ingenting avvises; nye ledger-rader får digest.
3. **Les revisjonen** etter en representativ periode (minst en uke med vanlig bruk, helst mer):
   ```sql
   SELECT type, tool_id, action, count(*) AS antall, max(at) AS sist
     FROM audit_events
    WHERE type IN ('tool.idempotency_key_reuse_observed', 'tool.idempotency_key_missing_observed', 'tool.request_digest_invalid_observed', 'tool.idempotency_legacy_row')
      AND at > now() - interval '14 days'
    GROUP BY type, tool_id, action ORDER BY antall DESC;
   ```
   - `tool.idempotency_key_reuse_observed` skal være **0** før `enforce`: en verdi over 0 betyr at en ekte kaller gjenbruker en nøkkel til en annen forespørsel (feil i kaller, eller nøkkel som ikke er unik). Undersøk hver rad (`payload->>'stored_tool_id'`, `payload->>'stored_action'`, `payload->>'stored_status'`) FØR `enforce`.
   - `tool.idempotency_key_missing_observed`: hvert verktøy/handling her vil bli AVVIST i `enforce` (kalleren sender ingen nøkkel). Rett kalleren (send en nøkkel) eller la handlingen stå som `optional` (endre regelen bevisst, §5). Skal være 0 for handlingene eieren faktisk bruker.
   - `tool.request_digest_invalid_observed` skal være 0 (ellers sender en kaller parametre som ikke er ren JSON).
   - `tool.idempotency_legacy_row` er forventet i starten (rader fra før 153) og forsvinner av seg selv etter hvert som nøklene fornyes; det er ikke en feil.
4. **Enforce**: sett `JARVIS_TOOL_REQUEST_DIGEST=enforce`, start api OG worker på nytt. Følg `tool.denied`-rader med `reason` `idempotency_key_reuse_mismatch` / `idempotency_key_required` / `request_digest_invalid:%` de første dagene.
5. **Hvis noe uventet avvises**: sett tilbake til `observe` (eller `off`) og start på nytt - ingen data- eller skjemaendring er nødvendig (§4.4).

### 4.3 Hemmelighetsbærende felt (A-4) - konsekvens å kjenne til

Digesten er et usaltet avtrykk og skal ikke kunne brukes til å gjette en hemmelighet med lav entropi. To handlinger utelater derfor feltet `value` fra digesten (`DIGEST_EXCLUDED_PARAMETERS` i `modules/tool-gateway/src/idempotency-requirements.ts`):
`owner_controls.set_connector_credential` og `vercel.upsert_env`. **Konsekvens:** å sende samme nøkkel med en ENDRET `value` gir IKKE `idempotency_key_reuse_mismatch` (resten av forespørselen er lik) - ledgeren svarer da med det lagrede resultatet, og den nye verdien settes ikke.
Bruk en ny nøkkel når verdien skal endres. En vakttest (`wpt1-idempotency-decisions`) sikrer at ingen registrert handling har et hemmelighetsliknende parameternavn uten å være utelatt (eller eksplisitt begrunnet).

### 4.4 Rollback og data

Tilbakerulling er å sette flagget til `off` og starte api og worker på nytt. Migrasjon 153 er additiv og nullbar: en eldre kodeversjon ignorerer kolonnen, og radene med digest skader ingenting (`off` leser og skriver den ikke).
Det finnes ingen down-migrasjon (migrasjoner er append-only); kolonnen kan stå. Kolonnen kan ikke endres av runtime-rollen etter INSERT (kolonnevise UPDATE-rettigheter); `DELETE` er fortsatt ikke gitt app-rollen.

## 5. Nøkkelkrav per handling (K4)

`ToolDefinition.idempotency` har tre verdier: `required` (kallet MÅ bære `idempotency_key`; håndheves i `enforce`, loggføres i `observe`), `optional` (nøkkel brukes når den oppgis) og `none` (ren lesing; klasse A har ingen ledger). UTELATT = som før WP-T1 (kun styrt klasse D krever nøkkel,
`class_d_idempotency_key_required`). Produksjonsregisteret får verdien ved komposisjonsroten (`firstWaveTools` -> `applyIdempotencyDecisions`, som returnerer KOPIER) fra den deterministiske regelen `decideIdempotency` (`modules/tool-gateway/src/idempotency-requirements.ts`, første treff gjelder).
En definisjon som selv har tatt stilling beholder sin verdi. `buildToolManifest` er uendret (manifestets `idempotency` er fortsatt utledet som før; vakten sikrer at alt manifestet krever også er `required` her).

Skrivehandlinger i produksjonsregisteret (258 av ca. 512 definisjoner; resten er lesinger = `none`), fordelt etter regel (festet i `apps/api/test/fixtures/wpt1-idempotency-decisions.json`):

| Regel | Nøkkelkrav | Antall | Begrunnelse |
|---|---|---|---|
| `R0_safety_switch` | `optional` | 10 | nødbryter/selvgjenoppretting: må virke også når alt annet er nede og kan aldri blokkeres av et nøkkelkrav |
| `R2_class_d` | `required` | 21 | klasse D: kjeden krever en ekte idempotensreferanse (`class_d_idempotency_key_required`) |
| `R3_money` | `required` | 6 | penger: en dobbel betaling/refusjon/generering kan ikke trekkes tilbake |
| `R4_outbound` | `required` | 13 | utsendelse: en dobbel melding, e-post, SMS eller varsel kan ikke trekkes tilbake |
| `R5_delete` | `required` | 3 | sletting: en gjentatt sletting kan ramme noe annet enn det som var ment, og beviset må være entydig |
| `R6_external_not_idempotent` | `required` | 24 | skriving/styring mot en ekstern leverandør som ikke er idempotent av natur: en retry gir et duplikat |
| `R7a_external_idempotent` | `optional` | 54 | ekstern handling der leverandøren selv er idempotent: nøkkel brukes når den oppgis, kreves ikke |
| `R7b_internal_state` | `optional` | 127 | Jarvis-eid intern tilstand: domenetjenesten har egen idempotens og avstemming |

`R1_read` (`none`) gjelder klasse A og handlinger med effekt «les». Totalt 67 handlinger er `required` og 191 `optional` blant skrivehandlingene. Den fulle listen (verktøy.handling, klasse, effekt, regel) står i fixturen; `required` er: R2: docker (start/stop/redeploy), drive (rettigheter, permanent sletting), `email.send`,
finance (betalingsintensjon, Stripe-refusjon, Vipps-capture/refusjon), gce (start/stop/reset), github (`delete_branch`, `merge_pr`), home-assistant (`alarm_set`, `lock_set`), `mcp_zapier.call_tool`, `microsoft_outlook.send_mail`; R3: `finance_wallester.submit_card` og de fem mediagenererings-handlingene;
R4: `discord`/`slack`/`telegram`/`telnyx`/`twilio`/`whatsapp.notify`, `support.reply`, GitHub-kommentar/workflow-handlinger, `make.run_scenario`, `n8n.activate_workflow`; R5: `business.delete_lead`, `business.delete_opportunity`, `drive.trash`; R6: opprett/oppdater mot kalender, drive, dropbox, onedrive, notion, jira, linear, hubspot, pipedrive, todoist, trello, spotify, google_sheets, `github.create_issue` og `finance_neonomics.create_consent`.

**Vakt (K4):** en NY skrivehandling, en endret regel eller en endret definisjon endrer listen og feller `apps/api/test/wpt1-idempotency-decisions.test.ts` til fixturen er regenerert BEVISST
(`UPDATE_IDEMPOTENCY_FIXTURE=1 pnpm exec vitest run apps/api/test/wpt1-idempotency-decisions.test.ts`) og diffen er forklart i PR-en: hver endring er en beslutning om at en handling skal/ikke skal kreve nøkkel. Hver regel er i tillegg testet isolert med syntetiske definisjoner (`modules/tool-gateway/test/wpt1-idempotency-rules.test.ts`).

**Utrullingsmerknad:** `required` slår først inn i `enforce`. Kallere som aldri har sendt nøkkel (for eksempel enkelte transporter og bakgrunnsjobber) vil da bli avvist. Derfor er `observe`-trinnet i §4.2 obligatorisk, og punkt 3 skal gi en tom liste for `tool.idempotency_key_missing_observed` for det eieren bruker.

## 6. Ledger-avstemming og eierens avgjørelse (K5)

### 6.1 Problemet og tilstandsmaskinen

Før: en `unverified`-rad (utført men ikke bekreftet) og en `reserved`-rad som aldri ble ferdigstilt (krasj midt i kallet) sto for alltid; samme-nøkkel-retry var blokkert (riktig, fail-closed), men ingen jobb flyttet dem og ingen sa fra til eieren.
Med `JARVIS_TOOL_LEDGER_RECONCILE=on`:

| Fra | Til | Når | Betydning |
|---|---|---|---|
| `reserved` | `unknown_outcome` | eldre enn `RESERVED_TTL_MINUTES` (standard 60) | utfallet er UKJENT; aldri automatisk retry; blokkerer fortsatt samme nøkkel |
| `unverified` | `needs_resolution` | eldre enn `UNVERIFIED_TTL_HOURS` (standard 24) | utført men ikke bekreftet; venter på eierens avgjørelse; blokkerer fortsatt samme nøkkel |
| `unverified` / `reserved` (eldre enn 10 min) / `unknown_outcome` / `needs_resolution` | `succeeded` | eieren avgjør `executed` | lagret suksess: en retry med samme nøkkel gir det lagrede resultatet (`deduplicated`), uten ny utførelse |
| samme | `failed` | eieren avgjør `not_executed` | nøkkelen er FRIGITT: en retry med samme nøkkel utføres på nytt (eierens ansvar etter sjekken) |

`needs_resolution` svarer ved replay som `unverified` (den lagrede årsaken, aldri en ny mutasjon); `unknown_outcome` svarer `execution_in_flight_or_outcome_unknown`. `ToolGateway.reconcile()` lister også de nye statusene. En eldre kodeversjon (uten 154) behandler dem som en rad under utførelse: blokkerer retry, aldri en ny mutasjon.

### 6.2 Utløpssveipet (`tool-ledger-reconcile`)

Daglig `DailyScheduler`-jobb (api-prosessen; `JARVIS_TOOL_LEDGER_RECONCILE_HOUR`, standard 05), registrert KUN med flagget på. Den flytter kun status og skriver ÉN revisjonsrad per rad (`tool.ledger_reconciled`, `person_id: system`, årsak `reserved_ttl_exceeded`/`unverified_ttl_exceeded`, kort avtrykk av nøkkelen, alder i minutter, og kjøringens `task_id`/`trace_id` fra `DailyScheduler` slik at raden kan knyttes til jobben og forsøket som skrev den, JARVIS-054).
**Aldri** en automatisk retry og **aldri** et leverandørkall. Idempotent (en ny kjøring finner ingenting), tenant-skopet (RLS; `withTenantTransaction` per tenant), `FOR UPDATE SKIP LOCKED` (to prosesser tar aldri samme rad), eldst først i batcher à 500 (opptil 20 batcher per status og tenant per kjøring = 10 000 rader; resten tas neste kjøring).
En tenant som feiler velter ikke de andre; feilene samles og kastes etterpå (`failOnSweepFailures`, D-442): nytt forsøk etter 1/5/15 minutter, `last_error` i `scheduler_state`, og jobben vises i scheduler-helsen/morgenbriefen om den gir opp (en kritisk jobb, D-445). Logglinjen `tool_ledger_reconcile_done` har kun tall.
DATABASEGULV (trigger `tool_executions_guard`): en `reserved`-rad kan ikke merkes ukjent før den er 10 minutter gammel, en `unverified`-rad ikke før 1 time, uansett konfigurasjon (en feilkonfigurasjon eller TTL=0 kan aldri merke et kall som kan være under utførelse).
Teoretisk grense: et leverandørkall som varer lenger enn TTL (minst 15 min; verktøyenes tidsavbrudd er langt kortere) kan avstemmes mens det går; ferdigstillingen (`UPDATE ... WHERE status = 'reserved'`) treffer da ingen rad og raden blir stående ukjent (fail-closed).

### 6.3 Eierens kø og avgjørelse (rutene)

Begge er `POST` med JSON-kropp og `grant_token` (som øvrige kontrollruter); identitet, tenant og person kommer UTELUKKENDE fra det verifiserte grantet (identitetsfelt og ukjente felt i kroppen avvises). Begge krever den suverene eieren (samme eier-port som kontrollsentrene; en annen person får `403 owner_required` og en `tool.denied`-revisjonsrad).
Uten flagget finnes ikke rutene (404, identisk med main). Ingen av dem er et modellverktøy; avgjørelsen er en registrering i Jarvis' egen ledger og kaller aldri en leverandør, transport eller `ToolGateway.execute()`. Det finnes foreløpig ingen kontrollsenter-/dashbord-flate for køen (`DEFERRED`, §9).

**`POST /tool-ledger/queue`** - kropp `{ "grant_token": "<eierens grant>", "limit": 50 }` (`limit` valgfri, heltall 1-200, standard 100). Svar `{ ok: true, data: { total, entries } }`, eldst først, kun for grantets tenant. Hver oppføring:
`idempotency_key`, `tool_id`, `action`, `capability_class` (`null` = verktøyet er ikke registrert i prosessen), `step_up_required`, `status` (`reserved` eldre enn 10 min, `unverified`, `unknown_outcome`, `needs_resolution`), `status_before_reconcile`, `reason` (fast kode, aldri leverandørtekst), `external_id` (leverandørens referanse, hvis kjent: det eieren slår opp hos leverandøren),
`executed_at`, `reconciled_at`, `age_minutes`, `recovery` (handlingens rollback-prosedyre: hva som skal sjekkes). Leseruten krever IKKE step-up.

**`POST /tool-ledger/resolve`** - kropp `{ "grant_token": "...", "idempotency_key": "<fra køen>", "resolution": "executed" | "not_executed", "provider_checked": true, "note": "<valgfri merknad>" }`.
Svar `200 { ok: true, data: { idempotency_key, tool_id, action, from_status, to_status, resolution, capability_class } }`. Regler:

- `provider_checked: true` kreves ALLTID (eieren bekrefter at hen har sjekket hos leverandøren; `false`/manglende gir `400 provider_check_not_confirmed`).
- KLASSE-BEVISST: for klasse C/D og for et verktøy som ikke er registrert (fail-closed, som D) kreves i tillegg step-up (enhetssignert økt fra en eier-kanal: `403 step_up_required` med årsakskode); klasse A/B holder med eierporten.
- En `reserved`-rad yngre enn 10 minutter kan ikke avgjøres (`409 ledger_resolve_too_early`: kallet kan fortsatt pågå). Endelige rader (`succeeded`/`failed`) og allerede avgjorte rader gir `409 ledger_not_resolvable` (med `ledger_status`); to samtidige avgjørelser: nøyaktig én lykkes, den andre får `409`. Ukjent nøkkel (eller annen tenant): `404 ledger_entry_not_found`.
- Merknaden (maks 200 tegn etter rensing) går først gjennom den sentrale hemmelighetsskanneren, deretter fjernes kontrolltegn/usynlige tegn, og den lagres KUN i revisjonsraden `tool.ledger_resolved` (aldri i ledger-raden og aldri i svaret). Revisjonsraden bærer hvem (`person_id`), avgjørelsen, `provider_checked`, `step_up`, forrige årsak og kort avtrykk av nøkkelen.
- Nøkkelen er valgt av kalleren og kan inneholde mellomrom og ikke-ASCII (1-300 tegn, ingen kontrolltegn); oppslaget er eksakt.

**Slik avgjør eieren:** sjekk hos leverandøren (bruk `external_id` og `recovery` fra køen). Er handlingen utført: `executed`. Er det sikkert at ingenting skjedde: `not_executed` (da kan samme nøkkel utføres på nytt; med `JARVIS_TOOL_REQUEST_DIGEST=enforce` avvises en retry med ANNEN nyttelast fortsatt som `idempotency_key_reuse_mismatch`, fordi digesten blir stående på raden).
Er det uklart: avgjør IKKE - raden blir stående i køen og nøkkelen forblir blokkert (fail-closed).

### 6.4 Migrasjon 154

`ALTER TABLE tool_executions`: statussjekken utvides til `reserved`, `succeeded`, `failed`, `unverified`, `unknown_outcome`, `needs_resolution`; seks nullbare kolonner (`status_before_reconcile`, `reconciled_at`, `reconcile_basis`, `resolved_at`, `resolved_by`, `resolution`) med kolonnevise UPDATE-rettigheter til `jarvis_app`; delvis indeks `tool_executions_open_idx` over åpne statuser;
CHECK-er: avstemmingsfeltene hører sammen (alle tomme eller alle satt), det samme for avgjørelsen, `unknown_outcome` kommer alltid fra `reserved` og `needs_resolution` fra `unverified` (`IS NOT DISTINCT FROM`, fordi en CHECK som evaluerer til NULL ellers slipper gjennom), `executed` hører til `succeeded` og `not_executed` til `failed`.
Triggeren `tool_executions_guard` (BEFORE UPDATE) håndhever tilstandsmaskinen uavhengig av applikasjonen: gulvene i §6.2, riktig utgangsstatus, en fullstendig avgjørelse ved utgang fra de nye statusene, og at et re-arm (`failed` -> `reserved`, retry) NULLSTILLER avstemmings- og avgjørelsesfeltene. Alle ØVRIGE overganger er uendret.
Trigger og kolonnerettigheter rører ikke identitetskolonnene eller `request_digest` (de er fortsatt ikke skrivbare for runtime-rollen). Retensjonen (`prune_operational_data`, med RLS-policy som bare tillater `succeeded`/`failed`) sletter aldri de nye statusene; en avgjort rad blir `succeeded`/`failed` og ryddes som andre; beviset for avgjørelsen står i `audit_events` (append-only).

### 6.5 Slå på og av

1. Sett `JARVIS_TOOL_LEDGER_RECONCILE=on` (valgfritt TTL-ene) i `.env`, start api på nytt. En ugyldig verdi stopper oppstarten med en tydelig melding i `docker compose logs api`.
2. Første kjøring tar etterslepet (alle `reserved`/`unverified` eldre enn TTL). Kontroller: logglinjen `tool_ledger_reconcile_done` (tall), `SELECT * FROM scheduler_state WHERE job_name = 'tool-ledger-reconcile' ORDER BY run_date DESC LIMIT 3;`, og køen via `/tool-ledger/queue`.
3. Rollback: `JARVIS_TOOL_LEDGER_RECONCILE=off` + omstart av api stopper jobben og fjerner rutene. Rader som allerede er `unknown_outcome`/`needs_resolution` blir stående (de blokkerer fortsatt nøkkelen: fail-closed; synlige i `ToolGateway.reconcile()` og i databasen) til eieren avgjør dem etter at flagget er på igjen.

## 7. Infra-journal (K6, JARVIS-105)

- En UKJENT utfall av en KLASSE D-infra-handling åpner nå hendelsen med alvorlighet `high` (var `normal`): en kritisk handling som kan ha endret noe uten at vi vet hva, er ikke mindre alvorlig enn en som feilet (`infraExecutionSeverity`, `modules/incidents/src/producers/infra-execution.ts`). PARTIAL og UKJENT utfall av en lavere klasse forblir `normal`.
- Docker-journalen (`modules/incidents/src/infra-execution.ts`) mapper et utfall leverandøren AKSEPTERTE men gatewayen ikke kunne bekrefte (`postcondition_mismatch`, `postcondition_unverified:*`) til UKJENT i stedet for FAILED (`isAcceptedButUnverifiedReason`), og leser da før-/etter-tilstanden fra ledgeren slik at gjenoppretting får før-tilstanden.
  `isUnknownOutcomeReason` og alle `postcondition_reason`-strenger er uendret (andre forbrukere er festet til dem).
- Ingen flagg: rettelsen gjelder alltid. Tester: `modules/incidents/test/wpt1-infra-unknown-outcome.test.ts` (bruker de ekte Docker-definisjonene).

## 8. Designvalg og antakelser (forslag til beslutningslogg)

- **A-1** Ingen Unicode-normalisering i digesten (§3.3).
- **A-2** ÉN kanonisering (`canonicalStringify`, uendret), to hash-domener; digesten er versjonsmerket (`v: 1`), en senere endring er en NY versjon (aldri en stille endring av digestene som ligger i ledgeren).
- **A-3** Digesten dekker verktøy, handling, parametre (uten nøkkel og utelatte felt), tenant og person; ikke økt/enhet/kanal/space.
- **A-4** Hemmelighetsbærende felt utelates fra digesten for to handlinger (§4.3); konsekvensen er dokumentert og testet.
- **A-5** Mismatch avgjøres atomisk i reserve-transaksjonen og er uavhengig av radens status; en rad uten digest (legacy) kjører som før (loggført), men et annet verktøy/handling er alltid et sikkert avvik.
- **A-6** Standard `off` er byte-/atferdslikt main (differensialtest: SQL-spion viser ingen ny kolonne og ingen ekstra spørring).
- **A-7** Nøkkelkravet er en egenskap på definisjonen, satt sentralt ved komposisjonsroten fra en deterministisk liste (§5); manifestet er uendret.
- **A-8** `reserved` blir `unknown_outcome` og `unverified` blir `needs_resolution` etter TTL (standard 60 min / 24 t); DB-gulv 10 min / 1 t; aldri automatisk retry eller leverandørkall.
- **A-9** Eierens avgjørelse er en registrering i Jarvis' ledger etter en manuell sjekk; `not_executed` frigir nøkkelen og er eierens ansvar. Klasse C/D og ukjent verktøy krever step-up.
- **A-10** Triggeren legger bevisst IKKE til uforanderlighet for identitetskolonnene/digesten (eksisterende administratortester og reparasjoner endrer dem; runtime-rollen er allerede stengt ute av kolonnevise rettigheter).
- **A-11** K6 er alltid på (ingen flagg): det er en rettelse av feil klassifisering, ikke en ny funksjon.

## 9. Kjente begrensninger, `PARTIAL` og `DEFERRED`

- Policy Gateway validerer først: NaN, `undefined` i lister og lignende gir `invalid_tool_call` før digest-koden; en SYKLISK parameterstruktur gir en `RangeError` i Policy Gateways skjemarekursjon før digest-koden (ikke endret her).
- `required` krever `observe`-trinn før `enforce` (§5); kallere uten nøkkel avvises i `enforce`.
- Hemmelighetsbærende felt er utelatt fra digesten for to handlinger (§4.3): endret verdi under samme nøkkel oppdages ikke.
- UKJENT utfall av en klasse C-handling får fortsatt alvorlighet `normal` (kun klasse D løftes). `PARTIAL` er uendret. Skyjournalen (`executeCloudMutation`) mapper fortsatt `postcondition_*` til PARTIAL (egen flyt, ikke endret).
- EV-19-vedlikeholdskatalogen er IKKE utvidet med ledger-jobben: katalogen er statisk og ville markert jobben som forfalt også med flagget AV (en endring av flagg-AV-atferden). Jobben har egen helse i `scheduler_state` og gir opp-varsel via scheduler-helsen. `DEFERRED`: betinget dekning.
- Ingen kontrollsenter-/dashbord-flate for køen (kun rutene). `DEFERRED`.
- Sveipet tar inntil 10 000 rader per status og tenant per kjøring; et større etterslep tas over flere døgn.
- Approval v2 (WP-MC7) som bruker `request_digest` er ikke bygget; `real_transport`-broen i connector-SDK er ikke bygget (WP-I2).

## 10. Tester og kommandoer

DB-tester kan ikke kjøre som root. Maks to arbeidere, alltid `timeout`:

```
su postgres -s /bin/bash -c 'export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=/opt/node22/bin:$PATH NODE_OPTIONS=--max-old-space-size=2048; cd <worktree> && timeout -k 5 900 pnpm exec vitest run --maxWorkers=2 \
  packages/contracts/test/request-digest.test.ts modules/core/test/wpt1-ledger-migrations.test.ts modules/core/test/wpt1-ledger-reconcile-migration.test.ts \
  modules/tool-gateway/test/wpt1-request-digest-db.test.ts modules/tool-gateway/test/wpt1-idempotency-rules.test.ts modules/tool-gateway/test/wpt1-ledger-reconcile-db.test.ts modules/tool-gateway/test/wpt1-runbook.test.ts \
  modules/incidents/test/wpt1-infra-unknown-outcome.test.ts apps/api/test/wpt1-idempotency-decisions.test.ts apps/api/test/wpt1-tool-ledger-routes.test.ts apps/api/test/wpt1-ledger-wiring.test.ts'
```

| Test | Bevis |
|---|---|
| `packages/contracts/test/request-digest.test.ts` | vektorene (håndskrevet kanonisk + uavhengig SHA-256), stabilitet over nøkkelrekkefølge, Unicode, tall, avvisningstabellen, ekvivalens med `canonicalStringify`/`hashApprovalParameters` |
| `modules/core/test/wpt1-ledger-migrations.test.ts` | 153 på en eksisterende database: eldre rader `NULL`, formatkrav, kolonnerettigheter, RLS |
| `modules/core/test/wpt1-ledger-reconcile-migration.test.ts` | 154 på en eksisterende database, CHECK-ene, trigger-matrisen (gulv, utgangsstatus, avgjørelse, re-arm), rettigheter, RLS, retensjon |
| `modules/tool-gateway/test/wpt1-request-digest-db.test.ts` | moduser `off`/`observe`/`enforce` mot ekte `ToolGateway`, SQL-spion for `off` = main, samtidighet, legacy-rader, hemmelighetsutelatelse, nødbrytere |
| `modules/tool-gateway/test/wpt1-idempotency-rules.test.ts`, `apps/api/test/wpt1-idempotency-decisions.test.ts` | hver regel isolert; produksjonsregisteret festet i fixturen |
| `modules/tool-gateway/test/wpt1-ledger-reconcile-db.test.ts` | konfigurasjon, sveip (TTL-grense, idempotens, tenant-skille, batcher, samtidighet), replay av de nye statusene, kø, avgjørelse (eier, step-up per klasse, samtidighet, merknad) |
| `apps/api/test/wpt1-tool-ledger-routes.test.ts`, `wpt1-ledger-wiring.test.ts` | rutene over HTTP (dormant, grant/eier/step-up, validering, statuskoder) og kildevakt for innkoblingen |
| `modules/incidents/test/wpt1-infra-unknown-outcome.test.ts` | K6 |
| `modules/tool-gateway/test/wpt1-runbook.test.ts` | dette dokumentet: vektorer, regeltall, flagg, migrasjoner og revisjonstyper er i samsvar med koden |

Rød-først: testene for K1, K2, K3, K5 og K6 er kjørt mot dagens (gamle) kode eller uten migrasjonen og feilet (tall i leveranserapporten). Mutanter: se leveranserapporten.

## 11. `NOT VERIFIED`, eierhandlinger og blokkeringer

**NOT VERIFIED (ingenting av dette er observert på NAS-en):** migrasjon 153/154 mot produksjonsdatabasen; `observe`-periodens utfall; `enforce` mot ekte kallere; sveipet mot ekte etterslep i `tool_executions`; rutene mot en ekte eier-økt (grant/step-up fra eierens enhet); `scheduler_state`-raden for `tool-ledger-reconcile`;
K6 mot ekte Docker-mutasjoner. Alle flagg er AV til eieren har kjørt trinnene i §4.2 og §6.5.

**Eierhandlinger (NAS), kort:** (1) deploy og kontroller at 153 og 154 er anvendt; (2) `JARVIS_TOOL_REQUEST_DIGEST=observe`, restart api og worker; (3) les revisjonen (§4.2 punkt 3) etter en uke; (4) `enforce` først når `tool.idempotency_key_reuse_observed` og `tool.idempotency_key_missing_observed` er forklart; (5) `JARVIS_TOOL_LEDGER_RECONCILE=on`, restart api;
(6) les køen og avgjør radene etter en manuell sjekk hos leverandøren (klasse C/D krever signert enhetsøkt).

**`BLOCKED_EXTERNAL`:** ingen (ingen credential, konto, maskinvare eller juss trengs for å bygge dette). `HARD_EXTERNAL_BLOCKER`: ingen.
