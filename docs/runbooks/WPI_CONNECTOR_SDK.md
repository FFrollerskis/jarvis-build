# Connector SDK / Connector Factory (WP-I, D-472) - runbook

**Status: `BUILT_UNWIRED` (utvikler- og CI-verktøy; CI-vakten er `WIRED` som test-port). Enhetstestet - men INGENTING er kjørt mot en ekte leverandør (`NOT VERIFIED` på NAS/sandbox), INGENTING er koblet til kjøretiden, og kontraktstest-beviset er `modelled` (mot en fake bygget fra manifestet), aldri `proven`.** Dette er en beskrivelses-, validerings- og testmodul
(masterplan Sovereign Autonomy v4.0 kap. 10 «Connector Factory og maintenance model», UA-0 «standardisert Connector SDK», Appendiks B «Connector acceptance nivå R / A»). Den endrer ingen eksisterende
connector: `CONNECTOR_REGISTRY` og verktøydefinisjonene er uendret og forblir kjøretidens sannhetskilde; manifestene BESKRIVER dem og sjekkes MOT dem.
Rettet etter uavhengig review (M1-M5 + LOW): se §11 for det som fortsatt er `DEFERRED`/`PARTIAL`.

Kilder i repoet: `docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` (kap. 10, Appendiks B), CLAUDE.md regel 3, 11 (D-41), 12 (D-64), `modules/tool-gateway/src/connector-registry.ts`, `tool-manifest.ts`,
`class-d-pipeline.ts`, Integrasjonssenteret (`apps/api/src/control-center/integration.ts`), migrasjon 077 (`connector_maintenance_log`), EV-17 (`modules/self-modification/src/evolution/credentials.ts`).

## 0. Status i ett blikk

| Del | Status | Bevis |
|---|---|---|
| `ConnectorManifest` (kap. 10-feltene) + redaksjonssikker validator | `BUILT_UNWIRED` | `modules/connector-sdk/src/{manifest,validate}.ts`, `test/manifest-schema.test.ts` |
| Skeleton-avledning fra registeret (58 av 58 oppføringer; D-64-svarene er IKKE forhåndssvart) | `BUILT_UNWIRED` | `src/derive.ts`, `test/derive.test.ts`, drift-test mot Integrasjonssenteret i `apps/api/test/wpi-connector-sdk-drift.test.ts` |
| Tre FULLE referansemanifester (GitHub, Cloudflare/WP-E1, Stripe/WP-F1) | `BUILT_UNWIRED` | `src/manifests/*.ts`, `test/catalogue.test.ts` |
| Kontraktstest-kit `runConnectorContract` (27 sjekker) + fake-adapter-harness (31 defekter) + Appendiks B-scoring - bak subpath-en `@jarvis/connector-sdk/testing` | `BUILT_UNWIRED` (utvikler-/testverktøy) | `src/testing.ts`, `src/contract/*.ts`, `test/contract-kit.test.ts`, `test/references/`, `test/testing-split.test.ts` |
| CI-vakt for manifester (18 regler, inkl. skeleton-baselinen) | `WIRED` som CI-port (kjører i `pnpm test`, ikke i kjøretiden) | `src/guard.ts`, `test/guard.test.ts` |
| Arbeidsliste-/kontraktrapport `scripts/report.ts` (`guard`, `contract <id>`) | `BUILT_UNWIRED` (kjøres av en person) | `test/report-cli.test.ts` |
| Connector-gjeld (ren lesemodell) | `BUILT_UNWIRED`; kobling til Integrasjonssenteret `DEFERRED` (§8) | `src/debt.ts`, `test/debt.test.ts` |
| Scaffold-generator `ops/connector/new-connector.mjs` | `BUILT_UNWIRED` (kjøres av en person) | `ops/connector/test/new-connector.test.mjs`, `test/scaffold.test.ts` |
| Kontraktstest-kit mot EKTE transport bak en fake leverandørserver (`adapter_kind: real_transport`) | `DEFERRED` (§5) | - |
| Live smoke mot sandbox for noen connector | `BLOCKED_EXTERNAL` (krever eierens credential) | - |

**Flagg, tabeller, ruter, verktøy, sider, migrasjoner: ingen.** Ingenting kjører ved oppstart, ingenting kaller, skriver eller sender. Ingen produksjonskode importerer `@jarvis/connector-sdk`
(sjekk: `grep -rln "@jarvis/connector-sdk" apps modules ops --include=*.ts --include=*.mjs --include=*.json` utenfor `modules/connector-sdk/` gir ingen treff; drift-testen i `apps/api/test` leser pakken via relativ sti
til hovedinngangen, og `apps/api` har bevisst ingen pakkeavhengighet). DORMANT-regelen er dermed oppfylt uten flagg: pakken har ingen effekt før noen eksplisitt importerer den.
Eneste filer utenfor de nye mappene (`modules/connector-sdk/`, `ops/connector/`, dette dokumentet): `apps/api/test/wpi-connector-sdk-drift.test.ts` (ren test) og importer-blokken for den nye pakken i `pnpm-lock.yaml`.

**To innganger (review M1, D-396/JARVIS-096).** Hovedinngangen `@jarvis/connector-sdk` har manifestmodellen, validator, avledning, katalog/drift, vakt, gjeld og referansemanifestene - og INGEN fake-/harness-symboler. Kittet, fake-harnessen (`createFakeConnector`, `FAKE_DEFECTS`,
`VirtualClock`, `FAKE_TENANT`, `FAKE_CREDENTIAL_CANARY`, `secretShapes`, `INJECTION_PAYLOAD`, `settle`) og Appendiks B-scoringen nås kun via `@jarvis/connector-sdk/testing` (`src/testing.ts`, samme mønster som `@jarvis/core/testing`).
`test/testing-split.test.ts` låser at hovedinngangen ikke eksporterer noen av de åtte symbolene eller noe som matcher `Fake*`/`create*Fake*`/`FAKE_*`/`Virtual*`/`Canary`, at import-grafen fra `src/index.ts` aldri når `src/contract/` eller `src/testing.ts`, at `exports`-kartet er nøyaktig `.` og `./testing`,
og (via `@ts-expect-error`) at harness-typer ikke finnes i hovedinngangen. D-396-vakten (`modules/core/test/d396-fake-export-guard.test.ts`) er UENDRET (den matcher kun `export class Fake*|Scripted*|InMemory*|Mock*`); testing-split-testen er en NY, strengere vakt for denne pakken.

