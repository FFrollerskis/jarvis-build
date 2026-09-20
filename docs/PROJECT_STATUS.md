# PROJECT STATUS

**Oppdatert:** 2026-09-20 (branch `claude/charlie-integrations-dashboard`, fra fersk `origin/main` HEAD
`438ab36` = HELE "Charlie"-linjens del 1/2/7 MERGET). **"Charlie"-linjen (D-208/D-209/D-210) FERDIG.
Ny slice: Q-05 lukket (Infisical valgt) + Infisical faktisk wiret inn som primær `SecretProvider` +
eierens integrasjons-dashboard, LESE-DELEN (D-211) - klar for commit/push/draft PR.**

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19) - GJELDENDE VIDERE

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd, helt til punktet der videre fremgang
faktisk krever credentials/kontoer/MCP-koblinger - IKKE start ny scope utover masterplanen. issue #68
BEHOLDES som logg. Claude har STÅENDE FULLMAKT til å merge rutinemessige PR-er når CI er grønt/tester
består/ingen åpne funn. D-201 presiserer sluttmålet: hele masterplanen bygget/fungerende, ALLE eksterne
integrasjoner unntatt `Fiken`/`Walley` (permanent ekskludert), en helt autonom agent, drift på
UGREEN-NAS-en + Tobias sin PC (`gemma_local`) som tilleggskraft inntil dedikert maskin. Se
D-192/D-201 i DECISIONS_AND_ASSUMPTIONS.md og `CLAUDE.md` §Merge-autoritet.

**VIKTIG PRESEDENS (D-208, 2026-09-20):** D-192s delegering er IKKE ubegrenset - den gjelder rutine-
implementasjonsvalg INNENFOR eksisterende arkitektur/CLAUDE.md sine Ufravikelige regler, ALDRI en
fullmakt til å fjerne selve håndhevingsmekanismen en ufravikelig regel krever skal eksistere, selv når
eieren eksplisitt og informert ber om det (Tobias ba to ganger om full, ugjennomgått live-selvpatching
av sikkerhetskritisk kode - AVSLÅTT SOM SPESIFISERT, erstattet med en trygg to-lags modell, se D-208).

## Hvor `main` står nå

- **PR #106-#119 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119) - se git-historikk/
  DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **NY slice (IKKE ennå committet): Infisical-wiring + integrasjons-dashboard lese-del (D-211).**
  Kildekode-audit fant at `InfisicalSecretProvider` (universal-auth, D-35) og Infisicals egen
  docker-compose-tjeneste ALLEREDE eksisterte, men var ALDRI faktisk koblet inn i `main.ts`/
  `worker-main.ts` sin `ToolGateway`-konstruksjon - kun `Env`/`BusinessInternal`-kjeden ble brukt.
  - **Levert:** Q-05 (Infisical vs. OpenBao) LUKKET - Infisical valgt. `main.ts`/`worker-main.ts`
    bygger nå `FallbackSecretProvider(InfisicalSecretProvider, FallbackSecretProvider(Env,
    BusinessInternal))` - Infisical PRIMÆR, gammel kjede UENDRET som fallback (staged migration).
    TRYGT: `InfisicalSecretProvider.get()` returnerer `null` umiddelbart når ukonfigurert - lokal
    dev/CI faller rett gjennom til SAMME env-kjede som før, INGEN regresjon.
  - Ny `modules/tool-gateway/src/connector-registry.ts`: kanonisk `CONNECTOR_REGISTRY` (14
    connectorer fra `docs/INTEGRATIONS.md`/`.env.example`) + `listConnectorStatus()` via ny
    `ToolGateway.hasSecret(ref)` (presence, ALDRI verdien) + `ToolGateway.health`. `live_test` KUN
    for GitHub/Calendar/Gmail (samme tre trygge klasse A-lesinger `mesh-bridge.ts` allerede bruker) -
    resten `presence_only`, bevisst avgrenset.
  - Ny `executive.get_connector_status` (klasse A, samme "zero nøstet gateway.execute()"-mønster som
    `get_capability_status`), lagt til `EXECUTIVE_QUERY_ACTIONS`-allowlisten (fortsatt lese-kun).
  - `apps/web/dashboard.html` fikk en ny "Integrasjoner"-seksjon (status-pill + helse per connector).
  - **BEVISST IKKE i denne sliceen:** "test connector"/"lim inn nøkkel → skriv til Infisical →
    auto-test"-mutasjonsflyten - krever egen risikoklassifisering + egen policy-gatet rute, IKKE
    `/executive/query`. Egen, senere oppgave.
  - D-35s 10-punkts host-produksjonsport FORTSATT IKKE runtime-verifisert - kun kodet/wiret nå.
  - 16 nye/utvidede DB-uavhengige tester grønne (`connector-registry.test.ts`,
    `connector-status.test.ts`, `executive-query-wiring.test.ts` oppdatert, `executive-query-e2e.test.ts`
    fikk en ny sak - IKKE kjørbar lokalt, kjent sandbox-begrensning). `pnpm -w typecheck`
    (31 pakker) + `npx eslint .` rene.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET,
dekker resten av masterplanen: Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. **Fullfør denne sliceen (D-211):** secret-scan, commit, push til fersk branch, draft PR, abonner.
2. **Følgeoppgave (samme dashboard-tema, del 2):** "test connector"-mutasjon (utvid `live_test`
   utover GitHub/Calendar/Gmail) + "lim inn nøkkel → skriv til Infisical → auto-test"-flyten - krever
   en gjennomtenkt risikoklassifisering (en credential-SKRIVING er en genuint ny handlingstype) og en
   egen, policy-gatet mutasjonsrute.
3. **Deretter:** koble den allerede-bygde `apps/voice-gateway` til noe Tobias faktisk kan bruke daglig.
4. **Deretter:** design + bygg den trygge to-lags selvendrings-modellen - IKKE full ugjennomgått
   selvpatching, se D-208.
5. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer.
