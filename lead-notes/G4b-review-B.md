TS: 2026-11-26T05:57:24.146Z
VERDICT: MERGE ETTER FIKSER. Jeg fant 0 HIGH og 3 MEDIUM (K4 dekker ikke minnets embedding, og `.env.example` lover mer enn koden gjør; «Tilbakekall» lar smale bindinger stå; transport-laget for skop mangler testdekning). I tillegg 5 LOW og 6 INFO. Jeg fant ingen vei til autonom fysisk handling.

## Funn (rangert, fil:linje mot HEAD c28e2b85)

**M1 (MEDIUM) K4 dekker ikke minnets embedding, og dokumentasjonen lover mer enn koden gjør.**
- `modules/memory/src/embedding.ts:205` velger URL fra `JARVIS_EMBEDDING_URL`, så `JARVIS_OLLAMA_URL`, så `JARVIS_GEMMA_LOCAL_URL`. Klassene på `:43` og `:99` har `locality = "local" as const`, og `fetch` står på `:130`.
- `memory-writer.ts:198/260/651` og `retriever.ts:117` sender minneinnhold og søkespørringer dit. Det omfatter helse og finans, jf. D-386.
- `local-model-endpoints.ts:42-44` og `:74` sjekker kun `local_llm`, `gemma_local` og `ollama`.
- Probe `zz-g4b-review-b-k4.test.ts` HULL-1: flagg PÅ, `JARVIS_OLLAMA_URL=http://example.com:11434`. Chat-profilen `ollama` blir `cloud`, men `createEmbeddingProviderFromEnv` gir `locality "local"`, `assertLocalEmbedding` passerer, og forespørselen går til `http://example.com:11434/api/embed` med minnetekst i kroppen.
- `.env.example:160` sier at helse-/økonomi-/kameradata «aldri sendes dit». Det stemmer ikke. Runbook §19.4 sier derimot `PARTIAL`, så der er det ærlig.
- Fiks, kode (ca. 12 linjer): i `enforceLocalModelEndpoints`, etter løkka, kall `embeddingEndpointFromEnv(env)` fra `@jarvis/memory`. Kjør samme `assertLocalEndpoint` og `resolveEndpointLocality`. Ved ikke-lokal URL: logg `identity:"memory_embedding"` med kode og kast `memory_embedding_must_be_local:<kode>`, som `assertLocalEmbedding`.
- Fiks, minimum før merge: rett `.env.example:160` og startloggen `local_model_endpoint_guard`. Legg til `not_covered:["memory_embedding","redirects"]`.

**M2 (MEDIUM, byggeren kjenner den: Q-G4-15) «Tilbakekall autonomi» lar smale bindinger stå.**
- Probe PB4 bekrefter: en bred rad + en regelrad, deretter `clearAutonomyPolicy` uten skop (kontrollsenterknappen via `executive`), gir `attempted=1`. Regelbindingen utfører fortsatt.
- Årsak: `autonomy-scope.ts:86` setter tak kun når den brede raden finnes og er inaktiv. WP-H2 SLETTER raden (`service.ts:1681`), og da forsvinner taket.
- PB4b: med `enabled=false` på den brede raden virker taket.
- Kontrollsenteret tilbyr dessuten ingen tilbakekall-knapp for rene smale rader (`authority.ts:301`).
- Alvorlighet: begrenset i dag. Kun `telegram.notify`, `business.create_followup` og `business.assign_open_loop` er bindbare. Skop-skjemaet er DORMANT, og `pause_domain` virker uansett.
- Minimal trygg fiks (ca. 20 linjer): domenebredt `clear` fjerner eller deaktiverer også alle smale rader i (tenant, rom, domene) i samme transaksjon under domenelåsen. `executive/service.ts:250` må lagre alle før-bilderader.
- Hvis fiksen utsettes: D-484 må si eksplisitt at skopede bindinger ikke tas i bruk før Q-G4-15 er bygget.