## 1. Slik legger du til en ny connector (standard prosedyre)

Rekkefølgen er bindende (CLAUDE.md regel 11 og 12): ingen connector «fordi den kan være nyttig» - den må støtte en aktiv verdi-løkke, et kontrollsenter eller en konkret veikartavhengighet (kap. 10).

1. **D-64 Core-vs-Adapter-porten FØR leverandøren velges.** Hva eier Jarvis (kanonisk tilstand, policy, minne), hva er leverandøren (kilde/sluk/utførelse)? Svaret (`core_boundary.system_of_record`: `JARVIS_CANONICAL` / `EXTERNAL_CANONICAL` / `HYBRID_WITH_CLEAR_AUTHORITY`, og
   `core_dependency_decision_required`) loggføres i beslutningsloggen og siteres med `decision_refs` (D-id). Blir leverandøren en kjerneavhengighet: **STOPP** og meld `CORE_DEPENDENCY_DECISION_REQUIRED=true` til eieren - validatoren
   avviser et fullt manifest der `core_dependency_decision_required` er `true`. Skeletons og malen FORHÅNDSSVARER aldri porten (svarene står som `Unknown`, `basis: unassessed`).
2. **D-41 kapabilitetsrevisjon** mot OFFISIELL dokumentasjon: lese/skrive/slette/tilgangsstyring, scopes for FULL nyttig tilgang (aldri gjettet), risikoklasse A-D per handling, eier vs delegert, idempotens,
   trygg test-sandbox. Alt leverandøren tilbyr som ikke er bygget står i `d41_audit.gaps` som `DEFERRED`/`PARTIAL` - aldri stille utelatt. Read-only er bare lovlig med en av D-41s fem grunner (`read_only_reason`).
3. **Registrer** connectoren i `connector-registry.ts` og verktøydefinisjonene i `integrations.ts` (uendret prosess - registeret er sannheten). Fra dette øyeblikket (bygd kategori) krever CI-vakten et fullt manifest ELLER en bevisst oppføring i `SKELETON_BASELINE` (§7).
4. **Generer utkastet:** `node ops/connector/new-connector.mjs --id <id> --name "<Navn>" [--vendor "<Leverandør>"] [--tool-id <tool_id>] [--write]` (§9; `--write` betyr at utkastet får en SKRIVEHANDLING og dermed nivå A - filene skrives alltid, bruk `--dry-run` for å bare se hva som ville bli laget).
   Det lager manifest, fake-adapter, kontraktstest og runbook-stub.
5. **Fyll ut manifestet** til `completeness: "full"` (`source: "authored"`): hver `unknownField(...)` og hver `TODO` byttes med en ekte verdi (inkl. D-64-svarene med `basis: "audited"` og `decision_refs`). Handlingsradene må være NØYAKTIG registerets (CI-vakten sjekker det).
   Legg manifestet til i `FULL_MANIFESTS` (`src/manifests/index.ts`) og FJERN id-en fra `SKELETON_BASELINE` (samme fil; vakten feiler hvis begge står der - baselinen kan bare krympe).
6. **Kjør** `pnpm exec vitest run modules/connector-sdk`: kontraktstest-kittet (§5) og CI-vakten (§7). Se akseptansegapene (§6) som arbeidsliste: `node --experimental-transform-types modules/connector-sdk/scripts/report.ts contract <id>`.
7. **Skriv runbooken ferdig** (stubben har D-64/D-41-tabellene og en NAS-verifiseringsliste). Live smoke mot sandbox er `BLOCKED_EXTERNAL` til eieren har gitt credential; `NOT VERIFIED` står til en ekte kjøring er observert.

## 2. ConnectorManifest (kap. 10, «Manifest-felt Krav»)

Skjemaet (`src/manifest.ts`, zod, `.strict()` overalt) har nøyaktig kap. 10-seksjonene - `SECTION_10_FIELDS` er masterplanens tabell ordrett og låses av en test:
`identity` (name, vendor, version, owner, environment) · `auth` (type, scopes, rotation) · `capabilities` (read, write, actions, webhooks, sync, search) · `authority` (owner, delegated, tenant, risk class, approval policy)
· `reversibility` (rollback method, compensating action, destructive flag, snapshot support) · `idempotency` (dedupe key, retry semantics, exactly-once target) · `limits` (rate limits, quotas, owner caps)
· `trust` (output trust, injection exposure, sanitization) · `data` (schemas, provenance, freshness, retention, delete semantics) · `operations` (health check, timeout, circuit breaker, metrics, runbook, maintenance owner)
· `secrets` (kun hvelvreferanser; `model_visibility` er bokstavelig `never`) · `tests` (fake adapter, contract, live smoke, authority, recovery, security).
I tillegg to obligatoriske tillegg: `d41_audit` (CLAUDE.md regel 11) og `core_boundary` (regel 12/D-64).

**Per-handling-fakta** (risikoklasse A-D, effekt, step-up, rollback-metode, kompenserende handling, destruktiv, før-/etter-evidens, klasse D-kjedens tilstand, idempotenskrav, tillit, rate limit, tidsavbrudd,
påkrevde parametre) ligger i `actions[]` under fasetter oppkalt etter seksjonene - én rad per `tool_id.action`.

