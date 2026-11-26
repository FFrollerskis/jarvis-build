TS: 2026-11-26T10:13:37.812Z
VERDICT: MERGE. Jeg fant 0 HIGH og 0 MEDIUM nye funn. Alle tidligere funn er lukket, bortsett fra A MEDIUM-1 som er et kjent integrasjonspunkt, og B L2 som er delvis lukket.

Worktreen er ren: `git status --short` er tom og HEAD er `41031fd1`. Prober og mutanter ligger i `/tmp/lead/G4b-delta-probes/`, og fremdriften i `/tmp/pg-home/g4b-delta-notes/NOTES.md`.

**(1) Tidligere funn**
- **B M1, embedding:** LUKKET.
  - B sin HULL-1 stopper nå oppstart med `memory_embedding_must_be_local:local_url_not_local`.
  - Min probe (26/26) dekker alle tre URL-kilder, prioritetsrekkefølgen, bare `JARVIS_EMBEDDING_MODEL` satt, `OLLAMA` med store bokstaver, brukerinfo, query og ugyldig skjema. Ingen URL, vert eller passord står i feil, logg eller console.
  - `main.ts:340` og `worker-main.ts:109` kjører vakten før `createEmbeddingProviderFromEnv` (`main.ts:713`, `worker-main.ts:392/780`).
  - Vakt AV (8 avvikende verdier) gir `null`, ingen logg og uendret profil.
- **A MEDIUM-2 = B M2, domenebredt tilbakekall:** LUKKET.
  - A sine tre bred-rad-tilstander (aktiv, avslått, utløpt) og B sin PB4 gir nå 0 utførelser etter clear. Disse prober feiler på 41031fd1 fordi de kodet den gamle feilen.
  - Min probe (3/3):
    - Clear under et pågående kall venter på domenelåsen og gir 0 kall etter retur.
    - En storm på 25 runder (clear, bind og tikk i tilfeldig rekkefølge) ga ingen deadlock eller uventet feil.
    - Tenant-, rom- og domeneisolasjon holder, og ugyldige skop (`rule:""`, `category:""`, begge felt, `constructor`, tall) gir avvisning i stedet for domenebredt sletting.
  - Skopet clear lar øvrige rader stå (D09 og D49 drept). Lås-settet `[domain]` er uendret fra før, så ingen ny deadlock-risiko.
- **B M3, transportskop:** LUKKET. PB10 er grønn, og X-01..04 er drept.
- **A LOW-1, K5:** LUKKET. Fire samtidige gir 1 `sent` og 3 `already_sent`. ECONNRESET gir fortsatt 2 transportkall, og det er nå dokumentert.
- **A LOW-2, fysisk først:** LUKKET.
  - A sin sveip over 489 definisjoner gir akkurat tre bindbare. `physical_action_not_bindable` er nå 6 (var 4).
  - Feilmerket `home-assistant.list_states` og `car.read_vehicle_state` gir avvist bind og `attempted=0`. Simuleringen er dekket av D27, og `actOn` av D56.
- **A LOW-3 / B L5:** LUKKET. Ukjent handling gir WARN og `action_not_bindable` i simuleringen (D18, D21, D26, D51 drept).
- **A LOW-4 / B L4:** LUKKET. M49, M70, M58, K4-10, X-05/D11/D16 og X-16 er alle drept.
- **A LOW-5:** LUKKET. M34 er drept av ICU-testen.
- **B L1, redirect:** LUKKET.
  - Builderens test (35) bruker to lokale servere som 301/302/307/308-mål og dekker complete, stream, ollama, embedding og begge komposisjonsrøtter. Mutantene D34–D40 er drept. AV gir ingen `redirect`-nøkkel.
  - Alle produksjonskonstruksjoner av de lokale adapterne er dekket. Scriptene i `modules/model-gateway/scripts` er det ikke (INFO).
- **B L2, FQDN:** DELVIS.
  - Min matrise: `localhost` og `ollama` (uten punktum) beholdes. `.local`, `.lan`, `.internal`, `.home.arpa`, `*.ts.net` og `host.docker.internal` demoteres kun når DNS ikke svarer. Løste navn forblir lokale. Demotering løftes aldri tilbake.
  - Delen «kun ved oppstart» (DNS-rebinding) er fortsatt `PARTIAL`, som dokumentert.
  - Embedding med uløst navn beholdes bevisst med advarsel.
- **A MEDIUM-1, N1b:** ÅPEN som integrasjonspunkt, se (5).

**(2) Nye funn**
- **LOW, testhull:** ingen test pinner at oppstart stopper når embedding-vakten kaster.
  - `worker-main.ts:109-111` og `main.ts:340`. Mutantene D41 (worker) og D58 (main) legger `.catch(() => undefined)` på kallet og overlever alle tester.
  - Scenario: en senere «gjør oppstart robust»-endring ville sendt minnetekst til en offentlig URL uten at noe feiler.
  - Fiks: strukturtest som for K4-16, som krever at kallet ikke svelges.
- **LOW, testhull:** domenelåsen i `service.ts:1696` er ikke testet.
  - D08 (`[domain]` → `[]`) overlever builderens tester og de gamle lås-testene. Bare min R1-probe dreper den.
  - Fiks: ta `zz-g4b-delta-clear.test.ts` R1 inn som permanent test.
