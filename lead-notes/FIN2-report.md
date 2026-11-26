TS: 2026-11-26T00:58:17.320Z
**Sluttrapport WP-FIN2 (D-486): pengesikkerhet i `modules/finance/**`**

`CORE_DEPENDENCY_DECISION_REQUIRED`: ingen. `HARD_EXTERNAL_BLOCKER`: ingen. Alt er `NOT VERIFIED` mot ekte leverandør.

**Gren og push**
- Gren `claude/wp-fin2-finance-integrity`, head `61f68c51`, pushet (`origin` = `https://github.com/FFrollerskis/jarvis-build.git`, `main` urørt på `71a31d8b`).
- 14 commits, 40 filer, +4480/−322. Ingen migrasjon (151/152 ubrukt), ingen nye flagg, ingen UI, ingen ny leverandør.
- Delt kode: `gateway.ts` +15/−2 i egen commit `40489a25`; `integrations.ts` kun `submit_card` (`idempotent_external: false` og ærlig beskrivelse).
- Commits i rekkefølge: K5 `57bba4e8`, K4 `60eb03bf`, K8 `67dd3699` og `d3dfe87d`, K7 `4af5759c`, K2 `70e584e9`, K1 `7a32321c`, K6 `34b71f82`, K9 `6172a74e`, K3 `40489a25`, K10-test `74bbdc51`, docs `21c0467d`, mutant-tester `82ae0e9e`, lint `61f68c51`.

**K1–K10: status, kode, test, rød-først**
Rød-først er antall tester som feilet mot gammel kode (`main` eller gammel semantikk).
- **K5 ferdig (22 tester, 13 røde).** `fin2-vipps-money-state.test.ts`.
  - (a) `submitVippsCapture` (`service.ts:2323`) gjør capture-oppgjør, `captured`-hendelse og `checkVippsFullSettlement` (`:2402`) i én transaksjon, med intensjonslås først.
  - (b) Cancel med oppgjorte eller uavklarte captures avvises uten leverandørkall (`CancelBlockedByCapturesError`). Webhook og oppfrisking gir `PROVIDER_STATE_CONFLICT` og intensjonen blir stående. `capturedFundsStatus` `:1985`, `flagCancelConflict` `:2002`, `applyVippsPaymentOutcome` `:2033`, `cancelVippsPayment` `:2460`.
  - «Delvis oppgjort» som egen tilstand er ikke bygget (eierens valg).
- **K4 ferdig (24, 16 røde).** `resolveChildIdempotency` `service.ts:302`, brukt av `createStripeRefund` `:1601`, `createVippsCapture` `:2273` og `createVippsRefund` `:2519`.
  - Sammenligner intensjon, beløp, valuta og `reason`; feilen lister feltnavn, aldri verdier.
  - Gjelder begge baner, og nøkkelen avgjøres før tilstandssjekken. Testet mot ekte Postgres, også samtidige kall.
- **K8 delvis (19, 11 røde; fire samtidige kall ga tre leverandørkall).** `card-service.ts:257/326/345`; `idempotent_external: false` i `integrations.ts:2616`.
  - Reserve-then-execute: `submitted_at` på kortet, flagget `CARD_SUBMIT_OUTCOME_UNKNOWN`, nytt forsøk blokkeres `submit_outcome_unknown_reconcile_required`. Ingen migrasjon trengtes.
  - `PARTIAL` fordi Wallester er `unverified` og manuell disposisjon er admin-SQL, ikke verktøy. SQL-en er kjørt mot ekte Postgres (`FINANCE_D_CHAIN.md` §11.3).
- **K7 ferdig (566 + 5 tester, 539 røde).** `provider-response.ts`, brukt i alle fem transportene. Mutasjoner gir `outcome_unknown:provider_response_invalid:<kode>`, lesinger en typet feil. Aldri `undefined`, `0`, `NOK` eller `PDNG` som standard.
- **K2 ferdig (24 + 7 + 8 tester, 19 røde).** `http.ts:25` `financeFetch` og `:32` `financeBackoff`; alle `*-tool-transport.ts` bruker `adoptCallSignal`.
  - Fikens delte token-utveksling (`fiken-transport.ts:127`) er frakoblet med `detachFromCallSignal`/`raceCallSignal`.
  - Bevist med hengende lokal server, én forespørsel per leverandør, ingen retry etter frist, og gjennom ekte `ToolGateway` (ledger `unverified`). `JARVIS_TOOL_CALL_ABORT=off` gir som før.
- **K6 delvis (9 tester, 3 røde).** `service.ts:1312` `recordSucceededAfterLocalFailed`.
  - Dagens oppførsel er låst: `failed` forblir terminal, `PAYMENT_INTENT_TRANSITIONS.failed = []`. Det skrives én `anomaly_flagged` med årsak `provider_succeeded_after_local_failed` (kun status og id).
  - Selve tilstandsendringen er `DEFERRED` med Q-forslag (under).
