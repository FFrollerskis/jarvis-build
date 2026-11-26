TS: 2026-11-26T11:01:20.012Z
**Ny tipp `7be281b7` (6 commits oppå `41031fd1`) er pushet til `claude/wp-g4b-situations-rest`; remote og lokal er like, og treet er rent.** Ingen delte docs, `.gitleaksignore`, `infra/`, pakker, flagg eller migrasjoner er rørt.

**Avvik i ordren:** Den nevner `JARVIS_LOCAL_MODEL_URL_GUARD_ALLOW_TAILSCALE`. Det navnet finnes ikke. Koden, compose og `.env.example` bruker `JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE`, og det er det jeg har brukt overalt.

**Per fiks**
- **FIX-A, ferdig (`6d956133`):** AST-strukturtest i `apps/api/test/wpg4b-local-model-guard-embedding.test.ts` (23 tester).
  - Den pinner at kallet er `await`et direkte som egen setning og at kastet ikke svelges.
  - api: kallet står rett i `buildDeps()`, og `.catch` kaller `process.exit(≠0)`.
  - worker: alene i en toppnivå-`try` med `failStartup(feilen)`.
  - Kallet står før hver `createEmbeddingProviderFromEnv`. D41 og D58 er drept.
- **FIX-B, ferdig (`13440a51`):** Deterministisk låstest i `modules/situations/test/wpg4b-revoke-all-scopes.test.ts` (12 tester). Den bruker en port som holder auto-ACT-kallet i flukt og en felles hendelsesrekkefølge i stedet for klokketider. D08 er drept, og testen var stabil 3 av 3.
- **FIX-C, ferdig (`c3cf313c`):** `toStrictEqual` på bodyen til hver revoke-knapp i `wph0-authority-center.test.ts` (31 tester). D22 og D59 er drept.
- **FIX-D, ferdig (`a455cb5c`):** `MemoryEmbeddingNotLocalError` i `apps/api/src/local-model-endpoints.ts` har et hint bak den uendrede stabile koden.
  - Hintet navngir variabelen som ble avvist (prioritet som minnets egen velger, låst av test) og tailnet-flagget.
  - Det bygges kun av konstanter, så det inneholder aldri URL, vert eller passord. Sentinel-test på hver del av URL-en.
  - `.env.example` har nå en LAN-adresse som eksempel og en TAILNET-kommentar. Runbook §11 steg 14 og §19.4 er oppdatert.
  - Leverandør-literaler i `local-model-endpoints.ts` er fortsatt 3 (N1b-skannerens regel).
- **FIX-E, ferdig (`0620e322`):** Alle fem punktene er rettet i runbooken (§19.9 (c), §19.5, rad 6 DELVIS/PARTIAL, seriell DNS som kjent begrensning (I7)). Den stale lese-allowlisten er rettet i `service.ts` og `UA10` §11.4, og testtittelen i `wph2-control-routes` (kun tittelen). Jeg rettet også samme undervurdering av «ett ekstra sammendrag» i kildekommentaren i `morning-summary.ts` og i §11 steg 15, og oppdaterte testtall i §19.9-tabellen.
- **Testbevis (`7be281b7`):** Ny runbook §19.10 med fiks-runde-2-tallene.

**Mutanter:** 38 unike, 37 drept og 1 ekvivalent. 5 er reviewerens (D41, D58, D08, D22, D59; de fire første kjørt på nytt mot sluttreet), og 33 er egne: 12 mot FIX-A, 1 mot FIX-B, 4 mot FIX-C, 16 mot FIX-D-hintet. Den ekvivalente er `rule: undefined` i knappens body, som `controlAction` JSON-normaliserer bort.

**Kontroller og testtall** (som OS-bruker `postgres`, maks 2 arbeidere)
- `modules/situations/test`: 39 filer, 591 tester grønne.
- `apps/api/test`: 236 filer, 3 525 tester grønne, inkludert flagg-AV-vaktene.
- Pakkesettet pluss compose-vaktene: 305 filer, 5 079 grønne og 3 røde. De tre er de kjente sandkassefeilene `wpc3-review1-hardening` F10a/b/c; kjørt som treets eier består filen 45 av 45.
- Fem ekstra vaktfiler (`d396`, `d398`-matrisen, `d398`-vacuous, `part3-secret-scan`, `remediation-1-host-script-guard`): 47 tester grønne.
- `pnpm -r --workspace-concurrency=2 run typecheck`, `pnpm lint` og `pnpm check:containment`: exit 0.
- gitleaks over 30 commits: ingen funn.
- `git merge-tree` mot N1b (`e4957e19`) og G2c (`6fb93fbe`): ingen konflikter.

**Til lead:**
- `UA10_SITUATION_ENGINE_DESIGN.md` l.548 («regel-skopet binding er `DEFERRED`») og §11.8-listen er fortsatt utdatert mot K2 og K5. Jeg rørte dem ikke fordi de ligger utenfor ordren.
- Integrasjonspunktene (`wpn1b-structure` ALLOWED og ALLOWED_BARE, `run-rate.ts` `!servedByCloudModel`) er ikke gjort.

**NOT VERIFIED:**
- Selve omstartsløkka under `docker compose` er ikke kjørt. Testet er feilmeldingen, vakten og at oppstart stopper.
- Ingen ekte tailnet-, Ollama- eller NAS-vert, og ingen ekte DNS ved oppstart (den serielle forsinkelsen på opptil 20 s er kun målt skalert av reviewer).
- Tallet ca. 720 i §19.5 er en teoretisk øvre grense, ikke målt.
- AST-testen er kun kjørt mot TypeScript-versjonen i repoet (`typescript` ^5.9.3).

Notater og verktøy ligger i `/tmp/pg-home/g4b-fix2-notes/`.