**To nivåer (`completeness`):** `skeleton` = avledet fra registeret; det som IKKE kan avledes er en eksplisitt `Unknown`-markør `{ unknown: true, reason }` (aldri en oppfunnet verdi). `full` = håndskrevet og gjennomgått:
ingen `Unknown`, `source: "authored"`, `core_boundary.basis: "audited"`.

**D-64-grensen (`core_boundary`, review M3).** `system_of_record` og `core_dependency_decision_required` er SVARENE på Core-vs-Adapter-porten, og kan derfor være `Unknown`. `basis: "unassessed"` = porten er ikke kjørt: begge svar SKAL være ukjent (en påstand uten revisjon avvises:
`unassessed_boundary_asserts`). `basis: "audited"` = porten er kjørt: begge svar er kjent og `decision_refs` (D-id i beslutningsloggen) peker på beslutningen som loggførte dem (`audited_boundary_without_decision`); CI-vakten sjekker at beslutningen finnes (`decision_ref_missing`).
HYBRID krever `authority_split`. De tre fulle referansene siterer GitHub `D-94` (+ `D-64`), Cloudflare `D-461`, Stripe `D-109`.

**Validatoren** (`validateConnectorManifest`) gir presise og REDAKSJONSSIKRE feil: `path` + `code` + skjema-ord, aldri den innsendte verdien (zod sin «received ...» siteres ikke; hemmelighetsformede nøkkelnavn vises som `<redacted>`).
Den sentrale hemmelighetsskanneren (`scanForSecrets` fra `@jarvis/core`, ÉN skanner) går over alle tekstverdier og nøkkelnavn. Identifikatorer (handlingsnøkler, connector-id) som skanneren kjenner igjen avvises i selve skjemaet (`secret_shaped_identifier`: regexen alene godtok `ghp_<24 tegn>.read`);
den semantiske fasen - den eneste som gjentar identifikatorer i meldinger - kjøres ikke når skanneren fant en hemmelighetsform eller ikke rakk å skanne alt; og ALLE meldingsveier (validator, drift, vakt, kittets subjects/evidens, `ConnectorManifestError.issues`) viser identifikatorer via `safeIdentifier` (`<redacted>`).
Semantiske regler speiler kjøretiden: effekt -> minimum risikoklasse (`MIN_RISK_FOR_EFFECT`, speiler `MIN_RISK_BY_EFFECT` i `tool-manifest.ts`), klasse D-kjeden (`assessClassDPipeline`: gjenopprettingsplan, fersk lesing + etterbetingelse; `exempt` krever en begrunnelse),
idempotens (D/send/pay = required; `safe_retry` på tidsavbrudd/5xx avvises når skrivehandlinger ikke er leverandør-idempotente), delete = destruktiv, D-41-konsistens (FULL/PARTIAL/READ_ONLY/PROVIDER_LIMITED; FULL kan ikke ha ikke-vurderte kapabiliteter; hver skrive-/utførende handling må stå under skriv, slett eller tilgangsstyring i revisjonen - aldri stille utelatt;
slettesemantikken `supported`/`not_offered` må ikke motsi revisjonens `provider_offers`), D-64 (se over).

**Grenser for hemmelighetsvernet (ærlig).** «Fanger hemmeligheter» betyr: formene den sentrale skanneren (`modules/core/src/services/secret-scan.ts`) kjenner - kjente token-formater (GitHub, Anthropic/OpenAI, Stripe, Slack, AWS-tilgangsnøkkel `AKIA...`, Google, Telegram, JWT), private nøkler, `Bearer ...`,
URL med passord, `NAVN=verdi` der navnet ser ut som en hemmelighet, «passord er ...»-fraser og Luhn-gyldige kortnumre. Skanneren er bevisst høy-presisjon og er IKKE en garanti. Kjente hull (verifisert i review, ikke lukket her - kjernebegrensning i skanneren): tokens delt med nullbredde-tegn, fullbredde-tegn
(`ｇｈｐ＿...`), et token delt over to felt, `Authorization: Basic <base64>`, AWS HEMMELIGE nøkler (kun tilgangsnøkkel-id er et mønster), og rene hex-/base64-strenger uten nøkkelord. Påstander i denne pakken om at noe «aldri lekker» gjelder derfor formene skanneren kjenner, pluss den ene kjente kanarifuglen kittet bruker.

## 3. Avledning og drift (registeret er sannheten)

`deriveSkeletonManifests({ definitions })` lager ett skeleton per `CONNECTOR_REGISTRY`-oppføring fra registeret + `ToolDefinition` + verktøymanifestet (`buildToolManifest`). Handling -> connector-koblingen er den samme
regelen som Integrasjonssenterets `connectorViews()` (credential-ref eller live-test-verktøy); `wpi-connector-sdk-drift.test.ts` låser at de to gir NØYAKTIG samme handlingsmengde for hele registeret.
Skeletonet er ærlig: leverandørnavn, auth-type, leverandør-scopes, rotasjon, D-41-revisjon, retensjon, runbook, tester og **D-64-svarene (`system_of_record`, `core_dependency_decision_required`)** er `Unknown` - arbeidslisten per connector (`unknown_fields_by_connector` i vaktens rapport, kun for skeletons).
Før review M3 hevdet alle 58 skeletons `EXTERNAL_CANONICAL`/`false`; beslutningsloggen har `HYBRID_WITH_CLEAR_AUTHORITY` for fiken (D-107), stripe (D-109), vipps (D-110), neonomics (D-111) og wallester (D-112), og GitHub (D-94) / Cloudflare (D-461) er `EXTERNAL_CANONICAL` - de loggførte svarene
er innspill til de neste fulle manifestene (`audited` + `decision_refs`), ikke noe et skeleton skal gjette.
API-versjon og synk-jobber avledes bare når kalleren gir dem (Integrasjonssenterets `CONNECTOR_API_FACTS`/`CONNECTOR_SYNC_JOBS`); ellers er de ukjent, aldri «ingen».