**M3 (MEDIUM, testhull) transport-laget for skop er ikke testet.**
- `transport.ts:123-124` og `:133-136` kan slippe `rule` eller `category` stille (set) eller skopet (clear). En skopet binding ville da bli domenebred.
- Mutantene X-01, X-02 og X-03 overlevde alle byggerens tester (41/41 grønne). Mine prober dreper dem.
- Probe PB10 kjører hele veien gateway → `SituationsTransport` → motor. Den er grønn på HEAD, så oppførselen er riktig, men ingen test låser den.
- Fiks: legg PB10 inn i `wpg4b-autonomy-scope.test.ts`.

**L1 (LOW) redirect følges med kropp.**
- `local-llm.ts:314-320` og `:388-393` har `redirect:"error"` kun for vision. `ollama.ts:34` og `embedding.ts:130` har ingen.
- HULL-2, 3 og 4 bekrefter at en 307 fra en lokal URL sender forespørselskroppen videre til `Location`. Det kan skje ved http→https-omdirigering på en omvendt proxy.
- Fiks: `redirect:"error"` bak en konstruktøropsjon som settes når vakten er PÅ, så AV = main.

**L2 (LOW) DNS kontrolleres kun ved oppstart, og uløst navn forblir lokalt.**
- Kode: `local-endpoint-guard.ts:90`, `local-model-endpoints.ts:94`.
- Probe: oppslaget kjøres én gang, og tom eller feilet DNS gir `unresolved` og `servedByCloudModel=false`. Et navn som ikke løses ved boot (resolver nede etter strømbrudd) kan senere løses offentlig.
- Fiks: periodisk re-sjekk som kun demoterer, eller demoter `unresolved` for navn med punktum.
- Ved flagg PÅ kan oppstarten forsinkes opptil 3×5 s.

**L3 (LOW) `apps/api/src/run-rate.ts:15`** har en frosset `LOCAL_PROVIDERS` (visning og `cloud_share_30d`). Etter demotering lyver den. Fiks: bruk `!servedByCloudModel`. N1b rører samme fil, så gjør det etter N1b.

**L4 (LOW) testhull som overlevde.**
- K4-10: passord-eneste userinfo (`http://:pw@host`) er utestet. Min probe dreper den.
- K4-17: ingen test pinner at `main.ts` kobler `isLocalProvider` til assist-vakten. Fiks: strukturtest som for worker (K4-16 ble drept).
- X-05: `executive/service.ts:250`, før-bildefilteret `scope_key==="*"` er utestet. Ikke strengt ekvivalent: med kun smal rad ville revisjonen beskrive en rad som ikke fjernes.
- X-16: simuleringens `active` ignorerer utløp utestet.

**L5 (LOW) K1 er flagg-uavhengig, så eksisterende produksjonsbindinger til andre handlinger stopper stille.**
- Bevisst og dokumentert (runbook §19.6).
- Kontrollsenteret viser en lagret binding til en uregistrert handling som OK (`authority.ts:299` krever at handlingen er registrert eller fysisk).
- Rådet er en sjekkliste: eieren kjører `list_autonomy_policies` etter utrulling og ser etter `blocked_code`.

**INFO**
- **I1.** Morgenoppsummeringens nøkkel `situation-morning-summary:<tenant>:<rom>:<ISO>` er forutsigbar. En kaller som kan bruke `ToolGateway` kan forhåndsbruke den og undertrykke sammendraget (PM4). Ingen modellflate når det (`situations` står på ingen flate; doc-probe viser tomme grants).
- **I2.** Meldingens eksistens avslører én bit («kamerahendelser mens stille timer gjaldt») til Telegram. Det er konsistent med eksisterende nøytral tekst og Q-G4-14.
- **I3.** `assign_open_loop`-begrunnelsen sier «person i samme tenant». `020_business_open_loops.sql:31` har FK mot `people`, ikke `person_tenants`. Parameteren er eierstyrt, så ingen angrepsvei.
- **I4.** Manifestet forbyr ikke risk D for `autonomy_bindable`. Pin-testen (`wpg4b-bindable-pin`, akkurat tre) er rekkverket.
- **I5.** Med hovedbryteren AV mister `clear_autonomy_policy` `rule`/`category`-feltene. Skopede rader kan da ikke fjernes via verktøy, men har ingen situasjoner å virke på.
- **I6.** `http://[::ffff:127.0.0.1]` demoteres (hex-normalisert, fail-lukket falsk positiv). Tailscale-IPv6 (fd7a:…) regnes lokal uten tailnet-flagget. Det arves fra G3.

