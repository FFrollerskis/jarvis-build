# PROJECT STATUS

**Oppdatert:** 2026-09-20 (branch `claude/fase-connector-credential-write`, fra fersk `origin/main` HEAD
`8ffe6c3` = voice-gateway daglig-bruk-overflate (D-212) MERGET). **Ny slice: task #122 - connector
credential-skriving ("lim inn nøkkel → skriv til Infisical → auto-test") + utvidet `live_test` fra 3 til
8 av 14 connectorer (D-213) - klar for commit/push/draft PR.**

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
fullmakt til å fjerne selve håndhevingsmekanismen en ufravikelig regel krever skal eksistere. Samme
grense bekreftet igjen for tale (D-212, Q-32 punkt 1 - hard ekstern/juridisk blokkering).

## Hvor `main` står nå

- **PR #106-#121 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120), voice-gateway daglig-bruk-overflate (D-212, PR #121)
  - se git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **NY slice (IKKE ennå committet): connector credential-skriving + utvidet live_test (D-213, task #122).**
  D-211 leverte kun LESE-delen av integrasjonsdashbordet og utsatte credential-SKRIVING eksplisitt som
  "en genuint ny mutasjonstype". Denne sliceen leverer den utsatte delen.
  - **Skrivekapabilitet:** ny `WritableSecretProvider`-tilleggskontrakt (`gateway.ts`), implementert av
    `InfisicalSecretProvider.set()` (PATCH FØRST/oppdater, POST kun på 404/opprett - verifisert mot
    Infisicals offisielle raw secrets v3-API). `ToolGateway` fikk et NYTT, separat `writableSecrets`-
    konstruktørargument (5. posisjon, ALDRI sammenblandet med den eksisterende les-fallback-kjeden) +
    `ToolGateway.setSecret(ref,value)`, fail-closed uten konfigurert skrive-provider. `main.ts`/
    `worker-main.ts` hoister nå `infisicalSecretProvider` til en navngitt konstant, gitt inn BÅDE i
    les-kjeden og det nye skrive-argumentet - SAMME instans.
  - **Mutasjonshandlinger:** to nye `owner_controls.*`-handlinger (SAMME pakke som allerede eier
    credential-livssyklusen via `revoke_credential`/`restore_credential`): `set_connector_credential`
    (klasse C, samme nivå som `revoke_credential` - `credential_ref` MÅ stå i `CONNECTOR_REGISTRY` for
    DEN PÅSTÅTTE `connector_id`-en, ellers avvist FØR skrivekall - hindrer en vilkårlig secret-skrive-
    primitiv; verdien ekkoes/logges ALDRI) og `test_connector` (klasse A - nøstet `gateway.execute()`
    mot connectorens `live_test`, D-68-identitetsvidereformidling; presence_only gir en strukturert
    "kan ikke live-testes"-respons, aldri en feil).
  - **Ny HTTP-rute:** `POST /owner-controls/connector-credentials` - HELT EGEN rute (`/executive/query`
    forblir lese-kun for alltid, D-199), eget hardkodet allowlist begrenset til de to nye handlingene -
    kill switch/frys/tilbakekall/enhetstilbakekall UNÅDBARE herfra.
  - **Utvidet `live_test`:** google_drive/telegram (ny `get_bot_info`-handling, Telegram Bot API
    `getMe`)/vercel/neonomics/wallester lagt til - alle eksisterende, verifiserte klasse A-lesinger.
    Fiken/Stripe/Vipps og Anthropic/OpenAI/Gemini forblir BEVISST presence_only (ingen trygg lesing
    uten sideeffekt/forhåndsbetingelse, hhv. en helt annen kallevei via ModelGateway).
  - **Dashboard-UI:** `dashboard.html` sin "Integrasjoner"-seksjon fikk "lim inn nøkkel"-inputrader
    (type=password) og "Test tilkobling"-knapper, via event-delegering.
  - 43 nye/utvidede DB-uavhengige tester + 6 nye DB-avhengige e2e-tester (kjent sandbox-begrensning,
    verifiseres av CI) + `pnpm -w typecheck` (31 pakker) + `npx eslint .` rene.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET,
dekker resten av masterplanen: Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR. Q-32 punkt 1 (OpenAI som
taleprosessor) og punkt 3 (lokal whisper.cpp/piper) er egne, eier-/eksterne blokkeringer - se
`docs/OPEN_QUESTIONS.md`. D-35s 10-punkts host-produksjonsport for Infisical fortsatt ikke
runtime-verifisert (uendret fra D-211).

## Neste oppgave

1. **Fullfør denne sliceen (D-213):** secret-scan, commit, push til fersk branch, draft PR, abonner.
2. **Deretter (task #121):** design + bygg den trygge to-lags selvendrings-modellen - IKKE full
   ugjennomgått selvpatching, se D-208.
3. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer, OG Q-32 punkt 1
   (OpenAI som taleprosessor - juridisk/eier-verifisering) og punkt 3 (whisper.cpp/piper-installasjon).