**Drift:** et fullt manifest må være IDENTISK med registeret i alt som kan avledes: id, navn, eier-art, handlingsmengden (ingen manglende, ingen ukjente), og per handling art, effekt, risikoklasse, step-up, owner-only, reversibel, før-/etter-evidens, klasse D-kjedens tilstand,
at en destruktiv handling ikke underdeklareres, idempotenskrav og leverandør-idempotens, tillit, rate limit, tidsavbrudd, identitetsfelt og påkrevde parametre; på connector-nivå scope-etikettene handlingene deklarerer og credential-referansene, og (når kalleren gir dem) API-versjon, synk-jobber og helsesjekk.
De 29 driftkodene er uttømmende listet (`DRIFT_CODES`), og `catalogue.test.ts` har en mutasjon per kode (en ny kode uten mutasjon feiler testen). Narrativ som registeret ikke kan si noe om (runbook, retensjon, D-41-revisjon) sammenlignes ikke.

## 4. De tre referanseconnectorene

| | GitHub | Cloudflare (WP-E1) | Stripe (WP-F1) |
|---|---|---|---|
| Handlinger (registerets) | 23 (10 lese, 13 skrive/utførende) | 21 (13 lese, 8 skrive) | 3 (2 lese, `submit_refund` klasse D) |
| D-41-klassifisering | `PARTIAL` (9 navngitte gap) | `PARTIAL` (8 gap) | `PARTIAL` (5 gap, inkl. sletting og tilgangsstyring) |
| Scopes verifisert mot dokumentasjon | **delvis** (5 verifisert 2026-10-09; den valgfrie Workflows-tillatelsen er dokumentert i `GITHUB_APP.md`, men hvilke handlinger som trenger den er uverifisert; `scopes_verified_against_docs: false`) | **delvis** (3 uverifiserte: rolle-liste, konto-medlemsliste (List Members), dashbord-navn for kontoeide tokens; purge-maksimum og 90-dagers rotasjon er også UVERIFISERT) | **nei** (tillatelsesnavn ikke lest i WP-I; refusjons-tillatelsen er UVERIFISERT) |
| `system_of_record` (D-64-porten loggført i) | `EXTERNAL_CANONICAL` (D-94, D-64) | `EXTERNAL_CANONICAL` (D-461) | `HYBRID_WITH_CLEAR_AUTHORITY` (D-109: Jarvis eier intensjon/idempotens/journal/avstemming, Stripe eier betalingstilstand og pengebevegelse) |
| Circuit breaker | `partial` (rate-limit-kontroller D-97, manuell frys) | `partial` (InfraExecutionGate, manuell pause) | `partial` (finans-nødbryter, frys, step-up) |
| Runbook | `GITHUB_APP.md` | `CLOUDFLARE_CONNECTOR.md` | `FINANCE_D_CHAIN.md` |
| Live smoke | `BLOCKED_EXTERNAL` (Q-31) | `BLOCKED_EXTERNAL` (runbook §6) | `BLOCKED_EXTERNAL` (D-228 var FØR WP-F1) |

