TS: 2026-11-26T06:27:12.966Z
VERDICT: MERGE ETTER FIKSER. Begge MEDIUM fra forrige runde er lukket med bevis, og jeg fant 0 HIGH. Ett nytt testhull (N15b, MEDIUM) må tettes, og et par LOW-funn bør tas stilling til.

Alt er kjørt mot `c1aafe10` i `/home/user/jarvisbuild/.claude/worktrees/g1c-delta` (løsrevet, `git status` tom). Kommando: `su postgres … vitest run --maxWorkers=2 <filer>`. Prober og logger ligger i `/tmp/lead/G1c-delta-probes/` (`NOTES.md`, `mutants.py`, `mutants2.py`, `mutant-results.jsonl`, `moved-probes/`).

## (1) Tidligere funn -> status

**A#1 / B M1 del 1 (413 før signatur) – LUKKET.**
- A `RVA_K3_ROUTE`: batch på 439 034 B gir nå 200 (før 413), og tjenesten kalles.
- B W2b: 1001 hendelser (266 467 B) gir 503, og retry gir 200 med STOP registrert.
- B W4a: ugyldig signatur gir 401 uten DB-skriving.
- Min T6: deklarert Content-Length over 4 MiB gir 413 og logges med `{provider:"meta", reason:"payload_too_large"}`. Slack, Twilio og Telnyx har fortsatt 256 KB (mutant N06 drept).
- Chunked over 4 MiB logges, men klienten får tilbakestilt forbindelse i stedet for 413. Dette er pre-eksisterende (`readLimited` kaller `req.destroy()`).

**A INFO retry / B M1 del 2 (ingen fremdrift) – LUKKET.**
- T1: 2500 nye hendelser med STOP sist gir 503 (deferred 1500), 503 (500), 200. STOP er registrert i første forsøk, og alle 2500 er lagret.
- T2: 1000 kjente, 1500 nye og 700 ignorerte gir 200 i forsøk 2.
- A `RVA_K3_RETRY`: `[503,200,200,200]` med 45/45 STOP registrert (før 5 av 45 tapt).
- `knownEventKeys` (T4): tenant, provider og rom er isolert. 999, 1000, 1001, 1999, 2000, 2001, 3000 og 70 000 nøkler gir riktig sett.

**A#2 / B I5 (STOP vinner ved overlapp) – LUKKET.**
- A `stagger`, gap 0/1/2/3/5/8/12 ms: 0/60 frie ved hvert gap (f43f06e6: 9/5/1/3/0/0/0, main: 33/43/21/13/5/1/0).
- A `diff-main`: D2 0/40 frie (main 30), D3 0/30 brudd. D1 løfter ingen kilde, som er bevisst på grunn av marginen.
- Uavhengig oracle (A sin, patchet for `{seq,at}`-returen):
  - Margin 0 (ren sekvens): 3 seeds × 200 runder × 2 tenants = 1200 scenarioer, 0 avvik, 0 uventede, 0 deadlocks, 717 injiserte feil.
  - Produksjonsmargin: 1200/1200 ender avmeldt.
  - Deterministisk overlapp gir `finalOpted:true`.
- Semantikk:
  - En START innen 5 s løfter ikke (S1), og re-levering av en konsumert START løfter heller aldri (S2). Det er akseptabelt, og STOP-vinner er ønsket. En angriper med gyldig signatur vinner ingenting på det.
  - Klokkehopp (S3): en fremtidsdatert `stop_db_at` gir en rad som ingen app-vei kan løse. Triggeren tillater kun økning, og eier-angre gjelder bare `owner_recorded`. Bare admin kan rette det. Dette er fail-lukket, og jeg rangerer det INFO.
- Migrasjon 141:
  - A sin mig-probe 5/5 grønn: main 001-140 med health/home/guest-rader i 7 tabeller, deretter 141-143, trigger-matrise 24/24.
  - Fra tom DB er alle test-DB-ene i suiten grønne.
  - `stop_db_at` er nullable (NULL regnes som gammel og løftes). `recv_db_at NOT NULL DEFAULT clock_timestamp()` ligger på en ny tabell.
  - Migratoren har SHA-sjekksum, så en DB som kjørte gammel 141 feiler høyt (`migration_checksum_mismatch`), ikke stille.

**A#3 / B L3 (K7-hull) – LUKKET.** Alle åtte overlevende er drept av nye tester (detaljer under mutanter).

**A#4 (K4 verdiendring) – DEFERRED.** `contact-value-change` pinner atferden og er grønn, og runbook har seksjon og Q.

**A#5 / B L2 (DELETE-vern) – PARTIAL, ærlig dokumentert.**
- DPIA §10.7 (rad 310) sier «DELVIS».
- A `RVA_MIG_BYPASS`: TRUNCATE, `replica_role`, DISABLE/DROP TRIGGER, `setval` og `alter_seq` gir alle 42501.
- DELETE med erasure-GUC gir rowcount 1, som er den kjente begrensningen.

