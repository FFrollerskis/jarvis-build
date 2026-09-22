# PROJECT STATUS

**Oppdatert:** 2026-09-22 (branch `claude/fase-d225-stripe-real-test-acceptance`, stablet oppå
`claude/fase-d224-stripe-live-verified` som PR #137, basert på `origin/main` HEAD `78ca6c1`, PR #136
MERGET). **D-223 (voice, MERGET) / D-224 (Stripe-credentials+API-tilkobling, PR #137 ÅPEN) / D-225
(Stripe EKTE test-modus-akseptanseskript BYGGET, IKKE ENNÅ HOST-KJØRT, IKKE ENNÅ PR): tre konkrete
milepæler denne økten. PR #97 (W1 watchdog) sin host-akseptanse er PASS og rapportert til issue #68,
venter nå på uavhengig arkitektgjennomgang.**

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
grense bekreftet igjen for tale (D-212, Q-32 punkt 1) og for selvendring (D-208→D-214): eieren avslo
full ugjennomgått selvpatching TO GANGER etter eksplisitt risikogjennomgang - den vedtatte retningen
var et to-lags-kompromiss, ikke en full fullmakt.

**LÆRDOM (D-218→D-222, 2026-09-21):** "lokalt kodbart arbeid oppbrukt" er IKKE en selv-uttalt
konklusjon som skal stå uimotsagt - Tobias sitt "Fortsatt å bygg"/"fortsett å bygg" (FEM separate
ganger samme dag) etter nøyaktig en slik påstand utløste fem runder som alle fant en reell, ubestridt
bug av SAMME anti-mønster-klasse (`.catch(() => undefined)`/bar `catch {}` som svelger feil sporløst).
D-220 ble tatt av CI for en feil DB-atferds-antakelse i egen test; D-221 anvendte den lærdommen
PROAKTIVT (dokumenterte/verifiserte `.catch()`-kjeding krever avviste løfter, ikke synkrone kast, OG at
en simulert ROLLBACK-feil likevel må utføre en EKTE ROLLBACK for å ikke korrumpere senere tester FØR
push) - CI grønt på FØRSTE forsøk. D-221s egen metode-lærdom: D-220s editering av to filer etterlot
tre søsken i SAMME filer - et grep bør derfor lete etter BÅDE `.catch(() => undefined)` OG et bart
`catch { }` uten fanget feil-variabel (sistnevnte er et STERKERE signal - ingen mulighet til å logge
originalfeilen uten en kodeendring). D-222s egen metode-lærdom: da D-221 sin egen "ingen kjent uløst
kandidat gjenstår"-konklusjon (korrekt, INGEN navngitt kandidat var glemt) møtte en ny "fortsett å
bygg", var riktig neste steg et HELT FRISKT, BREDT søk på tvers av HELE `apps/`/`modules/` (ikke bare
filene forrige runde rørte ved) - fant fire helt nye forekomster i TRE andre moduler
(`tool-gateway`/`situations`/`apps/api`), utenfor erasure-domenet D-218→D-221 hadde fokusert på.
Praktisk konklusjon for neste runde: sjekk FØRST om forrige runde selv la igjen en navngitt, uløst
kandidat; er den listen tom, kjør et helt friskt bredt søk FØR "oppbrukt" konkluderes igjen.

## Hvor `main` står nå

