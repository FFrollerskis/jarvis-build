# WP-AUTH2a: deterministisk klasse C-behandling (runbook)

**Status:** koden er bygget og testet lokalt (se §10), men **alt er `DORMANT`** (flagget `JARVIS_CLASS_C_PIPELINE` er AV som standard) og **`NOT VERIFIED`** mot ekte leverandører og NAS: ingen ekte GitHub-, Drive-, vekst- eller forretningskjøring er gjort. Hver påstand under er kun dekket av det som står i §10 (fake-leverandører, falske transporter og embedded Postgres). Beslutnings-id: D-492 (forslag; lead fører den i beslutningsloggen). Funn: JARVIS-014 (forslag til ny status: `CODE_FIXED (delvis)`, se rapporten). Ingen migrasjon, ingen nye leverandører eller connectorer (`CORE_DEPENDENCY_DECISION_REQUIRED=false`: ingen leverandør er valgt eller gjort til kjerne; adapterne bruker eksisterende lesehandlinger i connectorer som allerede finnes, og Jarvis eier tilstanden for vekst og forretning).

Statusord: `WIRED` (koblet i api og worker) · `DORMANT` (koblet, men AV) · `PARTIAL` · `DEFERRED` · `NOT VERIFIED` (aldri «verifisert» uten kjørt artefakt).

## 1. Hva er bygget (kort)

| Krav | Status | Hvor |
|---|---|---|
| K1 pipeline-kjerne (deterministisk, fail-lukket, ingen modell i beslutningene) | `WIRED`, `DORMANT` | `modules/tool-gateway/src/class-c-pipeline.ts` (`ClassCPipeline`, `ClassCRun`) |
| K2 grensesnitt og registrering (handling til adapter), ingen endring når flagget er AV | `WIRED`, `DORMANT` | `ClassCAdapter` i `class-c-pipeline.ts`; 61 nye og 8 endrede linjer i `gateway.ts` (hooks i `executeCall`, `deny` med ekstra bevis, ny `invokeRead`); fabrikk `apps/api/src/class-c-wiring.ts` brukt av `main.ts` og `worker-main.ts` |
| K3 de åtte første adapterne | `WIRED`, `DORMANT` (§5) | `class-c-adapter-github.ts`, `class-c-adapter-drive.ts`, `modules/growth/src/class-c-adapter.ts`, `modules/business/src/class-c-adapter.ts` |
| K4 forsterket audit (`class_c`-objekt: før, etter, diff, forventet diff, verdikt, rollback-plan med stabil referanse, `request_digest`-felt) | `WIRED`, `DORMANT` | `buildAuditBlock` i `class-c-pipeline.ts`; `...classCAudit()` i `gateway.ts` |
| K5 dekningstabell for ALLE klasse C-handlinger | ferdig (§7) | `class-c-coverage.ts` (`CLASS_C_COVERAGE`) + tabellen under, pinnet av `apps/api/test/wpauth2a-class-c-runbook.test.ts` |
| K6 vakt: en ny klasse C-handling MÅ ta stilling | ferdig (§8) | `apps/api/test/wpauth2a-class-c-coverage.test.ts` |
| K7 differensialtest: flagg AV er identisk med main | ferdig (§9) | `modules/tool-gateway/test/wpauth2a-flag-off-differential.test.ts` + fixture |
| K8 denne runbooken, eierhandlinger, rapport | ferdig | dette dokumentet |

**Bygges IKKE (bevisst):** godkjenningsport for klasse C (klasse C utføres autonomt, CLAUDE.md regel 11), endring av klasse D-kjeden, nye connectorer eller leverandører, opprydding av identitetsfeltene i skjemaene (JARVIS-012, foreslås akseptert som rest, se rapporten), alt i `.github/`.

## 2. Kjeden for en klasse C-handling med adapter

Rekkefølgen i `ToolGateway.executeCall` er uendret fram til pipelinen: policy, parameter-autorisasjon, step-up, rate limit, frys og tilbakekalt credential, credential. Så, kun når flagget er `observe`/`enforce` og handlingen har en adapter:

1. **Mål-/kapabilitetsbevis** (`adapter.validate`): ren validering uten I/O (gyldig repo, filreferanse uten sti-tegn, kjent målstatus osv.).
2. **Preflight**: fersk tilstandslesing via EKSISTERENDE lesehandlinger i samme connector (samme transport, credential og kontekst som mutasjonen; hver lesing har `min(verktøyets timeout, 10 s)`), og en deterministisk dom (`adapter.before.judge`). Replay (ledgeren har allerede en rad som ikke er `failed`) hopper over hele fasen: tilstanden har flyttet seg ved handlingen selv.
3. **Før-snapshot** (hvitelistede felt; `state` sammenlignes, `context` er kun bevis; sladdet før lagring).
4. **Ledger-reservasjon** og **levende eierkontroll** rett før leverandørkallet (se §4).
5. **Utførelsen**: uendret, akkurat ett leverandørkall (ingen automatisk retry av bivirkninger).
6. **Readback** via samme lesehandlinger, **etter-snapshot**, **deterministisk diff** mot **forventet diff** (`adapter.expect`): uventede endringer og avvik er `mismatch`, en readback som ikke kan leses (eller en effekt som ikke kan observeres) er `unverified`; kun «ingen avvik» er `verified`.
7. **Rollback-plan** (kompenserende handling eller manuell prosedyre) med stabil referanse `crb-` + 16 hex (SHA-256 over kanonisk plan). Planen UTFØRES ALDRI av pipelinen; den er data i audit.
8. **Forsterket audit**: ett `class_c`-objekt (schema 1, størrelsesbegrenset til 24 000 tegn med to kuttrinn) i revisjonsraden, i tillegg til de eksisterende feltene.

