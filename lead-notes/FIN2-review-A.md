TS: 2026-11-26T05:37:45.963Z
VERDICT: MERGE ETTER FIKSER. Jeg fant 0 HIGH og 1 MEDIUM (Wallester livssyklusverb, reprodusert mot `main`), pluss 7 LOW og 5 INFO. Jeg fant ingen dobbeltbetaling, tapt betaling eller hengende reservasjon i K1–K9-banene.

## Funn (rangert; fil:linje mot HEAD 61f68c51)

**MEDIUM-1: K7 er for streng på Wallester livssyklusverb (activate/block/unblock/close), og kortets tilstand blir stående feil.**
- Kode: `wallester-transport.ts:302` `mapCard` krever `id` og `status`. Den brukes av `activateCard` (`:379`), `blockCard` (`:384`), `unblockCard` og `closeCard` (`:394`), alle med `mutation: true`. `card-service.ts:380-415` `lifecycleAction` har ingen `onCallError`, flagg eller hendelse.
- Probe: `zz-fin2-review-a-lawful.test.ts` W1–W4, differensial mot `main`. Svaret er 2xx med tom kropp, `{}`, kun `{status:"Blocked"}` eller `{card:{id,status}}`.
  - `main`: `frozen`, hendelser `requested,frozen`.
  - HEAD: `ProviderResponseInvalidError: outcome_unknown:provider_response_invalid:id_missing`. Kortet står `active` i Jarvis, kun hendelsen `requested`, ingen flagg, mens Wallester har utført handlingen.
- Konsekvens: en fryseaksjon eller utelåsning er ikke registrert lokalt. Et spend-aktiverende verb gir motsatt avvik.
- Svarformen er `unverified`, og koden sier selv at PATCH-svar kan være tomme (`wallester-transport.ts` `request`).
- Fiks, minimal: i `lifecycleAction` fanges `ProviderResponseInvalidError` fra livssyklusverbene. Da anvendes måltilstanden med `provider_state='unconfirmed'`, en `provider_error`-hendelse og et flagg, og feilen kastes etterpå (fortsatt `outcome_unknown`). Alternativt gjøres `id`/`status` valgfrie i `mapCard` kun for de fire PATCH-verbene (`optionalText`), og `createCard`/`getCard` beholder streng validering.

**LOW-1: `cancelVippsPayment` avhenger nå av credential-leverandøren selv for rent lokale baner.**
- Kode: `service.ts:2463` henter credentials før transaksjonen.
- Probe: `zz-fin2-review-a-regress.test.ts`, differensial. Kaster `getCredentials`, lykkes lokal avbrytelse av en aldri innsendt intensjon og no-op på terminal intensjon på `main` (`cancelled`), men feiler på HEAD (`infisical_down`).
- Fiks: les intensjonen først uten lås, og hent credentials bare når `provider_ref` finnes og tilstanden ikke er terminal (som `prefetchCredentialsFor`).

**LOW-2: Neonomics `listTransactions` feiler hele siden på ukjent eller manglende status.**
- Kode: `neonomics-transport.ts:358` (`status_unknown`).
- Probe: lawful-differensialen (`rejected`, `information`, `cancelled`, `reserved` og manglende status). `main` bokførte alt ikke-`pending` som `booked`, som var feil. HEAD feiler hele siden.
- Konsekvens: `banking-service.ts:335` stopper paginering og synk på ett avvikende element, hver sveiperunde. Dette er ikke dokumentert i runbooken.
- Fiks: sett elementet i karantene med flagg (`BANK_TRANSACTION_STATUS_UNKNOWN`) i stedet for å feile siden, eller dokumenter det og gi varsel etter gjentatte feil. HEAD er riktig for `PENDING` med store bokstaver (pending, ikke booked).

**LOW-3: K1-kildevakten er navnebasert og kan omgås.**
- Kode: `fin2-no-provider-io-in-tx.test.ts:28` `PROVIDER_METHODS`.
- Probe: `zz-fin2-review-a-guard.test.ts` kjørte 14 omgåelser; 9 ble ikke fanget.
  - Ikke fanget: Fiken `listContacts`/`listBankAccounts` på annet variabelnavn (metodene mangler i `PROVIDER_METHODS`), `fetch` via alias, `globalThis.fetch`, hjelpefunksjon med I/O, `this.<egen metode>` utenfor `IO_SERVICE_METHODS`, `await import()`, `getCredentials` via destrukturering eller `['getCredentials']`, manuell `pool.connect()+BEGIN`.
  - Mutantene M56 og M57 overlever av samme grunn.