- **PR #106-#135 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120), voice-gateway daglig-bruk-overflate (D-212, PR #121),
  connector credential-skriving + utvidet live_test (D-213, PR #122), trygg selvendring - to-lags-
  modellen (D-214, PR #123), selvendring - EKTE requires_approval-produsent for vilkårlig kode + merge-
  koblingen (D-215, PR #125), UA-11 executive dashboard mutasjons-delen (D-216, PR #126), lokal
  whisper.cpp/piper STT/TTS - EKTE subprosess-implementasjon (D-217, PR #128), FEM uavhengige "silent
  error swallowing"-fikser (D-218 scheduler/D-219 policy-avslag-audit/D-220 erasure-fail-status-persist/
  D-221 erasure-rollback-stier/D-222 telegram+advisory-lock+device-registry, PR #130+#132+#133+#134+#135)
  - se git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **D-223 (2026-09-22, PR #136 MERGET, `78ca6c1` - ren dokumentasjons-/statusoppdatering, INGEN
  kodeendring):** Q-32 punkt 3 (lokal whisper.cpp/piper) er nå FULLSTENDIG lukket, ikke bare kode.
  Tobias lastet ned og installerte `whisper-cli.exe`+`ggml-small.bin` (whisper.cpp, fra `b5130`
  nightly-CI-releasen, IKKE hovedreleasen som kun har kildekode) og `piper.exe`+
  `no_NO-talesyntese-medium.onnx` (piper, norsk stemme fra `rhasspy/piper-voices`) på sin egen
  Windows-maskin, satte alle fire `JARVIS_WHISPER_*`/`JARVIS_PIPER_*`-miljøvariabler, og bekreftet EKTE
  norsk tale-syntese (`piper.exe` produserte en reell `.wav`-fil fra norsk tekst, avspilt og bekreftet
  å faktisk høres ut som norsk). D-217 sine `UNVERIFIED`-CLI-flagg-antakelser er nå bevist korrekte mot
  ekte binærer. Se D-223 i DECISIONS_AND_ASSUMPTIONS.md for full detalj.
- **D-224 (2026-09-22, PR #137 ÅPEN mot `main`, branch `claude/fase-d224-stripe-live-verified` - ren
  dokumentasjons-/statusoppdatering, INGEN kodeendring):** Stripe - ekte credentials konfigurert OG
  faktisk API-tilkobling bevist. Tobias opprettet en Stripe-konto, satte `JARVIS_STRIPE_SECRET_KEY`
  (`rk_live_...` restricted key)/`JARVIS_STRIPE_WEBHOOK_SECRET` (via `stripe listen --all-snapshot
  --live`)/`JARVIS_STRIPE_TENANT_ID` i `.env`, og et direkte `curl` mot `api.stripe.com/v1/balance`
  returnerte et ekte autentisert svar (`livemode:true`, `nok`). **PRESIST: dette er IKKE
  `STRIPE_LIVE_GATE=PASS`** - ingen eksisterende kodesti øvde faktisk `stripe_payment_execution`/
  `stripe_refund_execution`/`stripe_webhook_reachability` mot disse credentialene på dette tidspunktet (
  `stripe-live.ts`/`stripe-live-host-run.ts` bruker bevisst en fake transport-factory uansett ekte
  nøkler). Gate oppdatert fra `PENDING_CREDENTIALS` til
  `CREDENTIALS_CONFIGURED_AWAITING_LIVE_ACCEPTANCE_SCRIPT`. Se D-224 i DECISIONS_AND_ASSUMPTIONS.md,
  `docs/RUNTIME_GATES.md`, `docs/SOVEREIGN_GRADUATION_MATRIX.md` for full detalj.
- **D-225 (2026-09-22, DENNE branchen `claude/fase-d225-stripe-real-test-acceptance` - stablet oppå
  D-224-branchen som egen PR mot `main` - EKTE KODE denne gangen, ikke docs):** "gå videre med Stripe-
  akseptanseskriptet" - bygget `modules/finance/scripts/stripe-real-payment-acceptance.ts`+
  `-host-run.ts`, som lukker DEN NØYAKTIGE mangelen D-224 flagget - et akseptanseskript som faktisk
  gjør EKTE Stripe-API-kall (gjenbruker den allerede ferdigbygde `StripeTransport`, INGEN ny
  produksjonstransportkode) mot en Stripe TEST-modus-nøkkel (ny env-var `JARVIS_STRIPE_TEST_SECRET_KEY`,
  ALDRI den ekte live D-224-nøkkelen - tre uavhengige D-41-blast-radius-lag). Beviser, NÅR faktisk
  host-kjørt: `stripe_payment_execution` (ekte create+bekreft-med-test-kort+refresh),
  `stripe_refund_execution` (ekte refusjon), `stripe_webhook_reachability` (spawner ekte `stripe
  listen`, fanger dens ferske `whsec_`, lar Stripe sin EGEN ekte webhook-hendelse ankomme den kjørende
  serveren - ingen håndlaget fake-signatur denne gangen). `pnpm -w typecheck` (32/32)/`npx eslint .`
  rene. **IKKE ENNÅ HOST-KJØRT** - `STRIPE_LIVE_GATE` forblir UENDRET
  `CREDENTIALS_CONFIGURED_AWAITING_LIVE_ACCEPTANCE_SCRIPT` inntil Tobias faktisk henter en gratis Stripe
  TEST-nøkkel og kjører scriptet. Se D-225 i DECISIONS_AND_ASSUMPTIONS.md for full detalj.

## Andre åpne PR (utenfor denne øktens D-192-scope)

- **PR #97 (W1 watchdog produksjons-wiring, D-180)**, branch `claude/fase-w1-watchdog-runtime-
  durability`, opprettet 2026-09-19 via issue #68 sin `ARCHITECT_TASK`-protokoll - IKKE del av denne
  øktens direkte D-192-chat-arbeid. **OPPDATERT 2026-09-22: HOST-AKSEPTANSE PASS** - Tobias kjørte
  akseptanseharnesset ekte mot Docker/Postgres på egen maskin (`run_id=2e40685c`, `hard_fail=false`,
  alle 12 markører PASS). PR-en er oppdatert med full evidens og tatt ut av draft, og en `CLAUDE_REPORT`
  er postet til issue #68 (`INTERNAL_BUILD_COMPLETE=true`, `MERGE_AUTHORIZED=false` uendret - venter nå
  KUN på uavhengig ChatGPT-arkitektgjennomgang, ikke lenger på host-akseptanse). Flagget for arkitekten:
  branchens base (`9ede3ac1`, fra 19. sept) ligger nå godt bak `main` - arkitekten må vurdere om
  rebase/merge-med-main trengs før en eventuell merge-task.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - dekker
resten av masterplanen: Growth-stack live-evidens, iPhone/Watch/Home/Personal/Health LIVE, off-site
backup/monitoring. Se `docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.
Q-32 punkt 1 (OpenAI som taleprosessor) er FORTSATT en egen, ekstern blokkering (ren eier-/juridisk
avklaring - Tobias fikk en konkret steg-for-steg-guide denne økten for å verifisere DPA/region/
treningsbruk/retensjon selv) - se `docs/OPEN_QUESTIONS.md`. **Q-32 punkt 3 (lokal whisper.cpp/piper)
er nå FULLSTENDIG LUKKET (D-217+D-223) - ingen gjenstående handling.** **Stripe (D-224+D-225):
credentials er KONFIGURERT og API-tilkobling BEVIST (D-224), og det manglende akseptanseskriptet er nå
BYGGET (D-225) - men `STRIPE_LIVE_GATE` er FORTSATT IKKE `PASS`** - gjenstående arbeid er REN
EKSTERN HANDLING fra Tobias: hente en gratis Stripe TEST-modus-nøkkel
(`JARVIS_STRIPE_TEST_SECRET_KEY`) og faktisk kjøre
`stripe-real-payment-acceptance-host-run.ts` på egen maskin - ingen kode gjenstår.
PR #97 (W1 watchdog) er nå KUN blokkert på
uavhengig arkitektgjennomgang (issue #68) - host-akseptanse er PASS, se over. D-35s 10-punkts
host-produksjonsport for Infisical fortsatt ikke runtime-verifisert (uendret fra D-211).
Embedded-Postgres DB-avhengige tester (`initdb: Permission denied`) kan fortsatt ikke kjøres i DENNE
sandbox-økten - kjent, uendret begrensning; CI (GitHub Actions) kjører dem derimot uten problemer.

## Neste oppgave

1. **Push/merge D-224-dokumentasjonsoppdateringen** (PR #137, ren docs) under D-192, deretter
   **push/åpne PR for D-225** (EKTE kode - `stripe-real-payment-acceptance.ts`/`-host-run.ts`, stablet
   oppå D-224-branchen).
2. **Overvåk issue #68** for arkitektens svar på PR #97 sin `CLAUDE_REPORT` - når/hvis en
   `ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` kommer, følg standard merge-sekvens
   (eksakt HEAD-/base-guard rett før merge, kun to-forelder-merge).
3. **Fersk, BREDT kode-nivå gap-søk FØRST** (grep etter BÅDE `.catch(() => undefined)` OG et bart
   `catch { }` uten fanget feil-variabel, HELE `apps/`/`modules/`, ikke bare tidligere rørte filer - se
   D-222-lærdommen) hvis bedt om å fortsette å bygge - ingen kjent, allerede-registrert uløst kandidat
   gjenstår fra DENNE anti-mønster-klassen akkurat nå.
4. **Stripe REN EKSTERN handling gjenstår (D-225):** Tobias må hente en gratis Stripe TEST-modus-nøkkel
   og kjøre `stripe-real-payment-acceptance-host-run.ts` FØR `STRIPE_LIVE_GATE` kan bli `PASS` - ingen
   kode gjenstår fra Claude sin side.
5. **OpenAI-taleprosessor-avgjørelsen (Q-32 punkt 1):** Tobias fikk en konkret guide denne økten
   (platform.openai.com -> Data controls -> DPA/region/treningsbruk/retensjon) - venter på at han
   kommer tilbake med de fire konkrete svarene, så `docs/security/PROCESSOR_REGION_MATRIX.md` kan
   fylles inn og `processor_terms_status` flippes til `VERIFIED`.
6. Deretter valgfritt for Tobias: Apple Developer-konto/HA-instans, Google Ads-konto, off-site backup,
   Gemini-nøkler. Merk: Tobias sin `rk_live_...` Stripe-nøkkel ble limt inn direkte i chat under
   installasjonen (D-224) - han er selv klar over dette og har bekreftet at han roterer den senere;
   ingen handling påkrevd fra Claude nå utover å ikke glemme å nevne det om anledningen byr seg.
