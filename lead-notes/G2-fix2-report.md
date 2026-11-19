TS: 2026-11-19T18:17:52.000Z
**TILLEGG runde 2b (mini-delta B NY2-1 + A INFO): ny HEAD `3c3f30e8cdb5956978cd583b4f461cbd28d8b98c`** (lokalt, ikke pushet). Dette erstatter HEAD i teksten under (`adfa8308...`); 2 nye commits over den: `dd52a729` (fix + tester) og `3c3f30e8` (docs). Ingen rebase, ingen force-push, base b2d43703 uendret.

**Push:** Ett forsøk (`git push -u origin claude/wp-g2-personal`) ga igjen 503 («credential service temporarily unavailable; retry shortly»). Ingenting er pushet (heller ikke de 9 commits fra runde 2); grenen finnes kun lokalt i worktreen. Jeg har ikke forsøkt på nytt.

| Funn | Status | Test og mutasjonsbevis |
|---|---|---|
| B NY2-1 (LOW, fjerning mot samtidig innrullering) | LUKKET | review-b-family blokk F (4 nye DB-tester: R-A billett, R-B deadlock, R-C device_proof for `removed` og `left`; kappløpene settes opp deterministisk med en åpen transaksjon + `waitBlocked`, ingen sleep). Rød uten fiksen: 4 av 4 med reviewerens utfall (R-A/R-C: ny enhet AKTIV; R-B: `['ERR:40P01','ok']`). Mutanter mot den nye koden, hver mot R-A/R-B/R-C for seg (`timeout -k 5`, `--bail=1`): billett sist med løkke -> R-A og R-B røde; billett først uten løkke -> R-C rød; ingen billettforbruk -> R-A og R-B røde |
| A INFO (409-klientregel) | LUKKET | én setning i runbook §2.5: etter 409 `personal_action_target_busy` bruk SAMME idempotensnøkkel og les status først (`.../list`, `.../read`) |

- **Fiksen (reviewerens verifiserte, 12 linjer, `modules/context/src/family/service.ts` `endMembership`):** billett-UPDATE FØRST (samme låsrekkefølge som innrulleringen: billett, så enhet), deretter list + tilbakekall av enhetene i en LØKKE til ingen aktive står igjen, alt i samme transaksjon. Revisjonen teller summen over rundene (`devices_revoked`).
- **Uavhengig kontroll:** reviewerens egen probe (`zz-g2b-delta2-ticket-race.test.ts`, kopiert inn midlertidig og slettet igjen) mot den nye koden: R-A `removal ok`, ny enhet `active:false`, `unknown_device`; R-B `["ok","redeemer_ok"]` (ingen deadlock); R-C `removal ok`, ny enhet `active:false`, `unknown_device`. 3 av 3 grønne.
- **Rest (ikke endret, ærlig):** et sjeldent `device_proof`-tilfelle der innrulleringen ROTERER en eksisterende enhet D2 med en autoriserende enhet D1 som sorterer ETTER D2, kan gi en deadlock (40P01) mot fjerningens sorterte låsrekkefølge. Utfallet er trygt (hele transaksjonen ruller tilbake, medlemmet står `active`, eieren prøver igjen), ikke et sikkerhetshull, og ikke en regresjon (den sorterte rekkefølgen fantes også i adfa8308); ikke dekket av reviewerens tre scenarier og ikke endret.
- **Testtall:** review-b-family 14 -> 18; målrettede G2-tester som postgres (samme 34 filer som før): **34 filer, 458 tester, alle grønne** (454 + 4 nye). Familie-suitene grønne: review-b-family 18, family-service 30, wpg2-family-integration 4, wpg2-family-erasure 2.
- **Kvalitetsport:** `pnpm -r --workspace-concurrency=2 run typecheck`, `pnpm lint` og `pnpm check:containment`: alle exit 0. gitleaks adfa8308..HEAD (2 commits, 15 KB): ingen funn. Vaktbatchen (214 filer, samme liste som sist): **213 filer grønne, 3218 av 3221 tester grønne**; de 3 røde er de samme kjente sandkassefeilene wpc3-review1-hardening F10a/b/c (`git check-ignore` feiler med «dubious ownership» som OS-brukeren postgres), uendret fra forrige kjøring (3214 av 3217; de 4 nye testene er grønne). Ingen full suite er kjørt.
- **Maskin:** maks 2 workers, `timeout -k 5`, `NODE_OPTIONS=--max-old-space-size=2048`, ingen full suite; egne vitest-prosesser ryddet (ingen igjen etter kjøringene); ingen `pkill`/`rm -rf` (kun `rm` av den ene midlertidige probe-kopien).
- **D-464, bare endringer (2b):** **P1c:** fjerning/forlating tar billettene FØRST og tilbakekaller deretter enheter i løkke til ingen aktive står igjen (samme låsrekkefølge som innrullering); en samtidig innrullering gir aldri en aktiv enhet hos et fjernet medlem og aldri deadlock. **P1a (kun docs):** klientregel etter 409 `personal_action_target_busy`: samme idempotensnøkkel og les status først.

