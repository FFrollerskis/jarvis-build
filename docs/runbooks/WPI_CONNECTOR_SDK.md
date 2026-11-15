# Connector SDK / Connector Factory (WP-I, D-472) - runbook

**Status: BYGGET OG ENHETSTESTET - INGENTING ER KJØRT MOT EKTE LEVERANDØR OG INGENTING ER KOBLET TIL KJØRETIDEN. `NOT VERIFIED` på NAS.** Dette er en beskrivelses-, validerings- og testmodul
(masterplan Sovereign Autonomy v4.0 kap. 10 «Connector Factory og maintenance model», UA-0 «standardisert Connector SDK», Appendiks B «Connector acceptance nivå R / A»). Den endrer ingen eksisterende
connector: `CONNECTOR_REGISTRY` og verktøydefinisjonene er uendret og forblir kjøretidens sannhetskilde; manifestene BESKRIVER dem og sjekkes MOT dem.

Kilder i repoet: `docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` (kap. 10, Appendiks B), CLAUDE.md regel 3, 11 (D-41), 12 (D-64), `modules/tool-gateway/src/connector-registry.ts`, `tool-manifest.ts`,
`class-d-pipeline.ts`, Integrasjonssenteret (`apps/api/src/control-center/integration.ts`), migrasjon 077 (`connector_maintenance_log`), EV-17 (`modules/self-modification/src/evolution/credentials.ts`).

## 0. Status i ett blikk

| Del | Status | Bevis |
|---|---|---|
| `ConnectorManifest` (kap. 10-feltene) + redaksjonssikker validator | `BUILT_UNWIRED` | `modules/connector-sdk/src/{manifest,validate}.ts`, `test/manifest-schema.test.ts` |
| Skeleton-avledning fra registeret (58 av 58 oppføringer) | `BUILT_UNWIRED` | `src/derive.ts`, `test/derive.test.ts`, drift-test mot Integrasjonssenteret i `apps/api/test/wpi-connector-sdk-drift.test.ts` |
| Tre FULLE referansemanifester (GitHub, Cloudflare/WP-E1, Stripe/WP-F1) | `BUILT_UNWIRED` | `src/manifests/*.ts`, `test/catalogue.test.ts` |
| Kontraktstest-kit `runConnectorContract` + fake-adapter-harness + Appendiks B-scoring | `BUILT_UNWIRED` (utvikler-/testverktøy) | `src/contract/*.ts`, `test/contract-kit.test.ts`, `test/references/` |
| CI-vakt for manifester | `WIRED` som CI-port (kjører i `pnpm test`, ikke i kjøretiden) | `src/guard.ts`, `test/guard.test.ts` |
| Connector-gjeld (ren lesemodell) | `BUILT_UNWIRED`; kobling til Integrasjonssenteret `DEFERRED` (§8) | `src/debt.ts`, `test/debt.test.ts` |
| Scaffold-generator `ops/connector/new-connector.mjs` | `BUILT_UNWIRED` (kjøres av en person) | `ops/connector/test/new-connector.test.mjs`, `test/scaffold.test.ts` |
| Kontraktstest-kit mot EKTE transport bak en fake leverandørserver | `DEFERRED` (§5) | - |
| Live smoke mot sandbox for noen connector | `BLOCKED_EXTERNAL` (krever eierens credential) | - |

**Flagg, tabeller, ruter, verktøy, sider, migrasjoner: ingen.** Ingenting kjører ved oppstart, ingenting kaller, skriver eller sender. Ingen produksjonskode importerer `@jarvis/connector-sdk`
(sjekk: `grep -rln "@jarvis/connector-sdk" apps modules ops --include=*.ts --include=*.mjs --include=*.json` utenfor `modules/connector-sdk/` gir ingen treff; drift-testen i `apps/api/test` leser pakken via relativ sti,
og `apps/api` har bevisst ingen pakkeavhengighet). DORMANT-regelen er dermed oppfylt uten flagg: pakken har ingen effekt før noen eksplisitt importerer den.
Eneste filer utenfor de nye mappene (`modules/connector-sdk/`, `ops/connector/`, dette dokumentet): `apps/api/test/wpi-connector-sdk-drift.test.ts` (ren test) og importer-blokken for den nye pakken i `pnpm-lock.yaml`.

