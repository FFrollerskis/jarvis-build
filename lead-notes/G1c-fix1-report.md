TS: 2026-11-26T05:31:21.635Z
**Ny tipp: `c1aafe10`, pushet (ja).** Gren `claude/wp-g1c-comms-rest`, worktree ren, remote `FFrollerskis/jarvis-build`. Alle 11 punkter er rettet eller merket `DEFERRED`/`PARTIAL`.

**Commits siden `f43f06e6` (15):** `90e5beeb` (FIX-1), `0e8bb6de` (FIX-2), `533f94cc` (FIX-3), `a934c5c6` (FIX-4), `fe409e22` + `9220f48f` (FIX-6/5), `33f55567` (FIX-7), `4c86e7f6` (FIX-8), `c99116f4` (413-logging), `235bd31a` (FIX-9), `65a47271`, `15849aa5` (docs), `a1103c56`, `c1aafe10`.

**Status per FIX**
- **FIX-1: ferdig.** `WEBHOOK_MAX_BYTES_BY_PROVIDER` (Meta 4 MiB, øvrige 256 KB) gjelder før signatur. 413 logges med leverandør og årsakskode, og en loggfeil endrer aldri svaret. Test: `wpg1c-webhook-body-limit` (signert 1000-batch gir 200 og STOP registrert). Rød-først: 4 av 8 feiler på `f43f06e6`. Meta-grensene er `unverified`, og K3 står som LUKKET.
- **FIX-2: ferdig.** `knownEventKeys` hopper over duplikater i én spørring, og kun nye skrevne hendelser teller mot taket. 503 betyr at det gjenstår nye hendelser. Test: `batch-progress` (2500 hendelser, STOP sist, ferdig på tre forsøk). Rød-først: 5 av 6 feiler.
- **FIX-3: ferdig.** Tie-margin 5 s på DB-klokke (`stop_db_at` og `recv_db_at`). Matrisen gir 0 frie mottakere ved gap 0/1/2/3/5/8/12 ms og samtidig oppstart, begge rekkefølger, 60 runder hver (150 i en egen kjøring).
  - På `f43f06e6` var 13/11/2/2 av 60 frie ved gap 0/1/2/3 ms, og 17 og 20 av 60 ved samtidig oppstart.
  - As orakel kjørt mot HEAD (ren sekvensmodell, 3 seeds × 200 runder × 2 tenants = 1200 scenarioer): 0 avvik, 0 uventede.
  - Åtte eksisterende testfiler kjører med `startTieMarginMs: 0`; produksjonsmarginen bevises i `stop-start-overlap`.
- **FIX-4: ferdig.** Discord avvises som `recipient_invalid` hvis verdien ikke er en ren snowflake `^\d{17,20}$` uten trim. `legacy-notify-strict` kjører mot de ekte transportene. Rød-først: 3 av 9 feiler. Slack `U…` ble allerede blokkert (pinnet). Kanalnavn, worker og automasjonsverktøy er dokumentert som udekket (`DEFERRED`).
- **FIX-5: `PARTIAL`.** `db-privileges` pinner at TRUNCATE, `session_replication_role`, DISABLE/DROP TRIGGER og `setval` gir 42501, og at GUC-bypass er en KJENT BEGRENSNING. Runbook, DPIA §10.7 og 141-headeren er rettet til «vern mot kodefeil».
- **FIX-6: ferdig (a–g).** Nye filer: `db-privileges`, `optout-concurrency`, `contact-link-race`, X6-test i `stop-atomic`. `recordOptOutIn` er nå idempotent med `ON CONFLICT` i tillegg til låsen. Mutantene er drept av assertions, se mutanter under.
- **FIX-7: ferdig.** `assessPepper` avviser manglende, mellomrom rundt (ikke lenger trimmet), for kort, færre enn 10 ulike tegn og periodiske verdier. Boot-varselet har fast årsakskode. HMAC-nøkkelen er nå per formål og tenant (`hmac(purpose, tenantId, data)`).
- **FIX-8: ferdig, med avvik fra ordren.** WhatsApp-nøkler (`wa:msg`, `wa:status`) er alltid SHA-256, aldri rå `wamid`. Test `inbound-key-pseudonym` skanner alle `comms_*`-tabeller etter id og nummer (rått og base64): ingen treff. Se antakelse 16 under.
- **FIX-9: `DEFERRED`.** `contact-value-change` pinner dagens atferd, med ny runbook-seksjon og Q.
- **FIX-10: dokumentert, ikke bygget.** Atferden er allerede testet (`owner-undo`, `stop-start-order`, `migrations-upgrade`).
- **FIX-11: ferdig.** Alle nevnte linjer i runbook, DPIA og `PROCESSING_INVENTORY` er rettet. Mottaker-hash er `DEFERRED` med skisse til dobbeltlesing.

