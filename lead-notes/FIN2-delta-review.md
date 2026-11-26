TS: 2026-11-26T10:22:13.732Z
VERDICT: MERGE. Begge de opprinnelige MEDIUM-funnene er lukket. Jeg fant 0 HIGH og 0 MEDIUM nye, kun 3 LOW og 5 INFO, som kan tas som oppfølging. Worktreen er ren (`git status` tom, ingen `zz-`-filer igjen) på `766ac671`.

**(1) Tidligere funn**
- **B F1, Vipps/Stripe K7 for streng: LUKKET.**
  - Capture/cancel/refund godtar `{}` og `{reference}`. `createPayment` godtar `{reference, redirectUrl}` med `state`/`amount` lagret som NULL. Stripe-refusjon godtar minimal kropp.
  - Ekte feil gir fortsatt `outcome_unknown`: liste, HTML, feil `reference`, `createPayment` uten `reference`.
  - Bevis: diff-probe, `fin2-minimal-response-contract` (219), `fin2-vipps-ack-and-locks` (28), mutanter D07/D08/D13–D18 drept.
- **A-1 = B F3, Wallester livssyklus: LUKKET (kode og probe), med forbehold under (L1).**
  - Tom kropp, 204, `{}`, `{status}` og `{card:{…}}` gir lokal måltilstand med `provider_state='unconfirmed'` og `confirmed:false`. JSON `null` gir nå samme utfall (main: TypeError). Liste, primitiv, sentinel og feil type er fortsatt `outcome_unknown`.
  - B-K8-4 er rød mot den gamle forventningen fordi fiksen virker. D30–D36 drept.
- **B F2/K8, attention-kø og A.1: LUKKET.** A.1 er hentet bokstavelig fra markdown og kjørt mot migrert Postgres (3/3 grønne):
  - frisk reservasjon gir 0 rader, gammel 1 rad, andre kjøring 0 (idempotent)
  - feil tenant 0, kort med `provider_card_id` 0, og neste `submit_card` gir nøyaktig ett kall
  - D46–D48 og D50 drept (D49 se punkt 5)
- **Neonomics ukjent status: LUKKET.** `rejected`, `information`, `cancelled`, manglende, `null` og tall gir `unknown`, lagret som `pending` med flagg `BANK_TRANSACTION_STATUS_UNKNOWN`, aldri bokført. `PENDING` med store bokstaver er nå pending (main: booked). Karantenen overflates i `bank_transaction_unmatched` (`open-loop-service.ts:869`, velger alle flaggede rader uansett status). D37–D43 drept.
  - Én ukjent status stopper ikke siden eller bokføringen av resten.
  - Ulempe: en `rejected` som aldri bokføres blir stående som karantene i attention-køen.
- **`expectId`/`expectStatus`/`expectCurrency` og sentinel: LUKKET** (D01–D06). Kun frie tekstfelt som `reason` kan fortsatt inneholde «undefined».
- **`flagCancelConflict`: LUKKET.** A sin INFO-probe gir nå 1 hendelse, og 4 årsaker gir 4 hendelser. D24 drept.
- **`cancelVippsPayment` og credentials: LUKKET.** B-K5-2 og A regress er nå lik main. D26–D28 drept.
- **Testhull:** M01 (D51), M19 (D52), M04 (D56) og M56/M57 med `listContacts`/`fetch` (D53/D54) er drept. I/O via ukjent hjelpemetode (D55) slipper fortsatt gjennom. Det er den dokumenterte «navnebasert vakt»-begrensningen.
- **Stale docs: LUKKET.** `call-signal.ts:33` er rettet. 12 av 12 fil:linje-henvisninger i docs stemmer. Testtall i docs stemmer mot kjøring (495 strict, 219, 52, 35, 28, 20).
- **De 37 røde originalprobene:** 38 røde i min kjøring, siden jeg kjørte A regress i tillegg. Alle er tilsiktede, ingen er regresjon.

| Probe | Røde | Forklaring |
|---|---|---|
| A k7 | 27 av 124 | ubrukte felt, Wallester tom kropp, Neonomics status: FIX-1/2/5 |
| A db | 2 | FIX-7 (én hendelse per årsak) |
| B fuzz | 6 | samme loosening som A k7 |
| B money | 2 | B-K8-4 og B-K5-2: fiksene virker |
| A regress | 1 | gammel lås-rekkefølge, tilsiktet (FIX-9) |

Grønne uendret: A k2+B abort 40/40, A k3 8/8, A guard 53/53, A lawful 11/11.