- Kjøretidsprobene dekker det delvis: M68 (leverandørkall flyttet inn i tx i `syncCardState`) ble drept av `fin2-no-lock-card-bank` alene.
- Fiks: legg `listContacts` og `listBankAccounts` til i listen, og dokumenter at vakten er navnebasert.

**LOW-4: To testhull som ikke er ekvivalente (mutantene overlever byggerens tester).**
- M19: `createVippsRefund` kan avgjøre tilstanden før nøkkelen. Byggeren tester rekkefølgen kun for Stripe-refusjon.
- M01: intensjonslåsen først i `submitVippsCapture.apply` (`service.ts:2366`) er ikke assertert.
- Begge drepes av mine to tester i `zz-fin2-review-a-regress.test.ts` (M19b og M01b). Ta dem inn i byggerens filer.

**LOW-5: Foreldet kommentar.** `call-signal.ts:32` (DEKNINGSGRENSER) sier fortsatt at finanstransportene har eget signal og at preflight og re-arm mangler frist og signal. Begge er nå lukket.

**LOW-6: Feil veiledning i penge-runbook.**
- Kode: `FINANCE_D_CHAIN.md:253` (§11.3 C) sier at `finance_vipps.submit_refund` «krever settled-capture og går som vanlig».
- Faktisk: `createVippsRefund` krever at intensjonen er `settled` (`service.ts:2518`). Ved delvis capture står intensjonen `provider_acknowledged`, og refusjon via Jarvis feiler med `PaymentIntentNotSettledError` (min probe «INFO: delvis capture ... KAN IKKE refundere»).
- Ordlyden bør rettes. K5-målet «refusjon kan alltid gjøres» er dermed ikke nådd for delvis capture. Det er eierens valg (Q-forslag K5b), men teksten må ikke love det.

**LOW-7 (nesten INFO): `flagCancelConflict` undertrykker hendelsen når flagget alt finnes.**
- Kode: `service.ts:2005` sjekker flagget `PROVIDER_STATE_CONFLICT`, ikke hendelsen. Står flagget fra en annen årsak, skrives aldri `anomaly_flagged`-hendelsen med `captures`-metadata. Test: «INFO: hendelsens årsak undertrykkes».
- Fiks: sjekk hendelse på `metadata->>'reason'` som `recordSucceededAfterLocalFailed`.

**INFO**
- **I-1, Vipps `createPayment`.** Svaret `{reference, redirectUrl}` er ifølge byggeren dokumentert, og leverandørdokumentasjonen var ikke hentbar for meg. Mot det feiler både `main` og HEAD: `main` med TypeError i `service.ts:703` (`amount.value`) og HEAD med `outcome_unknown:...amount_missing`. Sluttilstanden er lik (draft + `SUBMIT_OUTCOME_UNKNOWN`), så dette er ingen regresjon. Svaret på overstrenghetsspørsmålet: ja, et dokumentert svar feiler, men også før K7. Integrasjonen er ubrukelig mot dokumentert respons før aktivering (`BLOCKED_EXTERNAL`). Fiks: krev kun `reference` (lik forespurt), og les state og beløp med `getPayment`.
- **I-2, Stripe-refusjon.** `status: null` eller `payment_intent: null` gir `outcome_unknown` på HEAD, og `main` aksepterte det. Nullbarhet er `unverified`. Behold, men sjekk i sandkasse.
- **I-3, delvis capture.** Normalflyten (capture en del, resten utløper) gir en evig `provider_acknowledged` med `PROVIDER_STATE_CONFLICT`. Cancel av resten er blokkert, noe som er D-41-relevant. Eierens valg (Q-K5b), men avklar før Vipps aktiveres.
- **I-4, `refreshStripeRefundState` mangler ordensvokter** (`service.ts:1748`). En vinnende webhook kan gi et falskt `WEBHOOK_STATE_CONFLICT`-flagg, men aldri overskriving, siden tilstandsmaskinen blokkerer terminal. Ingen penge-effekt.
- **I-5, K8 manuell disposisjon.** Den er kun admin-SQL, et dokumentert K10 DEFERRED.

