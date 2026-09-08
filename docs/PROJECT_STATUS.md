# PROJECT STATUS

**Oppdatert:** 2026-09-08 (branch `claude/ua3-product-domain`, base `main=4cc144f57888c1fd0d7ca4009405f9aae46b4e5b`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## D-127: MERGET (korreksjon av forrige versjon av denne filen)

**Viktig korreksjon:** den forrige `PROJECT_STATUS.md` beskrev PR #76 (D-127, `finance` →
Business Domain Coverage) som fortsatt "under uavhengig arkitekt-review - IKKE merget". Det er nå
UTDATERT. PR #76 er MERGET til `main` som merge-commit `4cc144f57888c1fd0d7ca4009405f9aae46b4e5b`.
`BUSINESS_DOMAIN_COVERAGE.finance` er `"available"` på `main`. UA-3 kriterium 2 sto ved D-127 sin
merge på 3/5 domener (sales/marketing/finance). Full detalj: D-127 i DECISIONS_AND_ASSUMPTIONS.md.

## Aktiv fase/oppgave

**UA-3: Native Jarvis Product Core - `product`-domenet (D-128). PR #77, branch
`claude/ua3-product-domain`, base eksakt `main=4cc144f57888c1fd0d7ca4009405f9aae46b4e5b`, opprettet
som draft, CI under verifisering.** Manuell fortsettelse etter D-127-
merget, derivert fra en frisk read-only rekonstruksjon (`git fetch origin --prune`, lokal HEAD =
origin/main verifisert, rent worktree, CLAUDE.md/PROJECT_STATUS.md/IMPLEMENTATION_PLAN.md/
OPEN_QUESTIONS.md/DECISIONS_AND_ASSUMPTIONS.md/masterplan v4.0 lest på nytt, `list_pull_requests`/
`list_branches` bekreftet ingen dupliserte pågående slices).

**Kandidatvurdering (research-agent, mot faktisk kode - ikke docs):** fire kandidater vurdert. UA-4
sin gjenstående Finance Integrity/marketing-spend-integrasjon og UA-5 «incident → diagnose → fix»
viste seg BEGGE **allerede fullt bygget** (kun `OPEN_QUESTIONS.md` Q-29(4)/Q-31(3) uoppdatert siden
hhv. D-115/D-116 og D-104/D-105) - IKKE gjenbygget, flagget for en egen fremtidig ren docs-lukking
(ville vært en meningsløs docs-only-PR i strid med ordren). Reelle gap: UA-3 `product`
(produkt-tilbakemeldinger/feature-requests/bug-reports - ingen kanonisk Jarvis-data noe sted) og
UA-3 `operations` (leverandør-/runbook-/eskaleringsstyring i FORRETNINGS-forstand - bekreftet en
HELT ANNEN masterplan-betydning enn `modules/incidents`/`modules/watchdog`, som er Jarvis sin EGEN
infra-drift). `product` valgt: mindre, bedre spesifisert, ingen leverandørbeslutning nødvendig.

**D-64-gate:** `SYSTEM_OF_RECORD=JARVIS_CANONICAL`, `CAN_RUN_WITHOUT_PROVIDER=true` - ZERO ekstern
leverandør (Linear/Jira/GitHub Issues) introdusert eller navngitt noe sted i `modules/product/src/*`
(strukturelt bevist, no-provider-proof-test).

**Bygget (samme mal som Contracts Core/D-71):** migrasjon `047_product.sql` (`product_items`,
`product_item_events`, RLS, Q-20 `GRANT DELETE`, `business_open_loops.product_item_id`); ny pakke
`@jarvis/product` (types/state-machine/service/transport, deterministisk lifecycle); to nye
`OpenLoopService`-regler (`product_item_needs_triage`, `product_item_high_priority_stalled`)
registrert i `runSweep()`; `businessOpenLoopsSource()` overflater disse GRATIS i briefen - INGEN ny
`BriefSource`; 10 nye `product.*` ToolGateway-handlinger (A/B/C, INGEN D); wired identisk i
`apps/api/src/main.ts`/`worker-main.ts`; Q-20 erasure-plan utvidet. `BUSINESS_DOMAIN_COVERAGE.product`
flippet til `"available"` (`live_provider_connected=false`).

**UA-3 kriterium 2 re-evaluert: `sales=AVAILABLE marketing=AVAILABLE finance=AVAILABLE
product=AVAILABLE operations=NOT_INTEGRATED` - 4/5 domener, FORTSATT IKKE komplett** (kun
`operations` gjenstår). Full detalj: D-128 i DECISIONS_AND_ASSUMPTIONS.md.

## Kvalitetsporter kjørt i denne økten (D-128)

