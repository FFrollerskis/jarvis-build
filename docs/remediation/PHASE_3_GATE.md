# PHASE 3 GATE – Remediering del 3 av 10 (LLM-autoritet, verktøy, prompt injection og godkjenning)

| Felt | Verdi |
|---|---|
| Dato | 2026-10-03 |
| Branch | `remediation/03-authority-tool-safety` |
| PR | draft, **IKKE merget** |
| Beslutninger | D-374 · D-375 · D-376 · D-377 · Q-47 |
| Uavhengig review | **IKKE gjort.** Denne filen er Claude sin egen evidens, ikke en godkjenning. |

## 1. Gate-utfall

**`PHASE 3 GATE: PASS` på repo-nivå for de invariantene som er oppført og testet i §2 – med tydelige DEFERRED/åpne punkter i §5 og `BLOCKED_EXTERNAL` for runtime-verifisering.**

- **Dette erklærer IKKE at Jarvis er «sikker mot prompt injection».** Kun de testede invariantene i §2 er bevist: en ubetrodd kilde kan ikke utløse klasse C/D eller utgående/betalt/ekstern skriving uten en korrekt, bundet, engangs eier-bekreftelse, og modellen ser bare et lite, deterministisk utvalg av lese-verktøy per flate.
- Ingenting er `VERIFIED` i runtime (ingen NAS/Docker/live-leverandører i sandbox). Nye migrasjoner 065/066 er kun kjørt mot ekte embedded Postgres.
- Atferdsendringer som merkes av eier står i §5 (Q-47): seks klasse D-handlinger er utilgjengelige (DEFERRED), URL-konfig krever `JARVIS_DESTINATION_HOST_ALLOWLIST`, privat/helse/finans-innhold går ikke lenger til gratis delt sky.

## 2. Bevismatrise (invarianter → tester)