## 1. Slik legger du til en ny connector (standard prosedyre)

Rekkefølgen er bindende (CLAUDE.md regel 11 og 12): ingen connector «fordi den kan være nyttig» - den må støtte en aktiv verdi-løkke, et kontrollsenter eller en konkret veikartavhengighet (kap. 10).

1. **D-64 Core-vs-Adapter-porten FØR leverandøren velges.** Hva eier Jarvis (kanonisk tilstand, policy, minne), hva er leverandøren (kilde/sluk/utførelse)? Sett `core_boundary.system_of_record`
   (`JARVIS_CANONICAL` / `EXTERNAL_CANONICAL` / `HYBRID_WITH_CLEAR_AUTHORITY`). Blir leverandøren en kjerneavhengighet: **STOPP** og meld `CORE_DEPENDENCY_DECISION_REQUIRED=true` til eieren - validatoren
   avviser et fullt manifest der `core_dependency_decision_required` er `true`.
2. **D-41 kapabilitetsrevisjon** mot OFFISIELL dokumentasjon: lese/skrive/slette/tilgangsstyring, scopes for FULL nyttig tilgang (aldri gjettet), risikoklasse A-D per handling, eier vs delegert, idempotens,
   trygg test-sandbox. Alt leverandøren tilbyr som ikke er bygget står i `d41_audit.gaps` som `DEFERRED`/`PARTIAL` - aldri stille utelatt. Read-only er bare lovlig med en av D-41s fem grunner (`read_only_reason`).
3. **Registrer** connectoren i `connector-registry.ts` og verktøydefinisjonene i `integrations.ts` (uendret prosess - registeret er sannheten).
4. **Generer utkastet:** `node ops/connector/new-connector.mjs --id <id> --name "<Navn>" [--vendor "<Leverandør>"] [--tool-id <tool_id>] [--write]` (§9; `--write` betyr at utkastet får en SKRIVEHANDLING og dermed nivå A - filene skrives alltid, bruk `--dry-run` for å bare se hva som ville bli laget).
   Det lager manifest, fake-adapter, kontraktstest og runbook-stub.
5. **Fyll ut manifestet** til `completeness: "full"` (`source: "authored"`): hver `unknownField(...)` og hver `TODO` byttes med en ekte verdi. Handlingsradene må være NØYAKTIG registerets (CI-vakten sjekker det).
   Legg manifestet til i `FULL_MANIFESTS` (`src/manifests/index.ts`).
6. **Kjør** `pnpm exec vitest run modules/connector-sdk`: kontraktstest-kittet (§5) og CI-vakten (§7). Akseptansegapene kittet viser (§6) er arbeidslisten.
7. **Skriv runbooken ferdig** (stubben har D-64/D-41-tabellene og en NAS-verifiseringsliste). Live smoke mot sandbox er `BLOCKED_EXTERNAL` til eieren har gitt credential; `NOT VERIFIED` står til en ekte kjøring er observert.

## 2. ConnectorManifest (kap. 10, «Manifest-felt Krav»)

Skjemaet (`src/manifest.ts`, zod, `.strict()` overalt) har nøyaktig kap. 10-seksjonene - `SECTION_10_FIELDS` er masterplanens tabell ordrett og låses av en test:
`identity` (name, vendor, version, owner, environment) · `auth` (type, scopes, rotation) · `capabilities` (read, write, actions, webhooks, sync, search) · `authority` (owner, delegated, tenant, risk class, approval policy)
· `reversibility` (rollback method, compensating action, destructive flag, snapshot support) · `idempotency` (dedupe key, retry semantics, exactly-once target) · `limits` (rate limits, quotas, owner caps)
· `trust` (output trust, injection exposure, sanitization) · `data` (schemas, provenance, freshness, retention, delete semantics) · `operations` (health check, timeout, circuit breaker, metrics, runbook, maintenance owner)
· `secrets` (kun hvelvreferanser; `model_visibility` er bokstavelig `never`) · `tests` (fake adapter, contract, live smoke, authority, recovery, security).
I tillegg to obligatoriske tillegg: `d41_audit` (CLAUDE.md regel 11) og `core_boundary.system_of_record` (regel 12/D-64).