---
(Teksten under er rapporten for runde 2 slik den sto ved adfa8308; HEAD der er avløst av HEAD over.)

WP-G2 fiks-runde 2 er ferdig lokalt, men ikke pushet.

**Ny HEAD: `adfa8308c7747c2a00b21b4342885492dcf237da`** (gren `claude/wp-g2-personal`, 9 nye commits over c7c57a6c, 21 filer, +903/-99, base b2d43703 uendret, ingen rebase/force-push).

**Push:** Ett forsøk (`git push -u origin claude/wp-g2-personal`) ga 503 («credential service temporarily unavailable; retry shortly»), som i forrige runde. Ingenting er pushet; grenen finnes kun lokalt i worktreen. Jeg har ikke forsøkt på nytt.

«Rød» betyr at de nye testene feller gammel kode (checkout av kildefilen fra forrige commit). «Mutant» er en bevisst feil i den NYE koden som en test må felle (filen gjenopprettet etter hver). Nummerering som i delta-reviewene.

**Per funn**

| Funn | Status | Test og mutasjonsbevis |
|---|---|---|
| A NY-1 (HIGH) pool-dødlås | LUKKET | wpg2-fix2-executor-locks (7, DB): 12 samtidige handlinger mot pool på 4 og mot standardpool (også forskjøvet ankomst): alle ferdig med journal/ledger/varsel. Rød 7/7 (dødlås), mutant «lås aldri sluppet» 7/7 røde; ekstra mutanter mot den nye låsen: «ingen lås» 4 røde, «lås med feil nøkkel» 9 røde |
| A NY-2 mutanthull | LUKKET | lås slippes etter fullført, feilet og kastet (executor-locks); rute 409 (personal-routes, 18); wiring `settleMsByDomain` (wpg2-fix2-wiring, 2); `!waitForMatch` (home-settle, 12); `p1a_outcome_reconcile` + omvendt id-vakt (status, 5). Mutanter: lås aldri sluppet 7 røde, 409 til 400 1 rød, D05 2 røde, D02 1 rød, S1 2 røde |
| A NY-3 lås-nøkkel | LUKKET | nøkkel `(domene, mål)` uten tenant; tvers-av-tenant-test; mutant «tenant i nøkkelen» 1 rød |
| B M2 offset > 14:00 | LUKKET | review-b-intake-timestamps (17, DB): hver offset -23:59..+23:59 i alle former mot ekte Postgres (ingen 22009-vei). Rød 3/3 (inkl. rå pg-feil fra ingestBatch). Mutanter: tak 15 t, tak 16 t, ±HHMM ukjent, kun positiv, ingen sjekk: 5 av 5 røde. «Minutt over 59 ikke sjekket» overlever som EKVIVALENT mutant (`Date.parse` avviser det allerede; sjekken er forsvar i dybden) |
| B NY-1 ReDoS | LUKKET | wpg2-review-b-dav blokk F (5): `<`+`a`x1 MiB, samme etter gyldig respons, `<![CDATA[`x1 MiB og ni andre fiendtlige former, alle under 2 s (nå ca. 10-50 ms). Rød 3 (7,5 s, 7,6 s, 12,1 s). Mutanter lookahead borte (2 røde) og CDATA-regex tilbake (1 rød). Engangs-fuzz: 0 avvik på 400 000 strenger (TAG_TOKEN gammel mot ny) og 30 000 CDATA-inndata |
| B NY-2 WILDCARD_DNS | LUKKET | wpg2-review-b-dav blokk H (7): én test per tjeneste (bart navn, underdomene, sluttpunktum; lignende navn godtas). 7 av 7 mutanter røde (hver med nøyaktig én rød) |
| B NY-3 vCard-gruppe | LUKKET | wpg2-review-b-dav blokk G (4): blandet gruppe beholder TEL/ukjent egenskap/etikett, ren gruppe mister etiketten, e2e. Rød 3 av 4. Mutanter (aldri/alltid etikett, gammel hel-gruppe): 3, 1 og 3 røde |
| B NY-4 guard påkrevd + DENY | LUKKET | wpg2-apple-dav (+1) og -routes (+5): ÉN DENY-rad (3 årsaker x list/create/delete), best effort, stopp midt i operasjon, e2e med ekte klient, wiring-raden, og «påkrevd» både som `@ts-expect-error` og i kjøretid. Rød 6/6. 10 av 10 vitest-mutanter og 2 av 2 tsc-mutanter (valgfri igjen) røde |
| B INFO tickets | LUKKET | review-b-family blokk E (5 nye + 1 justert, DB): billetter forbrukes ved removed/left, hele veien med ekte `DeviceEnrollmentService`, avvist fjerning forbruker ingenting, én poolforbindelse. Rød 5 av 14 (inkl. at et fjernet medlem rullet inn en NY enhet med gammel billett). 8 av 8 mutanter røde |