**Standard AV for K4:** riktig (tailnet-adressen i `.env.example` ville ellers blitt demotert, og K6 krever AV = main). Konsekvensen er at en offentlig modell-URL i dag gir ingen advarsel. Forslag: observe-modus som logger `local_model_endpoint_unverified` uten å demotere, eller et eget punkt i NAS-sjekklisten.

## Byggerens påstander → dom

| Påstand | Dom | Bevis |
|---|---|---|
| K1: default-deny, nøyaktig 3 bindbare, flagg-uavhengig | BEKREFTET | doc-probe: 429 definisjoner i `firstWaveTools`, kun `telegram.notify`, `business.create_followup` og `business.assign_open_loop` (klasse B, effekt send/write, uten step-up). Pin-test 7/7. PB1 (6 erklæringsvarianter × 4 skop: 0 kall) og PB3 (nedgradert definisjon: ingen ACT, rad beholdt) |
| K1: fysiske navnerom stengt uansett | BEKREFTET | PB2: feilmerket `home-assistant.lock_set` og `car.unlock`, bred og smal rad, 0 kall. Manifestet feller også `Home-Assistant`/`hass`-varianter via effekt `control` |
| K1: lagret binding feiler lukket, slettes ikke, vises | BEKREFTET (se L5) | PB1: rad beholdt, `blocked_code=action_not_bindable`. PB9: vision/health-bindinger i alle skop gir 0 kall |
| K2: presedens, tak, unntak, claim | BEKREFTET | PB4b, PB5 (utløpt bred = tak, utløpt smal = unntak). K2-01…03 og 07…09 drept |
| K2: skopnøkkel-injeksjon, kryss-skop, tenant og rom | BEKREFTET | PB6: 17 ugyldige rader avvist av CHECK. PB8: 16 injiserte skop avvist. PB7: annen tenant/rom gir 0 kall. K2-04…06 og 13 drept |
| K2: tak fanger «tilbakekall» | FEIL | M2 / PB4 |
| K2: transport-plumbing testet | FEIL (testhull) | M3, X-01…03 |
| K3: haste beholder fast bøtte | BEKREFTET (min vinkel) | mutant K3-01 (glidende vindu for `security_alert`) drept |
| K4: flagg AV = main | BEKREFTET | kun eksakt `on` (10 avvikende verdier). 30 leverandørnavn gir identisk `servedByCloudModel` og `financeLockServedLocally` som main-semantikken. Compose NO_DRIFT |
| K4: URL → `cloud` i alle lokalitetsavgjørelser | BEKREFTET for registeret | 46 URL-former, tailnet, DNS. Register, `financeLockServedLocally` og assist-vakt ser demoteringen. K4-01…16 drept |
| K4: helse/økonomi/kamera «aldri sendes dit» | FEIL | M1 og L1 |
| K4: logg kun identitet + kode | BEKREFTET | URL med bruker/passord/query, 3 identiteter, ingen lekkasje. K4-07 drept |
| K5: konstant, innholdsfri, idempotent, ingen PII | BEKREFTET | PM1: ledger har ingen parametrekolonne. 3 samtidige `deliver` gir 1 melding. PM3 og PM5. K5-01…09 drept |
| K6: ingen `process.env` utenfor parser, compose og guards | BEKREFTET | grep: kun parser. `compose-drift.mjs` NO_DRIFT. Flagg-/guard-tester 80 grønne (6 skipped). `remediation-2-compose-isolation` 40/40 som postgres. Flaggene kun i api og worker |
| K6: ingen nye pakker eller hemmeligheter | BEKREFTET | gitleaks «no leaks» (14 commits). Ingen `package.json` eller lockfile i diffen |
| Delt kode minimal | BEKREFTET | diffene til `gateway.ts`, `integrations.ts`, `tool-manifest.ts`, executive, `capability-registry.ts` og `cloud-tool-screen.ts` er små og gjelder kun K1/K4. `git merge-tree` ren mot n1b, fin2, g1c og g2c |
| K7: docs og tall | DELVIS | kap. 19 er konsistent og ærlig, bortsett fra `.env.example:160`. NAS-trinn 11–15 er ufarlige (stikkprøve). Test-diffen har ingen svekkede assertions: kun fiksturer med `autonomy_bindable`/`definitionLookup`, K3-cooldown-testen omskrevet til episode-semantikk, og `finance_spend.sync_internal_spend` byttet i fikstur |
| Forslag JARVIS-115 = PARTIAL | DELVIS enig | (d) bør nevne embedding og redirect. (a) bør nevne gate for Q-G4-15 |