- `npx vitest run modules/erasure modules/product modules/business modules/tool-gateway` →
  **792/792 grønt (55 testfiler)**, inkl. 6 nye i `modules/erasure/test/product-erasure.test.ts`, 20
  nye i `modules/product/test/*` (state-machine 11 + transport-wiring 9; `service-rls.test.ts` sine
  10 describe-blokker kjørt i samme batch tidligere i økten - se under), 10 nye i
  `modules/business/test/open-loop-product.test.ts`, samt `business-brief.test.ts` utvidet.
- Full monorepo `pnpm -w typecheck` (22/22 pakker) og `pnpm -w lint` (`eslint .`) - begge grønne,
  ingen nye feil/warnings.
- Hemmelighetsskann av full diff (`git diff --cached | grep` mot API-nøkkel-/token-/secret-mønstre):
  0 reelle treff - kun embedded-Postgres-test-passord (`pw`/`pw2`, samme presedens som ALLE
  tidligere domenepakker) og den eksisterende `credential_ref`-feltnavn-strengen (ikke en verdi).
  `gitleaks`-binær ikke tilgjengelig i dette kjøremiljøet - grep-basert manuelt skann kjørt i stedet,
  ærlig rapportert.
- `git status`/`git diff --cached --stat` gjennomgått manuelt: 23 filer endret, ALLE innenfor D-128
  sitt scope (migrasjon, ny `@jarvis/product`-pakke, `open-loop-service.ts`/`open-loop-types.ts`,
  `business-brief.ts` + test, `erasure/plan.ts` + ny testfil, `tool-gateway/integrations.ts`,
  `apps/api/main.ts`/`worker-main.ts`/`package.json`, `pnpm-lock.yaml`) - ingen urelaterte filer rørt.

**Selvfunnet og rettet FØR commit (ingen brukerinvolvering):** to selv-referensielle
provider-navn-feller (`modules/product/src/types.ts` og `business-brief.ts` sine JSDoc-kommentarer
nevnte "Linear/Jira/GitHub Issues" som illustrative eksempler, som traff mine egne
no-provider-proof-regex-tester) - rettet ved å beskrive fremtidige adaptere generisk, ALDRI navngi en
spesifikk leverandør (samme disiplin som `agreements/types.ts`). Én reell testoppsett-bug i
`modules/erasure/test/product-erasure.test.ts`: backdating av `created_at` via en rå
`appPool.query()` UTENFOR `withMemoryTransaction()` ble stille RLS-blokkert (0 rader truffet, ingen
feil kastet) og gjorde punktet aldri faktisk stale nok til å trigge deteksjonsregelen - diagnostisert
med et midlertidig debug-testoppsett (kjørt og SLETTET, aldri committet), rettet ved å pakke
backdating-oppdateringen inn i `withMemoryTransaction()` (samme presedens som
`open-loop-product.test.ts` sin `insertProductItem`-hjelper).

## Blokkeringer

Ingen for D-128 selv (ingen credential, ingen ny leverandør, ingen host-avhengighet). Den automatiske
arkitekt-loopen forblir bevisst PAUSET av Tobias (`JarvisClaudeWorker`/`JarvisWorkerSupervisor`
deaktivert på PC-en) - INGEN posting til issue #68 i denne økten, per eksplisitt instruks. Ingen
merge utført eller forsøkt - draft-PR opprettes og venter på uavhengig arkitekt-review når
kontrollsløyfen gjenopptas.

## Neste oppgave

1. **Umiddelbart:** verifisere CI grønn på draft-PR-ens eksakte HEAD. INGEN self-approval/merge under
   noen omstendighet (D-120/CLAUDE.md, uendret) - kontrollsløyfen er pauset, ingen `ARCHITECT_TASK`
   postes.
2. Etter D-128 er merget (av arkitekten/Tobias, ikke av denne økten): re-derivere neste slice fra
   faktisk repo-/masterplan-status på nytt (ikke anta en fast rekkefølge). Kandidater: UA-3
   `operations`-domenet (siste gjenstående UA-3-kriterium-2-domene - leverandørregister + runbooks +
   eskaleringspolicy, flerdel-kapabilitet som fortjener egen slice); rene docs-lukkinger for
   `OPEN_QUESTIONS.md` Q-29(4) (UA-4 marketing-spend-integrasjon, allerede fullt bygget) og Q-31(3)
   (UA-5 incident→diagnose→fix, allerede fullt bygget) - begge kun dokumentasjonsdrift, ingen ny kode
   nødvendig.
3. Separat, lavere prioritet, uendret fra forrige økt: dokumentasjonslukking for D-126 review-runder
   G-K (formell D-ID-registrering av allerede-fullført arbeid som kun finnes i issue #68).