- **K1 ferdig (51 + 5 tester).** Kildevakt (AST, negative kontroller) og kjøretidsprobe for `CardService` og `BankingService`.
  - Vakten fant én ekte rest på `main`: `cancelVippsPayment` slo opp credentials i `prepare`, under radlåsen. Rettet (`service.ts:2460`).
- **K9 ferdig (12 tester, 11 røde).**
  - (a) `card-service.ts:697` `AND card_id = $3`.
  - (b) Tenant-predikat i `appendChainAnomalyFlags` (`service.ts:967`), `appendAnomalyFlags` (`:1329`), `appendVippsAnomalyFlags` (`:2751`) og `appendBankAnomalyFlags` (`banking-service.ts:602`; tillegg av samme funnklasse). Kildevakt mot `UPDATE ... anomaly_flags` uten `tenant_id`.
  - (c) `refreshStripeRefundState` (`:1730`, tre faser), med i `syncPendingStripePayments` (`:1924`).
- **K3 ferdig (5 tester, alle 5 røde mot `main` sin `gateway.ts`, tre henger til testfristen).** `gateway.ts:1560` `invokePreflight` med `withTimeout` og `invokeWithCallSignal`.
  - Klasse D avslås `preflight_failed:tool_timeout` før noe reserveres; klasse C som en kastet preflight; re-arm avslås og reservasjonen frigis.
- **K10 DEFERRED, dokumentert.** `FINANCE_D_CHAIN.md` §11.4, `maxPages` ved `card-service.ts:621/625/656`.
  - `resolve_submit_outcome` og avstemming på forespørsel (WP-S1/F1/H1), kontraktversjoner (migrasjon), Neonomics `direction`, Fiken-form og paginering, Vipps webhook-tidsvindu, kill switch uten `FOR SHARE`, `maxPages` uten tak.
  - Zod-beviset ble delvis: spend-skjemaene er `.int().positive()`, men Wallester-kortgrensene er kun `z.number()`. Fraksjon, 0, negativt og Infinity passerer zod; DB (`bigint` + `CHECK > 0`) avviser dem før noe sendes (`fin2-money-param-schemas.test.ts`, 3 tester).

**K1-tabellen kort** (full: `FINANCE_D_CHAIN.md` §11.1)
- Lukket før: 019-lesestier for Stripe/Vipps/Neonomics (D-462); 020 og 070 webhooks og `Number()` i parsere (D-462); 072 `credential_ref_resolver` (`integrations.ts:1950`); 097 Fiken-token (D-398) og Neonomics-rekkefølge (D-462).
- Lukket her: 018 finanstransporter og preflight/re-arm; 019 `submitVippsCapture` i én transaksjon og kort/bank (bevisgapet); 020 cancel med captures; 072 barne-idempotens; 097 Wallester-oppslag og strenge svar.
- DEFERRED: uforanderlige kontraktversjoner.

**Tester**
- `modules/finance/test`: 47 filer / 1393 grønne.
- `modules/tool-gateway/test` (hele katalogen): 146 filer, 145 grønne (2101 tester). Eneste røde er `wpc3-review1-hardening` F10a/b/c, kjent sandkassefeil (git «dubious ownership» når testen kjører som `postgres`).
- `erasure`/`business`/`api` `wpf1-*`: 5 filer / 36 grønne.
- Vakter (`wph1-*`, `wph2-flag-off-main-parity`, `connector-sdk`, `d420`, `comms` manifest, `d398-doc-banners`, `wpj-closure-matrix`): 27 filer / 639 grønne.
- Totalt 760 nye tester. Alt kjørt med 2 arbeidere som `postgres`-brukeren (`su postgres`), alltid `timeout -k 5`.

**Mutantsett: 42 kjørt**
- 39 i første runde: 36 drept, 3 overlevde.
  - Idempotens-sammenligning 8/8, cancel-vern 8/8, strenge hjelpere 6/7, signal-sammensetning 5/6; K8 3/3, K9 3/3, K6 2/2, K3 1/1.
- Overlevende og rettelse:
  - K7-6 (`allowNegative: false` er en død gren): direkte hjelpertest lagt til.
  - K2-6 (Fikens `raceCallSignal`): tidsvindustest lagt til.
  - K1-1 var en ugyldig kildevakt-mutant (fjernet I/O i stedet for å legge den til): erstattet av K1-2/3/4 (credential tilbake i `prepare`, leverandørkall i tx, kall under radlås fanget av proben).
- Etter rettelsene er alle 41 gyldige mutanter drept; K1-1 står som ugyldig.

**Statiske kontroller**
- `pnpm -r --workspace-concurrency=2 run typecheck` exit 0.
- `pnpm lint` exit 0, etter at jeg fjernet en `no-control-regex`-feil i `expectAccessToken` (`61f68c51`).
- `pnpm check:containment` exit 0.
- gitleaks over `origin/main..HEAD`: `no leaks found`.

