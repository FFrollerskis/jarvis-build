TS: 2026-11-26T05:25:14.366Z
Ingen `CORE_DEPENDENCY_DECISION_REQUIRED` og ingen `HARD_EXTERNAL_BLOCKER`.

## Sluttrapport WP-G4b (verifikasjon og avslutning)

**Gren/tipp:** `claude/wp-g4b-situations-rest` @ `c28e2b85`, pushet (origin = FFrollerskis/jarvis-build, ingen force), treet rent. 14 commits over `origin/main` (`71a31d8b`): de 9 fra forrige bygger pluss mine 5 (`df65c906` fix K2 tilbakekall-tekst, `b7a01ce1` test mutantfunn, `e8518ea8` docs, `2586c124` fix K4 cloud→local-primitiv, `c28e2b85` docs 19.8). 57 filer, +2893/-234. Migrasjon 148 (149 ledig). Ingen delte docs rørt. Ingen festet baseline endret. `git merge-tree` mot N1b (`616a8977`), G1b, G1c, G2c, A1, C3, D4 og E1 gir ingen konflikter.

### Status per krav (alt `NOT VERIFIED`: lokale fakes og embedded Postgres)
- **K1 `WIRED`, flagg-uavhengig.** Dette er det eneste bevisste avviket fra K6.
  - `ToolDefinition.autonomy_bindable: {reason ≥ 20 tegn}` (`autonomy-bindable.ts:26`). Manifestinvarianter (`tool-manifest.ts:439`) feller fysisk navnerom, effekt pay/control/delete, step-up og ugyldig begrunnelse.
  - Vakt `autonomyBindBlocker` er fysisk-først, deretter default-deny (`autonomy-guard.ts:68`).
  - Bind-tid `service.ts:1626`. Utførelse: `autoActPending` `:1751`, `actOn` `:976`. Visning: `blocked_code` (`:1581`) og kontrollsenter-WARN (`authority.ts:299`). Simulering: `action_not_bindable`.
  - Kartlegging: alle ikke-fysiske handlinger kunne bindes før K1. Nå er kun `telegram.notify`, `business.create_followup` og `business.assign_open_loop` bindbare (`integrations.ts:192` m.fl.), med begrunnelse.
  - Tester: `wpg4b-bindability` (17, bl.a. `:172` lagret binding feiler lukket, slettes aldri, merkes for eieren; `:215` actOn) og `wpg4b-bindable-pin` (7: sveip over 300+ definisjoner, pinnet liste, kildeskanning av tilordninger).
- **K2 `WIRED` i motor og tabell, skop-skjema `DORMANT` (hovedbryter).**
  - Migrasjon 148, `autonomy-scope.ts:36` og `:82`, `service.ts:1612`, `:1062` (claim) og `:1713`, `rule_key` via `signal-bus.ts`.
  - Presedens regel > kategori > domene. Avslått/utløpt smal rad er et eksplisitt unntak. Avslått/utløpt domenebred rad er tak for alle smale.
  - Test: `wpg4b-autonomy-scope` (23, inkl. migrasjon fra tom DB og fra main-skjemaet, RLS og PK/CHECK).
  - `DEFERRED`: tilbakekalling per skop fra UI. Q-G4-15 under.
- **K3 `DORMANT` (`_VISION`).** Glidende vindu per (kamera, type). Anker er hendelsen som åpnet episoden; en duplikat flytter det aldri. Strengt `<`; haste (`security_alert`) beholder fast bøtte; ingen delt alarmnøkkel. Kode: `vision-bridge.ts:96`, `signal-bus.ts:253` og `:53`. Test: `wpg4b-camera-window` (16, deterministisk klokke; grensetilfellet `:104`).
- **K4 `DORMANT` og `PARTIAL`.**
  - Nytt flaggpar `JARVIS_LOCAL_MODEL_URL_GUARD` og `_ALLOW_TAILSCALE` i `MODEL_ENV` (api og worker). Compose er regenerert (4 linjer), `.env.example` oppdatert og guard-testet.
  - G3-vakten er flyttet uendret til `local-endpoint-guard.ts` og delt. `enforceLocalModelEndpoints` (`:74`) kjøres før gatewayen i `main.ts:340` og `worker-main.ts:107`. Loggen har kun identitetsnavn og kode.
  - Test: `wpg4b-local-model-guard` (23).
- **K5 `DORMANT` og `PARTIAL`.** Én konstant, innholdsfri melding per natt og rom via `telegram.notify`. Idempotent via nøkkelen `situation-morning-summary:<tenant>:<rom>:<slutt>` i `tool_executions`; ukjent utfall sendes aldri på nytt. Kode: `morning-summary.ts:88`, kobling `situation-signals-wiring.ts:266`. Test: `wpg4b-morning-summary` (17, `:91` idempotens og omstart).
- **K6.** Alle guards grønne uten baseline-endring: `wph1-flag-off-selection-baseline`, `wph2-flag-off-main-parity`, D-420, env-drift, compose-isolasjon, `part3-tool-manifest`, `wpg4-flags-wiring`, connector-sdk.
- **K7.** Runbook kap. 0, 1, 5, 7, 9, 11-17 og ny kap. 19 (min runde la til K1-kartlegging, N1b-samspill, tilbakekall-merknad, Q-G4-15 og målte tall i 19.8). PROCESSING_INVENTORY er oppdatert.

