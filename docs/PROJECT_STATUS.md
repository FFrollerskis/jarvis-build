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
`claude/ua3-product-domain`, base eksakt `main=4cc144f57888c1fd0d7ca4009405f9aae46b4e5b`.** Manuell
fortsettelse etter D-127-merget, derivert fra en frisk read-only rekonstruksjon (`git fetch origin
--prune`, lokal HEAD = origin/main verifisert, rent worktree, CLAUDE.md/PROJECT_STATUS.md/
IMPLEMENTATION_PLAN.md/OPEN_QUESTIONS.md/DECISIONS_AND_ASSUMPTIONS.md/masterplan v4.0 lest på nytt,
`list_pull_requests`/`list_branches` bekreftet ingen dupliserte pågående slices).

**Uavhengig arkitekt-review (`REVIEW_ID=5147198284`, mot eksakt daværende HEAD
`b04cac9c4beb61ff224494af26de73be632e0b9c`, `ARCHITECT_REVIEW_RESULT=CHANGES_REQUIRED`)** fant to
MERGE BLOCKERS, begge rettet på SAMME branch/PR (ingen ny slice, ingen ny D-ID):
1. **Same-verdi-mutasjoner var IKKE ekte no-op'er.** `ProductService.setStatus()` tillot allerede
   `from===to` som en gyldig overgang (`canTransitionProductItem`), men skrev likevel en ny
   `UPDATE`/`updated_at`/`status_changed`-event, og kunne overskrive `closed_at` ved gjentatt
   `shipped->shipped`. Dette kunne stille undertrykke `product_item_high_priority_stalled` (kunstig
   frisk `updated_at` uten reell fremgang). **Fikset:** `setStatus`/`setPriority`/`setOwner`/
   `linkReporter` returnerer nå UENDRET rad UTEN databasekall/event når den effektive verdien
   allerede er identisk (for `linkReporter`: BÅDE `company_id` og `contact_id` uendret). 8 nye
   regresjonstester i `service-rls.test.ts` (describe K) + 1 empirisk ende-til-ende-test i
   `open-loop-product.test.ts` (describe F) som beviser et no-op-`setPriority`-kall på et gammelt
   high-prioritert punkt FORTSATT blir flagget `product_item_high_priority_stalled` (mot ekte
   Postgres/`OpenLoopService`, ikke en isolert hjelpefunksjon).
