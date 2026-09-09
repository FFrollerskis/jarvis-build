# PROJECT STATUS

**Oppdatert:** 2026-09-08 (branch `claude/fase-3-operations-core`, base `main=0b350f448673b52f361cdea65110ab8939d9f889`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## D-128: MERGET (korreksjon av forrige versjon av denne filen)

**Viktig korreksjon:** den forrige `PROJECT_STATUS.md` beskrev PR #77 (D-128, `product` →
Native Jarvis Product Core) som fortsatt "under uavhengig arkitekt-review - IKKE merget". Det er nå
UTDATERT (denne filen selv var en del av PR #77 og kunne derfor ikke beskrive sin egen merge på
forhånd). PR #77 er MERGET til `main` som merge-commit
`0b350f448673b52f361cdea65110ab8939d9f889` (verifisert ekte to-forelder-merge via
`git cat-file -p`, fersk post-merge CI grønn på run `34286600540`). `BUSINESS_DOMAIN_COVERAGE.product`
er `"available"` på `main`. UA-3 kriterium 2 sto ved D-128 sin merge på 4/5 domener
(sales/marketing/finance/product). Full detalj: D-128 i DECISIONS_AND_ASSUMPTIONS.md.

## Aktiv fase/oppgave

**UA-3: Native Jarvis Operations Core - `operations`-domenet (D-129). PR #78, branch
`claude/fase-3-operations-core`, base eksakt `main=0b350f448673b52f361cdea65110ab8939d9f889`.**
Manuell fortsettelse etter D-128-merget, derivert fra en frisk read-only rekonstruksjon
(`git fetch origin --prune`, lokal HEAD = origin/main verifisert, rent worktree, CLAUDE.md/
PROJECT_STATUS.md/IMPLEMENTATION_PLAN.md/OPEN_QUESTIONS.md/DECISIONS_AND_ASSUMPTIONS.md/masterplan
v4.0 lest på nytt, `list_pull_requests`/`list_branches` bekreftet ingen dupliserte pågående slices).