**Per-handling-fakta** (risikoklasse A-D, effekt, step-up, rollback-metode, kompenserende handling, destruktiv, før-/etter-evidens, klasse D-kjedens tilstand, idempotenskrav, tillit, rate limit, tidsavbrudd,
påkrevde parametre) ligger i `actions[]` under fasetter oppkalt etter seksjonene - én rad per `tool_id.action`.

**To nivåer (`completeness`):** `skeleton` = avledet fra registeret; det som IKKE kan avledes er en eksplisitt `Unknown`-markør `{ unknown: true, reason }` (aldri en oppfunnet verdi). `full` = håndskrevet og gjennomgått:
ingen `Unknown`, `source: "authored"`, `core_boundary.basis: "audited"`.

**Validatoren** (`validateConnectorManifest`) gir presise og REDAKSJONSSIKRE feil: `path` + `code` + skjema-ord, aldri den innsendte verdien (zod sin «received ...» siteres ikke; hemmelighetsformede nøkkelnavn vises som
`<redacted>`). Den sentrale hemmelighetsskanneren (`scanForSecrets`) går over alle tekstverdier og nøkkelnavn. Semantiske regler speiler kjøretiden: effekt -> minimum risikoklasse (`MIN_RISK_BY_EFFECT`),
klasse D-kjeden (`assessClassDPipeline`: gjenopprettingsplan, fersk lesing + etterbetingelse), idempotens (D/send/pay = required), delete = destruktiv, D-41-konsistens (FULL/PARTIAL/READ_ONLY/PROVIDER_LIMITED),
D-64 (HYBRID krever `authority_split`). Minimumsklassen per effekt er `MIN_RISK_FOR_EFFECT` i `src/manifest.ts` (speiler `MIN_RISK_BY_EFFECT` i `modules/tool-gateway/src/tool-manifest.ts`).

## 3. Avledning og drift (registeret er sannheten)

`deriveSkeletonManifests({ definitions })` lager ett skeleton per `CONNECTOR_REGISTRY`-oppføring fra registeret + `ToolDefinition` + verktøymanifestet (`buildToolManifest`). Handling -> connector-koblingen er den samme
regelen som Integrasjonssenterets `connectorViews()` (credential-ref eller live-test-verktøy); `wpi-connector-sdk-drift.test.ts` låser at de to gir NØYAKTIG samme handlingsmengde for hele registeret.
Skeletonet er ærlig: leverandørnavn, auth-type, leverandør-scopes, rotasjon, D-41-revisjon, retensjon, runbook og tester er `Unknown` - arbeidslisten per connector (`unknown_fields_by_connector` i vaktens rapport).
API-versjon og synk-jobber avledes bare når kalleren gir dem (Integrasjonssenterets `CONNECTOR_API_FACTS`/`CONNECTOR_SYNC_JOBS`); ellers er de ukjent, aldri «ingen».

**Drift:** et fullt manifest må være IDENTISK med registeret i alt som kan avledes: id, navn, eier-art, handlingsmengden (ingen manglende, ingen ukjente), og per handling art, effekt, risikoklasse, step-up, owner-only, reversibel, før-/etter-evidens, klasse D-kjedens tilstand,
at en destruktiv handling ikke underdeklareres, idempotenskrav og leverandør-idempotens, tillit, rate limit, tidsavbrudd, identitetsfelt og påkrevde parametre; på connector-nivå scope-etikettene handlingene deklarerer og credential-referansene, og (når kalleren gir dem) API-versjon, synk-jobber og helsesjekk.
Endres registeret uten at manifestet følger med, feiler `guard.test.ts`/`catalogue.test.ts` (mutasjonstester beviser det). Narrativ som registeret ikke kan si noe om (runbook, retensjon, D-41-revisjon) sammenlignes ikke.

## 4. De tre referanseconnectorene