**Migrasjoner:** kun 141 rettet på stedet (`stop_db_at`, `recv_db_at`, trigger for monotoni, header). 142 og 143 er uendret, og ingen ny migrasjon. En sandkasse-DB som kjørte `f43f06e6` må gjenskapes. Opgradering fra main med health/home/guest-rader er grønn i `migrations-upgrade`.

**Tester** (som `postgres`, `--maxWorkers=2`):
- comms + api-ruter + conversation-graph + erasure: 75 filer / 882 tester, alle grønne.
- api-vakter + `env-drift` + `modules/core/test` uten ipv4-contention: 63 filer / 1093 tester. `embedded-postgres-port-lease` var rød én gang under last og er 71/71 grønn alene. `d420` og compose-/schema-vaktene er grønne.
- tool-gateway (inkl. `wpg1c-policy-denied-health`): 146 filer / 2104 tester, 2101 grønne. De 3 røde er de kjente `wpc3-review1-hardening` F10a/b/c.
- As `diff-main`-probe mot HEAD gir D1 identisk med main (ingen løftes), D2 0 frie (var 30 på main), D3 0 brudd. De STOP/START-forskjellene mot main som finnes med flagg PÅ er bevisste (marginen).

**Mutanter:** reviewernes åtte overlevende (S08, K03, K10, M05, M62, M63, M65, M66) er alle drept av en feilet assertion, ingen ved timeout. Av mine 31 nye mutanter (FIX-1 til 4, 7, 8) overlevde én (F2c, deferred-telling), og den døde etter en ny test. Gjenstående ekvivalente: M64/Y5, M03, M09c, M73, K04, H08.

**Statiske kontroller:** typecheck, lint og `check:containment` har exit 0, og gitleaks over `origin/main..HEAD` sier `no leaks found` (21 commits). `.gitleaksignore` er urørt.

**Nye antakelser til D-481 (fra nr. 8)**
8. Tie-margin Δ = 5 s på DB-klokke, strengt: en START innenfor Δ etter siste STOP løfter ingenting.
9. Meta-byte-grense 4 MiB og batch-tak 1000 nye hendelser (begge `unverified`).
10. 503 kun når nye hendelser gjenstår.
11. Discord-vakt: rått samsvar, ingen trim.
12. DELETE-vernet er `PARTIAL` (vern mot kodefeil) til en egen erasure-rolle finnes.
13. `recordOptOut` er idempotent i tillegg til låsen.
14. Pepper: minst 32 tegn og 10 ulike tegn, ikke periodisk, mellomrom avvises.
15. HMAC-nøkkel per (formål, tenant), JSON-kodet. Ingen ekte v2-rader finnes.
16. WhatsApp-nøkkel er SHA-256 uten pepper: STOP-mottak skal ikke avhenge av pepper, og rotasjon ville brutt dedupe. En HMAC-variant kan legges på senere med prefiks `wa:msg:hmac2:`.
17. Utgående `provider_message_id` er udekket (trengs for redigering/sletting).
18. Mottaker-salt er `DEFERRED` til dobbeltlesing.
19. `recipient_request` forblir uløftbar.
20. `CommsStore`-opsjonen `startTieMarginMs` finnes for testene.

**Q-forslag**
- **G1c-6 (oppdatert):** saltede mottaker-pseudonymer, med dobbeltlesing via `recipient_hash_version`.
- **Ny:** egen erasure-rolle (SECURITY DEFINER alene hjelper ikke).
- **Ny:** `resubscribe` som D-handling.
- **Ny:** innsyn og sletting per mottaker.
- **Ny:** kontakt-nivå-identitet for «samme kontakt, ulike verdier».
- **Ny:** worker-vakt og automasjonsverktøy (n8n/make/zapier).
- **Ny:** verifiser Metas batch, 3 MB, retry og svarfrist.
- **Ny:** verifiser `wamid` mot en ekte id, og vurder utgående `provider_message_id`.

**`NOT VERIFIED` / `BLOCKED_EXTERNAL`:** NAS-trinnene, Metas faktiske grenser og retry-vindu, om `wamid` koder nummeret, ekte pepper og vault-kjede, live leverandører, `embedded-postgres-ipv4-contention` (ikke kjørt), full suite (ikke kjørt) og jurist-gjennomgang. Ikke løst: FIX-5 er bare `PARTIAL`, og K4-verdiendring er ikke bygget.