**(2) Nye funn**
- **L1 LOW, `close` rettes ikke av nattsveipet.** `card-service.ts:~406-418` og FIX-1-notatet sier at `sync_card_state` og nattsveipet bekrefter etterpå. Sveipet bruker `listCards(..., includeClosed=false)` (`wallester-sweep.ts:41`) og hopper over lukkede kort.
  - Scenario: `close` gir tom 2xx, men Wallester utførte det ikke. Da står kortet `closed` lokalt (terminal) mens det er aktivt hos Wallester, og ingen flagg settes før noen kjører `sync_card_state` manuelt.
  - Samme som main, så ikke en regresjon. For activate/block/unblock gjelder rettingen, men `syncCardState` snur da tilstanden stille (gyldig overgang, ingen `CARD_PROVIDER_STATE_CONFLICT`).
  - Forslag: ta med `closed` + `provider_state='unconfirmed'` i sveipet, eller rett kommentaren og dokumenter det.
- **L2 LOW, Vipps stale-CREATED-sveip og NULL-status.** `service.ts:2684-2692` krever `provider_status='CREATED' AND provider_status_updated_at < now()-24h`.
  - Etter `createPayment` i dokumentert form er begge NULL. `EXPIRED_PAYMENT_WITH_ACTIVE_INTENT` kommer da først etter at det daglige `syncPendingVippsPayments` har fylt status, altså opptil 1 sveip + 24 t senere.
  - Capture avvises med `PaymentIntentNotAuthorizedError(null)` til første webhook eller refresh.
  - Alle lesere tåler NULL: `reconciliation.ts:249-260`, `class-d-checks.ts:166`, zod nullable, `applyVippsPaymentOutcome`.
  - Forslag: `COALESCE(provider_status,'CREATED')` og `COALESCE(provider_status_updated_at, submitted_at)`.
- **L3 LOW (forsvarsdybde), capture sjekker ikke intensjonens tilstand.** `submitVippsCapture.prepare` (`service.ts:2364-2365`) sjekker kun `provider_status==='AUTHORIZED'`. En refresh som rapporterer AUTHORIZED etter lokal cancel skriver `provider_status` tilbake: AUTHORIZED har ingen tilstandsovergang i `applyVippsPaymentOutcome` (`service.ts:~2096`).
  - Bevis: SQL-tidslinje fra proben. Med en fake `getPayment` som alltid sier AUTHORIZED ender 2–4 av 60 runder `cancelled` + oppgjort capture. Alle er flagget `PROVIDER_STATE_CONFLICT`, ingen er stille.
  - Uten refresh i miksen: 0 av 360 runder. Ekte Vipps melder TERMINATED etter cancel, så dette er mest et fake-artefakt.
  - Forslag: krev `intent.state==='provider_acknowledged'` i `prepare`.
- **I1 INFO.** `acknowledgedFrom` krever JSON-objekt, så en legitim 204 eller tom 2xx på capture/cancel/refund blir `outcome_unknown` og retry gir samme feil. Må sjekkes i Vipps-sandkasse før aktivering.
- **I2 INFO.** `neonomics-sweep.ts` summerer ikke `quarantined`; karantenen er bare synlig i attention-køen.
- **I3 INFO.** `unconfirmed` gir ingen flagg; det er vurdert som akseptabelt.
- **I4 INFO.** Vipps-feltet `reference` må matche byte for byte (ingen normalisering), `unverified`.
- **I5 INFO.** §11.5 bruker `VERIFIED_SEARCH_SNIPPET` om en Vipps-fakta. Det er en eldre etikett, men ikke `unverified`.

**Feilretning per Wallester-handling ved tom 2xx:**
- Block/close: lokalt `frozen`/`closed`. Det er konservativt hvis Wallester utførte det (2xx betyr det). Hvis ikke, falsk sikkerhet til neste sync; for close er det L1.
- Activate/unblock: lokalt `active`. Uten bekreftelse kan kortet være blokkert hos Wallester, noe som gir avslåtte kjøp, ikke ekstra bruk. Sync retter det.
- Nødbremsen `freeze_card` blir ikke lenger liggende `active`.

**(3) Differensial mot main** (`71a31d8b`, 198 case, 25 metoder)

| Utfall main → HEAD | Antall |
|---|---|
| OK → OK | 108 |
| OK → ERR | 67 |
| ERR → ERR | 19 |
| ERR → OK | 4 (Wallester JSON `null`) |

- OK→ERR er bare ugyldige svar, `reference`-mismatch, `getPayment` uten `amount` (main ga `{}` rett inn i tjenesten), Neonomics uten valuta eller med ugyldig valuta, og Fiken med ugyldig id eller ikke-liste.
- Fiken-lister med gyldig positiv heltalls-id (tall eller siffer-streng), tom liste og ekstra felt er uendret og bevarer alle felt.
- På felt tjenesten bruker er det kun disse forskjellene:
  - Wallester `id`: forespurt id i stedet for `"undefined"`; `status ""` blir `unknown`.
  - Neonomics `PENDING` blir pending; ukjent blir `unknown`.
  - Vipps `createPayment`: `state`/`amount` blir NULL.
  - Stripe-refusjon er lik på `id`, `amount`, `currency`, `status` og `payment_intent`.
- Hver forskjell er forklart og trygg.

