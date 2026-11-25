TS: 2026-11-25T21:12:07.043Z
VERDICT: MERGE ETTER FIKSER - 0 HIGH, 2 MEDIUM. K2-kartleggingen er ufullstendig: Sikkerhet-senteret og `executive.get_infra_status` lekker finanskoblinger til sky. K1 (AsyncLocalStorage) og flagg-AV-identiteten er solide og bevist.

HEAD `ebc85c38`, base `71a31d8b`. Worktreen er urørt (`git status` tom). Alt jeg lagde ligger i `/tmp/lead/N1b-review-A-probes/`. Jeg leste `/tmp/lead/N1b-report.md` ikke.

## Svar på leads tre punkter
**(a) De to endrede N1-testene er legitime, og ingen beskyttelse er svekket.**
- `wpn1-nested-finance-lock.test.ts` B (r.177-180) brukte `rig({lock})` (lås PÅ, vakt AV). `main.ts` lager aldri den konfigurasjonen. Den nye `rig()` er den ekte flagg-AV-tilstanden og asserterer fortsatt lekkasjen.
- Samme fil, C (r.252-262), asserterer nå strengere: nøstet finanskall nektes sentralt, og `financeCalls == []` for sky.
- Den endrede C er bærende. Den er eneste test som dreper mutantene A52/A54 (sentral lesning droppet i `getControlSurfaceStatus`/`getDelegationBoard`).
- `wpn1-stamping-structure.test.ts` la bare `model-scope.ts` til filllisten (r.34-38). `mesh-bridge`-telleren er urørt.
- Kun 2 eksisterende testfiler er endret. Ingen `.skip`/`.todo` er lagt til. `git diff --stat 71a31d8b..HEAD -- apps/api/test/fixtures` er tom, så `wpn1-main-engine-baseline.json` er urørt.

**(b) Flagg AV er identisk med main. Tapt skop er ikke nåbart fra en modellvei i api.**
- Flagg AV gir byte-identiske svar, se tabellen under.
- Det finnes bare to `new ToolGateway(` i produksjon: `main.ts:445` (lås kun med flagg) og `worker-main.ts:216` (ingen lås, dermed aldri skop; akseptert rest I6).
- Modellkall går kun via `MeshToolExecutor` (`mesh-bridge.ts:546-560`), som alltid stempler `servingModel`.
- Under 600 samtidige kall med pool `max=2` (kø i `pg-pool`) overlever skopet timere, `setImmediate`, mikrotask, tick, `Promise.all`, `EventEmitter.once` og nøstede kall.
- Faren «delt løfte/delt lytter» finnes som klasse. Probe A5 viser at en sky-kaller fikk eierens «ikke begrens» fra delt arbeid. Alle lesere er pinnet utenfor delt arbeid: mutant A81b (leser i `ControlCenterRegistry`) ble drept av strukturtest A.

**(c) ELLER-leddene i `executive` kan ikke avvike i drift.** Begge armer bruker `financeLockServedLocally`, og ELLER kan bare stramme inn. Den eksplisitte per-tjeneste-armen er likevel utestet: mutantene A53/A55 overlever. Se L2.

## Funn (rangert; fil:linje mot HEAD)
**MEDIUM-1: Sikkerhet-senteret (bygd med `restrictFinance`) lister finanskoblinger og finans-credentials til sky.**
- `apps/api/src/control-center/security.ts:189` leser frosne/tilbakekalte uten finansfilter. `:264-270` skriver `connector_id`/`credential_ref` i `detail_no`, og `:350-351` teller dem.
- Probe `zz-n1b-review-a-k2gaps` E1 mot ekte kode (guard PÅ). Sky og ukjent leverandør får `stripe`, `finance_vipps` og `JARVIS_VIPPS_CLIENT_SECRET` via `get_control_center{center:"security"}` og `get_security_center`. Lokal og eier får dem (kontroll).
- Byggeren har samme data som finansavledet i `shapeOwnerControlForCloud` (R11/R12), men klassifiserte Sikkerhet som «bygget uten finansavledet tilstand» (runbook r.148; `wpn1b-structure.test.ts:205` `handled_h2`).
- Betingelser: eier med signert økt, og `JARVIS_CONTROL_CENTER_SECURITY=on` (AV som standard).
- Fiks, validert ved midlertidig anvendelse (E1 6/6 grønt):
  ```ts
  import { isFinanceConnectorId, isFinanceCredentialRef, type ToolGateway } from "@jarvis/tool-gateway";
  // security.ts:189
  settle(async () => {
    const frozen = await deps.ownerControls.listFrozenConnectorsDurable();
    const revoked = await deps.ownerControls.listRevokedCredentialsDurable();
    return restrict
      ? { frozen: frozen.filter((f) => !isFinanceConnectorId(f.connector_id)), revoked: revoked.filter((r) => !isFinanceCredentialRef(r.credential_ref)) }
      : { frozen, revoked };
  }),
  ```
  Ellers: ny rad R24 i `n1b-rows.ts`, og retting av runbook r.148. Legg `JARVIS_CONTROL_CENTER_SECURITY` inn i K3-rekkefølgen (nå står kun FINANCE/VALUE).