### K4 mot N1b (`financeLockServedLocally`)
- Ingen fjerde kopi av lokalitetsregelen. Kilden er `ModelProfile.locality` i `DEFAULT_PROFILES`. Ugyldig/offentlig URL gjør identiteten `cloud` på selve profilen (`demoteLocalProfileToCloud`).
- `servedByCloudModel` (`cloud-tool-screen.ts:163`) leser profilen per kall i stedet for et sett frosset ved import. Uten flagg er resultatet byte-likt.
- N1b-prediktatet `financeLockServedLocally` er uendret (`!servedByCloudModel`). N1b sin `cloud`-verdi i modellskopet og låsen beregnes per kall fra samme prediktat, så begge sporene ser demoteringen.
- Ruter, gateway-låser, chat-jobber, kontrollsentre og assist-vakten (`main.ts:860` bruker `financeLockServedLocally`) leser samme profil. Bevist i `wpg4b-local-model-guard:206`.
- Gjenstående kopier, ikke sikkerhetsavgjørelser eller `PARTIAL`: `run-rate.ts:15` (visningsmerke), minnets embedding-provider (`modules/memory/src/embedding.ts:205` leser samme URL-er med konstant `locality`) og `decideRoute` i selvendringsmodulen (frosset).

### Funn og hull jeg lukket
1. **K2-nødventil:** knappen «Tilbakekall autonomi» fjerner kun den domenebrede raden. Uten bred rad finnes ikke noe tak, så aktiverte smale bindinger fortsatte å virke, mens teksten lovde «Jarvis utfører ingenting selv i domenet». Teksten navngir nå de gjenstående skopene (`authority.ts:283`; test i `wph0-authority-center`). Selve semantikken er Q-G4-15.
2. **K4:** «FAIL-LUKKET»-testen var vakuøs (godtok både `unresolved` og `demoted`). Nå en ekte test av `local_url_check_failed`, og en adresse-grensetabell.
3. **K4:** `resetProfileLocalityToDefaults` var en `cloud→local`-primitiv eksportert fra produksjonskoden. Flyttet til testen. Ny kildeskanning: eneste tilordning til `.locality` er nedgraderingen.
4. Mutantfunn (under) ga fire styrkede tester.

### Tester (som `postgres`, `--maxWorkers=2`, `timeout -k 5`)
- Kommando: `su postgres -s /bin/bash -c 'export HOME=/tmp/pg-home PATH=/opt/node22/bin:$PATH ...; cd <wt> && timeout -k 5 <s> pnpm exec vitest run --maxWorkers=2 <filer>'`.
- **A** (`modules/situations/test`, `modules/model-gateway/test`, `apps/api/test/wpg4`): 99 filer, 1 739 tester grønne.
- **Guards og vakter** (21 filer): 456 tester grønne.
- **B** (`apps/api/test` wph/part3/wpg3/wpn1/wpb3, hele `modules/tool-gateway/test`, connector-sdk, executive, vision, erasure, memory, `packages/contracts`, 22 av 56 core-filer): 334 filer, 5 732 grønne og 3 røde. De 3 er de kjente `wpc3-review1-hardening` F10a/b/c.
  - Første B-kjøring traff min egen `timeout` og ble delt i tre. Kjørt og regnet sammen.
  - Ikke kjørt: 34 core-filer (bl.a. `embedded-postgres-*`), `break-glass-guard` og `nas-ua0-gate`.
- **Mutantsett: 64 mutanter** over K1 (17), K2 (15), K3 (9), K4 (11) og K5 (12).
  - Første kjøring: 58 drept, 1 drept kun av en eldre G3-test (K4 `172.32`), 1 ugyldig mutant (syntaksfeil), 4 overlevde (K3 `DESC→ASC`, K3 `starts_with`, K4 fail-lukket gren, K5 etterfyllingsgrense `>`→`>=`).
  - Etter styrking av testene ble de fem som kunne drepes kjørt på nytt og drept. **Sluttstand: 63 av 64 drept.**
  - Siste overlevende, K3 `starts_with(detection_key,$5)`, er ekvivalent under C-kollasjon (kun `C`/`POSIX` finnes i sandkassen). Den er forsvar mot ikke-C-kollasjoner i produksjons-Postgres og er `NOT VERIFIED` der.
  - Harness og resultater ligger i `/tmp/g4b-fin/` (mutate.mjs, mutants.mjs, mut-results*.jsonl), ikke i repoet.
- **Statiske kontroller** på kodetreet `2586c124`, docs-only siden: typecheck exit 0, lint exit 0, `check:containment` exit 0, gitleaks «no leaks found» (14 commits, kjørt på tipp).

