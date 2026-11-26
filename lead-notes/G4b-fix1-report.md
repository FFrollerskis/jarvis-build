TS: 2026-11-26T09:48:56.805Z
# WP-G4b fiks-runde 1: sluttrapport

**Ny tipp: `41031fd1`, pushet til `origin/claude/wp-g4b-situations-rest` (ja).** Treet er rent. 11 commits siden `c28e2b85`: acead77a, 26eea95e, a98cad33, c0f6c029, 0ffa9225, f8473d17, 49c6a344, 9119b421, 981cba1e, b2bfa5db, 41031fd1. Ingen ny migrasjon (149 er ubrukt). Ingen nye flagg, pakker eller miljøvariabler.

## Per FIX
Alle er ferdig unntatt FIX-7. «Rød først» er bevist av testen eller av en mutant som reverserer fiksen.
- **FIX-2/2b (acead77a, b2bfa5db):** domenebredt tilbakekall fjerner ALLE rader i (tenant, rom, domene) i én DELETE under domenelåsen. Jeg valgte B sin løsning (b); A sin (a) vekker smale rader ved senere bred re-aktivering.
  - Kode: `service.ts` (`clearAutonomyPolicyScopes`), `executive/service.ts` (`before` + `before_scoped`), `autonomy-audit.ts`, `control-center/authority.ts` (én knapp per rom og domene, også for rene smale rader), `removed_scopes` i svaret.
  - Tester: `wpg4b-revoke-all-scopes` (11), `-db` (4), `wpg4b-revoke-before-image` (8), `wph0-authority-center` (31). A sine tre bred-rad-tilstander, PB4 og «smal clear lar den brede stå» er med.
- **FIX-1 (26eea95e):** `enforceLocalModelEndpoints` kaller `embeddingEndpointFromEnv`. Ikke-lokal URL kaster `memory_embedding_must_be_local:<kode>` (aldri URL), og loggen har `identity:"memory_embedding"`. `.env.example`, §19.4 og `not_covered` er rettet. Test: `wpg4b-local-model-guard-embedding` (13), HULL-1 inkludert.
- **FIX-3 (0ffa9225):** PB10 i `wpg4b-autonomy-scope` (24 tester). X-01..03 drept.
- **FIX-4/4b (0ffa9225, f8473d17):** K4-10 og M49/M70 i `wpg4b-k4-coupling` (7), X-05 i `wpg4b-revoke-before-image`, X-16 i `wpg4b-simulation-binding` (3), M58 i `wpg4b-morning-summary-fix` (8). Alle drept. M30 og M62 står forklart i §19.9 og er ikke endret.
- **FIX-5 (9119b421):** konstruktøropsjonen `noRedirect` (`local-llm`, `ollama`, `OllamaEmbedding`), satt i api og worker kun når vakten er PÅ. Test: `wpg4b-local-model-redirects` (35).
- **FIX-6 (9119b421):** valg (a): uløst navn MED punktum demoteres (`local_url_unresolved_fqdn`). Valg (b) er ikke bygget. Embedding med uløst navn beholdes med advarsel. Test: `wpg4b-local-model-guard-dns` (14). Avveining: ligger DNS nede ved oppstart, forblir identiteten sky til omstart.
- **FIX-7: DEFERRED** til integrasjon (se under).
- **FIX-8/10 (c0f6c029):** ukjent handling gir WARN i kontrollsenteret og `action_not_bindable` i simuleringen. NAS-sjekkliste er lagt i runbook §11.
- **FIX-9 (a98cad33):** `physical_action_not_bindable` for ENHVER handling i de fysiske navnerommene, før definisjonssjekken. Test: `wpg4b-physical-first` (8).
- **FIX-11 (f8473d17):** `classifyDelivery` gir taperen `already_sent`. Fire samtidige gir 1 `sent`, 3 `already_sent` og 1 transportkall. ECONNRESET er dokumentert ærlig (kan gi ett ekstra sammendrag; Telegram-transporten er urørt). Test: `wpg4b-morning-summary-fix` (8).
- **FIX-12 (49c6a344):** `wpg4b-camera-window-icu` (2); kommentaren i `signal-bus.ts` er rettet.
- **INFO:** morgenmelding-nøkkelen og FK mot `people` er dokumentert (I1, I3). Pin-testen feller en fjerde bindbar definisjon (I4, mutant drept). K1/D-160, K3-ankeret og migrasjon 148 står i §19.9. «Observe-modus» for K4 er DEFERRED: flagg AV skal være byte-identisk med main, og modusen krever en eierbeslutning.
- **Docs:** `WPG4_SITUATION_BRIDGES.md` (§19.9 + §5, 11, 12, 14, 19.1-19.5) og `WPH2_CONTROL_CENTERS.md` (revoke = alle rader). Q-G4-12-teksten er rettet: en enkelt regelbinding alene må nå opprettes på nytt etter et domenebredt tilbakekall.

