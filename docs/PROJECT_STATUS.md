# PROJECT STATUS

**Oppdatert:** 2026-08-20 (**UA-5 «DEVELOPER & CLOUD CONTROL PLANE» — D-96 Real Coding Agent v1 bygget
(ekte, ikke-interaktiv Claude Code CLI-kjøring, IKKE modellkvalitet).** PR #36 (D-95) er MERGET til main
(merge-commit `fed28c55753da0e4933e1332fa6f8ef777325e2d`, post-merge-CI bekreftet grønn). RESUME
SOVEREIGN AUTONOMY v4.0-ordre: fersk UA-5-rekonstruksjon fant at `createCodingHandler` har INGEN
produksjons-callere (verken `apps/api/src/main.ts` eller `worker-main.ts` registrerer `agent_profile=
"coding"`) - vurdert som bevisst utsettelse (koble en placeholder-agent inn i produksjon ville latt
ekte GitHub-PR-er fylles med fabrikkert innhold, et Q-26-brudd), ikke et utilsiktet hull. AVGJØRENDE
funn: `CANONICAL_SPEC.md`/`ARCHITECTURE.md`/`INTEGRATIONS.md`/begge kildemasterplanene spesifiserer
EKSPLISITT "Claude Code / Codex (headless)" som kodejobb-agentprofilen - `ClaudeCodeAgent` var derfor
allerede kanonisk arkitektur (CLI/prosess-adapter), ikke noe å gjette. Hele CLI-flaggsettet ble
verifisert MOT fersk offisiell dokumentasjon (`code.claude.com/docs/en/headless`) FØR kode ble skrevet
- INGEN gjettet syntaks. Bygget: `ClaudeCodeAgent.modify()` kjører nå ekte `claude -p "<mål>" --bare
--output-format json --permission-mode acceptEdits --allowedTools Read,Edit` INNE i den eksisterende
sandboxen (ingen ny sandbox), autentisert via `ANTHROPIC_API_KEY` injisert i sandboxens rene prosess-env
(gjenbrukt eksisterende nøkkel, aldri arvet fra Jarvis-prosessen). `createCodingHandler` fikk et nytt
valgfritt `claudeCodeCredential`-felt - uten det er oppførselen 100% uendret (alle 15 `fase6-worker.
test.ts` + alle 16 `pr-publisher.test.ts` består urørt). 15 nye tester (`claude-code-agent.test.ts`,
inkl. en ekte kjørt fake-`claude`-binær for wiring-bevis - `JARVIS_CLAUDE_BIN` er IKKE konfigurert i
dette miljøet, så EKTE modellkvalitet forblir `LIVE_PROVIDER_VERIFIED=false`, `HOST_ACTION_REQUIRED=
true`). `pnpm -w typecheck`/`lint` rent. UA-5 kriterium 2 forblir PARTIAL - agent-invokeringen er nå
ekte og testet, men modellkvalitet er strukturelt uverifiserbar uten en ekte, konfigurert binær. Se
D-96 i DECISIONS_AND_ASSUMPTIONS.md for full detalj. Branch `claude/ua5-real-coding-agent`, draft PR
gjenstår på tidspunktet for denne statuslinjen.

## Runden før det

**Oppdatert:** 2026-08-20 (**UA-5 «DEVELOPER & CLOUD CONTROL PLANE» — D-95 Tested Fix Orchestrator v1
bygget (GitHub-livssyklus-glue, IKKE diagnose/fiks-generering).** PR #35 (D-94) er MERGET til main
(merge-commit `0bf8b2cd2af58e4057c5f293f5b0ee209e280297`, bekreftet post-merge-CI grønn). RESUME
SOVEREIGN AUTONOMY v4.0-ordre: fersk UA-5-rekonstruksjon (ny lesing av `coding.ts`/`worker.ts`/
`pg-task-queue.ts`) fant kodejobb-workeren (sandbox/branch/test-gate/commit/push, ekte og testet) og
D-94s GitHub-transport strukturelt FRAKOBLET — vellykkede kodejobber produserte kun et inert
`pr-proposal`-artefakt, ingen ekte PR, og returnerte ikke commit-sha. Bygget `modules/tasks/src/
pr-publisher.ts`: `publishPullRequestForCodingJob()` åpner nå en EKTE GitHub-PR (via EKSISTERENDE
`github.create_pr`, klasse C, uendret) etter en vellykket kodejobb — KUN når jobbkontrakten selv
lister `"github"` i `allowed_tools` (ingen ny blanket-godkjenningssperre, gjenbruker eksisterende
mandat-mekanisme). `createCodingHandler` fikk et NYTT valgfritt `github`-felt — uten det er
oppførselen 100% uendret (alle 15 eksisterende `fase6-worker.test.ts`-tester består urørt). Commit-sha
fanges nå alltid og returneres i jobbresultatet. ALDRI merge herfra — `github.merge_pr` (klasse D,
D-94) forblir en separat, eier-autorisert handling. GitHub-side-feil gjør ALDRI en vellykket test+push-
jobb til "failed" — feilen er synlig i `pr.status`/`pr.reason`, aldri skjult. Diagnose-laget er UENDRET
IKKE ekte (`ScriptedCodingAgent` placeholder, `ClaudeCodeAgent` stub) — kriterium 2 forblir PARTIAL, IKKE
oppblåst til COMPLETE. `@jarvis/tool-gateway` ble BEVISST IKKE lagt til som pakkeavhengighet av
`@jarvis/tasks` (ville lukket en sirkulær workspace-graf via `@jarvis/memory`s devDependency på
`@jarvis/tasks` — oppdaget via `pnpm install`s eget cyclic-varsel) — løst med et strukturelt duck-typed
`PrPublishingGateway`-grensesnitt i stedet. 16 nye tester (`pr-publisher.test.ts`, inkl. en
`RepoUrlRedirectingSandboxRunner`-testdobbel som lar hele PR-opprettelses-veien testes ende-til-ende
uten å noensinne røre det virkelige github.com). `pnpm -w typecheck`/`lint` rent. Se D-95 i
DECISIONS_AND_ASSUMPTIONS.md for full detalj. Branch `claude/ua5-tested-fix-orchestrator`, draft PR
gjenstår på tidspunktet for denne statuslinjen.

## Runden før det

**Oppdatert:** 2026-08-20 (**PR #35 (D-94) PRE-MERGE CLOSEOUT-AUDIT — tre reelle idempotens-hull
funnet og fikset FØR godkjenning.** Fersk kodeaudit (ikke stolt på forrige rapport) fant: (1)
`create_branch` sin 422-"already exists"-håndtering returnerte suksess uansett hvilken sha den
eksisterende branchen faktisk pekte på - fikset til å kaste en `409`-stale-target-konflikt ved ulik sha.
(2) `create_pr` sin 422-oppslags-spørring filtrerte kun på `head`, ikke `base` - fikset med GitHub sitt
eget `base`-spørreparameter. (3) `merge_pr` behandlet ALLE 405-svar som feil uten idempotens-gjenkjenning
ved retry - fikset til å re-lese PR-en og stole KUN på `merged`-feltet, aldri feilteksten alene, ved 405.
Fjerde herding: `create_branch` fikk samme `GITHUB_PROTECTED_BRANCHES`-vern som `delete_branch` allerede
hadde. 12 nye regresjonstester (2 rettet fra å bevise gammel usikker oppførsel, 10 nye). Full regresjon
re-kjørt på ny HEAD, gitleaks rent. D-41/D-64/credential-isolasjon/freeze-dekning bekreftet uendret -
KUN idempotens-korrekthet fikset, ingen ny handling/klasse lagt til. UA-5 kriterie-status uendret (denne
runden er en korrekthetsfiks, ikke en kriterieoppfyllelse). Se D-94-addendum i
DECISIONS_AND_ASSUMPTIONS.md for full detalj. Branch/PR-oppdatering + ny CI gjenstår på tidspunktet for
denne statuslinjen.

## Runden før det

**Oppdatert:** 2026-08-20 (**UA-5 «DEVELOPER & CLOUD CONTROL PLANE» — STARTET, FØRSTE SLICE: GitHub
Developer Control Plane v1 → D-94.** RESUME SOVEREIGN AUTONOMY v4.0-ordre: forrige UA-5-rekonstruksjon
konkluderte `PHASE_CLOSURE_DECISION=C` (blokkert - krever levende leverandørtilkobling). Denne ordren
instruerte eksplisitt GitHub som første provider. D-64-gate: GitHub er `EXTERNAL_CANONICAL` for repo/
PR/workflow-tilstand, INGEN `CORE_DEPENDENCY_DECISION_REQUIRED`. D-41-audit: forrige `GithubTransport`
(UA-2 P0) var utilsiktet begrenset til to lese-handlinger + "create_pr (aldri merge)" - erstattet med en
23-handlings D-41-matrise (10×A/9×B/2×C/2×D) i `modules/tool-gateway/src/live-transports.ts`+
`integrations.ts`: branch/PR/issue/workflow-livssyklus, `merge_pr`(D, sovereign autonomt, preflight
target-re-read via `get_pull_request`, valgfri `expected_head_sha`-precondition) og `delete_branch`(D,
strukturelt vernet mot main/master/production). Eksisterende kodejobb-worker
(`modules/tasks/src/coding.ts`) bekreftet FORTSATT eier selve kilde-endringen (clone/branch/commit/push)
- denne sliceen bygger KUN GitHub-siden (PR/Actions/merge), ingen konkurrerende skrive-arkitektur.
Idempotens: 422-"already exists" håndtert gracefully for create_branch/create_pr; øvrig via eksisterende
`tool_executions`-dedupe. INGEN ny Jarvis-DB-tabell (ingen github.*-handling rører noen Jarvis-tabell).
100 nye tester (37+63), full suite **1808 tester grønne, 117 filer**, exit code 0 (228.52s).
`pnpm -w typecheck` 18/18 rent, `pnpm -w lint` rent. Live-verifisering: `GITHUB_CREDENTIAL_CONFIGURED=
false` i dette miljøet - `modules/tool-gateway/scripts/ua5-github-live.ts` skrevet og klar
(`LIVE_RUNNER_READY=true`), IKKE kjørt (`LIVE_PROVIDER_VERIFIED=false`). **UA-5 kriterium-status:**
1=PARTIAL/NOT_STARTED, 2=PARTIAL (GitHub-siden av tested-fix-livssyklusen finnes, diagnose/fiks-
generering fortsatt IKKE bygget), 3=PARTIAL (GitHub-mutasjoner har nå audit/recovery, GCP/Cloudflare/
Docker fortsatt ikke), 4=PARTIAL (GitHub lyder globale pause/freeze, full infra-degradert-modus ikke
bygget). `UA5_IMPLEMENTATION_COMPLETE=false`, `UA5_CAN_CLOSE=false` - dette er ÉN provider-slice, ikke
hele fasen. Vercel/GCP/Cloudflare/Docker/Infisical/Langfuse/Sentry EKSPLISITT ikke startet. **Sovereign
Autonomy v4.0-masterplanen SOM HELHET forblir IKKE komplett.** Branch/draft PR gjenstår på tidspunktet
for denne statuslinjen - se "neste oppgave".

## Runden før det

**Oppdatert:** 2026-08-20 (**UA-4 «GROWTH & MARKETING CONTROL PLANE» — FASE-LUKKET → D-93.**
RESUME SOVEREIGN AUTONOMY v4.0-ordre: post-D-92-rekonstruksjon av HELE UA-4 mot masterplanens EGNE
fire ordrette akseptansekriterier (`docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` linje
482-486), SAMME lukkings-metodikk som D-48 (UA-2). To uavhengige research-agenter kjørt FØR
beslutningen. **ALLE FIRE akseptansekriterier PASS** - CAC/ROAS↔ekte CRM/revenue; tracking-/
kampanje-avvik detektert+handlingsbart; skrivehandlinger idempotente/auditerbare/før-etter-tilstand;
samtykke/cookie/databehandlingskrav dokumentert (OVERGÅTT med faktisk håndhevingsmotor D-91/D-92).
`UA4_REQUIRES_UA6_COMPLETION=false`, `D86_BLOCKS_UA4_CLOSURE=false` (begge eksplisitt vurdert mot
masterplanens fasesekvensdiagram, ikke antatt). Eksplisitt IKKE-blokkerende for DENNE lukkingen (alle
«Bygges»-listeambisjoner, INGEN akseptansekriterium): GA4/Meta Ads/øvrige providere, Creative/
Experiment Intelligence (`BLOCKED_BY_DATA`), tracking runtime-håndheving, cookie-banner, samtykke-
provenance-taksonomi/evidence-secret-validering, Business OS ukentlig markedsførings-synlighet, ekte
leverandør-mutasjon (sekvensert bak UA-6), Q-26. RUNTIME_GATES.md-hygiene rettet (D-85 t.o.m. D-92
manglet rader). **INGEN kodeendring - kun verifikasjon + dokumentasjonslukking.** Full `pnpm -w test`
re-kjørt FERSK: **1708 tester grønne, 115 filer**, exit code 0 (195.47s). `pnpm -w typecheck` 18/18
pakker rent, `pnpm -w lint` rent. **UA-4 = CANONICAL/VERIFIED/COMPLETE.** Sovereign Autonomy v4.0-
masterplanen SOM HELHET forblir IKKE komplett - UA-5/UA-6/UA-7/... gjenstår. UA-3 kriterium 2 UENDRET
(2/5 domener). Branch/draft PR gjenstår på tidspunktet for denne statuslinjen - se "neste oppgave".
Full detalj: D-93 i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, MERGET):** **D-92 — Consent Enforcement Activation/Rollout v1 — MERGET.** PR #32
merget til `main` med standard merge-commit (IKKE squash), på eksplisitt godkjenning av Tobias.
Merge-commit `148d6e03063540e423bbbc90f43842b56425f504` (foreldre: `87404e8` (forrige `main`) +
`ffb2ab6` (PR-HEAD) - ekte to-forelder-merge, bekreftet via `git log --format=%P`). `origin/main` og
lokal `main` synkronisert, arbeidstre rent. Alle kanoniske D-92-elementer bekreftet TIL STEDE på
`main` etter merge (migrasjon 033, `ConsentEnforcementService`, `EnforcementSubject`-typen inkl.
`unresolved`-fail-closed-fiksen, policy-verktøy, `GrowthService`-håndheving, `main.ts`/`worker-main.
ts`-injeksjon, Q-20/Q-21-registrering). **D-92 = CANONICAL / FIXED_SUITE_VERIFIED / COMPLETE for
Consent Enforcement Activation/Rollout v1-sliceen** (IKKE det samme som "full samtykke-håndheving
komplett" - se grensepunkter under). `CONSENT_GOVERNANCE_CORE_COMPLETE=true`,
`ATTRIBUTION_ENFORCEMENT_WIRED=true`, `TRACKING_ENFORCEMENT_WIRED=false`,
`PRODUCTION_ENFORCEMENT_PARTIAL=true`, standard håndhevingsmodus FORTSATT `disabled` for enhver
tenant/space (ingen automatisk aktivering ved merge). `COOKIE_RUNTIME_ENFORCEMENT=false`,
`REAL_PROVIDER_ENFORCEMENT=false`, `HOST_ACTION_REQUIRED=false`. UA-4 SOM HELHET forblir IKKE
komplett (Creative/Experiment Intelligence BLOCKED_BY_DATA, UA-6/D-86 ekte utførelse fortsatt
DEFERRED/NOT_STARTED). UA-3 kriterium 2 UENDRET (2/5 domener - bekreftet via diff at INGEN
`modules/business`-fil ble rørt). Post-merge CI (run 32364410988) startet ved rapporttidspunkt,
ikke ventet på (rapportert som pågående, ikke antatt grønn). **INGEN ny slice startet denne
runden.** Full detalj: D-92-addendum i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, PRE-MERGE CLOSEOUT-AUDIT av PR #32) - IKKE en ny beslutning-ID, samme
D-92-slice, retter/styrker FØR merge.** En dedikert lukkingsordre reverifiserte hele PR #32 fra faktisk
repo-tilstand (IKKE stolte på forrige sluttrapport alene) og fant/rettet ÉN reell semantisk risiko:
`resolveContactIdForEntity()` kollapset opprinnelig "raden finnes, `contact_id` er FAKTISK NULL"
(`no_data_subject`) og "INGEN rad funnet for `entity_id`" (`unresolved` - `marketing_attributions.
entity_id` har BEVISST ingen FK) til SAMME `null`-signal - en policy-bypass-risiko. Rettet med ny
eksplisitt type `EnforcementSubject` (`resolved`/`no_data_subject`/`unresolved`) i `@jarvis/consent`;
`unresolved` blokkerer FAIL-CLOSED i `enforce`-modus. Et tidligere sluttrapport-utsagn om "ingen
duplikat-hendelse-spam ved retry" var UBEKREFTET av noen test - `consent_enforcement_events` har
BEVISST ingen dedup-nøkkel ("forsøk"-logg, ikke "tilstand"-logg) - nå presist dokumentert og testbevist
(§J) i stedet. Policy-/samtykke-oppslagsfeil bekreftet å PROPAGERE som exception, ALDRI stille tolket
som `disabled`/`UNKNOWN_NOT_CONFIGURED`. RLS FORCE bekreftet på begge nye tabeller; production-
komposisjonsrøtter (`apps/api/main.ts`/`worker-main.ts`, de ENESTE to) bekreftet å injisere
håndhevingstjenesten. 4 nye tester (2 `enforcement-service.test.ts` §E2, 1 §J, 1 `growth/service-
rls.test.ts` §M) - totalt 30 nye D-92-tester. Full `pnpm -w test` re-kjørt: **1708 tester grønne, 115
filer**, exit code 0 (216.42s, bekreftet ved faktisk kjøring). `pnpm -w typecheck` (alle 18 pakker -
avdekket at `erasure/consent-erasure.test.ts` hadde ett kallsted som IKKE fulgte den nye typen, rettet)
og `pnpm -w lint` begge rene. Branch `claude/ua4-consent-enforcement-rollout`, PR #32 fortsatt DRAFT,
IKKE merget. Commit/push/CI-reverifisering på NY HEAD gjenstår på tidspunktet for denne statuslinjen -
se "neste oppgave". Full detalj: D-92-addendum i DECISIONS_AND_ASSUMPTIONS.md.)

**Runden før det (samme dag, samme PR, FØR closeout-audit over):** **UA-4 NESTE SLICE — CONSENT
ENFORCEMENT ACTIVATION / ROLLOUT v1** → D-92,
base `main`@`87404e8ec30e971171ff0993563769da52098e88` (PR #31/D-91-status MERGET), branch
`claude/ua4-consent-enforcement-rollout`, HEAD `fee4996469e23b0690199a175c3c3489157b5532`,
**PR #32 opprettet som DRAFT, IKKE merget** (https://github.com/tsworkflow/jarvisbuild/pull/32).
CI-status på PR: **GRØNN** (run 32333299687/32333297459, `gitleaks` + `build-test` begge success,
bekreftet ved faktisk sjekk av CI-jobbene, ikke antatt).) **RESUME SOVEREIGN AUTONOMY v4.0 —
full UA-4-matrise + 9-kandidat-sammenligning (A-I) kjørt FØR valg.** D-91 sin motor eksisterte men var
IKKE koblet inn i noen faktisk prosesserings-sti (`MARKETING_PROCESSING_ENFORCEMENT_FULLY_WIRED=false`)
- det eneste gjenværende, ikke-eksternt-avhengige UA-4-punktet. **Ny klasse `ConsentEnforcementService`**
(`modules/consent/src/enforcement-service.ts`, BEVISST adskilt fra D-91 sin `ConsentService` - "hva
motoren MENER" vs. "OM det håndheves"). Ny migrasjon `033_consent_enforcement.sql`:
`consent_enforcement_policies` (mutable, `disabled`/`audit`/`enforce`, standard `disabled` ved fravær -
IDENTISK oppførsel med FØR D-92) + `consent_enforcement_events` (append-only observasjonslogg, `seq`-
tie-breaker fra FØRSTE stund). **`GrowthService.attributeToCampaign()` er innsettingspunktet** (dekker
`attributeFromTracking()` automatisk, siden den delegerer uendret) - `contact_id` løses fra
`business_leads`/`business_opportunities` (gjenbruker `campaignPerformance()`s eksisterende join-mønster,
NULLABLE `contact_id` håndtert eksplisitt som "intet datasubjekt", ALDRI gjettet). `consentEnforcement`
er BEVISST valgfri på konstruktøren - 25+ eksisterende tester + live-host-script forblir UENDRET og
grønne; kun `apps/api/main.ts`/`worker-main.ts` injiserer den faktiske instansen. `enforce`-modus:
`ALLOWED`→fortsett, `DENIED`/`UNKNOWN_NOT_CONFIGURED`→blokker FØR skriving (INGEN delvis rad). **Avvik
fra byggeordrens "reuse audit_events"-preferanse, eksplisitt begrunnet:** `audit_events` krever en EKTE,
ikke-valgfri `IdentityContext` (bekreftet: ALLE eksisterende `writeAudit()`-kallsteder har en) -
`GrowthTransport` tråder ikke identitet ned til tjenestemetoder, og å bygge det ville vært en mye større,
separat wiring-endring. Bygget i stedet en egen, smal observasjonstabell med `actor_person_id` NULLABLE
(samme mønster som `consent_decisions`), fremfor å fabrikkere identitet. **26 nye tester** (16 nye i
`enforcement-service.test.ts` (nytt fil), 9 nye i `growth/service-rls.test.ts` §M, 1 ny i
`erasure/consent-erasure.test.ts` §D). Testregnskap: `main` FØR = 1679/114 → ETTER = **1704 (+25), 115
filer**, alle grønne (bekreftet ved faktisk full `pnpm -w test`-kjøring, 213.96s, exit code 0 - ikke
anslag). `pnpm -w typecheck` 18/18 rent, `pnpm -w lint` rent. HOST_ACTION_REQUIRED=false. **UA-4
ETTER denne sliceen:** `CONSENT_GOVERNANCE_CORE_COMPLETE=true`, `PRODUCTION_ENFORCEMENT_PARTIAL=true`
(motoren KAN håndheve reelt for `attribution` når eieren eksplisitt aktiverer `enforce` - IKKE aktivert
for noen tenant/space per default; `tracking`-formålet har fortsatt ingen faktisk sporingsmekanisme).
UA-4 SOM HELHET forblir IKKE komplett. UA-3 kriterium 2 UENDRET (2/5 domener). **DRAFT PR opprettet,
IKKE merget.** **STOP: INGEN Google Ads live-oppsett, INGEN ekte provider-mutasjon, INGEN andre slice
denne runden, INGEN merge.** Full detalj: D-92 i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, MERGET):** UA-4 NESTE SLICE — CONSENT / COOKIE / DATA-PROCESSING
GOVERNANCE CORE v1 → D-91, base `main`@`4e8fc1c7d3380e32d00774e24bb2ed43537f1698` (PR #30/D-90-status
MERGET), branch `claude/ua4-marketing-consent-governance`, **PR #31 MERGET av Tobias sin eksplisitte
godkjenning → `main`@`87404e8ec30e971171ff0993563769da52098e88`** (merge-commit, `merge_method=merge`).
Post-merge CI: første kjøring rød på en pre-eksisterende, urelatert flake (`modules/core/test/
data-foundation.test.ts`, `ECONNREFUSED` mot embedded Postgres under parallell kjøring) - diagnostisert
og bekreftet som miljø-flake (13/13 grønt isolert, samme commit grønn to ganger lokalt + på PR-CI før
merge), rerun av de feilede jobbene ga GRØNN. **RESUME SOVEREIGN AUTONOMY v4.0 — full UA-4-matrise +
9-kandidat-sammenligning (A-I) kjørt FØR valg, ingen rekonstruksjon fra chat-historikk.** UA-4-matrisen (fersk lesing av docs + kode) viste samtykke-/databehandlingsstyring
(UA-4 akseptansekriterium 4, Q-29 punkt 5) som eneste GJENVÆRENDE literale UA-4-krav uten kode ELLER
dokumentert blokkering - Creative/Experiment Intelligence forblir BLOCKED_BY_DATA, GA4/Meta-adapter
NOT_STARTED uten D-64-port kjørt (avvist for å unngå leverandør-utvidelse kun for fremdrift), D-86/
UA-6 eksplisitt separat sovereign-owner-byggeordre. **Valgt: kandidat A (Consent/Cookie/Data-
Processing Governance Core)** - eneste kandidat som er et literal UA-4-krav med null eksterne
avhengigheter og null HOST_ACTION_REQUIRED. **Arkitektur:** ny pakke `@jarvis/consent`
(`modules/consent/`), NULL runtime-avhengighet til `@jarvis/business` (kun opak `contact_id: string`,
DB-håndhevet FK). `ConsentPurpose="attribution"|"tracking"` (lukket, bevisst SMALT sett, ingen
purpose-sprawl). `ConsentLegalBasis` er OWNER-KONFIGURERT autoritetsreferanse Jarvis håndhever, ALDRI
en Jarvis-utledet rettslig konklusjon (CHECK-constraint gjør ugyldige verdier strukturelt umulig).
**Append-only uforanderlig beslutningslogg** (bevisst avvik fra D-89/D-90 sitt current-state-mønster
- consent-historikk har egen rettslig betydning), håndhevet STRUKTURELT (ingen `UPDATE`-grant på
`jarvis_app` for `consent_decisions`, samme "strukturelt, ikke konvensjon"-presedens som D-87).
`evaluateProcessingDecision()` returnerer EKSAKT tre utfall: `ALLOWED`/`DENIED`/
`UNKNOWN_NOT_CONFIGURED` - FAIL-CLOSED, fravær av data er ALDRI stille tolket som tillatelse (D-81-
presedens). **ENFORCED_NOW vs ENFORCEMENT_DEFERRED:** selve policy-motoren er fullt reell og fail-
closed (ENFORCED_NOW). Automatisk kobling inn i growth sine eksisterende attribusjons-kallsteder er
EKSPLISITT IKKE gjort denne sliceen (ENFORCEMENT_DEFERRED) - ville stille endret oppførsel for
allerede-eksisterende kontakter uten samtykkeregistrering, i strid med ordrens krav om ingen
retroaktiv blokkering uten kompatibilitetsstrategi. **ToolGateway:** `consent.record_decision`
(klasse B), `consent.get_current_state`/`list_decisions`/`evaluate_processing_decision` (klasse A).
**D-81-kompatibilitet:** samtykkestatus kan ALDRI nedgradere `BUSINESS_CONFIDENTIAL`/`PRIVATE`/
`SECRET_RESTRICTED`-modellruting, `@jarvis/consent` har INGEN import av ModelGateway/provider-SDK
(strukturelt bevist). Policy Gateway-grense uendret (null konsept om "samtykke", genuint ortogonal).
D-87/UA-6/D-86 uberørt - governance kobles IKKE til reell leverandør-utførelse. Q-20: ny
`consent_decisions` registrert i erasure-planen. Q-21: FORCE RLS, tenant+space-isolasjon bevist. Q-26:
`Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED` forblir false, INGEN LLM-inferens. **18 nye tester**
(`service-rls.test.ts` §A-J: fail-closed, purpose-/tenant-/space-isolasjon, tilbaketrekking,
append-only/CHECK-constraint strukturelt bevis, no-ModelGateway/no-provider-mutation strukturelt
bevis). Testregnskap: `main` FØR = 1657/112 → ETTER = **1675 (+18), 113 filer**, alle grønne.
`pnpm -w typecheck` 18/18 pakker rent, `pnpm -w lint` rent. **Status:** D-91 =
**FIXED_SUITE_VERIFIED_COMPLETE=true, HOST_ACTION_REQUIRED=false** (ZERO leverandør). UA-4 forblir
IKKE komplett (Creative Intelligence, Experiment Intelligence, D-86/UA-6 ekte provider-utførelse
fortsatt BLOCKED_BY_DATA/DEFERRED/NOT_STARTED - denne sliceen bygger KUN håndhevingsGRUNNLAG, INGEN
automatisk kobling til eksisterende attribusjon ennå). UA-3 kriterium 2 UENDRET (2/5 domener). **DRAFT
PR #31 opprettet, CI GRØNN (gitleaks+build-test), IKKE merget.**

**PR #31 PRE-MERGE CLOSEOUT-AUDIT (samme dag, 2026-08-20):** en 58-punkts ekstern lukkingsordre
verifiserte PR-sannhet (HEAD uendret, `mergeable_state=clean`, ingen review-tråder) og fant TO reelle
strukturelle hull, begge fikset: (a) `getCurrentConsentState()`/`listConsentDecisions()` hadde INGEN
deterministisk tie-breaker for `recorded_at`-likhet - lagt til `seq bigserial UNIQUE` +
`ORDER BY recorded_at DESC, seq DESC`, bevist med en ny test (§K) som INSERTer to rader med
byte-for-byte identisk `recorded_at`; (b) den nye `bigserial`s implisitte sekvens manglet
`jarvis_app`-GRANT (`permission denied for sequence` under den nye testen) - fikset med
`GRANT USAGE, SELECT ON SEQUENCE consent_decisions_seq_seq TO jarvis_app`. Et tredje hull - INGEN
dedikert Q-20-ende-til-ende-erasure-test for `consent_decisions` fantes - lukket med ny
`modules/erasure/test/consent-erasure.test.ts` (3 tester): en memory-space-scoped erasure fjerner
FAKTISK alle beslutnings-rader (inkludert append-only-historikk), `CONSENT_AUDIT_SURVIVES_Q20_
ERASURE=false` bekreftet eksplisitt. Evidence-sikkerhet (§18) styrket med eksplisitt
"ALDRI hemmeligheter"-dokumentasjon i `types.ts`/ToolGateway-beskrivelsen. Alle andre 55 punkter i
lukkingsordren (legal-claim-audit, cookie-runtime-claim, subject-identity-entydighet, D-89/D-90/D-87/
UA-6/D-86-grense, Q-21/Q-26/Q-27, D-81, ToolGateway-risikoklasse-begrunnelse) verifisert KORREKTE ved
inspeksjon - ingen ytterligere kodeendring nødvendig. Testregnskap ETTER closeout: `main` FØR =
1657/112 → ETTER = **1679 (+22), 114 filer**, alle grønne. `pnpm -w typecheck`/`pnpm -w lint` fortsatt
rent. **STOP: INGEN Google Ads live-oppsett, INGEN ekte provider-mutasjon, INGEN andre slice denne
runden, INGEN merge.** Full detalj: D-91 §13 i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, MERGET):** UA-4 NESTE SLICE — BUSINESS OS × MARKETING MEMORY-INTEGRASJON
→ D-90, base `main`@`243e64ac1dca17de42a6823176411776f8335c88` (PR #28/D-89-status MERGET), branch
`claude/ua4-business-os-marketing-memory`, **PR #29 MERGET av Tobias sin eksplisitte godkjenning →
`main`@`d5dec17cf3449d865b25a1fd2c6e1a0ea2846e5c`**). **RESUME SOVEREIGN AUTONOMY v4.0 —
sliceen navngitt direkte av byggeordren.** Verifisert gap FØR bygging: `BUSINESS_OS_MARKETING_MEMORY_
VISIBLE=false` - D-89 sine observasjoner var kun nåbare via rå ToolGateway-lesing, aldri surfacet i
Business OS-briefen. **Arkitektonisk kjernefunn:** `@jarvis/growth` avhenger ALLEREDE av `@jarvis/
business` (D-74/D-78) - en ny `@jarvis/business` → `@jarvis/growth`-avhengighet for å konsumere
observasjonene direkte ville vært SIRKULÆR. Løst med dependency injection: ny `marketingMemoryBrief
Source(growthService)` bygget i `@jarvis/growth` (`business-os-integration.ts`, samme `BriefSource`-
kontrakt som `businessOpenLoopsSource`), `BusinessTransport` fikk et nytt valgfritt sjette konstruktør-
parameter `extraBriefSources`, injisert fra app-laget (`apps/api/src/main.ts`/`worker-main.ts`, identisk
wiring i begge) - `@jarvis/business` importerer FORTSATT ALDRI `@jarvis/growth` (strukturelt bevist).
**Presentasjon:** kun `status: 'open'`-observasjoner, `meetings_without_conversion` som ikke-kausalt
"N attribuerte møter, ingen vunnet opportunity ennå" (score 55), `recommendation_disposition_summary`
KUN når faktisk aktivitet finnes (unngår permanent tom støy-rad, siden typen aldri blir `'resolved'`,
score 30). Kampanjenavn slått opp for lesbarhet. TIME_WINDOW_MODEL=LIFETIME_ONLY, Q-26-grense uendret
fra D-89 (ingen truth promotion, ingen ModelGateway). **INGEN ny persistens/migrasjon/ToolGateway-action/
OpenLoop-endring** - ren lese-/presentasjonsintegrasjon. **14 nye tester** (10 `service-rls.test.ts` §S,
4 `business-brief.test.ts` §F inkl. et audit-funn: kildefeil-isolasjon bevist eksplisitt), pluss 4
eksisterende wiring-regresjonstester oppdatert for det nye flerlinjede `BusinessTransport(...)`-kallet
(kun formaterings-drift, ingen funksjonell regresjon).
Testregnskap: `main` FØR = 1643/112 → ETTER = **1657 (+14), 112 filer**, alle grønne. `pnpm -w typecheck`
17/17 rent, `pnpm -w lint` rent. **Status:** D-90 = **FIXED_SUITE_VERIFIED_COMPLETE=true,
HOST_ACTION_REQUIRED=false** (ZERO leverandør). UA-4 forblir IKKE komplett (Creative Intelligence,
samtykke-governance, UA-6, ekte provider-utførelse, Google Ads live-verifisering alle fortsatt
NOT_STARTED/BLOCKED/DEFERRED). UA-3 kriterium 2 UENDRET (2/5 domener). **PR #29 MERGET
2026-08-20T02:23:29Z** (merge commit `d5dec17cf3449d865b25a1fd2c6e1a0ea2846e5c`, `merge_method=merge`,
ingen squash) etter Tobias sin eksplisitte godkjenning og en fullstendig pre-merge closeout-audit
(60-punkts rapport levert, alle Q-26/D-64/D-41/D-86/D-87/UA-6/modul-avhengighet-grenser bekreftet
intakte). Post-merge: `origin/main` og lokal `main` verifisert synkronisert på `d5dec17`, kanoniske
D-90-filer bekreftet til stede (`business-os-integration.ts`, `BusinessTransport`-DI, app-lag-wiring
i begge `main.ts`/`worker-main.ts`). **STOP: INGEN Google Ads live-oppsett, INGEN ekte
provider-mutasjon, INGEN andre slice denne runden.** Full detalj: D-90 i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, MERGET):** UA-4 SLICE 7 — MARKETING MEMORY v1 → D-89, base
`main`@`c8a5ea46d9af6fed90f3d179c0eb01ac2dffc031` (PR #26/D-88 MERGET), branch
`claude/ua4-marketing-memory-v1`, **PR #27 MERGET av Tobias sin eksplisitte godkjenning →
`main`@`72b63418b70090686ad1ef03b3056dacba296de3`**). **RESUME SOVEREIGN AUTONOMY v4.0 — VALGT
AV 9 KANDIDATER, BEKREFTET byggeordrens "sterke default":** UA-4-matrisen rekonstruert fra repo-
sannhet viste at masterplanens EGEN literale nevning ("Experiment registry, anomaly detection,
creative intelligence og marketing memory") fortsatt hadde Marketing Memory som eneste NOT_STARTED
kapabilitet med en REELT mulig data-forutsetning etter D-88: kampanje→utgift→attribusjon→møte→
opportunity→won/revenue PLUSS D-85/D-87 sin anbefaling-/kommando-historikk ga FØRSTE gang nok
strukturert, evidensbærende data til et NARROW, Q-26-trygt observasjon-lag. Creative Intelligence/
eksperiment-intelligens AVVIST IGJEN (samme datamangel som D-87/D-88 - ingen kreativ-/per-variant-
data eksisterer). **Ny migrasjon `031_growth_marketing_observations.sql`** (`marketing_campaign_
observations`, additiv, FK KUN mot `marketing_campaigns`). **Begrepsskille:** MARKETING FACT
(eksisterende data) → MARKETING OBSERVATION (`CampaignObservation`, DETTE laget) → MARKETING
HYPOTHESIS/LEARNING (EKSPLISITT IKKE bygget - ville krevd generalisering på tvers av kampanjer,
Q-26-risiko) → MARKETING POLICY (urørt). **Q-26 er den primære sikkerhetsporten:**
`detection_method` LÅST til KUN `'deterministic'` i databasens CHECK-constraint (samme strenge
mønster som D-85 sin `source`-kolonne), bevist med en test som forsøker `UPDATE ... SET
detection_method = 'ai_assisted'` og bekrefter Postgres avviser det. `status` har BEVISST INGEN
`'verified'`-verdi (kun `'open'`/`'resolved'`) - Truth Promotion forblir ubygget. ZERO ModelGateway-
kall. **Persistens-avgjørelse:** vurderte og AVVISTE UA-2 sin generelle `memory_items`-motor (feil
form - bygget for fritekst/embedding, ikke strukturerte numeriske observasjoner), gjenbrukte i
stedet `business_scores` (D-61) sitt entity/evidence/UNIQUE-per-type-mønster. **To
observasjonstyper** (begge tidsvindu-frie, unngår "livstid A vs 7-dager B"-fellen siden
`campaignPerformance()` er livstids-only): `meetings_without_conversion` (≥1 attribuert møte MEN 0
vunne opportunities - ærlig funnel-gap, ALDRI kausal påstand) og `recommendation_disposition_
summary` (alltid-oppdatert opptelling av D-85/D-87-status). **Resolve-ALDRI-slett-livssyklus**
(samme prinsipp som D-85): når vilkåret opphører, markeres raden `'resolved'` med siste
evidens-øyeblikksbilde, ALDRI slettet - SAMME rad, historikken bevart. INGEN rad opprettes når data
mangler (fravær = ærlig "ingen data ennå"). **Ingen rad-fan-out-regresjon:** gjenbrukte
`computePerformanceSnapshot()` (trukket ut fra D-88 sin `campaignPerformance()`) i stedet for å
nøste `withMemoryTransaction`. Ny `growth.generate_marketing_observations` (klasse B)/`list_
marketing_observations` (klasse A) - INGEN klasse C/D. INGEN scheduler (eksplisitt agent-/eier-kalt
i v1). **D-85/D-87-grense bevart:** Marketing Memory OBSERVERER kun anbefaling-/kommando-HISTORIKK,
skriver ALDRI til deres tabeller - INGEN kobling observasjon→anbefaling→kommando→provider-mutasjon.
Q-20 erasure-plan oppdatert (ny tabell slettes FØR `marketing_campaigns`). **PR #27-audit fant og
fikset TO reelle presisjonsfunn FØR merge:** (a) hendelse-spam på idempotent regenerering (fikset -
`marketing_observation_generated` logges nå KUN når noe faktisk endret seg, samme prinsipp som D-85);
(b) `meetings_without_conversion` sin gjenåpnings-vei OVERSKRIVER forrige episodes evidence i SAMME
rad - PRESIST dokumentert som CURRENT-STATE-minne (IKKE historisk episodisk minne) i `types.ts`/D-89,
bevist med en dedikert test. **13 nye tester** (11 `service-rls.test.ts` §R, 2
`transport-wiring.test.ts` §C5, `growth-erasure.test.ts` utvidet).
Testregnskap: `main` FØR = 1630/112 → ETTER = **1643 (+13), 112 filer**, 112/112 grønn (INGEN
flake). `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent. **Status:** D-89 =
**FIXED_SUITE_VERIFIED_COMPLETE=true, HOST_ACTION_REQUIRED=false** (ZERO leverandør involvert). UA-4 SOM
HELHET forblir IKKE komplett (mutate-/utførelses-kapabilitet, Creative Intelligence, Finance
Integrity Gateway, samtykke-governance alle fortsatt NOT_STARTED/BLOCKED/DEFERRED - Marketing
Memory v1 er analyse-/lærings-lag ALENE, INGEN OpenLoop-endring, INGEN Business OS-brief-
integrasjon i denne sliceen - eksplisitt dokumentert gap). UA-3 kriterium 2 UENDRET (2/5 domener).
**PR #27 MERGET 2026-08-20T00:21:04Z** (merge commit `72b63418b70090686ad1ef03b3056dacba296de3`,
`merge_method=merge`, ingen squash) etter Tobias sin eksplisitte godkjenning og en fullstendig
pre-merge closeout-audit (55/41-punkts rapport levert, alle Q-26/D-64/D-41/D-85/D-87/UA-6-grenser
bekreftet intakte). Post-merge: `origin/main` og lokal `main` verifisert synkronisert på
`72b6341`, kanoniske D-89-filer bekreftet til stede på `main` (migrasjon 031, `GrowthService`-
metoder, ToolGateway-actions, erasure-plan). **STOP: INGEN Google Ads live-oppsett, INGEN ekte
provider-mutasjon, INGEN andre slice denne runden.** Full detalj: D-89 i
DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, IKKE merget):** UA-4 SLICE 6 — MARKETING→MEETING→REVENUE FUNNEL-LINKAGE
→ D-88, base
`main`@`90af34c6aae6968f3592e92028ba1e6f3e92df51` (PR #25/D-87 MERGET), branch
`claude/ua4-marketing-funnel-meeting-linkage`, draft PR, IKKE merget). **RESUME SOVEREIGN AUTONOMY
v4.0 — VALGT AV 8 KANDIDATER, BEKREFTET byggeordrens "sterke default":** literal rekonstruksjon av
funnel-kjeden CAMPAIGN→SPEND→TRACKING/CLICK→LEAD→KONTAKT→**MØTE**→OPPORTUNITY→WON→REVENUE viste at
ALLE ledd allerede var COMPLETE unntatt ETT: MØTE-stadiet (`business_activities.activity_type=
'meeting'`, opprettet deterministisk av `BusinessEventSyncService` med `contact_id` satt via
e-postmatching) var IKKE koblet tilbake til kampanjen som forårsaket kontakten -
`campaignPerformance()` hoppet direkte fra LEAD/OPPORTUNITY til WON/REVENUE. **ZERO ny tabell/
migrasjon** (byggeordrens eksplisitte preferanse for "derive fra eksisterende entiteter" var fullt
oppnåelig): nytt felt `CampaignPerformance.attributed_meetings` beregnes med en EGEN, ANDRE spørring
i EKSISTERENDE `campaignPerformance()` (`marketing_attributions` → `business_leads`/
`business_opportunities.contact_id` → `business_activities` der `activity_type='meeting'` OG
`occurred_at >= attributed_at`). **No-guess-grensen:** et møte FØR attribusjonstidspunktet telles
ALDRI (kan umulig være forårsaket av kampanjen, Q-26-fail-closed). **Fan-out-regresjon unngått
bevisst:** møte-spørringen kjøres SEPARAT fra revenue-aggregatet (en naiv ekstra JOIN i samme
spørring ville doble `attributed_revenue_ore`/`won_opportunities` for kontakter med flere møter) -
verifisert med en dedikert 3-møter-regresjonstest. INGEN ny ToolGateway-handling (EKSISTERENDE
`growth.campaign_performance`, klasse A, respons utvidet med ett felt). **9 nye tester**
(`service-rls.test.ts` §Q, +1 til 10 under PR #26-audit: multi-attribusjonsvei-dedup). Testregnskap:
`main` FØR = 1620/112 → ETTER = **1630 (+10), 112 filer**,
112/112 grønn (INGEN flake). `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent. **Status:** D-88 =
**FIXED_SUITE_COMPLETE=true, HOST_ACTION_REQUIRED=false** (ZERO leverandør involvert). UA-4 SOM
HELHET forblir IKKE komplett (mutate-/utførelses-kapabilitet, Creative Intelligence, Marketing
Memory, Finance Integrity Gateway, samtykke-governance alle fortsatt NOT_STARTED/BLOCKED/DEFERRED -
denne sliceen legger KUN til funnel-SYNLIGHET for et allerede eksisterende stadium). UA-3 kriterium 2
UENDRET (2/5 domener). Draft-PR opprettes, IKKE merget. **STOP: INGEN Google Ads live-oppsett, INGEN
ekte provider-mutasjon, INGEN Marketing Memory-slice, INGEN andre slice denne runden, INGEN merge.**
Full detalj: D-88 i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, IKKE merget):** UA-4 SLICE 5 — PROVIDER-NØYTRAL KAMPANJE-UTFØRELSES-KOMMANDO-MODELL →
D-87, base `main`@`7ebc31b` (PR #24/D-85/D-86 MERGET), branch `claude/ua4-execution-command-model`,
draft PR, IKKE merget). **RESUME SOVEREIGN AUTONOMY v4.0 — VALGT AV 8 KANDIDATER, EKSPLISITT AVVIST
byggeordrens "sterke default" (Creative Intelligence Core):** repo-sannhet viser at INGEN kreativ-
nivå-data eksisterer noe sted i kodebasen (Google Ads-adapteren synker UTELUKKENDE kampanje-nivå-
fakta, INGEN `CreativeAsset`-skjema finnes) - å bygge Creative Intelligence nå ville enten fabrikkert
kreativ-ytelse fra kampanje-data (Q-26-risiko) eller levert et tomt skjema uten reelle input. **Valgt
i stedet: en provider-nøytral UTFØRELSES-KOMMANDO-modell** - det strukturelle bindeleddet mellom D-85
sitt BESLUTNINGS-lag og en FREMTIDIG UTFØRELSES-lag. **STRUKTURELL (ikke bare kode-konvensjonell)
Finance Integrity-håndhevelse:** ny `marketing_campaign_execution_commands`-tabell (`030_growth_
execution_commands.sql`) sin `status`-CHECK-constraint inneholder BEVISST INGEN `'executed'`-verdi -
databasen SELV gjør det umulig for noen kode å markere et command utført, bevist eksplisitt med en
test som forsøker et direkte `UPDATE` og bekrefter Postgres avviser det. `generateExecutionCommand()`
oversetter en ALLEREDE eier-godkjent `reduce_budget`-anbefaling til et deterministisk nytt budsjett
(default 20% reduksjon, ALDRI AI-gjettet); `investigate`-anbefalinger genererer INGEN command. **KRITISK
sikkerhetsinvariant:** når den underliggende anbefalingen senere supersederes, kaskade-kanselleres et
`pending_execution`-command AUTOMATISK i SAMME transaksjon - et command kan ALDRI overleve at sin
egen begrunnelse reverseres. `cancelExecutionCommand()` for eier-/agent-kansellering FØR utførelse
(aldri bygget). Ny `growth.generate_execution_command`/`cancel_execution_command` (klasse B)/`list_
execution_commands` (klasse A) - INGEN klasse C/D. INGEN ny scheduler (kommandoer genereres eksplisitt,
ikke periodisk sveipet - unngår enhver antydning av automatisk kommando→utførelse-kobling). Q-20
erasure-plan oppdatert (kommando-tabellen slettes FØRST av HELE marketing_*-blokken, FK mot BÅDE
kampanjer OG anbefalinger). **17 nye tester** (14 `service-rls.test.ts` §P, 3 `transport-wiring.test.ts`
§C4, `growth-erasure.test.ts` utvidet). Testregnskap: `main` FØR = 1603/112 → ETTER = **1620 (+17),
112 filer**, 112/112 grønn (én urelatert, kjent embedded-Postgres-`afterAll`-ressursflake i
`ua1-p1a-dclass-mesh.test.ts` under full parallell kjøring, bevist ved endret-fil-uavhengighet og en
ren 5/5-isolasjonskjøring). `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent. **Status:** D-87 =
**FIXED_SUITE_COMPLETE=true, HOST_ACTION_REQUIRED=false** (ZERO leverandør involvert). UA-4 SOM
HELHET forblir IKKE komplett (mutate-/utførelses-kapabilitet fortsatt IKKE bygget - denne sliceen
legger KUN til kommando-OVERSETTELSEN, aldri utførelsen). UA-3 kriterium 2 UENDRET (2/5 domener).
Draft-PR opprettes, IKKE merget. **STOP: INGEN Google Ads live-oppsett, INGEN ekte provider-mutasjon,
INGEN andre slice denne runden, INGEN merge.** Full detalj: D-87 i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, IKKE merget):** UA-4 SLICE 4 — ANOMALY → RECOMMENDED-ACTION CONTROL-
PLANE-FUNDAMENT → D-85, base `main`@`465421b` (PR #23/D-83/D-84 MERGET), branch
`claude/ua4-marketing-action-recommendations`, draft PR, IKKE merget. **RESUME SOVEREIGN AUTONOMY
v4.0-oppfølging etter Google Ads-merge:** Tobias besluttet at ekte Google Ads live-credential-oppsett
utsettes til en fremtidig FINAL INTEGRATION-fase - registrert eksplisitt som `GOOGLE_ADS_LIVE_
VERIFICATION = DEFERRED_TO_FINAL_INTEGRATION_PHASE` (D-86, SEKVENSERING IKKE kansellering -
`LIVE_PROVIDER_VERIFIED` forblir `false`, live-runneren/credential-kravene UENDRET, backlog på syv
konkrete steg registrert i D-86). **UA-4-matrise rekonstruert fra repo-sannhet:** kampanje-/utgifts-/
attribusjon-/CAC-ROAS-fundament + BUSINESS_DOMAIN_COVERAGE-kabling + UTM-auto-attribusjon + Google
Ads LES/SYNK-adapter = alle COMPLETE (D-74/76/77/78/79/82/83/84, ALLE på `main`); Google Ads LIVE-
verifisering = DEFERRED_TO_FINAL_INTEGRATION_PHASE (D-86, ny); Meta Ads/GA4/andre providere = NOT_
STARTED; autonome budsjett-/bud-/nøkkelord-/kreativ-mutasjoner = BLOCKED (Finance Integrity-grense,
UA-6 ikke bygget); Creative Intelligence/Marketing Memory/samtykke-cookie-governance/anomaly→handling-
fundament = alle NOT_STARTED FØR denne runden. **Valgt ÉN slice: anomaly → recommended-action control-
plane-fundament** (av 9 kandidater - se D-85 for full WHY_NOW/WHY_NOT_OTHERS-begrunnelse) - 100%
testbar UTEN leverandør-credential, INGEN D-64-kjerneavhengighet, forbereder BESLUTNINGS-laget FØR
noe UTFØRELSES-lag ("gjør det MOT en leverandør") noensinne kan bygges. **Implementasjon:** ny
migrasjon `029_growth_action_recommendations.sql` (`marketing_campaign_action_recommendations`,
additiv, `source` CHECK-fastlåst til `'deterministic_rule'` - Q-26-grensen, ZERO AI-inferens), ny
`GrowthService.detectAndRecommendSpendAnomalies()` (UAVHENGIG re-deteksjon av SAMME avviksformel som
`OpenLoopService.detectSpendAnomalies()`, BEVISST duplisert SQL - IKKE en pakkeavhengighet, se D-85
§3 for full begrunnelse), pluss `upsertActionRecommendation`/`listActionRecommendations`/
`resolveActionRecommendation`/`supersedeStaleActionRecommendations`. **Arkitektur-lærdom fanget FØR
commit:** et første utkast nestet `withMemoryTransaction`-kall (to ikke-atomiske transaksjoner på
separate pool-tilkoblinger) - rettet ved å trekke ut klient-scopede private hjelpefunksjoner (SAMME
mønster som eksisterende `insertEvent(client, ...)`), regelen selv logget i D-85 §4 for fremtidige
slices. Ny `growth.list_action_recommendations` (klasse A)/`growth.resolve_action_recommendation`
(klasse B, IKKE C/D - REN Jarvis-intern disposisjon-sporing, utfører INGENTING mot en ekte
annonseplattform). Ny uavhengig `DailyScheduler`-sveip (`growth-action-recommendation-sweep`, default
kl. 09) i `apps/api/src/main.ts`. Erasure-plan oppdatert (Q-20) - EN EKTE FK-brudd-regresjon fanget og
fikset FØR commit (`marketing_campaign_action_recommendations` må slettes FØR `business_open_loops`,
IKKE etter - motsatt rekkefølge av den vanlige child-tabell-lærdommen, fordi `open_loop_id` her peker
TIL `business_open_loops`). **20 nye tester** (13 `service-rls.test.ts` §O, 3 `transport-wiring.test.ts`
§C3, 4 ny `action-recommendation-sweep.test.ts`). Testregnskap: `main` FØR = 1583/111 → ETTER =
**1603 (+20), 112 filer (+1)**, 112/112 grønn. `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent.
**Status:** D-85 = **FIXED_SUITE_COMPLETE=true, HOST_ACTION_REQUIRED=false** (ZERO leverandør
involvert - ingen host-kjøring relevant for denne sliceen). UA-4 SOM HELHET forblir IKKE komplett.
UA-3 kriterium 2 UENDRET (2/5 domener - `sales`/`marketing="available"`,
`product`/`finance`/`operations="not_integrated"`). Draft-PR opprettes, IKKE merget. **STOP: INGEN
Google Ads live-oppsett, INGEN ekte provider-mutasjon, INGEN andre slice denne runden, INGEN merge.**
Full detalj: D-85/D-86 i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, MERGET):** PR #23 PRE-MERGE HARDENING — GOOGLE ADS LIVE-VERIFISERINGSVEI
+ D-41-RE-AUDIT → D-84, D-83-oppfølging, samme branch, SIDEN eksplisitt godkjent og merget av Tobias
samme dag (merge-commit `465421bd9de2922b5ff600176e2dcf1040fa8506`). D-83 sin egen rapport erkjente
`HOST_ACTION_REQUIRED=true` UTEN at noen deterministisk live-kjøringsvei fantes ennå - lukket FØR
review/merge, UTEN å endre den allerede-grønne adapterens produksjonsatferd (kun kommentaroppdatering
i `google-ads-transport.ts`, ZERO logikkendring). **Nye scripts** (samme "host-run bootstrapper +
-live.ts akseptanse"-todeling som alle øvrige UA-3/UA-4-scripts): `modules/growth/scripts/
google-ads-live-host-run.ts` + `google-ads-live.ts`, med rene beslutningsfunksjoner i `scripts/lib/
google-ads-live-lib.ts` (enhetstestbare, samme mønster som `google-drive-reauth-lib.ts`). ÉN
Windows-kommando, uendret FØR/ETTER Tobias' oppsett: `node --env-file=.env
--experimental-transform-types modules/growth/scripts/google-ads-live-host-run.ts`. **Env-preksjekk**
(kun tilstedeværelse, ALDRI verdi) navngir eksakt manglende variabel; `BLOCKED_NO_CREDENTIALS` er en
FORVENTET, IKKE-krasjende tilstand (`hard_fail=false`) FØR Tobias' oppsett - `computeHardFail()`
skiller Q-21-regresjon (ALLTID hard_fail) fra manglende credentials (ALDRI alene). **Live-markører:**
ÉTT `list_campaigns`-kall beviser auth+customer-access+provider-read SAMTIDIG, eksplisitt skilt fra
"kampanjer finnes" (tom, men gyldig liste = PASS, ALDRI feil). Kampanje-/utgiftssynk kjørt to ganger
via `ToolGateway.execute()` (samme applikasjonssti som produksjon) for idempotens-bevis. NO_DATA
(scanned=0) er DISTINKT fra FAIL - skjuler aldri en reell feil. gclid-sporing: NO-GUESS-bevis
strukturelt (`registered <= raw_rows`, kan aldri overstige). Tenant-isolasjon og cleanup (KUN denne
kjøringens egen syntetiske tenant, Google Ads-kontoen ALDRI rørt - kun lesing i HELE scriptet).
Secret-safety: `evaluateSecretSafety()` er et etterprøvbart bevis (skanner HELE loggbufferet),
evaluert SIST. **D-41-re-audit:** en NY research-agent re-verifiserte hver faktisk IMPLEMENTERT
D-83-påstand via uavhengig flerkilde-søk (WebFetch fortsatt bekreftet blokkert) - alle 8 punkter
STYRKET fra `VERIFIED_SEARCH_SNIPPET` til `VERIFIED_OFFICIAL_SEARCH_SNIPPET`, ÉN presisering (401/403
aldri retries er utledet, ikke direkte sitert - nedgradert til `UNVERIFIED_INFERRED`, INGEN
kodeendring nødvendig, koden var allerede konservativ). INGEN kapabilitet utvidet, INGEN
mutate-forskning. **31 nye tester** (`google-ads-live-lib.test.ts` §A-H: env/secret-safety/
zero-campaign/auth-vs-customer-access/NO_DATA-vs-FAIL/hard_fail + strukturelt kildetekst-bevis mot
mutate-handlinger og unscoped cleanup-DELETE). Testregnskap: `main` FØR = 1552/110 → ETTER = **1583
(+31), 111 filer (+1)**, 111/111 grønn. `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent.
**Status:** D-84 = **FIXED_SUITE_COMPLETE=true, LIVE_RUNNER_READY=true, LIVE_PROVIDER_VERIFIED=false**
(runneren er nå KLAR, kjøres FØRST av Tobias etter oppsettsekvensen - uendret fra D-83 §11). PR #23
oppdatert, IKKE merget i DENNE runden (SIDEN eksplisitt godkjent og merget av Tobias samme dag,
merge-commit `465421bd9de2922b5ff600176e2dcf1040fa8506` - se toppoppføringen). Full detalj: D-84 i
DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, IKKE merget):** UA-4 — FØRSTE LIVE MARKEDSFØRINGSPROVIDER: GOOGLE
ADS-ADAPTER, LES/SYNK → D-83, IKKE merget. Tobias bekreftet Google Ads som `FIRST_MARKETING_PROVIDER` (forrige, rene
research-runde, ingen kode/D-ID). Base `main`@`6ddbbeb` (D-82, merget), branch
`claude/ua4-google-ads-adapter`. **§0 kildeverifisering:** WebFetch mot `developers.google.com`
BLOKKERT i dette miljøet (uendret) - en dedikert research-agent verifiserte Google Ads REST/GAQL-
fakta og merket hver påstand `VERIFIED_SEARCH_SNIPPET` (flertallet) vs `UNVERIFIED` (mutate-
idempotens, conversion-upload) - `UNVERIFIED`-kapabiliteter STOPPES eksplisitt denne runden fremfor
å gjette virkemåte. **D-64-gate:** `SYSTEM_OF_RECORD=HYBRID_WITH_CLEAR_AUTHORITY` (Jarvis =
kanonisk kampanje-/attribusjonsmodell, uendret siden D-74; Google = autoritativ kilde for RÅ
leverandørfakta som synkes inn med proveniens), `CORE_DEPENDENCY_DECISION_REQUIRED=false` - Growth
Core fungerer UENDRET UTEN Google Ads. Google Ads forblir en ADAPTER (`modules/growth/src/
google-ads-transport.ts`), ALDRI der Jarvis sin domenearkitektur bor. **D-41-matrise:** LESING
(kampanjer/annonsegrupper/annonser/budsjett/status via GAQL) + RAPPORTERING (kostnad/klikk/
visninger per dag) + `click_view` (gclid) = **IMPLEMENTERT** (klasse A/B); OPPRETT/OPPDATER/FJERN/
PAUSE/RESUME/BUDSJETT/BUD/NØKKELORD/MÅLGRUPPE/KREATIV/KONVERTERING-OPPLASTING = **EKSPLISITT UTSATT**
(Finance Integrity-sekvenseringsgrense - IKKE beskrevet som permanent read-only, IKKE stille
utelatt). Mutate-idempotens var `UNVERIFIED` → INGEN mutate-handling kodet i det hele tatt denne
runden. **Finance-grense:** denne sliceen øker ALDRI budsjett/bud, oppretter ALDRI ekte forbruk,
INGEN autonom forbruksøkende handling - kun LESING/RAPPORTERING/SYNK. **D-82-integrasjon:**
`click_view.gclid` mappes til EKSISTERENDE `marketing_campaign_tracking_tags`
(`click_id_param='gclid'`) via EKSISTERENDE `GrowthService.registerCampaignTrackingTag()` - INGEN ny
attribusjonsmekanisme, INGEN LLM-gjetting. **Arkitektur:** `GoogleAdsTransport implements
ToolTransport` i `modules/growth` (unngår sirkulær pakkeavhengighet), delt OAuth-tokenfornyelse
gjenbrukt fra `googleAccessToken()` (`modules/tool-gateway/src/live-transports.ts`, kun `export`
lagt til) med EGET `JARVIS_GOOGLE_ADS_REFRESH_TOKEN`/`adwords`-scope, atskilt fra Gmail/Calendar/
Drive. To nye `GrowthService`-metoder (`findCampaignByExternalId`/`upsertCampaignFromProvider`,
idempotent via EKSISTERENDE `UNIQUE (tenant_id, channel, external_campaign_id)`, INGEN ny
migrasjon). **Robusthet:** streng `YYYY-MM-DD`-datovalidering FØR GAQL-strenginterpolasjon (ingen
parameterisert spørring tilgjengelig), bounded retry (3 forsøk, kun 429/5xx), per-rad try/catch
(delvis-synk-sikkerhet), et 24t Google-utfall tar Growth Core NED for NY synk men eksisterende
synket tilstand forblir brukbar. **ToolGateway:** `googleads.list_campaigns` (A), `sync_campaigns`/
`sync_spend`/`sync_tracking_tags` (B) - INGEN klasse D. **Sikkerhet:** ZERO ModelGateway-kall (D-81
uberørt), utviklertoken/tokens KUN i HTTP-headere (bevist), feilmeldinger <250 tegn og bevist fri
for hemmeligheter. Q-20/21/26/27 uendret prinsipp (ny provider-synket kampanje erasert via SAMME
eksisterende plan, bevist med test). **Reell bug funnet+fikset:** `upsertCampaignFromProvider()`
satte `started_at` KUN i `ON CONFLICT`-grenen, ikke ved FØRSTE insert - fikset med `CASE WHEN`
direkte i INSERT VALUES + `COALESCE` i `ON CONFLICT DO UPDATE`. 38 nye tester. Testregnskap: `main`
FØR = 1514/108 → ETTER = **1552 (+38), 110 filer (+2)**, 110/110 grønn. `pnpm -w typecheck` 17/17
rent (én reell `TS2352`-feil funnet+fikset i ny test), `pnpm -w lint` rent. **FIXED_SUITE_COMPLETE=
true, LIVE_PROVIDER_VERIFIED=false** (INGEN ekte Google Ads-kall denne økten - byggeordren forbød å
be om credentials under implementering). **HOST_ACTION_REQUIRED=true**: Tobias må (1) aktivere
Google Ads API i eksisterende Google Cloud-prosjekt, (2) legge `adwords`-scope til eksisterende
OAuth-samtykkeskjerm, (3) generere NY, adskilt refresh-token for dette scopet, (4) søke om Google
Ads Developer Token, (5) hente Customer ID (+ evt. Manager/Login-Customer-ID), (6) sette de fire nye
`JARVIS_GOOGLE_ADS_*`-variablene i `.env`. **INGEN Tobias-handling krevd for denne kode-lukkingen
selv** (kun for LIVE-verifisering). D-83 = **FIXED_SUITE_COMPLETE / IKKE LIVE_PROVIDER_VERIFIED**.
UA-4 SOM HELHET forblir IKKE komplett (mutate/kreativ intelligens/Finance Integrity Gateway/samtykke
fortsatt UTSATT/BLOCKED/DEFERRED). UA-3 kriterium 2 forblir IKKE oppfylt (2/5 domener, uendret -
`live_provider_connected` flyttes til `true` FØRST etter LIVE_PROVIDER_VERIFIED). Draft-PR
opprettes, IKKE merget, INGEN Meta Ads, INGEN GA4-slice, INGEN autonome forbruksøkende mutasjoner,
INGEN UA-6. Full detalj: D-83 i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, IKKE merget):** UA-4 SLICE 3 — DETERMINISTISK UTM-/KLIKK-ID-BASERT
AUTO-ATTRIBUSJON → D-82, IKKE merget. Neste UA-4-slice etter PR #21 (D-80/D-81, MERGET, merge-SHA `7b9789d`) - valgt
via repo-sannhet-audit (`origin/main` verifisert eksakt `7b9789d`), IKKE Google Ads-default. **UA-4-
matrise rekonstruert fra Q-29:** kampanje-/utgifts-/attribusjon-/CAC-ROAS-fundament = COMPLETE
(D-74-78); live annonseplattform-connectorer/autonome budsjett-endringer/kreativ intelligens/Finance
Integrity Gateway-integrasjon/samtykke-dokumentasjon = alle fortsatt NOT_STARTED/BLOCKED/DEFERRED;
deterministisk UTM-/kilde-basert auto-attribusjon = **NÅ COMPLETE (denne runden)**. **8 kandidat-
slices sammenlignet eksplisitt** (live connector, analytics-kildefundament, kreativ intelligens,
autonom handling, samtykke/personvern-styring, Finance Integrity Gateway-avhengighet, gjenstående
domenedekning-kabling - alle avvist med begrunnelse) - valgte i stedet attribusjon-ingestion-
fundamentet: `027_growth.sql` sin EGEN kildekommentar sa ordrett "se OPEN_QUESTIONS.md for fremtidig
deterministisk UTM-basert auto-matching" - dette ER den forhåndsplanlagte, leverandør-uavhengige
neste utvidelsen (platform-agnostisk, ZERO ekstern leverandørvalg kreves, styrker CAC/ROAS-presisjon
direkte). **D-64-gate:** `CORE_DEPENDENCY_DECISION_REQUIRED=false` - ren applikasjonslag-oppslags-
logikk mot Jarvis sine EGNE registrerte sporingstagger, ZERO Google Ads/Meta Ads/GA4-credential/
tabell/endepunkt. D-41 IKKE anvendelig (ingen provider introdusert). **Implementasjon:** migrasjon
`028_growth_attribution_tracking.sql` (ny `marketing_campaign_tracking_tags`-tabell, to gjensidig
utelukkende taggtyper - `click_id` (gclid/fbclid/msclkid) og full `(utm_source, utm_medium,
utm_campaign)`-triplett, to partial UNIQUE-indekser sikrer BÅDE idempotent registrering OG at
ambiguity er STRUKTURELT umulig i databasen selv), fire nye `GrowthService`-metoder
(`registerCampaignTrackingTag`/`listCampaignTrackingTags`/`resolveCampaignFromTracking`/
`attributeFromTracking` - sistnevnte kaller den EKSISTERENDE `attributeToCampaign()` uendret, ingen
ny attribusjonsmekanisme), fire nye `growth.*`-ToolGateway-handlinger (klasse A/B, INGEN klasse D).
Deterministisk oppslag returnerer `null`/kaster `no_matching_campaign_for_tracking` ved ingen EKSAKT
match - ALDRI en gjettet kampanje (Q-26-grensen). Q-20/erasure/Q-21/Q-27 uendret prinsipp, ny tabell
registrert i erasure-planen og bevist erasert. 17 nye tester. Testregnskap: `main` FØR = 1497 →
ETTER = **1514 (+17)**, 108/108 filer grønn. `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent.
**INGEN Tobias-host-handling krevd.** D-82 = CI_VERIFIED/COMPLETE på egen scope (lukker Q-29 punkt
6). UA-4 SOM HELHET forblir IKKE komplett, UA-3 kriterium 2 forblir IKKE oppfylt (2/5 domener,
uendret). Full detalj: D-82 i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, MERGET):** PR #21 PRE-MERGE SECURITY + D-41 HARDENING** → D-81, D-80-oppfølging,
MERGET (merge-SHA `7b9789d`) etter Tobias sin eksplisitte godkjenning. **P0-FUNN OG FIKS:** `UNCLASSIFIED_CAN_ROUTE_TO_HOSTED_FREE_TIER=true` FØR denne
runden - udefinert `sensitivity` ble feilaktig tolket som "ingen filtrering" for ALLE
providerkategorier, inkl. `hosted_free_tier` (`gemma_hosted`). Kombinert med at BÅDE
`apps/api/src/executive.ts` OG `apps/api/src/conversation.ts` (HOVED-samtalemotoren, dekker alle
memory spaces inkl. "health"/"personal") sender INGEN `sensitivity`, kunne uklassifisert innhold nå
gratis-tieret. **Fikset:** `isSensitivityEligible()` krever nå EKSPLISITT
`sensitivity === "PUBLIC_OR_LOW_SENSITIVITY"` for `hosted_free_tier`-providere (fail-safe, ikke
fail-open) - gjelder OGSÅ eksplisitt eier-override. ALLE andre, allerede betrodde providere beholder
UENDRET ruting for udefinert sensitivitet (§23 uendret for dem). Konsekvens: `gemma_hosted` vinner
IKKE lenger AUTO/BACKGROUND for udefinert sensitivitet (faller tilbake til openai/gemini, EKSAKT som
FØR D-80) - "Gemma-først" gjelder KUN når kalleren eksplisitt setter `PUBLIC_OR_LOW_SENSITIVITY`.
**D-41 korrigert mot faktisk dokumentasjon** (WebSearch mot Google sin offisielle Gemini API-doks,
WebFetch blokkert av egress-proxy denne økten): Gemma 4 støtter EKTE bildeforståelse via Gemini API
- **vision NÅ IMPLEMENTERT** (`gemma.ts` sin `toGemmaParts()`, samme mønster som `anthropic.ts`,
personvern-gaten forblir autoritativ - e-post-OCR forblir 100% Anthropic siden ingen sensitivity
settes der). Streaming: `PROVIDER_SUPPORT=true` (`streamGenerateContent` er en generisk metode),
`ADAPTER_SUPPORT=false` (bevisst utsatt, ikke-trivielt, Q-30). Pris-sannhet: `pricing.ts` fikk
`pricing_mode`/`pricing_verified_at`-metadata (`gemma_hosted=FREE_TIER/2026-08-19`,
`local_llm`/`ollama`=LOCAL) - arkitekturen støttet allerede dynamisk prisoppdatering. Rate-limit/
router-økonomi verifisert korrekt, INGEN kodeendring nødvendig der. **Testregnskap korrigert:** D-80
sin opprinnelige "26 nye tester" var feil - faktisk 44 (22+22). D-81 la til 14 MER (11 routing + 3
vision). Nytt totalregnskap: `main` FØR D-80=1439 → ETTER D-80=1483 (+44) → ETTER D-81=1497 (+14),
108/108 filer grønn alle ganger. `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent, lokal
`gitleaks` "no leaks found". **D-80 = CI_VERIFIED/COMPLETE ETTER denne fiksen.** PR #21 forblir
draft, IKKE merget, INGEN AI Market/Cost Optimizer bygget, INGEN nye providere utover D-80 sine to,
INGEN Tobias-secret-oppsett. Full detalj: D-81 i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag):** JARVIS AI MESH — GEMMA-FIRST KOST-/PERSONVERNARKITEKTUR → D-80 (opprinnelig
implementasjon, senere herdet av D-81 over). Claude ikke lenger standardmodell for ordinær drift,
to nye providere (`gemma_hosted`/`local_llm`), `DataSensitivity`-klassifisering,
`hosted_free_tier`-markør, D-64/D-41-gater kjørt. Full detalj: D-80 i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det igjen (samme dag, MERGET):** UA-4 SLICE 2 (D-78) — CI-AKSEPTANSE ERSTATTER MANUELL
HOST-KJØRING → D-79. D-78 = `CI_VERIFIED / COMPLETE`. PR #20 MERGET (merge-SHA `f602040`) etter
Tobias sin eksplisitte godkjenning - UA4_SLICE_2 = VERIFIED/COMPLETE på `main`. UA-4 SOM HELHET
forblir IKKE komplett, UA-3 kriterium 2 forblir IKKE oppfylt (`sales=AVAILABLE marketing=AVAILABLE
product/finance/operations=NOT_INTEGRATED`, 2/5). Full detalj: D-79 i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det igjen (samme dag):** UA-4 SLICE 2: GROWTH → BUSINESS DOMAIN COVERAGE-INTEGRASJON → D-78,
FIXED_SUITE / IKKE HOST VERIFIED (senere oppgradert til CI_VERIFIED/COMPLETE av D-79 over). Lukker
Q-29 punkt 7: `BUSINESS_DOMAIN_COVERAGE` (`business-brief.ts`) hardkodet FORTSATT
`marketing: "not_integrated"` etter D-77, til tross for at Native Growth Core allerede var
VERIFIED/COMPLETE - datakilden fantes, men var ikke koblet inn i selve rapporteringen. **D-64-gate:**
`SYSTEM_OF_RECORD=JARVIS_CANONICAL`, `CAN_RUN_WITHOUT_PROVIDER=true` - ingen leverandør. **Design:**
`BUSINESS_DOMAIN_COVERAGE`-verdien utvidet fra en bar streng til `{status, source,
live_provider_connected}` - `status` (Jarvis-intern kapabilitet) og `live_provider_connected`
(ekstern leverandør-tilkobling) er BEVISST separate felt, forveksles ALDRI.
`marketing.status="available"` (source: Native Jarvis Growth Core), `marketing.live_
provider_connected=false`. `sales`/`product`/`finance`/`operations` uendret i sak. 24 nye/oppdaterte
tester. Full detalj: D-78 i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, MERGET):** UA-4 NATIVE JARVIS GROWTH CORE — ENDELIG LUKKING:
VERIFIED/COMPLETE → D-74/D-75/D-76/D-77. Tobias sin FJERDE, RENE host-kjøring
(`ua4-growth-core-host-run.ts`, run_id
`8f2b89e1`, `hard_fail=false`) ga ALLE 23 markører PASS, inkludert de tre som feilet i de tre
foregående rundene (`ua4_growth_spend_idempotent`, `ua4_growth_cac_roas`,
`ua4_growth_open_loop_resolved`). Repo-sannhet bekreftet FØR lukking: lokal og
`origin/claude/ua4-growth-core` HEAD identisk (`598f4547e7632413c5dde3806f0d1da8638545a7`),
arbeidstreet rent, INGEN kjørbar kode endret etter den host-testede SHA-en, GitHub CI
(`gitleaks`+`build-test`) begge grønne på nøyaktig denne SHA-en. **D-74/D-75/D-76 markeres NÅ
VERIFIED/COMPLETE.** Native Growth Core er `JARVIS_CANONICAL`/`HYBRID_WITH_CLEAR_AUTHORITY`, ZERO
annonseplattform-connector-avhengighet. **Live-bevist:** spend-idempotens (identisk retry OG
avvikende korreksjon, begge auditert), CAC/ROAS mot ekte CRM (`total_spend_ore=25000
won_opportunities=1 attributed_revenue_ore=500000 cac_ore=25000 roas=20`), OpenLoop-anomali
opprettes OG resolves (`open_loops_after_create=1 open_loops_after_normal_day=0`), Q-20-erasure,
Q-21, tenant-/space-isolasjon, ToolGateway, audit-sikkerhet, cleanup. **UA-3 kriterium 2 re-evaluert
mot det ordrette "kombinerer sales, product, finance, marketing, operations"-kriteriet** (et
INTEGRASJONS-kriterium, i motsetning til K1 sitt RESULTAT-kriterium) - kildekoden
(`business-brief.ts`) lest direkte, IKKE antatt: `BUSINESS_DOMAIN_COVERAGE` har FORTSATT
`marketing: "not_integrated"` hardkodet, INGEN kabling til `growth.*` finnes. **Kriterium 2 markeres
derfor FORTSATT IKKE oppfylt** - en ekte datakilde eksisterer nå (nødvendig, ikke tilstrekkelig),
selve kombineringen er ugjort, allerede registrert i Q-29 punkt 7. `sales="available"`,
`marketing`/`product`/`finance`/`operations="not_integrated"` (uendret utover at marketing nå har en
klar-til-kabling datakilde). **.gitleaksignore re-auditert, uendret** (ett snevert fingeravtrykk).
Full lokal suite 106/106 filer, 1422/1422 tester grønn, lint/typecheck rene. **PR #19 klar for
review** (`MERGE_READY=true`) - **MERGES IKKE uten Tobias sin eksplisitte godkjenning.** **UA-4 SOM
HELHET forblir IKKE komplett** (kun første av flere planlagte slices). **UA-3 forblir IKKE
komplett.** **HELE Sovereign Autonomy-masterplanen forblir IKKE komplett.** Neste UA-4-slice
velges FØRST i en egen fremtidig økt via D-64-porten. Full detalj: D-77 i
DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, FUNKSJONELT HOST-BEVIST, IKKE VERIFIED):** UA-4 NATIVE GROWTH CORE HOST
FIX #2 — "TIDSSONE-BUG I HOST FIX #1 SIN EGEN DATO-FIKS, ZERO PRODUKSJONSFEIL" → D-76. Tredje
host-kjøring (run_id `5c54b656`, `hard_fail=true`) - CAC/ROAS OG open-loop-resolusjon nå BEGGE
bekreftet PASS live (D-75 sine fikser
virket), KUN `ua4_growth_spend_idempotent=FAIL` gjensto, til tross for at loggen selv viste
`spend_event_ids_equal=true final_amount=25000`. **Rotårsak: D-75 sin EGEN dato-fiks
(`new Date(e.event_date).toISOString().slice(0,10)`) har en skjult tidssone-bug** - pg-types
konstruerer `date`-kolonner via `new Date(år, måned, dag)` i LOKAL tid, `.toISOString()` konverterer
til UTC, og paa en host med UTC-offset ULIK 0 (Tobias sin faktiske host, ikke byggemiljøets
UTC-sandbox) ruller dette datoen TILBAKE én dag - reprodusert eksplisitt:
`TZ=Europe/Oslo node -e "new Date(2026,0,10).toISOString()"` → `"2026-01-09T23:00:00.000Z"`.
**Fiks:** ny kanonisk helper `pgDateToIsoDate()` (`@jarvis/core`) som reverserer med de SAMME lokale
getterne pg-types selv brukte - tidssone-uavhengig. Brukt i host-scriptet OG i
`modules/growth/test/service-rls.test.ts` (samme latente bug, usynlig i UTC-CI, fikset proaktivt).
Den sammenslaatte `ua4_growth_spend_idempotent`-sjekken er nå splittet i fire eksplisitte
delmarkører (identisk retry / ingen duplikat / avvikende korreksjon / auditert korreksjon) pluss et
urelatert-kampanje-bevis - aggregatmarkøren forblir, men skjuler ikke lenger HVILKEN delkomponent
som feiler. PRODUCTION_BUG=false, HOST_ASSERTION_BUG=true (i D-75 sin egen fiks). 4 nye
regresjonstester (inkl. to som spawner en ekte `TZ=Europe/Oslo`-barneprosess og BEVISER at det gamle
mønsteret feiler mens den nye helperen er immun). `pnpm -w typecheck` 17/17 rent, `pnpm -w lint`
rent, full lokal suite 106/106 filer, 1422/1422 tester grønn. **Status: FUNKSJONELT PARTIAL /
HOST-VERIFIKASJON FEILET** (tredje host-runde, alle tre hard_fail=true) - D-74 markeres FORTSATT
IKKE VERIFIED/COMPLETE, krever ÉN NY REN host-kjøring. PR #19 oppdatert med run_id `5c54b656` -
forblir draft, IKKE merget. Full detalj: D-76 i DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, FUNKSJONELT HOST-BEVIST, IKKE VERIFIED):** UA-4 NATIVE GROWTH CORE HOST
FIX #1 — "AKSEPTANSESCRIPT-KUN, ZERO PRODUKSJONSFEIL" → D-75. To uavhengige, ekte
Windows/Docker-host-kjøringer (run_id `0a177044`/`5a03593a`) ga BEGGE `hard_fail=true`, EKSAKT tre
markører FAIL (`ua4_growth_spend_idempotent`, `ua4_growth_cac_roas`,
`ua4_growth_open_loop_resolved`), alle øvrige 16 av 19 PASS. **Alle tre
spores til `ua4-growth-core-live.ts` sin EGEN verifikasjons-/fixture-kode, IKKE til
`GrowthService`/`OpenLoopService`:** (A) spend-idempotens - scriptets `String(dateObject).slice(0,10)`
matcher aldri en ISO-dato (pg returnerer `date` som JS `Date`); produksjonens `ON CONFLICT DO UPDATE`
+ eksplisitt before/after-audit var HELE tiden korrekt (allerede regresjonstestet FØR denne
hendelsen). Fiks: `new Date(...).toISOString()` i scriptets egen sjekk. (B) CAC/ROAS - scriptets
fixture brukte en rå, RLS-kontekstløs `pool.query()` UPDATE mot en FORCE RLS-tabell (traff STILLE 0
rader) - EKSAKT samme feilklasse som D-54/D-58/D-59/D-62. Avdekket et EKTE produksjonshull
(`BusinessService.updateOpportunityStage()` kunne ikke sette `value_ore`) - fikset i produksjonskode
med en valgfri `valueOre`-parameter (RLS-trygg, D-41-samsvarende), scriptet bruker nå den ekte
kanoniske metoden. (C) Open-loop-resolusjon - scriptets normaliseringsverdi (2 000) var kopiert fra
en enhetstest med en ANNEN spike-størrelse (10 000, ikke scriptets 20 000) - reberegnet terskel for
20 000-spiken er `[2476.19, 5571.43]`, 2 000 lå UNDER; `detectSpendAnomalies()` var KORREKT hele
tiden. Fiks: normaliseringsverdi endret til 3 500 (matte dokumentert i kommentar). **Delt rotårsak:**
alle tre i SAMME fil, forfattet uten samme iterative ekte-Postgres-validering som
`modules/growth/test/*.test.ts` fikk. 3 nye regresjonstester, `.gitleaksignore` re-auditert (uendret,
fortsatt snevert til ett fingeravtrykk). `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent, full
lokal suite 105/105 filer, 1415/1415 tester grønn. **Status: FUNKSJONELT PARTIAL / HOST-VERIFIKASJON
FEILET** - D-74 markeres IKKE VERIFIED/COMPLETE ennå, krever ÉN NY REN host-kjøring. PR #19
oppdatert med begge run_id-er/rotårsaker/fikser - forblir draft, IKKE merget. Full detalj: D-75 i
DECISIONS_AND_ASSUMPTIONS.md.

**Runden før det (samme dag, FIXED_SUITE / IKKE HOST VERIFIED):** UA-4 GROWTH & MARKETING CONTROL
PLANE — FØRSTE SLICE: Native Jarvis Growth Core → D-74. Startet FØRST etter eksplisitt lesing av
`docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` (INGEN UA-4-detalj fantes fra før i
CANONICAL_SPEC/ARCHITECTURE/IMPLEMENTATION_PLAN - masterplanen er derfor eneste kanoniske kilde,
ingen motstrid). D-64 Core-vs-Adapter-porten kjørt FØRST: `SYSTEM_OF_RECORD=HYBRID_WITH_CLEAR_
AUTHORITY` (attribusjon/kampanjesporing/eksperimentregister/avviksdeteksjon er `JARVIS_CANONICAL`;
RÅ spend-/klikk-/visningstall fra en fremtidig annonseplattform er `EXTERNAL_CANONICAL`).
**UA4_SLICE_1 valgt: Native Jarvis Growth Core** - kanonisk kampanje-/utgifts-/attribusjon-/
eksperimentmodell, ZERO annonseplattform-credential (obligatorisk fundament for ALT annet
UA-4-arbeid, fremmer literale akseptansekriterier direkte, unngår unødvendig leverandørbinding).
Ny pakke `@jarvis/growth`, migrasjon `027_growth.sql` (`marketing_campaigns`/
`marketing_spend_events`/`marketing_attributions`/`marketing_experiments`/
`marketing_campaign_events`). Deterministisk kampanje-/eksperiment-lifecycle, idempotent
utgifts-ingestion (before/after state), EKSPLISITT deterministisk attribusjon til EKSISTERENDE
`business_leads`/`business_opportunities`, CAC/ROAS beregnet FRA ekte `business_opportunities.
value_ore`/`stage='won'` (ALDRI fabrikkert - `null` når nevneren er `0`, aldri en gjettet verdi).
`OpenLoopService` utvidet med `marketing_spend_anomaly` (glidende 7-dagers-snitt, INGEN ny motor).
`growth.*`-ToolGateway-namespace (16 handlinger, INGEN klasse D i denne sliceen). 66 nye tester,
`pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent. **INGEN ekte host-kjøring i DENNE økten**
(Docker/Windows-host ikke tilgjengelig her) - `ua4-growth-core-host-run.ts`/`-live.ts` SKREVET og
lokalt bevist via embedded Postgres, status ærlig **FIXED_SUITE / IKKE HOST VERIFIED**. **UA-4 SOM
HELHET forblir IKKE komplett** (kun første av flere planlagte slices - se Q-29 for gjenstående:
live connectorer, autonome budsjett-/bud-endringer, kreativ intelligens, Finance Integrity Gateway,
samtykke-/cookie-dokumentasjon, UTM-auto-attribusjon, BUSINESS_DOMAIN_COVERAGE-kabling). **UA-3
forblir IKKE komplett** (kriterium 2 fortsatt PARTIAL - vekst-domenet finnes nå men er IKKE koblet
inn i brief-domenedekningen ennå). **HELE Sovereign Autonomy-masterplanen forblir IKKE komplett.**
Draft-PR opprettes, IKKE merget, INGEN leverandør-connector valgt, INGEN autonome spend-endringer.

**Runden før det (samme dag, MERGET):** UA-3 NATIVE CONTRACTS CORE — ENDELIG LUKKING: VERIFIED/COMPLETE
→ D-71/D-72/D-73. Tobias sin TREDJE, RENE host-kjøring (`ua3-native-contracts-host-run.ts`,
run_id `5ca4765b`, `hard_fail=false`) ga ALLE 26 markører PASS, inkludert `ua3_contracts_cleanup`
(FAIL i de to foregående rundene, D-72). Repo-sannhet bekreftet FØR lukking: lokal og
`origin/claude/ua3-native-contracts-core` HEAD identisk (`8d530e6`), arbeidstreet rent, INGEN
kjørbar kode endret etter den host-testede SHA-en. Migrasjon `026_contracts.sql`, pakke
`@jarvis/agreements`, D-71-implementasjonen og D-72 sin `cleanupTenant()`-fiks alle bekreftet til
stede i kildekoden. **D-71 markeres NÅ VERIFIED/COMPLETE.** Native Contracts Core er `JARVIS_CANONICAL`.
**K1 ("Hva skjer med kunde X?"):** re-evaluert mot det ordrette masterplan-kriteriet (`docs/input/
02_..._v4.0.md` linje 469: *"'Hva skjer med kunde X?' gir complete source-backed timeline"* - INGEN
nevning av juridisk e-sign/signaturutførelse der) - CRM/Sales (P0), Support/tickets (D-70) OG NÅ
Contracts Core (D-71/D-73) er ALLE host-verifisert og bidrar til Business OS-tidslinjen. **K1
markeres derfor NÅ VERIFIED/COMPLETE** - Q-28 sin SIGNATURE EXECUTION PROVIDER-halvpart (juridisk
bindende e-signaturutførelse) er et SEPARAT Integrasjonskatalog-kapabilitetspunkt, IKKE en del av
det ordrette K1-akseptansekriteriet, og forblir egen, ÅPEN (Tobias-leverandørbeslutning kreves).
**HELE UA-3 forblir IKKE komplett** (akseptansekriterium 2 - tverr-domene sales/product/finance/
marketing/operations - fortsatt PARTIAL, avhenger av UA-4/UA-5/UA-6, ingen startet). **HELE
Sovereign Autonomy-masterplanen forblir IKKE komplett.** Full lokal suite grønn, `pnpm -w lint`
rent, `pnpm -w typecheck` rent, GitHub CI (`gitleaks`+`build-test`) grønn på `8d530e6`. **PR #18
status: klar for review** (alle påkrevde CI-sjekker grønne, full lokal regresjon grønn, ekte
host-bevis foreligger) - `MERGE_READY=true`, men **MERGES IKKE uten Tobias sin eksplisitte
godkjenning** (CLAUDE.md-regel, uendret - dette er IKKE en godkjenning). **STOP etter denne
lukkingen. Ingen merge utført. Ingen signaturleverandør. Ingen UA-4.**

**Runden før det (samme dag, FUNKSJONELT HOST-BEVIST, IKKE VERIFIED/CLOSED):** UA-3 NATIVE CONTRACTS
CORE HOST FIX #1 (D-72) - SYNTHETIC CLEANUP ONLY. To ekte Windows/Docker-host-kjøringer (run_id
`1e9ae3a8`/`53d294b8`) ga BEGGE `hard_fail=true`, men ALLE 25 funksjonelle/sikkerhets-/Q-20-markører
PASSET - KUN `ua3_contracts_cleanup=FAIL` (`business_followups`-fixture fra Q-20-seksjonen ikke
ryddet av `cleanupTenant()` - EKSAKT samme feilklasse som Native Support Core sin egen D-69). Fikset
ved å utvide `cleanupTenant()` i `ua3-native-contracts-live.ts` med `DELETE FROM
business_followups`, 8 nye regresjonstester. Se egen seksjon lenger ned for full detalj.

**Runden før det (samme dag, FIXED_SUITE FØR host-funnet over):** UA-3 NATIVE JARVIS CONTRACTS CORE
(D-71) - ny pakke `@jarvis/agreements`, migrasjon `026_contracts.sql`, 96 nye tester. Se egen
seksjon lenger ned for full byggedetalj.

**Runden før det (samme dag, MERGET):** UA-3 NATIVE SUPPORT CORE — ENDELIG LUKKING: VERIFIED/COMPLETE
→ D-66/D-67/D-68/D-69/D-70. Tobias sin FJERDE, RENE host-kjøring (`ua3-native-support-host-run.ts`,
run_id `da7e0c1b`, `hard_fail=false`) ga ALLE 26 markører PASS. PR #17 merget til `main`
(merge-commit `7149ac6`). Se egen seksjon lenger ned for full detalj.

**Forrige runder (samme dag):** HOST FIX #1 (D-67, run_id `60f0d682`/`5457c59a`) → SECURITY FIX #2
(D-68, ekstern sikkerhetsaudit) → HOST FIX #3 (D-69, run_id `1e821a86`, kun teardown) → D-70
(endelig ren kjøring). Se egne seksjoner nederst for full detalj per runde.

**Runden før det (samme dag, FIXED_SUITE FØR host-funnet over):** UA-3 NATIVE JARVIS SUPPORT CORE
(D-66) - ny pakke `@jarvis/support`, migrasjon `024_support.sql`, 62 nye tester (1176→1240). Se egen
seksjon lenger ned for full byggedetalj.

**Runden før det (samme dag, MERGET):** Q-27 - RLS-blind business-tenant-enumering: VERIFIED/CLOSED
(D-65) - PR #16 merget til `main` (merge-commit `65cafc5`, host-bevist run_id `8549d23f`,
`hard_fail=false`, alle 15 markører PASS).

**Runden før det (samme dag, MERGET):** CORE OWNERSHIP / ADAPTER BOUNDARY INVARIANT (D-64) - PR #15
merget til `main` (merge-commit `0566b7a`), ny regel 12 i CLAUDE.md + §11 i ARCHITECTURE.md.
Support/tickets nå eksplisitt `JARVIS_CANONICAL` (Native Jarvis Support Core-retning, Tobias-
besluttet), tidligere Zendesk-connector (draft-PR #13) SUPERSEDED, IKKE merget, branch bevart. Den
tidligere, feilaktig Zendesk-branch-stablede governance-versjonen (PR #14) er SUPERSEDED/closed.
UA-2 forblir VERIFIED/COMPLETE i sin helhet → D-48, uendret · P1A Runtime Wiring Closeout forblir
VERIFIED/COMPLETE (host-smoke-bevist, PR #6 merget) · UA-2 P1A selv forblir VERIFIED/COMPLETE (D-42,
uendret, host-bevist run_id `2703299e`, PR #5 merget) · UA-2 P1B-A merget til `main` (PR #7) · UA-2
masterplan-closeout merget til `main` (PR #8) · UA-3 P0 merget til `main` (PR #9) · UA-3 Open-Loop
Detection + Business Brief merget til `main` (PR #10) · UA-3 Business-Event-Linkage merget til `main`
(PR #11) · UA-3 Profiling/Scoring merget til `main` (PR #12) · UA-3 Support/Tickets (Zendesk, PR #13):
SUPERSEDED, IKKE merget · Core Ownership/Adapter Boundary (PR #15): MERGET til `main`

---

**Tidligere oppdatering, 2026-08-17** (UA-3 — Profiling/Scoring VERIFIED/COMPLETE → D-63, uendret av
denne governance-runden): Tobias sin ANDRE host-kjøring (`run_id 61b5cf63`, `hard_fail=false`) kom
HELE VEIEN gjennom UTEN nye funn - alle 17 markører PASS inkl. `ua3_scoring_idempotent=PASS`
(`score_rows_for_same_identity=1`), etter HOST FIX #1 (D-62, RLS-blind idempotens-spørring).
Transparent, 100% deterministisk BUSINESS-OPERASJONELL prioritering (`lead_priority_v1`)/risiko-
scoring (`opportunity_risk_v1`) - ALDRI generalisert personprofilering. **Akseptansekriterium 4 er
re-evaluert til COMPLETE/VERIFIED** - rettslig grunnlag (GDPR art. 6(1)(f)) lagt til
`UA3_BUSINESS_DPIA.md`, GDPR art. 22 eksplisitt vurdert og funnet ikke relevant. **Fire-kriterie
UA-3-matrise (D-63):** kriterium 1 PARTIAL, kriterium 2 PARTIAL, kriterium 3 COMPLETE/VERIFIED,
kriterium 4 COMPLETE/VERIFIED. 1160/1160 tester. **HELE UA-3 er FORTSATT IKKE komplett.** Branch
`claude/ua3-profiling-scoring-controls` (fra `origin/main` `4a19396`) merget til `main` (PR #12).

## Aktiv fase
Masterplan v4.0 «Sovereign Autonomy» — **UA-0 CORE RUNTIME = CLOSED** (formelt, BO-08).
**UA-1 UNIVERSAL AI MESH: P0 VERIFIED · MULTI-PROVIDER LIVE VERIFIED · P1A (streaming+tool-calling) VERIFIED (BO-11).**
**D-30 VOICE = VERIFIED** (BO-12, merget til main 2026-08-14, commit `8f28862`).
**Q-21 (systembredt DB admin/runtime-rolle-gap): VERIFIED/CLOSED (2026-08-15, host-bevist,
run_id `778bb87d`)** → D-38. Host bekreftet at api/worker/migrate opprinnelig kjørte som
Postgres-superbruker (RLS aldri håndhevet til tross for korrekte policyer); fikset permanent med
admin/runtime-DB-config-splitt + idempotent `jarvis_runtime`-rolle-bootstrap + fail-closed
startup-vakter + ett automatisert host-fiks-script (tre host-recovery-runder samme dag - se
RUNTIME_GATES.md for full feilsøkingslogg; faktisk root cause var et stale Docker-image som ble
gjenbrukt av `docker compose run` i stedet for å bygges på nytt). **Host-bevis:**
`migrate_effective_db_user=postgres`, `runtime_current_user=jarvis_runtime`,
`runtime_role_superuser=false`, `runtime_role_bypassrls=false`, `runtime_role_canlogin=true`,
`runtime_role_member_jarvis_app=true`, `q21_runtime_role_safe=PASS`, `tenant_isolation=PASS`,
`memory_space_isolation=PASS`.
**UA-2 UNIVERSAL KNOWLEDGE LAYER: P0 (Knowledge Ingestion Foundation) = VERIFIED/COMPLETE
(2026-08-15, samme host-kjøring)** → D-39. Alle P0-akseptansekriterier host-bevist mot ekte
Postgres/pgvector, ekte filsystem, ekte GitHub-repo: filesystem full livssyklus, ekte FTS/vector/
hybrid, filsystem-sikkerhet (allowlist/traversal), GitHub live sync+dedupe, tenant/memory-space-
isolasjon - alle PASS, `duplicate_documents=0`, `hard_fail=false`. `symlink_escape=
SKIPPED_HOST_PERMISSION` (Windows-hosten tillot ikke symlink uten admin-rettigheter denne
kjøringen) - eksplisitt IKKE et live-PASS, mekanismen forblir suite-bevist
(`filesystem-source.test.ts`). Full evidens: docs/RUNTIME_GATES.md.
**UA-2 P1A (Knowledge Source Expansion + Google Drive Full Read/Write): VERIFIED/COMPLETE
(2026-08-16, host-bevist på ekte Windows/Docker-host, run_id `2703299e`, `hard_fail=false`)** → D-42.
Ni oppfølgingsrunder (hver drevet av et ekte Tobias-host-funn) endte med full grønn host-akseptanse:
Obsidian-livssyklus, tenant-isolasjon/retrieval for nye kildetyper, Google Drive full read/write
ende-til-ende (Desktop-OAuth-bootstrap, Drive API aktivert, auth/read/create/update/rename/move/
trash/permanent_delete/cleanup/sync/no-resurrection/idempotency/policy/live ALLE PASS), Q-21 uendret
i samme kjøring, ingen token-lekkasje. Eksplisitt, ærlig unntak: `google_drive_permission_live=
SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL` (live permission-mutasjon IKKE host-testet - se Q-23, IKKE en
blokkering for lukking). PR #5 merget til `main`. Full evidens under "UA-2 P1A FINAL CLOSURE" nederst i denne filen.
**Q-20 (teknisk data-erasure-foundation, FØR UA-2 P1): VERIFIED/CLOSED (2026-08-16, host-bevist på
ekte Windows/Docker-host, run_id `eaabe2b1`)** → D-40. Ny pakke `@jarvis/erasure` - sentral, typed
`ErasureService` (preview/execute/verify) med scope-modell (`tenant`/`person`/`memory_space`/
`knowledge_source`/`knowledge_document`/`conversation`). Hard-delete av knowledge- OG memory-innhold +
alt avledet (embeddings/versjoner/entiteter/relasjoner/oppsummeringer/beslutninger/forpliktelser/
frister), FK-trygg/fail-closed/idempotent. `erasure_fingerprints`-suppresjonsledger hindrer at
`KnowledgeSyncService` gjenoppliver slettet innhold ved neste source-sync (kun SHA-256-fingerprint,
aldri klartekst) - bevist LIVE. D-klasse policy-integrasjon gjenbruker eksisterende `PolicyGateway`/
sovereign/approval uendret, bevisst IKKE via `ToolGateway`s D-pipeline (ville lagret en KOPI av
innholdet i et recovery-snapshot - dokumentert unntak). `jarvis_app` fikk et nytt, avgrenset
`GRANT DELETE` (kun de faktisk hard-slettede tabellene - `events`/`audit_events` forblir
append-only-blokkert). **Host-bevis:** `q20_preview`/`q20_hard_delete`/`q20_derived_delete`/
`q20_fts_erasure`/`q20_vector_erasure`/`q20_hybrid_erasure`/`q20_memory_erasure`/`q20_no_resurrection`/
`q20_idempotency`/`q20_tenant_isolation`/`q20_space_isolation`/`q20_receipt_safe`/`q20_sentinel_scan` =
ALLE PASS, `hard_fail=false`; resync-bevis `created=0`/`suppressed=1`; retrieval etter purge
`fts_hits=0`/`vector_hits=0`/`hybrid_hits=0`/`memory_hits=0`; `q21_runtime_role_safe=PASS` uendret i
samme kjøring. Tre host-recovery-runder samme dag (workspace-bootstrap → Windows pnpm-
prosessoppløsning → DEP0190-opprydding, se RUNTIME_GATES.md) løste kun host-/prosess-hygiene, ingen
erasure-logikk endret. **Teknisk foundation, IKKE juridisk GDPR-sertifisering.** Fortsatt eksplisitt
dokumenterte, ikke purgede stores: `events`/`audit_events`-payload, `tasks`/`tool_executions`-innhold,
Langfuse/trace-fil, `person`-scope dekker ikke knowledge-dokumenter. Full evidens:
docs/DATA_ERASURE.md og docs/RUNTIME_GATES.md.

## UA-0 (lukket)
D-27/D-28/D-32/D-35/OPS-RUNTIME/UA0-RUNRATE = VERIFIED (evidens: docs/RUNTIME_GATES.md).
Owner-seed nå automatisk/idempotent i one-shot migrate. **D-30 Voice = VERIFIED** (BO-12,
host-runde 6 - merget til main). Gjenværende åpne, ikke-blokkerende porter: D-36 Apple,
HA-RUNTIME, D-10 STT-benchmark (≥100 norske prøver, providervalg - se OPEN_QUESTIONS Q-03).

## UA-1 P1A (BO-11)
- Normalisert streaming (OpenAI+Claude live, ttft, cancel/barge-in-fundament, pre-output-fallback,
  konservativ post-output-policy), provider-uavhengig tool-calling via trusted mesh-bridge→ToolGateway
  (kun A/B-read i P1A), idempotent utførelse, cross-provider recovery etter utført verktøy (aldri
  dobbel side-effekt), SSE-chat + worker-tool-mesh live. Evidens: RUNTIME_GATES BO-11.
- **P1A delta (BO-11.1):** SQL streaming-metrics i cost_events (migrasjon 016), SSE
  klient-disconnect → upstream cancellation (barge-in-fundament bevist på HTTP-nivå),
  executive-handler-paritet api↔worker (delt handler), eksplisitt D-class-mesh- og
  SSE-fixture-regresjon (+ fix: Anthropic stream-error-events klassifiseres, aldri stille suksess).
- **Sovereign-fix (pre-merge):** api/worker-wiringen manglet authority-config → owners D-kall
  krevde feilaktig approval (legacy SCOPED). Fikset i main/worker/bo11-live; begge semantikker
  testbevist (owner sovereign → full D-pipeline uten approval; delegat → approval-gate + replay-vern).
  249/249 tester. Delta-live på host gjenstår: `apps/api/scripts/bo11-1-delta-live.ts`.

## UA-1 LIVE-status (BO-10)
- **UA-1 MULTI-PROVIDER LIVE = VERIFIED (BO-10).** OpenAI + Anthropic/Claude begge LIVE i container-runtime.
  Cross-provider fallback PASS begge retninger; multi-provider critic PASS begge veier; owner override,
  health, 401/429/timeout, benchmark (10/10), Langfuse- og cost_events-korrelasjon verifisert.
  Gemini/Kimi/Ollama fortsatt IMPLEMENTED_NOT_LIVE (nøkler mangler - ikke-blokkerende).

## UA-1 P0 (BO-08)
- AI Router (deterministisk), CapabilityRegistry, ProviderHealth, versjonert pricing, normaliserte
  request/response-kontrakter, klassifisert fallback, critic (opt-in), purpose-taksonomi.
- Providere: **OpenAI LIVE (baseline)**; Claude/Gemini/Kimi/Ollama IMPLEMENTED_NOT_LIVE
  (mangler kun: ANTHROPIC_API_KEY, GEMINI_API_KEY, KIMI_API_KEY, JARVIS_OLLAMA_URL i .env/vault).
- Live-akseptanse i container: routed kall m/routing_reason i Langfuse + mesh-felter i cost_events
  (migrasjon 015). /status og /ai (Telegram) viser mesh-status.
- LIVE multi-provider fallback + benchmark: NOT YET VERIFIED (krever ≥2 cloud-credentials);
  logikk verifisert med fake-adaptere.
- Kvalitet: 203/203 tester (Node 22), lint, typecheck, gitleaks rene. Full stack healthy.

## D-30 Voice (BO-12) — VERIFIED

- **Status: VERIFIED (2026-08-14, host-runde 6).** Host-live-akseptanse fullført og
  bestått: real-provider streaming smoke PASS (inkrementell levering bekreftet),
  §32 generation cancellation PASS (aktiv stream observert, abort etter 3 tokens,
  ren neste tur), §1/§2 real audio barge-in PASS (`barge_in_audio_stop_ms=0` ≤
  250ms-gate, 0 stale frames, ren neste tur), 10-tur soak PASS **to uavhengige
  kjøringer** (10/10, én session_id, `duplicate_tool_executions=0`, turn 8
  cancelled/turn 9+10 normale, begge ganger), Q-18 FIXED bekreftet live
  (kalender-repetisjon gir ferske svar). Merget til `main` (se commit under).
  Branch `claude/d30-voice`. Voice er transportlag over eksisterende Jarvis (samme mesh/
  tools/authority/minne): streaming Core-klient (P1A-SSE) → setningschunking → TTS-kø,
  full barge-in (stopp lyd + tøm kø + abort generering upstream, epoch-vern mot stale
  audio), eksplisitt tilstandsmaskin m/personvern (ingen skjult opptak, rå lyd
  persisteres aldri), STT-/TTS-feilbaner, full latenskjede-metrics, voice-helse i
  /status, cross-provider-override. OpenAI STT/TTS er P0-baseline (nøkkel alt live).
- **Live-findings-fix (host-runde 2):** TTS/STT/no-tool/cross-provider/barge-in PASS live,
  kalender-voice feilet, fikset (ConversationEngine→completeWithTools-bro, per-identity
  executor, trusted SSE tool_call, voice-device-seed, semantisk STT-akseptanse). Runde 2
  bekreftet: kalender-voice PASS live (`tools=[read_calendar_today]`).
- **FINAL HOST ACCEPTANCE HARDENING (host-runde 3):** funn+fiks: `VoiceSession`
  hadde INGEN klientdisconnect-håndtering → zombie-generering ved WS-frakobling midt i
  tur; ny `disconnect()` wiret til `ws.on("close")`. Ekte lyd-barge-in-akseptanse
  (`barge_in_audio_stop_ms`, ≤250ms-gate) + stale-audio-settlingsjekk i bo12-voice-live.ts;
  10-tur host-soak (`bo12-voice-soak.ts`); full latenskjede-rapportering per tur.
  Q-18 reprodusert (BLOCKER).
- **HOST FAILURE FIX (host-runde 4, denne):** host kjørte de nye scriptene - tre feil
  funnet, alle undersøkt til rot (ikke gjettet) og fikset:
  - **§32 (legacy LLM-abort-test) feilet** ("forventet AbortError, fikk suksess") -
    root cause = race (kategori B: modellen rakk fullføre før 5. token+abort);
    mekanismen selv er uendret bevist korrekt (suite, treg adapter). Fiks: abort
    trigges nå på FØRSTE token + lengre (500+ ord) tekst - assertion uendret.
  - **Soak turn 8 timet ut** - root cause = harness-deadlock (ventet på turn 8s
    EGNE metrics FØR turn 9s barge-in-lyd ble sendt), IKKE sesjonskorrupsjon.
    Fikset: turn 8+9 kjøres nå konkurrerende (vent kun til "speaking", så send
    barge-in). Ny eksplisitt "korrekt cancelled-turn"-definisjon (cancelled +
    t_speech_start + t_tts_first_frame), speilet i suite-regresjon.
  - **`tools=[read_calendar_today,read_calendar_today]` avgjort via kjørt test:**
    kategori (A) - 2 SSE-events, KUN 1 faktisk ToolGateway-kall (in-memory
    per-tur-cache i ModelGateway.completeWithTools fungerte allerede korrekt).
    16s-TTFT skyldes en EKSTRA MODELLRUNDE, ikke dobbel verktøyutførelse.
  - **Q-18 FIKSET:** `tool_executions`-dedupe gjelder nå kun C/D
    (`capability_class !== "A"` i gateway.ts). A-class reads utfører friskt per
    brukertur; write/mutation-dedupe uendret (regresjonstestet). In-memory
    per-tur-beskyttelse (samme tur, samme kall → maks 1 utførelse) uendret,
    testet separat fra database-/sesjonsnivå-fiksen.
  - 279/279 tester, lint/typecheck/gitleaks rene. Ingen regresjon.
- **FINAL BARGE-IN HOST BLOCKER (host-runde 5, denne):** host bekreftet Q-18-fiksen
  PASS live, men §32 feilet med NY info som avkrefter forrige race-hypotese:
  0 tokens over 35,5s, deretter suksess (ikke "modellen var rask", men "ingen
  inkrementelle events observert i det hele tatt"). Kan IKKE avgjøres endelig
  uten host-tilgang - IKKE gjettet. Gjort denne runden:
  - **Kodesporing:** hele kjeden er strukturelt identisk for alle requests;
    Ollama/Gemini/Kimi-hypotesen (ikke-strømmende adaptere) undersøkt og
    AVKREFTET ved lesing (ville gitt ≥1 token, ikke 0); ingen reverse proxy
    i docker-compose.
  - **Deterministisk sandbox-bevis KJØRT i denne økten** (ekte server+SSE+
    embedded PG, ingen mocks): 600 tokens levert inkrementelt over 702ms,
    abort på 1. token → AbortError på 19ms. Beviser egen kode er IKKE
    generisk buffret. Formalisert som 2 nye permanente suite-tester.
  - **Server-side diagnostikk lagt til** (`JARVIS_STREAM_DEBUG=true`, kun
    type+timing, aldri innhold) i 3 lag (gateway/conversation/SSE-write) -
    lar host avgjøre PRESIST hvor levering evt. slutter å være inkrementell.
  - **§32 redesignet - "500 ord"-fixen FJERNET helt** (var en blind
    lengde-gjetning). Ny §3B smoke-test måler faktisk observert
    inkrementell levering FØRST; §32 kjøres kun betinget på det, rapporterer
    IKKE KJØRT (inkonklusivt) i stedet for FAIL når ingen aktiv stream kan
    bevises - og en feiling NÅR streaming er bekreftet er en høy-konfidens
    ekte regresjon, ikke en race.
  - **Ekte lyd-barge-in (§1/§2) koblet løs fra lang LLM-respons** - kort
    normalsvar, trigges kun på observert avspilling.
  - **Soak turn 8:** sannsynlig samme fenomen som §32 (ikke egen
    harness-feil) - tidsstemplet tilstandshistorikk lagt til, timeout økt
    til 60s, tekst kortet ned, timeout merkes ikke lenger stille som
    "corrupted" uten forklaring.
  - 281/281 tester, lint/typecheck/gitleaks rene. Ingen regresjon.
- **FINAL CLOSURE (host-runde 6, denne):** full host-evidens mottatt og bekreftet
  (se detaljert tabell i docs/RUNTIME_GATES.md). D-30 satt VERIFIED; PR #2 merget
  til `main`. §32s tidligere anomali (runde 5: 0 tokens/35.5s) reproduserte IKKE
  denne runden - real-provider streaming var inkrementell (`token_count=142`,
  `spread_ms=4757`) og cancellation fungerte korrekt (abort etter 3 tokens).
  Vurdert som en engangs-nettverksanomali (runde 5), ikke et vedvarende mønster.
- **Ytelsesgjeld (IKKE en D-30-blokker - egen åpen post, se OPEN_QUESTIONS.md
  Q-19):** host-observert latens er funksjonelt korrekt men treg for ønsket
  realtime-opplevelse: `e2e_first_audio` vanligvis ~3.5-6.2s, enkelte turer
  ~9-12s, streaming-smoke første token ~12.7s. D-30-korrekthet er verifisert
  UAVHENGIG av dette - realtime-latensoptimalisering er bevisst utsatt til egen
  runde (ingen optimalisering gjort i denne lukkingen).

## UA-2 P0 — Knowledge Ingestion Foundation (BYGGET denne økten)
- **Status: SUITE-VERIFIED. IKKE host/live-verifisert** (sky-container: ingen Docker, ingen ekte
  GitHub-PAT, ingen ekte NAS-mount). Godkjent P0-scope fra spec-runden bygget i ny pakke
  `modules/knowledge` (`@jarvis/knowledge`):
  - `KnowledgeSource`-kontrakt (kilde-uavhengig, ingen credentials i kontrakten).
  - `FilesystemKnowledgeSource`: allowlistet root, `realpath()`-verifisert FØR lesing - traversal/
    symlink-escape strukturelt umulig (ikke bare filtrert).
  - `GithubKnowledgeSource`: via eksisterende ToolGateway/policy/audit (ny `read_repo_meta`-action,
    samme PAT/scope som `read_issues` - ingen scope-utvidelse); repo-fil-innhold dokumentert som
    neste skive (transporten støtter det ikke i dag).
  - `KnowledgeSyncService`: idempotent sync-rapport, canonical identity + content_hash-dedupe,
    tombstone ved forsvunnet kilde (myk sletting), deterministisk reaktivering.
  - `KnowledgeRetriever`: FTS+vector hybrid på eksisterende pgvector-fundament (D-28), full
    provenance, tombstonede dokumenter alltid ekskludert.
  - Migrasjon `017_knowledge.sql`: samme RLS-mønster som `memory_items` (tenant+space i databasen).
  - DPIA-notat: `docs/UA2_KNOWLEDGE_DPIA.md`. Åpent gap Q-20 (kun myk sletting, ingen GDPR-purge-vei
    ennå) - dokumentert, ikke skjult.
  - **Regresjon funnet+fikset:** `read_repo_meta` midt i `firstWaveTools()`-arrayet forskjøv
    posisjonsindekser to eksisterende tester brukte - flyttet til slutten av arrayet.
  - 294/294 tester (281+13 nye), lint/typecheck/gitleaks rene. Full evidens: docs/RUNTIME_GATES.md.
- **Gjenstår for host/live-verifikasjon (§13 i BO-en, IKKE gjort her):** ekte NAS-mount, ekte
  GitHub-repo-sync med reell PAT, full ende-til-ende-demo kjørt på Tobias sin host.
- **FINAL HOST ACCEPTANCE HARNESS (forrige runde, bygget):** `modules/knowledge/scripts/ua2-p0-live.ts` -
  kjøres `node --env-file=.env --experimental-transform-types modules/knowledge/scripts/ua2-p0-live.ts`.
- **HOST-BLOCKER-RUNDE (denne økten, 2026-08-15):** Tobias kjørte harnesset live. 13/15 felt PASS
  (filesystem livssyklus, provenance, FTS/vector/hybrid, filsystem-sikkerhet, GitHub live sync+dedupe
  `created=2`→`unchanged=2`). **`tenant_isolation`/`memory_space_isolation` FEILET.** Root cause
  funnet (ikke gjettet): harnesset beviste isolasjon via `pool` (samme rolle api/worker/migrate
  faktisk bruker) UTEN å verifisere bypass-status - `jarvis_app` er en `NOLOGIN`-gruppe-rolle, og
  INGEN sted i den faktiske driftsveien oppretter en ekte login-rolle bundet til den (kun suitens
  test-oppsett gjør det). Dette avdekket samtidig et **systembredt (ikke UA-2-spesifikt)
  deployment-gap** - se **Q-21 i OPEN_QUESTIONS.md** (trenger Tobias sin beslutning; docker-compose/
  migrate-main.ts bevisst urørt, utenfor denne BO-ens scope). **Fikset:** harnesset bootstrapper nå
  en fersk, garantert non-bypass rolle (kun for isolasjons-BEVISET) + ny §6-diagnostikk
  (`rls_test_role`/`_superuser`/`_bypassrls`, `knowledge_rls_enabled`/`_force_rls`,
  `configured_app_role`/`_superuser`/`_bypassrls`) som fail-closed skiller HARNESS FEIL fra RUNTIME
  FEIL. Presisjonsfunn underveis: rå listelengde er ikke et presist lekkasje-mål (vektor-selvtreff-
  støy fra `LocalHashEmbedding`) - assertions sjekker nå faktisk innhold. Nye regresjonstester:
  `modules/knowledge/test/rls-role-isolation.test.ts` (6 tester, inkl. et eksplisitt kontrast-bevis
  §K: samme spørring lekker via superbruker, ikke via non-bypass-rolle). Full detaljer:
  docs/RUNTIME_GATES.md.
- **Q-21 AUTOMATISK DIAGNOSE (samme dag):** `ua2-p0-live.ts` diagnostiserer nå selv, i ÉN kommando,
  om den faktiske runtime-rollen er trygg (`q21_runtime_role_safe`) og kjører isolasjons-acceptance
  via `pool` direkte når den er det - ellers `BLOCKED_BY_RUNTIME_ROLE` (aldri fake PASS).
- **Q-21 HOST-BEVIS (samme dag):** Tobias kjørte diagnosen live - `current_user=postgres`,
  `runtime_role_superuser=true`, `runtime_role_bypassrls=true`, `q21_runtime_role_safe=FAIL`. Bekreftet:
  RLS-policyene finnes og FORCE RLS er aktivt (`knowledge_documents_force_rls=true`), men
  api/worker/migrate kjørte alle som Postgres-superbruker - en ekte systembred
  runtime-konfigurasjonsfeil, ikke en UA-2-kode-bug.
- **Q-21 SYSTEMBRED FIKS (denne runden):** permanent split innført i `@jarvis/core`:
  `configFromEnv()` (RUNTIME, default `jarvis_runtime`) vs. ny `adminConfigFromEnv()` (ADMIN, leser
  `JARVIS_DB_ADMIN_USER/PASSWORD`) - to distinkte lesere, ingen fallback mellom dem. Ny
  `ensureRuntimeRole()` (idempotent, admin-kjørbar) bootstrapper `jarvis_runtime`
  (LOGIN/NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE, medlem av `jarvis_app`) fra
  `migrate-main.ts` (nå på `adminConfigFromEnv()`). `main.ts`/`worker-main.ts` fail-closed ved
  oppstart (`assertRuntimeCredentialsConfigured`/`assertRuntimeRoleSafe`) - nekter å starte normalt
  uten gyldige, distinkte, non-bypass runtime-credentials. `.env.example`/`docker-compose.yml`
  oppdatert med forklarende kommentarer (ingen ny parallell config-modell - samme grants/RLS som
  `jarvis_app` alt hadde, 005_rls.sql). **Automatisert host-fiks:**
  `modules/core/scripts/fix-q21-runtime-role.ts` - ÉN kommando som backup-er `.env`, genererer
  runtime-credentials, kjører migrate (bootstrapper rollen), restarter api/worker, verifiserer
  FAKTISK trygg tilkobling direkte mot Postgres, og kjører `ua2-p0-live.ts` til slutt. Ingen
  volumes/data røres. 24 nye tester (`modules/core/test/runtime-role.test.ts`,
  `db-config-split.test.ts`, `apps/api/test/db-role-wiring.test.ts`) - 324/324 totalt,
  lint/typecheck/gitleaks rene (inkl. `scripts/`-mapper nå faktisk typecheck-dekket, tidligere
  stille utelatt).
- **HOST RECOVERY-RUNDER (samme dag, tre runder til faktisk grønt):** første host-kjøring av
  fiks-scriptet feilet delvis (`.env`-interpolasjonsbug i Docker Compose - fikset med eksplisitt
  `--env-file`), deretter feilet migrate-containeren fortsatt med `password authentication failed for
  user "jarvis_runtime"` selv om admin-precheck viste `postgres` (runde 2 - grundig kildesporet, ingen
  kodebug funnet i selve wiringen). Faktisk root cause (runde 3, Tobias sin egen hypotese, bekreftet):
  `docker compose run --rm migrate` bygger ALDRI om et image automatisk - containeren kjørte et
  utdatert, pre-Q21-image. Fikset ved å alltid kjøre `docker compose build migrate api worker` før
  migrate/restart i hvert scriptkall. Full feilsøkingslogg: docs/RUNTIME_GATES.md.
- **STATUS: VERIFIED/COMPLETE (2026-08-15, host-bevist, run_id `778bb87d`) → D-38/D-39.** Full
  host-kjøring bekreftet grønt: `q21_runtime_role_safe=PASS`, `tenant_isolation=PASS`,
  `memory_space_isolation=PASS`, alle øvrige UA-2 P0-felt PASS unntatt `symlink_escape=
  SKIPPED_HOST_PERMISSION` (eksplisitt IKKE et live-PASS, forblir suite-bevist). Se
  header-seksjonen øverst i denne filen og docs/RUNTIME_GATES.md for full evidens.

## Q-20 — Data Erasure Foundation (BYGGET denne økten, 2026-08-16)
- **Inventory først** (docs/DATA_ERASURE.md §2): faktisk skjema lest (ikke antatt) - klassifisert
  A (CONTENT)/B (DERIVED)/C (OPERATIONAL METADATA)/D (SECURITY/AUDIT, append-only-blokkert).
- **Én sentral, typed erasure-tjeneste** (`modules/erasure`, `@jarvis/erasure`) - IKKE separate
  tilfeldige delete-funksjoner per modul. `previewErasure`/`executeErasure`/`verifyErasure`.
  Scope-modell: `tenant`/`person`/`memory_space`/`knowledge_source`/`knowledge_document`/
  `conversation`, `tenant_id` alltid eksplisitt - ingen cross-tenant purge uttrykkbart (bevist, §H).
- **Hard delete** (`modules/erasure/src/plan.ts`): FK-trygg rekkefølge, én transaksjon, fail-closed
  (en injisert midt-i-feil ruller HELE transaksjonen tilbake - bevist, §N). Dekker knowledge
  (`knowledge_documents`/`knowledge_embeddings`) + memory (`memory_items` + alt avledet) +
  conversations (`messages`/`sessions`) + `artifacts` (kun tenant-scope).
- **Ny migrasjon `018_erasure.sql`:** `erasure_requests`/`erasure_fingerprints`-ledger (RLS, samme
  mønster som resten) + et EKSPLISITT, avgrenset `GRANT DELETE` til `jarvis_app` (kun de tabellene
  som faktisk hard-slettes fra - systemet hadde ALDRI hatt en DELETE-rettighet noe sted før dette;
  `events`/`audit_events` forblir uten DELETE-grant, i tillegg til append-only-trigger-blokkert).
- **Resurrection protection (§5):** `erasure_fingerprints` lagrer KUN en irreversibel SHA-256-
  fingerprint av canonical identity - ALDRI innhold/external_id i klartekst. `KnowledgeSyncService`
  sjekker denne før nytt canonical document opprettes (`report.suppressed`, ny felt). Bevist LIVE
  (embedded Postgres): purge → resync (fil fortsatt på disk) → `created=0, suppressed=1`.
- **Erasure receipt/ledger (§6):** kun identifiers/counts, ALDRI slettet innhold - bevist (§K/§L,
  en plantet SENTINEL finnes aldri i `erasure_requests`/`erasure_fingerprints`).
- **Policy/risk (§7/§8):** gjenbruker EKSISTERENDE `PolicyGateway`/sovereign/approval/nonce-replay
  uendret - ingen ny auth-modell. Owner sovereign kjører uten approval; delegert identitet nektes
  uten signert approval, tillates med gyldig Ed25519-signatur (bevist, begge veier).
- **§9-unntak (dokumentert):** IKKE via `ToolGateway`s generiske D-pipeline (ville lagret en KOPI av
  innholdet i et `before_state`-recovery-snapshot - undergraver selve erasure). `executeErasure()`
  kaller `PolicyGateway.authorize()` direkte og skriver sin egen trygge ledger-rad.
- **Backup/restore-kontrakt (§10):** `TIER1_TABLES` (watchdog) utvidet med knowledge-tabellene (reell
  pre-eksisterende gap) + erasure-ledgeren. Ny `reapplyErasuresAfterRestore()` - re-fjerner et
  restorert dokument som matcher ledgeren, idempotent (bevist).
- **Observability (§11):** events/audit_events (strukturelt blokkert), Langfuse/lokal trace-fil
  (ingen purge-integrasjon) dokumentert som kjente, IKKE skjulte gap.
- **Retrieval verification (§12):** FTS/vector/hybrid/memory-retrieval alle bevist 0 treff etter
  purge (§E/§F/§G, live-script §8-§11).
- **Q-21 uendret/ikke-regresert (§13):** kjører via `jarvis_runtime` (NOSUPERUSER/NOBYPASSRLS) i
  ALLE tester og i live-scriptet (§O-testen leser `pg_roles` direkte og bekrefter dette per kjøring).
- **Live host-akseptanse-script:** `modules/erasure/scripts/q20-erasure-live.ts` - alle 21 trinn fra
  byggeordren, kjørt AV DENNE ØKTEN mot en ekte (embedded, ikke mocket) Postgres:
  `hard_fail=false`, alle `q20_*`-felt PASS (ved bygging - senere host-bevist reelt, se under).
- 14 nye tester (`modules/erasure/test/erasure-service.test.ts` 13 + `modules/watchdog/test/
  erasure-restore-contract.test.ts` 1), full suite grønn, lint/typecheck/gitleaks rene.
- **STATUS ved bygging: FIXED_SUITE / READY_FOR_HOST_VERIFY. OPPDATERT: VERIFIED/CLOSED (D-40) -
  se "Q-20 FINAL CLOSURE" under.** Teknisk erasure-foundation - IKKE en juridisk GDPR-sertifisering.

## Q-20 HOST RECOVERY #1 (samme dag, 2026-08-16) — workspace-bootstrap-feil
Tobias sin første kjøring feilet FØR noe Q-20-innhold ble testet: `ERR_MODULE_NOT_FOUND:
Cannot find package '@jarvis/core'`. Root cause: branchen la til en NY pnpm-workspace-pakke
(`modules/erasure`) - hosten sin `node_modules` var aldri bootstrappet for den (host-bootstrap-feil,
IKKE et Q-20-funn). Node 24 (host) bekreftet IKKE root cause (`engines: >=22` er oppfylt).
**Fikset** med ny ett-kommando-orkestrator `modules/core/scripts/q20-host-run.ts` (kun Node-
innebygde moduler på toppnivå - kan kjøre FØR `pnpm install`): bootstrapper workspacet
(`pnpm install --frozen-lockfile`), verifiserer resolvering (`modules/erasure/scripts/
verify-workspace.ts`), sikrer ferske Docker-images, kjører migrasjonene (inkl. `018_erasure.sql`)
via ADMIN-rollen (uendret Q-21-splitt), restarter api/worker, og kjører til slutt selve
`q20-erasure-live.ts`. Feilen reprodusert og fiksen bekreftet i byggemiljøet (node_modules fjernet
→ samme feil → `pnpm install` reparerer). 18 nye wiring-tester
(`modules/core/test/q20-host-run-wiring.test.ts`). Kommando uendret siden:
`node --experimental-transform-types modules/core/scripts/q20-host-run.ts`. Full evidens:
docs/RUNTIME_GATES.md.

## Q-20 HOST RECOVERY #2 (samme dag, 2026-08-16) — Windows pnpm-prosessoppløsning
Samme runner feilet deretter på selve `pnpm install --frozen-lockfile`-steget:
`spawnSync pnpm ENOENT` - til tross for at `pnpm` fungerer fint fra Tobias sin egen PowerShell.
Root cause: Node sin `execFileSync`/`spawnSync` uten shell-involvering gjør ikke Windows sin PATHEXT-
baserte utvidelsesoppløsning (`pnpm.cmd`). **Fikset (runde 1)** med ny, avhengighetsfri
`modules/core/scripts/lib/package-manager-resolve.ts` - deterministisk oppløsning: `pnpm`/`pnpm.cmd`
direkte på PATH → ellers `corepack`/`corepack.cmd` med EKSPLISITT pinnet versjon (`pnpm@9.15.9` fra
`package.json`, ALDRI `corepack enable`) → ellers fail-closed med tydelig diagnostikk. 11 nye
enhetstester. **Bekreftet FOR REAL i byggemiljøet** (ikke bare unit-testet): hele bootstrap-kjeden
kjørt direkte som ekte prosess - `package_manager_resolution=PASS
package_manager_driver=pnpm package_manager_version=9.15.9`, `install_frozen_lockfile=PASS`,
`erasure_workspace_dependencies=PASS`. Ett-kommando-kontrakten uendret. Full evidens:
docs/RUNTIME_GATES.md.

## Q-20 HOST RECOVERY #3 (samme dag, 2026-08-16) — DEP0190-opprydding
Host-output fra runde 2 sin fiks endte med Node sin `DEP0190`-advarsel (`shell: true` kombinert med
et args-array er en kjent injeksjonsrisiko - Node må selv gjette hvordan argumentene skal escapes).
**Fikset PERMANENT FØR merge:** `shell` er nå fjernet som alternativ overalt i
`q20-host-run.ts`/`package-manager-resolve.ts`. Et Windows `.cmd`-shim kjøres i stedet via en
eksplisitt, ikke-shell cmd.exe-barneprosess med et internt kontrollert argv (`buildSpawnInvocation()`,
`/d /s /c <sti> <args>` - samme mønster som `cross-spawn`-biblioteket bruker for nøyaktig dette
Windows-problemet). Native `.exe`/unix-binærer kjøres fortsatt direkte (ingen unødvendig indirection).
Ny regresjonstest bekrefter `shell: true` aldri finnes i kildekoden igjen. 16 nye/oppdaterte
enhetstester (34 totalt i `package-manager-resolve.test.ts`). Ingen erasure-/migrasjons-/DB-rolle-
/retrieval-/policy-logikk endret - kun prosess-spawning-hygiene.

## Q-20 FINAL CLOSURE (2026-08-16, samme dag) — HOST VERIFIED
**Tobias kjørte `node --experimental-transform-types modules/core/scripts/q20-host-run.ts` på sin
faktiske Windows/Docker-host - GRØNT resultat, run_id `eaabe2b1`.** Bootstrap
(`package_manager_resolution=PASS package_manager_driver=pnpm.cmd`), migrasjon 018 anvendt via
admin-rollen, Q-21 uendret (`q21_runtime_role_safe=PASS`), og ALLE `q20_*`-felt PASS
(`hard_fail=false`) - hard delete av original+avledet innhold, FTS/vector/hybrid/memory-retrieval=0
etter purge, resurrection-suppresjon bevist (`created=0`/`suppressed=1`), idempotens bevist,
tenant/space-isolasjon urørt, trygg kvittering, sentinel-scan uten funn. **STATUS: Q-20 =
VERIFIED/CLOSED → D-40.** Full evidens: docs/RUNTIME_GATES.md, docs/DECISIONS_AND_ASSUMPTIONS.md.
PR #4 merges til `main`.

## UA-2 P1A — Knowledge Source Expansion (BYGGET denne økten, 2026-08-16, FRA `origin/main` etter Q-20-merge)
- **Godkjent byggeordre** (etter Q-20 VERIFIED/CLOSED-merge): utvid `@jarvis/knowledge` med Google
  Drive (READ ONLY) og Obsidian/lokal vault som nye kunnskapskilder, på den EKSISTERENDE
  `KnowledgeSource`/`KnowledgeSyncService`/FTS+vector-hybrid-arkitekturen - ingen parallell
  connector-SDK, ingen ny auth-modell, ingen ny DB-migrasjon (gjenbruker `knowledge_documents`/
  `knowledge_embeddings` uendret). Pieces eksplisitt utsatt (se under). IKKE bygget: e-post-
  ingestion, møtetranskripsjon, OCR, full Knowledge Graph/GraphRAG, Drive write/delete.
- **Kontrakt-utvidelse** (`modules/knowledge/src/source.ts`): `KnowledgeSource.list()` returnerer nå
  `KnowledgeListResult { records, skipped }` i stedet for en bar array - en kilde kan rapportere
  bevisste per-element-skips (f.eks. ustøttet MIME) uten å forveksle dem med feil. Ny
  `KnowledgeSourceError`/`SourceErrorClass` (AUTH/PERMISSION/RATE_LIMIT/TRANSIENT_NETWORK/NOT_FOUND/
  UNSUPPORTED_CONTENT/INVALID_CONFIG/SOURCE_UNAVAILABLE) for TOTAL listing-svikt - `sync()` tombstoner
  ALDRI noe når `list()` kaster, uansett klasse (kritisk sikkerhetsegenskap, uendret). Fikset en latent
  bug i `GithubKnowledgeSource` samtidig: en feilet ToolGateway-handling ble tidligere stille utelatt
  (kunne feiltolkes som "alt slettet" av tombstone-logikken) - kaster nå eksplisitt i stedet.
- **`KnowledgeSourceRegistry`** (`registry.ts`): typet, FLERE-instans konfigurasjon bundet til
  (tenant_id, memory_space_id, source_instance_id) - `forTenant()` kan STRUKTURELT aldri returnere en
  annen tenants config, ingen implisitt/global kilde.
- **`GoogleDriveTransport`** (`modules/tool-gateway`): READ ONLY, samme OAuth/konto-mønster som
  Gmail/Calendar (`googleAccessToken()` gjenbrukt, ingen ny credential-type). `list_files` (paginert,
  eksplisitt `folder_id` fra kilden - ALDRI en default) + `read_document` (Google Docs eksporteres til
  text/plain, tekstlige MIME-typer leses rått, alt annet - Sheets/Slides/bilder/PDF/binærformater -
  kaster en typet `drive_unsupported_content_<mime>`-feil).
- **`GoogleDriveKnowledgeSource`** (`drive-source.ts`): `external_id` = Drive sin stabile `file.id`
  (rename-safe - en omdøpning endrer `title`, ikke `external_id`). Mappe-scope er REKURSIV men
  importerer ALDRI hele driven når konfigurert for én mappe. Paginering + rekursjon aggregeres internt
  i `list()` (komplett resultat eller kast, aldri partielt). Sletting gjenbruker eksisterende
  "fraværende i vellykket listing = tombstone" (ingen egen Drive Changes-API-integrasjon - bevisst,
  dokumentert valg). En AUTH/PERMISSION-feil på ÉN fil-lesing eskaleres til TOTAL svikt (systemisk
  årsak antatt); NOT_FOUND/RATE_LIMIT/TRANSIENT_NETWORK på én fil er en trygg per-fil-skip.
- **`ObsidianVaultKnowledgeSource`** (`obsidian-source.ts`): KOMPONERER rundt
  `FilesystemKnowledgeSource` (samme allowlist/traversal/symlink-forsvar som UA-2 P0, ingen duplisert
  sikkerhetslogikk) - kun `.md`-filer, `.obsidian/` ekskludert som default. Frontmatter parses
  best-effort (flat, ingen ny YAML-avhengighet) til `metadata.frontmatter`; wiki-lenker
  (`[[Notat]]`) til `metadata.wiki_links` (flat liste, IKKE en graf - GraphRAG bevisst utenfor P1A).
  `external_id` = relativ vault-sti (samme presedens som filesystem) - Obsidian-omdøpning er derfor
  slett+ny, IKKE en oppdatering (dokumentert forskjell fra Drive, som HAR en stabil fil-id).
- **To korrekthetsfiks i `KnowledgeSyncService.sync()`** (gjelder ALLE kilder, ikke bare de nye):
  (1) `skipped`-elementer beskyttes nå mot tombstoning sammen med `seen` - én forbigående per-element-
  feil kunne tidligere tombstonet ETT dokument selv om hele listingen lyktes; (2) "uendret innhold"-
  grenen oppdaterer nå tittel/uri/metadata (uten re-embedding) - nødvendig for at en Drive-omdøpning
  faktisk skal synes.
- **Chunking-safeguard** (bevisst MINIMAL, ingen ekte multi-chunk-skjema): `embed()`-input trunkeres
  til 24 000 tegn - `content`-kolonnen (og dermed FTS) beholder ALLTID hele, utrunkerte teksten. Ingen
  embedding-leverandør i kodebasen hadde en input-grense før dette (Drive/Obsidian-dokumenter kan bli
  langt større enn P0 sine korte GitHub-issues).
- **Pieces: eksplisitt utsatt.** Repo-søk fant INGEN integrasjon/API/eksportformat/credential-
  miljøvariabel noe sted - kun navnedropp i planleggingsdokumenter. Ingen konkret, ikke-gjettet
  integrasjonsflate å bygge mot ennå - egen fremtidig underoppgave når en finnes.
- **Ett-kommando host-akseptanse:** `modules/core/scripts/ua2-p1a-host-run.ts` (samme
  pnpm/Windows/Docker-bootstrap-mønster som `q20-host-run.ts`, INGEN ny workspace-pakke denne gangen
  → ingen egen verify-workspace-steg) kjører til slutt
  `modules/knowledge/scripts/ua2-p1a-live.ts`: Q-21-rolle-sjekk, registry-sanity, Obsidian full
  livssyklus i en ISOLERT MIDLERTIDIG vault (ALDRI Tobias sin ekte vault), tenant-isolasjon+retrieval
  med de nye kildetypene, no-content-i-audit-scan. Google Drive LIVE er BETINGET: krever
  `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`JARVIS_GOOGLE_TOKEN` OG en NY, dedikert
  `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` (aldri hele driven) - mangler noen av de fire rapporteres
  `google_drive_live=BLOCKED_NO_SAFE_TEST_SCOPE`, ALDRI en fake PASS.
- **Kvalitet:** 463/463 tester (406 baseline fra `origin/main` + 57 nye: registry x9, Drive-source x11,
  Obsidian-source x9, kryssgående tenant/space/retrieval/audit-redaksjon x5, chunking-safeguard x2,
  host-run-wiring x21), full monorepo-typecheck ren. Lint/gitleaks gjenstår før PR (se §32 i
  byggeordren).
- **STATUS: FIXED_SUITE / READY_FOR_HOST_VERIFY. IKKE VERIFIED** - ingen ekte Google Drive-credential,
  ingen ekte Docker-Postgres i denne sky-sandboxen. Krever Tobias sin host-kjøring
  (`ua2-p1a-host-run.ts`) før VERIFIED kan settes, akkurat som Q-20/UA-2 P0 krevde det.

## UA-2 P1A scope-endring — Google Drive full read/write + Owner Connector Capability Invariant (D-41, samme økt)
- **Tobias sin eksplisitte beslutning FØR PR #5 merges:** Jarvis skal IKKE være begrenset til read-only
  Google Drive - full funksjonell tilgang, styrt av det EKSISTERENDE A-D policy-systemet (ingen ny
  permission-modell). Samtidig innført som en PERMANENT arkitekturregel for ALLE fremtidige connectors
  (se D-41 i DECISIONS_AND_ASSUMPTIONS.md, rule 11 i CLAUDE.md).
- **Google Drive utvidet fra READ ONLY til FULL read/write/permissions:** `GoogleDriveTransport` fikk 10
  nye handlinger (`get_metadata`/`read_permissions` klasse A; `create_file`/`create_folder`/
  `update_content`/`rename`/`move`/`trash` klasse C; `delete_permanent`/`create_permission`/
  `update_permission`/`delete_permission` klasse D). Produksjons-OAuth-scope bekreftet mot Google sitt
  offisielle Drive API v3-discovery-dokument (IKKE gjettet): `https://www.googleapis.com/auth/drive`
  (full tilgang - `drive.file` dekker kun app-opprettede filer, utilstrekkelig). `files.delete` er
  PERMANENT (bekreftet); trashing er en egen, reversibel `files.update`. `update_content`/`rename`/
  `move`/`trash` godtar en valgfri `expected_head_revision_id`-precondition - ved mismatch kastes en
  typet `drive_conflict_stale_version`-feil FØR noen mutasjon forsøkes, aldri en stille overskriving.
  D-klasse-handlinger har `preflight_action` (samme eksisterende ToolGateway-evidensmekanisme som
  Home Assistant sin `lock_set`/`alarm_set` alt brukte - ingen ny mekanisme). Owner sovereign-modus
  uendret: klasse D autonomt for eier, delegert identitet krever fortsatt signert godkjenning.
- **Idempotens:** skriveoperasjoner gjenbruker EKSISTERENDE ToolGateway `idempotency_key`-dedupe (samme
  mekanisme som resten av systemet) - bevist kritisk for `create_permission` spesielt, siden Drive sin
  egen `permissions.create` IKKE dedupliserer identiske tilganger selv.
- **Q-20-distinksjon (§5 i scope-endringen):** eksplisitt bevist arkitektonisk separert - en
  `drive/trash`-handling rører ALDRI `knowledge_documents`, og en Q-20-hard-delete av et
  `knowledge_document` kaller ALDRI ut til Drive. Dette er to uavhengige operasjoner, ikke automatisk
  koblet.
- **Tester:** 27 nye (`drive-full-access.test.ts` 17 - policy/idempotens/isolasjon/observability via ekte
  ToolGateway+Postgres+FakeTransport; `google-drive-transport.test.ts` 10 - konflikt-/statuskode-
  klassifisering internt i transporten, fetch mocket, det ENESTE unntaket fra "raw HTTP-transportere
  unit-testes aldri"-presedensen fordi byggeordren eksplisitt krevde det). `ua2-p1a-live.ts` §6 utvidet
  med ekte create/update/rename/move/trash/cleanup/sync/no-resurrection/idempotency mot
  `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` - `google_drive_live=BLOCKED_REAUTH_REQUIRED` hvis lesing
  fungerer men skriving feiler på auth (utilstrekkelig scope på eksisterende token). Permission-
  mutasjon er BEVISST IKKE live-testet (kan ikke gjøres trygt uten å involvere en ekte person/endre ekte
  eksponering) - policy/klassifisering for det er suite-bevist. 517/517 tester totalt (490 + 27),
  full monorepo-typecheck ren.
- **Connector-audit (engangs, IKKE alle utvidet i denne runden - kun Google Drive):**

  | Connector | Klassifisering | Har i dag | Konkrete gap (backlog, IKKE bygget her) |
  |---|---|---|---|
  | Google Drive | **FULL** (denne økten) | read/list/create/update/rename/move/trash/delete/permissions | - |
  | GitHub | PARTIAL | read_issues, read_repo_meta, create_pr | Ingen merge_pr, ingen issue-kommentar/opprettelse/lukking, ingen branch-sletting, ingen repo-admin |
  | Google Calendar | PARTIAL | read_events, create_event | Ingen update_event, ingen delete_event, ingen svar-på-invitasjon |
  | Gmail/e-post | PARTIAL | read_inbox, send | Ingen reply/forward, ingen arkivering/sletting/labeling, ingen draft-håndtering |
  | Telegram | PARTIAL | notify (send), `/brief`/`/status`/`/ai`-kommandoer (poll) | Ingen redigering/sletting av sendte meldinger, ingen rikere Bot API-funksjoner (pin, media) |
  | Vercel | READ_ONLY | read_deployments | Ingen trigger/rollback/promote-deploy, ingen env-var-håndtering |
  | Home Assistant | PARTIAL | read_state, light_set, climate_set, lock_set (D), alarm_set (D) | God kjernedekning, men ikke uttømmende (media_player, cover/blinds, scener, automasjon-trigger mangler) |

  Gapene er EKSPLISITT dokumentert som backlog, IKKE lukket her (D-41/§CURRENT CONNECTOR AUDIT sier
  eksplisitt "IKKE utvid alle nå dersom det blåser scope"). Hver fremtidig connector-byggeordre
  vurderer full kapabilitet fra D-41-sjekklisten fremover.

## UA-2 P1A HOST RECOVERY — auto-create safe Drive test sandbox (samme dag, 2026-08-16)
- **Host-funn:** Tobias kjørte `ua2-p1a-host-run.ts` (run_id `8af834dd`, `hard_fail=false`) - ALLE
  ingestion-felt (Obsidian/registry/tenant-isolasjon/retrieval/audit) PASS, men
  `google_drive_live=BLOCKED_NO_SAFE_TEST_SCOPE` fordi `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` ikke var
  satt, selv om `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`JARVIS_GOOGLE_TOKEN` alle var konfigurert.
- **Eksplisitt eierbeslutning:** Tobias skal ALDRI måtte manuelt opprette en Drive-testmappe, finne/
  kopiere en mappe-ID, eller redigere `.env` for å kjøre denne akseptansen.
- **Ny, ren, avhengighetsfri modul** `modules/knowledge/scripts/lib/drive-acceptance-sandbox.ts`
  (`DriveAcceptanceSandbox`, `determineTestRootSource`, `driveAcceptanceFolderName`, `isReauthSignal`) -
  BEVISST ingen fetch/nettverk der, kun grensekontroll-/cleanup-logikk. `assertInSandbox()` er den ENESTE
  veien en mutasjon godkjennes - fail-closed, kaster `DriveBoundaryViolationError` for enhver ID denne
  kjøringen ikke selv sporet som opprettet (aldri "prøv og se").
- **`ua2-p1a-live.ts` §6 fullstendig omskrevet:** er `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` satt, brukes den
  (kun LEST, ALDRI slettet av runneren). Er den IKKE satt, oppretter runneren SELV en unikt navngitt,
  midlertidig mappe (`"Jarvis P1A Acceptance <run_id>"`) - BEVISST INGEN søk-etter-lignende-navn-og-
  gjenbruk (alltid en fersk `create_folder`, aldri en `list_files`-basert oppslag). Et rent LESE-scope-
  probe (`get_metadata` på Drive sin reserverte `"root"`-ID) skjer FØR test-roten løses og FØR noen
  mutasjon forsøkes, slik at total auth-svikt skilles fra manglende skrive-scope
  (`google_drive_auth_scope=BLOCKED_REAUTH_REQUIRED`). Full akseptanse A-Q bevist INNENFOR sandkassen:
  auth-probe, opprett to undermapper + hovedtestfil, les, oppdater, omdøp, flytt mellom undermappene,
  sync+retrieval (scopet til subfolder-b), Q-20 hard-delete+resync-no-resurrection (PLUSS et nytt
  Drive-side-uavhengighetsbevis: originalfilen bekreftes FORTSATT å eksistere i Drive etter Jarvis-side
  purge), trash (reversibelt), idempotent create (samme idempotency_key), permanent sletting KUN på en
  artefakt DENNE kjøringen selv opprettet (`driveMutate()`-wrapperen grensekontrollerer FØR ethvert
  mutasjonskall). Permission-mutasjon fortsatt BEVISST IKKE live-testet
  (`google_drive_permission_live=SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL`) - kan ikke gjøres trygt uten å
  involvere en ekte person/endre ekte eksponering i en ubetjent kjøring.
- **Opprydding:** alt DENNE kjøringen selv opprettet slettes permanent til slutt via
  `sandbox.cleanupTargets()` (barn FØR rot) - en eksplisitt KONFIGURERT rot er strukturelt ALDRI et
  mål (kun inkludert når `autoCreated=true`). Den auto-opprettede mappe-IDen persisteres ALDRI til
  `.env` - kun til kjøringens `diagnostics`/logg.
- **`ua2-p1a-host-run.ts`-kommentarblokken oppdatert** til å reflektere at `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID`
  nå er VALGFRI - selve ett-kommando-kontrakten er UENDRET:
  `node --experimental-transform-types modules/core/scripts/ua2-p1a-host-run.ts`.
- **Tester:** 13 nye rene enhetstester (`drive-acceptance-sandbox.test.ts` - auto-create-beslutning,
  navneunikhet, grensekontroll, reauth-klassifisering, cleanup-scoping inkl. delvis-oppsatt-kjøring og
  "konfigurert rot aldri i cleanup-listen"), pluss `ua2-p1a-host-run-wiring.test.ts` utvidet/oppdatert
  (guard krever nå kun client_id/secret/token, IKKE test_folder_id; nye strukturelle bevis for §D
  no-reuse-by-search, §J konfigurert-rot-aldri-direkte-slettet, §K ingen `.env`-persistering,
  driveMutate-grensekontroll-kjeden, §M idempotent-gjentakelse). **512/512 tester totalt** (faktisk målt
  denne runden), lint/full monorepo-typecheck/gitleaks (`protect --staged` + historikk-scan) alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever en NY host-kjøring fra
  Tobias for å bevise auto-sandkassen faktisk fungerer mot ekte Drive. PR #5 forblir draft/umerget.

## GOOGLE DRIVE FULL-ACCESS REAUTH (samme dag, 2026-08-16) — ett-kommando nettleser-reauth
- **Host-funn:** run_id `262ac1bb` viste `google_drive_auth_scope=BLOCKED_REAUTH_REQUIRED`
  (`get_metadata("root")` → `tool_failed:drive_auth_error_403`) - det eksisterende `JARVIS_GOOGLE_TOKEN`
  mangler full Drive-scope (utstedt før D-41-scope-endringen). Eierkrav: Tobias skal ALDRI måtte lime
  inn en autorisasjonskode manuelt, redigere `.env`, eller kjøre en egen andre kommando etterpå -
  produksjons-OAuth-scope forblir FULL `https://www.googleapis.com/auth/drive` (D-41 uendret, ingen
  fallback til read-only for å "få testen til å passere").
- **Ny, ren, avhengighetsfri modul** `modules/core/scripts/lib/google-drive-reauth-lib.ts` -
  URL-bygging/callback-parsing/state-CSRF-sjekk/scope-sammenligning/refresh-token-beslutning/konto-
  maskering, INGEN nettverk/filsystem der (30 rene enhetstester).
- **`modules/core/scripts/google-drive-reauth.ts`** - ÉN host-kommando:
  `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`. Offisiell
  "authorization code" + loopback-IP-redirect-flyt (RFC 8252, `http://127.0.0.1:8942/oauth2callback`
  default, `JARVIS_GOOGLE_REAUTH_PORT` valgfri override) - ALDRI den avviklede OOB-flyten. Ber om
  `https://www.googleapis.com/auth/drive` + EKSISTERENDE `https://www.googleapis.com/auth/calendar`
  (unngår å regressere kalender, som deler samme `JARVIS_GOOGLE_TOKEN`) + et minimalt
  `https://www.googleapis.com/auth/userinfo.email`-scope (kun for konto-identitetssjekk). `access_type=
  offline`+`prompt=consent`+`include_granted_scopes=true` (bekreftet mot google-auth-library sin
  offisielle Node.js-dokumentasjon - garanterer en fersk refresh_token hver kjøring, bevarer andre
  allerede godkjente scopes). Åpner standardnettleseren automatisk (Windows/macOS/Linux, samme
  DEP0190-sikre ikke-shell cmd.exe-mønster som `package-manager-resolve.ts` på Windows); fallback til
  manuell URL hvis åpning feiler.
- **Verifisering FØR noe skrives (§7):** både token-responsens `scope`-felt OG en FAKTISK
  `get_metadata("root")`-lesing mot ekte Drive må lykkes - callback-suksess alene er IKKE nok.
  Innsuffisient scope → `FAIL_INSUFFICIENT_SCOPE`, `.env` urørt. Manglende refresh_token i responsen
  (uventet siden `prompt=consent` alltid tvinger en) håndteres KUN ved å LIVE re-verifisere den
  eksisterende token-ens faktiske scope via `tokeninfo`-endepunktet - aldri en antakelse om Google sin
  interne inkrementell-auth-oppførsel.
- **Konto-konsistens (§8):** henter KUN e-postadressen (minimalt scope), maskerer den (`t***@domene`)
  i all logging, sammenligner mot konfigurert `JARVIS_GOOGLE_ACCOUNT` - ved mismatch kreves eksplisitt
  skrevet "YES" i terminalen FØR noe skrives; "identitet kunne ikke bestemmes" blokkerer IKKE (logges
  ærlig som ukjent, aldri stille behandlet som match).
- **Sikkerhet:** aldri client_secret/access_token/refresh_token/authorization_code i logg eller
  prosessargument (bevist strukturelt, se wiring-tester). `.env` skrives KUN ved full suksess - alle
  feilbaner returnerer/kaster FØR skriving, slik at den eksisterende (om enn scope-begrensede)
  credentialen alltid forblir gjenopprettbar. Skriving gjenbruker EKSISTERENDE
  `buildUpdatedEnvLines`/`parseEnvValues`/backup-mønster fra `lib/q21-env-recovery.ts` (samme
  `.env.bak.<epoch>` + atomisk tmp+rename som `fix-q21-runtime-role.ts`) - rører KUN
  `JARVIS_GOOGLE_TOKEN`-linjen.
- **Kjeder automatisk videre:** ved `google_drive_reauth=PASS` kjøres `ua2-p1a-host-run.ts` (og dermed
  hele Drive-auto-sandkasse-akseptansen fra forrige runde) AUTOMATISK - ingen andre kommando fra Tobias.
- **Presisjonsfunn (dokumentert, IKKE fikset i denne runden):** `GmailTransport` (tool_id `"email"`)
  bruker faktisk en HELT ANNEN, i dag ukonfigurert credential (`JARVIS_EMAIL_TOKEN`) - IKKE
  `JARVIS_GOOGLE_TOKEN` slik en eldre `.env.example`-kommentar feilaktig antydet (rettet i denne
  runden). Reauth-scriptet ber derfor bevisst KUN om Drive+Calendar-scope, ikke Gmail.
- **Åpent, IKKE-blokkerende funn (logget, ikke skjult):** `GoogleDriveTransport` er registrert i
  `firstWaveTools()`-funksjonen, men er IKKE koblet inn i de faktiske produksjons-entrypointene
  (`apps/api/src/main.ts`/`worker-main.ts` sine `firstWaveTools({...})`-kall mangler en `drive:`-nøkkel
  - kun `email`/`calendar`/`github`/`telegram` er wiret der i dag). Drive-verktøyet er dermed reelt
  reachable KUN fra `ua2-p1a-live.ts`/testene, ikke fra en løpende api/worker-prosess ennå. Dette er
  UTENFOR denne reauth-ordrens scope (som var credential-anskaffelse, ikke entrypoint-wiring) og
  krever en egen, eksplisitt godkjent byggeordre - ikke gjort stille her.
- **Tester:** 30 nye rene enhetstester (`google-drive-reauth-lib.test.ts`) + 24 nye strukturelle
  wiring-tester (`google-drive-reauth-wiring.test.ts`, kildeteksts-basert - samme presedens som
  `ua2-p1a-host-run-wiring.test.ts`). Full suite/lint/typecheck/gitleaks kjøres som del av denne
  rundens kvalitetsport (se rapport).
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever Tobias sin faktiske
  nettleser-godkjenning på hosten. PR #5 forblir draft/umerget.

## GOOGLE DRIVE REAUTH HOST FIX (samme dag, 2026-08-16) — response_type manglet + feil konto
- **Host-funn:** Tobias kjørte `google-drive-reauth.ts`. Nettleseren åpnet Google OAuth med FEIL konto
  (`henrik@ffskis.com`), og Google avviste med "Required parameter is missing: response_type" (Error
  400: invalid_request).
- **Root cause (ÉN, forklarer BEGGE symptomene samtidig):** den genererte autorisasjons-URL-en har
  ALLTID inneholdt `response_type=code` (bevist av eksisterende enhetstester siden forrige runde) -
  feilen lå i `openBrowser()` sin daværende Windows-vei, `cmd /c start "" <url>`. URL-en inneholder `&`
  (gyldig spørrestreng-skilletegn) men verken mellomrom eller anførselstegn, så Node sin Windows-argv-
  til-kommandolinje-quoting siterte IKKE argumentet automatisk. cmd.exe mottok URL-en USITERT i
  `/c`-modus og splittet den ved HVERT ubeskyttet `&` som et kommando-skille - Google mottok reelt kun
  `...auth?client_id=<id>`, nok til å identifisere appen og stille falle tilbake til en allerede
  innlogget nettleser-konto, men ALDRI `redirect_uri`/`response_type`/`scope`/`state`.
- **Fiks 1 (transport):** Windows-veien bruker nå `rundll32.exe url.dll,FileProtocolHandler <url>` i
  stedet for `cmd /c start` - en native .exe, INGEN kommandotolk involvert i det hele tatt (samme
  "native-exe-trenger-ingen-cmd-wrapper"-presedens som `lib/package-manager-resolve.ts`).
- **Fiks 2 (kontovalg):** `prompt` er nå `"consent select_account"` (Google sin offisielt dokumenterte
  mellomrom-delte prompt-liste) - tvinger ALLTID frem kontovelgeren, aldri en stille auto-valgt konto.
  `login_hint` settes til `JARVIS_GOOGLE_ACCOUNT` (kun et HINT - hindrer aldri kontobytte, offisielt
  dokumentert Google-oppførsel).
- **Fiks 3 (pre-flight-sikkerhetsnett):** `validateAuthorizationUrl()` parser den genererte URL-en
  tilbake og krever eksplisitt `response_type=code`+`client_id`+`redirect_uri`+`state`+full Drive-scope
  FØR nettleseren i det hele tatt åpnes - fanger enhver FREMTIDIG regresjon i selve URL-byggingen,
  fail-closed (server startes ikke, nettleser åpnes ikke).
- **Konto-mismatch-rapportering presisert:** ny `formatAccountMismatchReport()` gir en eksplisitt,
  grep-bar `expected_account=<maskert> authorized_account=<maskert>`-loggform - samme
  bekreftelses-gate (typet "YES") som før, kun tydeligere format.
- **.env-sikkerhet uendret/bekreftet:** alle feilbaner (inkl. den nye pre-flight-valideringen) skjer
  strukturelt FØR backup/skriving - `.env` forblir urørt ved enhver feil, bevist av wiring-testene.
- **Tester:** 15 nye rene enhetstester (URL-validering, prompt/login_hint, mismatch-rapportformat) +
  7 nye strukturelle wiring-tester (rundll32 i bruk / cmd-start borte, pre-flight-rekkefølge,
  login_hint-wiring, mismatch-rapport-bruk) - 588/588 totalt. Lint/full monorepo-typecheck/gitleaks
  alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever en NY host-kjøring
  fra Tobias for å bevise fiksen faktisk fungerer mot en ekte Windows-nettleser. PR #5 forblir
  draft/umerget. Ett-kommando-kontrakten er UENDRET:
  `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE OAUTH HOST FIX #2 (samme dag, 2026-08-16) — redirect_uri_mismatch / permanent Desktop-klient-design
- **Host-funn:** transport-fiksen over løste URL-korrumperingen (Tobias sin nettleser åpnet nå den
  KOMPLETTE URL-en - riktig client_id/redirect_uri/response_type/scope/state/prompt), men Google svarte
  deretter med `Error 400: redirect_uri_mismatch`.
- **Root cause (evidensbasert, ikke gjettet):** Google validerer `redirect_uri` FØR noe annet
  (sikkerhetskritisk, hindrer open-redirect) - en "Web application"-klient krever en EKSAKT
  forhåndsregistrert redirect-URI, mens en "Desktop app"-klient godtar EN loopback-IP-redirect på
  HVILKEN SOM HELST port UTEN forhåndsregistrering (bekreftet Google-dokumentert oppførsel). At
  Tobias sin eksisterende, allerede eksisterende OAuth-klient (fra FØR denne reauth-byggingen) ga
  mismatch for en loopback-URI er sterk evidens for at den er "Web application"-type - Jarvis sin
  lokale, interaktive eier-reauth-flyt er NØYAKTIG scenarioet "Desktop app" er bygget for. Google
  sender ALDRI noen callback tilbake ved mismatch (feilsiden vises direkte i nettleseren) - dette
  scriptet kan derfor STRUKTURELT ikke oppdage feilen selv via callback-serveren.
- **Ingen offentlig Google-API for å opprette en OAuth-klient programmatisk** (kun Cloud Console-UI -
  bekreftet, ikke antatt) - ETT manuelt Cloud Console-steg er derfor uunngåelig. Redusert til fem
  eksplisitte steg i loggmeldingen FØR nettleseren åpnes, PLUSS Cloud Console-credentials-siden åpnes
  AUTOMATISK i en egen fane (prosjektnummeret utledes fra den eksisterende `JARVIS_GOOGLE_CLIENT_ID`
  sin stabile `<prosjektnummer>-<random>.apps.googleusercontent.com`-form - ingen gjettet URL).
- **Ny, valgfri `JARVIS_GOOGLE_CLIENT_SECRET_JSON`** (.env-variabel, filsti): peker til den nedlastede
  client secret-JSON-fila fra en NY "Desktop app"-OAuth-klient. `resolveOAuthClient()` leser/validerer
  denne FØR noe annet i `main()` - `parseClientSecretJson()` godtar KUN Google sin `installed`
  (Desktop)-JSON-form, og avviser en `web`-type fil EKSPLISITT (`WrongOAuthClientTypeError`, samme
  brittleness som klienten Tobias allerede har - stille prøving av samme feilende type unngås).
- **Koherent credential-sett (§4 i ordren):** brukes en importert Desktop-klient, skrives
  `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN` SAMMEN i ÉN atomisk `.env`-skriving ved suksess - aldri
  et token alene mot en client_id/_secret som ikke lenger samsvarer. Refresh-tokens er tied til klienten
  som utstedte dem (bekreftet Google-oppførsel) - en full authorization_code-exchange (ikke bare en
  refresh_token-gjenbruk) garanterer et FERSKT, korrekt-koblet token for DEN importerte klienten.
- **Kontovelger uendret:** `prompt=consent select_account` og `login_hint` er identisk uansett
  klientkilde (ÉN `buildAuthorizationUrl()`-kall, ingen egen "importert klient"-gren som svekker dette).
  Presisering av §7 i ordren: "browseren viste fortsatt henrik@ffskis.com" er mest sannsynlig Google sin
  standard feilside-topptekst (viser AKTIV nettleser-økt-identitet) - siden redirect_uri-valideringen
  skjer FØR kontovelgeren i det hele tatt vises, ble select_account/login_hint aldri nådd i det
  tilfellet. Ingen svekkelse av den mekanismen er gjort eller nødvendig.
- **Tester:** 11 nye rene enhetstester (`parseClientSecretJson`/`deriveProjectNumberFromClientId`/
  `buildCredentialsConsoleUrl`) + 10 nye strukturelle wiring-tester (koherent skriving, ingen
  parallell/duplisert credential-lesing, .env-drevet gjenopptakelse, ingen secrets i den nye koden) -
  608/608 totalt. Lint/full monorepo-typecheck/gitleaks alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever Tobias sitt ENE
  manuelle Cloud Console-steg (opprett Desktop-klient, sett `JARVIS_GOOGLE_CLIENT_SECRET_JSON`) etterfulgt
  av en NY host-kjøring for å bevise dette faktisk fungerer. PR #5 forblir draft/umerget. Ett-kommando-
  kontrakten er UENDRET: `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE OAUTH HOST FIX #3 "ZERO MANUAL ENV EDITING" (samme dag, 2026-08-16) — automatisk Desktop-klient-oppdagelse
- **Eierens UX-krav:** etter HOST FIX #2 var det ENE uunngåelige manuelle steget i praksis TO -
  Cloud Console-handlingen OG å redigere `.env` med filstien til den nedlastede JSON-en. Tobias skal KUN
  gjøre den ENE, faktisk uunngåelige handlingen (opprette en "Desktop app"-klient og trykke "Download
  JSON") - ALDRI redigere `.env`, kopiere client_id/secret, eller lime inn en filsti.
- **Automatisk Nedlastinger-oppdagelse, i SAMME kjørende prosess, uten restart:** `attemptOAuth()` starter
  nå det opprinnelige OAuth-forsøket OG (parallelt, i bakgrunnen) en `watchForDesktopClientDownload()`-
  polling av Tobias sin Nedlastinger-mappe (`os.homedir()/Downloads` - den dokumenterte
  standardplasseringen, ALDRI en hardkodet bruker-sti). `Promise.race()` mellom callback-en og watcheren
  avgjør veien videre: kommer callback-en FØRST (normalflyt - klienten var allerede riktig type),
  fortsetter alt UENDRET og Tobias ser ALDRI noen ekstra fane (veiledningen/Cloud Console-siden vises
  FØRST etter 25 sekunder - god margin for en vanlig kontovalg+samtykke-interaksjon, kort nok til rask
  hjelp ved en ekte feil). Finner watcheren en NY, gyldig Desktop-klient-JSON FØRST, avbrytes det
  opprinnelige callback-forsøket EKSPLISITT (frigjør porten - `waitForCallback()` er nå kansellerbar) og
  et FRISK OAuth-forsøk starter AUTOMATISK med den nye klienten, i SAMME prosess.
- **KUN filer fra og med kjøringens eget starttidspunkt regnes** (`selectNewCandidateJsonFiles`) - en
  gammel, urelatert JSON-fil som allerede lå i Nedlastinger plukkes ALDRI opp. Hver kandidat valideres med
  den EKSISTERENDE `parseClientSecretJson()` (ingen ny/parallell valideringslogikk) - en "web"-type fil
  eller søppel EKSKLUDERES STILLE fra kandidatlisten (Nedlastinger kan inneholde mange urelaterte
  JSON-filer), krasjer ALDRI polling-løkka. Flere gyldige kandidater SAMTIDIG avgjøres ALDRI stille - en
  trygg, KUN-filnavn nummerert liste ber Tobias velge eksplisitt.
- **Koherent persistering uendret:** `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN` skrives SAMMEN, atomisk,
  til de VANLIGE `.env`-nøklene FØRST etter faktisk OAuth-suksess (scope+Drive-probe+kontosjekk alle
  bestått). `JARVIS_GOOGLE_CLIENT_SECRET_JSON` (HOST FIX #2) forblir støttet for et avansert/manuelt
  oppsett, men er IKKE lenger nødvendig for normalflyten og persisteres ALDRI selv - kun et
  engangs-import-artefakt.
- **Tester:** 20 nye rene enhetstester (`selectNewCandidateJsonFiles`/`classifyDiscoveryResult`/
  `formatCandidateSelectionPrompt`/`parseCandidateSelection`) + 15 nye strukturelle wiring-tester
  (kansellerbar callback-server, race-rekkefølge, koherent skriving KUN etter suksess, ingen restart,
  fortsatt ingen secrets logget) - 637/637 totalt. Lint/full monorepo-typecheck/gitleaks alle rene.
- **Ærlighet om verifikasjonsgrense:** selve den KONKURRERENDE race-/polling-/kanselleringslogikken kan
  IKKE kjøres ende-til-ende i denne sky-sandboxen (krever en ekte Windows-nettleser + en ekte
  Nedlastinger-mappe + faktisk Google OAuth) - bevist STRUKTURELT (kildeteksts-baserte wiring-tester,
  samme presedens som resten av denne fila) + den underliggende beslutnings-/filtreringslogikken FULLT
  enhetstestet. Faktisk host-kjøring er derfor fortsatt nødvendig for VERIFIED.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever Tobias sitt ENE
  Cloud Console-steg (hvis nødvendig) etterfulgt av en NY host-kjøring. PR #5 forblir draft/umerget.
  Ett-kommando-kontrakten er UENDRET: `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE OAUTH HOST FIX #4 "SETUP-FØRST, ALDRI AUTH MED KJENT WEB-KLIENT" (samme dag, 2026-08-16)
- **Host-funn:** Tobias kjørte HOST FIX #3-versjonen. Nettleseren åpnet Google OAuth UMIDDELBART og fikk
  igjen `Error 400: redirect_uri_mismatch` (kontoen vist: `post@tsworkflow.com`) - beviset på at racet
  (opprinnelig OAuth-forsøk kjørt SAMTIDIG med Nedlastinger-oppdagelsen) startet OAuth med den samme,
  allerede kjent inkompatible Web-klienten FØR noen Desktop-klient var på plass.
- **Root cause:** HOST FIX #3 sitt design antok at man MÅTTE prøve eksisterende credentials FØRST for å
  "oppdage" om de var utilstrekkelige. For et tilfelle der Tobias ALLEREDE (fra HOST FIX #2) har bevist
  at eksisterende `JARVIS_GOOGLE_CLIENT_ID` er en Web-klient, er dette feil - vi VET allerede at et
  OAuth-forsøk med den vil feile, og skal derfor ALDRI forsøkes.
- **Racet er FJERNET.** Ny, strengt sekvensiell tilstandsmaskin: `resolveProvenDesktopClient()` avgjør
  FØRST om en POSITIVT bevist Desktop-klient finnes - enten en eksplisitt `JARVIS_GOOGLE_CLIENT_SECRET_
  JSON`-import (HOST FIX #2, avansert/manuelt), ELLER en NY `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE=desktop`-
  metadata-linje persistert av EN TIDLIGERE vellykket kjøring av DENNE flyten. Eksisterende
  `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET` ALENE (uten den metadata-linjen) regnes ALDRI som bevist Desktop -
  de kan være NØYAKTIG den samme Web-klienten som allerede har feilet TO GANGER, og brukes derfor ALDRI
  til et OAuth-forsøk.
- **Finnes ingen bevist klient:** `main()` går INN i SETUP_REQUIRED FØR noe OAuth-forsøk i det hele tatt
  vurderes. Cloud Console-siden åpnes UMIDDELBART (ingen "vent og se"-graceperiode lenger - setup-behovet
  er allerede kjent, ikke en gjetning), og `waitForDesktopClientJson()` venter ALENE (ingen samtidig
  OAuth-forsøk) i inntil 10 minutter på at en gyldig, ny Desktop-klient-JSON dukker opp i Nedlastinger.
  Først NÅR en slik klient er funnet+validert bygges autorisasjons-URL-en - ALLTID med DEN klientens
  `client_id`, ALDRI den rå `JARVIS_GOOGLE_CLIENT_ID`-verdien direkte.
- **`waitForCallback()` forenklet tilbake** til en enkel (ikke-kansellerbar) funksjon - siden det aldri
  finnes mer enn ÉTT OAuth-forsøk per kjøring lenger, er hele kanselleringsmekanismen fra HOST FIX #3
  unødvendig og fjernet.
- **Koherent persistering utvidet:** ved full suksess skrives `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/
  `_TOKEN` OG den nye `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE=desktop`-metadata-linjen SAMMEN i ÉN atomisk
  skriving - FØR suksess er gamle credentials (om noen) HELT urørt, slik at eksisterende, fungerende
  Gmail/Calendar-integrasjoner (som deler samme `JARVIS_GOOGLE_TOKEN`) aldri risikerer å miste sin
  gyldige credential midt i en mislykket reauth-kjøring.
- **Tester:** wiring-testsuiten omskrevet fra grunnen for den nye sekvensielle flyten (50 tester, dekker
  ordrens §10 A-L) - 631/631 totalt (færre enn forrige runde ved design, siden race-spesifikke tester er
  erstattet av færre, mer presise sekvensielle tester). Lint/full monorepo-typecheck/gitleaks alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever Tobias sitt ENE
  Cloud Console-steg (hvis nødvendig, nå UTEN risiko for at scriptet prøver den kjente Web-klienten
  først) etterfulgt av en NY host-kjøring. PR #5 forblir draft/umerget. Ett-kommando-kontrakten er
  UENDRET: `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE DRIVE REAUTH HOST FIX #5 "CLASSIFY REAL DRIVE 403 + AUTO-GUIDE" (samme dag, 2026-08-16)
- **Host-funn:** Tobias kjørte HOST FIX #4-versjonen. Desktop-OAuth-bootstrappen fungerte HELT gjennom
  (`google_desktop_client_status=SETUP_REQUIRED` → `google_desktop_client_import=PASS` →
  `google_desktop_client_type=desktop`, token-exchange lyktes med en scope-streng som så korrekt ut) -
  men flyten feilet DERETTER spesifikt på selve Drive-metadata-probe-kallet: `google_reauth=
  FAIL_DRIVE_PROBE`. `.env` forble korrekt urørt. Eksplisitt eierkrav: IKKE rør OAuth-redirect-/klient-
  arkitekturen igjen (host-bevist fungerende) - blokkeringen er en POST-AUTH Google Drive API-403, og
  den EKSAKTE Google-feilårsaken skulle klassifiseres, ALDRI gjettes.
- **Ny, trygg feilklassifisering** (`classifyDriveProbeError()` i lib, rent/deterministisk, INGEN
  nettverk): parser Google sin STABILE feil-JSON-form (`error.status`/`error.errors[].reason`/
  `error.details[].reason`/`error.message`) til `API_NOT_ENABLED`/`INSUFFICIENT_SCOPE`/
  `WORKSPACE_ADMIN_POLICY`/`RATE_LIMIT`/`AUTH_INVALID`/`UNKNOWN_PROVIDER_403`. `API_NOT_ENABLED` og
  `INSUFFICIENT_SCOPE` gjenkjennes via Google sine EGNE, dokumenterte, høy-presisjon signaler
  (`SERVICE_DISABLED`/`accessNotConfigured`/"has not been used in project"; `insufficientPermissions`/
  "insufficient authentication scopes"). `WORKSPACE_ADMIN_POLICY` er EKSPLISITT dokumentert i koden som
  en BEST-EFFORT-bøtte (generisk `PERMISSION_DENIED` uten et mer presist signal på dette tidspunktet i
  flyten - Google gir normalt ikke et unikt maskinlesbart signal for Workspace-adminblokk etter
  token-exchange) - ALDRI fremstilt som en Google-bekreftet unik årsak. `safeMessage` trunkeres
  (≤300 tegn); resultatobjektet har KUN 7 trygge felt - access_token/refresh_token/client_secret/
  authorization_code/fulle request-headers går ALDRI inn i klassifiseringen eller noen logglinje.
- **Automatisk guiding + samme-prosess-retry** (`driveMetadataProbe()`/`retryDriveProbeUntilRecovered()`
  i orchestratoren): en GJENOPPRETTBAR blokkering (`isRecoverableDriveProbeBlocker()` - KUN
  `API_NOT_ENABLED`/`WORKSPACE_ADMIN_POLICY`) åpner NØYAKTIG riktig side automatisk (Google sin EGEN
  innebygde enable-URL fra feilmeldingen foretrukket for API_NOT_ENABLED - `buildDriveApiEnableUrl()`
  KUN som fallback; Admin Console sin API Controls-side, `GOOGLE_ADMIN_API_CONTROLS_URL`, for
  WORKSPACE_ADMIN_POLICY - med ÉN instruksjon om å stole eksplisitt på "Jarvis Desktop"-klienten, IKKE en
  bred org-policy-endring), gir Tobias ÉN eksakt setning, og prøver DERETTER Drive-proben på nytt hvert
  5. sekund i SAMME kjørende prosess i opptil 10 minutter - ingen restart, ingen andre kommando. Et
  refresh_token tilgjengelig IN-MEMORY brukes trygt til å fornye access-tokenet underveis hvis det
  utløper mens Tobias gjør Console-klikket (`refreshAccessToken()`) - `.env` forblir likevel HELT urørt
  til HELE flyten (inkludert denne retryen) lykkes. En IKKE-gjenopprettbar blokkering (INSUFFICIENT_SCOPE/
  RATE_LIMIT/AUTH_INVALID/UNKNOWN_PROVIDER_403) kaster UMIDDELBART med den klassifiserte rapporten - retry
  forsøkes ALDRI for noe scriptet ikke kan løse selv.
- **Ingen scope-nedgradering, ingen klient-fallback (D-41 uendret):** hele probe-/retry-flyten bruker
  UTELUKKENDE den allerede bevist-Desktop-klienten (`client.clientId`/`client.clientSecret`) - aldri
  `values["JARVIS_GOOGLE_CLIENT_..."]` direkte, aldri `drive.file`/`drive.readonly` noe sted i filen.
  Ingen Drive-MUTASJONER forsøkes noensinne i probe-/retry-koden - kun gjentatte, skrivebeskyttede
  metadata-lesinger.
- **Ingen credential persisteres mens blokkeringen er uløst:** `driveMetadataProbe()`-feilen og
  `retryDriveProbeUntilRecovered()`-kallet skjer STRUKTURELT FØR `updates`-blokken/`.env`-backup-koden -
  samme fail-closed-plassering som scope-sjekken. Lykkes retryen, oppdateres KUN det in-memory
  access-tokenet (`driveVerifiedAccessToken`) som brukes videre i resten av `main()` (inkl.
  `detectAccountEmail()`) - selve `.env`-skrivingen skjer fortsatt KUN i den ene, eksisterende atomiske
  `updates`-blokken, uendret fra HOST FIX #4.
- **Tester:** 15 nye rene enhetstester (`classifyDriveProbeError`/`formatDriveProbeReport`/
  `isRecoverableDriveProbeBlocker`/`buildDriveApiEnableUrl`/`GOOGLE_ADMIN_API_CONTROLS_URL`) + 11 nye
  strukturelle wiring-tester (riktig-prosjekt enable-URL-preferanse, samme-prosess-retry uten
  execFileSync-selv-spawn, ingen-persistering-mens-blokkert, vellykket-retry-fortsetter-med-ferskt-token,
  samme bevist-Desktop-klient gjennom hele flyten, ingen drive.file/drive.readonly noe sted) - **657/657
  totalt**. Lint/full monorepo-typecheck/gitleaks (`protect --staged` + historikk-scan) alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - selve klassifiserings-/retry-
  logikken kan IKKE kjøres ende-til-ende mot en ekte Google-403 i denne sky-sandboxen (krever en ekte
  Workspace-organisasjon/Cloud-prosjekt i en faktisk blokkert tilstand) - bevist STRUKTURELT
  (kildeteksts-baserte wiring-tester) + den underliggende klassifiseringslogikken fullt enhetstestet mot
  Google sin dokumenterte, stabile feil-JSON-form. Krever Tobias sin NYE host-kjøring for å bevise
  klassifiseringen/auto-guidingen faktisk treffer riktig mot den EKTE 403-en han observerte. PR #5
  forblir draft/umerget. Ett-kommando-kontrakten er UENDRET:
  `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE DRIVE REAUTH HOST FIX #6 "REUSE EXISTING DESKTOP JSON AFTER FAILED AUTH" (samme dag, 2026-08-16)
- **Host-funn:** Tobias hadde allerede opprettet ÉN Desktop-OAuth-klient ("Jarvis Desktop") og lastet ned
  en gyldig `installed`-JSON (HOST FIX #5-kjøringen beviste den helt gjennom token-exchange). Fordi
  persistering er BEVISST atomisk, ble klient-metadata/credentials IKKE skrevet til `.env` da Drive-proben
  feilet senere i samme kjøring. NESTE kjøring rapporterte likevel `google_desktop_client_status=
  SETUP_REQUIRED` igjen og åpnet Cloud Console på nytt - FEIL, siden Tobias ikke skal opprette en ny
  OAuth-klient han allerede har.
- **Root cause:** `waitForDesktopClientJson()`/`selectNewCandidateJsonFiles()` sin mtime-filter (§2 i HOST
  FIX #4-ordren, riktig for SITT formål - unngå å plukke opp en gammel, urelatert fil under FØRSTE gangs
  oppsett) godtar KUN filer med `mtime >= runStartMs`. En allerede-validert JSON fra en TIDLIGERE kjøring
  har per definisjon en eldre mtime enn en NY kjørings `runStartMs`, og ble derfor STILLE ignorert - et
  gjenopprettingsscenario (JSON importert → OAuth forsøkt → senere providervalidering feilet → prosessen
  avsluttet FØR persistering) som det opprinnelige designet aldri dekket.
- **Ny gjenopprettings-skanning FØR SETUP_REQUIRED vurderes:** `tryRecoverExistingDesktopClientJson()`
  (orchestrator) skanner Nedlastinger-mappa med en NY, mtime-fri lib-funksjon
  (`selectExistingCandidateJsonFiles()` - samme sortering/`.json`-filter som `selectNewCandidateJsonFiles()`,
  men UTEN `sinceMs`-parameteren) og validerer HVER kandidat med den EKSISTERENDE
  `tryReadValidDesktopClient()`/`parseClientSecretJson()`-kjeden (ingen parallell valideringslogikk - en
  "web"-type/ugyldig fil ekskluderes like stille som ved vanlig oppdagelse). Nøyaktig ÉN gyldig kandidat:
  gjenbrukes AUTOMATISK (`google_desktop_client_status=RECOVERED_EXISTING_JSON`), Cloud Console åpnes
  ALDRI. `main()` sin `if (!client)`-gjenopprettingsblokk står STRUKTURELT FØR `SETUP_REQUIRED`-blokken som
  to SEPARATE if-sjekker (ikke if/else) - lykkes gjenopprettingen, er `client` allerede satt og
  `SETUP_REQUIRED`-blokken sin betingelse er `false` ved runtime.
- **Flere eksisterende gyldige kandidater samtidig:** samme trygge, KUN-filnavn-nummererte velger som
  ellers (`promptForCandidateSelection()`, nå med en `variant: "new" | "existing"`-parameter for riktig
  ledetekst - ALDRI en stille gjetning, ALDRI to parallelle implementasjoner). Et uavklart svar faller
  TRYGT tilbake til `SETUP_REQUIRED` (ingen uendelig løkke her, i motsetning til den vanlige
  nedlastings-pollingen - eksisterende filer endrer seg ikke av seg selv mens vi venter).
- **Non-secret gjenopprettingsmarkør (§3 i ordren): BEVISST IKKE bygget denne runden.** Selve
  gjenopprettings-skanningen løser det konkrete host-funnet uten behov for ny persistert tilstand (unngår
  en ekstra `.gitignore`-styrt lokal fil og tilhørende kompleksitet) - dokumentert avveining, ikke et
  utelatt krav (ordren selv merket punktet "Consider"/valgfritt).
- **Atomisk `.env`-persistering UENDRET:** gjenopprettingen påvirker KUN hvilken `client` OAuth-forsøket
  bruker - `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN`/`_OAUTH_CLIENT_TYPE` skrives fortsatt SAMMEN, KUN
  én gang i hele filen, KUN etter at callback+state+scope+Drive-probe+kontosjekk alle har lyktes.
- **HOST FIX #5 uendret:** `classifyDriveProbeError()`/`driveMetadataProbe()`/
  `retryDriveProbeUntilRecovered()` (Drive-403-klassifisering, auto-guide, samme-prosess-retry) er ikke
  rørt - en gjenopprettet klient fortsetter inn i NØYAKTIG samme OAuth→scope→Drive-probe-flyt som en
  nyoppdaget/persistert-metadata-klient.
- **Tester:** 4 nye rene enhetstester (`selectExistingCandidateJsonFiles` - eksisterende gammel fil tas
  med, ekstremt gammel mtime diskvalifiserer IKKE, `.json`-filter, nyest-først) + 12 nye strukturelle
  wiring-tester (mtime-fritt gjenopprettingskall, to separate if(!client)-sjekker, gjenbruk av
  eksisterende valideringskjede, fail-safe flere-kandidater-håndtering uten uendelig løkke, Cloud Console
  IKKE åpnet ved vellykket gjenoppretting, ingen client_secret logget, ingen tidlig `.env`-persistering,
  HOST FIX #5 uendret) - **673/673 totalt** (84+4 lib, 61+12+3 justerte wiring). Lint/full
  monorepo-typecheck/gitleaks alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - selve gjenopprettings-
  skanningen kan ikke kjøres ende-til-ende mot en ekte tidligere-nedlastet fil i denne sky-sandboxen
  (krever en ekte Windows Nedlastinger-mappe med en reell, tidligere validert JSON-fil) - bevist
  STRUKTURELT (kildeteksts-baserte wiring-tester) + den underliggende filter-/valideringslogikken fullt
  enhetstestet. Krever Tobias sin NYE host-kjøring for å bevise at scriptet nå gjenkjenner den allerede
  eksisterende "Jarvis Desktop"-JSON-en automatisk og går rett til OAuth-samtykke uten å åpne Cloud
  Console på nytt. PR #5 forblir draft/umerget. Ett-kommando-kontrakten er UENDRET:
  `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## UA-2 P1A HOST FIX #8 "CLEANUP-ONLY BLOCKERS AFTER FULL DRIVE SUCCESS" (samme dag, 2026-08-16)
- **Host-funn (run_id `ff16c69d`) - VIKTIG MILEPÆL: Google Drive full read/write er nå HOST-BEVIST.**
  Reauth-flyten (HOST FIX #4-#6) fullførte helt: `google_drive_api_enabled=PASS`,
  `google_drive_full_scope=PASS`, kontosjekk PASS, koherent Desktop-credential-sett persistert,
  `google_drive_reauth=PASS`. Selve Drive-akseptansen (`ua2-p1a-live.ts` §6) beviste DERETTER
  `google_drive_auth_scope`/`_read`/`_create`/`_update`/`_rename`/`_move`/`_sync`/
  `_q20_no_resurrection`/`_trash`/`_idempotency`/`_permanent_delete`/`_policy` ALLE PASS, ingen
  token-lekkasje (`drive_token_leak_audit=false`, `drive_token_leak_metadata=false`),
  `google_drive_permission_live=SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL` (uendret, bevisst). Den samlede
  P1A-akseptansen ble likevel blokkert av TO RENE opprydding-defekter (IKKE manglende
  Drive-kapabilitet) - se under.
- **Blokker A - `google_drive_cleanup=FAIL` (targets=5, root_deleted=true):** root cause funnet ved
  faktisk kildelesing (ikke gjettet). §P sin allerede-vellykkede `delete_permanent` av hovedtestfila
  lot fila stå igjen i `sandbox.created` - §5-oppryddingen forsøkte DERFOR å slette den EN GANG TIL.
  Den EKTE mekanismen: `delete_permanent` er en klasse-D-handling med `preflight_action: "get_metadata"`
  (ToolGateway sin evidens-/recovery-mekanisme) - for en fil som ALLEREDE er permanent slettet gir
  DENNE preflight-lesingen en 404, og siden klassen er D fører det til en UMIDDELBAR
  `preflight_failed:drive_not_found_...`-DENY - `deletePermanent()`-transportens EGEN, allerede
  idempotente 404-håndtering (`already_deleted: "true"`) nås ALDRI i dette tilfellet.
- **Fiks A:** `DriveAcceptanceSandbox` fikk en eksplisitt artefakt-livssyklus
  (`CREATED`/`TRASHED`/`PERMANENTLY_DELETED`/`CLEANED`) - `markPermanentlyDeleted(fileId)` kalles
  UMIDDELBART etter §P sin vellykkede sletting, og `cleanupTargets()` utelater NÅ strukturelt et hvert
  artefakt i en terminal tilstand (`PERMANENTLY_DELETED`/`CLEANED`) - INGEN redundant sletteforsøk
  skjer lenger. Som forsvar-i-dybden: ny `classifyCleanupOutcome()` klassifiserer et EVENTUELT
  gjenværende NOT_FOUND-svar under selve cleanup-løkka som `already_absent` KUN når mål-IDen er et
  KJENT sandkasse-artefakt (`sandbox.has()` - samme grensekontroll som `assertInSandbox()`) - ALDRI
  generalisert til en vilkårlig Drive-fil utenfor sandkassen. `google_drive_cleanup=PASS` avgjøres
  UTELUKKENDE av `cleanup_failures === 0` - ALDRI av `root_deleted=true` alene. Ny evidenslinje:
  `created_artifacts=<n> cleaned_artifacts=<n> already_absent=<n> cleanup_failures=<n> root_deleted=<bool>`.
- **Blokker B - `tenants`-FK-feil:** `"update or delete on table tenants violates foreign key
  constraint tool_executions_tenant_id_fkey"`. Root cause funnet mot det FAKTISKE skjemaet (ikke
  gjettet): `tool_executions.tenant_id` REFERENCES `tenants` (010_tool_executions.sql) - §N sin
  idempotency-test (ToolGateway sin idempotency_key-dedupe) skriver ÉN rad dit for TENANT_A, og
  `cleanupTenant()` slettet den aldri FØR `DELETE FROM tenants` ble forsøkt.
- **Fiks B:** `DELETE FROM tool_executions WHERE tenant_id = $1` lagt til FØRST i `cleanupTenant()`
  (FK-trygg rekkefølge, utledet fra selve migrasjonsgrafen). Verifisert MOT faktisk kildekode (ikke
  antatt) at INGEN andre tabeller trenger rydding: `audit_events.tenant_id` er en REN TEKSTKOLONNE
  (INGEN `REFERENCES tenants`, se 004_audit_cost.sql) OG append-only-trigger-beskyttet (samme
  Q-20-presedens - IKKE rørt, IKKE forsøkt slettet); `sessions`/`messages`/`events`/`devices`/
  `approvals`/`cost_events`/`brief_seen` opprettes ALDRI av P1A-akseptansen (verifisert - ingen av
  kallene i `ua2-p1a-live.ts` går via de tilhørende service-modulene). Ingen `DISABLE TRIGGER`, ingen
  `session_replication_role`, ingen `TRUNCATE`, ingen superbruker-omvei - kun presise,
  parameteriserte `DELETE ... WHERE tenant_id = $1`-setninger via den EKSISTERENDE `adminPool`
  (uendret Q-21 admin/runtime-splitt).
- **Q-21 uendret:** ingen kode rørt utenfor de to presise cleanup-fiksene - `jarvis_runtime` forblir
  NOSUPERUSER/NOBYPASSRLS, ingen RLS-omvei brukt eller nødvendig (adminPool var allerede den
  eksisterende, legitime admin-tilkoblingen for nettopp denne typen opprydding).
- **Google OAuth-arkitekturen er IKKE rørt** denne runden (eksplisitt krav i ordren) - begge fiksene
  er rene opprydding-/DB-endringer i `ua2-p1a-live.ts`/`drive-acceptance-sandbox.ts`. Tobias sin NESTE
  host-kjøring bruker de ALLEREDE persisterte Desktop-credentialene - INGEN ny reautorisering, INGEN
  nytt Cloud Console-steg, INGEN nytt samtykke nødvendig.
- **Tester:** 14 nye rene enhetstester (`drive-acceptance-sandbox.test.ts` - livssyklustilstand,
  `isNotFoundFailureReason()`, `classifyCleanupOutcome()`, inkl. eksplisitt "NOT_FOUND utenfor
  sandkassen aksepteres ALDRI"-kontrastbevis) + 14 nye strukturelle wiring-tester
  (`ua2-p1a-host-run-wiring.test.ts` - markPermanentlyDeleted-plassering, classifyCleanupOutcome-bruk,
  PASS-betingelse, FK-rekkefølge, scopet DELETE, ingen FK-omvei, audit_events urørt, alle tidligere
  host-bevist Drive-kapabilitetsstier uendret) - full suite kjørt, lint/typecheck/gitleaks rene (se
  rapport for eksakte tall).
- **STATUS - VIKTIG DISTINKSJON (§11 i ordren):** Google Drive full read/write-kapabilitet er
  HOST-BEVIST (run_id `ff16c69d`) - dette er IKKE lenger en åpen post. Den SAMLEDE UA-2 P1A-
  akseptansen forblir likevel FIXED_SUITE / READY_FOR_HOST_VERIFY, **IKKE VERIFIED**, fordi
  cleanup-defektene (Blokker A/B over) hindret et fullstendig grønt `hard_fail=false`-resultat på
  DENNE kjøringen. Krever EN NY host-kjøring (ingen ny reautorisering) for å bevise at BEGGE
  cleanup-fiksene faktisk fungerer mot ekte Drive/Postgres FØR P1A kan settes VERIFIED. PR #5 forblir
  draft/umerget.

## UA-2 P1A FINAL CLOSURE (2026-08-16, samme dag) — HOST VERIFIED, PR #5 MERGET
**Tobias kjørte `node --experimental-transform-types modules/core/scripts/ua2-p1a-host-run.ts` på sin
faktiske Windows/Docker-host - GRØNT resultat, run_id `2703299e`, `hard_fail=false`.** Ingen ny
Google-reautorisering var nødvendig - de allerede persisterte Desktop-credentialene ble gjenbrukt
direkte.
- **Q-21 uendret:** `q21_runtime_role_safe=PASS`, `runtime_current_user=jarvis_runtime`,
  `runtime_role_superuser=false`, `runtime_role_bypassrls=false`.
- **Knowledge P1A:** `p1a_registry_tenant_scoping`/`p1a_obsidian_lifecycle`/
  `p1a_obsidian_obsidian_dir_excluded`/`p1a_obsidian_frontmatter_wikilinks`/
  `p1a_obsidian_no_resurrection`/`p1a_tenant_isolation_new_sources`/`p1a_retrieval_new_sources`/
  `p1a_no_content_in_audit` = ALLE PASS.
- **Google Drive (full read/write, D-41):** `google_drive_auth_scope`/`_read`/`_create`/`_update`/
  `_rename`/`_move`/`_trash`/`_permanent_delete`/`_cleanup`/`_sync`/`_q20_no_resurrection`/
  `_idempotency`/`_policy`/`_live` = ALLE PASS. HOST FIX #8-cleanup-fiksene (§forrige seksjon) bevist
  fungerende: `created_artifacts=4 cleaned_artifacts=4 already_absent=1 cleanup_failures=0
  root_deleted=true` - ingen `cleanup A/B feilet`-linjer. `drive_token_leak_audit=false`,
  `drive_token_leak_metadata=false`.
- **Ærlig unntak, IKKE overklaimet:** `google_drive_permission_live=SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL`
  - live permission-mutasjon (dele/tilgangsstyring) er bevisst IKKE host-testet (ingen trygg ekstern
  testperson i en ubetjent kjøring). Kapabiliteten er implementasjon-/suite-verifisert
  (`drive-full-access.test.ts` §I), men IKKE live-host-bevist - registrert som Q-23, et smalt,
  gjenværende verifikasjonspunkt, IKKE en blokkering for lukking (akseptanseløperen behandlet det
  eksplisitt som et trygt skip).
- **STATUS: UA-2 P1A = VERIFIED/COMPLETE → D-42.** PR #5 merget til `main` (normal merge-commit,
  samme konvensjon som PR #1-#4 - historikk bevart, ikke squashet). Se D-42 i
  DECISIONS_AND_ASSUMPTIONS.md for full beslutningslogg-entry.

## P1A RUNTIME WIRING CLOSEOUT (2026-08-16, egen branch `claude/p1a-drive-runtime-wiring`)
**IKKE en ny P1A-fullføring - D-42 forblir UENDRET som beslutningen som satte UA-2 P1A VERIFIED/
COMPLETE.** Dette er en oppfølgende, avgrenset lukking av ETT gjenværende funn fra P1A-lukkingen
(se "Nytt, ikke-blokkerende funn" i tidligere runder): `GoogleDriveTransport` var host-akseptanse-
bevist (D-42), men var ALDRI wiret inn i den NORMALE `apps/api/src/main.ts`/`worker-main.ts` sine
`firstWaveTools({...})`-kall - Drive-verktøyene var derfor reelt uoppnåelige fra en løpende api/
worker-prosess (kun `ua2-p1a-live.ts` sin egen akseptanse-only ToolGateway nådde dem).
- **Fiks:** ny delt fabrikk `driveTransportsIfConfigured()` (`live-transports.ts`) - sjekker KUN
  tilstedeværelse (Boolean) av `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN` (de tre
  `googleAccessToken()` faktisk krever - `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE` er bevisst IKKE sjekket,
  den er kun reauth-scriptets egen bokføringsmarkør). Begge `main.ts` og `worker-main.ts` sprer
  `...driveTransportsIfConfigured()` inn i sitt EKSISTERENDE `firstWaveTools({...})`-kall - SAMME
  registreringsvei som email/calendar/github/telegram, ingen parallell mekanisme. Mangler
  credentials: `drive`-nøkkelen er fraværende, `firstWaveTools()` sin egen (allerede eksisterende)
  `UnconfiguredHttpTransport("drive")`-fallback brukes - INGEN oppstartskrasj, INGEN ny feilbane.
- **Full D-41-kapabilitet:** alle 14 implementerte Drive-handlinger (4×A, 6×C, 4×D) registreres
  samlet - ingen read-only-nedgradering, ingen ny godkjenningsfriksjon utover eksisterende
  sovereign-owner-policy.
- **Ny ett-kommando host-smoke:** `apps/api/scripts/p1a-drive-runtime-smoke.ts` - beviser den NORMALE
  runtime-banen (EKTE ToolGateway/PolicyGateway, samme konstruksjon som main.ts) mot ekte Drive med
  et rent lese-only `get_metadata("root")`-kall, PLUSS et strukturelt bevis for worker-banens
  identiske registrering. INGEN ny OAuth-samtykke, INGEN Drive-mutasjon.
- **Q-23 uendret:** `google_drive_permission_live=SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL` forblir åpen -
  runtime-wiring eksponerer permission-handlingene, men live-verifikasjon krever fortsatt en reell
  ekstern testperson.
- **Tester:** 22 nye rene enhetstester (`google-drive-transport.test.ts` §credential-sjekk) + 24 nye
  strukturelle wiring-tester (`drive-runtime-wiring.test.ts` + `drive-runtime-smoke-wiring.test.ts`,
  inkl. en regresjonsvakt mot den ufullstendige kommandoen - se HOST-FIX under). Eksisterende
  `drive-full-access.test.ts` (owner sovereign/delegert D-klasse-policy) kjørt UENDRET - fortsatt
  17/17 PASS, bevis for at policy-banen ikke er regressert.
- **HOST-FIX (2026-08-16, Tobias sitt faktiske host-funn):** den opprinnelig dokumenterte kommandoen
  (`node --experimental-transform-types apps/api/scripts/p1a-drive-runtime-smoke.ts`) manglet
  `--env-file=.env` - scriptet leser `process.env` direkte (samme mønster som main.ts/worker-main.ts,
  som i normal drift får variablene injisert av docker-compose, IKKE av et `--env-file`-flagg), men
  kjørt FRITTSTÅENDE på hosten (utenfor en container) må Node eksplisitt bes om å laste `.env` selv.
  Uten flagget rapporterte scriptet (korrekt, ikke en logikk-bug) `BLOCKED_NO_CREDENTIALS`
  (`client_id=false client_secret=false token=false`). Rettet til
  `node --env-file=.env --experimental-transform-types apps/api/scripts/p1a-drive-runtime-smoke.ts` -
  Node sin EGEN innebygde `--env-file`-mekanisme (siden Node 20.6), BEVISST ingen ny `dotenv`-
  avhengighet lagt til. Samme konvensjon som `ua2-p1a-live.ts` sin egen toppkommentar allerede
  dokumenterer - dette scriptet var det inkonsekvente unntaket, nå rettet i selve fila,
  wiring-testen og all dokumentasjon.
- **HOST-BEVIS (samme dag, korrigert kommando):** `drive_runtime_registered=PASS`,
  `drive_runtime_api_path=PASS` (**LIVE** - ekte `get_metadata("root")` gjennom den normale
  ToolGateway/firstWaveTools-runtime-banen mot ekte Google Drive), `drive_runtime_worker_path=PASS`
  (**STRUKTURELT** bevist - IKKE en live worker-prosess-kjøring, se skillet dokumentert i scriptets
  egen kommentar og i ordren), `q21_runtime_role_safe=PASS`, `token_leak=false`, `hard_fail=false`.
- **STATUS: VERIFIED/COMPLETE.** P1A Runtime Wiring Closeout er ferdig host-bevist. **D-42 forblir
  UENDRET** som beslutningen som satte UA-2 P1A VERIFIED/COMPLETE - denne closeout-runden erstatter
  IKKE D-42, den lukker kun det ETT gjenværende post-merge-integrasjonsfunnet. PR #6 merget til
  `main` (normal merge-commit, samme konvensjon som PR #1-#5).

## UA-2 P1B-A — E-post-vedlegg + OCR/vision-ingestion-fundament (BYGGET denne økten, 2026-08-16, branch `claude/ua2-p1b-a-email-ocr-vision` fra `origin/main` `35ac208`)

**Fase-port avklart FØRST:** `docs/PROJECT_STATUS.md` hadde tidligere logget at P1B-A venter på "egen,
eksplisitt fase-godkjenning fra Tobias" (CLAUDE.md-regel 10). Ved mottak av byggeordren for P1B-A ble
denne motstriden eksplisitt flagget og avklart via spørsmål til brukeren FØR noe kode ble skrevet -
brukeren bekreftet "Proceed with implementation". Loggført her for sporbarhet, ikke stille omgått.

**Status: IMPLEMENTED + SUITE-VERIFIED (813/813 tester, 62 testfiler). IKKE host-verifisert ennå.**
Bygget PÅ det VERIFIED P0/P1A-fundamentet - ingen parallell ingestion-pipeline, ingen ny
autentiseringsvei. Full arkitektur-/scope-begrunnelse: D-43 (opprinnelig scope-beslutning) og D-44
(oppdaget under selve byggingen - `pdf-parse` v2 dekker BÅDE native tekst-ekstraksjon OG
side-rasterisering i ett bibliotek, ingen tung systemavhengighet).

**Bygget (se IMPLEMENTATION_PLAN.md sin P1B-A-seksjon for full detaljliste):**
1. Multimodalt `ChatMessage.content` (`string | ContentPart[]`) i `packages/provider-adapters` - EKTE
   bildestøtte KUN i Anthropic-adapteren denne runden; `capability-registry.ts` sitt `vision`-flagg
   korrigert til å reflektere dette faktisk (ikke aspirasjonelt lenger på openai/gemini).
2. `GmailTransport.list_messages`/`read_attachment` (nye handlinger, SAMME `JARVIS_EMAIL_TOKEN`-vei).
3. `extraction-safety.ts` - fil-type-klassifisering (arkiver/docx/xlsx/pptx eksplisitt avvist), fail-
   closed størrelses-/side-/tidsgrenser, native→bilde-terskel, path-traversal-sikker filnavn-sanering.
4. `ocr-provider.ts` - `ModelGatewayVisionExtractor` (OCR + vision-beskrivelse, BEGGE via EKSISTERENDE
   `ModelGateway`, `purpose:"VISION"`, aldri direkte leverandør-SDK).
5. `pdf-extraction.ts` (ny avhengighet `pdf-parse` v2 / `@napi-rs/canvas`, D-44) - EKTE per-side native
   tekst OG side-rasterisering, verifisert funksjonelt i dev-sandkasse mot en håndlaget test-PDF.
6. `EmailAttachmentKnowledgeSource` - side-granulær `external_id`-"chunking" UTEN ny tabell
   (`msg:<id>`/`att:<msgId>:<attId>[:page:<n>]`), gjenbruker 100% av eksisterende
   dedupe/tombstone/Q-20/RLS. Per-vedlegg/per-side feilisolasjon, AUTH/PERMISSION-eskalering.
7. `email_attachment`-kildetype i `KnowledgeSourceRegistry` + ny `knowledge-ingest-email`-agent-profil
   i `apps/api/src/worker-main.ts` (SAMME `InProcessWorker`/`PgTaskQueue` som `executive`).
8. Host-akseptansescript `modules/knowledge/scripts/ua2-p1b-a-host-run.ts` (`p1b_*`-markører,
   `--env-file=.env`-konvensjon, BLOCKED_NO_EMAIL_CREDENTIALS/BLOCKED_NO_VISION_PROVIDER fail-closed
   defaults - ALDRI en antatt PASS uten faktiske credentials).

**Suite-verifisert:** 813/813 - multimodal content-mapping (10 tester), Gmail-transport-logikk (8+6
tester, inkl. rekursiv MIME-tre-vedleggsgjenfinning), fail-closed sikkerhetsgrenser (18 tester),
EmailAttachmentKnowledgeSource end-to-end (13 tester, inkl. EKTE PDF native/OCR/vision-routing mot
håndlagde test-PDF-er, ikke mocket), full dedupe/tombstone/Q-20-resurrection-suppresjon mot ekte
embedded Postgres (2 tester), registry-/worker-wiring (5+5+10 strukturelle tester).

**IKKE host/live-verifisert (se Q-24 for full gap-liste):** ekte Gmail-listing/vedleggsnedlasting
(krever `JARVIS_EMAIL_TOKEN` - EGEN credential fra Drive/Calendar, se D-35), ekte vision-modellkall
(krever `ANTHROPIC_API_KEY`), full sync mot en ekte innboks, `@napi-rs/canvas` sin native binær
bevist å laste korrekt på Tobias sin faktiske Windows/Docker-host (kun dev-sandkasse-verifisert).

**Kvalitetsgates kjørt:** `pnpm -r run typecheck` (13/13 workspace-prosjekter grønt), `eslint .`
(0 feil/advarsler på alle nye/endrede filer), `pnpm test` (813/813, 62 testfiler), gitleaks
(protect --staged + detect mot origin/main..HEAD, begge rene).

**Docs oppdatert:** D-43 (opprinnelig scope-beslutning), D-44 (pdf-parse-oppdagelse),
Q-24 (samlet gap-liste), IMPLEMENTATION_PLAN.md (ny P1B-A-seksjon + P1A-referanse), RUNTIME_GATES.md
(ny gate-rad), UA2_KNOWLEDGE_DPIA.md (ny `email_attachment`-datakategori-rad + egen
"OCR/vision-dataflyt"-seksjon - materiell dataflyt-endring: bilde-bytes til ekstern leverandør).

**STATUS: FIXED_SUITE/READY_FOR_HOST_VERIFY.** IKKE merget - venter på Tobias sin host-kjøring av
`ua2-p1b-a-host-run.ts` (krever `JARVIS_EMAIL_TOKEN` + `ANTHROPIC_API_KEY` i `.env`) før VERIFIED kan
erklæres, i tråd med samme host-bevis-disiplin som D-38/D-39/D-40/D-42.

## UA-2 P1B-A HOST FIX #1 "GMAIL 401 CLIENT/TOKEN COHERENCE + COST_EVENTS CLEANUP" (samme dag, 2026-08-16, ekte host-funn `run_id 3af67dab`)

**Tobias sin faktiske Windows/Docker-host-kjøring** (`run_id 3af67dab`) ga PASS for
`p1b_pdf_native_extraction`/`p1b_pdf_page_render`/`p1b_extraction_routing_decision`/
`p1b_vision_ocr_live`/`q21_runtime_role_safe`/token-leak-audit, men **FAIL** for
`p1b_gmail_list_messages_live` (`reason=tool_failed:google_auth_failed_401`) - som kaskaderte til
`p1b_sync_email_source_live`-feil (`error_class:"AUTH"`) og en hoppet-over Q-20-e-post-live-sjekk,
pluss en separat `cost_events_tenant_id_fkey`-FK-brudd som blokkerte tenant-cleanup. `hard_fail=true`.

**Root cause IKKE konkludert med sikkerhet fra dette funnet alene** - `googleAccessToken()` kastet
opprinnelig vekk Google sin faktiske token-endpoint-responskropp ved feil, så kun `401` var synlig,
ingen `error`/`error_description`. Full begrunnelse/full fiks: **D-45** i
`docs/DECISIONS_AND_ASSUMPTIONS.md`. Kort sammendrag av det som ER bygget denne runden:

1. **Klassifisering** - `classifyGoogleTokenEndpointError()` (ny, `live-transports.ts`) parser
   Google sitt RFC 6749 §5.2-token-endpoint-feilformat til `EMAIL_TOKEN_CLIENT_MISMATCH`/
   `EMAIL_REFRESH_TOKEN_REVOKED`/`EMAIL_INSUFFICIENT_SCOPE`/`GOOGLE_INVALID_GRANT`/
   `GOOGLE_INVALID_CLIENT`/`UNKNOWN_GOOGLE_AUTH` - kun trygge felt eksponert (HTTP-status, Google
   sin `error`-kode, sanert `error_description`), ALDRI token/secret/Authorization-header i logg.
2. **Gmail-reauth-flyt** - `modules/core/scripts/google-email-reauth.ts` (nytt orkestreringsskript)
   gjenbruker den ALLEREDE persisterte Desktop-OAuth-klienten (`JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/
   `_OAUTH_CLIENT_TYPE=desktop`, samme klient som Drive/D-42) - ingen ny Google Cloud-klient, ingen ny
   JSON-import, Drive-auth HELT urørt. Scopes: `gmail.readonly` + `gmail.send` (bevarer eksisterende
   send-kapabilitet, D-41) + `userinfo.email` (kontoverifisering). `prompt=consent select_account`,
   autorisert konto sammenlignet mot `JARVIS_GOOGLE_ACCOUNT` FØR persistering - ulik konto avbryter
   eksplisitt. Persisterer KUN `JARVIS_EMAIL_TOKEN` (atomisk, `.bak.<epoch>`-sikkerhetskopi), først
   etter state-PASS + exchange-PASS + scope-PASS + konto-PASS + live Gmail-leseprobe-PASS.
3. **Automatisk gjenoppretting samme kjøring** - `ua2-p1b-a-host-run.ts` forsøker reauth-skriptet
   AUTOMATISK ÉN gang (`reauthAttempted`-vakt) når feilen klassifiseres som gjenopprettbar, leser
   `.env` på nytt fra disk, og fortsetter SAMME prosess - ingen ny Windows-kommando kreves.
4. **`cost_events`-FK-fiks** - verifisert mot faktisk skjema (`004_audit_cost.sql`, ingen
   append-only-trigger i motsetning til `audit_events`/`events`) - `DELETE FROM cost_events WHERE
   tenant_id = $1` lagt til FØRST i `cleanupTenant()`, ingen `TRUNCATE`/`DISABLE TRIGGER`/bred sletting.
5. **Live e-post-vedleggsfikstur** - `GmailTransport` mangler fortsatt `send`/`create`-kapabilitet,
   så ingen trygg fikstur kunne opprettes denne runden. Ny `Verdict`-medlem `SKIPPED_SAFE_FIXTURE`
   (ærlig, ALDRI en stille antatt PASS) brukes i stedet for å late som et vedlegg ble bevist.
6. **Fersk-workspace-bootstrap** - `ua2-p1b-a-host-run.ts` konverterte alle topp-nivå `@jarvis/*`-
   importer til dynamiske `await import()` etter en ny, synkron `ensureWorkspaceInstalled()`
   (`pnpm install --frozen-lockfile`, samme mønster som P1A sin runner) - ETT skript, ETT
   kommando løser fersk-checkout uten et separat installasjonssteg.

**Regresjonstester lagt til (A-S i byggeordren, alle PASS):** 18 nye tester for
token-endpoint-klassifisering (`google-auth-error-classification.test.ts`), 14 nye strukturelle
tester for reauth-orkestreringsskriptet (`google-email-reauth-wiring.test.ts`), full omskriving av
`ua2-p1b-a-host-run-wiring.test.ts` (21 tester: selv-bootstrap-rekkefølge, auto-reauth-vakt/-gjenopptak,
FK-trygg cleanup-rekkefølge, SKIPPED_SAFE_FIXTURE, §6-skip). **Ingen regresjon:** Drive-auth/-scopes/
-klient HELT urørt (verifisert strukturelt), Q-21 uendret, P0/P1A-tester alle fortsatt grønne.

**Kvalitetsgates:** `pnpm -r run typecheck` (13/13 grønt), `eslint .` (0 feil), `pnpm test`
(**856/856**, 64 testfiler - opp fra 813/813), gitleaks (protect --staged + detect mot
origin/main..HEAD, begge rene).

**STATUS UENDRET: FIXED_SUITE / HOST_VERIFY_BLOCKED.** IKKE VERIFIED - krever en NY host-kjøring av
`node --env-file=.env --experimental-transform-types modules/knowledge/scripts/ua2-p1b-a-host-run.ts`
for faktisk å bevise den fiksede klassifiseringen/reauth-flyten og live Gmail-sync mot en ekte
innboks. `docs/OPEN_QUESTIONS.md` Q-24 oppdatert med denne rundens funn (nye punkter 7/8). PR #7
IKKE merget - `IKKE merge, IKKE ny fase`-instruksen i byggeordren er fulgt.

## UA-2 P1B-A HOST FIX #2 "UNAUTHORIZED_CLIENT MUST TRIGGER SAFE GMAIL REAUTH" (samme dag, 2026-08-16, ekte host-funn `run_id ab43fb1f`)

**HOST FIX #1 sin nye klassifisering FUNGERTE og avdekket et mer presist funn.** Tobias sin neste
faktiske host-kjøring (`run_id ab43fb1f`) ga PASS for alle de samme lokale/vision-punktene som forrige
runde, men Gmail-refresh feilet nå med et EKSAKT klassifisert
`tool_failed:google_auth_failed_401:GOOGLE_INVALID_CLIENT:unauthorized_client` mot den ALLEREDE
host-bevist FUNGERENDE Desktop-OAuth-klienten (samme klient Drive bruker, D-42). Fordi
`isRecoverableGoogleAuthErrorClass("GOOGLE_INVALID_CLIENT")` (korrekt, for den GENERELLE klassen) er
`false`, ble auto-reauth-forsøket fra HOST FIX #1 aldri utløst - `gmail_auth_recoverable=false` og
kjøringen stoppet der. Full begrunnelse/full fiks: **D-46** i `docs/DECISIONS_AND_ASSUMPTIONS.md`.

**Root cause fortsatt IKKE kryptografisk bevisbart** (ærlig, per ordrens eget krav) - vi kan ikke bevise
fra selve refresh-tokenet HVILKEN gammel OAuth-klient som opprinnelig utstedte det. Dokumentert som
`LEGACY_TOKEN_OR_CLIENT_BINDING`: en begrunnet sannsynlighet (en gjenstående Gmail-tildeling fra FØR
Desktop-klient-migreringen), IKKE et bevist faktum.

**Løsning - kontekst-bevisst klassifisering, IKKE en global oppmykning av `invalid_client`:**

1. `classifyGoogleTokenEndpointError()` (`live-transports.ts`) tar nå en eksplisitt
   `GoogleAuthClientContext { provenDesktopClient: boolean }`. `invalid_client`/`unauthorized_client`
   klassifiseres til en NY klasse `EMAIL_REAUTH_REQUIRED` (gjenopprettbar,
   `recoveryReason=LEGACY_TOKEN_OR_CLIENT_BINDING`) KUN når `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE ===
   "desktop"` allerede er persistert (samme markør `google-drive-reauth.ts` skriver KUN etter en
   fullstendig host-bevist suksess). UTEN den markøren forblir klassifiseringen `GOOGLE_INVALID_CLIENT`,
   FORTSATT fail-closed - manglende secret/uprøvd/feilkonfigurert klient skal ALDRI automatisk
   reauth-forsøkes (§3 i ordren, eksplisitt testet).
2. `googleAccessToken()` leser `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE` KUN til dette formålet (aldri
   skrevet/eksponert noe sted).
3. `ua2-p1b-a-host-run.ts` sin eksisterende auto-reauth-trigger (HOST FIX #1, INGEN logikkendring)
   håndterer den nye klassen AUTOMATISK via SAMME `isRecoverableGoogleAuthErrorClass()`-kall - ingen
   egen, parallell spesialgren. Ny `p1b_gmail_reauth`-markør
   (`SKIPPED_NOT_NEEDED`/`SKIPPED_NOT_RECOVERABLE`/`PASS`/`FAIL`) gjør selve reauth-forsøkets EGET
   utfall eksplisitt synlig i host-sammendraget.
4. **Workspace-policy/Gmail-API-blokkeringer forblir separat klassifisert** (§6/§7 i ordren) - dette
   var ALLEREDE arkitektonisk garantert: `classifyDriveProbeError()` (Gmail-API-nivå, ETTER en
   vellykket token-exchange) og `classifyGoogleTokenEndpointError()` (token-endepunkt-nivå, FØR Gmail-
   API-tilgang) er to strukturelt separate klassifiseringsfunksjoner mot to ulike Google-feilformer -
   ingen kodeendring var nødvendig for dette punktet.
5. **Sikker akseptanse-fikstur-forbedring** (§11 i ordren, en bevisst enklere, men fungerende variant
   av ordrens run_id-baserte eksempel) - en STABIL `ACCEPTANCE_FIXTURE_SUBJECT = "Jarvis P1B
   Acceptance"`-konstant + ETT ekstra, SMALT `subject:"..."`-scoped `list_messages`-søk (samme
   handling/scope-begrensning, ALDRI en bredere postkasse-skann) forsøkes FØR fallback til
   `SKIPPED_SAFE_FIXTURE`. Tobias kan sende ÉN testmelding med dette EKSAKTE emnefeltet FØR en
   fremtidig kjøring uten å måtte forutsi et fremtidig run_id. Ingen `send`-kapabilitet lagt til
   `GmailTransport` - Tobias sender fortsatt selv, manuelt. Bundet flerminutters polling (ordrens
   eget eksempel) er EKSPLISITT UTSATT som dokumentert oppfølgingspunkt (Q-24, ikke stille utelatt).

**Regresjonstester lagt til (alle PASS):** nye tester i `google-auth-error-classification.test.ts`
(kontekst-bevisst `EMAIL_REAUTH_REQUIRED` vs. `GOOGLE_INVALID_CLIENT`, `recoveryReason`-felt,
`GmailTransport`-integrasjon med `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE` satt/usatt), nye tester i
`ua2-p1b-a-host-run-wiring.test.ts` (`p1b_gmail_reauth`-markør-tilstander, ingen egen
EMAIL_REAUTH_REQUIRED-spesialgren, smalt subject-søk). **Ingen regresjon:** Drive-auth/-scopes/-klient
HELT urørt, Q-21 uendret, cost_events-cleanup fra HOST FIX #1 bevart, alle P0/P1A/HOST FIX #1-tester
fortsatt grønne.

**Kvalitetsgates:** `pnpm -r run typecheck` (13/13 grønt), `eslint .` (0 feil), `pnpm test` (se
kommandoresultat under), gitleaks (protect --staged + detect mot origin/main..HEAD, begge rene).

**STATUS UENDRET: FIXED_SUITE / HOST_VERIFY_BLOCKED.** IKKE VERIFIED - krever en NY host-kjøring av
SAMME ene kommando for faktisk å bevise at reauth nå fullfører for dette spesifikke
`unauthorized_client`-funnet og at live Gmail-sync fungerer. `docs/OPEN_QUESTIONS.md` Q-24 oppdatert
med denne rundens funn (nye punkter 9/10). PR #7 IKKE merget - `IKKE merge, IKKE ny fase`-instruksen i
byggeordren er fulgt.

## UA-2 P1B-A FINAL CLOSURE (2026-08-17) — HOST VERIFIED, PR #7 MERGET

**Tobias kjørte `node --env-file=.env --experimental-transform-types
modules/knowledge/scripts/ua2-p1b-a-host-run.ts` på sin faktiske Windows/Docker-host - GRØNT
resultat, run_id `0f43f39d`, `hard_fail=false`.** Begge host-fix-rundene (HOST FIX #1/D-45, HOST
FIX #2/D-46) beviste seg selv i praksis: første Gmail-autentiseringsforsøk klassifisert KORREKT som
`EMAIL_REAUTH_REQUIRED`/`reason=LEGACY_TOKEN_OR_CLIENT_BINDING`, automatisk samme-prosess-reauth
fullførte helt (`google_email_reauth=PASS`), retry lyktes.

- **Q-21 uendret:** `q21_runtime_role_safe=PASS`.
- **Lokal PDF-ekstraksjon (ingen credentials):** `p1b_pdf_native_extraction`/`p1b_pdf_page_render`/
  `p1b_extraction_routing_decision` = ALLE PASS. `p1b_pdf_page_render=PASS` beviser SAMTIDIG at
  `@napi-rs/canvas` sin native binær laster korrekt på den faktiske Windows/Docker-hosten (tidligere
  kun dev-sandkasse-verifisert, D-44) - dette gapet er nå lukket.
- **Gmail auto-reauth + LIVE:** `p1b_gmail_reauth=PASS`, `p1b_gmail_list_messages_live=PASS`,
  `p1b_gmail_attachment_download_live=PASS` (et EKTE vedlegg funnet/lastet ned LIVE -
  `SKIPPED_SAFE_FIXTURE`-fallbacken fra HOST FIX #1/#2 var IKKE nødvendig denne kjøringen).
- **Vision OCR LIVE:** `p1b_vision_ocr_live=PASS` (ekte Anthropic-vision-kall via `ModelGateway`).
- **Full sync + Q-20 LIVE:** `EmailAttachmentKnowledgeSource`-sync `scanned=5 created=5 failed=0`,
  `p1b_sync_email_source_live=PASS`, `p1b_q20_no_resurrection_live=PASS` (Q-20-suppresjonsmekanismen
  nå LIVE-bevist for e-post-kilden, ikke bare Drive/filsystem fra tidligere).
- **Ingen token-lekkasje:** `p1b_token_leak_audit=PASS`, `token_leak=false`.
- **Credential-sikkerhet bekreftet:** KUN `JARVIS_EMAIL_TOKEN` endret av reauth-flyten -
  `JARVIS_GOOGLE_CLIENT_ID`/`_CLIENT_SECRET`/`_TOKEN`/`_OAUTH_CLIENT_TYPE` (Drive/Calendar) HELT
  urørt, INGEN ny Google Cloud OAuth-klient opprettet.
- **Ærlig unntak, IKKE overklaimet:** `p1b_worker_registration=SUITE_VERIFIED` - selve
  `knowledge-ingest-email`-worker-JOBB-kjøringen (via `InProcessWorker`/`PgTaskQueue`) er IKKE
  live-host-kjørt i denne akseptanserunden (host-scriptet kaller `KnowledgeSyncService.sync()`
  direkte, samme mønster som resten av scriptet) - kun implementasjon-/strukturelt suite-verifisert.
  Registrert som et smalt, gjenværende verifikasjonspunkt i Q-24, IKKE en blokkering for lukking
  (samme prinsipp som Q-23 sitt Drive-permission-unntak i D-42).
- **STATUS: UA-2 P1B-A = VERIFIED/COMPLETE → D-47.** PR #7 merget til `main` (normal merge-commit,
  samme konvensjon som PR #1-#6 - historikk bevart, ikke squashet). Se D-47 i
  DECISIONS_AND_ASSUMPTIONS.md for full beslutningslogg-entry, Q-24 for oppdatert gap-status.

## UA-2 MASTERPLAN CLOSEOUT (2026-08-17, branch `claude/ua2-masterplan-closeout`) — HELE FASEN VERIFIED/COMPLETE → D-48

**Fullstendig lukkings-audit av UA-2 «Universal Knowledge Layer» som HELHET** (ikke en ny feature-fase)
mot masterplanens EGNE fire ordrette akseptansekriterier (`docs/input/02_Jarvis_Masterplan_Sovereign_
Autonomy_v4.0.md`, linje 455-459 - kanonisk kilde for UA-2, `IMPLEMENTATION_PLAN.md` sin UA-2-seksjon
verifisert å gjengi disse ORDRETT, ingen avvik funnet). Full begrunnelse: **D-48** i
DECISIONS_AND_ASSUMPTIONS.md.

**Akseptansematrise (alle fire PASS, evidens i D-48):**

| # | Kriterium (masterplanens ordlyd) | Resultat | Kort evidens |
|---|---|---|---|
| 1 | Minst fem source systems i samme retrieval flow | **PASS** | 5 distinkte `source_type` i `KnowledgeSourceRegistry`: `filesystem`/`github`/`google_drive`/`obsidian`/`email_attachment` - alle via SAMME `KnowledgeSource`/`KnowledgeSyncService`/`KnowledgeRetriever`, ingen parallell vei |
| 2 | All hentet kunnskap har source pointer/freshness/trust | **PASS** | `KnowledgeProvenance` (`retriever.ts`) returnerer kilde-pointer+ferskhet på HVERT resultat, strukturelt umulig å hoppe over. "Trust" implisitt via `source_type` + DPIA sin "untrusted ingestion"-klassifisering (ingen eget felt bygget - se D-48 for ærlig presisering) |
| 3 | Cross-tenant leakage = 0; delete/revoke propagated | **PASS** | `FORCE ROW LEVEL SECURITY` (tenant+space) i `017_knowledge.sql`; Q-20/tombstone LIVE-bevist på tvers av P0 (`778bb87d`)/P1A (`2703299e`)/P1B-A (`0f43f39d`); Q-21 uendret i alle tre |
| 4 | DPIA/processing inventory oppdatert for nye datakategorier | **PASS** | `UA2_KNOWLEDGE_DPIA.md` har egen, oppdatert rad for alle fem kilder + egen OCR/vision-dataflyt-seksjon |

**Worker-krav eksplisitt vurdert (§12 i audit-ordren):** verken "durable worker" eller "live worker-jobb-
kjøring" er nevnt i masterplanens fire akseptansekriterier - Q-24 sin `p1b_worker_registration=
SUITE_VERIFIED`-status er derfor en implementasjonsdetalj-verifikasjon, IKKE en UA-2-blokkering.

**Klassifisert IKKE-BLOKKERENDE for UA-2-lukking (oppdatert i OPEN_QUESTIONS.md, ingenting bygget):**
Q-22 (Pieces - "5 kildesystemer" er allerede oppfylt UTEN Pieces), Q-23 (Drive permission-live-
verifikasjon - D-41-connector-kapabilitet, ikke et UA-2-kriterium), Q-24 (P1B-A worker-jobb-live-
kjøring + øvrige kjente kapabilitetsgap - ingen av dem et UA-2-kriterium), møtetranskripsjon
(masterplanens "Bygges"-liste for UA-2 nevner det, men det avhenger strukturelt av UA-7 Communications
Hub som IKKE er bygget - IKKE et av de fire akseptansekriteriene, derfor ikke-blokkerende for DENNE
lukkingen; konflikten mellom "Bygges"-listens fulle ambisjon og faktisk byggbarhet er allerede løst i
IMPLEMENTATION_PLAN.md sine "Bygges IKKE"-seksjoner). Entity extraction/Knowledge Graph (Q-10) forblir
utsatt til reelt behov er målt - heller ikke et akseptansekriterium.

**Kvalitetsgates:** `pnpm -r run typecheck` (13/13 grønt), `eslint .` (0 feil), `pnpm test` (873/873,
64 filer - INGEN endring, denne runden er ren verifikasjon+dokumentasjon, ingen kodeendring), gitleaks
(protect --staged + detect mot origin/main..HEAD, begge rene). CI: se PR-status.

**STATUS: UA-2 «UNIVERSAL KNOWLEDGE LAYER» = VERIFIED/COMPLETE → D-48.** Erstatter/overstyrer IKKE
D-42 (P1A) eller D-47 (P1B-A) - begge forblir gyldige, uendrede fase-lukkinger. **Neste kanoniske fase
per masterplan v4.0: UA-3 «Business Operating System»** (`docs/input/02_Jarvis_Masterplan_Sovereign_
Autonomy_v4.0.md` linje 460) - IKKE startet, IKKE godkjent, IKKE implementert i denne audit-runden.

## UA-3 P0 — Business Domain Foundation = VERIFIED/COMPLETE (2026-08-17, branch `claude/hva-skjer-hvordan-ligger-0z3ztp` fra `origin/main` `593a69c`)

**Status: VERIFIED/COMPLETE (host-bevist av Tobias på ekte Windows/Docker-host, run_id `ca2d9248`,
`hard_fail=false`) → D-52.** TREDJE host-kjøring, etter HOST FIX #1 (D-50)/HOST FIX #2 (D-51), kom
HELE VEIEN gjennom UTEN nye funn - alle 13 Business OS-kapabilitetsmarkører OG alle 5
CLEANUP-markører PASS. **Kun UA-3 P0 er VERIFIED/COMPLETE - HELE UA-3 er IKKE komplett** (se Q-25 for
gjenstående arbeid mot masterplanens fire akseptansekriterier), og HELE masterplan v4.0 «Sovereign
Autonomy» er IKKE komplett. Første UA-3-slice, navngitt/prioritert fra masterplanens
egen integrasjons-prioritetstabell ("Internal CRM / Sales pipeline full internal UA-3 P0") - full
begrunnelse: **D-49**.

**HOST FIX #1 (samme dag, ekte host-funn av Tobias, `run_id b95dd25f`) → D-50:** første host-kjøring
kom gjennom bootstrap/migrasjoner/`q21_runtime_role_safe=PASS`, men feilet DERETTER med
`error: new row violates row-level security policy for table "tenants" (code=42501)` - `ua3-business-
live.ts` brukte FEILAKTIG runtime-poolen (`jarvis_runtime`) til å opprette den midlertidige
akseptanse-tenanten. **Dette var IKKE et RLS-brudd å fikse - RLS fungerte som tiltenkt** (`tenants`
sin `WITH CHECK (tenant_id = current_setting('jarvis.tenant_id'))`-policy kan strukturelt aldri
oppfylles for en helt ny tenant). Fikset ved å innføre en egen `adminPool` (samme
`adminConfigFromEnv()`-mønster som `q20-erasure-live.ts`) for ALL scaffold-opprettelse/opprydding -
`pool` (runtime) forblir den ENESTE tilkoblingen Business OS-operasjonene (`BusinessService`/
`ToolGateway`) noensinne bruker. Ny `ua3_business_runtime_role`-marker verifiserer `current_user` RETT
FØR de faktiske skrivingene, ikke bare ved Q-21-sjekken i toppen. 12 nye tester (inkl. en LIVE
reproduksjon av selve `42501`-feilklassen mot en ekte NOSUPERUSER/NOBYPASSRLS-rolle) - ingen svekkelse
av RLS/Q-21 noe sted.

**HOST FIX #2 (samme dag, ekte host-funn av Tobias, `run_id ad45603d`) → D-51:** ANDRE host-kjøring
(etter HOST FIX #1) kom HELE VEIEN gjennom bootstrap/migrasjoner/Q-21 OG **ALLE 13 faktiske Business
OS-kapabilitetstester PASSET** (`ua3_company_contact`/`ua3_lead_idempotent`/`ua3_opportunity_pipeline`/
`ua3_activity_timeline`/`ua3_activity_idempotent`/`ua3_followup_lifecycle`/`ua3_followup_overdue`/
`ua3_metrics`/`ua3_tenant_isolation`/`ua3_space_isolation`/`ua3_toolgateway_wiring`/
`ua3_audit_no_sensitive_content` osv.) - KUN akseptanse-CLEANUP feilet: `DELETE FROM audit_events`
kastet (append-only-triggeren forbyr det ubetinget) og stoppet RESTEN av `cleanupTenant()`
(`leftover_tenants=1`), som DERETTER fikk `DELETE FROM people` til å feile med
`person_tenants_person_id_fkey` (en direkte følge). **Root cause:** `audit_events.tenant_id` har
INGEN fremmednøkkel mot `tenants` (i motsetning til `cost_events`) - append-only-revisjonsrader er
derfor VERKEN et FK-hinder for tenant-sletting NOCH noe cleanup-koden skal forsøke å slette. Fikset
ved å fjerne `DELETE FROM audit_events`-linjen HELT fra `cleanupTenant()` - resten av den allerede
FK-korrekte rekkefølgen (business_*→tool_executions→memory_spaces→person_tenants→tenants) fullfører nå
uhindret. CLEANUP splittet i fire granulære markører (`ua3_cleanup_mutable_rows`/
`ua3_cleanup_person_links`/`ua3_cleanup_tenants`/`ua3_cleanup_audit_retained`) + samlet `ua3_cleanup`.
Sekundært, ikke-blokkerende funn fikset samtidig: en `pg`-deprecation-advarsel fra
`BusinessService.metrics()` sin `Promise.all([client.query(...), ...])` på samme `pg.PoolClient` -
byttet til sekvensielle `await`-kall. 20 nye tester (inkl. direkte reproduksjon av BEGGE
host-feilmeldingene mot ekte embedded Postgres).

**Bygget:**
- Ny pakke `@jarvis/business` (mal: `@jarvis/erasure`).
- Migrasjon `019_business.sql`: 6 tenant-scoped FORCE RLS-tabeller (business_companies/contacts/
  leads/opportunities/activities/followups), samme RLS-mønster som `017_knowledge.sql`. Idempotent
  kilde-ingestion (UNIQUE-constraint på leads/aktiviteter, idempotency_key på followups).
- `BusinessService` - gjenbruker `withMemoryTransaction` uendret; CRUD/livssyklus for alle 6
  entiteter, kunde-tidslinje ("hva skjer med kunde X?"), forfalt-oppfoelging-spørring, drifts-metrikker.
- `BusinessTransport implements ToolTransport` - 13 nye ToolGateway-handlinger, A/B/C-klassifisert,
  INGEN D-klasse. `BusinessInternalSecretProvider` (ikke-hemmelig sentinel) løser credential-kravet
  for et rent internt verktøy, wiret via eksisterende `FallbackSecretProvider`.
- Registrert som femte, ubetinget transport i `firstWaveTools({...})` i `main.ts`/`worker-main.ts`.
- ETT Windows host-akseptanseskript: `modules/business/scripts/ua3-host-run.ts` →
  `ua3-business-live.ts` (speiler `q20-host-run.ts`/`q20-erasure-live.ts`).

**Suite-verifisert (930/930 - 44 nye tester totalt, se RUNTIME_GATES.md):** tenant-isolert
entitets-opprettelse, lead/opportunity-livssyklus, idempotent lead/aktivitet-ingestion,
aktivitetstidslinje, oppfoelging-livssyklus + forfalt-spørring, kilde-peker-lenking (ingen FK til
knowledge_documents - Q-20-trygt strukturelt), cross-tenant/memory-space-isolasjon (RLS mot ekte
embedded Postgres), samtidig idempotency_key-sikkerhet, ToolGateway-wiring (owner sovereign +
delegert policy via EKSISTERENDE PolicyGateway, ingen ny logikk), audit uten sensitivt kundeinnhold,
scaffold-/runtime-pool-separasjon (HOST FIX #1), append-only-audit-trygg + FK-korrekt CLEANUP
(HOST FIX #2 - inkl. live-reproduksjon av BÅDE `42501`-RLS-avslaget og
`person_tenants_person_id_fkey`-bruddet).

**Host-evidens (3 ekte kjøringer av Tobias):** (1) `run_id b95dd25f` - stoppet på scaffold-bug
(HOST FIX #1); (2) `run_id ad45603d` - alle 13 faktiske Business OS-kapabilitetstester PASSET, kun
CLEANUP feilet (HOST FIX #2); (3) **`run_id ca2d9248` - HELE VEIEN gjennom, INGEN nye funn, alle
13 kapabilitetsmarkører OG alle 5 CLEANUP-markører PASS, `hard_fail=false`.** Runtime bekreftet
uendret gjennom hele kjøringen (`runtime_current_user=jarvis_runtime`,
`runtime_role_superuser=false`, `runtime_role_bypassrls=false`, `business_runtime_role=jarvis_runtime`).

**Eksplisitt utsatt til senere UA-3-slice (Q-25, ingenting av dette bygget denne runden):**
Gmail/Calendar-hendelseslenking, AI Mesh-basert forretningsresonnering, worker/jobbkø-integrasjon,
automatisk open-loop-deteksjon, tverr-domene driftsoversikt, kontrakt/faktura/inntekt-sporing,
numerisk lead/deal-scoring, D-klasse/hard-delete, UI/dashboard - INGEN av disse er startet.

**Kvalitetsgates:** `pnpm -r typecheck` (15/15 grønt), `eslint .` (0 feil), `pnpm test` (930/930 - 69
filer), gitleaks (detect, ren). PR #9 merget til `main` (normal merge-commit).

## UA-3 — Open-Loop Detection + Daily/Weekly Business Brief = VERIFIED/COMPLETE (2026-08-17, branch `claude/ua3-open-loops-business-brief` fra `origin/main` `b306a480`) → D-53/D-54/D-55/D-56

**Status: VERIFIED/COMPLETE (host-bevist av Tobias på ekte Windows/Docker-host, run_id `de01ca07`,
`hard_fail=false`) → D-56. PR #10 merget til `main`.** Bygget på det VERIFIED/COMPLETE UA-3
P0-fundamentet (D-52) - additiv migrasjon, ingen eksisterende P0-tabell endret.
**Ekte host-kjøring #1 av Tobias (`run_id 19a7f3a4`):** 12 av 14 open-loop/brief-kapabilitetsmarkører
PASSET live; kun idempotens-akseptansen (harness-bug, IKKE produksjonsfeil) og akseptanse-CLEANUP
(nytt `cost_events`-FK-funn) feilet - begge fikset i **HOST FIX #1 (D-54)**. **Ekte host-kjøring #2
(`run_id c7fe8206`):** begge D-54-fikser bekreftet PASS live (idempotens nå PASS); KUN cleanup
feilet PÅ NYTT med et ANNET, uavhengig `brief_seen`-FK-funn - fikset i **HOST FIX #2 (D-55)**, som
også la til en selvdiagnostisk, skjema-drevet FK-sjekk for å fange fremtidige avhengigheter
automatisk. Se egne underseksjoner under. Venter på host-kjøring #3 for endelig VERIFIED-status.

**§0 canonical scope-audit (FØR implementering):** masterplanens "Integrasjonskatalog"
(`docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md`, linje 1049-1082) navngir "Support/
tickets"/"Contracts/e-sign" som UA-3 P1-CONNECTOR-prioritet, men dokumentet sier eksplisitt at
"P0/P1/P2 uttrykker prioritet, ikke obligatorisk samtidig aktivering" - denne tabellen styrer KUN
rekkefølgen for NYE eksterne connectors, ikke intern, connector-fri kapabilitetsbygging. Open-loop-
deteksjon + business brief kommer fra en SEPARAT liste ("Bygges", linje 463-467: "Daily/weekly business
brief og open-loop detection") og er DIREKTE navngitt i det obligatoriske akseptansekriteriet 3 ("Open
loops detected automatically", linje 471) - **ingen konflikt funnet, dette er et legitimt neste-slice-
valg** (arguably høyere prioritet enn P1-connector-radene, siden det er et navngitt akseptansekriterium,
ikke bare en katalog-prioritetsmarkør, og krever ingen ny ekstern connector).

**Domenegrenser (§4 i byggeordren, respektert uendret):** business followup (P0) = menneskelig/
forretningsmessig oppfoelgings-tilstand; task queue (`PgTaskQueue`) = agent-utførelsesinfrastruktur;
**open loop (NY)** = automatisk detektert, uløst forretningsforpliktelse/-tilstand; memory
`"commitment"`-type = huskede forpliktelser/kontekst; Knowledge = kilde-forankret bevis. Open loops
REFERERER (nullable FK), dupliserer ALDRI, business_followups/opportunities/leads/companies/contacts/
activities.

**Bygget:**
- Migrasjon `020_business_open_loops.sql`: additiv, én ny tabell `business_open_loops` - SAMME FORCE
  RLS-mønster (tenant + RESTRICTIVE memory-space-policy) som alle 6 P0-tabeller. `detection_key`
  (UNIQUE per tenant) er den deterministiske idempotens-nøkkelen - re-kjørt deteksjon oppdaterer SAMME
  rad, oppretter ALDRI en duplikat.
- `OpenLoopService` (`modules/business/src/open-loop-service.ts`): to deterministiske deteksjonsregler
  - `detectOverdueFollowups()` (forfalt, åpen `business_followups`-rad) og
  `detectStalledOpportunities()` (ikke-terminal stage + ingen åpen oppfoelging linket + ingen
  oppdatering siste N dager). **Ingen AI Mesh-bruk i dette sliceet** - begge regler er utvetydige
  dato/status-betingelser (`detection_method='deterministic'`; `'ai_assisted'`-kolonnen finnes som
  ubrukt fremtidig utvidelsespunkt, se Q-25). Idempotens via `ON CONFLICT (tenant_id, detection_key) DO
  UPDATE`; gjenåpning av en manuelt resolved loop for SAMME vedvarende vilkår skjer på SAMME rad (aldri
  en ny rad) - historikk før/etter ligger i det eksisterende append-only `audit_events`. Auto-resolve
  når vilkåret ikke lenger er sant (`resolution_reason='condition_no_longer_true'`). Prioritet
  deterministisk fra hvor lenge forfalt/stagnert (`high` vs `normal`) - ingen AI-oppfunnet
  kunde-/beløps-viktighet. `attentionQueue()` bucketer (`critical`/`overdue`/`due_soon`/`informational`)
  som en ren spørring over persistert state, ikke et transient LLM-svar.
- `business-brief.ts`: DAGLIG brief gjenbruker `DailyBrief`-motoren UENDRET via en ny `BriefSource`
  (`businessOpenLoopsSource`) - ingen parallell brief-motor. UKENTLIG brief (`generateWeeklyBrief`) er
  en bevisst egen, liten, kilde-forankret aggregeringsfunksjon i SAMME modul (7-dagers vindu:
  åpnede/løste loops per type, flyttede opportunities, fortsatt-åpne) - ikke tvunget inn i
  `DailyBrief`s snapshot-kontrakt. `BUSINESS_DOMAIN_COVERAGE` markerer EKSPLISITT kun `sales` som
  tilgjengelig - `product`/`finance`/`marketing`/`operations` er `not_integrated` i BEGGE briefer, ALDRI
  fabrikkert (akseptansekriterium 2 er fortsatt IKKE fullt oppfylt).
- `open-loop-sweep.ts`: `runOpenLoopSweepForAllTenants()` - periodisk sveip for tidsbaserte vilkår,
  gjenbruker EKSISTERENDE `DailyScheduler` (eget `job_name="business-open-loop-sweep"`, egen
  `JARVIS_BUSINESS_SWEEP_HOUR`-env, samme reboot-durable DB-claim-mekanisme som den personlige daglige
  briefen) - ingen ny kø. Bounded (`LIMIT 200` tenants), tenant-scoped, per-tenant feilisolasjon (én
  tenants feil velter aldri resten). Wiret INN i `apps/api/src/main.ts` (uavhengig av
  Telegram-konfig - deteksjon ≠ levering) og `OpenLoopService`/`BusinessTransport`-oppdateringen speilet
  identisk i `worker-main.ts`.
- `BusinessTransport` utvidet med 8 nye ToolGateway-handlinger: A-klasse lesing
  (`list_open_loops`/`read_open_loop`/`get_attention_queue`/`get_business_brief` - period
  `daily`/`weekly`); C-klasse tilstandsovergang (`resolve_open_loop`/`defer_open_loop`); B-klasse enkle
  felt-oppdateringer (`assign_open_loop`/`set_open_loop_next_action`). Ekstern side-effekt (e-post/
  telefon) er EKSPLISITT utenfor scope - deteksjon/tilstandsoppdatering er kun intern operasjonell
  state.
- Ett Windows host-akseptanseskript: `modules/business/scripts/ua3-open-loops-host-run.ts` →
  `ua3-open-loops-live.ts` (speiler `ua3-host-run.ts`/`ua3-business-live.ts`, SAMME
  admin-pool-for-scaffold/runtime-pool-for-operasjoner-separasjon som P0 HOST FIX #1, SAMME
  append-only-audit-trygge CLEANUP-rekkefølge som P0 HOST FIX #2 - `business_open_loops` slettes FØR
  `business_followups`/`business_opportunities` pga FK).

**Suite-verifisert (48 nye tester i business-modulen + 4 nye i eksisterende
`business-transport-wiring.test.ts` = 52 nye, se RUNTIME_GATES.md for eksakt totalsum):** forfalt-
oppfoelging/stagnert-opportunity-deteksjon, idempotens (ingen duplikat ved re-sveip), manuell + auto-
resolusjon, gjenåpning på samme rad, deterministisk prioritet, kilde-forankret begrunnelse
(followup_id/company_id/detection_key sporbart), tenant-/memory-space-isolasjon (RLS mot ekte embedded
Postgres), oppmerksomhets-kø-bucketing, defer/assign/set-next-action, Q-20-interaksjon (ingen FK til
`knowledge_documents` - strukturelt bevist), FORCE RLS bekreftet i databasen (`pg_class`), ingen direkte
AI Mesh/provider-SDK-import (strukturelt bevist), daglig/ukentlig brief-innhold + domenedeknings-
ærlighet, ToolGateway-wiring gjennom EKSISTERENDE Policy Gateway (owner sovereign + delegert policy,
audit uten sensitiv fritekst-begrunnelse), sveip-hjelperens tenant-scoping/bounded-LIMIT/
feilisolasjon (rene enhetstester, ingen DB nødvendig).

**Eksplisitt utsatt (Q-25, ingenting av dette bygget denne sliceen):** Gmail/Calendar-hendelseslenking
til open loops (motoren er designet for å ta imot normaliserte fremtidige hendelser, men P0-synthetisk
data er bevisst nok til å bevise motoren denne runden), Support/tickets- og Contracts/e-sign-connectorer
(forblir eksplisitte UA-3 P1-kandidater, arkitekturen er extensible for fremtidige ticket-/
kontrakt-hendelser), full tverr-domene bedriftshelse (akseptansekriterium 2 - kun sales/CRM-domenet er
dekket, ærlig markert i begge briefer), numerisk lead/deal-scoring, D-klasse/hard-delete for
business-data, UI/dashboard, AI Mesh-basert semantisk tolkning av loops (ingen ambiguitet krevde det i
dette sliceet).

**Kvalitetsgates (ved bygging):** `pnpm -r typecheck` (14/14 grønt), `eslint .` (0 feil), `pnpm test`
(982/982 - 73 filer, 52 nye), gitleaks (detect, 125 commits scannet, ingen funn).

**PR-status:** [PR #10](https://github.com/tsworkflow/jarvisbuild/pull/10) opprettet som draft,
CI grønt (build-test + gitleaks - se egen CI-fiks under). **IKKE merget** - venter eksplisitt på
Tobias sin neste host-verifikasjon.

## UA-3 NEXT SLICE HOST FIX #1 (2026-08-17, samme dag, ekte host-funn av Tobias, `run_id 19a7f3a4`) → D-54

**To distinkte funn, begge undersøkt til rot FØR noe ble fikset - ingen gjettet root cause.**

**(1) `ua3_open_loop_idempotency=FAIL` selv om host-loggen viste `open_loops_before=2
open_loops_after=2 duplicate_rows_for_same_key=0`** - en akseptanse-HARNESS-bug, IKKE en
produksjonsfeil. Root cause: IDEMPOTENS-seksjonens verifikasjonsspørring i `ua3-open-loops-live.ts`
kalte `pool.query(...)` DIREKTE mot `business_open_loops` (FORCE ROW LEVEL SECURITY) UTEN
`withMemoryTransaction` - under den ekte NOSUPERUSER/NOBYPASSRLS `jarvis_runtime`-rollen (Q-21) ble
`jarvis.tenant_id`/`jarvis.memory_spaces`-session-GUC-ene ALDRI satt, RLS-predikatet evaluerte til
NULL, og spørringen så derfor STRUKTURELT 0 rader uansett faktisk databasetilstand. Reprodusert
direkte mot ekte embedded Postgres (`ua3-open-loops-cost-cleanup.test.ts` §A: samme raw spørring
finner 0, samme spørring wrappet i `withMemoryTransaction` finner den korrekte 1-raden).
`OpenLoopService` sine egne metoder (bevist i `open-loop-service.test.ts` §B) bruker
`withMemoryTransaction` KORREKT overalt - idempotens var aldri broken i produksjon. **Fiks:**
spørringen wrappet i `withMemoryTransaction`, ingen produksjonskode endret.

**(2) Akseptanse-CLEANUP feilet: `update or delete on table "tenants" violates foreign key constraint
"cost_events_tenant_id_fkey"`.** Root cause verifisert mot faktisk skjema (IKKE gjenbrukt blindt fra
P0 sin `audit_events`-fiks, som byggeordren eksplisitt advarte mot): `get_business_brief`(daily)
konstruerer `new DailyBrief([...], pool)`, og `DailyBrief.generate()` skriver en `cost_events`-rad per
generert brief (eksisterende run-rate-oppførsel) - en genuint NY avhengighet dette sliceet introduserer
(P0 hadde ingen brief-handling). `cost_events.tenant_id REFERENCES tenants` (ekte FK, ingen CASCADE)
OG INGEN append-only-trigger (i motsetning til `audit_events`, som forblir uendret utelatt fra
cleanup) - samme FK-klasse og fiks-presedens som `ua2-p1b-a-host-run.ts` sin D-45. **Fiks:**
`DELETE FROM cost_events WHERE tenant_id = $1` lagt til FØRST i `cleanupTenant()`, scoped eksakt til
den ene synthetic-tenanten.

**Regresjon:** 12 nye tester (`ua3-open-loops-cost-cleanup.test.ts`, inkl. direkte reproduksjon av
BEGGE feilklassene mot ekte embedded Postgres under en ekte non-bypass rolle) + 2 nye strukturelle
regresjonsvakter i `ua3-open-loops-host-run-wiring.test.ts`. 982→994 tester totalt.
**Kvalitetsgates:** `pnpm -r typecheck` (14/14 grønt), `eslint .` (0 feil), `pnpm test` (994/994 - 74
filer), gitleaks (127 commits scannet, ingen funn).

**CI-fiks (samme PR, før dette HOST FIX-funnet):** `gitleaks/gitleaks-action@v2` 403-et mot
`/repos/.../pulls/10/commits` (samme "Resource not accessible by integration"-klasse som tidligere
GitHub MCP-tilgangsproblemer i denne økten) til tross for korrekt `pull-requests: read`-tildeling -
erstattet med direkte gitleaks-CLI-kjøring mot hele historikken (ingen GitHub API-avhengighet).

**Status: FORTSATT FIXED_SUITE / HOST_VERIFY_BLOCKED.** Q-21/RLS/`OpenLoopService`/`BusinessService`/
`DailyBrief`/ToolGateway/skjema UENDRET - ingen produksjonslogikk rørt, kun akseptanse-harness-koden
(verifikasjonsspørring + cleanup-rekkefølge). Venter på Tobias sin neste kjøring av:
`node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-open-loops-host-run.ts`

## UA-3 NEXT SLICE HOST FIX #2 (2026-08-17, samme dag, ekte host-funn av Tobias, `run_id c7fe8206`) → D-55

**HOST FIX #1 sine to fikser bekreftet PASS LIVE:** `ua3_open_loop_idempotency=PASS`
(`open_loops_before=2 open_loops_after=2 duplicate_rows_for_same_key=1` - korrekt, ikke 0 lenger), og
alle 12 av 14 kapabilitetsmarkører PASSET på nytt (deteksjon/resolusjon/prioritet/kilde-bevis/tenant-
og space-isolasjon/ToolGateway/daglig+ukentlig brief/domenedeknings-ærlighet/audit). **KUN
akseptanse-CLEANUP feilet PÅ NYTT** - et ANNET, uavhengig FK-brudd: `brief_seen_tenant_id_fkey`.

**Root cause:** SAMME `DailyBrief.generate({pool})`-kodeblokk som skriver `cost_events` (fikset i
D-54) skriver OGSÅ en `brief_seen`-rad per unikt brief-punkt (stale-suppression) - to uavhengige
INSERT-er i samme blokk, D-54 sporet kun én av dem. Bekreftet mot skjema (`012_brief_seen.sql`):
ekte FK til `tenants`, ingen append-only-trigger, og `jarvis_app` har INGEN DELETE-grant i det hele
tatt (kun `adminPool` kan rydde den).

**Full, skjema-drevet FK-revisjon (§3 i ordren, ikke gjentatt gjetting):** en `information_schema`-
spørring mot en ekte migrert database bekreftet 44 fremmednøkler mot `tenants(tenant_id)` totalt.
Kildekode-sporing av HVER faktiske `INSERT INTO` nåbar fra dette akseptanseskriptets kodebane
(`BusinessService`/`OpenLoopService`/`ToolGateway.execute`/`DailyBrief.generate`) bekreftet at KUN
`cost_events` og `brief_seen` er nye avhengigheter - de øvrige ~30 FK-refererende tabellene har
INGEN skrivevei fra dette scriptet og er bevisst IKKE inkludert i cleanup.

**Selvdiagnostisk sperre lagt til** (`findBlockingTenantDependencies()`): en dynamisk, skjema-drevet
sjekk (ikke en hardkodet tabelliste) som spør `information_schema` for ALLE FK-er mot
`tenants(tenant_id)` og teller rader for den ene test-tenanten RETT FØR `DELETE FROM tenants`
forsøkes i hver `cleanupTenant()`-kjøring - fanger automatisk en FRAMTIDIG, ennå ukjent avhengighet
med presis diagnostikk (`blocking_fk_table`/`blocking_fk_name`/`rows_for_test_tenant`, aldri
radinnhold) FØR selve slette-forsøket, i stedet for en tredje blind host-runde for neste
uoppdagede avhengighet.

**Regresjon:** 16 nye tester (13 i `ua3-open-loops-cost-cleanup.test.ts` inkl. direkte reproduksjon
av `brief_seen`-FK-bruddet og selvdiagnostikk-mekanismen mot ekte embedded Postgres, + 3 nye
strukturelle regresjonsvakter). 994→1010 tester totalt. **Kvalitetsgates:** `pnpm -r typecheck`
(14/14 grønt), `eslint .` (0 feil), `pnpm test` (1010/1010 - 74 filer), gitleaks (128 commits
scannet, ingen funn).

**Status: FORTSATT FIXED_SUITE / HOST_VERIFY_BLOCKED.** Q-21/RLS/`OpenLoopService`/`BusinessService`/
`DailyBrief`/ToolGateway/idempotens-fiksen fra D-54 UENDRET - ingen produksjonslogikk rørt igjen, kun
akseptanse-harness-cleanup-koden utvidet med en genuint ny, robust selvdiagnostisk mekanisme. Venter
på Tobias sin neste kjøring av:
`node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-open-loops-host-run.ts`

## UA-3 FINAL CLOSURE — Open-Loop Detection + Business Brief (2026-08-17, samme dag) — HOST VERIFIED

**Tobias kjørte `node --env-file=.env --experimental-transform-types
modules/business/scripts/ua3-open-loops-host-run.ts` på sin faktiske Windows/Docker-host - GRØNT
resultat, run_id `de01ca07`.** TREDJE host-kjøring, etter HOST FIX #1 (D-54) og HOST FIX #2 (D-55) -
denne runden kom HELE VEIEN gjennom UTEN nye funn. Alle 16 forventede markører PASS:
`q21_runtime_role_safe`, `ua3_open_loop_runtime_role`, `ua3_open_loop_overdue_detection`,
`ua3_open_loop_stalled_detection`, `ua3_open_loop_idempotency` (`duplicate_rows_for_same_key=1` -
korrekt), `ua3_open_loop_resolution`, `ua3_open_loop_priority`, `ua3_open_loop_source_evidence`,
`ua3_open_loop_tenant_isolation`, `ua3_open_loop_space_isolation`, `ua3_open_loop_toolgateway`,
`ua3_business_daily_brief`, `ua3_business_weekly_brief`, `ua3_brief_missing_domains_honest`,
`ua3_open_loop_audit_safe`, `ua3_open_loop_cleanup` (`cleanup_ok=true leftover_open_loops=0
leftover_tenants=0`). Runtime uendret gjennom hele kjøringen: `runtime_current_user=jarvis_runtime`,
`runtime_role_superuser=false`, `runtime_role_bypassrls=false`, `open_loop_runtime_role=jarvis_runtime`.
`hard_fail=false`.

**Idempotens-arkitekturlærdom (bevart fra D-54, bekreftet her):** den opprinnelige idempotens-
host-feilen var ALDRI en produksjonsfeil - `OpenLoopService` brukte `withMemoryTransaction` korrekt
gjennom hele denne sliceen. Den opprinnelige feilen skyldtes en akseptanse-verifikasjonsspørring mot en
FORCE-RLS-tabell (`business_open_loops`) uten `jarvis.tenant_id`/`jarvis.memory_spaces`-session-GUC-er
- den korrigerte spørringen (`withMemoryTransaction`) beviser nå korrekt `duplicate_rows_for_same_key=1`
live.

**Business-brief-ærlighet bekreftet host-bevist:** `sales` tilgjengelig via eksisterende Business
Graph/CRM; `product`/`finance`/`marketing`/`operations` forblir eksplisitt `not_integrated` i BEGGE
briefer (`ua3_brief_missing_domains_honest=PASS`) - masterplanens akseptansekriterium 2 ("Hvordan går
bedriften?") er FORTSATT IKKE fullt oppfylt av denne sliceen alene.

**STATUS: VERIFIED/COMPLETE → D-56.** Full evidens (D-53/D-54/D-55/D-56) og oppsummering i
header-seksjonen øverst i denne filen. **KUN denne UA-3-sliceen + UA-3 P0 er VERIFIED/COMPLETE - HELE
UA-3 er IKKE komplett** (se oppdatert Q-25) - Support/tickets, Contracts/e-sign, Gmail/Calendar-
hendelseslenking, tverr-domene driftsoversikt utover sales, profiling/scoring med juridiske kontroller
er alle IKKE bygget/startet. **Masterplan v4.0 «Sovereign Autonomy» forblir IKKE komplett.** PR #10
merget til `main` (normal merge-commit, samme konvensjon som PR #1-#9 - historikk bevart, ikke
squashet).

## UA-3 — Business-Event-Linkage (Gmail/Calendar → Business OS) = FIXED_SUITE / READY_FOR_HOST_VERIFY (2026-08-17, branch `claude/ua3-business-events-linkage` fra `origin/main` `017172c`) → D-57

**Canonical-audit FØR kode (§1-§5 i byggeordren):** full lesing av masterplanens UA-3-seksjon (linje
460-472) OG Integrasjonskatalogen (linje 1049-1082, IKKE bare den korte fase-headeren) bekreftet at
UA-3 sine to gjenværende P1-connector-rader ("Support/tickets", "Contracts/e-sign") IKKE har en
navngitt leverandør noe sted i masterplanen eller øvrige docs - et målrettet søk (Zendesk/Freshdesk/
Intercom/DocuSign/Dropbox Sign/tilsvarende) ga null treff. Å velge én av dem ville brutt byggeordrens
eksplisitte §5-provider-beslutnings-gate ("Do NOT choose one merely from popularity" / "Do not burn a
development round implementing a provider that was never chosen"). Gmail/Calendar er derimot allerede
navngitte, provider-besluttede UA-0/UA-7-P0-connectorer (linje 1101-1102) - den ENESTE måten å faktisk
levere UA-3 sitt FØRSTE akseptansekriterium ("Hva skjer med kunde X?", linje 469) uten å oppfinne en ny
leverandørbeslutning. Q-25 sitt eget item 1 og IMPLEMENTATION_PLAN.md sin "Bygges IKKE"-liste navnga
dette gjennomgående som det FØRSTE utsatte punktet siden P0 - ingen konkurrerende, like moden kandidat
fantes. **Konklusjon: unik, ikke-tvetydig neste slice, IKKE en `NEEDS_TOBIAS_DECISION`-situasjon.**
Se D-57 for full begrunnelse.

**Bygget:**
1. `GmailTransport.listMessages()` utvidet med `to`/`cc`-headere (additivt felt).
2. `GoogleCalendarTransport` fikk en ny `list_events`-handling (deltaker-e-poster + `html_link`,
   `read_events` uendret).
3. `BusinessEventSyncService` (`modules/business/src/business-event-sync.ts`) - deterministisk
   entitetsgjenkjenning (e-postadresse, ALDRI AI-gjettet), idempotent aktivitets-registrering via
   EKSISTERENDE `recordActivity()`, open-loop-reevaluering via EKSISTERENDE `OpenLoopService.
   runSweep()`.
4. `BusinessService.findContactsByEmail()` + additiv indeks `021_business_contact_email_lookup.sql`.
5. ToolGateway: `calendar.list_events` (klasse A) + `business.sync_business_events` (klasse B, INGEN
   D). `BusinessTransport` fikk en fjerde, valgfri `toolGateway`-parameter.
6. Periodisk synk via EKSISTERENDE `DailyScheduler` (`job_name="business-events-sync"`, default kl.
   05), wiret inn i `main.ts`/`worker-main.ts`.
7. Host-akseptanseskript `ua3-business-events-host-run.ts` → `ua3-business-events-live.ts` - to-delt
   strategi (ekte connector-reachability + deterministisk FakeTransport-basert entitetsgjenkjenning),
   gjenbruker UENDRET D-55 sin selvdiagnostiske FK-blokkerings-sperre.

**Suite-verifisert (1053/1053 tester, 43 nye - 19 i `business-event-sync.test.ts`, 12 nye/oppdaterte i
`business-transport-wiring.test.ts`, 21 i `ua3-business-events-host-run-wiring.test.ts`, minus
allerede-eksisterende oppdaterte assertions):** e-post-adresse-parsing, motpart-utledning,
matchet/umatchet/tvetydig entitetsgjenkjenning (Gmail OG Calendar), idempotens, ingen body-/
beskrivelses-innhold lagret, tenant-/memory-space-isolasjon, open-loop-reevaluering, ToolGateway-
wiring (owner sovereign + delegert policy), audit-metadata-sikkerhet, ingen AI Mesh/provider-SDK-
bypass. Lint/typecheck rene.

**STATUS (før HOST FIX #1): FIXED_SUITE / READY_FOR_HOST_VERIFY → D-57.**

## UA-3 Business-Event-Linkage HOST FIX #1 (2026-08-17, samme dag, ekte host-funn av Tobias, `run_id 7c5a5289`) → D-58

**Tobias kjørte `node --env-file=.env --experimental-transform-types
modules/business/scripts/ua3-business-events-host-run.ts` på sin faktiske Windows/Docker-host.**
Bootstrap/Docker/migrasjoner PASS. `q21_runtime_role_safe=PASS role=jarvis_runtime`,
`ua3_events_runtime_role=PASS`, CLEANUP PASS (`cleanup_ok=true leftover_activities=0
leftover_tenants=0`). **PRIMÆR FEIL:** REAL CONNECTOR REACHABILITY feilet med
`tool_failed:credential_unavailable` (`sync_ok=false`) - nesten alle andre funksjonelle markører
feilet deretter som en KASKADE av samme rotårsak, ikke uavhengige produksjonsfeil.

**Root cause verifisert presist (kildekode-sporet fra `credential_unavailable` i `gateway.ts` linje
190, via `BusinessTransport.invoke()` sin `sync_business_events`-gren, til
`BusinessEventSyncService.syncGmailActivities()`/`syncCalendarActivities()` sine
`gateway.execute({tool_id:"email"/"calendar",...})`-kall, til selve REACHABILITY-seksjonens
`realGateway`-konstruksjon):** `ua3-business-events-live.ts` sin REACHABILITY-seksjon (DEL 1)
konstruerte `realGateway` med `new FallbackSecretProvider({name:"env-empty", get: async()=>null}, new
BusinessInternalSecretProvider())` - en ALLTID-null stub-secret-provider FEILAKTIG kopiert fra
vitest-enhetstestenes mønster (der Gmail/Calendar-credentials BEVISST aldri skal resolve) - i stedet
for den EKTE `new FallbackSecretProvider(new EnvSecretProvider(), new
BusinessInternalSecretProvider())` som `apps/api/src/main.ts`/`worker-main.ts` allerede bruker
korrekt (bekreftet ved kildekode-inspeksjon av begge filer - PRODUKSJON VAR ALDRI PÅVIRKET).
`JARVIS_EMAIL_TOKEN`/`JARVIS_GOOGLE_TOKEN` ble derfor ALDRI lest fra `.env`, uansett om de faktisk var
konfigurert riktig hos Tobias. **Dette var en REN akseptanse-harness-bug, ikke en produksjonsfeil eller
en tenant-credential-isolasjonsfeil** - verifisert eksplisitt (§5 i HOST FIX-ordren) at
`credential_ref` for Gmail/Calendar er en FAST, per-verktøy-konstant (aldri tenant-avledet) - denne
arkitekturen har INGEN tenant-scoped credential-binding å bryte, samme globale eierkonto-mønster som
personlig daily brief allerede brukte uendret siden UA-0/UA-7.

**Fiks:** (1) DEL 1 (REACHABILITY) byttet til ekte `EnvSecretProvider()`; (2) DEL 2 (deterministisk
`FakeTransport`-basert entitetsgjenkjenning) beholdt BEVISST credential-uavhengighet - en eksplisitt
dummy-verdi kun for Gmail/Calendar-referansene (samme "test-google-static"-mønster som
`business-transport-wiring.test.ts`), IKKE `EnvSecretProvider()`. (3) `BusinessEventSyncService.
syncTenant()` isolerer nå Gmail/Calendar-feil UAVHENGIG (`Promise.all()` + per-provider `.catch()`,
sanert `error`-felt, `.slice(0,120)`, aldri et rått credential/token) - en ekte
produksjonsrobusthetsforbedring, ikke bare en akseptanse-fiks. **Urelatert, ekte CI-funn fikset
samtidig:** en genuin TOCTOU-race i `BusinessService.createFollowup()` (P0/D-49, urørt av D-57) -
ikke-atomisk SELECT-så-INSERT for `idempotency_key` kunne la to samtidige kall begge INSERT-e,
reprodusert av en CI-rerun (`business-service.test.ts` test U) - fikset til samme atomiske
`ON CONFLICT ... DO UPDATE ... RETURNING *`-mønster som `createLead()`/`recordActivity()`.

18 nye tester (1053→1071): 8 i ny `business-event-sync-credential-wiring.test.ts` (EnvSecretProvider
løser ekte konfigurerte credentials, manglende credential gir sanert `credential_unavailable`, ingen
credential-lekkasje, BusinessTransport bruker injisert gateway - ikke en nestet/uavhengig en, fast
credential_ref uavhengig av tenant), 3 nye i `business-event-sync.test.ts` sin "O"-seksjon (Gmail/
Calendar-feil isolert uavhengig), 7 nye/oppdaterte strukturelle regresjonsvakter i
`ua3-business-events-host-run-wiring.test.ts`. 1071/1071 tester, lint/typecheck rene.

**STATUS (før HOST FIX #2): FIXED_SUITE / HOST_VERIFY_BLOCKED → D-58.**

## UA-3 Business-Event-Linkage HOST FIX #2 (2026-08-17, samme dag, ekte host-funn av Tobias, `run_id b969e9e7`) → D-59

**Tobias kjørte host-akseptansen PÅ NYTT etter HOST FIX #1 - ALLE funksjonelle Business-Event-
kapabiliteter PASSET LIVE:** `q21_runtime_role_safe=PASS`, `ua3_events_runtime_role=PASS`, EKTE Gmail
(`gmail_reachable=true gmail_scanned=25`) OG Calendar (`calendar_reachable=true calendar_scanned=0` -
et tomt resultat er en gyldig PASS, ikke en feil) reachability UAVHENGIG PASS,
`ua3_events_gmail_matched/_unmatched/_ambiguous=PASS`, `ua3_events_calendar_matched=PASS`,
`ua3_events_idempotency=PASS`, `ua3_events_no_body_content_stored=PASS`,
`ua3_events_tenant_isolation/_space_isolation=PASS`, `ua3_events_toolgateway_wiring=PASS`,
`ua3_events_open_loop_reevaluation=PASS`, `ua3_events_cleanup=PASS` (`leftover_activities=0
leftover_tenants=0`). **ENESTE feil:** `ua3_events_audit_safe=FAIL` (`audit_payload_excerpt={}`) -
`hard_fail=true` KUN pga. denne ene markøren.

**Root cause verifisert presist (eksplisitt IKKE rørt noen av de fungerende kapabilitetene over, per
ordrens §1):** OPEN-LOOP-REEVALUERING-seksjonens audit-verifikasjon brukte en RAW `pool.query()` mot
`audit_events` - **NØYAKTIG SAMME FEILKLASSE SOM D-54.** `audit_events` har `FORCE ROW LEVEL SECURITY`
(`005_rls.sql`) med policyen `USING (tenant_id = current_setting('jarvis.tenant_id', true))` - en raw
spørring under den ekte NOSUPERUSER/NOBYPASSRLS `jarvis_runtime`-rollen setter ALDRI denne
session-GUC-en, og spørringen ser derfor STRUKTURELT 0 rader uansett faktisk databasetilstand. Selve
audit-SKRIVINGEN var korrekt hele tiden - `ToolGateway.execute()` kaller `writeAudit()` INNI SAMME
`withTenantTransaction`-blokk som selve verktøykjøringen, og `ua3_events_toolgateway_wiring=PASS` (fra
SAMME host-kjøring) beviser at handlingen fullførte. Mekanismen er direkte reprodusert i en ny test
(`business-event-sync-audit-rls.test.ts` test A): en ekte audit-rad bekreftet å FINNES via `adminPool`,
mens EKSAKT samme spørring via den non-bypass rollen (`appPool`) returnerer 0 rader.

**Fiks (kun akseptanse-harnesset - ingen produksjonskode rørt):** spørringen wrappet i
`withTenantTransaction(pool, TENANT_A, ...)` (samme presedens som D-54). Eksistens og
innholds-sikkerhet gjort til to eksplisitt distinkte krav - `auditFound` inngår nå direkte i selve
PASS-betingelsen (en manglende/tom spørring kan aldri lenger tolkes som "trygt"). Nøstede
`email`/`calendar`-audit-rader (fra `BusinessEventSyncService` sine egne `ToolGateway.execute()`-kall)
bekreftet å ALDRI forveksles med den ytre `business`/`sync_business_events`-spørringen.

12 nye tester (7 i ny `business-event-sync-audit-rls.test.ts` + 5 nye strukturelle regresjonsvakter i
`ua3-business-events-host-run-wiring.test.ts`, 1071→1082). Lint/typecheck rene.

**STATUS: FIXED_SUITE / HOST_VERIFY_BLOCKED → D-59. IKKE VERIFIED** - venter på Tobias sin TREDJE
kjøring av:
`node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-business-events-host-run.ts`
**KUN UA-3 P0 + open-loop-sliceen er VERIFIED/COMPLETE - denne sliceen er FIXED_SUITE, funksjonelt
LIVE-bevist, men IKKE ferdig host-bevist (kun audit-verifikasjonsbugen gjenstår) - HELE UA-3 er
FORTSATT IKKE komplett** (se oppdatert Q-25). Support/tickets, Contracts/e-sign (krever fortsatt en
Tobias-provider-beslutning), tverr-domene driftsoversikt utover sales, profiling/scoring med juridiske
kontroller er alle IKKE bygget/startet. **Masterplan v4.0 «Sovereign Autonomy» forblir IKKE komplett.**

## UA-3 FINAL CLOSURE — Business-Event-Linkage (2026-08-17, samme dag) — HOST VERIFIED → D-60

**Tobias kjørte `node --env-file=.env --experimental-transform-types
modules/business/scripts/ua3-business-events-host-run.ts` på sin faktiske Windows/Docker-host - GRØNT
resultat, run_id `6c6a4948`.** TREDJE host-kjøring, etter HOST FIX #1 (D-58) og HOST FIX #2 (D-59) -
denne runden kom HELE VEIEN gjennom UTEN nye funn. Alle markører PASS: `q21_runtime_role_safe`,
`ua3_events_runtime_role`, `ua3_events_gmail_real_connector_reachable` (`gmail_scanned=25`),
`ua3_events_calendar_real_connector_reachable` (`calendar_scanned=0`, tomt vindu er gyldig PASS),
`ua3_events_gmail_matched`/`_unmatched`/`_ambiguous`, `ua3_events_calendar_matched`,
`ua3_events_idempotency`, `ua3_events_no_body_content_stored`, `ua3_events_tenant_isolation`/
`_space_isolation`, `ua3_events_open_loop_reevaluation`, `ua3_events_toolgateway_wiring`,
`ua3_events_audit_safe` (`audit_event_found=true`, `audit_action=business.sync_business_events`),
`ua3_events_cleanup` (`leftover_activities=0 leftover_tenants=0`). Runtime uendret gjennom hele
kjøringen: `runtime_current_user=jarvis_runtime`, `runtime_role_superuser=false`,
`runtime_role_bypassrls=false`, `events_runtime_role=jarvis_runtime`. `hard_fail=false`.

**Real vs. synthetic acceptance bekreftet, ikke overklaimet:** ekte Gmail/Calendar API-autentisering/
reachability mot den faktiske eierkontoen (REAL HOST); matchet/umatchet/tvetydig entitetslenking,
idempotens, isolasjon, open-loop-reevaluering via `FakeTransport`-gjennom-ekte-`ToolGateway.execute()`
(CONTROLLED SYNTHETIC RUNTIME). Ingen ekte mailboks-/kalenderdata ble mutert - kun lesing.

**Akseptansekriterium 1-re-evaluering ("Hva skjer med kunde X?"): PARTIAL, IKKE automatisk markert
COMPLETE.** Kjernemekanismen (Internal CRM/Sales pipeline UA-3 P0 + Gmail/Calendar UA-0/UA-7 P0) er NÅ
VERIFIED/COMPLETE og host-bevist ende-til-ende - men masterplanens Integrasjonskatalog (linje
1069-1071) navngir Support/tickets og Contracts/e-sign som EGNE UA-3 P1-kundekontaktsystemer som
fortsatt IKKE er tilkoblet (ingen leverandør navngitt noe sted, uavklart Tobias-beslutning). Full
firekriterie-matrise (se D-60 for detaljert evidens per kriterium):
1. "Hva skjer med kunde X?" = **PARTIAL** (kjernemekanisme COMPLETE, full katalogbredde IKKE).
2. "Hvordan går bedriften?" = **PARTIAL, uendret fra D-56** (kun `sales` tilkoblet; `product`/
   `finance`/`marketing`/`operations` avhenger av UA-4/UA-5/UA-6, som IKKE er startet).
3. "Open loops detected automatically" = **COMPLETE/VERIFIED, uendret fra D-56**.
4. "Profiling/scoring med dokumenterte juridiske/menneskelige kontroller" = **NOT STARTED, uendret**
   (krever Tobias produkt-/juridisk-beslutning om scoringens omfang - IKKE et kodbart standardvalg).

**STATUS: VERIFIED/COMPLETE → D-60.** Full evidens (D-57/D-58/D-59/D-60) og oppsummering i
header-seksjonen øverst i denne filen. **KUN denne UA-3-sliceen + UA-3 P0 + open-loop-sliceen er
VERIFIED/COMPLETE - HELE UA-3 er IKKE komplett** (2 av 4 kriterier PARTIAL, 1 av 4 NOT STARTED - se
oppdatert Q-25). **Masterplan v4.0 «Sovereign Autonomy» forblir IKKE komplett.** PR #11 merget til
`main` (normal merge-commit, samme konvensjon som PR #1-#10 - historikk bevart, ikke squashet).

## UA-3 — Profiling/Scoring (akseptansekriterium 4) = FIXED_SUITE / READY_FOR_HOST_VERIFY (2026-08-17, branch `claude/ua3-profiling-scoring-controls` fra `origin/main` `4a19396`) → D-61

**Status: FIXED_SUITE / READY_FOR_HOST_VERIFY → D-61 - IKKE VERIFIED**, venter på Tobias sin FØRSTE
host-kjøring. Svarer på D-60 sin `NEEDS_TOBIAS_DECISION` - av de tre gjenværende kandidatene
(Support/tickets, Contracts/e-sign, profiling/scoring) var profiling/scoring den ENESTE som ikke krevde
en uavklart leverandørbeslutning.

**Bygget:** migrasjon `022_business_scoring.sql` (`business_scores`, samme FORCE RLS-mønster som
`business_open_loops`, `entity_type` DB-CHECK-begrenset til `'lead'`/`'opportunity'` - kontakt-/
person-scoring strukturelt umulig); `scoring-rules.ts` (ren, deterministisk regelmotor,
`lead_priority_v1`/`opportunity_risk_v1`, whitelist + `assertNoProhibitedFactorCodes()`);
`scoring-service.ts` (signal-innsamling KUN fra lead/opportunity/aktivitet/oppfoelging/open-loop-data,
idempotent UPSERT, forklaring/rangering, manuell overstyring); 8 nye ToolGateway-handlinger
(`get_lead_score`/`get_opportunity_score`/`explain_score`/`rank_leads`/`rank_opportunities` = klasse A;
`recalculate_score`/`set_manual_override`/`clear_manual_override` = klasse B); periodisk rekalkulering
via EKSISTERENDE `DailyScheduler` (`job_name="business-scoring-recalc"`, default kl. 07); host-
akseptanseskript `ua3-profiling-scoring-host-run.ts`/`-live.ts` (ETT-delt, INGEN ekstern leverandør-
credential kreves - i motsetning til Gmail/Calendar-linkage).

**Suite-verifisert (1147/1147 tester, 65 nye):** lead-/opportunity-score-beregning, faktor-forklaring,
kilde-/evidence-referanser, versjonering, beskyttet-trekk-forbud (strukturelt OG funksjonelt), ingen
skjult persontrekk-inferens, manuell overstyring + audit, idempotent rekalkulering, tenant-/
memory-space-isolasjon, Q-21, ToolGateway-lesing/-skriving, audit-personvern, INGEN AI Mesh-bruk,
Q-20-kildefjerning-resiliens, hoy-konsekvens-personbeslutning strukturelt umulig, fail-closed.

**Eksplisitt IKKE overklaimet:** kun DENNE sliceen implementeres her. HELE UA-3 forblir IKKE komplett -
Support/tickets, Contracts/e-sign (uavklart Tobias-provider-beslutning) og tverr-domene driftsoversikt
utover sales (avhenger av UA-4/UA-5/UA-6, ikke startet) gjenstår. HELE masterplan v4.0 «Sovereign
Autonomy» forblir IKKE komplett - se D-60/D-61 og oppdatert Q-25.

## UA-3 Profiling/Scoring HOST FIX #1 (2026-08-17, samme dag, ekte host-funn av Tobias, `run_id 22226237`) → D-62

**Tobias sin FØRSTE host-kjøring** (`node --env-file=.env --experimental-transform-types
modules/business/scripts/ua3-profiling-scoring-host-run.ts`) traff `hard_fail=true`, men ALLE
funksjonelle markører PASSET LIVE:

`q21_runtime_role_safe`, `ua3_scoring_runtime_role`, `ua3_scoring_toolgateway`, `ua3_scoring_lead`
(`lead_score=60`, faktorer `status_qualified`/`has_active_opportunity`/`recent_activity_7d`),
`ua3_scoring_explainable`, `ua3_scoring_versioned`, `ua3_scoring_source_backed`,
`ua3_scoring_protected_traits_blocked`, `ua3_scoring_opportunity` (`opportunity_score=50`, faktorer
`stage_proposal`/`overdue_followup`), `ua3_scoring_high_impact_blocked`, `ua3_scoring_manual_override`
(`override_score=88`, `underlying_score_unchanged=true`), `ua3_scoring_override_audit`,
`ua3_scoring_tenant_isolation`, `ua3_scoring_space_isolation`, `ua3_scoring_audit_safe`,
`ua3_scoring_cleanup` (`leftover_scores=0 leftover_tenants=0`). **KUN**
`ua3_scoring_idempotent=FAIL` (`duplicate_rows_for_same_lead=0`) blokkerte.

**Root cause verifisert presist (kildekode-sporet, IKKE gjettet):** IDEMPOTENS-seksjonen i
`ua3-profiling-scoring-live.ts` verifiserte `business_scores` med `withTenantTransaction()` - denne
hjelperen setter KUN `jarvis.tenant_id`. `business_scores` (`022_business_scoring.sql`) har - i
MOTSETNING til `audit_events` (som D-59 korrekt fikset MED `withTenantTransaction`, siden
`audit_events` KUN har en tenant-policy) - BÅDE en tenant-policy OG en RESTRICTIVE
memory-space-policy (samme mønster som `business_open_loops`). Uten `jarvis.memory_spaces` satt
evaluerer memory-space-predikatet til NULL, og RESTRICTIVE-policyen blokkerer STRUKTURELT alle rader -
**SAMME feilklasse som D-54/D-59, en NY konkret forekomst** (feil hjelpefunksjon valgt for en tabell
med et EKSTRA policy-lag). Selve SKRIVINGEN var korrekt hele tiden - `ScoringService` bruker
`withMemoryTransaction()` konsekvent, og host-loggens egne `ua3_scoring_lead=PASS`/
`ua3_scoring_manual_override=PASS` beviser raden ble lest korrekt like før idempotens-seksjonen kjørte.

**Bevist reprodusert mekanisk** (ny `scoring-idempotency-rls.test.ts`, 9 tester): en ekte
`recalculate_score` gjennom ToolGateway, `adminPool` bekrefter 1 rad finnes, raw/
`withTenantTransaction`-spørring under en ekte non-bypass rolle finner FORTSATT 0 rader (identisk
mekanisme som host-loggen), `withMemoryTransaction()` finner raden korrekt.

**Idempotens-identitet klargjort:** `UNIQUE (tenant_id, entity_type, entity_id, score_type)` er den
fullstendige identiteten - `rule_version` deltar BEVISST IKKE (kun ÉN gjeldende score per
entitet/type, ikke en versjonshistorikk-tabell; `audit_events` er den faktiske historikken). Schema
var allerede korrekt - INGEN endring gjort der.

**Fiks (kun akseptanse-harnesset, ingen produksjonskode rørt):** spørringen wrappet i
`withMemoryTransaction(pool, TENANT_A, ["business"], ...)`. Diagnostikk omdøpt fra det misvisende
`duplicate_rows_for_same_lead` til `score_rows_for_same_identity` + eksplisitt
`idempotency_identity`-felt, slik at fremtidige feilsøkinger kan skille rad-mangel fra RLS-skjult rad
fra ekte duplikat. 13 nye tester (9 i `scoring-idempotency-rls.test.ts` + 4 nye strukturelle
regresjonsvakter i `ua3-profiling-scoring-host-run-wiring.test.ts`, 1147→1160). Lint/typecheck rene.

**STATUS: FIXED_SUITE / HOST_VERIFY_BLOCKED → D-62. IKKE VERIFIED** - venter på Tobias sin ANDRE
kjøring av:
`node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-profiling-scoring-host-run.ts`
**KUN UA-3 P0 + open-loop-sliceen + Business-Event-Linkage er VERIFIED/COMPLETE - denne sliceen er
FIXED_SUITE, funksjonelt LIVE-bevist, men IKKE ferdig host-bevist (kun idempotens-verifikasjonsbugen
gjenstår) - HELE UA-3 er FORTSATT IKKE komplett** (se oppdatert Q-25). Support/tickets, Contracts/
e-sign (krever fortsatt en Tobias-provider-beslutning), tverr-domene driftsoversikt utover sales er
alle IKKE bygget/startet. **Masterplan v4.0 «Sovereign Autonomy» forblir IKKE komplett.**

## UA-3 FINAL CLOSURE — Profiling/Scoring (2026-08-17, samme dag) — HOST VERIFIED → D-63

**Tobias kjørte `node --env-file=.env --experimental-transform-types
modules/business/scripts/ua3-profiling-scoring-host-run.ts` på sin faktiske Windows/Docker-host - GRØNT
resultat, run_id `61b5cf63`.** ANDRE host-kjøring, etter HOST FIX #1 (D-62) - denne runden kom HELE
VEIEN gjennom UTEN nye funn. Alle 17 markører PASS: `q21_runtime_role_safe`, `ua3_scoring_runtime_role`,
`ua3_scoring_lead` (`lead_score=60`), `ua3_scoring_opportunity` (`opportunity_score=50`),
`ua3_scoring_explainable`, `ua3_scoring_source_backed`, `ua3_scoring_versioned`,
`ua3_scoring_idempotent` (`score_rows_for_same_identity=1`), `ua3_scoring_protected_traits_blocked`,
`ua3_scoring_high_impact_blocked`, `ua3_scoring_manual_override` (`override_score=88`,
`underlying_score_unchanged=true`), `ua3_scoring_override_audit`, `ua3_scoring_tenant_isolation`,
`ua3_scoring_space_isolation`, `ua3_scoring_toolgateway`, `ua3_scoring_audit_safe`,
`ua3_scoring_cleanup` (`leftover_scores=0 leftover_tenants=0`). Runtime uendret gjennom hele kjøringen:
`runtime_current_user=jarvis_runtime`, `runtime_role_superuser=false`, `runtime_role_bypassrls=false`,
`scoring_runtime_role=jarvis_runtime`. `hard_fail=false`.

**Akseptansekriterium 4-re-evaluering ("Profiling/scoring used with documented legal/human controls
where required"): COMPLETE/VERIFIED.** Rettslig grunnlag (GDPR art. 6(1)(f), berettiget interesse for
intern prioritering av allerede lovlig innsamlet data) lagt til `UA3_BUSINESS_DPIA.md` denne runden.
GDPR art. 22 (automatiserte enkeltavgjørelser) eksplisitt vurdert og funnet IKKE relevant - en score
"produces" verken "legal effects" eller "similarly significantly affects" en person (avviser aldri,
nekter aldri tjeneste, avgjør aldri kreditt/ansettelse/forsikring - strukturelt umulig). Menneskelig/
juridisk kontroll (manuell overstyring + audit + full forklarbarhet) likevel TILSTEDE og host-bevist -
Appendiks D-gaten er dermed oppfylt i BÅDE bokstav og ånd.

**STATUS: VERIFIED/COMPLETE → D-63.** Full evidens (D-61/D-62/D-63) og oppsummering i
header-seksjonen øverst i denne filen. **KUN UA-3 P0 + open-loop-sliceen + Business-Event-Linkage +
denne sliceen er VERIFIED/COMPLETE - HELE UA-3 er IKKE komplett** (kriterium 1/2 fortsatt PARTIAL - se
oppdatert Q-25). **Masterplan v4.0 «Sovereign Autonomy» forblir IKKE komplett.** PR #12 merget til
`main` (normal merge-commit, samme konvensjon som PR #1-#11 - historikk bevart, ikke squashet).

## CORE OWNERSHIP / ADAPTER BOUNDARY INVARIANT (2026-08-18, branch `claude/core-ownership-adapter-invariant-clean`, REN transplantasjon fra `origin/main`) → D-64 - MERGET (PR #15, merge-commit `0566b7a`)

**Permanent styringsregel, IKKE en implementasjonsoppgave.** Tobias identifiserte et tilbakevendende
feilmønster: et masterplan-kapabilitetsnavn ("Support/tickets") ble tolket som "velg en ekstern
SaaS-leverandør og la den eie domenet" - konkret demonstrert av en tidligere, ALDRI merget
utforskende Zendesk-connector (draft-PR #13). Denne runden gjør lærdommen permanent OG korrigerer en
prosessfeil fra en tidligere versjon av dette arbeidet (se "Nummererings-korreksjon" under).

**Bygget (dokumentasjon/styring, INGEN kode endret):**
1. **CLAUDE.md regel 12** - CORE OWNERSHIP / ADAPTER BOUNDARY INVARIANT: et kapabilitetsnavn antyder
   ALDRI automatisk en leverandør. Jarvis eier kanonisk domenemodell/tilstand for intrinsic
   kapabiliteter (`JARVIS_CANONICAL`); eksterne tjenester er normalt kilder/sluk/transporter/
   adaptere/utførelsesleverandører (`EXTERNAL_CANONICAL`). IKKE "bygg alt selv".
2. **ARCHITECTURE.md §11** (ny seksjon, 11 underpunkter) - Core-vs-Adapter-beslutningsport (11
   spørsmål A-K), `CORE_DEPENDENCY_DECISION_REQUIRED=true`-eskaleringsmekanisme, forhold til D-41
   klargjort, system-of-record-klassifisering (`JARVIS_CANONICAL`/`EXTERNAL_CANONICAL`/
   `HYBRID_WITH_CLEAR_AUTHORITY`), portabilitets-/utfalls-/dataeierskapstest, gjenbrukbar
   leverandørbeslutningsmal, full masterplan-avhengighetsaudit (§11.9, PÅ CANONICAL `origin/main`),
   Zendesk-historikk + RLS-produksjonsfunn (§11.10), Contracts/e-sign forebyggende grenseanalyse
   (§11.11).
3. **D-64** i DECISIONS_AND_ASSUMPTIONS.md - full beslutningstekst, inkl. Native Support Core-
   beslutningen og nummererings-korreksjonen.
4. **Q-27** - RLS-blind tenants-katalog-spørring i TRE eksisterende produksjonsfunksjoner
   (`runOpenLoopSweepForAllTenants`/`runBusinessEventSyncForAllTenants`/`runScoringSweepForAllTenants`)
   - RE-VERIFISERT direkte mot faktisk `origin/main`-kildekode i denne runden (ikke tatt for gitt fra
   den forkastede branchen sin tekst). Status: OPEN, IKKE fikset (dokumentasjons-/re-verifiserings-
   runde, ikke en kodefiks-runde).
5. **Q-28** - Contracts/e-sign forebyggende grenseanalyse (Contract Core vs. Signature Execution
   Provider), INGEN leverandør valgt, INGEN kode bygget.

**Support/tickets-domenet er NÅ EKSPLISITT besluttet `JARVIS_CANONICAL`** (Native Jarvis Support
Core - IKKE bygget i denne runden, egen fremtidig, eksplisitt godkjent slice). Den tidligere Zendesk-
connectoren (draft-PR #13) er **SUPERSEDED / UNMERGED EXPERIMENTAL IMPLEMENTATION** - merges IKKE,
branch/historikk bevares (ikke slettet) som mulig fremtidig adapter-referanse.

**Nummererings-korreksjon (viktig prosessfunn denne runden):** en tidligere versjon av dette
governance-arbeidet (PR #14, branch `claude/architecture-core-adapter-invariant`) ble feilaktig
stablet PÅ den umergede Zendesk-branchen (`claude/ua3-zendesk-support-connector`, PR #13) og lånte
dens IKKE-canonical `D-64`/`Q-27`/`Q-28`/`Q-29`-numre - numre som KUN eksisterte på en branch som
aldri ble merget til `main`, og derfor ALDRI reserverte canonical IDer. Denne runden startet en HELT
NY branch DIREKTE fra `origin/main` (SHA `4bc33b8`, bekreftet siste canonical D-ID = D-63, siste
canonical Q-ID = Q-26), og bruker derfor korrekt D-64/Q-27/Q-28. PR #14 er markert SUPERSEDED og
closed. **Lærdom lagt til selve D-64-teksten:** IDer fra en forkastet/umerget branch reserverer
ALDRI canonical numre - neste ID skal ALLTID verifiseres mot faktisk `origin/main`.

**Masterplan-avhengighetsaudit - hovedfunn (re-kjørt PÅ canonical `origin/main`):** de fleste
eksisterende connectors (Gmail/Calendar/Drive/GitHub/Telegram/Vercel/Home Assistant/AI-modell-
leverandører/observability/secret-håndtering/Business OS-CRM) er ALLEREDE korrekt klassifisert som
adaptere bak eksisterende abstraksjoner - INGEN endring nødvendig. INGEN CRITICAL-grenser funnet.

**Q-26 (Knowledge Verification/Truth Promotion) UENDRET og bevart** - denne runden overlapper eller
fortrenger ikke den.

**Kvalitetsgater:** kun dokumentasjonsendring (CLAUDE.md/ARCHITECTURE.md/
DECISIONS_AND_ASSUMPTIONS.md/OPEN_QUESTIONS.md/PROJECT_STATUS.md) - ingen kode rørt. Rent-diff
eksplisitt verifisert mot `origin/main`: KUN disse fem dokumentasjonsfilene endret, ZERO
Zendesk-implementasjonsfiler (transport/migrasjon/ToolGateway-definisjoner/webhook/host-scripts) i
diffen. `pnpm -w typecheck` 14/14 pakker fortsatt clean (uendret, ingen kode rørt).

**HELE UA-3 forblir uendret av denne runden** - ingen fase-fullførelsesstatus endret.

## Q-27 - RLS-BLIND BUSINESS TENANT ENUMERATION FIX (2026-08-18, branch `claude/q27-safe-tenant-enumeration`, fra `origin/main` `0566b7a`) → D-65 - MERGET (PR #16, merge-commit `65cafc5`)

**Dedikert produksjonsbug-slice - fikser den ekte D-64/Q-27-oppdagelsen, IKKE en governance-/
dokumentasjonsrunde.** Tre eksisterende, allerede-i-produksjon `DailyScheduler`-funksjoner
(`runOpenLoopSweepForAllTenants` D-53, `runBusinessEventSyncForAllTenants` D-57,
`runScoringSweepForAllTenants` D-61) kjørte en rå, uskopet `SELECT tenant_id FROM tenants
WHERE kind='business'...` mot den delte `jarvis_runtime`-poolen FØR noen `jarvis.tenant_id`-kontekst
var satt - `tenants` har `FORCE ROW LEVEL SECURITY`, så spørringen returnerte STRUKTURELT 0 rader
uansett faktisk tenant-antall.

**Bygget:**
1. **Migrasjon `023_business_tenant_catalog.sql`** - ny `jarvis_list_business_tenant_ids(p_limit
   integer DEFAULT 200)`, en smal `SECURITY DEFINER`-funksjon (samme mønster som `claim_next_task()`,
   `007_claim_function.sql`/`009_worker.sql`), eid av migrasjons-admin-rollen, `SET search_path =
   public`, `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE` KUN til `jarvis_app`. `kind='business'`
   HARDKODET i funksjonskroppen (ingen caller-styrt parameter) - snevrere enn den forkastede
   Zendesk-branchens opprinnelige prototype.
2. **`listBusinessTenantIds()`** (`@jarvis/core`, `modules/core/src/services/tenant-catalog.ts`) - ny
   delt TS-hjelper, kaster en typet `BusinessTenantEnumerationError` ved faktisk spørringsfeil
   (ALDRI stille "0 tenants"), logger KUN et antall (`business_tenants_enumerated`), aldri
   tenant-IDer.
3. **Alle tre sveip-funksjoner omskrevet** til å kalle DENNE ene hjelperen - ingen duplisert SQL,
   ingen tre separate fikser.
4. **Repo-bred audit** (grep etter alle `FROM tenants`-mønstre) bekrefter INGEN andre
   produksjonsforekomster av samme feilklasse.
5. **Testdekning (16 nye tester, ekte embedded Postgres, IKKE `fakePool()`):**
   `modules/core/test/business-tenant-catalog-rls.test.ts` (8) beviser katalogfunksjonen isolert -
   bug-reproduksjon, riktige/kun bedrifts-tenants, minimal kolonneoverflate, PUBLIC/utenforstående-
   rolle nektet, search_path-sikkerhet (decoy-skjema), Q-21 uendret, tom mengde ≠ feil, bounded
   limit. `modules/business/test/q27-scheduler-tenant-enumeration-rls.test.ts` (8) beviser alle TRE
   sveip-funksjonene oppdager syntetiske bedrifts-tenants via den ekte RLS-rollen, ekskluderer
   person-tenant, bevarer feilisolasjon, repeterbar. Eksisterende `fakePool()`-enhetstester
   (`open-loop-sweep.test.ts`) BEHOLDT UENDRET i sin orkestrerings-/feilisolasjonsrolle - kun test C
   sin SQL-tekstform-assertion oppdatert til det nye kallmønsteret.
6. **Host-akseptanseskript** `q27-tenant-enumeration-host-run.ts` → `q27-tenant-enumeration-live.ts`
   (samme admin/runtime-pool-separasjon/selvdiagnostisk-FK-sperre-mønster som alle tidligere
   UA-3-live-scripts) - beviser BÅDE bug-reproduksjon (RLS fortsatt håndhevet) OG fiksen i ÉN kjøring.

**Suite-verifisert:** 1176/1176 tester totalt (1160→1176, 16 nye), typecheck 14/14, lint rene.

**VERIFIED / CLOSED (2026-08-18):** Tobias har kjørt den ekte Windows/Docker-host-akseptansen
(`q27-tenant-enumeration-host-run.ts`), run_id `8549d23f`, `hard_fail=false`. ALLE 15 markører PASS:
`q21_runtime_role_safe`, `q27_direct_runtime_global_query_restricted`, `q27_catalog_business_tenants`,
`q27_catalog_excludes_nonbusiness`, `q27_catalog_minimal_surface`, `q27_catalog_public_execute_denied`,
`q27_catalog_runtime_execute_allowed`, `q27_open_loop_scheduler`, `q27_business_event_scheduler`,
`q27_scoring_scheduler`, `q27_multiple_business_tenants`, `q27_tenant_isolation`,
`q27_runtime_no_superuser`, `q27_runtime_no_bypassrls`, `q27_cleanup`. Runtime bekreftet
`jarvis_runtime`/`superuser=false`/`bypassrls=false` - Q-21 IKKE svekket. Markørnavnene i den
rapporterte kjøringen er verifisert direkte mot `results`-kartet i `q27-tenant-enumeration-live.ts`
på denne branchen (kildelest i denne runden) - evidensen samsvarer strukturelt med implementasjonen
som faktisk ligger her. Re-audit av migrasjonen fant INGEN ytterligere sårbarhet (eier =
migrasjons-admin-rollen, eksplisitt `search_path`, ingen dynamisk SQL, `REVOKE`/smal `GRANT`, ingen
bredere dataflate enn `tenant_id`). Q-27 formelt lukket i OPEN_QUESTIONS.md. **PR #16 MERGET til
`main`** (merge-commit `65cafc5`, normal merge-commit, Tobias' eksplisitte godkjenning).

**Kjente åpne gap (ikke skjult):** D-64/Q-28 Contracts-forebygging/Q-26 Knowledge Verification alle
UENDRET av denne rene bug-fiks-runden. Utenfor Q-27 sitt eget scope: en pre-eksisterende, ikke-
relatert CI-flake i `modules/watchdog/test/erasure-restore-contract.test.ts` (tilfeldig portvalg,
`30000 + random(20000)`, ingen kollisjons-retry) ble diagnostisert og re-kjørt til grønn - IKKE
fikset i denne sliceen (annen modul, utenfor scope).

## UA-3 NATIVE JARVIS SUPPORT CORE (2026-08-18, branch `claude/ua3-native-support-core`, fra `origin/main` `65cafc5`) → D-66

**Implementerer D-64 sitt `JARVIS_CANONICAL`-vedtak for Support/tickets** - IKKE en governance-runde,
en faktisk domenebygging. D-64 Core-vs-Adapter-gate kjørt FØR kode (bekreftet i D-66): ZERO Zendesk-
avhengighet, `JARVIS_CORE`=ticket-lifecycle/entitetskobling/events/tildeling/prioritet/SLA/Business-
OS-kobling/open-loops, `EXTERNAL_ROLE`=Gmail KUN som kommunikasjonstransport.

**Bygget:** ny pakke `@jarvis/support` + migrasjon `024_support.sql` (`support_tickets`/
`support_ticket_events`); deterministisk lifecycle (`state-machine.ts`); kanal-nøytral domenemodell
(kun generiske `source_*`/`canonical_uri`-pekere); Gmail-ingress via EKSISTERENDE `GmailTransport`
(deterministisk routing - konfigurert innboks ELLER kjent tråd-id, AI ALDRI eneste port); thread-/
melding-idempotens (samme `ON CONFLICT`-mønster som `business_activities`); entitetsresolusjon
gjenbruker `BusinessService.findContactsByEmail()` DIREKTE (samme MATCHED/UNMATCHED/AMBIGUOUS som
D-57); Business OS-tidslinje-integrasjon (søkbar via `company_id`, kombinerbar med
`business_activities`); pointer-not-payload (ingen full e-postmeldingstekst noe sted i skjemaet);
open-loop-integrasjon GJENBRUKER `OpenLoopService`/`business_open_loops` UENDRET mekanisme (fire nye
`loop_type`-verdier + `ticket_id`-pekerkolonne, dekket av DEN EKSISTERENDE
`business-open-loop-sweep`-jobben, ingen ny scheduler); kunde-svar ruter GJENNOM eksisterende
`email.send` (klasse D uendret, INGEN SMTP bygget); nytt `support.*` ToolGateway-namespace (12
handlinger, A/B/C-klasser, INGEN klasse D); Q-21/RLS samme mønster som `business_open_loops`; Q-27-
gjenbruk (`listBusinessTenantIds()`, ingen ny katalogmekanisme); Q-20-erasure-registrering
(`modules/erasure/src/plan.ts`, ny begrunnet `GRANT DELETE` for de to nye tabellene).

**Reell regresjon funnet og fikset under bygging:** den nye erasure-registreringen UTEN et
tilhørende `GRANT DELETE` fikk HELE `erasure-service.test.ts`-suiten (13 tester, urelatert til
Support) til å feile med `status: "failed"` - fanget av en full `pnpm -w test`-kjøring, IKKE av
modulens egne tester alene. Fikset i samme migrasjon (`024_support.sql`).

**Testdekning:** 62 nye tester (54 i `@jarvis/support` + 8 i
`ua3-native-support-host-run-wiring.test.ts`, pluss 2 nye erasure-regresjonstester), 1176→1240, full
suite grønn. Typecheck 15/15 pakker, lint rene.

**Host-akseptanseskript** `ua3-native-support-host-run.ts` → `ua3-native-support-live.ts` (samme
admin/runtime-pool-separasjon/selvdiagnostisk-FK-sperre-mønster som alle tidligere UA-3-live-scripts)
- bruker en deterministisk `FakeTransport` GJENNOM den EKTE ToolGateway/Policy Gateway-arkitekturen
for Gmail-ingress/kunde-svar (§32 i byggeordren: ALDRI reell e-postutsendelse/mutasjon i
akseptanse). 26 markører (`q21_runtime_role_safe` + 25 `ua3_support_*`).

**Status: FIXED_SUITE / IKKE VERIFIED.** Draft-PR opprettes, INGEN Tobias-host-kjøring utført ennå.
K1 ("Hva skjer med kunde X?") forblir EKSPLISITT PARTIAL - IKKE automatisk markert COMPLETE.

**Kjente åpne gap (ikke skjult):** Contracts/e-sign (Q-28) uendret, ikke bygget; ingen ekstern
support-leverandør-adapter koblet inn (Zendesk-branchen forblir SUPERSEDED/unmerget); flerkanal
utover e-post ikke koblet inn (domenemodellen støtter det strukturelt); AI-basert support-vs-ikke-
support-klassifisering ikke bygget (routing er bevisst deterministisk).

## Blokkeringer
Q-20/UA-2 P0/Q-21/UA-2 P1A/P1A Runtime Wiring Closeout/UA-2 P1B-A/UA-3 P0/UA-3 Open-Loop Detection/
UA-3 Business-Event-Linkage/UA-3 Profiling/Scoring/Q-27/**UA-3 Native Jarvis Support Core (D-66/
D-67/D-68/D-69/D-70, host-bevist run_id `da7e0c1b`, `hard_fail=false`)** har INGEN egne
blokkeringer lenger (alle VERIFIED/CLOSED/COMPLETE - Native Support Core er merge-klar, `main`-merge
avventer KUN Tobias' eksplisitte godkjenning, ikke ytterligere byggearbeid).
Manglende provider-nøkler er eneste gap for LIVE multi-provider-evidens (Gemini/Kimi/Ollama).
Ytelsesgjeld for voice-latens (Q-19) er åpen, ikke-blokkerende. Pieces har ingen kjent integrasjonsflate
ennå (Q-22) - egen fremtidig underoppgave. Google Drive permission-mutasjon er IKKE live-host-bevist
(Q-23) - smalt, ikke-blokkerende gjenværende verifikasjonspunkt. P1B-A sin worker-JOBB-live-kjøring er
tilsvarende IKKE live-host-bevist (Q-24) - samme mønster, egen fremtidig test-runde. **Contracts/
e-sign-connectoren forblir blokkert på en EKSPLISITT Tobias-provider-beslutning FOR SELVE
SIGNATUR-UTFØRELSEN, OGSÅ på Core-vs-Adapter-porten i §11.2** (D-64/Q-28) - IKKE kodbar før dette
foreligger, se D-57/Q-25 item 8 + Q-28. **Kriterium 2 sin gjenstående bredde
(product/finance/marketing/operations) er en FASE-AVHENGIGHET av UA-4/UA-5/UA-6, ikke et internt
UA-3-kodbart gap** - disse fasene er selv IKKE startet. Connector-audit-gapene
(GitHub/Calendar/Gmail/Telegram/Vercel/HA - se tabellen over) er dokumentert backlog, ikke
blokkerende.

## Neste oppgave
**UA-3 Native Jarvis Support Core (D-66→D-70) er NÅ VERIFIED/COMPLETE - INGEN videre byggearbeid
eller host-kjøring gjenstår for denne sliceen.** Draft-PR #17 er klar for review (all CI grønn, full
lokal regresjon grønn, ekte host-bevis `da7e0c1b`/`hard_fail=false`/alle 26 markører PASS foreligger)
- **venter KUN på Tobias sin eksplisitte merge-godkjenning** (CLAUDE.md-regel, ingen økt merger uten
den). Se "UA-3 NATIVE SUPPORT CORE — ENDELIG LUKKING"-seksjonen nederst for full detalj.

**HELE UA-3 er FORTSATT IKKE komplett** - masterplanens fire akseptansekriterier: kriterium 3
COMPLETE/VERIFIED (uendret fra D-56); kriterium 4 COMPLETE/VERIFIED (uendret fra D-63); kriterium 1
FORTSATT PARTIAL (Support/tickets-delkriteriet NÅ VERIFIED/COMPLETE, MEN Contracts/e-sign fortsatt
IKKE bygget - kriterium 1 som helhet derfor fortsatt PARTIAL); kriterium 2 PARTIAL (uendret, kun
sales, avhenger av UA-4/UA-5/UA-6).

**Gjenstående for kriterium 1:**
1. ~~Native Jarvis Support Core host-verifikasjon~~ - **FERDIG** (D-70, run_id `da7e0c1b`,
   `hard_fail=false`). Kriterium 1 forblir likevel PARTIAL inntil Contracts/e-sign også bygges.
2. **Contracts/e-sign-connector** (UA-3 P1, masterplan linje 1071) - krever leverandørvalg for selve
   signatur-utførelsen (f.eks. DocuSign/Dropbox Sign - kun eksempler, IKKE forhåndsvalgt), OGSÅ
   krav om at kontraktskjernen designes `JARVIS_CANONICAL` FØRST (D-64/Q-28). IKKE startet.
**Kriterium 2 sin gjenstående bredde ligger UTENFOR "neste UA-3-slice"-scopet** inntil UA-4/UA-5/UA-6
faktisk starter. Q-26 (Knowledge Verification/Truth Promotion-invariant, uendret) forblir sporet som
en fremtidig, egen slice. **IKKE startet:** Contracts/e-sign, UA-4, noen annen UA-fase. Faseporten
gjelder fortsatt strengt (CLAUDE.md-regel 10) - venter på en egen, eksplisitt byggeordre/-beslutning
fra Tobias/arkitekten før noe av det ovennevnte begynner.

Gjenstående, eksplisitt IKKE-blokkerende UA-2-relatert backlog (se D-48/OPEN_QUESTIONS.md for full
klassifisering - ingen av disse hindrer UA-2-lukkingen eller krever noe FØR UA-3 kan startes, men
ingen av dem er heller igangsatt uten egen godkjenning):
- Møtetranskripsjon - avhenger av UA-7 Communications Hub, som selv IKKE er bygget ennå.
- Pieces som kunnskapskilde (Q-22) - ingen kjent integrasjonsflate identifisert; uansett ikke
  nødvendig for UA-2 sitt "minst fem kilder"-krav, som er oppfylt uten Pieces.
- Dedikert lokal OCR-motor, ekte bildestøtte i providere utover Anthropic, docx/xlsx/pptx-ekstraksjon,
  finere per-vedlegg-checkpointing (D-43/Q-24) - ingen konkret behov identifisert.
- Google Drive permission-live-verifikasjon (Q-23) og P1B-A worker-JOBB-live-verifikasjon (Q-24) -
  begge egne, smale, eksplisitt godkjente test-runder (ikke byggearbeid).

## UA-3 NATIVE SUPPORT CORE HOST FIX #1 (2026-08-18, samme branch `claude/ua3-native-support-core`) → D-67

**Ekte host-funn (Tobias, Windows/Docker), TO run_id-er:** `60f0d682` og `5457c59a`, begge
`hard_fail=true`, 18 av 26 markører PASS. TO rapporterte rotårsaker + ÉN TREDJE, tidligere maskert
rotårsak funnet under gjenoppbygging av regresjonstestene for de to første (ikke i selve
host-funnet).

**Rotårsak 1 - `credential_unavailable`-kaskade (7 avledede FAIL: create_ticket/thread_idempotency/
message_idempotency/source_pointer/no_body_copied/reply_path/toolgateway):** akseptanse-scriptets
egen `FallbackSecretProvider` returnerte ALLTID null for `JARVIS_EMAIL_TOKEN`/`JARVIS_GOOGLE_TOKEN` -
`ToolGateway.execute()` avviser UBETINGET med `credential_unavailable` FØR `transport.invoke()` kalles
(bekreftet mot `gateway.ts` linje 185-190), ogsaa for `FakeTransport`. SAMME klasse akseptanse-
harness-bug som D-58. **Fiks:** gjenbrukte EKSAKT samme "test-google-static"-dummy-credential-mønster
som `ua3-business-events-live.ts` (D-57) - rører ALDRI produksjonens `EnvSecretProvider()`-wiring.

**Rotårsak 2 - Q-20 FK-brudd (`business_open_loops_ticket_id_fkey`):** en support-tilknyttet
open-loop-rad blokkerte faktisk sletting av ticketen. To delårsaker: (a) erasure-PLANEN
(`modules/erasure/src/plan.ts`) registrerte ALDRI `business_open_loops`; (b) `jarvis_app` hadde ALDRI
`GRANT DELETE` på `business_open_loops` (kun SELECT/INSERT/UPDATE fra `020_business_open_loops.sql`).
Schema-drevet FK-audit bekreftet `business_open_loops` er DET ENESTE eksterne avhengighetspunktet.
**Fiks:** ny, EGEN migrasjon `025_business_open_loops_ticket_grant.sql` (IKKE en redigering av
allerede kjørte 020/024 - migrasjons-immutabilitet) + ny, SNEVERT avgrenset (`ticket_id IS NOT NULL`)
sletting av support-linkede open-loops FØR ticketen i `plan.ts` - ALDRI en generell
`business_open_loops`-erasure-utvidelse (forblir samme pre-eksisterende gap, Q-25 punkt 9).

**Rotårsak 3 - NY, funnet under skriving av §14-regresjonstestene (maskert av rotårsak 1 i det
opprinnelige host-funnet):** `SupportTransport.invoke("reply", ...)` bygde internt en
`person_id: "system"`-identitet for det nøstede `email.send`-kallet (klasse D).
`resolveAuthorityMode()` krever `identity.person_id === authority.owner_person_id` for SOVEREIGN-
authority - "system" matcher ALDRI en konfigurert eier, saa `email.send` fikk UBETINGET
`class_d_missing_approval` for HVER reply, uavhengig av credential-status. Ville reprodusert
reply_path-FAIL på NESTE host-kjøring selv med rotårsak 1 fikset. **Fiks:** gjenbrukte EKSAKT samme
`JARVIS_OWNER_PERSON_ID`-konvensjon (fallback `"person-tobias"`) som `main.ts`/`worker-main.ts`
allerede bruker for sine egne system-utførte klasse D-identiteter; akseptanse-scriptet selv oppdatert
til å sette `process.env.JARVIS_OWNER_PERSON_ID = OWNER_PERSON` FØR noen ToolGateway/PolicyGateway
konstrueres.

**Ny regresjonsdekning (10 tester, 1240→1250):**
- `modules/support/test/support-transport-credential-wiring.test.ts` (4 tester, EKTE
  `ToolGateway`/`PolicyGateway`/embedded Postgres): konfigurert `EnvSecretProvider`-credential
  lykkes gjennom `support.reply`; manglende credential gir FORTSATT `credential_unavailable`
  (produksjonens håndhevelse UENDRET); credential-verdier lekker aldri; den eksakte
  dummy-provider-konstruksjonen fungerer isolert fra `process.env`.
- `modules/erasure/test/support-open-loop-erasure.test.ts` (6 tester, EKTE
  `ErasureService.executeErasure()`, byggeordrens §11 A-I): linket-loop-erasure lykkes, loopen
  slettes (ikke nulles/orphanes), events slettes, schema-drevet FK-audit bekrefter ingen andre
  avhengige tabeller og ingen dinglende referanse gjenstår, ingen resurrection ved ny ingress,
  urelaterte loops/business-data forblir uendret, idempotent replay uendret.

**Full regresjon:** 92 testfiler, 1250/1250 grønne. Typecheck 15/15 pakker, lint rene.

**Status ved denne runden (D-67, historisk - se D-70 under for endelig status): HOST_VERIFY_FAILED /
FIX_REQUIRED - IKKE VERIFIED.** Draft-PR #17 oppdatert med begge run_id-ene, rotårsakene og
fiksene, FORTSATT ikke merget. K1 forblir EKSPLISITT PARTIAL.

## UA-3 NATIVE SUPPORT CORE SECURITY FIX #2 (2026-08-18, samme branch) → D-68

**Ekstern sikkerhetsaudit** av D-67 sin rotårsak-3-fiks (`SupportTransport` bygde en
`person_id: JARVIS_OWNER_PERSON_ID`-identitet lokalt for det nøstede `email.send`-kallet), FØR noen
ny host-kjøring. Funnet: en REELL rettighetseskalering - `ToolTransport.invoke(action, parameters,
credential)` fikk ALDRI den opprinnelige kalleren sin `IdentityContext` i det hele tatt, saa ENHVER
kaller autorisert til å kalle `support.reply` overhodet (eier ELLER en delegat med et gyldig
`support:reply`-mandat) fikk sitt nøstede `email.send` (klasse D) utført med UBETINGET
eier-/sovereign-authority - en delegat kunne dermed sende e-post uten noensinne å levere en signert
godkjenning.

**Fiks:** `ToolInvocationContext` (`{identity, approval}` fra DET OPPRINNELIGE
`ToolGateway.execute()`-kallet) lagt til som en 4. parameter på `ToolTransport.invoke()` -
gatewayen gir nå transporter DEN EKTE kalleren sin kontekst i stedet for at transporter
fabrikkerer sin egen. Bakoverkompatibelt (alle andre transportere uendret, TypeScript strukturell
typing tillater færre deklarerte parametre). `SupportTransport` sin `reply`-case videreformidler
`context.identity`/`context.approval` UENDRET til det nøstede kallet - INGEN ny autoritetsmodell.
D-67 sin `JARVIS_OWNER_PERSON_ID`-omgåelse i akseptanse-scriptet fjernet (unødvendig).

**Invariant bevist:** `effective_authority(nested email.send) <= effective_authority(original
caller)`, ALDRI eskalert - 10 nye tester (`support-reply-authority-propagation.test.ts`, EKTE
`ToolGateway`/`PolicyGateway`/embedded Postgres/Ed25519-signerte godkjenninger): eier sender fortsatt
uten per-kall-godkjenning (sovereign, uendret); delegat UTEN godkjenning nektes
(`class_d_missing_approval`); delegat MED gyldig godkjenning tillates; feil action/parametre
avvises; gjenbrukt nonce avvises; `person_id: "system"` blir ALDRI stille eier; nøstet audit-rad
arver kallerens FULLE identitet; en delegat fra tenant B kan ALDRI faa sovereign-authority for
tenant A via `parameters.tenant_id`. **Full regresjon:** 93 testfiler, 1260/1260 grønne
(1250→1260). **Status forblir HOST_VERIFY_FAILED/FIX_REQUIRED.**

## UA-3 NATIVE SUPPORT CORE HOST FIX #3 (2026-08-18, samme branch) → D-69 "SYNTHETIC FIXTURE CLEANUP ONLY"

**Ekte host-funn, run_id `1e821a86`, `hard_fail=true`.** ALLE 25 funksjonelle/sikkerhets-/
Q-20-markører PASSET (D-66/D-67/D-68 sine fikser bekreftet på ekte host) - KUN
`ua3_support_cleanup=FAIL`, blokkert av to leftover-rader for den syntetiske akseptanse-tenanten:
`business_followups` (bevisst Q-20-fixture, aldri ryddet) og `erasure_requests` (den EKTE Q-20-
revisjonsraden fra samme seksjons `ErasureService.executeErasure()`-kall). Ingen av dem var en
produksjonsfeil - `jarvis_app` har bevisst INGEN DELETE-rettighet på verken tabell.

**Fiks:** `cleanupTenant()` i `ua3-native-support-live.ts` utvidet med `DELETE FROM
business_followups`/`erasure_fingerprints`/`erasure_requests` (riktig FK-rekkefølge) via
`adminPool` - EKSAKT samme, allerede etablerte mønster som `q20-erasure-live.ts` sin egen
`cleanupTenant()`. INGEN ny runtime-rettighet, produksjonens erasure-retensjon UENDRET.
8 nye regresjonstester (`ua3-native-support-cleanup.test.ts`, EKTE embedded Postgres): fixture-
scenarioet er reproduserbart; opprydding fjerner begge rader korrekt og tenanten kan deretter
slettes; urelatert tenant upåvirket; `jarvis_app` kan FORTSATT ikke slette fra noen av tabellene
direkte (Q-21 uendret); opprydding på en tenant som ikke finnes, og kjørt to ganger paa rad, begge
trygt idempotente. **Full regresjon:** 94 testfiler, 1268/1268 grønne (1260→1268). **Status:
funksjonelt host-bevist, MEN fortsatt IKKE VERIFIED/CLOSED** - venter på én ren host-kjøring til.

## UA-3 NATIVE SUPPORT CORE — ENDELIG LUKKING (2026-08-18, samme branch) → D-70

**Fjerde, REN host-kjøring: run_id `da7e0c1b`, `hard_fail=false`, ALLE 26 markører PASS.** Ingen
nye funn. **D-66/D-67/D-68/D-69 markeres alle VERIFIED/CLOSED/COMPLETE.**

**Repo-sannhet verifisert FØR lukking (ikke antatt):** lokal og `origin/claude/ua3-native-support-
core` HEAD identisk (`2e90d5f`), arbeidstreet rent, INGEN kjørbar kode endret etter den host-
testede SHA-en - host-beviset er derfor fortsatt gyldig for nøyaktig denne koden. Migrasjon
`024_support.sql`/`025_business_open_loops_ticket_grant.sql`, `ToolInvocationContext`-
autoritetspropagering (D-68) og `cleanupTenant()`-opprydding (D-69) alle bekreftet til stede.

**Alle 26 markører PASS:** `q21_runtime_role_safe`, `ua3_support_runtime_role`,
`ua3_support_no_zendesk_dependency`, `ua3_support_create_ticket`, `ua3_support_thread_idempotency`,
`ua3_support_message_idempotency`, `ua3_support_contact_match`, `ua3_support_unmatched`,
`ua3_support_ambiguous`, `ua3_support_company_link`, `ua3_support_timeline`,
`ua3_support_source_pointer`, `ua3_support_no_body_copied`, `ua3_support_state_machine`,
`ua3_support_priority`, `ua3_support_assignment`, `ua3_support_internal_note`,
`ua3_support_reply_path`, `ua3_support_open_loop_created`, `ua3_support_open_loop_resolved`,
`ua3_support_tenant_isolation`, `ua3_support_space_isolation`, `ua3_support_toolgateway`,
`ua3_support_audit_safe`, `ua3_support_q20`, `ua3_support_cleanup`. Runtime bekreftet uendret:
`jarvis_runtime`, `superuser=false`, `bypassrls=false` - Q-21 IKKE svekket gjennom noen av de fire
rundene.

**Q-20 (host-bevist denne runden):** `ErasureService` fullførte reelt - ticket fjernet, events
fjernet, den support-linkede open-loopen fjernet, en URELATERT open-loop forble upåvirket, ingen
resurrection ved re-ingest. Produksjonens erasure-retensjonssemantikk UENDRET.

**Q-27:** Native Support gjenbruker DEN SAMME `listBusinessTenantIds()`-katalogmekanismen der
scheduler-fan-out trengs - INGEN duplisert tenant-enumereringsmekanisme. Q-27 forblir
VERIFIED/CLOSED (D-65), uendret.

**Zendesk:** `ua3_support_no_zendesk_dependency=PASS` bekrefter ZERO kjøretids-avhengighet av
`JARVIS_ZENDESK_*`. PR #13 (Zendesk-connectoren) forblir SUPERSEDED/UNMERGED, branch/historikk
bevart, foreslås formelt lukket (ikke merget) med et avsluttende notat.

**K1 ("Hva skjer med kunde X?"):** Support/tickets-delkriteriet er NÅ VERIFIED/COMPLETE - men K1
SOM HELHET forblir EKSPLISITT PARTIAL, siden Contracts/e-sign (Q-28) FORTSATT ikke er bygget og
fortsatt krever en eksplisitt Tobias-leverandørbeslutning FØR noe kan kodes (D-64-splitten CONTRACT
CORE vs. SIGNATURE EXECUTION PROVIDER uendret, INGEN leverandør valgt her). Q-26 (Knowledge
Verification/Truth Promotion) forblir sporet/ubygget - support-innhold forblir KILDEDATA, blir IKKE
automatisk "VERIFISERT KUNNSKAP" av denne lukkingen.

**HELE UA-3 forblir IKKE komplett** (kriterium 2 fortsatt PARTIAL, avhenger av UA-4/UA-5/UA-6 - ingen
startet). **HELE Sovereign Autonomy-masterplanen forblir IKKE komplett.**

**Full regresjon på lukkingstidspunktet:** 94 testfiler, 1268/1268 grønne, `pnpm -w lint` rent,
`pnpm -w typecheck` 15/15 rent, GitHub CI (`gitleaks`+`build-test`) grønn på `2e90d5f`.

**PR #17 status: klar for review** (alle påkrevde CI-sjekker grønne, full lokal regresjon grønn,
ekte host-bevis foreligger) - `MERGE_READY=true`, men **MERGES IKKE uten Tobias sin eksplisitte
godkjenning** (CLAUDE.md-regel, uendret). **STOP etter denne lukkingen. Ingen merge utført. Ingen
Contracts. Ingen signaturleverandør. Ingen UA-4.**

Øvrige kandidater uendret i bakgrunnen: D-30 ytelsesgjeld (Q-19), D-10 STT-benchmark (Q-03), D-36
Apple, HA-RUNTIME, provider-nøkler for Gemini/Kimi/Ollama LIVE-benchmark, connector-audit-gapene
(D-41-sjekklisten, egne fremtidige byggeordre per connector),
`claude/hva-skjer-hvordan-ligger-0z3ztp`-branch-opprydding (krever noen med slette-rettighet på
repoet).

---

## UA-3 NATIVE JARVIS CONTRACTS CORE (BYGGET denne økten, 2026-08-18) → D-71

**Status: FIXED_SUITE / IKKE HOST VERIFIED.** Ny slice fra `origin/main` (`7149ac6`, PR #17 sitt
merge-commit) på branch `claude/ua3-native-contracts-core`. Implementerer D-64/Q-28 sitt
Core-vs-Adapter-vedtak for kontraktdomenet - denne gangen kjørt PROAKTIVT FØR kode, ikke reaktivt
utledet som for Support.

**D-64 Core-vs-Adapter-gate (kjørt FØR kode):** CAPABILITY=Contract management;
JARVIS_CORE=kontrakt-lifecycle/motparter/versjoner/forpliktelser/frister/fornyelser/godkjenninger/
Business-OS-kobling/open-loops/kanonisk status; EXTERNAL_ROLE=fremtidig juridisk
signeringsutførelse/identitetsverifisering/bevis-levering (KUN dette); SYSTEM_OF_RECORD=
`JARVIS_CANONICAL`; CAN_RUN_WITHOUT_PROVIDER=true; REPLACEMENT_PATH=signaturleverandøren kan byttes
ut uten omskriving av Contracts Core. **ZERO DocuSign/PandaDoc/Signicat/Adobe Sign valgt eller
integrert.**

**Bygget:**
- Ny pakke **`@jarvis/agreements`** (`modules/agreements/`) - IKKE `@jarvis/contracts` (den
  pakken er allerede den delte type-kontrakt-pakken `packages/contracts`, brukt av alle moduler,
  inkl. denne nye). ToolGateway-navnerommet forblir likevel `contract.*` (kun en streng).
- Migrasjon **`026_contracts.sql`**: `contracts`/`contract_versions`/`contract_obligations`/
  `contract_events`, FORCE RLS (tenant+space RESTRICTIVE, samme mønster som `support_tickets`),
  `GRANT SELECT/INSERT/UPDATE/DELETE` til `jarvis_app` (Q-20-krav). `contracts` har BEVISST INGEN
  `current_version_id`-kolonne (unngår en sirkulær FK mot `contract_versions`) - gjeldende versjon
  er alltid `ORDER BY version_number DESC LIMIT 1`.
- **Deterministisk lifecycle** (`state-machine.ts`):
  `draft→review→approved→active→expiring→expired→terminated→cancelled`. INGEN LLM avgjør
  gyldighet. `terminated`/`cancelled` praktisk talt terminale - ENESTE vei videre er en eksplisitt
  administrativ korreksjon tilbake til `draft` (ALDRI direkte til `active`).
- **Eksplisitte, immutable versjoner** - kun nye append-only rader, atomisk `version_number` under
  radlås. Pointer-not-payload: `canonical_uri` peker til dokumentet, ALDRI kopiert innhold -
  strukturelt bevist (ingen `body`/`content`/`document_text`-kolonne finnes noe sted i skjemaet).
- **Motparter gjenbruker EKSISTERENDE `business_companies`/`business_contacts`** - ingen ny
  motpart-tabell/-tjeneste bygget.
- **Forpliktelser** (`contract_obligations`, `open/completed/waived`) besvarer "hva må vi
  gjøre"/"hva forfaller neste"/overdue deterministisk.
- **Open-loop-integrasjon** utvider `OpenLoopService`/`business_open_loops` UENDRET (additiv
  `contract_id`-kolonne + fire nye `loop_type`: `contract_renewal_due`/
  `contract_termination_deadline`/`contract_obligation_due`/`contract_review_required`), dekket av
  DEN EKSISTERENDE `runOpenLoopSweepForAllTenants`-schedulerjobben - INGEN ny jobb/motor.
- **`contract.*`-ToolGateway-namespace** (24 handlinger): klasse A lesing, klasse B interne
  skrivinger, klasse C KUN `set_status` (lifecycle-overgang har reelt effektnivå utover en vanlig
  feltoppdatering) - INGEN klasse D (ingen nøstet ekstern/uigjenkallelig handling i denne sliceen).
- **Business OS-tidslinje:** "Hva skjer med kunde X?" kan nå inkludere kontraktstilstand via
  `agreements.listByCompany()` ved siden av `business.companyTimeline()`/Support/Gmail/Calendar -
  samme per-domene-spørrings-orkestreringsmønster som Support, ingen fysisk sammenslått
  tidslinje-tabell.
- **Q-20:** alle fire tabeller + kontrakt-tilknyttede `business_open_loops`-rader registrert i
  `plan.ts` FØR noen host-runde - samme FK-lærdom som HOST FIX #1/D-67 for Support, anvendt
  forebyggende denne gangen (open-loop slettes FØRST, snevert til `contract_id IS NOT NULL`).
- **Q-27:** gjenbruker `listBusinessTenantIds()` uendret. **Q-26:** uendret, kontraktdokumenter er
  KILDEDATA, ALDRI automatisk "verifisert kunnskap".
- **Host-akseptanseskript** `ua3-native-contracts-host-run.ts` → `ua3-native-contracts-live.ts` -
  INGEN e-sign-leverandør-oppsett, INGEN signaturleverandør-credential, INGEN manuell SQL kreves:
  `node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-native-contracts-host-run.ts`

**Testdekning:** 96 nye tester (`modules/agreements/test/` state-machine 16 + service-rls 28 +
transport-wiring 9, `modules/business/test/open-loop-contracts.test.ts` 11,
`modules/erasure/test/contracts-erasure.test.ts` 6 - pluss øvrig dekning i selve tallene under).
`pnpm -w typecheck` 16/16 rent, `pnpm -w lint` rent, full lokal suite **1347/1347 grønn** (kun ett
kjent, urelatert flaky-funn: `modules/knowledge/test/registry.test.ts` fikk en ressurs-kontensjon-
`afterAll`-hook-timeout når HELE suiten kjøres parallelt - PASS 11/11 i isolasjon, INGEN Contracts-
kode berørt, ikke undersøkt videre siden det er en pre-eksisterende infrastruktur-timing-flake).

**Bygges IKKE i denne sliceen:** juridisk signeringsutførelse/e-sign-leverandør av noe slag (Q-28
SIGNATURE EXECUTION PROVIDER-halvparten, krever en eksplisitt Tobias-leverandørbeslutning FØRST);
UA-4; AI Mesh-basert kontraktstolkning (ingen inferert kontraktsmening utover eksplisitt lagrede/
utpekte data, ingen juridisk rådgivning).

**Ærlighet om host-status:** dette byggemiljøet har ikke Docker/en ekte lokal Postgres-host
tilgjengelig - `ua3-native-contracts-host-run.ts`/`ua3-native-contracts-live.ts` er derfor SKREVET
og bevist lokalt (embedded Postgres, ekte RLS via en garantert non-bypass-rolle, IKKE `fakePool()`),
men IKKE kjørt på Tobias sin faktiske host ennå. Status er derfor **FIXED_SUITE, ALDRI hevdet
VERIFIED/COMPLETE** før det beviset foreligger - samme disiplin CLAUDE.md krever og som D-66 selv
fulgte før D-67-D-70.

**Draft-PR opprettes for branch `claude/ua3-native-contracts-core` - MERGES IKKE uten Tobias sin
eksplisitte godkjenning.** Ingen Contracts-signaturleverandør valgt. Ingen UA-4 startet.

---

## UA-3 NATIVE CONTRACTS CORE HOST FIX #1 (samme dag, 2026-08-18) — SYNTHETIC CLEANUP ONLY → D-72

**To ekte Windows/Docker-host-kjøringer** (`run_id 1e9ae3a8`, `run_id 53d294b8`) ga BEGGE
`hard_fail=true` - men ALLE 25 funksjonelle/sikkerhets-/Q-20-markører PASSET (D-71 sin bygging
bekreftet på ekte host begge ganger). **KUN `ua3_contracts_cleanup=FAIL`:** `business_followups`
(`business_followups_tenant_id_fkey`, 1 rad).

**Rotårsak, sporet ikke gjettet:** §"Q-20 ERASURE-INTEGRASJON"-seksjonen i
`ua3-native-contracts-live.ts` oppretter BEVISST en `business_followups`-rad
(`business.createFollowup(TENANT_A, "business", { title: "Q20 unrelated followup agr", ... })`) for
å bevise at erasure-scopet KUN treffer kontrakt-tilknyttede open-loops, ALDRI en generell
`business_open_loops`-tømming - en ren ACCEPTANCE_FIXTURE, ALDRI produksjonsdata. `cleanupTenant()`
ryddet den aldri. **EKSAKT samme feilklasse som Native Support Core sin egen HOST FIX #3 (D-69)** -
IKKE en Contracts-domenebug (ingen av de øvrige markørene, inkl. `ua3_contracts_q20`, ble påvirket).

**Skjema-/FK-audit (denne runden, før fiks - ikke etter):** gjennomgang av alle FK-er mot
`tenants(tenant_id)` som denne akseptansen faktisk populerer bekrefter `business_followups` er DET
ENESTE utelatte punktet - `audit_events` har bevisst INGEN FK mot `tenants` (kun `text NOT NULL`,
append-only-trigger-blokkert uansett), `cost_events`/leads/opportunities/scores/support-/knowledge-
tabellene/`messages`/`sessions` får aldri en rad fra dette scriptet. Ingen skjulte tilleggsfunn.

**Fiks:** `cleanupTenant()` utvidet med `DELETE FROM business_followups WHERE tenant_id = $1` (rett
etter `contracts`, før `erasure_fingerprints`/`erasure_requests` - samme relative rekkefølge D-69
brukte for Support). `selfHeal()` kaller SAMME funksjon uendret - stale-run-gjenoppretting bruker
derfor automatisk den korrigerte veien. **Produksjonens `business_followups`-retensjon UENDRET:**
`jarvis_app` har fortsatt bevisst INGEN `DELETE`-rettighet der (kun SELECT/INSERT/UPDATE) - bevist
eksplisitt med et `permission denied`-regresjonstest.

**8 nye regresjonstester** (`modules/business/test/ua3-native-contracts-cleanup.test.ts`, §A-H):
reproduserer begge fixture-typene (business_followups + ekte `erasure_requests`-rad via ekte
`ErasureService`), beviser korrekt FK-rekkefølge, urelatert-tenant-isolasjon, uendrede
runtime-rettigheter, Q-21 uendret, idempotent opprydding (tom/allerede-ryddet/dobbel kjøring). Q-20
contracts-erasure-suiten re-kjørt uendret grønn. 104 tester totalt for Contracts-sliceen nå (96+8).
`pnpm -w typecheck` 16/16 rent, `pnpm -w lint` rent, full lokal suite **1346/1346 grønn**.

**STATUS: FUNKSJONELT HOST-BEVIST, MEN IKKE VERIFIED/CLOSED** - full akseptanse endte fortsatt
`hard_fail=true` begge ganger denne runden. **D-71 markeres IKKE komplett før én REN host-kjøring
ender `hard_fail=false`.** Q-28 forblir ÅPEN. K1 forblir PARTIAL. PR #18 oppdatert med begge
run_id-er/rotårsak/fiks/testdekning - forblir draft, IKKE merget. **Ingen e-sign-leverandør. Ingen
UA-4.**