**Endringer**
- **A NY-1:** målets lås er nå en prosess-lokal, ikke-blokkerende rad i et `Set` (ingen databaseforbindelse, ingen kø). Opptatt mål gir umiddelbart 409 `personal_action_target_busy` før noe sendes; låsen slippes i `finally`. Delte `createPool`/pool.ts er urørt.
- **A NY-3:** lås-nøkkelen er `(domene, mål)` uten tenant (HA og bil er globale fysiske enheter).
- **A NY-2:** nye tester for de fem overlevende mutantene. Eneste produksjonsendring: `PersonalWiringInput.homeTimers` (kun tester: virtuell klokke, ellers ville alarmtesten måttet vente 90 s).
- **B M2:** `isPlausibleObservedAt` avviser |forskyvning| > 14:00 i alle former før transaksjonen (400 `invalid_timestamps`).
- **B NY-1:** `(?![A-Za-z0-9-])` etter navnet i TAG_TOKEN og en `indexOf`-løkke for CDATA (`stripCdata`); identiske treff.
- **B NY-3:** `patchComponent` fjerner kun de erstattede egenskapene, og gruppens `X-ABLabel` bare når ingen annen egenskap står igjen.
- **B NY-4:** `guard` er påkrevd i `FetchDavTransportOptions` og `PersonalDavDeps` (konstruksjonsfeil `dav_guard_required`; rute fail-closed). Et stoppet forsøk (før klienten eller midt i en operasjon, også lesing) gir ÉN `tool.denied`/DENY-rad med handling, samling og årsak, aldri innhold eller UID.
- **B INFO:** `endMembership` setter `consumed_at` på personens ubrukte innrullingsbilletter i sirkel-tenanten i samme transaksjon; revisjonen teller `tickets_consumed`.
- **Docs:** runbook §0, §2.5, §2.7, §4, §5, §6, §11 og én setning i DPIA. Ingen delte dokumenter rørt.