## Mutanter
43, alle drept. Batch på 42 pluss ett fra før (FIX-9 lese-unntak). 40 ble drept første gang.
- **Overlevde først:** F2-10 (SQL-filter på rom) og F2-12 (tenant). RLS holder radene alene i app-rollen.
- **Løsning:** ny test på superuser-poolen; F2-10/11/12 drept.

## Testkommandoer (som `postgres`, `timeout -k 5`, `--maxWorkers=2`)
- `modules/situations/test`: 39 filer, 590 tester grønne.
- `apps/api/test` (hele): 236 filer, 3 515 grønne. Flagg-AV-vaktene `wph1`/`wph2` er med.
- memory, model-gateway, executive, tool-gateway, connector-sdk, provider-adapters, contracts, vision, erasure og vaktene d398, D-420, compose-isolasjon, wpj-closure-matrix: 301 filer, 5 054 grønne og 3 røde. De 3 er `wpc3-review1-hardening` F10a/b/c (sandkassefeil): `git check-ignore` feiler med «dubious ownership» fordi `postgres` ikke eier treet. Kjørt som root består filen 45 av 45.
- `pnpm -r --workspace-concurrency=2 run typecheck`, `pnpm lint` og `pnpm check:containment`: alle exit 0.
- gitleaks `origin/main..HEAD` (24 commits): no leaks found.
- Compose: `infra/` er uendret siden `c28e2b85`. env-drift (15) og compose-isolasjon (40) er grønne. Generatoren uten `--write` skriver bare ut blokkene og printer ikke «NO_DRIFT» selv.

## Nye antakelser til D-484 (nr. 10-18, også i runbook §19.9)
- (10) Domenebredt tilbakekall fjerner alle bindinger i domenet; med skop fjernes kun den ene raden.
- (11) Før-bildet har `before` (bred) og `before_scoped`; `removed_scopes` i svaret viser hva som ble fjernet.
- (12) Enhver handling i `home-assistant` og `car` er fysisk, også lesing.
- (13) Handling uten kjent definisjon er ikke bindbar, også i visning og simulering.
- (14) K4 dekker minnets embedding: ikke-lokal URL stopper oppstarten, uløst navn beholdes med advarsel.
- (15) Med vakt PÅ følges aldri en omdirigering av lokale modellkall.
- (16) Uløst navn MED punktum demoteres for chat-identitetene.
- (17) Kun kallet som faktisk sendte morgensammendraget får `sent`.
- (18) `starts_with` i episodesøket skal stå uansett kollasjon.

## Q-forslag
- **Q-G4-15:** lukk, bygget som anbefalt.
- **Q-G4-12:** tekst oppdatert som over.
- **Q-G4-13:** utvides med to spørsmål: skal et uløst embedding-navn stoppe oppstarten, og skal FQDN-demotering være standard?
- **Ny Q-G4-16:** vil eieren ha en observe-modus (logg `local_model_endpoint_unverified` når vakten er AV)? Det krever et nytt flagg.

## NOT VERIFIED
- NAS-trinnene i §11 (steg 11-15) og alt mot ekte utstyr: HA, Telegram, tailnet, ekte 307/308-vert (testet med fakeservere).
- `starts_with` mot glibc `en_US` på NAS (C, POSIX og ICU er verifisert).
- DNS ved ekte oppstart med nede resolver (testet med injisert `lookup`).
- ECONNRESET mot ekte Telegram.
- Monorepoet utenfor settene over, inkludert resten av `modules/core/test`.

## Integrasjonspunkter for lead (ikke gjort)
- **(a) `wpn1b-structure.test.ts` gruppe G:** `apps/api/src/local-model-endpoints.ts` har nå 3 leverandør-literaler, uendret fra 3 (bare ordene teller likt). Legg `"apps/api/src/local-model-endpoints.ts": 3` i `ALLOWED` og `ALLOWED_BARE` i den grenen som merges sist.
  - `git merge-tree` av denne grenen mot lokal N1b-gren er konfliktfri.
  - Emulert gruppe G på det sammenslåtte treet avviker kun for den filen: 23 mot 22 filer sitert, 26 mot 25 bare.
- **(b) `run-rate.ts` `!servedByCloudModel` (L3/FIX-7):** til det er koblet inn regnes en demotert `gemma_local` til 0 øre og vises som lokal. `LOCAL_PROVIDERS` er en frosset visningskopi.
- **(c) Compose** trenger ikke regenereres.
- **(d) Delte docs** (D-484, OPEN_QUESTIONS, FINDINGS_LEDGER) er ikke rørt; tekstforslag står over og i §19.9.

Notater og mutantlogger: `/tmp/pg-home/g4b-fix-notes/` (`NOTES.md`, `mutants-run-1.log`, `mutants-run-2.log`, `verify/`).