| | GitHub | Cloudflare (WP-E1) | Stripe (WP-F1) |
|---|---|---|---|
| Handlinger (registerets) | 23 (10 lese, 13 skrive/utførende) | 21 (13 lese, 8 skrive) | 3 (2 lese, `submit_refund` klasse D) |
| D-41-klassifisering | `PARTIAL` (9 navngitte gap) | `PARTIAL` (6 gap) | `PARTIAL` (3 gap) |
| Scopes verifisert mot dokumentasjon | ja (github/docs, 2026-10-09) | **delvis** (2 uverifiserte; `scopes_verified_against_docs: false`) | **nei** (tillatelsesnavn ikke lest i WP-I) |
| `system_of_record` | `EXTERNAL_CANONICAL` (ARCHITECTURE.md §11.9) | `EXTERNAL_CANONICAL` (runbook D-64) | `HYBRID_WITH_CLEAR_AUTHORITY` (Jarvis eier intensjon/journal/avstemming, Stripe eier betalingstilstand og pengebevegelse) |
| Circuit breaker | `partial` (rate-limit-kontroller D-97, manuell frys) | `partial` (InfraExecutionGate, manuell pause) | `partial` (finans-nødbryter, frys, step-up) |
| Runbook | `GITHUB_APP.md` | `CLOUDFLARE_CONNECTOR.md` | `FINANCE_D_CHAIN.md` |
| Live smoke | `BLOCKED_EXTERNAL` (Q-31) | `BLOCKED_EXTERNAL` (runbook §6) | `BLOCKED_EXTERNAL` (D-228 var FØR WP-F1) |

**Funn under byggingen (ikke rettet - WP-I endrer ingen eksisterende connector; føres til eier/arkitekt):**
1. Stripe: registerets `credential_refs` har kun secret key; webhook-hemmeligheten, tenant-id og test-nøkkelen (FINANCE_D_CHAIN §5) er ikke synlige i Integrasjonssenteret (samme feilklasse som D-245/D-246). Manifestet følger registeret og noterer det.
2. GitHub: transporten gjentar aldri selv en mutasjon ved 5xx (D-392/JARVIS-018, `isRetrySafeStatus`), men en 5xx på en mutasjon kastes som en vanlig feil og MERKES IKKE `outcome_unknown` (kun gateway-tidsavbrudd og transporter som selv sier `outcome_unknown:` gir ukjent utfall, `gateway.ts`).
   Handlinger uten leverandør-idempotens (`create_issue`, `comment_on_issue`, rerun/cancel/dispatch) kan derfor i teorien dobbeltutføres hvis en KALLER prøver på nytt uten å avstemme mot GitHub. Manifestet erklærer kontrakten (`reconcile_before_retry`) og navngir gapet i
   `idempotency.retry_semantics.note`; kontraktstest-kittet kan ikke vise det (fakeen modellerer kontrakten, ikke den ekte transportens 5xx-oppførsel).
3. GitHub: de eldre klasse D-handlingene `merge_pr` og `delete_branch` mangler `step_up_required` (allerede kjent i lukkingsmatrisen, UA-5).
4. De to klasse D-handlingene uten komplett kjede (`mcp_zapier.call_tool`, `microsoft_outlook.send_mail`) er `deferred` i skeletonene og regnes som `gap` i akseptansen (utilgjengelige under håndhevelse, jf. `EXPECTED_DEFERRED`).

## 5. Kontraktstest-kittet

`runConnectorContract(manifest, adapter)` (`src/contract/kit.ts`) kjører 26 sjekker mot en `ContractAdapter` på **virtuell klokke** (ingen ekte ventetid, ingen nettverk). `skip` er aldri `pass`; en sjekk som kaster blir `fail`.

