TS: 2026-11-26T04:34:56.299Z
VERDICT: MERGE ETTER FIKSER. 0 HIGH, 0 MEDIUM, 6 LOW, 5 INFO. Produksjonskoden har ingen blokkerende feil. Fiksene er 5 docs-setninger, 4 manglende regresjonstester og ca. 10 linjer kode, og kan tas som egen oppfølger hvis du vil merge nå.

Grunnlag: HEAD `2bd0dedc` mot base `71a31d8b`. Begge worktrees var rene før og etter (`git status --short` tomt). Jeg kjørte selv A sine guards, pool-, routes- og journal-prober, B sine wiring- og decide-prober, 4 av B sine mutanter på nytt, 9 nye mutanter og gitleaks.

## Funn (rangert)

**LOW-1: falsk `failed` når HA-klokken går BAK Jarvis, og feil dokumentasjon.** `action-reconcile.ts:119-126`.
- `failed` krever `last_changed + 60 s <= requested_at` og at tilstanden er lik før-tilstanden. En handling som kjørte og deretter ble reversert får `last_changed` etter forespørselen, men målt på HAs klokke. Er HA bak med minst 60 s pluss reverseringsforsinkelsen, blir resultatet `failed`.
- Probe `/tmp/lead/G2c-review-B-probes/zz-g2c-review-b-decide.test.ts` (kjørt på nytt): HA 5 min bak og revert etter 90 s gir `failed/no_state_change_since_request`. HA 30, 59 og 61 s bak, og HA 5 min frem, gir `unknown`. Terskelen i dette scenarioet er 150 s. Probens egen 61 s-forventning er feil.
- `before_state=null` hopper over før-tilstandssjekken (`:120`). `failed`-grenen leser aldri `laterAction` (`:101` beskytter bare `applied`).
- Skaden er begrenset. En replay med original nøkkel gir FAILED uten POST (A R2). En ny nøkkel krever eier og step-up. Svaret viser observert tilstand.
- Dokumentasjonen er feil: runbook §10 steg 7 (l.264) sier «over 60 s gjør `failed` for forsiktig, ikke farlig». Det gjelder bare HA FREM.
- Fiks:
  - rett setningen
  - krev `!e.laterAction` og `typeof before_state.state === "string"` for `failed`
  - valgfritt: mål skjevhet fra HTTP-`Date` i HA-svaret og nekt `failed` ved skjevhet over 30 s

**LOW-2: NUL eller ensomt surrogat i `expected_state` gir rå DB-feil (regresjon i feilkontrakt).** `action-executor.ts:150` videre til `action-journal.ts:91-97` (`JSON.stringify` til `$17::jsonb`).
- Probe A R1 (`zz-g2c-review-a-reconcile.test.ts`): NUL gir «unsupported Unicode escape sequence», surrogat gir «invalid input syntax for type json». Resultat: 0 journalrader og 0 HA-kall.
- Main (og kontrolltegn/emoji nå) gir FAILED `preflight_invalid:precondition_changed` med `failed`-rad. Her gir mutate-ruten generisk 400 uten journalrad.
- Gjelder bare eier med step-up, og har ingen sideeffekt.
- Fiks: `request_params: validParameters && jsonbSafe(input.parameters) ? input.parameters : null`. `jsonbSafe` avviser `\u0000` og `!isWellFormed()`. Legg til test.

**LOW-3: DAV-begrenseren sitter FØR step-up og teller avviste mutasjoner.** `personal-dav.ts:177` (begrenser) mot `:190` (step-up), nøkler `:70`.
- B DV3 (6/6 grønn): 10 mutasjoner fra en svak eier-økt (Telegram, `active`, 403 step_up) gir signert `create` 429 `scope=mutation`.
- A K3d: 10 godkjente pluss 50 avviste mutasjoner tømmer personbudsjettet, så neste lesing får 429 `person`.
- Fast vindu gir 60 forespørsler på 2 s ved vindusgrensen (enhetsgrense 30).
- Nøkkeltaket er 10 000, og nye nøkler nektes over det.
- Runbook §6 regel 12 (l.207) «en avvisning teller ikke mot en grense som ikke var nådd» stemmer ikke for mutasjons- og person-avvisninger.
- Fiks: step-up for mutasjoner før begrenseren, eller sjekk alle tre grenser før noe forbrukes. Rett setningen.