## Byggerens påstander -> dom

| Påstand | Dom | Bevis |
|---|---|---|
| K5a: capture, `captured`-hendelse og fulloppgjør i én tx med intensjonslås først | BEKREFTET | Mine DB-prober. Trigger på `payment_intents` UPDATE `settled` gir rollback, `ProviderOutcomeUnknownError`, retry med samme nøkkel og nøyaktig én `captured` og én `settled`. 10 runder med 2 delcaptures og CAPTURED-webhook gir ingen deadlock. Leverandørkallet står uten tx (`idle in transaction`=0, `FOR UPDATE NOWAIT` lykkes). M01 drept av min lock-order-probe |
| K5b: aldri `cancelled` med oppgjorte eller uavklarte captures | BEKREFTET | 6 capture-konfigurasjoner x (eksplisitt cancel, 4 webhooks, 4 refresh) = 54 tilfeller grønne. Eksplisitt cancel gir typet feil uten leverandørkall. Konflikt skrives én gang. Revers-kappløp og delcaptures som summerer nøyaktig til beløpet er testet |
| K4: samme regel som `createPaymentIntent`, begge baner, feltnavn uten verdier | BEKREFTET | Samtidighet 10 runder på `ON CONFLICT` (nøyaktig én vinner). Identiske samtidige kall gir samme rad. Annen tenant gir ingen konflikt. Nøkkel avgjøres før tilstand (Stripe). Meldingen grep-sjekket. Ulik valuta og intensjon gir konflikt. Se LOW-4 for Vipps-refusjon |
| K6: tilstandsmaskin uendret, én anomalihendelse uten innhold | BEKREFTET | `state-machine.ts` er ikke i diff. 3 refresh gir 1 hendelse, ingen beløp eller valuta |
| K7: strengt og typet overalt, aldri undefined/0/NOK/PDNG | DELVIS | Min tabell: 26 metoder, 124 tester grønne (mangler, null, tom, feil type, negativ, brøk, 1e21, ekstra felt, HTML 200, tom kropp). Se MEDIUM-1, LOW-2, I-1, I-2. `banking-service.ts:246` (`?? "NOK"`) er ærlig dokumentert |
| K2: avbryter, ingen retry etter frist, delt Fiken-token overlever | BEKREFTET | 37 prober mot hengende lokal server per leverandør (11 metoder): ÉN forespørsel, serveren ser lukking, ingen forespørsel etter abort under backoff, allerede avbrutt kall sender ingenting. Fiken: kaller B overlever kaller A sin frist, én token-utveksling. `off` gir ingen signal. Kildevakt: M58–M60 drept |
| K3: frist på preflight/re-arm, eksisterende utfall, `off` = før | BEKREFTET | 8 prober: transport som ignorerer signalet, `timeout_ms` 0/-5/0.4/1, fullføring rundt fristen uten ubehandlede avvisninger, klasse C fortsetter med én mutasjon, kun `off` (alle skrivemåter) slår av. Merge-tree mot `origin/claude/wp-g1c-comms-rest` og `...wp-n1b-finance-serving-model`: begge rene (exit 0) |
| K8: reserve-then-execute, lease, flagg, `idempotent_external:false` | BEKREFTET (PARTIAL på leverandør) | Markøren committet før kallet og synlig fra annen tilkobling. Lease utløper mens første kall kjører: andre kall får `reconcile_required`, aldri nytt kall. 4 samtidige + 503 gir ett kall. 4xx gir rent draft. 408/409/uklassifisert/2xx-ugyldig gir flagg. Lokal lagringsfeil gir flagg. Admin-SQL fungerer. Manifest-vaktene er grønne. `integrations.ts`-diffen er kun `submit_card` |
| K9: card_id, tenant-predikat (4 steder), refund-refresh | BEKREFTET | Superbruker-probe: ingen cross-tenant-endring. M22–M29 drept (unntatt M28, se under) |
| K1: tabell i §11.1 og vakter | DELVIS | 19 av 19 linjehenvisninger stemmer (±1 linje). `cancelVippsPayment`-fiksen er ekte (se LOW-1). AST-vakten er svakere enn påstått (LOW-3). Kjøretidsproben fanger regresjon (M68) |
| K10: ingenting stille utelatt | BEKREFTET | Alle K10-punkter står i §11.4 |
| Flagg AV = `main`, ingen nye felter | BEKREFTET | Ingen nye flagg. Guards: `wph1-flag-off-selection-baseline`, `wph2-flag-off-main-parity`, `part3-tool-manifest`, connector-sdk, env-drift, d420, d398, wpj, comms manifest, `wpf1-*` i api/erasure/business: 24 filer / 492 tester, exit 0. Nye hendelser bruker eksisterende `anomaly_flagged` |
| Eksisterende tester ikke svekket | BEKREFTET | Ingen `skip`/`only`/`todo` lagt til. Ett navn og én fixture endret: 500 til 422 i `wallester-service.test.ts` (5xx er nå ukjent utfall og dekket av M33), og `{transactions: []}` i `wallester-webhook.test.ts` |