**(4) Deadlock og kappløp** (ekte Postgres, app-rolle med RLS, `zz-fin2-delta-race.test.ts`)
- **Strukturelt:** i transaksjonen som tar `FOR SHARE` skjer ingen UPDATE eller `FOR UPDATE` på `payment_intents`. Det er 1 slik tx og 19 setninger i spy-loggen, så S→X-oppgradering finnes ikke.
- **Lås-rekkefølge:** alle andre stier tar intensjon før capture (`apply`, `cancel`, webhook, `createVippsCapture`). Jeg fant ingen syklus. `releaseChildReservation` tar kun capture-raden.
- **Stress:** N=2/3/4/6/8 samtidige `submitVippsCapture` pluss cancel, 1–2 webhooks, `createVippsCapture` og refresh, med tilfeldig forsinkelse i leverandørkall. Omtrent 600 runder:
  - 0 × 40P01/55P03/serialiseringsfeil/pool-timeout
  - 0 hengende låser: `FOR UPDATE NOWAIT` lykkes etter hver runde
  - 0 `idle in transaction`
  - 0 dobbeltkall per capture
- **Leverandørkall:** står utenfor transaksjon og radlås (`pg_stat_activity` og NOWAIT mens kallet pågikk).
- **Forbehold:** testet med fakes, ikke ekte Vipps.

**(5) Mutanter** (56 egne: 51 drepte, 5 overlevde)
- **Drept:** sentinel, `acknowledgedFrom`, `expectNumericId`, `optionalId`/`optionalCurrency`, `reference_mismatch`, `state`/`amount`, `FOR SHARE` fjernet, `FOR NO KEY UPDATE`, `flagCancelConflict` uten dedupe, credentials i `cancelVippsPayment`, Wallester `unconfirmed`/id/status/body/block, Neonomics, karantene, Fiken, attention-lease, M01, M19, M04, M56/M57-varianter.
- **Overlevde:**
  - D22 `FOR KEY SHARE`: ekvivalent, fordi alle konkurrenter bruker `FOR UPDATE`.
  - D29 `status!`: ekvivalent.
  - D25 (dedupe uten årsak): testhull LOW, per-årsak er ikke pinnet.
  - D49 (attention uten `state='draft'`): testhull LOW, støy for ikke-draft kort.
  - D55 (I/O via ukjent hjelper): kjent begrensning for navnebasert vakt.
- Byggerens 64 mutanter (alle drept) kan jeg ikke bekrefte direkte. Mine 56 er et uavhengig sett, og det avkrefter ingenting av påstanden.

**(6) Integrasjon**
- **K3 uendret.** `gateway.ts` er ikke rørt i fiks-runden; kun `call-signal.ts` (kommentar). Differansen mot main er fortsatt +15/−2.
- **merge-tree.** `git merge-tree --write-tree` av `766ac671` mot N1b og mot G1c går rent (exit 0), og N1b mot G1c går også rent.
- **Gateway-tester.** Jeg kjørte `wpk-`, `wpf1-`, `d392-`, `part3-`, `fin2-`, `wpn1b-` og `g1c` på en midlertidig løsrevet worktree (766ac671 + N1b merget + G1c-patch): 24 filer / 375 tester, alle grønne. Worktreen er fjernet.
- **`.gitleaksignore`.** Patch-applisering av G1c oppå N1b ga en `.gitleaksignore`-hunk-konflikt. Det er en artefakt av metoden, fordi `merge-tree` er rent, og FIN2 rører ikke filen.
- **Regresjon på HEAD:** `modules/finance/test/fin2-*`, `neonomics-service`, `wallester*` og `modules/business/test/fin2-*`: 21 filer / 1090 tester, alle grønne.

**(7) Docs mot kode**
- **Runbook §0, §4, §11.1–11.6:** har ingen avvik jeg fant. §4/§11.3 C er rettet ærlig om at delvis capturet intensjon ikke kan refunderes via Jarvis.
- **`WPK_LEDGER_REMNANTS` §3:** stemmer.
- **Gitleaks:** 30 commits, `no leaks found`; `.gitleaksignore` er uendret mot `origin/main`; ingen nøkkelformede literaler i diffen.

**(8) Ikke verifisert**
- Alle leverandørfakta (Vipps, Stripe, Wallester, Neonomics, Fiken) er `unverified`. Dette gjelder særlig Vipps 2xx-kropp på capture/cancel/refund, Wallester PATCH-svar, `reference`-ekko og Stripe-nullbarhet.
- Ingen ekte nettverk, NAS eller produksjonslast.
- Full suite, typecheck og lint er ikke kjørt.
- Deadlock er bare vist under testinterleavings med fakes.
- Lease er ikke testet i 120 s sanntid.

Prober, mutanter og logger ligger i `/tmp/lead/FIN2-delta-probes/`. Fremdriftsnotater: `/tmp/pg-home/fin2-delta-notes/NOTES.md`.