**LOW-4: `request_params` lagrer fri tekst, mot «aldri fritekst» og «ingen hemmeligheter».**
- `home-critical.ts:201` (`expected_state` 1-40 tegn) og `:270` (`expected_last_activated/triggered` ≤64) lagres i klartekst, også på `failed`-rader.
- Migrasjon 144 header l.12-14 sier «aldri alarmkode, token eller fritekst». Det samme gjelder DPIA og PROCESSING_INVENTORY («ingen hemmeligheter»).
- B J1: `expected_state="kode-1234-hemmelig-pin"` ble lagret. Alarmens `code` avvises av strict zod.
- Fiks: stram `expectedState` til `/^[a-z_]{1,40}$/` og markørene til `ISO_INSTANT`. Alternativt omformuler til «kort, skjema-validert tekst».

**LOW-5: testhull. Byggerens «0 overlevde» lar seg ikke reprodusere.** Av 184 uavhengige mutanter overlever 9 mot byggertestene.
- **M21:** `reconcile` koblet til skrive-eksekutoren i `personal-wiring.ts:104`. Hovedinvarianten «aldri skrive-verktøyet» er ubevoktet i oppkoblingen. B-proben `zz-g2c-review-b-wiring.test.ts` er grønn på ren kode og rød på M21 (`personal_action_unknown_action`).
- **M28:** `action-journal.ts:151` ser bare `applied`. Nyere `requested`/`outcome_unknown` er ikke testet. A sin probe R4 dreper den.
- **M30:** `FOR UPDATE` på egen invitasjonsrad (`family/service.ts:255`) har ingen kappløpstest.
- **M54:** revisjonspayloaden testes med `toMatchObject` (`action-journal.ts:186`). Ekstra innhold (`params`, `observed`) slipper gjennom, så «revisjon uten innhold» er ikke låst.
- **N12/X09:** `safeCode`-rensing og -lengde (`action-reconcile.ts`) maskeres av DB-CHECK `reconcile_basis ~ '^[a-z]…{0,79}$'`. En hostile årsak gir 500 i stedet for lagret kode.
- **N23, X02, X03:** `state_malformed`-vakten, start-anker i `RECONCILE_ID` og DAV-personnøkkel uten tenant. De endrer bare basiskode, feilkode eller er sikkerhetsnøytrale med én eier.
- Fiks:
  - ta A R4 og B W inn som tester
  - `toEqual` på audit-nøklene
  - ett kappløp for invitasjonslåsen
  - én hostile `read.reason`

**LOW-6: dokumentasjonsunøyaktigheter** i `docs/runbooks/WPG2_PERSONAL.md`.
- §9 l.253 «eneste atferdsforskjell mot main med alle flagg AV» er feil. K4 `lockDeviceRowsOn` (`device-enrollment-service.ts:172`, `device-service.ts:315-327`) gjelder `device_proof`-innrullering for alle (§4.5 l.157 sier det selv). Migrasjon 144 (kolonner og erstattet trigger) kjører også med flagg AV. Byggerens antakelse 8 motsier antakelse 1.
- §0 l.16: `wpg2-home-critical-unit` har 37 tester, ikke 36.
- §4.5 l.155 «Koordinatene leses aldri»: `getPersonLocation` bruker `SELECT *` (`modules/location/src/service.ts:320-328`, uendret) og laster koordinater. De eksponeres ikke. Bruk smal SELECT eller omformuler.
- §10 steg 7 (LOW-1) og §6 regel 12 (LOW-3).

**INFO**
- **I-1:** `reconcilePersonalAction` har ingen aktørsjekk selv. Ruten (`personal-routes.ts:311-313`) er porten og eneste produksjonskaller (`:316` via `personal-wiring.ts:104`). B J3: delegat direkte gir `read_failed:credential_not_bound_to_identity` og en forsøksrad. Fiks: eier-assert i funksjonen.
- **I-2:** revisjon `decision: "ALLOW"` også for forsøk som ender `outcome_unknown` (`action-journal.ts:186`), ulikt DAV-mappingen. Fiks: `UNKNOWN` ved `outcome_unknown`, pluss test.
- **I-3:** gatewayens grense på 30 lesinger/min gjelder også reconcile. Over det gir `read_failed`.
- **I-4:** byggertestens `POOL_OWNERS` mapper CLI-ene til «api», men ops kjører dem i `migrate`. Ingen effekt, siden variabelen står i begge.
- **I-5:** `ISO_INSTANT` (`critical-ops.ts:161`) godtar tidsstempel uten sone (eksisterende). `applied` har ingen maks alder: en 3 dager gammel rad blir `applied` hvis tilstanden matcher (dokumentert designvalg).