**«Security surfaces» som trenger uavhengig gjennomgang**
- `gateway.ts:1560` (+15/−2) og kallestedene i preflight og `revalidateAfterRearm`; `integrations.ts:2616`.
- Retry-løkkene i de fem `*-transport.ts` og `http.ts:25/32`; Fikens token-deling `fiken-transport.ts:127`.
- K5-vernet: `service.ts:1985–2060`, `:2323–2420`, `:2460–2510`.
- K8: `card-service.ts:257–364`. K9b-hjelperne (de fire stedene over) og `provider-response.ts`.
- Konfliktrisiko: `gateway.ts` rundt `withTimeout` og preflight (G1c, N1b, T1 og AUTH2) er lav. `integrations.ts` kun rundt `submit_card`.

**Motsigelser (§3): bekreftet eller korrigert**
- Ledger 019 «Åpent» er utdatert: leverandørkall ligger utenfor transaksjon (`service.ts:1387/2115/2878`; kort og bank bevist av K1). Men vakten fant `cancelVippsPayment` utenfor de oppgitte linjeområdene.
- 020, 070 og 072 er lukket (D-462, `integrations.ts:1950`). 097: Wallester-oppslaget ble lukket først nå (K9a).
- `submit_card` var merket idempotent uten nøkkel: bekreftet og rettet. `FINANCE_D_CHAIN.md` §0 manglet stien til `apps/api/test/wpf1-webhook-status-mapping.test.ts`: rettet.
- Ordren sa «bevis at zod fanger det» for pengeparametre: delvis (se K10).
- Restpunkter jeg fant:
  - `banking-service.ts:246` kontovaluta `?? "NOK"` (Neonomics kontoskjema er `unverified`), `PARTIAL`.
  - Oppfriskingssveipet leser ikke `failed`-intensjoner.
  - Vipps `createPayment` krever `state` og `amount`, mens dokumentert svar er `{reference, redirectUrl}`; feiler lukket og må sjekkes mot sandbox.
  - `applyStripeRefundOutcome` (som K9c gjenbruker) har ingen ordens-vokter. Det var slik fra før.

**D-486-forslag (for leads dokument)**
1. Penge-tilstand er hele og forutsigbare: capture, hendelse og full-oppgjørssjekk i én transaksjon; aldri `cancelled` med oppgjorte eller uavklarte captures.
2. Barn-idempotens følger samme regel som `createPaymentIntent`.
3. Wallester `submit_card` bruker Jarvis' egen reservasjon (markør `submitted_at`, flagg, lease 120 s), ikke leverandørens idempotens. Manuell disposisjon er admin-SQL.
4. Leverandørsvar valideres strengt og feiler lukket. Vipps `createPayment` er strengere enn dokumentert.
5. Finanstransportene følger gatewayens kallsignal; preflight og re-arm har samme frist som utførelsen.
6. Tilstandsmaskinens terminalregler er uendret (K6).
7. Ingen leverandørfakta er `VERIFIED`; Stripe og Vipps er kun søkeutdrag.

**Ny status foreslått**
- JARVIS-018: `CODE_FIXED` for finans og preflight; WPK-grensene gjenstår.
- 019: `CODE_FIXED`, «Åpent» lukket.
- 020: `CODE_FIXED (delvis)`, K6 er `DEFERRED`.
- 070: `CODE_FIXED (delvis)`, Wallester-zod er `DEFERRED`.
- 072: `CODE_FIXED`.
- 097: `CODE_FIXED (delvis)`, kontraktversjoner og kontovaluta gjenstår.

**Q-forslag til eieren** (tekst i `FINANCE_D_CHAIN.md` §11.4)
- **K5b:** skal en delvis captured og så avsluttet Vipps-intensjon få egen sluttilstand? Hva Vipps' cancel gjør etter delvis capture er `unverified`.
- **K6:** (a) `payment_failed` som ikke-terminal for Stripe, (b) tillat `failed → settled` kun fra Stripe `succeeded`, (c) la sveipet også lese `failed`-intensjoner.
- **K8:** gjøres `submit_card` gjenopptakbar uten eierens sjekk, forutsatt at Wallester dokumenterer en idempotensnøkkel eller oppslag på `external_reference`?

**`NOT VERIFIED` og `BLOCKED_EXTERNAL`**
- Hele pakken er ikke kjørt mot Stripe, Vipps, Neonomics, Wallester eller Fiken. Vipps sandbox er nødvendig for `createPayment`-formen.
- Wallester-adferd (idempotens, svarformer, beløpsenhet) er `unverified`; `docs.stripe.com` og Vipps-dokumentasjonen var ikke hentbare direkte.
- Delte docs er urørt. Docs-vaktene `d398-doc-banners` og `wpj-closure-matrix` er grønne.