## Regresjon (kommando og tall)
- `vitest run --maxWorkers=2` som `postgres`, `timeout -k 5`:
  - `modules/finance/test` (uten mine prober): 47 filer / 1393 grønne.
  - `modules/tool-gateway/test/{wpk-,wpf1-,d392-,part3-,fin2-}`: 23 filer / 365 grønne.
  - Guards: 24 filer / 492 grønne.
- Mine prober, alle grønne: DB 80, K7-tabell 124, K2 37, K3 8, guard 1. Lawful-differensialen (11 scenarioer) og regress-differensialen (6, `main` mot HEAD) er rene observasjoner, ikke assertion-tester.
- Differensial mot `main`: 9 scenariofamilier (Vipps-opprettelse x3, Wallester x4, Stripe-refusjon x3, Neonomics-status x9, `cancelVippsPayment`), ikke alle 26 metoder x varianter. Aksept av Jarvis' forventede svarform er bevist for alle 26 metoder på HEAD.

## Mutasjoner
68 distinkte mutanter (M01–M68). De er kjørt 70 ganger, med 2 omkjøringer mot mine prober (M01b, M19b), ett eksakt tekstbytt hver, `--bail=1`, og kilden gjenopprettet med `git checkout` (`git status --short` tom). Alle kills er assertion-nivå, ingen transform- eller infrafeil.
- Drept av byggerens tester: 62.
- Overlevde: 6 (M01, M19, M28, M47, M56, M57).
  - M01, M19: reelle testhull. De drepes av mine prober (M01b, M19b).
  - M28 (provider_ref-revalidering i refund-refresh): defensiv og ekvivalent uten admin-endring av `provider_ref`.
  - M47 (`throwIfAborted` i `financeFetch`): ekvivalent med ekte fetch, siden et allerede avbrutt komponert signal ikke sender noe.
  - M56, M57: K1-vakt-omgåelser (LOW-3).
- Dekning: K5 (12 + M67 + 2), K4 (8), K6 (1), K9 (8), K8 (8 + M64, M65), K7 (7 + M61–M63), K2 (6 + M58–M60), K3 (4 + M66), K1 (M55–M57, M68).

## Ikke verifisert av meg
- Alle leverandørfakta (Stripe, Vipps, Neonomics, Wallester, Fiken): proxyen ga 403 mot `docs.stripe.com` og `developer.vippsmobilepay.com`. Svarformene (særlig MEDIUM-1, I-1, I-2) er `unverified` og trenger sandkasse.
- Ingen ekte nettverk, NAS eller produksjonslast. Deadlock er kun testet for interleavings i probene, ikke under reell samtidighet.
- Andre moduler med preflight og kort `timeout_ms` kan få avslag på en treg men fungerende preflight (delt kode). Ikke kartlagt.
- Lease-tid er testet med `submitLeaseMs`-valget, ikke med 120 s i sanntid.

## Probe-mappe
`/tmp/lead/FIN2-review-A-probes/`
- `NOTES.md`
- `zz-fin2-review-a-{db,k7,k2,k3,lawful,regress,guard}.test.ts` (ikke i worktreen)
- `mut/{mutants1.json, mutants.json, run-mutants.mjs, results.jsonl}`
- `lawful.jsonl`, `regress.jsonl`, `guard-evasion.txt`, `regress-*.log`, `run-*.log`
- `main-copy/` (git archive av `71a31d8b`)
- Worktreen er urørt: `git status --short` er tom og HEAD er 61f68c51.
