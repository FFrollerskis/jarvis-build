TS: 2026-11-26T05:28:43.243Z
VERDICT: MERGE ETTER FIKSER. Ingen HIGH og tre MEDIUM (F1 for streng Vipps-svarvalidering, F2 falsk refusjonspåstand i runbooken, F3 Wallester freeze). Jeg fant ingen dobbel utførelse eller tapt betaling i noen probe. HEAD `61f68c51`, worktreen er ren etter at probene ble flyttet ut (`git status --short` er tom).

## Funn (rangert, fil:linje mot HEAD)

**F1 MEDIUM, K7 for streng på felt koden ikke bruker**
- `vipps-transport.ts:254` `paymentFrom` krever `reference`, `state` og `amount.{currency,value}` for alle fem Vipps-metoder.
- Tjenesten leser aldri svaret fra capture, cancel og refund. `apply` ignorerer `result` (`service.ts:2361`, `:2495`, `:2587`), og koden sier selv at en 2xx er oppgjøret.
- Et 2xx-svar med annen kropp (`unverified`, Vipps-docs kunne ikke hentes) gir `outcome_unknown:provider_response_invalid:*` for en capture eller refusjon som allerede har flyttet penger.
- Retry med samme Idempotency-Key gir samme kropp og dermed samme feil. Capturen står `draft` med flagg, cancel er blokkert (`capture_outcome_unresolved`), refusjon er umulig, og runbooken har ingen admin-SQL for dette.
- `createPayment` krever `state` og `amount` mens dokumentert svar er `{reference, redirectUrl}`. Byggeren meldte dette selv. `main` var like ødelagt (`amount.value` ga TypeError i `service.ts:703`), så K7 forverrer ingenting.
- Fiks:
  - Nytt `acknowledgedFrom(body, ctx, reference)` for capture, cancel og refund: krev `expectRecord`, og `reference` må matche hvis den finnes. Returtypen blir `{reference}`.
  - `createPayment`: krev kun `reference`. `state` og `amount` valideres bare hvis de finnes, ellers lagres NULL. Kolonnene er nullable (`040_stripe.sql:77-79`), og `applyVippsPaymentOutcome` tar allerede `number | null`. Første webhook eller refresh fyller dem.
- Mindre tilfelle (LOW): Stripe-refusjon krever `payment_intent` og `object`, som koden ikke bruker. `status` har allerede `??`-fallback i `service.ts:1704`.

**F2 MEDIUM, runbooken lover noe koden ikke gjør (K5b)**
- `FINANCE_D_CHAIN.md:100` sier «slik at `createVippsRefund` fortsatt kan refundere pengene som er tatt». §11.3 C (`:253`) sier at refusjon «går som vanlig».
- Det er falskt for delvis capture. `createVippsRefund` krever intensjon `settled`, og intensjonen står i `provider_acknowledged`.
- Probe `B-K5-1` ga `PaymentIntentNotSettledError ...:provider_acknowledged`.
- Etter K5b kan en delvis capturet intensjon verken kanselleres eller refunderes via Jarvis før resten er captured. Eieren ser feilen `cancel_blocked_by_captures:<id>:settled_captures` på cancel, eller flagg og én hendelse via webhook.
- Fiks nå: rett begge tekstene. Q-K5b må i tillegg spørre om refusjon mot oppgjorte captures på en ikke-`settled` intensjon.

**F3 MEDIUM, Wallester lifecycle-PATCH krever `id` som ikke brukes**
- `wallester-transport.ts:302` `mapCard` kreves for `activate`, `block`, `unblock` og `close`. `lifecycleAction` bruker kun `.status` (`card-service.ts:410`), og kortets id står allerede i URL-en.
- Builderens egen kommentar (`wallester-transport.ts:285`) sier at PATCH-svar kan være tomme.
- Probe `B-K8-4`: `freeze_card` med tom 2xx ga `outcome_unknown:provider_response_invalid:id_missing`, mens lokal tilstand ble stående `active`. Gjentatte freeze kan aldri flytte lokal tilstand.
- Frys er nødbremsen. Før K7 ble den registrert lokalt med `provider_state` «unknown».
- Fiks: `mapCard(body, ctx, {requireId:false})` for de fire PATCH-metodene. Godta tom kropp med `status: "unknown"`, samme verdi som runbook A.2 bruker. `sync_card_state` bekrefter etterpå.

**F4 INFO, K5 «aldri cancelled» er ikke garantert under samtidighet**
- Kommentaren i `service.ts:2063` («captures kan ikke endre seg») er usann for reservasjonen. `submitVippsCapture.prepare` leser intensjonen uten lås.
- Stress 60 runder (`B-K5-3`), to ganger: 18/60 og 10/60 runder endte med `cancelled` og oppgjort capture. Alle var flagget `PROVIDER_STATE_CONFLICT`, og ingen var stille.
- Dette krever en leverandør som godtar capture etter cancel. Ekte Vipps avviser det, så praktisk effekt er liten.
- Ingen deadlock ble sett.
- Fiks (valgfri): `FOR SHARE` på intensjonen før capture-låsen i `prepare`.