**A#6 / B L1 (notify-vakt) – LUKKET for Discord, med ett nytt unntak under.**
- Blokkert med `recipient_invalid`: `…/messages?`, `?x=`, `/../…`, `#x` og padded.
- Slack-kanalnavn, worker og automasjonsverktøy er DEFERRED og dokumentert.

**A#7 / B L7 (docs) – LUKKET.** B-NY-raden, PROCESSING_INVENTORY:77-78, DPIA-kvitteringen og K3/K7/K1-radene er rettet (stikkprøve). Runbook:39 er ikke rettet, se nytt funn 5.

**B L4 (pepper) – LUKKET.**
- `assessPepper` avviser 19 av 20 svake eller feilformede former, og aksepterer en 36-tegns sekvens og en trailing ZWSP (den periodiske sjekken er uavhengig av lengde).
- 0 av 15 000 tilfeldige verdier (base64 og hex) avvist.
- HMAC per (formål, tenant): uavhengig omregning stemmer for 14 av 14 kombinasjoner (inkl. tenant-id med skilletegn). Tom tenant kaster.

**B L5 (mottakerhash) – DEFERRED, dokumentert** (runbook:237, DPIA:276).

**B L6 (wamid) – LUKKET.**
- S6: realistisk Meta-batch (kontakter, statuser, context, errors). Skann av alle 9 `comms_*`-tabeller med `row_to_json` etter nummer (rått og base64), `wamid`, `HBgL` og conv-id gir 0 treff.
- Nøklene er `wa:msg:sha256:…` og `wa:status:sha256:…`.
- SHA-256 uten pepper er tilstrekkelig hvis wamid har ca. 80 bit tilfeldig del. Det er UVERIFISERT.
- Utgående `provider_message_id` ligger rått i journalen. Det er dokumentert.

**B L8 (`recipient_request`) – dokumentert, ikke bygget.** Atferden er testet.

**B I1-I4, I6, I7 – uendret.**

## (2) Nye funn i deltaet

1. **MEDIUM (testhull, ikke produktfeil): produksjonsmarginens positive vei er utestet.** Fil: `modules/comms/src/store.ts:404`.
   - Mutant N15b gjør at `stop_db_at < recv - margin` aldri er sann: ingen START kan da løfte en STOP skrevet av ny kode.
   - Den overlever hele `modules/comms/test` (49 filer, 347 s, rc 0) og API-rutetestene.
   - Alle tester som verifiserer løfting bruker `startTieMarginMs: 0` eller en legacy-rad med NULL.
   - Min probe `zz-g1c-delta-semantics` S1 dreper den (`liftedAfterAgedStop:false` under mutanten).
   - Minimal fiks: legg S1 i `stop-start-overlap`. Alder raden med `session_replication_role=replica` og `UPDATE stop_db_at = clock_timestamp() - interval '30 seconds'`. START skal da løfte, og en ny STOP med START rett etter skal være beskyttet.

2. **LOW-MEDIUM: 4 MiB for-signatur-lesing gir 13,6x minneamplifikasjon.** Fil: `apps/api/src/server.ts:1897`.
   - T5: 30 samtidige halvferdige kropper holder +110 MiB (3,67 MiB per forbindelse mot 0,27 for Slack).
   - Per-IP-grensen er 30/min og Node `requestTimeout` er 300 s, så opptil ca. 150 samtidige per IP, ca. 550 MB (min ekstrapolering).
   - Det finnes ingen lesefrist eller global grense for webhook-kropp. Front-proxy er ukjent.
   - Fiks: lesefrist på ca. 15 s og en global semafor (f.eks. 4 samtidige Meta-lesinger) for webhook-kropp. Alternativt aksepter og dokumenter restrisikoen.

3. **LOW: taket teller kun skrevne hendelser, så arbeid per forespørsel er bare byte-begrenset.** Fil: `ingest.ts:205`.
   - T3: 16 000 ignorerte hendelser (2,7 MB) gir 200 etter 6,9 s, det vil si 0,43 ms per hendelse.
   - 4 MiB blir da ca. 10 s på dev-DB, og NAS er trolig tregere. Det kan gi retry-storm mot Metas svarfrist (uverifisert), men gjelder bare signert Meta-trafikk.
   - Fiks: et eget tak på behandlede hendelser (f.eks. 5×cap) som gir 503.

4. **LOW (UVERIFISERT): Discord-regex tillater ledende null.** Fil: `legacy-notify-guard.ts:40`.
   - B sin guard-probe: `0123456789012345678` SENDES, fordi nøkkelen er forskjellig fra den avmeldte `123456789012345678`.
   - Om Discord normaliserer ledende nuller i URL-en er ikke sjekket (ingen nett).
   - Fiks: `^[1-9]\d{16,19}$`.