### Flagg AV = main
- Guards og de uendrede motor-testene er grønne.
- Bevisste avvik, alle listet i runbook 19.6: K1 (stopper eksisterende bindinger til ikke-bindbare handlinger, som vises, men ikke slettes), migrasjon 148 (ny primærnøkkel), `servedByCloudModel` per kall og additive felt (`scope_key`, tre manifestfelt, `situations.rule_key`).

### Antakelser (D-484-forslag)
1. K1 er flagg-uavhengig. Ingen oppslagsfunksjon betyr at ingenting er bindbart.
2. `autonomy_bindable` krever begrunnelse ≥ 20 tegn. Fysiske navnerom er stengt først og uansett. Tre produksjonsdefinisjoner er pinnet.
3. K1-sjekken i `actOn` gjelder kun den autonome veien (`autoActGuard`); ingen produksjonskaller uten.
4. Skopnøkkel `*`, `rule:<kilde>:<type>` eller `category:<navn>` (9 lukkede kategorier). Ny primærnøkkel. `situations.rule_key` = regelen som vant; `NULL` betyr kun domenebred binding.
5. Tak: avslått/utløpt domenebred rad stanser smale bindinger. Uten bred rad finnes ikke noe tak (Q-G4-12).
6. K3: strengt `<`, anker i `detection_key` (13 siffer), haste uendret, `opening_detected` beholder HA-nøkkelen.
7. K3-begrensning: en sen hendelse eldre enn eksisterende anker (på tvers av tikk) gir en egen episode, høyst ett ekstra varsel.
8. K4 bak nytt flaggpar (tailnet-adressen ville ellers blitt demotert), AV som standard. DNS kun ved oppstart, uløst navn beholdes og logges.
9. K5: konstant tekst uten tall eller tid. Teller kun `vision`, `remember`, prioritet over `low`, aldri varslet, åpnet i natten. Etterfylling 12 t. Kun rom med kameraabonnement. Ingen nytt flagg.

### Security surfaces for reviewerne
- `autonomy-guard.ts:49` og `:68`
- `tool-manifest.ts:334` og `:439`
- `service.ts:976`, `:1062`, `:1612`, `:1626`, `:1751`
- `autonomy-scope.ts:82`
- `migrations/148...sql:14`
- `signal-bus.ts:253`
- `local-endpoint-guard.ts:44`
- `local-model-endpoints.ts:74`
- `capability-registry.ts:272`
- `cloud-tool-screen.ts:163`
- `assist.ts:225`
- `morning-summary.ts:44` og `:88`
- `authority.ts:283` og `:299`
- `main.ts:700`, `:340`, `:860`
- `worker-main.ts:107`

### Kjente begrensninger og Q-forslag
- **Q-G4-12:** er taket riktig tolket? Anbefaling: behold.
- **Q-G4-13:** slå K4 på som standard etter NAS-verifisering, inkl. tailnet-flagget. Skal embedding-provideren demoteres av samme vakt? Anbefaling: ja, som oppfølger (endrer minne-oppsettet).
- **Q-G4-14:** antall eller tid i morgenmeldingen? Anbefaling: nei.
- **Q-G4-15 (ny):** skal «Tilbakekall autonomi» også fjerne smale bindinger? Anbefaling: ja. Krever at revisjonsraden bærer alle radene (executive-modulen), derfor `DEFERRED`.
- Kontrollsenteret viser kun «utføres ikke» for registrerte eller fysiske handlinger. En binding til en uregistrert handling vises bare via `list_autonomy_policies.blocked_code`.

### Forslag til JARVIS-115
- `OPEN` → `PARTIAL`.
- (a) bygget, `WIRED`, `NOT_VERIFIED`.
- (b) glidende vindu bygget; delt alarmnøkkel = nei (eierens valg).
- (d) `PARTIAL` (embedding, `run-rate`-visning og DNS etter oppstart åpne).
- (f) `PARTIAL`: morgenoppsummering bygget; HA-push, UI, anomali-kobling og etterfylling `DEFERRED`.
- (m) bygget, `WIRED` (flagg-uavhengig).
- Åpne: (c), (e), (g)-(l), Q-G4-12 til Q-G4-15.

### `NOT VERIFIED` og `BLOCKED_EXTERNAL`
- Ingenting er kjørt mot ekte HA, kamera, lokal modell, Telegram, tailnet-DNS eller NAS. Runbook §11 steg 11-15 er skrevet, ikke utført.
- ACT/ACT+NOTIFY observert på NAS er `BLOCKED_EXTERNAL`.
- Produksjons-DB-ens eksisterende bindinger er ukjente. Etter utrulling bør eieren kjøre `situations.list_autonomy_policies` og se etter `blocked_code`.
- K3-`starts_with` mot ikke-C-kollasjon er `NOT VERIFIED`.
- Ved omstart av mine statiske kontroller stoppet jeg prosesser med et bredt `ps`-mønster (`pnpm -r … typecheck`). Jeg så ingen andre builderes typecheck-prosesser da, men kan ikke utelukke det.