2. **`PROJECT_STATUS.md`/Q-25 var bak faktisk PR-status.** Rettet i denne samme committen: korrekt
   filantall (27, ikke 23), korrekt CI-tilstand (grønn på forrige HEAD, IKKE "under verifisering"),
   og Q-25 sin utdaterte hale ("...avhenger av product/finance/marketing/operations som ikke er
   startet ennå") fjernet - erstattet med den faktiske 4/5-tilstanden.

**Presis review-/fiks-historikk (kode ferdig, kun dokumentasjonens EGEN selvbeskrivelse har lagget
bak seg selv over flere runder):**
- Review `5147198284` (mot `b04cac9c...`) → to blockers: kode (no-op-mutatorene) + docs.
- Kode-fiksen landet på eksakt HEAD `61a10f0ee97c18e043ed161ed42ab1b8a31cf81e`, CI grønn på DENNE
  HEAD-en (GitHub Actions run `34281655599` - `build-test`/`windows-git-auth`/`gitleaks` alle
  `completed`/`success`, INGEN re-run nødvendig). PR-body oppdatert til å reflektere 798/798 (var
  792/792).
- Review `5147386218` (mot NETTOPP `61a10f0e...`) → **bekreftet KODE-DELEN PASS** (alle fire
  no-op-fiksene og den empiriske stagnasjons-friskhet-regresjonstesten til stede, CI grønn på
  eksakt reviewed HEAD) - MEN fant én gjenværende docs-only blocker: `PROJECT_STATUS.md` beskrev
  fortsatt en FØR-push-tilstand for `61a10f0e...` ("neste steg: push og avvent CI" mens
  push+grønn-CI for DEN HEAD-en allerede var fullført).
- Commit `321a1dc77f53027ff746928a96b0fd84369c4604` forsøkte å lukke DENNE docs-blokkeren, men
  beholdt utilsiktet en NY variant av samme selvrefererende "push/avvent CI"-formulering (nå om
  seg selv, ikke om `61a10f0e...`).
- Review `5147497517` (mot NETTOPP `321a1dc...`) → fant nettopp denne gjenværende
  selvreferansen og krevde én siste, ren docs-only rettelse - INGEN kode-/test-/schema-endring.
- **Rettet i denne påfølgende ren docs-commit-en**, som beskriver den stabile tilstanden ovenfor
  UTEN å beskrive sin egen kommende SHA/CI (unngår en uendelig selv-referanse-løkke der hver
  dokumentasjonsrettelse umiddelbart blir utdatert av sin egen push). PR forblir åpen/draft/
  mergeable, base uendret `4cc144f57888c1fd0d7ca4009405f9aae46b4e5b`, og venter nå på en FRISK
  uavhengig arkitekt-re-review/merge-beslutning - INGEN ytterligere kode-/test-/schema-/docs-arbeid
  er identifisert som gjenstående fra noen av de fire foregående review-/fiks-rundene.

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

## Kvalitetsporter kjørt i denne økten (D-128 + arkitekt-review-fiksrunde)

**Opprinnelig D-128-slice (før review):**
- `npx vitest run modules/erasure modules/product modules/business modules/tool-gateway` →
  792/792 grønt (55 testfiler). Full monorepo `pnpm -w typecheck`/`pnpm -w lint` grønne. Diff
  gjennomgått manuelt: **27 filer** endret (rettet fra en tidligere feilrapportert 23 - se
  arkitekt-review-blokker 2 over), ALLE innenfor D-128 sitt scope. PR #77 opprettet, CI grønn på
  HEAD `b04cac9c4beb61ff224494af26de73be632e0b9c` (run `34275871697`, ett begrunnet re-run av en
  kjent, urelatert `modules/watchdog/test/fase10-ops.test.ts`-ECONNREFUSED-flake).

**Arkitekt-review-fiksrunde (MERGE BLOCKER 1+2, samme branch/PR):**
- `npx vitest run modules/product/test/service-rls.test.ts modules/business/test/open-loop-product.test.ts modules/erasure/test/product-erasure.test.ts`
  → 38/38 grønt (21+11+6, inkl. 9 nye no-op-regresjonstester).
- `npx vitest run modules/erasure modules/product modules/business modules/tool-gateway` →
  **798/798 grønt (55 testfiler)** (792 + 6 netto nye: 8 nye service-rls-tester - describe K - minus
  ingen fjernet, pluss 1 ny open-loop-product-test - describe F).
- Full monorepo `pnpm -w typecheck` (22/22 pakker) og `pnpm -w lint` (`eslint .`) - begge grønne,
  ingen nye feil/warnings.
- Hemmelighetsskann av full diff (`git diff --cached | grep` mot API-nøkkel-/token-/secret-mønstre):
  0 reelle treff - kun embedded-Postgres-test-passord (`pw`/`pw2`, samme presedens som ALLE
  tidligere domenepakker). `gitleaks`-binær ikke tilgjengelig i dette kjøremiljøet - grep-basert
  manuelt skann kjørt i stedet, ærlig rapportert.
- `git diff --stat` gjennomgått manuelt: KUN `modules/product/src/service.ts` (no-op-fiks),
  `modules/product/test/service-rls.test.ts`, `modules/business/test/open-loop-product.test.ts`,
  `docs/PROJECT_STATUS.md`, `docs/OPEN_QUESTIONS.md` endret i denne fiksrunden - ingen nye filer,
  ingen urelaterte filer rørt, ingen ny D-ID, ingen `operations`-implementasjon.

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

1. **Umiddelbart:** PR #77 venter på en FRISK uavhengig arkitekt-re-review/merge-beslutning. Kode-
   og test-tilstanden er stabil og uendret siden `61a10f0e...` (CI grønn, review `5147386218`
   bekreftet kode PASS) - kun denne filens EGEN beskrivelse av seg selv var bak, nå rettet.
   INGEN ytterligere kode-/test-/schema-/docs-endring er identifisert som gjenstående. INGEN
   self-approval/merge under noen omstendighet (D-120/CLAUDE.md, uendret) - kontrollsløyfen er
   pauset, ingen `ARCHITECT_TASK` postes.
2. Etter D-128 er merget (av arkitekten/Tobias, ikke av denne økten): re-derivere neste slice fra
   faktisk repo-/masterplan-status på nytt (ikke anta en fast rekkefølge). Kandidater: UA-3
   `operations`-domenet (siste gjenstående UA-3-kriterium-2-domene - leverandørregister + runbooks +
   eskaleringspolicy, flerdel-kapabilitet som fortjener egen slice); rene docs-lukkinger for
   `OPEN_QUESTIONS.md` Q-29(4) (UA-4 marketing-spend-integrasjon, allerede fullt bygget) og Q-31(3)
   (UA-5 incident→diagnose→fix, allerede fullt bygget) - begge kun dokumentasjonsdrift, ingen ny kode
   nødvendig.
3. Separat, lavere prioritet, uendret fra forrige økt: dokumentasjonslukking for D-126 review-runder
   G-K (formell D-ID-registrering av allerede-fullført arbeid som kun finnes i issue #68).
