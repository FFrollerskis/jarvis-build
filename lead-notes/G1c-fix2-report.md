TS: 2026-11-26T09:34:38.911Z
Ny tipp-SHA: `84702cf2` (`84702cf284150eebad48b9907a7d8558307a67ca`), pushet til `origin/claude/wp-g1c-comms-rest`. Lokal og remote HEAD er like, og treet er rent. Det er 9 commits siden `c1aafe10`: `19ebc72f`, `484dd526`, `148ab56f`, `6baceccc`, `611ca6f3`, `cd57ca15`, `743e10bc`, `84702cf2`, pluss FIX-1 til FIX-4 fra forrige bygger (to av dem er allerede nevnt).

**FIX-1: ferdig** (`19ebc72f`, kun tester)
- Testene ligger i `stop-start-overlap` (positiv vei med alderet STOP-rad, `clock_timestamp` mot `now()`) og `batch-progress` (kjent per tenant og leverandør).
- Rød-først: N15b, N20 og N26 overlevde hele comms-suiten på `c1aafe10`. Alle tre er nå drept. N27 er kun ytelse.

**FIX-2: ferdig** (`6baceccc`, `611ca6f3`)
- `apps/api/src/http-guard.ts` har `readRawBodyGuarded` og `WebhookBodyGuard`, og `server.ts` bruker dem. Lesefristen er 15 s og grensen er 4 samtidige kropper over 256 KB (den femte får 503 `webhook_busy` med `Retry-After: 5`). Verdiene kan bare settes i test via `ApiDeps.comms.webhooks.bodyRead`.
- Produksjonskode er 75 linjer i `http-guard.ts` og 19 endrede linjer i `server.ts`, mest kommentarer. Kjernelogikken er ca. 40 linjer, så den ble ikke merket DEFERRED.
- Tester i `wpg1c-webhook-body-read`: 15 grønne. Det er enhetstester av lesefunksjonen, ekte HTTP-rute, 100 sykluser uten lekkasje og chunked-kropp med alle plasser tatt (lukkes uten statuslinje).
- Rød-først: den ekte ruten med gammel leser gir 5 av 5 røde i del B. Del A kan ikke kjøres mot gammel kode fordi funksjonen ikke fantes.

**FIX-3: ferdig** (`148ab56f`)
- Eget behandlingstak i `ingest.ts` (`maxProcessedPerRequest`, standard 5 x skrivetaket = 5000, konstanten `PROCESSING_CAP_FACTOR` i `parsers.ts`). Loggen har nå `reason`: `write_cap` eller `processing_cap`.
- STOP er unntatt behandlingstaket. En STOP som står sist bak 30 ignorerbare START registreres i første forsøk og forblir registrert ved alle retry.
- Tester i `batch-processing-cap`: 8 stk, hvorav 5 av 7 var røde på `c1aafe10`.

**FIX-4: ferdig** (`484dd526`). Regexen er `^[1-9]\d{16,19}$` i `legacy-notify-guard.ts`, og samme svakhet er rettet i `channels.ts`.
- 3 assertions var røde først.
- Om Discord selv normaliserer ledende null er `unverified` (ingen nett).

**FIX-5: ferdig** (`cd57ca15`, `84702cf2`)
- Runbooken har nå alle pepper-reglene. En `\n` fra en fil gir `comms_content_pepper_invalid` og fail-lukket utsendelse.
- Påstandene om lesefrist, behandlingstak og Discord-regex er rettet, og DPIA er oppdatert. PROCESSING_INVENTORY er uendret fordi ingen påstand der berøres.
- Jeg la til en ærlig «Avveining»: grensen på 4 er global og gjelder uautentiserte forespørsler, så en fiendtlig klient kan gi 503 til store Meta-batcher over 256 KB. Små kropper berøres aldri.