## Byggerens påstander -> dom

| Påstand | Dom | Bevis |
|---|---|---|
| K1 `applied`/`failed` kun med bevis, aldri retry eller skrive-verktøy, idempotent, revidert | BEKREFTET (forbehold LOW-1, -2, -5) | A R3: 168 kombinasjoner mot eget orakel, 0 avvik. R2 replay: `failed` gir FAILED uten POST, `unknown` ingen ny POST, `applied` gir SUCCESS. Trigger-matrise som app-rolle: 60 kombinasjoner, 0 avvik. Oppgradering 001..143 anvender kun 144. B rutematrise 21/21. M14-M26 drept. Én produksjonskaller. |
| K1 `p1a_outcome_reconcile` bygget, `wpg2-status` ikke svekket | BEKREFTET | R04 drept. Diffen endrer kun `DEFERRED` til `DORMANT/PARTIAL`. Ingen assertion fjernet utenom de forventede (`not_the_invitee`, nøkkelsettet i home-critical, status). |
| K2 pool 30 s, ikke flagg-styrt, `0` = ingen grense, ugyldig gir oppstartsfeil, ingen lekkasje, `advisory-lock.ts` urørt | BEKREFTET | Pool-probe 5/5. B: 12 samtidige mot hengende tjener, ingen lekkasje. env-drift 15 og compose 40 grønne. `""` gir default (`envInt`). Ingen endring i `modules/situations`. |
| K3 e/1-4 derive | BEKREFTET | A: 12 000 strømmer lik main modulo `trip_id`. 20k hendelser: 52 ms mot 5 819 ms. 200k: 294 ms. |
| K3 e/5 «nå»-sted og no-store; 3 HealthKit-punkter DEFERRED | BEKREFTET, `json()` globalt PARTIAL er ærlig | A: 108 forespørsler, 0 `/personal/*` uten no-store, andre ruter identiske flagg på/av. X04-X06 drept. `intake.ts` er kun kommentar, 6 tester. |
| K3 e/6-7 DAV | DELVIS | B DV 6/6, D01-D10 og M10-M20 drept. Se LOW-3. |
| K3 e/8 invitasjon | BEKREFTET | B: identiske feilobjekter, 0 audit-rader, p50 1,207 mot 1,222 ms, ikke blokkert av radlås. `not_the_invitee` finnes ikke andre steder enn i kommentarer og tester. M30 overlever. |
| K4 felles låsrekkefølge | BEKREFTET | L01-L05 og X08 (lås etter nøkkelavlesing) drept av deterministiske kappløp. B: 25-80 kappløp per modus, ingen 40P01 eller hengning. Lås tas før autorisasjonsavlesing. |
| K5 flagg AV = main unntatt pool | DELVIS | Guards grønne (tabell under). Reconcile-rute 404 uten flagg. K4 og migrasjon 144 gjelder også med flagg AV (LOW-6). |
| K6 docs, gitleaks | DELVIS | `NOT VERIFIED` og `BLOCKED_EXTERNAL` er merket ærlig. Unøyaktighetene står i LOW-1, -3, -4, -6. |

## Kommandoer og tall (mine)

- **A `guards.sh`:** 11 filer / 293 tester (54 s) og 42 filer / 606 tester (121 s), alle grønne.
- **Guards i første kjøring:** wph1 7, wph2 12, D-420 6, tool-manifest 32, env-drift 15, compose-isolation 40, schema 22, erasure 3, d124 123, connector 28, migration-order 5.
- **Prober:**
  - Pool 5/5 (nøstet bruk: 1-2 feil og 8-9 OK på 1,2 s, pool intakt).
  - Routes 7/7.
  - Journal 8/8.
  - B wiring grønn på ren kode.