**MEDIUM-2: `executive.get_infra_status` bærer finanskoblings- og finansjobbnavn i hendelsestitler til sky.**
- `modules/executive/src/transport.ts:220` er uten vakt.
- `apps/api/src/infra-status-source.ts:31,55` leverer `title`. Titlene lages i `modules/incidents/src/producers/provider.ts:32` («Tilkobling svikter: ${display_name}») og `scheduler.ts:27` («Bakgrunnsjobben ${job_name} ga opp»).
- Probe E2: sky får «Stripe» og «stripe-payment-sync». Lokal og eier får dem.
- Builder klassifiserte stien som «ingen finans» (`wpn1b-structure.test.ts:206`, runbook r.149).
- Betingelse: åpne hendelser for finansstier. Produsentene er AV som standard, men manuelle hendelser går an.
- Fiks, validert (lekkasjelisten blir `[]`): første linje i `case "get_infra_status"`:
  ```ts
  if (withholdFinanceFromCurrentModel()) return { data: { ...financeWithheldMarker() } as unknown as JsonValue };
  ```
  Ellers: rad R24b, flytt `get_infra_status` fra `read_no_finance` til `handled`, og rett runbook r.149.

**LOW-1: `telnyx.get_account_info` returnerer kontoens saldo og står på lese-nivået.**
- `integrations.ts:3816` («gjeldende saldo, GET /v2/balance»), `live-transports.ts:3146`, `chat-read-tier.ts:210`.
- Klassifisert `external` (`wpn1b-structure.test.ts:173`). «Saldo» står på leads søkeliste. Hold tilbake for sky, eller merk eksplisitt DEFERRED/akseptert. Ikke verifisert mot ekte Telnyx (kun kodelesing).

**LOW-2: Testhull (overlevende mutanter).**
- A71: `list_connector_maintenance` kan summere finansminutter til `minutes_30d` uten at R22 feiler.
- A24: `external_id` for en finansløkke er ikke observert (ikke modellsynlig, men påstanden «ingen `external_id`» er upinnet).
- A80: se «Mutasjoner» under.
- A53/A55: den eksplisitte per-tjeneste-armen er ikke testet uavhengig.

**LOW-3: `servingModel: null` gir full tilgang i skopet, men sky i låsen.**
- `gateway.ts:791` bruker `??`, så `null` blir «ingen modell». `gateway.ts:1503-1504` regner `null` som sky for `finance*`.
- Probe A3: `null` er eneste av 14 former som ikke blir sky. Ikke nåbart med typet API.
- Fiks: `request.servingModel !== undefined ? request.servingModel : ambient?.servingModel`.

**INFO**
- `gateway.ts:787`: en løsrevet `execute` (uten `this`) KASTER synkront i stedet for å avvise. Ingen bruk i produksjon (grep).
- Workeren: ingen lås, dermed ingen skop. Runbook-begrensning 7 («ikke et hull») er foreldet for K2. `worker-main.ts:534-538` registrerer `get_capability_status` uformet for sky. Dette er akseptert rest (I6), men teksten bør rettes.
- `growth.*` er DEFERRED (begrensning 21). Det er ærlig merket, men inkonsistent med `marketing_spend_anomaly` som holdes tilbake.
- Tre fail-closed-omslag rundt ÉN lokalitetsfunksjon (`gateway.servedByCloud`, `ExecutiveService.isCloudServed`, `withholdsRestrictedJobFromCloud`) er konsistente. K1 la til ingen ny.
- Datadrevet sveip over memory/agent/operations/privacy-sentrene: 0 finansmarkører. Privacy nevner bare dokumentstatus («Finansdata: UTKAST»), ingen tilstand.
- A02/A03/A12 er drept kun av tekstpinn i strukturtesten (ekvivalente eller uobserverbare).
- Aggregater i `get_capability_status.model_surface` (antall registrerte handlinger) inkluderer finansverktøy. Det er registerstørrelse, ikke tilstand.