5. **LOW (doc): `docs/runbooks/WPG1_COMMS.md:39`** nevner bare «minst 32 tegn».
   - Mangler FIX-7-reglene: minst 10 ulike tegn, ikke periodisk, og mellomrom eller linjeskift rundt avvises (ikke trimmes).
   - En `\n` fra en fil gir `comms_content_pepper_invalid` og fail-lukket utsendelse.

6. **INFO:**
   - ZWSP og andre usynlige tegn godtas i pepper.
   - `stop_seq_up_huge: OK`: app-SQL kan sperre en START (kjent).
   - M62: X6-testen feiler rent alene (16 s, 55P03). Hele `stop-atomic` med `--bail` dør først av en eldre test-timeout etter 160 s.

## (3) Mutanter

**Mine 46 (N01-N46): 41 drept, 5 overlevde, og N15b ble kjørt ekstra (se N15 under).**
- FIX-1 (N01-N06): drept.
- FIX-2 (N07-N13): drept. N10 (`if(false)`, kjente hoppes ikke) er også drept.
- FIX-3 (N14, N17-N19, N21, N22): drept.
- ON CONFLICT og retry-løkke (N23, N24): drept.
- Discord-regex (N28-N33): drept.
- Pepper og HMAC-kontekst (N34-N40): drept.
- WhatsApp-hash (N41-N44): drept.
- Funnel-HMAC (N45, N46): drept.
- N15 («OR false») er ugyldig: ubrukt `$6` gir SQL-feil. Jeg erstattet den med N15b (se funn 1).

Overlevende, vurdert:

| Mutant | Vurdering |
|---|---|
| N16 (fjern `$7<=0`-grenen) | ekvivalent (kun testmodus) |
| N25 (fjern `tenant_id=$1` i `knownEventKeys`) | ekvivalent, FORCE RLS dekker |
| N20 (`now()` i stedet for `clock_timestamp()`) | LOW testhull, bare relevant ved lang låsekø før `nextSeq` |
| N26 (fjern provider-filter) | LOW testhull, prefiksene hindrer kollisjon i praksis |
| N27 (chunk-steg 1001) | LOW, bare ytelse, ingen funksjonell effekt |

Min T4 (probe) dreper N26 og N27 (resonnert, ikke kjørt mot mutantene).

**Reviewernes 8 overlevende: alle drept av nye tester.**
- S08 og K10a/b: drept av `db-privileges`.
- K03 og M05: drept av `optout-concurrency`.
- M62: drept av `stop-atomic` (se funn 6 for timing).
- M63, M65 og M66: drept av `contact-link-race`.

Mot reviewernes opprinnelige testutvalg overlevde K10a (`funnel-db` og `retention` alene), men den dør mot `db-privileges`.

**Test-diff:** ingen assertion er svekket. De 8 filene med `startTieMarginMs: 0` har forklarende kommentar. Produksjonsmarginen testes i `stop-start-overlap`, men uten positiv løfting (funn 1). `batch-cap` 503-testen er erstattet fordi taket nå telles annerledes, og `batch-progress` dekker det ekte taket.

## (4) Flagg AV = main

- Guards: 20 filer og 329 tester grønne. Det dekker wph1/wph2 flag-off, drive-runtime-wiring, wpg1-comms-routes, wpg1c-legacy-notify-wiring, part3-tool-manifest, model-surface, env-drift, d212/d240/d339/d395/d420, remediation-2-*, wpg1c-policy-denied-health og conversation-graph.
- Baseline `modules/comms/test` pluss body-limit-testen: 49 filer, 659 tester grønne.
- `apps/api` typecheck: exit 0. `modules/comms` typecheck: kun 8 feil, alle i mine probe-filer (B-proben bruker gammel `hmac`-signatur), 0 i produksjonskode.
- A sin `diff-main`: D2 og D3 uten brudd. D1 er forskjellig fra main med flagg PÅ, som er den bevisste marginen.

## (5) Ikke verifisert av meg

- **Statiske kontroller:** gitleaks er ikke installert. Grov diff-skann etter nøkkelmønstre ga ingen treff, bare falske Twilio-SID-fikstur. Full `pnpm lint`, `check:containment` og full `pnpm -r typecheck` er ikke kjørt.
- **Ikke kjørt:** `embedded-postgres-ipv4-contention`, erasure-testene, full tool-gateway-suite og full suite.
- **Eksternt:** NAS, live leverandører og ekte pepper/vault. Metas grenser, retry og wamid-format. Discords håndtering av ledende nuller. Front-proxy-grenser.
- **Docs:** utover stikkprøven.