Ledgeren (`tool_executions`) får før-snapshot i `before_state`, etter-snapshot i `after_state` og årsaken i `postcondition_reason`: kolonnene fantes fra før (ingen migrasjon).

## 3. Flagg og moduser

`JARVIS_CLASS_C_PIPELINE=off|observe|enforce`. Tom, usatt eller ukjent verdi er `off`; en ukjent verdi meldes høyt ved oppstart (`class_c_pipeline_mode_invalid`, `effective_mode: "off"`), aldri en stille `enforce`. Flagget står i `infra/local/service-env.mjs` (kun api og worker) og i `.env.example`; **restart api OG worker** etter endring (begge bruker samme fabrikk).

| Modus | Hva skjer | Utfallet av kallet |
|---|---|---|
| `off` (standard) | `ToolGateway` får ingen pipeline-option; ingen lesinger, ingen `class_c` i audit. Bevist byte-/atferdslikt main av differensialtesten (§9). | som før |
| `observe` | alt kjøres og registreres (lesinger, snapshot, diff, verdikt, rollback-plan), og `would_block` i audit viser hva `enforce` ville gjort | **uendret** (ingenting blokkeres, ingen status endres); unntak: den levende eierkontrollen (§4) gjelder også her |
| `enforce` | et preflight-avslag blokkerer FØR noe reserveres eller utføres; en handling som ikke bekreftes av readback blir `unverified` (aldri «suksess») | avslag `class_c_*`, eller `unverified` (ledger-raden kan ikke gjenbrukes med samme idempotensnøkkel) |

Fail-lukket-regler (samme prinsipp som klasse D-kjeden; alt er kode, ingen prompt og ingen modell):

| Situasjon | `enforce` | `observe` |
|---|---|---|
| ugyldig mål | avslag `class_c_target_invalid:<kode>` | utføres, `would_block` |
| ikke-valgfri lesing feiler eller tidsavbrytes | avslag `class_c_preflight_failed:<id>:<timeout\|read_failed>`; ikke funnet: `class_c_target_not_found:<id>` | utføres, `would_block` |
| adapter kaster | avslag `class_c_preflight_failed:adapter_error:<kode>` | utføres, `would_block` |
| dommen sier blokk (utdatert revisjon, ulovlig overgang, mål er ikke mappe osv.) | avslag `class_c_preflight_invalid:<kode>` | utføres, `would_block` |
| readback feiler | `unverified`: `postcondition_unverified:readback_failed` / `target_missing` / `class_c_no_readback` | uendret, `would_block` |
| diff avviker fra forventet | `unverified`: `postcondition_mismatch` | uendret, `would_block` |
| effekten kan ikke observeres (f.eks. Drive-fil uten `headRevisionId`) | `unverified`: `postcondition_unverified:class_c_unobservable` | uendret, `would_block` |
| før-tilstand mangler (sjeldent re-arm-race) | `unverified`: `postcondition_unverified:class_c_no_baseline` | uendret, `would_block` |
| leverandørkallet feiler | `failed` som før (+ `class_c` i audit) | som før |
| leverandørkallet tidsavbrytes | `unverified`/UKJENT som før (WP-K), aldri `failed` | som før |

## 4. Eierens overstyring er uendret og kommer først

Global pause, frys (verktøy og connector) og tilbakekalt credential avgjøres av gatewayen og policyen FØR pipelinen starter, og sjekkes på nytt (`liveControlDenial`) rett før leverandørkallet for hver engasjert klasse C-kjøring, både i `observe` og `enforce` (pipelinens lesinger tar tid, og en pause/frys skal gjelde helt fram til kallet). Slår kontrollen inn, frigis reservasjonen (raden tilbake til `failed`, `recheck_<årsak>`) og avslaget får `class_c`-beviset.

Pipelinen er **aldri en ny barriere for eieren**: `ClassCPipeline`-konstruktøren NEKTER adaptere for eierens stopp- og kontrollhandlinger (`class_c_adapter_forbidden`), og `begin()` gir aldri en kjøring for dem. Det gjelder alle `owner_controls.*`-handlinger, kill switch-handlingene, selvgjenopprettingshandlingene og settet `CLASS_C_OWNER_OVERRIDE_ACTIONS` (frys/opphev, tilbakekall/gjenopprett credential, enhet, autonomi-binding og kommunikasjonskonto, pause/opphev for situasjoner). Settet er pinnet av test, og de 19 `owner_override`-radene i §7 er avstemt mot det.

## 5. De åtte første handlingene (`covered`)

Alle bruker KUN lesehandlinger og felt som den eksisterende transporten allerede returnerer (ingen nye leverandør-API-antakelser). Det som ikke kan leses står i `unobservable` og påstås aldri. Rollback-planen er data; kun planer der verktøyet er registrert i samme gateway merkes `registered`.