**F5 INFO, `cancelVippsPayment` slår opp credentials ubetinget (`service.ts:2461`)**
- Probe `B-K5-2`: en no-op-cancel på terminal intensjon kaster nå credential-feilen når leverandøren kaster. Samme gjelder kill-switch-avslag.
- `submitVippsCapture` og `submitVippsRefund` gjør allerede det samme, så dette er konsistent med eksisterende mønster.

**F6 INFO, K3 klasse C**
- Svar på brief punkt 3: klasse D er fail-lukket. Timeout gir `preflight_failed:tool_timeout` før `decision.commit` (`gateway.ts:1058` kommer før `:1066`), så ingen reservasjon og ingen nonce-brenning.
- Klasse C svelger kastet preflight (`:1057-1061`) og fortsetter uten før-tilstand. En treg lesing ≥ `timeout_ms` gir nå mutasjon uten snapshot for `reversible`-verktøy (`business.update_lead` m.fl.). Det er samme utfall som ved kastet preflight, men nå nåbart.
- Ingen autorisasjon kan oppstå fra timeout.
- Re-arm: reservasjonen frigis med `AND status='reserved'`-vern (`:1350`), så dobbel frigivelse er ufarlig. Nonce er allerede brent når re-arm-lesingen feiler (`:1066` kommer før `:1136`).

**F7 INFO/LOW, forhold ved K7-implementasjonen**
- `expectId` og `expectStatus` (`provider-response.ts:63`, `:109`) godtar strengen «undefined», «null» og «NaN». Fuzz fant 0,02-0,4 % av genererte svar, f.eks. `wallester.blockCard` 21 av 5000. Det er en enlinjes avvisning å legge til.
- Fiken-lesere (`listContacts`, `listBankAccounts`, `listJournalEntries`, `fiken-transport.ts:238-247`) er fortsatt `as T`. §11.1 sier «LUKKET HER (K7)» uten å nevne dem.
- `banking-service.ts:246` har `?? "NOK"`. Byggeren har selv oppgitt dette.
- Wallester list-metodene krever nå nøkkelen `authorizations` eller `transactions`. Fiksturen i `wallester-webhook.test.ts` ble endret fra `[]` til `{transactions:[]}` av samme grunn.
- Neonomics `listAccounts` validerer ikke valutaformat, den bare uppercaser.

**F8 INFO, K8 drift**
- En reservasjon uten flagg (krasj midt i kallet) vises ikke i attention-køen (`open-loop-service.ts:965` krever flagglengde > 0). Eieren oppdager den først ved neste innsending.
- Admin-SQL A.1 mangler alderspredikat. Foreslått: `AND submitted_at < now() - interval '5 minutes'` og en linje om å vente ≥ 2 minutter.

**F9 INFO, testhull**
- Ingen test pinner `idempotent_external:false` på `submit_card` (`integrations.ts:2616`, M04). Det er funksjonelt ekvivalent etter K8.
- K1-vakten er leksikalsk. Leverandør-I/O via en ny hjelpemetode inne i en transaksjon slipper gjennom både AST-vakt og kjøretidsprobe (M56). Proben dekker bare Card og Bank.
- `call-signal.ts:32` har en utdatert DEKNINGSGRENSER-kommentar som sier at finans og preflight mangler signal.
- Tall i §0 og §11 er utdatert: strict står som 564 (faktisk 566) og no-provider-io som 50 (faktisk 51).
- Forhåndseksisterende: non-2xx-feil bærer leverandørtekst i meldingen (`wallester-transport.ts:294`, `stripe-transport.ts:183`, `neonomics-transport.ts:280`). K7-kodene gjør det ikke (0 av ca. 100 000 K7-feil i fuzz).

## Brief-spørsmål, kort
- **(a) K8:**
  - Lease > 120 s gir bare en annen feiltype, aldri nytt kall (`B-K8-1`: 1 `createCard`, første kall fullfører og setter `provider_card_id`).
  - 20 samtidige kall over to tjenesteinstanser ga 1 leverandørkall (`B-K8-3`).
  - Runbook A.1 og A.2 er kjørt mot migrert DB og er riktige og ufarlige (`B-K8-2`, `B-K8-5`). A.2-kortet gikk gjennom `sync_card_state` til `active`, og et nytt `submitCard` ga ingen nytt kall.
  - Eneste kaller av `submitCard` utenom gatewayen er manuelle live-scripts. Ingen automatisk retry finnes.
- **(c) K4:** lik nøkkel gir samme rad, ulikt beløp, intensjon eller reason gir konflikt med kun feltnavn, og samtidige kall ga 1 rad (`B-K4-1`).
- **(d) K2:** abort midt i en 2xx-kropp er `outcome_unknown:...body_not_json`, klassifisert `unknown`, med 1 forespørsel (Stripe og Vipps, `zz-fin2-review-b-abort`).
- **(e) K9c:** `failed→succeeded` forblir `failed` med konfliktflagg, `settled` overskrives ikke, `pending` endrer ingenting (`B-K9-1`). Ingen leverandørmutasjon skjer.
- **K5-webhook:** TERMINATED×25 ga 25 × `processed` (200, ingen retry-storm), 1 hendelse og flagg satt (`failed_retryable` gir 502, `server.ts:1808`).