## Mutasjoner

76 kjørt mot byggerens tester (`--bail=1`, 2 arbeidere, `git checkout --` etter hver): 69 drept, 7 overlevde. Satt 1 hadde 60 mutanter (58 drept) og satt 2 hadde 16 (11 drept).

Fordeling av satt 1: K1 19 (alle drept), K2 14 (alle), K3 1 (drept), K4 17 (15 drept), K5 9 (alle).

Overlevende:
- K4-10, X-01, X-02, X-03: reelle testhull, drept av mine prober (`K4-10p`, `X-01p`…`X-03p`).
- K4-17: assist-koblingen i `main.ts` er ikke pinnet.
- X-05: før-bildefilteret i revoke er utestet.
- X-16: simuleringens utløp er utestet.
- Ingen overlevende er ekvivalente.

Byggerens egne mutanter (64) har jeg ikke verifisert.

## Ikke verifisert av meg
- Alt som krever NAS, ekte Home Assistant, kamera, lokal modell, Telegram eller tailnet-DNS er `NOT VERIFIED` eller `BLOCKED_EXTERNAL`.
- Ikke-C-kollasjon for K3 `starts_with`.
- Produksjons-DB-ens eksisterende bindinger.
- Hele suiten, `pnpm typecheck`, `pnpm lint` og `check:containment`. Jeg stoler ikke på byggerens «exit 0».
- Samlet N1b + G4b i drift. Jeg har kun gjort en `merge-tree`-sjekk og lest at N1b ikke endrer lokalitetsprediktatet.
- Ekte oppstartsrekkefølge og DNS i worker.
- Faktisk Telegram-levering og indeterminate-feil.
- K3-korrekthet utover haste (reviewer A).

## Probe-mappe
`/tmp/lead/G4b-review-B-probes/` inneholder:
- `NOTES.md`
- prober: `zz-g4b-review-b-k1k2.test.ts` (11), `-k4.test.ts` (54), `-k5.test.ts` (5), `-doc.test.ts` (4)
- harness: `run-db.sh`, `run-mutants.mjs`, `build-mutants*.mjs`, `compose-drift.mjs`
- mutantspesifikasjoner og resultater: `mutants*.json`, `mutants*-results.jsonl`

Worktreen er ren: `git status --short` er tom, HEAD er uendret, og probefilene er flyttet til `worktree-copies/`.

Kommando for DB-prober: `su postgres -s /bin/bash -c '… pnpm exec vitest run --maxWorkers=2 --bail=1 <fil>'`. K4-prober (ikke-DB) ble kjørt som root, tilsvarende uten `su`.