| Krav | Tiltak | Bevis | Status |
|---|---|---|---|
| ÉN sentral manifest (eier, A–D, effekt, datasone, sensitivitet, kost, nettverk, idempotens, flater) med invarianter | `tool-manifest.ts` (`buildToolManifest`, `assertManifestInvariants` ved oppstart i api + worker) | `apps/api/test/part3-tool-manifest.test.ts` (29): dekker ALLE ~401 handlinger, effekt→minimumsklasse, klasse D krever idempotens, mutasjonstest (utvidelse som bryter reglene feiler lukket) | `CODE_FIXED` |
| Deterministiske verktøysett per flate, hard allowlist etter utvalg, grenser; ikke ~430 skjemaer per runde | `selectSurfaceTools`, `SURFACE_TOOL_GRANTS`, `SURFACE_LIMITS`, `maxCallsPerRound`/`maxRounds` | `modules/tool-gateway/test/part3-surface-selection.test.ts` (8); **målt: hele registeret 38 382 tokens/runde (401 handlinger) vs modellflate 602 tokens**, regresjonsterskel ≤ 900 og per-flate `max_schema_tokens` | `CODE_FIXED` |
| `output_trust` bevart transport→resultat→adapter→neste runde; ubetrodd blir aldri system-/developer-instruks | `tool-result-envelope.ts` (`jarvis_data_envelope`, standard `untrusted`), adaptere anthropic/openai/local/gemma | `packages/provider-adapters/test/part3-tool-result-envelope.test.ts`; `part3-taint-confirmations.test.ts` «data-envelope bevarer trust» | `CODE_FIXED` |
| Taint + ny bundet bekreftelse (SHA-256 over verktøy/handling/parametre/mottaker/bruker/enhet/utløp/nonce); endret parameter ugyldiggjør | `TurnTaint`, `ConfirmationStore` (migrasjon 066, RLS), `MeshToolExecutor`, `POST /confirmations`, dashbord «Bekreftelser» | `apps/api/test/part3-taint-confirmations.test.ts` (rød-lag: ondsinnet e-post, nettside, Notion, Slack, MCP-output, tale-transkripsjon ⇒ **0 utførelser** uten riktig artefakt, kjører KUN med bundet artefakt; endre én parameter ⇒ avvist; kun samme person/enhet; utløp; engangs ved samtidig forbruk; manipulert rad avvises; fail-closed uten bekreftelsestjeneste) | `CODE_FIXED` |
| Klasse D minimumspipeline; handling uten full kjede er utilgjengelig; varsler/recovery mangler ⇒ fail-closed | `class-d-pipeline.ts`, `gateway.ts` (hard port, `reconcile`), postconditions docker/github/drive, Gmail-ID | `modules/tool-gateway/test/part3-class-d-pipeline.test.ts` (21): pinnet DEFERRED-liste mot produksjonsdefinisjonene, notifier mangler/ikke klar, manglende nøkkel, ufullstendig kjede, varslingsfeil synlig, uverifisert utfall + avstemming, predikatene | `CODE_FIXED` (6 handlinger DEFERRED – §5) |
| Jobber: identitet fra signert innsender + kontrakt; `allowed_tools` filtrerer skjema OG utførelse; `tools:true` med tom liste/ubetrodd kontrakt avvises | `jobIdentityFor`, `filterMeshToolsForJob`, `jobContractAllows`, `executive.ts`, `TaskService.submit` | `part3-job-contract.test.ts`, `part3-job-gateway-enforcement.test.ts` (ekte Postgres), `apps/api/test/executive-parity.test.ts`, `modules/tasks/test/fase6-worker.test.ts` | `CODE_FIXED` |
| Cross-tenant / ikke-eier / tom allowlist / fremmed credential | `credentialBinding`, `scope_mismatch:*`, `job_identity_mismatch` | `part3-job-gateway-enforcement.test.ts` M8: fremmed tenant/person/delegat avvises (`credential_not_bound_to_identity`), parametre med fremmed tenant/person avvises, jobb-memory_space utenfor kontrakt avvises | `CODE_FIXED` |
| Kontroll-/hemmelighets-/identitetshandlinger finnes ikke på noen modellflate; sensitive navnerom fraværende i tale/Telegram/bakgrunn | `OWNER_ONLY_NAMESPACES`, flate-invarianter | `part3-tool-manifest.test.ts` «JARVIS-024 strukturell invariant» (ingen forbudte navn/identitetsfelt i kuraterte mesh-skjemaer, tale/Telegram/bakgrunn read-only) | `CODE_FIXED` |
| Eier-kontrollflate: step-up + vertsallowlist for destinasjons-konfig; limte hemmeligheter oppdages/redigeres før lagring og sendes aldri til minneuttrekk | `step-up.ts`, `assertDestinationAllowed`, `secret-scan.ts` | `apps/api/test/part3-step-up.test.ts` (8), `modules/core/test/part3-secret-scan.test.ts`, `apps/api/test/part3-conversation-secrets.test.ts` | `CODE_FIXED` |
| Reklassifisering + deterministisk utgående validering (CR/LF, mottaker, URL, Sheets `RAW`) | `integrations.ts` (B→C), `url-safety.ts`, `live-transports.ts` | `modules/tool-gateway/test/part3-outbound-validation.test.ts`, `part3-tool-manifest.test.ts` (reklassifisering) | `CODE_FIXED` |
| Reell sensitivitetsruting; critic/council/uttrekk/spesialist under samme regler | `content-sensitivity.ts`, `contextWithMeta`, `runCritic` | `modules/model-gateway/test/part3-content-sensitivity.test.ts` (15), `conversation-d106-overrides.test.ts` V/W/I2, `ua1-mesh.test.ts` (critic sendes aldri til sky ved SECRET_RESTRICTED; **verifisert at testen feiler uten fiksen**) | `CODE_FIXED` (mønsterbasert, ikke DLP) |
| Telegram: sterkere binding for skriving; offset varig; fetch-timeout; non-2xx varsler | poller (eier + privat chat + `from.id`), migrasjon 065, `onFailure` | `modules/tool-gateway/test/part3-telegram-poller.test.ts`, `part3-telegram-offset-store.test.ts` | `CODE_FIXED` for poller; **Telegram forblir read-only** til signert godkjenning finnes (§5) |

## 3. Kvalitetsporter (kjørt i denne økten, som `nobody` mot embedded Postgres, gruppevis)

- `pnpm -r run typecheck`: ren. `eslint apps modules packages ops/security`: ren. `node ops/security/check-containment.mjs`: OK.
- Full CI lokalt: se §4. GitHub Actions-resultat for PR er ikke sett ennå.

## 4. Testtall

Gruppevis (`vitest run <katalog>/`, som `nobody`, ekte embedded Postgres). **Totalt ≈ 8690 tester bestått.** Per gruppe: apps/api: 555; apps/browser-gateway: 125; apps/voice-gateway: 183; modules/agreements: 68; modules/business: 433; modules/consent: 38; modules/context: 15; modules/conversation-graph: 80; modules/core: 710; modules/erasure: 65; modules/executive: 121; modules/finance: 447; modules/governance: 28; modules/growth: 242; modules/health: 27; modules/incidents: 79; modules/knowledge: 152; modules/location: 23; modules/memory: 58; modules/model-gateway: 271; modules/operations: 64; modules/owner-controls: 98; modules/policy: 40; modules/product: 41; modules/self-modification: 88; modules/situations: 186; modules/support: 86; modules/tasks: 314; modules/tool-gateway: 935; modules/vision: 42; modules/watchdog: 118; packages/contracts: 30; packages/provider-adapters: 140; ops: 1394; ops: 1394 (inkl. `check-containment`-tester).