| Sjekk (id) | Nivå | Hva den beviser |
|---|---|---|
| `manifest.valid` / `manifest.adapter_matches` / `manifest.secret_scan` | R | gyldig manifest; adapteren eksponerer nøyaktig manifestets handlinger og id; ingen hemmelighetsform i manifestet |
| `read.returns_data` | R | lese-handlinger gir data uten leverandør-effekt |
| `trust.labelling` / `trust.injection_is_data` | R | utdata merkes med manifestets tillitsnivå; innsprøytingstekst forblir data (ubetrodd), aldri i kontrollfelt |
| `errors.taxonomy` | R | auth/rate limit/nettverk/ikke funnet/ugyldig gir riktig kategori og retry-signal |
| `health.degrades_and_recovers` | R | auth-feil -> `auth_failed`, rate limit -> `rate_limited`, nettverk -> `unavailable`; vellykket kall gjenoppretter; ugyldig/ikke funnet er ikke helsebevis |
| `timeout.abort` | R | tidsavbrudd: connectoren stopper, svarer `timeout`, lekker ingen timere |
| `redaction.no_secret_shapes` / `audit.no_secret_values` | R | credential og hemmelighetsformer lekker aldri (svar, feil, logg, revisjon), selv når leverandøren siterer dem |
| `revoke.and_reauth` / `data.delete_semantics_declared` | R | tilbakekalt credential stanser alt uten leverandørkall; gjenopprettet virker; slettesemantikk er deklarert |
| `params.validated_before_provider` | A | ugyldige parametre avvises før leverandøren (ingen kall, ingen effekt) |
| `idempotency.same_key_one_effect` / `distinct_keys_distinct_effects` / `required_key_enforced` / `key_reuse_other_payload` | A | samme nøkkel to ganger = én effekt; ulike nøkler = ulike effekter; påkrevd nøkkel håndheves; samme nøkkel med annen nyttelast gir aldri en ny effekt |
| `evidence.before_after` | A | før-/etter-readback eller leverandørens bekreftede id |
| `timeout.after_effect_unknown_not_replayed` / `timeout.before_effect_applies_nothing` | A | avbrudd ETTER effekten = «ukjent utfall» (`outcome_unknown`, gjentas aldri); avbrudd FØR effekten = ingen effekt og trygg retry |
| `authority.tenant_isolation` / `authority.delegated` | A | fremmed tenant nektes; delegert følger manifestets modus (nektet / krever godkjenning for C/D / lik eier) |
| `recovery.rollback_restores_state` | A | automatisk rollback gjenoppretter tilstanden (hoppes over, med årsak, for dokumentert manuell/ingen reversering) |
| `classd.chain_and_notification` | A | komplett klasse D-kjede gir evidens og umiddelbar varsling; ufullstendig kjede er utilgjengelig (fail-closed) |
| `control.pause_blocks_all` | A | pause/kill switch stanser alle kall uten leverandørkall |

**Fake-adapter-harnessen** (`createFakeConnector({ manifest, handlers?, defects? })`) modellerer Jarvis' kjøre-kontrakt (ToolGateway + transport) ut fra manifestet. Leverandørspesifikk oppførsel legges inn som `handlers` per handling
(`read`, `run`, `readback`, `sample`); en handler som siterer tredjepartstekst MÅ bruke `ctx.redact(...)` - kittet feller en som lekker. De 21 `defects` finnes KUN for kittets egne mutasjonstester: hver defekt gjør fakeen brutal mot nøyaktig én
egenskap, og testen låser at kittet feller den (`FAKE_DEFECTS` er uttømmende dekket).

**Ærlig grense:** harnessen er en MODELL. Referansetestene beviser at manifestenes deklarerte garantier er konsistente og at kittet kjører dem mot en adapter som følger kontrakten - de beviser IKKE at de ekte transportene
(`GithubTransport`, `CloudflareTransport`, Stripe-transporten) holder dem. De har egne tester (manifestenes `tests`-felt). Broen som kjører samme kit mot en ekte transport bak en fake leverandørserver er `DEFERRED`.

## 6. Akseptansenivå R / A (Appendiks B)

`scoreAcceptance(manifest, checks)`: nivå R (10 krav) for lese-/synk-connectorer; nivå A (11 krav, inkluderer alle R-krav) så snart connectoren har en skrive-/utførende handling. Hvert krav får en ÆRLIG status:
`proven` (kittet kjørte det mot adapteren) · `declared` (manifestet påstår det; ingenting har utført det) · `gap` (kittet feilet, eller manifestet deklarerer selv at det mangler: circuit breaker `partial`, D-41-gap, ufullstendig klasse D-kjede)
· `not_proven` (krever live-/ekstern evidens: live read-smoke, reversibel live-handling) · `not_applicable`. Dom: `gaps` / `live_evidence_pending` / `complete_on_paper`. **Ingenting er `VERIFIED`** - det krever en kjøring mot ekte leverandør.