**Verifisert/uverifisert mot leverandørdokumentasjon (review).** Bekreftet av reviewer via søkesammendrag av offisielle sider (ikke primærdokumentasjon): GitHub merge = Contents write, create/delete ref + list branches = Contents, rerun/cancel/dispatch = Actions write, request reviewers = Pull requests write, labels = Issues eller PR write,
installasjonstoken 5000/t (+50/t per repo over 20, tak 12500); Cloudflare 1200 req/5 min per bruker med `Retry-After`, audit logs v2 = Account Settings Read/Write; Stripe `balance_read`, `payment_intent_read/write`, idempotensnøkler opptil 255 tegn ryddet etter minst 24 t. **IKKE bekreftet (merket `unverified` i manifestene):**
Cloudflare List Members-/list roles-tillatelsen, purge-maksimum og 90-dagers rotasjon (Jarvis' egen anbefaling, ikke et leverandørkrav); Stripe-refusjonens tillatelsesnavn (sammendrag grupperer refusjoner under `charge_write`); GitHub Workflows-kartleggingen. Stripes 23 t-vindu er Jarvis' egen avgjørelse (D-462), ikke et Stripe-tall.

**Funn under byggingen (ikke rettet - WP-I endrer ingen eksisterende connector; føres til eier/arkitekt):**
1. Stripe: registerets `credential_refs` har kun secret key; webhook-hemmeligheten, tenant-id og test-nøkkelen (FINANCE_D_CHAIN §5) er ikke synlige i Integrasjonssenteret (samme feilklasse som D-245/D-246). Manifestet følger registeret og noterer det.
2. GitHub: transporten gjentar aldri selv en mutasjon ved 5xx (D-392/JARVIS-018, `isRetrySafeStatus`), men en 5xx på en mutasjon kastes som en vanlig feil og MERKES IKKE `outcome_unknown` (kun gateway-tidsavbrudd og transporter som selv sier `outcome_unknown:` gir ukjent utfall, `gateway.ts`).
   Handlinger uten leverandør-idempotens (`create_issue`, `comment_on_issue`, rerun/cancel/dispatch) kan derfor i teorien dobbeltutføres hvis en KALLER prøver på nytt uten å avstemme mot GitHub. Manifestet erklærer kontrakten (`reconcile_before_retry`) og navngir gapet i
   `idempotency.retry_semantics.note`. Kittet har nå sjekken `errors.write_5xx_is_outcome_unknown` og fakeen modellerer kontrakten - men fakeen er laget fra manifestet; den ekte transportens 5xx-oppførsel er uendret og ubevist (samme åpne punkt som WP-K 018: HTTP 5xx-svar er ikke dekket).
3. GitHub: de eldre klasse D-handlingene `merge_pr` og `delete_branch` mangler `step_up_required` (allerede kjent i lukkingsmatrisen, UA-5).
4. De to klasse D-handlingene uten komplett kjede (`mcp_zapier.call_tool`, `microsoft_outlook.send_mail`) er `deferred` i skeletonene og regnes som `gap` i akseptansen (utilgjengelige under håndhevelse, jf. `EXPECTED_DEFERRED` i `modules/tool-gateway/test/part3-class-d-pipeline.test.ts`; `derive.test.ts` speiler listen, så en ny klasse D-handling uten kjede gjør testen rød).

## 5. Kontraktstest-kittet

`runConnectorContract(manifest, adapter)` (`src/contract/kit.ts`, importeres fra `@jarvis/connector-sdk/testing`) kjører 27 sjekker mot en `ContractAdapter` på **virtuell klokke** (ingen ekte ventetid, ingen nettverk). `skip` er aldri `pass`; en sjekk som kaster blir `fail`.
Rapporten bærer `adapter_kind` (`fake_from_manifest` | `real_transport`); ALL tekst kittet sender ut (detail, subjects, evidens) redigeres til slutt (`redactText`), også når verdien kommer fra adapteren eller et uvalidert manifest.

| Sjekk (id) | Nivå | Hva den beviser (mot adapteren under test) |
|---|---|---|
| `manifest.valid` / `manifest.adapter_matches` / `manifest.secret_scan` | R | gyldig manifest; adapteren eksponerer nøyaktig manifestets handlinger og id; ingen hemmelighetsform i manifestet |
| `read.returns_data` | R | lese-handlinger gir data uten leverandør-effekt |
| `trust.labelling` / `trust.injection_is_data` | R | utdata merkes med manifestets tillitsnivå; innsprøytingstekst forblir data (ubetrodd), aldri i kontrollfelt |
| `errors.taxonomy` | R | auth/rate limit/nettverk/ikke funnet/ugyldig gir riktig kategori og retry-signal (5xx: retry-bar på lesing, ikke på skriving) |
| `health.degrades_and_recovers` | R | auth-feil -> `auth_failed`, rate limit -> `rate_limited`, nettverk -> `unavailable`; vellykket kall gjenoppretter; ugyldig/ikke funnet er ikke helsebevis |
| `timeout.abort` | R | tidsavbrudd: connectoren stopper, svarer `timeout`, lekker ingen timere |
| `redaction.no_secret_shapes` / `audit.no_secret_values` | R | credential og hemmelighetsformer lekker aldri (svar, feil, logg, revisjon), selv når leverandøren siterer dem - for HVER feilklasse (auth, 429, nettverk, 5xx, ikke funnet, ugyldig, tidsavbrudd før/etter effekt), for lesing og skriving |
| `revoke.and_reauth` / `data.delete_semantics_declared` | R | tilbakekalt credential stanser alt (også en gjentakelse av et utført kall) uten leverandørkall; gjenopprettet virker; slettesemantikk er deklarert |
| `params.validated_before_provider` | A | ugyldige parametre avvises før leverandøren (ingen kall, ingen effekt); HVER påkrevd parameter fjernes i tur, for lesing og skriving |
| `idempotency.same_key_one_effect` / `distinct_keys_distinct_effects` / `required_key_enforced` / `key_reuse_other_payload` | A | samme nøkkel to ganger = én effekt; ulike nøkler = ulike effekter; påkrevd nøkkel håndheves; samme nøkkel med annen nyttelast AVVISES (`conflict`/`invalid_input`, aldri en ny effekt og aldri det gamle resultatet gjentatt som deduplisert), og det opprinnelige kallet kan fortsatt gjentas |
| `evidence.before_after` | A | før-/etter-readback eller leverandørens bekreftede id; når leverandør-tilstanden endret seg, skiller før-evidensen seg fra etter-evidensen |
| `timeout.after_effect_unknown_not_replayed` / `timeout.before_effect_applies_nothing` | A | avbrudd ETTER effekten = «ukjent utfall» (`outcome_unknown`, gjentas aldri); avbrudd FØR effekten = ingen effekt og trygg retry |
| `errors.write_5xx_is_outcome_unknown` | A | 5xx på en SKRIVING er «ukjent utfall» (`outcome_unknown`, ikke retry-bar), og samme nøkkel gir aldri en ny effekt (avstem først) |
| `authority.tenant_isolation` / `authority.delegated` | A | fremmed tenant nektes - også når den gjentar eierens idempotensnøkkel (kryss-tenant-replay: tenant-sjekk FØR dedupe-oppslag); delegert følger manifestets modus (nektet / krever godkjenning for C/D / lik eier) |
| `recovery.rollback_restores_state` | A | automatisk rollback gjenoppretter tilstanden (hoppes over, med årsak, for dokumentert manuell/ingen reversering) |
| `classd.chain_and_notification` | A | komplett klasse D-kjede gir evidens og umiddelbar varsling; ufullstendig kjede er utilgjengelig (fail-closed) |
| `control.pause_blocks_all` | A | pause/kill switch stanser alle kall (også en gjentakelse av et utført kall) uten leverandørkall |

**Fake-adapter-harnessen** (`createFakeConnector({ manifest, handlers?, defects? })`) modellerer Jarvis' kjøre-kontrakt (ToolGateway + transport) ut fra manifestet. Leverandørspesifikk oppførsel legges inn som `handlers` per handling
(`read`, `run`, `readback`, `sample`); en handler som siterer tredjepartstekst MÅ bruke `ctx.redact(...)` - kittet feller en som lekker. En 5xx på en skriving modelleres som `outcome_unknown` (ikke retry-bar, ledgeren settes til ukjent, same-key-replay avstemmes aldri blindt); på en lesing som vanlig retry-bar nettverksfeil.
De 31 `defects` finnes KUN for kittets egne mutasjonstester: hver defekt gjør fakeen brutal mot nøyaktig én egenskap, og testen låser den EKSAKTE mengden sjekker den feller (`toEqual`, ikke `toContain`; følgefeil som deler ledger står eksplisitt). I tillegg bygger testen reviewens subtilt gale adaptere UTENFRA (wrappere: ledger før nyttelast-/tenant-sjekk,
credential i 429, før-evidens lik etter-evidens, stille standardverdi for 2. påkrevde parameter, 5xx som retry-bar feil, effekt til tross for avbrudd) og viser at hver sjekk i kittet kan feile (ingen vakuøse sjekker).

**Ærlig grense:** harnessen er en MODELL, og de tre referansefakene er laget fra de samme manifestene de testes mot. Referansetestene beviser at manifestenes deklarerte garantier er konsistente og at kittet fanger brudd - de beviser IKKE at de ekte transportene
(`GithubTransport`, `CloudflareTransport`, Stripe-transporten) holder dem. De har egne tester (manifestenes `tests`-felt). Derfor er kit-beviset `modelled`, ikke `proven` (§6). Broen som kjører samme kit mot en ekte transport bak en fake leverandørserver (`adapter_kind: real_transport`) er `DEFERRED`;
den må også levere `snapshot()`, `effects()`, `providerCalls()` og feilinjeksjon fra den falske leverandørserveren.

## 6. Akseptansenivå R / A (Appendiks B)

`scoreAcceptance(manifest, checks, adapterKind?)`: nivå R (10 krav) for lese-/synk-connectorer; nivå A (11 krav, det første er «alle nivå R-krav oppfylt») så snart connectoren har en skrive-/utførende handling. Hvert krav får en ÆRLIG status:
`proven` (kittet kjørte det mot en EKTE transport - ingen connector har dette i dag) · `modelled` (kittet kjørte det mot en fake bygget fra manifestet: konsistent og kittet kan felle brudd, men ikke bevist mot en ekte transport) · `declared` (manifestet påstår det; ingenting har utført det) · `gap` (kittet feilet, eller manifestet deklarerer selv at det mangler: circuit breaker `partial`, D-41-gap, ufullstendig klasse D-kjede)
· `not_proven` (krever live-/ekstern evidens: live read-smoke, reversibel live-handling) · `not_applicable`. Dom: `gaps` / `live_evidence_pending` / `complete_on_paper`. Rapporten (`adapter_kind`) sier hva beviset er laget mot; manglende eller ukjent proveniens regnes som fake (fail-safe). **Ingenting er `VERIFIED`** - det krever en kjøring mot ekte leverandør.

Dagens dom for referansene: **`gaps`** for alle tre (pinnet i `reference-connectors.contract.test.ts`; kittet består 27/27 for GitHub og Cloudflare og 26 + 1 begrunnet hopp-over for Stripe, som ikke har automatisk rollback). Alle tre har de samme tre gapene: `R.docs_checked` (scopes ikke fullt verifisert),
`R.health_retry_breaker_runbook` (circuit breaker `partial`) og `A.all_level_r` (følger av de forrige). `R.live_read_smoke` og `A.live_reversible_action_smoke` er `not_proven` for alle, og ingen kit-bevis er `proven` (kun `modelled`).
Kittet hopper over sjekkene som krever skrivehandlinger (`needsWrites`) for en ren lese-connector; et hopp er aldri `pass`.

## 7. CI-vakten (`guard.test.ts`)

`runManifestGuard({ definitions, authored, fileExists, decisionExists })` bygger katalogen (ett manifest per registeroppføring: det håndskrevne når det finnes, ellers skeletonet) og reviderer den. 18 regler (`GUARD_RULES`, låst av testen):
registeroppføring uten manifest (defensivt: katalogen må ha en oppføring per registeroppføring) · ugyldig manifest · manglende eier / tillitsklasse / risikoklasse per handling (sjekket på det RÅ manifestet) · håndskrevet manifest som ikke er `full` · fullt manifest uten runbook (`runbook_not_declared`) / runbook-fil som ikke finnes
· teststi som ikke finnes / «present» uten sti · **hemmelighetsVERDI i manifestet** (kun hvelvreferanser; verdien gjentas aldri i bruddet) · **skrivekapabel connector uten idempotensinfo** · drift mot registeret · foreldreløst/dobbelt manifest · **`built_connector_unreviewed`** · **`skeleton_baseline_stale`** · **`decision_ref_missing`**.
I tillegg feiler en manifestfil i `src/manifests/` som ikke er registrert i `FULL_MANIFESTS`. Hva du gjør når den feiler: les `rule` + `path` i bruddet, rett manifestet (eller registeret, hvis det er registeret som er endret med vilje), kjør testen på nytt.

**Hva vakten garanterer (review M5 - ærlig).** Et skeleton avledes AUTOMATISK for hver registeroppføring, så en registeroppføring uten manifest kan ikke oppstå, og vakten kan ikke kreve at «et manifest følger med» i den forstand. Det den kan kreve: en NY BYGD connector (kategori ikke backlog) må ha et fullt manifest eller en BEVISST oppføring i den committede
`SKELETON_BASELINE` (`src/manifests/index.ts`; i dag de 48 bygde registeroppføringene uten fullt manifest) - ellers `built_connector_unreviewed`. Baselinen kan bare krympe (samme idé som D-396-vakten): en id som ikke finnes, en backlog-oppføring eller en connector som nå har fullt manifest gir `skeleton_baseline_stale`.
Backlog trenger ingen oppføring til den bygges. En connector med et håndskrevet (også ugyldig) manifest regnes ikke som uten manifest. Vakten svekkes aldri stille: et manifest den ikke kan lese er et brudd, ikke en hopp-over; `decisionExists` er påkrevd input (ikke valgfri).
Grense: «finnes» betyr at filen/beslutningen eksisterer - vakten leser ikke innholdet i runbook eller tester (en tom fil teller), se §11.

## 8. Connector-gjeld (`computeConnectorDebt`)

Ren lesemodell over data som finnes i dag - vedlikeholdsjournalen (`connector_maintenance_log`, `modules/core/src/db/migrations/077_connector_maintenance_log.sql`: `event_kind`, `minutes`, `occurred_at`), auth-feil/helse, synk-forsinkelse og API-fakta. Seks faktorer (kap. 10): auth-feil, API-endringer, vedlikeholdstimer
(varsel fra 3 t = Integrasjonssenterets 180 min, høy fra 8 t), hendelser (incident/outage), synk-forsinkelse (som multiplum av forventet intervall) og utfasingsrisiko. **Ikke målt = `unknown`, aldri null gjeld**; en UGYLDIG måling (NaN, uendelig, negativ, forventet intervall 0 eller negativt) er også `unknown` - aldri stille «ok» (review LOW: `lag/0` og `0/0` ga før fail-open);
utfasing er kjent-høy eller ukjent (repoet kjenner ingen «ingen utfasing»-tilstand); færre enn to målte faktorer gir `level: unknown` uten score. `review_for_retirement` (mye tid OG gjentatte hendelser) er en oppfordring til å se på connectoren (kap. 20), aldri en beslutning.

**Kobling mot Integrasjonssenteret: `DEFERRED`.** Hvorfor ikke gjort: (1) senteret leser journalen aggregert per connector, ikke per `event_kind` - gjelden trenger `SELECT connector_id, event_kind, count(*), sum(minutes) FROM connector_maintenance_log WHERE tenant_id = $1 AND occurred_at >= $2 GROUP BY 1, 2`;
(2) `wph0-integration-center.test.ts` låser seksjonslisten (`live, configured_other, not_configured, maintenance, jobs, backlog`) og `wph0-dependencies-down.test.ts` låser kildene - en ny seksjon ville endret eksisterende tester; (3) `apps/api` har ingen avhengighet til pakken (endring i `package.json`, lockfile og Docker-bygg).
Når det skal gjøres: legg `@jarvis/connector-sdk` til i `apps/api` og importer KUN hovedinngangen (`@jarvis/connector-sdk`) - ALDRI `/testing` (harnessen med `FAKE_DEFECTS` skal ikke inn i API-modulgrafen, JARVIS-096; `test/testing-split.test.ts` sørger for at hovedinngangen er fri for den),
legg den grupperte spørringen i `readMaintenance`, map `AuditToolRow`/`JobState`/`CONNECTOR_API_FACTS` til `DebtInput`, legg en `debt`-seksjon sist i listen og oppdater de to testene bevisst.

## 9. Scaffold-generatoren

`node ops/connector/new-connector.mjs --id <connector_id> --name "<Visningsnavn>" [--vendor "<Leverandør>"] [--tool-id <tool_id>] [--write] [--root <mappe>] [--dry-run]` (ren Node, ingen avhengigheter, ingen nettverk).
`--write` = utkastet får også en skrivehandling (klasse B) og krever dermed akseptansenivå A (uten den: kun én lese-handling, nivå R); `--dry-run` skriver ingenting; `--root` er mappen filene skrives under (standard repo-roten).
Avslutter 0 = ok, 1 = ugyldig bruk, 2 = ville overskrive. Lager fire filer fra malene i `modules/connector-sdk/templates/`: `src/manifests/<id>.ts` (skeleton), `test/connectors/<id>.fake.ts`, `test/connectors/<id>.contract.test.ts` (importerer kittet og harnessen fra `src/testing.ts`), `docs/runbooks/CONNECTOR_<ID>.md`.
**Nekter å overskrive** (alle mål sjekkes før noe skrives; kode 2; filer OG mapper som ble laget før en sti ble blokkert fjernes - mapper kun hvis de er tomme), validerer `--id` (snake_case uten ledende/avsluttende/doble understreker, samme form som connector-id i manifestskjemaet - `ab_` og `a__b` ga en ugyldig hvelvreferanse) og visningstekst
(ingen anførselstegn/backslash/backtick/`$`/`*`/`|`/klammer, og ingen kontroll-, usynlige eller retningsstyrende tegn: nullbredde, bidi, U+0085, U+2028/U+2029 - kan aldri bryte ut av TS-strenger eller kommentarer, og heller ikke skjule tegn i genererte filer),
skriver aldri utenfor `--root`: stien sjekkes leksikalt OG via symlenke-gjennomgang (en symlenke inne i roten som peker ut eller er dinglende gir kode 1 før noe skrives; en symlenke som peker innenfor roten, og en `--root` som selv er en symlenke, er lovlige). `--root /` fungerer.
Utkastet er ærlig: skeleton med `unknownField("TODO ...")` (inkl. D-64-svarene - malen forhåndssvarer dem aldri), og det er IKKE en ferdig connector (CI-vakten feiler på en manifestfil som ikke er registrert i `FULL_MANIFESTS`, og en ny bygd registeroppføring krever fullt manifest eller baseline-oppføring).
Testet ende-til-ende: det genererte manifestet validerer, fakeen følger det og kontraktstest-kittet består (`test/scaffold.test.ts`); den genererte kontraktstesten er kjørt grønn.

## 10. Verifisering på NAS (`NOT VERIFIED`)

Pakken har ingen kjøretid å verifisere på NAS; dette er hva eieren/arkitekten kan gjøre for å se at den holder (alle kommandoer kjøres fra repo-roten; Node 22; `ExperimentalWarning` fra `--experimental-transform-types` er forventet):
1. `git pull`, `pnpm install --frozen-lockfile`, `pnpm exec vitest run modules/connector-sdk ops/connector apps/api/test/wpi-connector-sdk-drift.test.ts modules/core/test/d396-fake-export-guard.test.ts` - alle grønne.
2. **Skeleton-arbeidslisten:** `node --experimental-transform-types modules/connector-sdk/scripts/report.ts guard` (`--json` for hele rapporten). Forventet: `CI-vakt: OK (0 brudd)`, `fulle manifester: github, cloudflare, stripe`, `skeletons: 55`, `skeleton-baseline (bygde uten fullt manifest): 48`, og en liste med ukjent-markører per skeleton (flest først) - de neste kandidatene til `full`.
3. **Per connector med fullt manifest:** `node --experimental-transform-types modules/connector-sdk/scripts/report.ts contract github` (også `cloudflare`, `stripe`, og et scaffold-utkast `<id>`). Forventet: `27 bestått, 0 feilet` (Stripe 26 + 1 hopp-over), `adapter_kind: fake_from_manifest`, og akseptanse-gapene (`GAP`/`NOT_PROVEN`) som arbeidsliste - lukk dem eller dokumenter dem ærlig.
   Live smoke er først `present` etter en observert kjøring mot sandbox (runbookene har trinnene).

## 11. Kjente begrensninger (`DEFERRED` / `PARTIAL`, aldri stille utelatt)

- `DEFERRED`: kontraktstest-kit mot en ekte transport bak en fake leverandørserver (broen fra `ToolTransport` til `ContractAdapter`, `adapter_kind: real_transport`). Til den finnes er alt kit-bevis `modelled`, og transport-egenskapene manifestene deklarerer (f.eks. GitHubs 5xx-oppførsel) er ubevist.
- `DEFERRED`: kobling av connector-gjeld til Integrasjonssenteret (§8); full manifest for de øvrige 48 bygde connectorene + 7 backlog (skeleton finnes for alle - arbeidslisten er `scripts/report.ts guard`; de 48 står i `SKELETON_BASELINE`).
- `DEFERRED`: «Factory»-abstraksjon utover scaffold. Masterplanen sier: første 3-5 connectorer bygges manuelt etter samme standard, factory abstraheres etter at mønsteret er bevist. Tre referanser er bevist her; mønsteret er ikke bevist mot en NY connector bygget fra scaffold.
- `DEFERRED` (review M5, risiko): `src/production-definitions.ts` er et HÅNDFØRT SPEIL av det `apps/api/src/main.ts` registrerer (`firstWaveTools(...)` + `additionalTools`, den ene `register`-løkken). Drift-testen kan ikke se en ny connector-bundet verktøyfamilie i main.ts, fordi begge sider får samme liste. Delvis dekket:
  `derive.test.ts` feller en NY bygd registeroppføring som ikke får én eneste handling herfra. IKKE dekket: en ny verktøyfamilie bundet til en EKSISTERENDE connectors credential. Lukkes først når main.ts og SDK-et deler ÉN liste (delt fabrikk i `@jarvis/tool-gateway`) - en endring i kjøretidskoden WP-I bevisst ikke gjør.
- `DEFERRED` (LOW): vakten godtar enhver eksisterende fil som runbook-/testbevis og enhver eksisterende beslutningsrad som `decision_refs` (innholdet leses ikke; en tom fil teller). Kan strammes (filstørrelse, `.md`/`.test.ts`-form, krav om at runbooken nevner connector-id) uten å røre kjøretiden.
- `DEFERRED` (kjernebegrensning, review LOW): hemmelighetsskannerens kjente hull (§2: nullbredde-delte tokens, fullbredde-tegn, tokens delt over felt, Basic-auth, AWS hemmelige nøkler, hex/base64) er IKKE lukket - skanneren er felles (`@jarvis/core`) og endres ikke av WP-I. Pakkens «fanger hemmeligheter»-påstander gjelder formene den kjenner.
- `DEFERRED` (LOW): scaffold-generatorens sjekk av symlenker og eksisterende filer er en sjekk-så-skriv uten lås (en lokal utviklers egen race, ikke et angrepsscenario); Windows-stier er ikke testet.
- `PARTIAL`: akseptansen kan aldri bli bedre enn `complete_on_paper` uten live-evidens (`BLOCKED_EXTERNAL`); `modelled` er ikke `proven`.
- `PARTIAL`: leverandørfakta som er `unverified` i manifestene (§4): GitHub Workflows-kartleggingen, Cloudflare List Members-/list roles-tillatelse, purge-maksimum og 90-dagers rotasjon, Stripe-tillatelsesnavn (inkl. refusjon). Egen gjennomgang mot offisiell dokumentasjon gjenstår (`docs.github.com`/`developers.cloudflare.com` var blokkert for WebFetch i review).
- `PARTIAL`: terskler i connector-gjeld er grove standarder (justerbare) - ikke kalibrert mot eierens faktiske vedlikeholdsdata (journalen er ung).
- Ikke bygget, bevisst: ingen leverandør valgt eller endret, ingen ny auth-modell, ingen ny migrasjon, ingen endring i `CONNECTOR_REGISTRY` eller noen transport (ingen parallell connector-SDK i kjøretiden, jf. RUNTIME_GATES).

## 12. Rollback / av-bryter

Ingenting å slå av: pakken har ingen kjøretidseffekt. Fjerne den helt: slett `modules/connector-sdk/`, `ops/connector/`, `apps/api/test/wpi-connector-sdk-drift.test.ts` og importer-blokken i `pnpm-lock.yaml` (`pnpm install`). Ingen produksjonskode, ingen data, ingen konfig berøres.