**Feil funnet og rettet i denne økten:** `modules/support` (nøstet `email.send` krevde leverandør-ID uten håndhevelse; test I oppdatert: gatewayen avviser nå `scope_mismatch:tenant_id` strengere enn før), `modules/business` (wiring-regex for ny konstruktør), `apps/api` D-369-wiring-test; alle grønne ved omkjøring.

**Kjent, forhåndseksisterende feil (ikke fra del 3):** `modules/core/test/embedded-postgres-ipv4-contention.test.ts` B.3 feiler også på en ren tre (verifisert med `git stash`); miljøavhengig port-/lytter-test i sandboxen. Resultat modules/core: 709 av 710 bestått.


## 5. DEFERRED / åpent / ikke gjort (ærlig liste)

1. **DEFERRED klasse D (utilgjengelig under håndhevelse):** `finance.submit_payment_intent`, `finance_stripe.submit_refund`, `finance_vipps.submit_capture`/`submit_refund`, `mcp_zapier.call_tool`, `microsoft_outlook.send_mail` – mangler fersk tilstandslesing/etterbetingelse (finans-ledger = del 4). Pinnet i `part3-class-d-pipeline.test.ts`.
2. **Telegram skriving** krever signert godkjenning (ikke bygget) – derfor read-only.
3. **Samtykke (JARVIS-084)** er ikke endret (`OPEN`). **Klasse C** uten preflight/readback er ikke endret. **~370 skjemaer** har fortsatt identitetsfelt (kun modellflatene er strippet; gatewayen avviser avvik).
4. `delegate_code_task` er fortsatt fryst fra chat; policy-/budsjettstyrt delegering er ikke bygget (kun sensitivitetsregelen).
5. **Ikke runtime-verifisert:** NAS-redeploy, live leverandør-postconditions (Drive/GitHub/Docker readback mot ekte API), Telegram-varsling av klasse D, step-up fra ekte dashbord-grant (antakelse: dashbord-grant er `signed`/`web` – må sjekkes ved første bruk), migrasjon 065/066 på NAS.
6. Sensitivitetsklassifiseringen er mønster-/metadatabasert; ukjente formater og indirekte omtaler kan slippe gjennom.
7. Q-47 (Tobias): DEFERRED-listen, `JARVIS_DESTINATION_HOST_ALLOWLIST`, roter Infisical-nøklene som ble limt inn i chat. **Besvart (D-378):** helse/finans er `SECRET_RESTRICTED` (lokal modell, usladdet; hemmeligheter sladdes fortsatt). Ikke verifisert: at en lokal modell er konfigurert på NAS.

## 5b. Runtime-observasjon (NAS, 2026-10-03, observert via Tobias sine utskrifter)

- **Observert:** `main` `9177ded` (#227) bygget og startet; `migrate` Exited (ok), `migrations_complete`; `action_confirmations` og `telegram_poll_state` finnes (`to_regclass`); `/health` ok; api `healthy`; Telegram-token og chat-id er satt (kun telling, ikke verdier); dashbordet leverer «Bekreftelser»-panelet (`curl /dashboard`) og Tobias så det i nettleseren med teksten «Ingen handlinger venter på bekreftelse» (dvs. `POST /confirmations` `list` med ekte grant svarte OK og tomt).
- **Feil funnet i drift, ikke av CI:** `local-worker-1` gikk i restart-loop med `ToolManifestViolationError` («tildelt flate … men ikke registrert» for `memory.*`/`executive.get_capability_status`). Årsak: worker har et delvis register. Rettet i #229 (`ignoreUnregisteredGrants` i `worker-main.ts`, test i `part3-tool-manifest.test.ts`). Etter redeploy på `917c80f`: worker `Up`, `jarvis-worker started`, ingen `violation`; api `healthy`. Lærdom: ingen test starter `worker-main.ts` – oppstartsvakter bør ha en røyktest (ikke gjort).
- **Oppdatert 2026-10-03 11:35 (NAS `04de63b`, inkl. #228/#229):** api `Up (healthy)`, worker `Up`, `jarvis-worker started` uten `violation`, `/health` `status:ok`. `JARVIS_DESTINATION_HOST_ALLOWLIST` er ikke satt (valgfritt) – URL-konfig via dashbordet er derfor lukket.
- **IKKE observert:** en faktisk bekreftelse (godkjenne/forbruke), step-up fra ekte dashbord-grant (`signed`/`web`-antakelsen), klasse D-varsling via Telegram, sensitivitetsrutingen i ekte chat, jobb-`allowed_tools` i ekte kø, `JARVIS_DESTINATION_HOST_ALLOWLIST` (#228 ikke merget; variabelen når ikke api før den er det).

## 6. Neste

Del 4 (idempotens, eksterne sideeffekter, finansintegritet) startes IKKE før Tobias ber om det. Uavhengig arkitekt-review av denne grenen er ikke gjort.