Dagens dom for referansene: **`gaps`** for alle tre (pinnet i `reference-connectors.contract.test.ts`; kittet består 26/26 for GitHub og Cloudflare og 25 + 1 begrunnet hopp-over for Stripe, som ikke har automatisk rollback): GitHub har gapene `R.health_retry_breaker_runbook` (circuit breaker `partial`) og
`A.all_level_r` (følger av det forrige); Cloudflare og Stripe i tillegg `R.docs_checked` (scopes ikke fullt verifisert). `R.live_read_smoke` og `A.live_reversible_action_smoke` er `not_proven` for alle.
Kittet hopper over sjekkene som krever skrivehandlinger (`needsWrites`) for en ren lese-connector; et hopp er aldri `pass`.

## 7. CI-vakten (`guard.test.ts`)

`runManifestGuard({ definitions, authored, fileExists })` bygger katalogen (ett manifest per registeroppføring: det håndskrevne når det finnes, ellers skeletonet) og reviderer den. 15 regler (`GUARD_RULES`, låst av testen):
registeroppføring uten manifest · ugyldig manifest · manglende eier / tillitsklasse / risikoklasse per handling (sjekket på det RÅ manifestet) · håndskrevet manifest som ikke er `full` · fullt manifest uten runbook / runbook-fil som ikke finnes
· teststi som ikke finnes / «present» uten sti · **hemmelighetsVERDI i manifestet** (kun hvelvreferanser; verdien gjentas aldri i bruddet) · **skrivekapabel connector uten idempotensinfo** · drift mot registeret · foreldreløst/dobbelt manifest.
I tillegg feiler en manifestfil i `src/manifests/` som ikke er registrert i `FULL_MANIFESTS`. Hva du gjør når den feiler: les `rule` + `path` i bruddet, rett manifestet (eller registeret, hvis det er registeret som er endret med vilje), kjør testen på nytt.
Vakten svekkes aldri stille: et manifest den ikke kan lese er et brudd, ikke en hopp-over.

## 8. Connector-gjeld (`computeConnectorDebt`)

Ren lesemodell over data som finnes i dag - vedlikeholdsjournalen (`connector_maintenance_log`, `modules/core/src/db/migrations/077_connector_maintenance_log.sql`: `event_kind`, `minutes`, `occurred_at`), auth-feil/helse, synk-forsinkelse og API-fakta. Seks faktorer (kap. 10): auth-feil, API-endringer, vedlikeholdstimer
(varsel fra 3 t = Integrasjonssenterets 180 min, høy fra 8 t), hendelser (incident/outage), synk-forsinkelse (som multiplum av forventet intervall) og utfasingsrisiko. **Ikke målt = `unknown`, aldri null gjeld**; utfasing er kjent-høy eller ukjent
(repoet kjenner ingen «ingen utfasing»-tilstand); færre enn to målte faktorer gir `level: unknown` uten score. `review_for_retirement` (mye tid OG gjentatte hendelser) er en oppfordring til å se på connectoren (kap. 20), aldri en beslutning.

**Kobling mot Integrasjonssenteret: `DEFERRED`.** Hvorfor ikke gjort: (1) senteret leser journalen aggregert per connector, ikke per `event_kind` - gjelden trenger `SELECT connector_id, event_kind, count(*), sum(minutes) FROM connector_maintenance_log WHERE tenant_id = $1 AND occurred_at >= $2 GROUP BY 1, 2`;
(2) `wph0-integration-center.test.ts` låser seksjonslisten (`live, configured_other, not_configured, maintenance, jobs, backlog`) og `wph0-dependencies-down.test.ts` låser kildene - en ny seksjon ville endret eksisterende tester; (3) `apps/api` har ingen avhengighet til pakken (endring i `package.json`, lockfile og Docker-bygg).
Når det skal gjøres: legg `@jarvis/connector-sdk` til i `apps/api`, legg den grupperte spørringen i `readMaintenance`, map `AuditToolRow`/`JobState`/`CONNECTOR_API_FACTS` til `DebtInput`, legg en `debt`-seksjon sist i listen og oppdater de to testene bevisst.

## 9. Scaffold-generatoren

