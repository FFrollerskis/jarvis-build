TS: 2026-11-19T08:20:17.523Z
Fiks-runde 2 er ferdig: alle seks punkter er LUKKET. Det er ikke pushet. Det ene forsøket ga 503 («credential service temporarily unavailable»), så alt ligger lokalt.

**Ny head:** `c0aa2fb8` på `claude/wp-g1-comms`. Det er 8 commits over `d79b0434` (29 filer, +1084/−210), og arbeidsmappen er ren. Ingen ny migrasjon. Full suite er ikke kjørt, som avtalt.

**Per punkt**
1. **A-N1 + B-NY (STOP-absorpsjon), `65f4c950`, LUKKET.** Én aktiv rad per (tenant, navnerom, kanal, kilde). `account_ref` er internt kilde-spor, og listen viser fortsatt `*`. START løfter kun stopp-ord/leverandørfeil-rader på samme kanal, aldri eierregistrert.
   - Test: `stop-slots` (8 tester) med de tre sekvensene i begge rekkefølger. Fire mutanter feller den: felles kilde-spor, pre-sjekk uten kanal, START uten kanalfilter, START uten kildefilter.
2. **A-N2 (nøkkelgjenbruk), `13c01cf7`, LUKKET (A-M5 er nå LUKKET).** Eier-handlingslaget skoper nøkkelen til `<handling>:<tenant-merke>:<nøkkel>`. Den delte gatewayen er uendret.
   - Test: `key-scope` (5 tester) kjører alle 56 ordnede par av åtte handlinger med samme nøkkel; begge utføres uavhengig. Uskopet nøkkel feller den.
3. **A-M2 (relasjonsbevis), `7556bb98`, LUKKET.** Bevis er innkommende siste 7 døgn eller en lenke med `exact_email`, `exact_phone_e164`, `exact_handle` eller `owner_configured` og confidence ≥ 0,9. `contact_sync`, `manual` og lav confidence gjør ikke en mottaker varm.
   - Test: `relationship-evidence` (6 tester). Tre mutanter feller den.
4. **B-H1 rest, `7d960bc6`, LUKKET.** Ny graf-metode `linkExclusiveIdentifiers` gjør oppløsning, eierkontroll og skriving i én transaksjon bak lås per (tenant, rom), med etterkontroll av hver lenke. En feil midtveis ruller alt tilbake.
   - Test: `contacts` (+2 tester) med 12 runder `Promise.all`, og en DB-trigger som feiler den andre lenken.
   - Mutasjonsbevis: uten både lås og etterkontroll feller samtidighetstesten; skriving i separate transaksjoner feller atomisitetstesten. Fjerner jeg bare låsen eller bare etterkontrollen, består testene. Det er to uavhengige lag, og det er dokumentert slik i runbook §10.
5. **Tak på tvers av rom, `cea65ca8`, LUKKET.** Per-mottaker-taket og gjenspillingsvernet gjelder tenant-bredt. Kontotaket er fortsatt per konto. Tørrkjøringen teller samme tall som håndhevelsen.
   - Test: `caps-cross-room` (6 tester). Tre mutanter feller hver sin test.
6. **LOW, `2f35834a` og `9380d1a6`, alle LUKKET.**
   - B-NY: uvanlige meldings-id-er gir en stabil hash-nøkkel i stedet for en forkastet hendelse. Test: `inbound-keys` (3 tester).
   - A-N3: leverandør-id lagres også ved `outcome_unknown`. Test: utvidet A-M4-test i `outbound-integrity`.
   - A-N4: mottakerlåsen er nå testet med to kontoer og en deterministisk barriere i `caps-cross-room`.
   - A-N5: `record_opt_out`-teksten stemmer med koden, låst av en test i `stop-slots`.
   - Mutasjonsbevis for alle fire.
   - `Polly.Liv` er uendret og står som UVERIFISERT i runbook. Incidents-flaken er ikke rørt.

**Lead-avgjørelser og avvik**
- Alle fem avgjørelser er bygget: STOP-rader per (kanal, kilde), nøkkelskoping, strammere relasjonsbevis, kontaktlås og tenant-bredt mottakertak.
- Brukernøkkelen er nå maks 160 tegn (var 200), fordi den skopede nøkkelen må rommes i journalens 200. Nøkler på 161–200 tegn avvises med `idempotency_key_required`.
- `delete_message(K)` etter `send(K)` er nå en uavhengig forespørsel, ikke en kollisjon. Kollisjon gjelder bare samme handling. Jeg endret den gamle A-M5-testen tilsvarende.
- Reviewer A's probepakke ble kjørt mot grenen: 57 av 61 grønne.
  - Tre av de fire røde slår opp ledger på rå nøkkel og må bruke `scopedIdempotencyKey(tenant, action, key)`.
  - Den fjerde, `authorize_account(K)` så `send(K)`, forventer «ingen sending». Etter avgjørelsen sendes meldingen, uavhengig.
- Ingen avvik fra avgjørelsene. START-regelen og konfliktrapportering i synk-resultatet er uendret fra forrige runde.
- Et tidlig «overlevd»-resultat for A-N4 var en gammel vite-transformasjon, ikke et ekte funn. Mutasjonsløperen venter nå på ny mtime, og mutanten er bekreftet drept.

**Tester og kommandoer** (som `postgres`, `HOME=/tmp/pg-home`, maks 2 workers)
- Målrettet: 32 filer / 435 tester grønne.
  - Comms: 26 filer / 305 tester. Graf: 4 filer / 100. Ruter: 29. Comms-erasure: 1.
- Vaktbatch inkl. graf og `modules/erasure/test`: 32 filer / 403 tester grønne.
- `pnpm -r --workspace-concurrency=2 run typecheck`: 35 av 36 prosjekter, exit 0.
- `pnpm lint`: exit 0. `pnpm check:containment`: holder.
- Gitleaks `d79b0434..HEAD`: 8 commits, ingen funn.

**D-463-tekst, kun endringer:** «... policyen står foran hver NY `comms.*`-utsendelse; første kontakt med kald mottaker krever relasjonsbevis (innkommende siste 7 d eller eksakt/eier-konfigurert lenke ≥ 0,9, ikke kontaktbok-lenker) eller eierens `purpose_basis`; avmelding lagres per kanal og kilde (START løfter kun samme kanal, aldri en eierregistrert avmelding); per-mottaker-tak tenant-bredt på tvers av rom; idempotensnøkkel skopet med handling og tenant; kontaktlenking atomisk.»

**Nye eierspørsmål**
1. **Angre en feilregistrert STOP.** Ingen vei finnes i dag. Anbefaling: tillat angring kun av `owner_recorded`-rader, med step-up, begrunnelse og audit, aldri av `recipient_request`.
2. **Step-up for `record_opt_out`.** Er unntatt i dag. Anbefaling: behold registrering uten friksjon, og krev step-up bare for angring.
3. **START på hver kanal.** En mottaker som har stoppet på SMS og WhatsApp må sende START på begge. Anbefaling: behold, og la en jurist vurdere en «START alle»-regel.
4. **Kontaktbok-lenker regnes som kalde.** Bekreft at det er ønsket, siden eierens egne kontakter nå trenger `purpose_basis`.
5. **`Polly.Liv`.** Verifiser i sandbox, eller bytt standardstemme til en dokumentert norsk stemme.

Dokumentasjonen (runbook §3, §5, §6, §8 og §10, DPIA §10.2/10.5/10.7, inventar) er oppdatert i `c0aa2fb8`. Delte docs er ikke rørt.