| Handling | Preflight (lesing, dom) | Forventet diff etter handlingen | Rollback-plan | Kan ikke observeres |
|---|---|---|---|---|
| `github.create_pr` | `get_branch` for head og base (begge må kunne leses), valgfri `list_pull_requests`; head ≠ base, gyldig `eier/repo`, tittel | `get_pull_request` på det returnerte nummeret: åpen, riktig head/base, ikke merget, og tittel kun for en PR som ble opprettet nå (idempotent treff er en eksisterende PR) | opprettet: `github.update_pr` med `state=closed` (registrert); idempotent treff: `none`; uklart: manuell | `body` |
| `drive.create_file` | forelder (kun hvis oppgitt) finnes og er en mappe | filen finnes med riktig id og navn, ikke i papirkurven, og (hvis oppgitt) kun i den mappen | `drive.trash` på den opprettede filen (registrert) | innholdets bytes |
| `drive.update_content` | `get_metadata`; `expected_head_revision_id` må stemme (samme forutsetning som transporten, men før noe sendes) | `headRevisionId` endret og lik den transporten returnerte; navn, papirkurv og foreldre uendret | manuell (gjenopprett revisjon fra Drive-historikken) | innholdets bytes; **filer uten `headRevisionId` (Google-egne dokumenttyper) gir `unverified`, aldri `verified`** |
| `drive.rename` | `get_metadata` | navn lik ønsket; papirkurv og foreldre uendret | `drive.rename` tilbake til forrige navn (registrert); `none` hvis navnet var det samme | - |
| `drive.move` | fil og målmappe leses; målet må være en mappe (`application/vnd.google-apps.folder`), ikke filen selv | `parents` er nøyaktig målmappen; navn og papirkurv uendret | `drive.move` tilbake når det var én forelder; `none` hvis allerede der; ellers manuell | - |
| `drive.trash` | `get_metadata` | `trashed` er sann; navn og foreldre uendret | manuell (ingen registrert gjenopprettingshandling); `none` hvis den allerede lå i papirkurven | - |
| `growth.set_campaign_status` | `get_campaign`; overgangen må være lovlig i den ekte tilstandsmaskinen (`canTransitionCampaign`) | `status` er den ønskede (`started_at`/`ended_at` er bevis, ikke sammenlignet) | `growth.set_campaign_status` tilbake kun når tilstandsmaskinen tillater det; ellers manuell med lovlige overganger | - |
| `business.update_lead_status` | `inspect_lead` (eksisterende `preflight_action`); målstatus må være kjent | `status` er den ønskede og `closed` følger tjenestens regel for terminale statuser | `business.update_lead_status` tilbake til forrige status | - |

Vekst og forretning eies av Jarvis (`JARVIS_CANONICAL`, D-64): adapterne bor i `@jarvis/growth` og `@jarvis/business` og settes sammen i `apps/api/src/class-c-wiring.ts`. WP-D3-skriveplattformene for vekst (16 handlinger) har allerede en egen full kjede og er `existing_chain` (de røres ikke).

## 6. Audit-objektet `class_c`

`audit_events.payload->'class_c'` (på `tool.executed`, `tool.postcondition_unverified`, `tool.failed` og `tool.denied`):

| Felt | Innhold |
|---|---|
| `schema`, `mode`, `adapter` | 1, `observe`/`enforce`, `tool_id.action` |
| `request_digest` | 64 hex fra et felt på forespørselen (koblet til WP-T1 via FELT, ikke via kode), ellers `null` |
| `preflight` | `outcome` (`passed`/`blocked`/`would_block`/`skipped`), årsak, advarsler, hver lesing (id, handling, ok) |
| `before`, `after` | `state` (sammenlignes) og `context` (bevis), sladdet |
| `expected`, `diff`, `violations` | forventet diff, faktisk diff (sti, før, etter) og brudd (`expected_*`, `unexpected_change`, `unobservable`) |
| `verdict`, `verdict_detail` | `not_run`/`verified`/`mismatch`/`unverified` + kort årsak |
| `unobservable`, `would_block` | felt som aldri påstås; hva `enforce` ville gjort (kun `observe`) |
| `rollback` | `kind` (`compensating_action`/`manual`/`none`), `steps`, `note`, `ref` (`crb-…`), `complete` (usann hvis sladding endret planen), `registered[]` |
| `truncated` | satt når blokken ble kuttet for å holde grensen (stier, verdikt og rollback beholdes) |

Sladding: alle strenger går gjennom den felles hemmelighetsskanneren (`redactVendorText`), nøkler som ser ut som hemmelighetsnavn får verdien erstattet, og dybde (5), bredde (40) og strenglengde (200) er begrenset. Sammenligninger gjøres på rå verdier; kun det som lagres er sladdet. Credential-verdier og tokens når aldri audit eller ledger (testet).

Nyttige spørringer for `observe`-fasen (som tenant-eier mot Postgres):

```sql
-- verdikt per handling siste 7 dager
SELECT tool_id, action, payload->'class_c'->>'mode' AS mode, payload->'class_c'->>'verdict' AS verdict, count(*)
  FROM audit_events
 WHERE payload ? 'class_c' AND at > now() - interval '7 days'
 GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4;
-- hva enforce ville ha gjort annerledes
SELECT at, tool_id, action, payload->'class_c'->'would_block' AS would_block, payload->'class_c'->'violations' AS violations
  FROM audit_events
 WHERE payload->'class_c'->'would_block' <> '[]'::jsonb AND at > now() - interval '7 days' ORDER BY at DESC;
```

## 7. Dekningstabell: ALLE klasse C-handlinger i produksjonsregisteret