`node ops/connector/new-connector.mjs --id <connector_id> --name "<Visningsnavn>" [--vendor "<Leverandør>"] [--tool-id <tool_id>] [--write] [--root <mappe>] [--dry-run]` (ren Node, ingen avhengigheter, ingen nettverk).
`--write` = utkastet får også en skrivehandling (klasse B) og krever dermed akseptansenivå A (uten den: kun én lese-handling, nivå R); `--dry-run` skriver ingenting; `--root` er mappen filene skrives under (standard repo-roten).
Avslutter 0 = ok, 1 = ugyldig bruk, 2 = ville overskrive. Lager fire filer fra malene i `modules/connector-sdk/templates/`: `src/manifests/<id>.ts` (skeleton), `test/connectors/<id>.fake.ts`, `test/connectors/<id>.contract.test.ts`, `docs/runbooks/CONNECTOR_<ID>.md`.
**Nekter å overskrive** (alle mål sjekkes før noe skrives; kode 2; filer som ble laget før en sti ble blokkert fjernes), validerer `--id` (snake_case som i registeret) og visningstekst (ingen anførselstegn/backslash/backtick/`$`/`*`/`|`/klammer - kan aldri bryte ut av TS-strenger eller kommentarer), skriver aldri utenfor `--root`.
Utkastet er ærlig: skeleton med `unknownField("TODO ...")`, og det er IKKE en ferdig connector (CI-vakten feiler på en manifestfil som ikke er registrert i `FULL_MANIFESTS`).
Testet ende-til-ende: det genererte manifestet validerer, fakeen følger det og kontraktstest-kittet består (`test/scaffold.test.ts`); den genererte kontraktstesten er kjørt grønn.

## 10. Verifisering på NAS (`NOT VERIFIED`)

Pakken har ingen kjøretid å verifisere på NAS; dette er hva eieren/arkitekten kan gjøre for å se at den holder:
1. `git pull`, `pnpm install --frozen-lockfile`, `pnpm exec vitest run modules/connector-sdk ops/connector apps/api/test/wpi-connector-sdk-drift.test.ts` - alle grønne.
2. Skeleton-arbeidslisten: kjør `runManifestGuard` (eller se `guard.test.ts`) og les `coverage.unknown_fields_by_connector` - hvilke connectorer som er neste kandidater til `full`.
3. Per connector med fullt manifest: kjør `runConnectorContract` og les `acceptance.gaps` - lukk dem, eller dokumenter dem ærlig. Live smoke er først `present` etter en observert kjøring mot sandbox (runbookene har trinnene).

## 11. Kjente begrensninger (`DEFERRED` / `PARTIAL`, aldri stille utelatt)

- `DEFERRED`: kontraktstest-kit mot en ekte transport bak en fake leverandørserver (broen fra `ToolTransport` til `ContractAdapter`).
- `DEFERRED`: kobling av connector-gjeld til Integrasjonssenteret (§8); full manifest for de øvrige 55 connectorene (skeleton finnes for alle - arbeidslisten er `unknown_fields_by_connector`).
- `DEFERRED`: «Factory»-abstraksjon utover scaffold. Masterplanen sier: første 3-5 connectorer bygges manuelt etter samme standard, factory abstraheres etter at mønsteret er bevist. Tre referanser er bevist her; mønsteret er ikke bevist mot en NY connector bygget fra scaffold.
- `PARTIAL`: akseptansen kan aldri bli bedre enn `complete_on_paper` uten live-evidens (`BLOCKED_EXTERNAL`).
- `PARTIAL`: terskler i connector-gjeld er grove standarder (justerbare) - ikke kalibrert mot eierens faktiske vedlikeholdsdata (journalen er ung).
- Ikke bygget, bevisst: ingen leverandør valgt eller endret, ingen ny auth-modell, ingen ny migrasjon, ingen endring i `CONNECTOR_REGISTRY` eller noen transport (ingen parallell connector-SDK i kjøretiden, jf. RUNTIME_GATES).

## 12. Rollback / av-bryter

Ingenting å slå av: pakken har ingen kjøretidseffekt. Fjerne den helt: slett `modules/connector-sdk/`, `ops/connector/`, `apps/api/test/wpi-connector-sdk-drift.test.ts` og importer-blokken i `pnpm-lock.yaml` (`pnpm install`). Ingen produksjonskode, ingen data, ingen konfig berøres.