**Kandidatvurdering (background research-agent, mot faktisk kode - ikke docs-tekst):** UA-4 sin
gjenstående Finance Integrity/marketing-spend-integrasjon (Q-29(4)) og UA-5 «incident → diagnose →
fix» (Q-31(3)) ble UAVHENGIG re-verifisert (samme konklusjon som D-128 sin egen tidligere vurdering,
nå med eksplisitt fil:linje-bevis) - BEGGE **allerede fullt bygget** i kode
(`spend-service.ts` `syncMarketingSpend()`/`matchAndReconcile()`, `039_finance_spend_integrity.sql`
`campaign_id`-FK, `open-loop-service.ts` sine finance-spend-regler; `repair.ts` sin
`proposeRepairTask()` → ekte `ClaudeCodeAgent`, `correlation.ts`, `infra-execution-gate.ts`) - IKKE
gjenbygget, kun dokumentasjonsdrift i `OPEN_QUESTIONS.md`, flagget for en egen fremtidig ren
docs-lukking (ikke løst her - ville vært en meningsløs docs-only-PR i strid med ordren). Eneste
reelle, ubestridte gap: UA-3 `operations` (masterplan §13, linje 748: "Tasks, owners, deadlines,
suppliers, runbooks, escalations") - INGEN kanonisk business-operations-datamodell fantes noe sted
(`finance_vendors`, D-116, er et betalings-MOTPART-identitetsregister for rekonsiliering, IKKE et
leverandør-/driftsregister; `modules/incidents`/`modules/watchdog` er Jarvis sin EGEN
infra-drift/Fase-10-konsept, en HELT ANNEN masterplan-betydning - navnelikhet beviser aldri
kapasitet, samme D-122-lærdom).

**D-64-gate:** `SYSTEM_OF_RECORD=JARVIS_CANONICAL`, `CAN_RUN_WITHOUT_PROVIDER=true` - ZERO ekstern
driftsplattform-/ticketing-leverandør (ServiceNow/Notion/Jira/Atlassian) introdusert eller navngitt
noe sted i `modules/operations/src/*` (strukturelt bevist, no-provider-proof-test, samme disiplin
som `product`/D-128).

**Bygget (samme mal som Product Core/D-128):** migrasjon `048_operations.sql` (`operations_vendors`,
`operations_runbooks`, `operations_tasks`, `operations_task_events`, RLS tenant+RESTRICTIVE-space,
Q-20 `GRANT DELETE`, `business_open_loops.operations_task_id`-pekerkolonne); ny pakke
`@jarvis/operations` (types/state-machine/service/transport, deterministisk oppgave-lifecycle
`open→in_progress/blocked→done/cancelled` med administrativ gjenåpning); to nye
`OpenLoopService`-regler (`operations_task_overdue`, `operations_task_escalation_needed`)
registrert i `runSweep()`; eksplisitt `OperationsService.escalateTask()` (akkumulerende
eskaleringsnivå, faller tilbake til leverandørens eskaleringskontakt) - INGEN ny varslings-/
reminder-motor; `businessOpenLoopsSource()` overflater begge GRATIS i briefen - INGEN ny
`BriefSource`; 22 nye `operations.*` ToolGateway-handlinger (A/B/C, INGEN D); wired identisk i
`apps/api/src/main.ts`/`worker-main.ts`; Q-20 erasure-plan utvidet (open-loop → task_events → tasks
→ runbooks → vendors, FK-trygg rekkefølge). `BUSINESS_DOMAIN_COVERAGE.operations` flippet til
`"available"` (`live_provider_connected=false`). `renderDomainCoverage()`-overskriften gjort
beregnet (ikke hardkodet "IKKE fullt oppfylt") for å unngå en aktivt usann påstand fra det
øyeblikket det femte domenet ble dekket.

**UA-3 kriterium 2 re-evaluert: `sales=AVAILABLE marketing=AVAILABLE finance=AVAILABLE
product=AVAILABLE operations=AVAILABLE` - 5/5 domener, NÅ dekket** (JARVIS_CANONICAL kapabilitet
for alle fem - presist: dette betyr IKKE at noen av de fem har en LIVE ekstern leverandør
tilkoblet, `live_provider_connected=false` er uendret sant for alle fem). Full detalj: D-129 i
DECISIONS_AND_ASSUMPTIONS.md.

## Kvalitetsporter kjørt i denne økten

- Ny pakke `modules/operations` (`package.json`/`tsconfig.json`/`src/{types,state-machine,service,
  transport,index}.ts`, 5 nye filer) + migrasjon `048_operations.sql` + endringer i
  `modules/business/src/open-loop-service.ts`/`open-loop-types.ts`/`business-brief.ts`,
  `modules/erasure/src/plan.ts`, `modules/tool-gateway/src/integrations.ts`,
  `apps/api/src/main.ts`/`worker-main.ts`, `apps/api/package.json`.
- Ny testmatrise: `modules/operations/test/{state-machine,service-rls,transport-wiring}.test.ts`
  (47), `modules/business/test/open-loop-operations.test.ts` (13, ny fil), utvidet
  `modules/business/test/business-brief.test.ts` (+34, inkl. ny empirisk `describe I`),
  `modules/erasure/test/operations-erasure.test.ts` (9, ny fil).
- `pnpm install` (workspace-symlink for `@jarvis/operations` opprettet), full monorepo
  `pnpm -w typecheck` (23/23 pakker inkl. `modules/operations`) og `pnpm -w lint` (`eslint .`) -
  begge grønne, ingen nye feil/warnings.
- **FULL arbeidsområde-testsuite (`npx vitest run`, ingen filter): 3666/3666 grønt på 216
  testfiler** (94 av disse er nye/endrede tester fra denne sliceen - `modules/operations/test/*`,
  `open-loop-operations.test.ts`, utvidelsene i `business-brief.test.ts`,
  `operations-erasure.test.ts` - de øvrige ~3572 er FØR-eksisterende tester, uendret grønne, ingen
  regresjon).
- Hemmelighetsskann av full diff (`git diff | grep` mot API-nøkkel-/token-/secret-/private-key-
  mønstre): 0 reelle treff - kun embedded-Postgres-test-passord (`pw`/`pw2`, samme presedens som
  ALLE tidligere domenepakker). `gitleaks`-binær ikke tilgjengelig i dette kjøremiljøet -
  grep-basert manuelt skann kjørt i stedet, ærlig rapportert.
- `git diff --stat`/`git status` gjennomgått manuelt: 10 endrede filer + 4 nye stier
  (`modules/operations/` som helhet, migrasjonen, to nye testfiler) - alle innenfor D-129 sitt
  scope, ingen urelaterte filer rørt, ingen `D108`/credential-arbeid startet, ingen
  issue #68-mutasjon, worker/supervisor urørt.

**Selvfunnet og rettet FØR commit (ingen brukerinvolvering):** (1) et selv-referensielt
provider-navn-fangst - `business-brief.ts` sin egen JSDoc-prosa om `operations` skrev opprinnelig
det bokstavelige pakkenavnet `` `@jarvis/operations` `` i teksten, som traff min egen
no-provider-proof-aktige `not.toMatch(/@jarvis\/operations/)`-test i `business-brief.test.ts` -
rettet ved å beskrive pakken generisk ("egen domenepakke, IKKE importert herfra"), samme disiplin
som `product`-paragrafens eksisterende ordlyd (D-128-presedens, samme fellegruppe som
Linear/Jira-fellene i D-128 selv). (2) en test-assertion-bug i `business-brief.test.ts` sin nye
`describe I`: `operations_task_overdue`-loopens brief-tittel prefikses med `"OVERDUE"` (fordi
loopen HAR en `due_at`, i motsetning til `product_item_needs_triage` som aldri har det) - testen
lette feilaktig etter `loop_type`-strengen i tittelen; rettet ved å identifisere punktet via
`why`-teksten i stedet (samme mønster som followup-loopene i `describe A`).

## Blokkeringer

Ingen for D-129 selv (ingen credential, ingen ny leverandør, ingen host-avhengighet). Den
automatiske arkitekt-loopen forblir bevisst PAUSET av Tobias (`JarvisClaudeWorker`/
`JarvisWorkerSupervisor` deaktivert på PC-en) - INGEN posting til issue #68 i denne økten, per
eksplisitt instruks. Ingen merge utført eller forsøkt - draft-PR opprettes og venter på uavhengig
arkitekt-review når kontrollsløyfen gjenopptas.

## Neste oppgave

1. **Umiddelbart:** PR #78 (draft) venter på uavhengig arkitekt-review og CI-status på eksakt HEAD
   (ikke gjenbruk av lokal quality-gate-kjøring som "CI-bevis"). INGEN self-approval/
   merge under noen omstendighet (D-120/CLAUDE.md, uendret) - kontrollsløyfen er pauset, ingen
   `ARCHITECT_TASK` postes.
2. Etter D-129 er merget (av arkitekten/Tobias, ikke av denne økten): re-derivere neste slice fra
   faktisk repo-/masterplan-status på nytt (ikke anta en fast rekkefølge). Kandidater: rene
   docs-lukkinger for `OPEN_QUESTIONS.md` Q-29(4) (UA-4 marketing-spend-integrasjon, uavhengig
   re-bekreftet allerede fullt bygget i DENNE sliceen også) og Q-31(3) (UA-5
   incident→diagnose→fix, samme) - begge kun dokumentasjonsdrift, ingen ny kode nødvendig. UA-3
   kriterium 2 (5-domene business-brief-dekning) er nå FERDIG - ingen videre slice gjenstår for
   selve domenedekningen; en fremtidig BO om LIVE ekstern leverandørtilkobling for noen av de fem
   domenene er en separat, senere Tobias-provider-beslutning.
3. Separat, lavere prioritet, uendret fra forrige økt: dokumentasjonslukking for D-126 review-runder
   G-K (formell D-ID-registrering av allerede-fullført arbeid som kun finnes i issue #68).