## Byggerens påstander mot dom
| Påstand | Dom | Bevis |
|---|---|---|
| K5a: capture, hendelse og oppgjør i én tx | BEKREFTET | M16 drept; stress 60 runder uten deadlock |
| K5b: aldri `cancelled` med captures | DELVIS | Cancel og webhook bekreftet (M09-M13, M17, M51 drept); «aldri» holder ikke i samtidighetsvinduet (F4); refunderbarhet falsk (F2) |
| K4 barn-idempotens | BEKREFTET | `B-K4-1`; M18-M23 drept |
| K8 reserve-then-execute (PARTIAL) | BEKREFTET | `B-K8-1,2,3,5`; M01-M03, M05, M06, M47-M49 drept |
| K7 strenge svar | DELVIS | Fuzz 25 metoder × 5000 = 125 000: 0 TypeError/Range/Syntax, 0 undefined/NaN, 0 sentinel i K7-feil, ingen prototype-forurensning; M28-M35, M52 drept; for streng på ubrukte felt (F1, F3) |
| K2 kallsignal | BEKREFTET | M36, M38, M39, M53 drept; M37 overlevde (kun latens, `throwIfAborted` hindrer ny forespørsel) |
| K3 frist på preflight/re-arm | BEKREFTET | M40-M44, M54 drept; klasse D avslag før nonce (F6) |
| K6 `payment_failed` | BEKREFTET | M25, M50 drept; runbooken sier åpent at en betalt betaling kan stå `failed` |
| K1 revisjon og lås | DELVIS | M45, M46 drept; linjetall i §11.1 stemmer; vakten er leksikalsk (M56 overlevde) |
| K9 småfunn | BEKREFTET | M08, M24, M55 drept; M26 overlevde (ekvivalent); `B-K9-1,2` |
| K10 DEFERRED komplett | BEKREFTET | Alle K10-punkter står i §11.4 |
| Ledger 018, 019, 072 `CODE_FIXED`; 020, 070, 097 `(delvis)` | FORSVARLIG | Så sant F1-F3 rettes; 097 beholder kontraktversjoner og kontovaluta som åpne |

## Mutasjoner
- 56 kjørt (`mutants.py`), 50 drept og 6 overlevd. Baseline: 14 fin2-filer / 760 tester grønne på ren HEAD (matcher byggerens tall).
- Overlevende:
  - **M04:** `idempotent_external` tilbake til true. Ikke pinnet av noen test, funksjonelt ekvivalent. Anbefalt: pin flagget i en test.
  - **M07:** flagget fjernes ikke ved suksess. Ekvivalent, siden flagget aldri er til stede da.
  - **M15:** intensjonslås fjernet fra `apply`. Stress 60 runder uten låsen ga ingen deadlock og ingen stille avvik, så mutanten er ekvivalent.
  - **M26:** referansevern i `refreshStripeRefundState`. Ekvivalent i praksis.
  - **M37:** backoff ikke avbrytbar. Kun latens.
  - **M56:** I/O via hjelpemetode (se F9). Reelt hull i vakten.
- Svake eksisterende tester: ingen skippet eller fjernet. Eneste endringer er 500→422 i `wallester-service.test.ts` (bevisst) og fiksturen i `wallester-webhook.test.ts`.

## Ikke verifisert av meg
- Alle leverandørfakta: Stripe, Vipps, Wallester, Neonomics og Fiken. Nettverket blokkerer docs (`ENOTFOUND developer.vippsmobilepay.com`, curl 000 mot `docs.stripe.com`), så alle svarformer er `unverified`.
- Differensiale prober mot en `main`-kopi er ikke kjørt, fordi jeg ikke kunne lage en ny worktree uten å røre refs. Flagg AV (`JARVIS_TOOL_CALL_ABORT=off`) er vist ved kodelesing, byggerens test og M40.
- Ikke kjørt: hele suiten, typecheck, lint og NAS.
- `isIndeterminateTransportError` og ledger-tilstand ved gateway-timeout er kun verifisert via byggerens `fin2-finance-gateway-abort` (7 tester, grønne), ikke med egen gateway-probe.
- Hvorvidt den ekte Vipps `capture` avviser etter `cancel` (som F4 er avhengig av) er `unverified`.
- Wallester kan returnere 4xx etter at kortet er opprettet. Det ville bryte «4xx rydder» (`unverified`).

Gitleaks (`71a31d8b..HEAD`): 14 commits, `no leaks found`; `.gitleaksignore` er urørt. Fikstur-tokens er bokstavelige men ikke nøkkelformede (f.eks. `sk-fixture-not-a-key`), ikke sammensatt som briefen ba om.

Probe-mappe: `/tmp/lead/FIN2-review-B-probes/` (`NOTES.md`, `mutants.py`, `results.jsonl`, `adhoc_m15.py` og probene `zz-fin2-review-b-{fuzz,money,abort}.test.ts`).