- **Probe-forventninger jeg rettet** (ikke produktfeil):
  - Pool: nøstet bruk gir en kaskade, ikke 10 feil.
  - Routes: `%2e%2e` normaliseres av `fetch` til `/health/ingest`, og `GET /` har `no-cache` også på main.
  - Journal: array i `request_params` blokkeres riktig av CHECK 23514.
- **gitleaks** `71a31d8b..HEAD`: 15 commits scannet, «no leaks found». Én ny fingerprint-linje i `.gitleaksignore`, for `924fc6ac` `SENTINEL_PASSWORD` l.26. To-forelder merge beholder hashen, og dokumentasjonen sier det riktig.
- **Nye `console`/`logger`-kall i produksjonsdiffen:** 0. `process.env` kun som default-parametere.
- **Eksisterende tester:** B kjørte 244/244 grønne på berørte filer og 159/159 på de nye wpg2c-filene.

## Mutanter

| Kilde | Kjørt | Drept | Overlevd |
|---|---|---|---|
| A (`mutation-results.json`) | 83 | 82 | 1 (M28) |
| B (`mutants.tsv` + `mutants2.tsv`) | 92 | 87 | 5 (M21, M30, M54, N12, N23) |
| Nye av meg (`lead-extra.tsv`, X01-X09) | 9 | 6 | 3 (X02, X03, X09) |
| Totalt | 184 | 175 | 9 |

- B hadde kjørt mutantene selv om notatene ikke sa det. Jeg stikkprøvde M13, M21, M30 og M54 (`lead-spot.tsv`) og fikk samme utfall.
- Ingen drap skyldes timeout eller syntaksfeil (sjekket i A sine logger).
- Overlevende vurdert: M21, M28, M30 og M54 er ekte testhull. M28 og M21 lukkes av reviewer-prober. N12 og X09 maskeres av DB-CHECK. N23 og X02 gir bare annen kode, og X03 er sikkerhetsnøytral med én eier. Ingen er ekvivalente i streng forstand.
- Byggerens eget tall: 131 mutanter, 129 drept.

## Pool-standard

Behold 30 000 ms. Hvis målingen på NAS viser kø over 10 s, øk til 60 s i stedet for å slå av med `0`. Ikke senk under 10 s.
- Migratoren tar én dedikert forbindelse for hele kjøringen (`migrator.ts:112-150`). Bare første `connect()` omfattes, og migreringsspørringer og `pg_advisory_lock` er ikke underlagt tidsavbruddet.
- G4 `withDomainAdvisoryLocks` begrenser lås-holdere til `floor(10/2)-1 = 4`, så minst 6 forbindelser er igjen til nøstede spørringer (`advisory-lock.ts` ca. l.60).
- Erasure, finance og memory holder én forbindelse per kall. Workeren bruker korte spørringer og transaksjoner.
- Verste tilfelle er at ≥10 samtidige holdere over 30 s nå gir en feil etter 30 s, der main hang for alltid.
- En 3 s spørring avbrytes ikke av en 1 s grense (probe).

## Ikke verifisert av meg

- Alt mot ekte HA, bil, iCloud, HealthKit og NAS (`NOT VERIFIED` og `BLOCKED_EXTERNAL`, riktig merket i runbook §10).
- Flere API-instanser (tverr-prosess-lås, DEFERRED).
- Rød-på-main for K4 og derive (jeg kjørte ikke main; L- og X08-mutantene viser at kappløpstestene er følsomme).
- `typecheck`, `lint` og `check:containment` (byggeren rapporterer exit 0).
- Full suite (inkludert `embedded-postgres-ipv4-contention`, utelatt etter instruks).
- A sine reconcile- og derive-prober og B sine prober 1-6 hviler på deres logger. Jeg kjørte dem ikke på nytt.

## Probe-mapper

- `/tmp/lead/G2c-review-A-probes/`: `NOTES.md`, `mutation-results.json`, `guards1.log`, `guards2.log`, `guards2-counts.txt`, `pool-run2.log`, `routes-run3.log`, `journal-run3.log`, `mut-M28-areconcile.log`
- `/tmp/lead/G2c-review-B-probes/`: `NOTES.md`, `mutants.tsv`, `mutants2.tsv`, `lead-extra.tsv`, `lead-spot.tsv`, `lead-mutate3.py`, `zz-g2c-review-b-*.test.ts`