**FIX-6: ferdig** (`743e10bc`). Hele `stop-atomic` bruker nå en pool med `lock_timeout` 5 s. Reviewerens mutant M62 gir 6 av 7 røde tester med `canceling statement due to lock timeout` på 33 s, mot 160 s før. Normalkjøring er 7 grønne på 5,7 s. Ingen assertions er endret.

**INFO (uendret, dokumentert i runbook §7):** chunked kropp over byte-grensen gir tilbakestilt forbindelse i stedet for 413. Fremtidsdatert `stop_db_at` etter klokkehopp kan bare rettes av admin. Nullbredde-mellomrom (ZWSP) godtas i pepper. Discord-/Slack-kanalnavn, worker og automasjon er fortsatt DEFERRED.

**Mutanter: 60 totalt, 59 drept, 1 ekvivalent**
- N15b, N20 og N26 er drept.
- Fordelingen er FIX-1: 3, FIX-2: 21, FIX-3: 22, FIX-4: 13 og FIX-6 (M62): 1.
- Den ene overlevende er F3n (`??=` mot `=` på en litteral). Den er ekvivalent fordi skrivetak-grenen bryter ut av løkken rett etter.

**Statiske kontroller og tester** (kjørt som `postgres`, `--maxWorkers=2`):

| Kontroll | Resultat |
|---|---|
| `modules/comms/test` | 49 filer, 663 tester grønne |
| api-ruter og vakter (`wpg1-comms-routes`, `wpg1c-*`, `drive-runtime-*`, `part3-tool-manifest`, `wph1-flag-off-selection-baseline`, `wph2-flag-off-main-parity`, model-surface, env-drift, `wpg1c-policy-denied-health`, conversation-graph m.fl.) | 21 filer, 294 tester grønne |
| d212/d240/d339/d395/d420/remediation-2 | 25 filer, 473 tester grønne (d420 kjørt på nytt etter siste doc-edit) |
| `pnpm -r --workspace-concurrency=2 run typecheck` | 35 pakker, exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm check:containment` | exit 0 |
| gitleaks over `origin/main..HEAD` | 28 commits, `no leaks found` |

`.gitleaksignore` er urørt, og det er ingen ny migrasjon, pakke eller flagg.

**Nye antakelser til D-481 (fra nr. 21)**
21. Behandlingstaket er 5 x skrivetaket (5000), basert på 0,43 ms per hendelse i sandkassen. `UNVERIFIED` på NAS. Kjente duplikater teller ikke, STOP er unntatt.
22. En ignorert hendelse lagres aldri og blir aldri «kjent». En kropp med over 5000 ignorerbare hendelser gir derfor 503 ved hver retry. Dette er dokumentert, og kropper av den typen kan bare lages av noen som har app-hemmeligheten.
23. Lesefrist 15 s, maks 4 samtidige kropper over 256 KB og `Retry-After: 5`. Ingen miljøvariabel.
24. En chunked kropp over 256 KB som ikke får plass lukkes uten statuskode (som 413 på chunked).
25. Discord-snowflake har aldri ledende null, også i funnelens normalisering.
26. Hele `stop-atomic` kjører med `lock_timeout` 5 s.

**Q-forslag**
- Front-proxy-grenser på NAS (størrelse, lesetid, samtidighet). Dette er ukjent.
- Verifiser mot Discord om ledende null normaliseres.
- Ny: per-IP-grense for store lesinger, og kontooppslag én gang per forespørsel (begge DEFERRED).

**NOT VERIFIED**
- Front-proxyen på NAS.
- Behandlingstid for 5000 ignorerbare hendelser på NAS.
- Metas faktiske batch-, retry- og svarfristgrenser.
- Full suite og `embedded-postgres-ipv4-contention` er ikke kjørt.
- Ekte pepper og vault-kjede, og live leverandører.

Notater og mutantresultater ligger i `/tmp/pg-home/g1c-fix2-notes/` (`NOTES.md`, `mutant-results.jsonl`).