## Byggerens påstander -> dom
| Påstand | Dom | Bevis |
|---|---|---|
| K1: skop settes ÉN gang med `run`, ikke `enterWith` | BEKREFTET | `model-scope.ts:59-60`, grep `enterWith` = 0. A09 (`enterWith`) drept uten `wpn1-nested`; A11 (modul-variabel) drept |
| K1 i: ingen lekkasje mellom samtidige | BEKREFTET | A1: 600 kall, pool `max=2`, sky/lokal/ingen/ukjent/blank/STORE, >4800 målepunkter, 0 feil. A2: sekvens sky→eier→lokal, ingenting «stuck» |
| K1 ii: uten modell = full tilgang | BEKREFTET | A1/A2; eierruter og lokal får alt |
| K1 iii: fail-lukket | DELVIS | Ukjent/blank/STORE/kast/ikke-true = sky (A3, A05-A08 drept). `null` = full (LOW-3). Tapt kontekst = full er dokumentert (begrensning 24) og ikke nåbart i api |
| K1 iv: ÉN lokalitetsfunksjon | BEKREFTET m/ forbehold | Alle kaller `financeLockServedLocally`. Vakten fanger ikke en ny provider-liste (A80 overlever) |
| K1 v: per-tjeneste beholdt som dybdeforsvar | BEKREFTET | Kan ikke avvike (se (c)). Sentral arm testet kun av modifisert C; per-tjeneste-arm utestet |
| Flagg AV = main | BEKREFTET | Se tall under |
| K2: tabell R01-R23 mot ekte kode | BEKREFTET | Alle 27 løkketyper E2E, 24/24 (egen liste fra `domainForLoopType`: 12 `spend`-typer = `FINANCE_DERIVED_LOOP_TYPE`) |
| K2: nøytralt svar innholdsfritt | BEKREFTET | Konstant tekst. Siffer i notatet (A35) drept |
| K2: kartleggingen er fullstendig | FEIL for to stier | MEDIUM-1 og MEDIUM-2. LOW-1 delvis |
| K3: aktiveringsrekkefølge | DELVIS | Dekker FINANCE/VALUE. Mangler SECURITY (MEDIUM-1) |
| K4a: rød først mot main | BEKREFTET | Se tall under |
| K4b: samtidighet ≥50 | BEKREFTET | Byggerens 126. Mine 600 med pool-kø |
| K4e: kildevakter | DELVIS | Ny leser (A81b) og literal finanskall i transport (A82) drept. Dynamisk id (A83) overlever, men er trygt: sentral lås nekter. Ny provider-liste (A80) overlever |
| K4f: ≥20 mutanter | BEKREFTET | 39 mønstre gyldige (`--check`), hvert nøyaktig én gang |
| K5: ingen nye flagg | BEKREFTET | Ingen `process.env`/`JARVIS_`-linje i produksjonsdiffen. Ingen endring i infra/ops/packages/migrasjoner. `env-drift` grønn |
| K6: runbook | DELVIS | Linje 148/149 og begrensning 7 er feil/foreldet (se funn) |

**Flagg-AV-tall.**
- Gateway mot ordrett main-kopi (`git show 71a31d8b:gateway.ts`):
  - 154 scenarier × 2 kjøringer (10 verktøy × 5 modeller × 3 identiteter + 4 feilbaner): resultat, SQL-setninger og transportkontekst byte-like.
  - Mikrotask-ticks til `execute()` er avgjort er identiske for 45 kombinasjoner. Returverdien er et native Promise.
- Snapshot over 49 stier/sentre × 5 modellklasser = 245 svar (1,74 MB), grenens kode mot main-versjonene av de 9 berørte produksjonsfilene (byttet inn via `git show`, gjenopprettet):
  - 0 forskjeller etter normalisering av uptime/db-størrelse (6 rå diffs var kun «oppe i 5 s» og `db_bytes`).
  - 0 `finance_withheld` i begge.