Produksjonsuniverset (alle flaggstyrte sett PÅ) har 109 klasse C-handlinger (tallene i ledgeren, «25/29 C», er utdaterte). Hver har nøyaktig én stilling i `CLASS_C_COVERAGE`; ingen er stille utelatt. Statusene: `covered` = adapter registrert; `existing_chain` = full egen kjede fra før (WP-D3), ikke rørt; `owner_override` = eierens kontrollhandling, utelukket strukturelt (§4); `deferred` = ikke dekket i AUTH2a (kategori og begrunnelse under; WP-AUTH2b bygger videre). Kodereferansene er stier relativt til `modules/`; linjenummer og stilling er pinnet av `wpauth2a-class-c-runbook.test.ts` (tabellen kan ikke drive fra koden).

**Sum:** 109 klasse C-handlinger = 8 `covered` + 16 `existing_chain` + 19 `owner_override` + 66 `deferred`.

| Handling | Status | Kategori | Kode:linje | Test | Begrunnelse (kort; full tekst i manifestet) |
|---|---|---|---|---|---|
| `business.cancel_followup` | `deferred` | `no_readback_action` | `tool-gateway/src/class-c-coverage.ts:37` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Som `business.complete_followup`: ingen lesing av én oppfølging etter avlysning |
| `business.close_lead` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:38` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Samme form som `business.update_lead_status` (`inspect_lead`) |
| `business.close_opportunity` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:39` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Samme form som `business.update_opportunity_stage` (`inspect_opportunity`) |
| `business.complete_followup` | `deferred` | `no_readback_action` | `tool-gateway/src/class-c-coverage.ts:40` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Ingen lesing av én oppfølging (kun `list_overdue_followups`, som ikke viser fullførte) |
| `business.defer_open_loop` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:41` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | `business.read_open_loop` finnes; forventet diff = utsatt til gitt tidspunkt |
| `business.delete_lead` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:42` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | `inspect_lead` finnes; etterbetingelsen er «målet er borte» (`data |
| `business.delete_opportunity` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:43` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Som `business.delete_lead` (`inspect_opportunity` |
| `business.resolve_open_loop` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:44` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | `business.read_open_loop` finnes (klasse A) og kan brukes som readback |
| `business.update_lead_status` | `covered` | - | `business/src/class-c-adapter.ts:32`, `tool-gateway/src/class-c-coverage.ts:45` | `modules/business/test/wpauth2a-class-c-adapter.test.ts`<br>`apps/api/test/wpauth2a-class-c-coverage.test.ts` | Domene-adapter i `modules/business/src/class-c-adapter.ts` |
| `business.update_opportunity_stage` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:46` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Samme form som `business.update_lead_status` (`inspect_opportunity` finnes og er allerede `preflight_action` |
| `calendar.create_event` | `deferred` | `no_live_write_transport` | `tool-gateway/src/class-c-coverage.ts:47` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Live-transporten (`GoogleCalendarTransport`) støtter kun `read_events`/`list_events` og kaster `calendar_unsupported_action_create_event` |
| `cloudflare.purge_cache` | `deferred` | `no_readback_action` | `tool-gateway/src/class-c-coverage.ts:48` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Cache-tilstand kan ikke leses og handlingen er ikke reverserbar (`reversible |
| `comms.authorize_account` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:49` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Registrering i Jarvis' egen kontoregister (JARVIS_CANONICAL) med egen revisjon |
| `comms.contacts_create` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:50` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Oppretter kontakt i Google Contacts; `contacts_get` finnes som readback |
| `comms.contacts_sync` | `deferred` | `no_readback_action` | `tool-gateway/src/class-c-coverage.ts:51` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Samlet synkronisering (flere kontakter): ingen enkelt målpost å lese tilbake |
| `comms.contacts_unlink` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:52` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Fjerner Jarvis' kobling mellom kontakt og identitet (intern tilstand) |
| `comms.contacts_update` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:53` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | `contacts_get` finnes som readback (som `contacts_create`) |
| `comms.decide_contact_conflict` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:54` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Eierens avgjørelse i en konflikt mellom kilder (intern tilstand, `list_contact_conflicts` leser) |
| `comms.edit_message` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:55` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | `comms.get_message` finnes som readback og `check_message_target` er allerede `preflight_action` |
| `comms.meeting_confirm_participant` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:56` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Eierens bekreftelse av deltaker (intern tilstand, `meeting_get` leser) |
| `comms.meeting_decide_commitment` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:57` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Eierens avgjørelse om en foreslått forpliktelse (intern tilstand, `meeting_commitments` leser) |
| `comms.meeting_ingest_text` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:58` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Intern behandling av møtetekst til forslag (egen journal i comms) |
| `comms.revoke_account` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:59`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `contract.set_status` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:60` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Samme form som `growth.set_campaign_status` |
| `discord.notify` | `deferred` | `no_readback_action` | `tool-gateway/src/class-c-coverage.ts:61` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Utgående melding uten lesing av levert melding (som `slack.notify`) |
| `drive.create_file` | `covered` | - | `tool-gateway/src/class-c-adapter-drive.ts:182`, `tool-gateway/src/class-c-coverage.ts:62` | `modules/tool-gateway/test/wpauth2a-class-c-adapters.test.ts`<br>`apps/api/test/wpauth2a-class-c-coverage.test.ts` | Adapter i `class-c-adapter-drive.ts`: forelder (`get_metadata`), readback av den opprettede filen |
| `drive.create_folder` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:63` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Samme form som `drive.create_file` (readback via `get_metadata` på returnert ID, mappetype, forelder) |
| `drive.move` | `covered` | - | `tool-gateway/src/class-c-adapter-drive.ts:121`, `tool-gateway/src/class-c-coverage.ts:64` | `modules/tool-gateway/test/wpauth2a-class-c-adapters.test.ts`<br>`apps/api/test/wpauth2a-class-c-coverage.test.ts` | Adapter i `class-c-adapter-drive.ts`: målmappen er en mappe |
| `drive.rename` | `covered` | - | `tool-gateway/src/class-c-adapter-drive.ts:106`, `tool-gateway/src/class-c-coverage.ts:65` | `modules/tool-gateway/test/wpauth2a-class-c-adapters.test.ts`<br>`apps/api/test/wpauth2a-class-c-coverage.test.ts` | Adapter i `class-c-adapter-drive.ts`: navn endret, papirkurv/foreldre uendret |
| `drive.trash` | `covered` | - | `tool-gateway/src/class-c-adapter-drive.ts:144`, `tool-gateway/src/class-c-coverage.ts:66` | `modules/tool-gateway/test/wpauth2a-class-c-adapters.test.ts`<br>`apps/api/test/wpauth2a-class-c-coverage.test.ts` | Adapter i `class-c-adapter-drive.ts`: `trashed` sann, navn/foreldre uendret |
| `drive.update_content` | `covered` | - | `tool-gateway/src/class-c-adapter-drive.ts:155`, `tool-gateway/src/class-c-coverage.ts:67` | `modules/tool-gateway/test/wpauth2a-class-c-adapters.test.ts`<br>`apps/api/test/wpauth2a-class-c-coverage.test.ts` | Adapter i `class-c-adapter-drive.ts`: revisjons-ID endret og lik transportens svar |
| `executive.freeze_connector` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:68`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `executive.pause_domain` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:69`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `executive.record_evolution_decision` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:70` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Registrerer kun eierens avgjørelse i revisjonssporet (ingen virkning på endringsregisteret) |
| `executive.restore_credential` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:71`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `executive.resume_domain` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:72`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `executive.revoke_autonomy_binding` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:73`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `executive.revoke_credential` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:74`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `executive.revoke_device` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:75`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `executive.unfreeze_connector` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:76`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `finance_neonomics.revoke_consent` | `deferred` | `finance_owner_gated` | `tool-gateway/src/class-c-coverage.ts:77` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Tilbakekall av banksamtykke (eier-/step-up-port) |
| `finance_vipps.cancel_payment` | `deferred` | `finance_owner_gated` | `tool-gateway/src/class-c-coverage.ts:78` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Pengehandling bak eier-/step-up-port; leverandørtilstanden leses via finansmodulen (`get_capture`/`refresh_payment_state`), men semantikken (hva en... |
| `finance_wallester.activate_card` | `deferred` | `finance_owner_gated` | `tool-gateway/src/class-c-coverage.ts:79` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Kortaktivering: `get_card` finnes; tilstandsnavn er uverifisert mot dokumentasjon |
| `finance_wallester.close_card` | `deferred` | `finance_owner_gated` | `tool-gateway/src/class-c-coverage.ts:80` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Kortlukking (`reversible: false`): `get_card` finnes |
| `finance_wallester.submit_card` | `deferred` | `finance_owner_gated` | `tool-gateway/src/class-c-coverage.ts:81` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Kortbestilling (betaling, `reversible: false`) |
| `finance_wallester.unfreeze_card` | `deferred` | `finance_owner_gated` | `tool-gateway/src/class-c-coverage.ts:82` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Opphev kortfrys: `get_card` finnes; tilstandsnavn er uverifisert |
| `finance_wallester.update_spend_policy` | `deferred` | `finance_owner_gated` | `tool-gateway/src/class-c-coverage.ts:83` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Endrer forbruksgrenser: `get_spend_policy` finnes og er det naturlige readback |
| `github.cancel_workflow_run` | `deferred` | `async_effect` | `tool-gateway/src/class-c-coverage.ts:84` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Asynkron avbrytelse (`get_workflow_run` viser fortsatt `in_progress` en stund) |
| `github.comment_on_issue` | `deferred` | `no_readback_action` | `tool-gateway/src/class-c-coverage.ts:85` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Ingen lese-handling returnerer kommentarer (`get_pull_request`/`read_issues` har ikke kommentarlisten) |
| `github.create_pr` | `covered` | - | `tool-gateway/src/class-c-adapter-github.ts:64`, `tool-gateway/src/class-c-coverage.ts:86` | `modules/tool-gateway/test/wpauth2a-class-c-adapters.test.ts`<br>`apps/api/test/wpauth2a-class-c-coverage.test.ts` | Adapter i `class-c-adapter-github.ts`: head/base-branch (`get_branch`), åpne PR-er (`list_pull_requests`), readback `get_pull_request` |
| `github.dispatch_workflow` | `deferred` | `async_effect` | `tool-gateway/src/class-c-coverage.ts:87` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Gir ingen kjøre-ID: den nye kjøringen kan ikke identifiseres umiddelbart (kun listing av kjøringer, racy) |
| `github.rerun_workflow_run` | `deferred` | `async_effect` | `tool-gateway/src/class-c-coverage.ts:88` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Effekten er asynkron: kjøringen starter etter at kallet returnerer, så en umiddelbar readback (`get_workflow_run`) viser ikke sluttilstanden |
| `google_veo.generate_video` | `deferred` | `async_effect` | `tool-gateway/src/class-c-coverage.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Betalt, asynkron videogenerering uten eksisterende lesing av jobbstatus |
| `growth.conclude_experiment` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:90` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Registrerer utfall og avslutter eksperimentet |
| `growth.set_campaign_status` | `covered` | - | `growth/src/class-c-adapter.ts:35`, `tool-gateway/src/class-c-coverage.ts:91` | `modules/growth/test/wpauth2a-class-c-adapter.test.ts`<br>`apps/api/test/wpauth2a-class-c-coverage.test.ts` | Domene-adapter i `modules/growth/src/class-c-adapter.ts` |
| `growth.set_experiment_status` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:92` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Samme form som `growth.set_campaign_status` (`growth.get_experiment` + tilstandsmaskinen `EXPERIMENT_TRANSITIONS`) |
| `growth_ga4.create_key_event` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:93`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_gbp.update_location_hours` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:94`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_googleads.add_keywords` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:95`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_googleads.create_responsive_search_ad` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:96`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_googleads.enable_keyword` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:97`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_googleads.pause_ad` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:98`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_googleads.pause_ad_group` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:99`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_googleads.pause_campaign` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:100`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_googleads.pause_keyword` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:101`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_linkedin.pause_campaign` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:102`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_metaads.create_ad` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:103`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_metaads.pause_ad` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:104`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_metaads.pause_ad_set` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:105`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_metaads.pause_campaign` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:106`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_searchconsole.register_sitemap` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:107`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `growth_tiktok.pause_campaign` | `existing_chain` | - | `tool-gateway/src/class-c-coverage.ts:108`, `growth/src/write/tool-factory.ts:89` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/growth/test/wpd3-write-engine.test.ts` | WP-D3-kjeden (`modules/growth/src/write/tool-factory.ts` `buildGrowthToolDefinitions`) |
| `higgsfield.generate_video` | `deferred` | `async_effect` | `tool-gateway/src/class-c-coverage.ts:109` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Betalt, asynkron videogenerering uten eksisterende lesing av jobbstatus |
| `kling.generate_video` | `deferred` | `async_effect` | `tool-gateway/src/class-c-coverage.ts:110` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Betalt, asynkron videogenerering uten eksisterende lesing av jobbstatus |
| `make.run_scenario` | `deferred` | `async_effect` | `tool-gateway/src/class-c-coverage.ts:111` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Starter en kjøring hos leverandøren (asynkron, ikke-idempotent) |
| `n8n.activate_workflow` | `deferred` | `no_readback_action` | `tool-gateway/src/class-c-coverage.ts:112` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Eneste lesing er `list_workflows`, som returnerer leverandørens rå kropp (ikke normalisert i repoet) |
| `n8n.deactivate_workflow` | `deferred` | `no_readback_action` | `tool-gateway/src/class-c-coverage.ts:113` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Som `n8n.activate_workflow`: kun `list_workflows` med rå leverandørform finnes som lesing, ingen normalisert `get_workflow` |
| `openai_images.generate_image` | `deferred` | `async_effect` | `tool-gateway/src/class-c-coverage.ts:114` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Betalt generering; resultatet er en leverandørjobb uten eksisterende lesing av status |
| `operations.escalate_task` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:115` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | `operations.get_task` finnes som readback |
| `operations.set_status` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:116` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Samme form som `growth.set_campaign_status` med `operations.get_task`/`get_vendor` som readback |
| `owner_controls.freeze_connector` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:117`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `owner_controls.restore_credential` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:118`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `owner_controls.revoke_credential` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:119`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `owner_controls.revoke_device` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:120`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `owner_controls.set_connector_credential` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:121`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `owner_controls.unfreeze_connector` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:122`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `product.set_status` | `deferred` | `sibling_of_covered` | `tool-gateway/src/class-c-coverage.ts:123` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Samme form som `growth.set_campaign_status` med `product.get_item` som readback |
| `runway.generate_video` | `deferred` | `async_effect` | `tool-gateway/src/class-c-coverage.ts:124` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Betalt, asynkron videogenerering uten eksisterende lesing av jobbstatus |
| `situations.clear_autonomy_policy` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:125` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Fjerner eierens autonomi-binding (egen tilstand og revisjon) |
| `situations.pause_all` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:126`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `situations.pause_domain` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:127`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `situations.release_stuck_act_claim` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:128` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Frigir en hengende ACT-reservasjon i Jarvis' egen situasjonsmotor |
| `situations.remove_subscription` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:129` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Jarvis' eget abonnementsregister med revisjon |
| `situations.reset_rule_tuning` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:130` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Jarvis' egen regelterskel (JARVIS_CANONICAL) med revisjon i tjenesten |
| `situations.set_autonomy_policy` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:131` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Eierens autonomi-binding (Jarvis' egen tilstand, egen vakt og revisjon |
| `situations.set_critical_quiet_bypass` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:132` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Jarvis' egen varslingspolicy med revisjon |
| `situations.set_notification_policy` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:133` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Jarvis' egen varslingspolicy med revisjon |
| `situations.set_subscription_enabled` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:134` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Jarvis' eget abonnementsregister med revisjon |
| `situations.subscribe` | `deferred` | `internal_registration` | `tool-gateway/src/class-c-coverage.ts:135` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Jarvis' eget abonnementsregister med revisjon |
| `situations.unpause_all` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:136`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `situations.unpause_domain` | `owner_override` | - | `tool-gateway/src/class-c-coverage.ts:137`, `tool-gateway/src/class-c-pipeline.ts:562` | `apps/api/test/wpauth2a-class-c-coverage.test.ts`<br>`modules/tool-gateway/test/wpauth2a-class-c-core.test.ts` | Eierens stopp-/kontrollhandling (pause, frys, tilbakekall) |
| `slack.notify` | `deferred` | `no_readback_action` | `tool-gateway/src/class-c-coverage.ts:138` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Utgående melding: ingen eksisterende lesing av levert melding (`comms.get_message` finnes bare i comms-flaten) |
| `support.reply` | `deferred` | `no_readback_action` | `tool-gateway/src/class-c-coverage.ts:139` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Svaret sendes via nøstet `email.send` (klasse D `outbound_message` med egen kjede og varsling) |
| `telnyx.notify` | `deferred` | `no_readback_action` | `tool-gateway/src/class-c-coverage.ts:140` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Utgående, betalt SMS uten lesing av levert melding (som `twilio.notify`) |
| `twilio.notify` | `deferred` | `no_readback_action` | `tool-gateway/src/class-c-coverage.ts:141` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Utgående, betalt SMS uten lesing av levert melding |
| `vercel.promote_deployment` | `deferred` | `effect_not_observable` | `tool-gateway/src/class-c-coverage.ts:142` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Ingen eksisterende lesing viser hvilken deployment som er produksjon (`read_deployment` gir deploymentens `target`, ikke alias-/produksjonspekeren) |
| `vercel.rollback_deployment` | `deferred` | `effect_not_observable` | `tool-gateway/src/class-c-coverage.ts:143` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Som `vercel.promote_deployment`: produksjonspekeren kan ikke leses med eksisterende handlinger, så det som skal bekreftes (hvilken deployment som n... |
| `vercel.upsert_env` | `deferred` | `effect_not_observable` | `tool-gateway/src/class-c-coverage.ts:144` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | `list_env` viser nøkkel, mål og type, aldri verdi |
| `whatsapp.notify` | `deferred` | `no_readback_action` | `tool-gateway/src/class-c-coverage.ts:145` | `apps/api/test/wpauth2a-class-c-coverage.test.ts` | Utgående melding uten lesing av levert melding (som `twilio.notify`) |

Kategorier for `deferred`: `sibling_of_covered` (samme form som en dekket handling og med lesehandling: første AUTH2b-tillegg), `internal_registration` (Jarvis' egen tilstand uten ekstern effekt å lese tilbake), `no_readback_action` (ingen lesehandling for akkurat denne effekten), `async_effect` (effekten kommer etter at kallet returnerer), `finance_owner_gated` (pengehandling bak eier-/step-up-port; leverandørsemantikk uverifisert mot dokumentasjon), `effect_not_observable` (kan ikke leses tilbake med eksisterende handlinger), `no_live_write_transport` (live-transporten har ingen skrivesti).

## 8. Vakten (K6): en ny klasse C-handling MÅ ta stilling

`apps/api/test/wpauth2a-class-c-coverage.test.ts` bygger produksjonsuniverset (alle flaggstyrte sett PÅ) og feller testen hvis en klasse C-handling mangler stilling i `CLASS_C_COVERAGE`, hvis en `covered` mangler adapter (eller en adapter står som noe annet), hvis `owner_override`, `existing_chain` eller `deferred` ikke stemmer med faktisk definisjon (kategori, begrunnelse på minst 40 tegn), eller hvis en oppføring er foreldet. `assessClassCCoverage` er selv mutasjonstestet (§10). **Ny klasse C-handling:** legg en rad i `CLASS_C_COVERAGE` (`covered` med adapter, eller `deferred` med kategori og begrunnelse), kjør vakten og regenerer tabellen i §7 (drift-testen sier hva som avviker).

## 9. Differensialtesten (K7): flagg AV er identisk med main

`wpauth2a-flag-off-differential.test.ts` kjører 23 scenarier (klasse A/B/C/D, avslag, replay, tidsavbrudd, kill switch/frys/tilbakekall, produksjonsdefinisjonene for GitHub, Drive, Vercel, forretning og vekst) gjennom `ToolGateway.execute()` mot embedded Postgres og sammenligner resultat, transportkall, ledger-rader og audit-rader mot en fixture generert fra uendret `origin/main` (`a5ef98b3`), i tre varianter av «AV» (ingen option, `classCPipeline: undefined`, pipeline i modus `off` med alle adaptere). En kontrolltest viser at akkurat de fem engasjerte scenariene avviker i `observe`/`enforce`, og at utsatte handlinger (`vercel.rollback_deployment`) er uendret i alle moduser. Regenerering av fixturen skjer KUN fra en ren main (prosedyren står i testens toppkommentar); en legitim atferdsendring fra en senere pakke gjør testen rød til det er gjort, og den skal aldri «oppdateres blindt».

## 10. Tester og mutanter (bevis, ikke påstand)

Ikke-DB (kan kjøres som root):
`pnpm exec vitest run --maxWorkers=2 modules/tool-gateway/test/wpauth2a-class-c-core.test.ts modules/tool-gateway/test/wpauth2a-class-c-adapters-unit.test.ts apps/api/test/wpauth2a-class-c-coverage.test.ts apps/api/test/wpauth2a-class-c-wiring.test.ts apps/api/test/wpauth2a-class-c-runbook.test.ts`

DB-tester (embedded Postgres; kjør som vanlig bruker, ikke root):
`pnpm exec vitest run --maxWorkers=2 modules/tool-gateway/test/wpauth2a-class-c-gateway.test.ts modules/tool-gateway/test/wpauth2a-class-c-adapters.test.ts modules/tool-gateway/test/wpauth2a-flag-off-differential.test.ts modules/growth/test/wpauth2a-class-c-adapter.test.ts modules/business/test/wpauth2a-class-c-adapter.test.ts`

Rød-først: `wpauth2a-class-c-gateway.test.ts` ble skrevet mot den uendrede gatewayen og feilet der (24 tester feilet: observe/enforce, levende kontroll, audit, `request_digest` og «ingen doble lesinger»; testene for modus AV, ingen adapter og klasse B/D bestod) før hookene ble bygget. Mutanter: 143 mutanter i åtte kildefiler (kjerne 67, gateway 18, GitHub 13, Drive 19, dekningstabell 14, vekst/forretning 9, kobling 3; skript og logger: /tmp/pg-home/auth2a-notes/mutate.py, mutants-run1.log): første kjøring drepte 126 og 17 overlevde; alle 17 var testhull (ingen ekvivalente) og er lukket med nye tester, og en ny kjøring av de 17 drepte alle. Resultat: 143 av 143 drept (testene kjører mutantene i trinn, billigste først, med --bail=1). Overlevende mutanter er enten ekvivalente (forklart i rapporten) eller testhull som er lukket.

## 11. Eierhandlinger (NAS) - kort sjekkliste (utrulling: off, observe, enforce)

1. **Deploy som vanlig** (flagget er AV: ingenting endres). Bekreft at loggene fra api og worker IKKE har en `class_c_pipeline`-linje.
2. **Test-/sandbox-ressurser først** (begrenser skaderadius; sier ingenting om produksjonens tilgangsnivå): et testrepo med en testgren (GitHub), en testmappe i Drive, en testkampanje og en testlead.
3. **`observe`:** sett `JARVIS_CLASS_C_PIPELINE=observe` i `.env`, restart api OG worker, og bekreft linjen `{"msg":"class_c_pipeline","mode":"observe","adapters":[…åtte nøkler…]}` i begge. Kjør hver av de åtte handlingene mot testressursene (og noen ekte, lavrisiko) og les `class_c` med spørringene i §6 i minst en uke: hvert verdikt skal være `verified`, og hver `mismatch`/`unverified`/`would_block` skal kunne forklares. Hver dekket handling koster nå 1-3 lesinger før (GitHub: head, base og åpne PR-er; Drive: filen og eventuelt målmappen/forelderen; vekst og forretning: én) og én etter, og kun disse.
4. **`enforce`** først når `observe` har gått uten uforklarte `would_block`. Merk: et ulesbart mål (nettverksfeil mot leverandøren i preflight) blokkerer i `enforce` (fail-lukket) og kan prøves på nytt; en handling som ikke bekreftes får status `unverified` og kan ikke gjenbrukes med samme idempotensnøkkel (kontroller leverandøren, kjør så på nytt med ny nøkkel).
5. **Rollback-planer** utføres av eieren (eller av Jarvis som et nytt, vanlig klasse C-kall): `rollback.steps` er ferdige kall, `rollback.complete=false` betyr at verdier må hentes fra leverandørens historikk.
6. **Nødutgang:** fjern flagget (eller `off`) og restart api og worker: gatewayen er da identisk med main. Ingen migrasjon må rulles tilbake; ledger og audit beholder radene.

## 12. NOT VERIFIED, begrensninger og gjenstår

- **`NOT VERIFIED`:** alt mot ekte GitHub, Google Drive og NAS. Svarformene i adapterne er hentet fra de eksisterende transportene og testet mot fake-leverandører som følger dem; at de ekte leverandørene svarer slik i alle varianter er ikke bevist før eieren har kjørt §11. `BLOCKED_EXTERNAL`: ingen (testen krever bare eierens tid på NAS).
- **Bare åtte av 109** klasse C-handlinger er dekket; 66 er `deferred` med kategori, og vi har ikke funnet en trygg måte å dekke dem uten nye lesehandlinger eller leverandørdokumentasjon (se tabellen). Vercel (produksjonspekeren kan ikke leses), kalender (live-transporten har ingen skrivesti) og meldinger (ingen readback) er de viktigste hullene.
- **Innhold leses aldri tilbake** (PR-`body`, Drive-bytes): står i `unobservable`. Drive-filer uten revisjons-ID gir alltid `unverified` i `enforce` (ærlig, men støyende for Google-egne dokumenttyper).
- `observe` endrer ikke utfallet, men den levende eierkontrollen (§4) gjelder også der; ellers er `observe` kun registrering.
- Leseforsterkningen (1-3 lesinger før og én etter, per dekket handling) går mot samme transport og rate limit som mutasjonen; i `observe` er det den eneste ekstra belastningen.
- Pipelinen utfører aldri rollback selv, og gjør ingen automatisk retry av bivirkninger.
- `request_digest` er bare et felt (`null` til WP-T1 leverer det); koblingen er uten kodeavhengighet.