- **LOW, testhull:** kontrollsenterknappens body er ikke pinnet fullt ut. `authority.ts:316` D22 (ekstra felt `rule:"x"`) overlever. Feil domene-verdi (D59) dreper testene. Ekstra felt ville gi `invalid_parameters`, så knappen feiler uten å slette.
- **LOW, brukervennlighet:** Tailscale-IP som embedding-URL med vakt PÅ uten `ALLOW_TAILSCALE=on` stopper api og worker.
  - Eksempelet i `.env.example` (`http://100.86.89.57:11434`) gir `memory_embedding_must_be_local:local_url_not_local`. Compose har `restart: unless-stopped`, så det blir en omstartsløkke.
  - Feilen nevner hverken variabel eller tailnet-flagg. Runbook §11 steg 14 sier at chat-identiteter blir `demoted`, men ikke at embedding stopper oppstart.
  - Fiks: legg til en linje i steg 14 og et hint i feilkoden.
- **INFO:**
  - Seriell DNS gir opptil 4×5 s = 20 s oppstartsforsinkelse ved svart-hull (målt skalert: 483 ms ved 120 ms timeout). Compose-`start_period` er 20 s.
  - `D05`: `.sort()` på `removed_scopes` (`service.ts:1701`) er kosmetisk, og testen setter inn i sortert rekkefølge.
  - `D50` (skopet clear uten domenefilter) er ekvivalent i praksis, fordi skopnøkler er domenespesifikke.
  - Stale kommentar `service.ts:1641` og `docs/UA10_SITUATION_ENGINE_DESIGN.md:544` nevner fortsatt lese-allowlisten.
  - Tittelen «nøyaktig én rad» i `wph2-control-routes.test.ts:212` er utdatert.
  - Utdatert knappetekst er innenfor designet: et klikk fjerner også rader eieren la til etter at siden ble tegnet. De står i før-bildet.
  - `situations.clear_autonomy_policy` kalt direkte gir ingen før-bilde, men verktøyet har ingen rute og ingen modellflate.
- **Angrepsflate:** ingen funn.
  - Rom kommer kun fra identiteten. Knappen sender bare `{domain}`.
  - Eier, signert enhet og step-up er uendret (wph2: step-up-avslag, annen person, svak grant og isolasjon). B sin doc-probe (4/4) viser ingen modellflate.
  - `rule`/`category` som ikke er tekst forkastes i transporten, men zod `strict()` avviser dem før transporten nås.

**(3) Mutanter**
- Jeg kjørte 71 runder mot de nye grenene. 69 er unike, og 2 er gjenkjøringer av D10 og D08 mot eldre tester.
- Resultat: 64 drept, 7 overlevde (`mutant-results.tsv`). D10 ble drept av gamle `wph2-autonomy-revoke-db`, og D08 av min R1-probe.
- Mot builderens egne tester overlevde 6 unike mutanter: D05, D08, D22, D41, D50 og D58. Vurderingen står i (2).

**(4) Flagg AV = main**
- `wph1-flag-off-selection-baseline` (7), `wph2-flag-off-main-parity` (12), `wpn1-flag-off-differential` (7) og `part3-tool-manifest` (32) er grønne. Totalt 27 filer og 375 tester grønne.
- Ingen nye env-navn, SDK-importer eller `package.json`-endringer. Nye `process.env` er kun argument eller default.
- `check:containment` har exit 0. Typecheck for de fem berørte pakkene er OK. Compose gir NO_DRIFT (`rewriteCompose(text)===text`), og `infra/` er urørt siden `c28e2b85`.
- Vakt AV gir ingen `redirect`-nøkkel og ingen logg.

**(5) Integrasjon**
- `git merge-tree` mot N1b (`e4957e19`) og G2c (`6fb93fbe`) er rene (exit 0, 0 CONFLICT).
- Midlertidig merge mot N1b, så `merge --abort`: 17 filer og 581 tester grønne, bortsett fra `wpn1b-structure` gruppe G (3 røde). Funnet bekreftes: 23 mot 22 filer og 26 mot 25 bare, kun `apps/api/src/local-model-endpoints.ts` = 3.
- Fiks i grenen som merges sist: legg `"apps/api/src/local-model-endpoints.ts": 3` i `ALLOWED` og `ALLOWED_BARE`.
- `run-rate.ts` `LOCAL_PROVIDERS` (FIX-7) er fortsatt DEFERRED til N1b-integrasjon.

**(6) Docs-avvik**
- Runbook §19.9 (c), linje 397: «`generate-compose-env.mjs` uten `--write` gir NO_DRIFT» er feil formulert. Generatoren skriver 538 linjer og printer ikke NO_DRIFT.
- Alle sjekkede testtall i §19.9 stemmer, og `WPH2_CONTROL_CENTERS.md` stemmer med koden.
- `.env.example` ~160 er nå sann for embedding og redirect.
- `NOT VERIFIED` er ikke presentert som fakta.
- «I verste fall ETT ekstra sammendrag» (§19.5) undervurderer: ved gjentatte ECONNRESET kan det sendes ett per tikk i 12-timersvinduet.
- §19.9 merker B L2 som «LUKKET», men DNS-rebinding etter oppstart er fortsatt åpen.
- Gitleaks: 25 commits, ingen funn.

**(7) Ikke verifisert av meg**
- Ekte NAS, HA, Telegram, tailnet, en ekte 307/308-vert og DNS ved ekte oppstart (kun fakeservere og injisert lookup).
- glibc `en_US`-kollasjon.
- `pnpm lint` og hele monorepoets suite. Eldre `modules/core/test` utenfor det jeg kjørte.
- G2c-tester på det sammenslåtte treet (kun merge-tree).
- Mutantene til builderen (43) er ikke kjørt på nytt; jeg kjørte mine egne.