**Røde mot main-kode (9 produksjonsfiler byttet).**
- `apps/api/test/wpn1b-model-scope.test.ts`: 10 av 16 røde.
- `wpn1-nested-finance-lock` (C): 1 rød.
- Tabelltesten: 77 av 151 røde.
- `wpn1b-finance-withheld` er 16/16 grønn, fordi den tester nye rene hjelpefunksjoner.

**Regresjon på HEAD** (som `postgres`, 2 arbeidere, ingen `--bail`; sett 1 og 2 uten D-420-filen):
- N1b-testene: 5 filer / 218 tester grønne.
- Sett 1 (`modules/{core,model-gateway,tool-gateway}/test/wpn1-*`, `apps/api/test/{wpn1-*,wpn1b-*,wph1-*,wph2-*}`): 48 filer / 931 tester grønne.
- Sett 2 (`modules/{executive,business,conversation-graph}/test`, `env-drift`, `executive-parity`, `connector-sdk`): 79 filer / 1610 tester grønne.
- `d420-processing-inventory`: 6 tester grønne.

## Mutasjoner
66 kjøringer = 60 distinkte gyldige mutanter + 5 re-kjøringer uten strukturtesten + 1 artefakt (A81, drept av en ReferenceError, erstattet av A81b).
- Drept: 48. A52/A54 er drept av `wpn1-nested-finance-lock` C; runneren merket dem feilaktig TECHNICAL.
- Overlevd: 12.
- Ekvivalente/by design (7):
  - A04: eierkall får et skop med `undefined` modell, men oppførselen er lik.
  - A08: blank leverandør i gatewayen er overflødig med den ekte prediktaten.
  - A31/A32: ingen finanskobling har valgfrie refs, og alle `live_test`-ider er `finance*`.
  - A41: `category: "finance"` dekker registeret.
  - A51: sentral og per-tjeneste er like i drift.
  - A83: nøstet finanskall med dynamisk id nektes sentralt.
- Testhull (5): A24, A53, A55, A71 og A80.
  - A80: en ny kopi av lokalitetsregelen (provider-liste i `modules/executive/src/service.ts`) feller INGEN test. Byggerens vakt pinner kun `servedByCloud(` i `gateway.ts` og `servedByCloudModel` i `apps/api/src`. Lead ba eksplisitt om denne mutanten; vakten faller ikke.
- Re-kjøringer uten `wpn1b-structure`: A02n, A03n og A12n overlever (ekvivalente), A10n og A09n drept av atferdstester.
- Flagg-mutanter drept av `wpn1-guard-env`: A90 (parser godtar `true`/`ON`/`1`), A91b (lås alltid satt), A92 (per-tjeneste-vakt alltid satt).

## Ikke verifisert av meg
- NAS, ekte Ollama/Anthropic, ekte `pg`-oppførsel under Node på NAS, Gmail/Kalender/MCP-transporter. Alt er embedded Postgres og falske modeller.
- Telnyx-saldo er kun kodelesing. Ingen kjørt probe mot ekte leverandør.
- Workeren er ikke kjørt, kun lest (`worker-main.ts:216,534`).
- `pnpm -r typecheck`, `pnpm lint`, `pnpm check:containment`, gitleaks og full suite er ikke kjørt (lead kjører dem). `connector-manifest` er dekket indirekte via `connector-sdk` (grønn).
- Fiksene F1/F2 er validert kun mot proben og ikke mot hele suiten.
- Jeg kjørte ikke byggerens egen mutantløper (kun `--check`). Mine 60 er uavhengige.

## Probe-mappe
`/tmp/lead/N1b-review-A-probes/`. `README.txt` har oversikt; `mutants-summary.txt` har alle 66 mutantkjøringene.
- `zz-n1b-review-a-als.test.ts`: 600 samtidige kall, sekvens, rare `servingModel`-former, avleggere, delt emitter/løfte.
- `zz-n1b-review-a-flagoff.test.ts` + `zz-main-gateway.ts.copy`: gateway mot ordrett main-kopi.
- `zz-n1b-review-a-snapshot.test.ts` + `snapdiff.py`, `redfirst.py`, `snap-branch.json`, `snap-main.json`: snapshot-differensial og rød-først mot main-kode.
- `zz-n1b-review-a-k2gaps.test.ts` + `fixcheck.py`: E1/E2 og fiksvalidering.
- `zz-n1b-review-a-loops.test.ts`: alle 27 løkketyper.
- `zz-n1b-review-a-centers.test.ts`: datadrevet sentersveip.
- `mutate.py`, `run-tests.sh`, `logs/`.