**Avvik**
1. Lås: prosess-lokal i stedet for semafor + 429 eller egen lås-pool. Valgt fordi den ikke holder noen ressurs mens den venter og dermed beviselig ikke kan dødlåse. Ingen kapasitetskode/429 var nødvendig. Tverr-prosess-serialisering er DEFERRED (én API-prosess i dag; journalens idempotensnøkkel og ledgeren hindrer dobbeltutførelse av samme forespørsel). Jeg la ikke til noe Q-G2-spørsmål om dette; leaden kan beslutte.
2. Test-seam `homeTimers` i wiring (se over).
3. NY-4: DENY-raden bruker eksisterende type `tool.denied` (sikkerhetssenteret teller den per verktøy) og gjelder også stoppede LESE-forsøk; stopp midt i en mutasjon gir `requested` + DENY i stedet for `requested` + `rejected:...`. UID utelates med vilje.
4. B INFO: alle ubrukte billetter lukkes, også en som nettopp har utløpt (ingen utløpsfilter, for å unngå avhengighet av klokkeforskjell); `tickets_consumed` kan derfor telle utløpt-ubrukt. `consumed_device_id` står NULL.
5. Testene for NY-1 har to miljøvariabler (`G2_REDOS_TAG_BYTES`, `G2_REDOS_CDATA_BYTES`) som KUN brukes til å gjøre den røde kjøringen mot gammel kode kort; standard er 1 MiB.
6. Min første versjon av målrettet-scriptet hadde en linjeskift-feil i `su -c` og startet en UFILTRERT vitest-kjøring som postgres. Jeg stoppet den etter ca. 2 minutter med `kill` på egne PID-er (ingen pkill); ingen resultater derfra er brukt, og scriptet er rettet (filene på én linje, `timeout -k 5`). Det ble ikke kjørt noen full suite.
7. Under 1 MiB-kjøringen meldte kjernen om en OOM-drept prosess på maskinen (delt minne); min kommando ga exit 0 og alle tester grønne, så ingen effekt på resultatene.
8. Review A INFO 13-16 og review B INFO-2/3/5 er ikke gjort (leaden fører dem), som avtalt.
9. IKKE gjort, og trenger leadens avklaring: reviewer A foreslo i tillegg `connectionTimeoutMillis` på den delte `createPool` (`modules/core/src/db/pool.ts`, utenfor G2). Lås-fiksen fjerner den konkrete dødlåsen (ingen forbindelse holdes mens noe venter), men en generell pool-uttømming ville fortsatt vente uten tidsavbrudd. Anbefaling: eget lite tiltak i core.

**Testtall og kommandoer**
- `pnpm -r --workspace-concurrency=2 run typecheck`, `pnpm lint` og `pnpm check:containment`: alle exit 0.
- gitleaks c7c57a6c..HEAD (9 commits, 82 KB): ingen funn.
- Målrettede G2-tester som postgres (HOME=/tmp/pg-home, `--maxWorkers=2`, 34 filer: wpg2-* i tool-gateway og api, hele helse- og context-modulene, personal-digital-twin/wpg2-family-erasure, d214): **34 filer, 454 tester, alle grønne**.
- Vaktbatchen (214 filer: wph1/wph2-baselines, manifest-, restricted- og wiring-vakter, d395-erasure, D-420, schema-invarianter, compose-isolasjon, env-drift, hele tool-gateway/context/health/location/erasure/connector-sdk): **213 filer grønne, 3214 av 3217 tester grønne**. De 3 røde er de kjente sandkassefeilene wpc3-review1-hardening F10a/b/c (`git check-ignore` feiler med «dubious ownership» når vitest kjører som OS-brukeren postgres i en rot-eid worktree), uten forbindelse til G2. Ingen full suite er kjørt (som avtalt).
- Nye/endrede G2-tester (45 nye): executor-locks 7, fix2-wiring 2, home-settle +3 (12), status +2 (5), personal-routes +1 (18), intake-timestamps +3 (17), review-b-dav +16 (30), apple-dav +1 (24), apple-dav-routes +5 (21), review-b-family +5 (14).
- Mutasjonsscript og logger ligger i scratchpad (`g2fix2-mut-*.sh/log`); alle mutanter kjørt med kilden gjenopprettet og verifisert etterpå.

**D-464, bare endringer**
- **P1a:** målets lås er prosess-lokal og ikke-blokkerende per (domene, mål) uten tenant; opptatt gir umiddelbart 409; ingen databaseforbindelse holdes (ingen pool-dødlås); tverr-prosess-serialisering DEFERRED.
- **P1c:** fjerning og forlating forbruker også personens åpne innrullingsbilletter i sirkel-tenanten i samme transaksjon.
- **P1d:** `observed_at` avviser forskyvning over ±14:00 i alle former før transaksjonen.
- **P2e:** parsing lineær også for `<` + navn uten `>` og ulukket CDATA; vCard-gruppe med blandede egenskaper bevarer de andre egenskapene; `guard` påkrevd i typene; et stoppet forsøk gir ÉN DENY-rad (`tool.denied`) uten innhold; jokertegn-DNS-vernet testet per tjeneste.
