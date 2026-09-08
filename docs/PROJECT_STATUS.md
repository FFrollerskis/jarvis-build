# PROJECT STATUS

**Oppdatert:** 2026-09-08 (branch `claude/ua3-finance-domain-coverage`, base `main=1b5da61bc070eb7fa8e5068e0c9ba8ecc015e1bd`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Aktiv fase/oppgave

**UA-3: finance → Business Domain Coverage-integrasjon (D-127). PR #76, branch
`claude/ua3-finance-domain-coverage`, opprettet, CI grønn, under uavhengig arkitekt-review - IKKE
merget.** `BUSINESS_DOMAIN_COVERAGE.finance` (`modules/business/src/business-brief.ts`) hardkodet
`"not_integrated"` selv om UA-6 Finance & Spend Integrity Gateway sin kanoniske kapabilitet/arkitektur
allerede var implementert og arkitektur-akseptert (`UA6_IMPLEMENTATION_COMPLETE=true`,
`UA6_ARCHITECTURE_ACCEPTANCE_COMPLETE=true`, D-107-D-118 - se D-118 for gjeldende flaggsett;
`UA6_LIVE_PROVIDER_VERIFICATION_COMPLETE=false`/`UA6_CREDENTIAL_PHASE_COMPLETE=false`/
`D108_COMPLETE=false`/`UA6_COMPLETE=false` er ALLE uendret av D-127) og allerede overflatet
utgifts-/forpliktelses-/anskaffelsesavvik som `business_open_loops` som DEN EKSISTERENDE
`businessOpenLoopsSource()` allerede viste i briefen. Datastrømmen fantes; kun dekningstabellen løy
om den - samme mønster som D-78 (marketing) og samme lærdom som D-122 ("aktivt usann dokumentasjon
er farligere enn manglende"). `finance` flippet til `available`, 11 nye/oppdaterte tester (inkl. én
empirisk ende-til-ende-test: ekte finance-avviksrad → open loop → faktisk brief-punkt), pluss to
uavhengig oppdagede, pre-eksisterende host-akseptanse-script-drifter rettet i samme slag
(`ua4-growth-domain-coverage-live.ts`, `ua3-open-loops-live.ts` - sistnevnte aldri oppdatert siden
D-78). UA-3 kriterium 2: 3/5 domener (sales+marketing+finance), fortsatt IKKE komplett
(product/operations har ingen kapabilitet). Full detalj: D-127 i DECISIONS_AND_ASSUMPTIONS.md.

**Oppgaven derivert av en Claude-økt som fikk direkte instruks fra Tobias** om å gjenoppta ordinær
Jarvis-produktutvikling manuelt (den automatiske arkitekt-loopen er bevisst pauset mens dette pågår
- `JarvisClaudeWorker`/`JarvisWorkerSupervisor` deaktivert på PC-en, `disabled.flag` satt). En
research-agent rekonstruerte repo-/masterplan-status FØRST (les IMPLEMENTATION_PLAN.md/OPEN_QUESTIONS.md/
masterplan v4.0/faktisk kode) og rangerte kandidater før denne ble valgt - se D-127 for full
derivering og hvorfor UA-8/9/10/11 IKKE ble valgt (ingen av dem har én linje implementasjon ennå, og
å hoppe dit ville brutt CLAUDE.md regel 10, "ingen fri sekvens-hopping").

## D-126: worker-infrastruktur - MERGET, KILDEMERGET OG HOST-DEPLOYERT (oppdatering fra forrige økt)

**Viktig korreksjon av forrige versjon av denne filen:** den forrige `PROJECT_STATUS.md`
(runde 8/`D126-ARCHITECT-REVIEW-FIX-20260908-G`) sa PR #75 fortsatt ventet på uavhengig review og
IKKE var merget. Det er nå UTDATERT. Faktisk forløp, verifisert direkte mot GitHub og lokal git i
DENNE økten:

- Arkitekten godkjente merge (`D126-MERGE-CLOSEOUT-20260908-H`, `ARCHITECT_MERGE_APPROVED=true`).
  PR #75 merget som normal two-parent-merge: merge-SHA `1b5da61bc070eb7fa8e5068e0c9ba8ecc015e1bd`,
  parents `94e4aaa5` (gammel main) og `e4178587` (PR-hode) - verifisert med `git rev-list --parents`.
  Fersk post-merge CI på EKSAKT merge-SHA grønn (build-test/windows-git-auth/gitleaks, run
  `34187076196`, 206 testfiler/3530 tester).
- Host-deployment fullført og read-only-verifisert (`D126-HOST-DEPLOY-HANDOFF-20260908-I` →
  `D126-POSTDEPLOY-VERIFY-20260908-J`): PowerShell-tillatelsesgapet fra runde I ble løst av Tobias
  selv (smalt `Bash(powershell.exe:*)` lagt til workerens `allowedTools`), deployment
  `20260908-115207` installert, alle 30 payload-filer hash-verifisert kilde==host==manifest, ekte
  Windows-oppgaver (`JarvisClaudeWorker`/`JarvisWorkerSupervisor`) bekreftet kjørbare med
  post-deploy scheduler-tikk. `CURRENT_SOURCE_DEPLOYED_TO_HOST=true`,
  `D126_HOST_DEPLOYMENT_VERIFIED=true`, `SUPERVISOR_INSTALLED=true`.
- Ende-til-ende-automasjon bekreftet (`D126-AUTOMATION-E2E-PROBE-20260908-K`): en ny arkitektoppgave
  ble oppdaget og dispatchet av den EKTE Windows-planleggeren uten manuell trigger
  (`AUTOMATED_WORKER_QUEUE_PICKUP=PASS`).
- **Fortsatt bevisst ubevist, uendret:** `WORKER_SELF_RECOVERY_VERIFIED=false` (ingen krasj indusert),
  `REMOTE_RESTART_VERIFIED_CURRENT_SOURCE=false`, `REBOOT_PERSISTENCE=UNVERIFIED`.
- **Dokumentasjonsgap oppdaget, IKKE lukket her** (utenfor denne sliceens scope, flagget som egen
  fremtidig oppgave i D-127): review-rundene G/H/I/J/K eksisterer KUN som issue #68-kommentarer og
  har aldri fått egne D-ID-rader i DECISIONS_AND_ASSUMPTIONS.md eller en IMPLEMENTATION_PLAN.md-seksjon.

**Autonom-loopen er nå bevisst PAUSET av Tobias** (ikke krasjet, ikke feilet) mens han jobber direkte
med denne Claude-økten. Ikke start/aktiver/endre `JarvisClaudeWorker`/`JarvisWorkerSupervisor` uten
eksplisitt beskjed.

## Kvalitetsporter kjørt i denne økten (D-127)

- `npx vitest run modules/business/test/business-brief.test.ts modules/business/test/open-loop-finance-spend.test.ts`
  → **37/37 grønt** (21 i business-brief.test.ts inkl. 3 nye/utvidede describe-blokker, 16 uendret i
  open-loop-finance-spend.test.ts, kjørt som regresjonsbevis - urørt av denne sliceen).
- Full monorepo `pnpm -w typecheck` og `pnpm -w lint` kjørt - begge grønne, ingen nye feil/warnings.
- CI på PR #76 (GitHub Actions, `build-test`/`windows-git-auth`/`gitleaks`): grønn på det opprinnelige
  koden-HEAD etter én begrunnet re-run av `build-test` (kjent, PR-urelatert flaky-mønster - ECONNREFUSED
  mot embedded Postgres under `runMigrations()` i `modules/finance/test/service-rls.test.ts`, samme
  Postgres-oppstart-race sett flere ganger tidligere i prosjektet; 3505/3533 tester besto ved første
  forsøk, re-run løste resten - ingen kodeendring nødvendig).
  Denne truth-sync-runden (docs-only, ingen ny D-ID, ingen produktkodeendring - se under) er pushet
  som en ny commit på SAMME branch/PR; CI må verifiseres grønn på DENNE nye eksakte HEAD før videre
  review, jf. arkitektens instruks.
- `git status --porcelain` tom før og etter; `git diff` kontrollert manuelt for hele PR-en (8 filer
  totalt): kode/tester/scripts - `modules/business/src/business-brief.ts`,
  `modules/business/test/business-brief.test.ts`,
  `modules/business/scripts/ua4-growth-domain-coverage-live.ts`,
  `modules/business/scripts/ua3-open-loops-live.ts` - samt FIRE dokumentasjonsfiler -
  `docs/DECISIONS_AND_ASSUMPTIONS.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/OPEN_QUESTIONS.md`,
  `docs/PROJECT_STATUS.md` (denne filen selv, siden den beskriver PR-ens egen sluttilstand).
- Hemmelighetsskann av diff: 0 treff (kjørt både på D-127-hovedsliceen og på denne truth-sync-runden).
- **Uavhengig arkitekt-review (GitHub PR-review, `tsworkflow`/OWNER, mot eksakt HEAD
  `c3a0e4875d44d8d916ab3b0a566b3da0384f956c`):** CODE/BEHAVIOR PASS, CI PASS. To MERGE BLOCKERS reist,
  begge dokumentasjons-presisjon (ingen kodefeil funnet): (1) denne filen beskrev en FØR-fullført
  tilstand (porter "ikke kjørt ennå", neste oppgave "fullfør porter/PR") mens alt faktisk allerede var
  gjort, og undertalte berørte filer (sa 3 docs/7 filer, faktisk 4 docs/8 filer); (2) UA-6-
  fullføringsspråket ("VERIFIED/COMPLETE"/"allerede tilkoblet") i D-127-teksten i
  DECISIONS_AND_ASSUMPTIONS.md og IMPLEMENTATION_PLAN.md kunne mistolkes som at UA-6 var HELT
  ferdig inkl. live leverandørverifisering. Begge rettet i denne truth-sync-runden (kun docs, ingen
  ny D-ID, ingen produktkode rørt) - se D-127-raden i DECISIONS_AND_ASSUMPTIONS.md for eksakt
  før/etter-ordlyd.

## Blokkeringer

Ingen for D-127 selv (ingen credential, ingen ny leverandør, ingen host-avhengighet). D-126 sine
gjenstående punkter (self-recovery/reboot-bevis, dokumentasjonslukking for G-K) er uendret utenfor
scope og krever enten en fremtidig autorisert feilinjeksjons-/reboot-oppgave eller en egen
dokumentasjons-closeout-oppgave - ingen av dem blokkerer D-127.

## Neste oppgave

1. **Umiddelbart:** verifisere at CI er grønn på denne truth-sync-commitens eksakte HEAD på PR #76,
   deretter avvente ny uavhengig arkitekt-re-review. Ingen selv-godkjenning/merge under noen
   omstendighet (D-120/CLAUDE.md, uendret).
2. Etter D-127 er merget: re-derivere neste slice fra faktisk repo-/masterplan-status på nytt (ikke
   anta en fast rekkefølge) - `product`/`operations`-domenene i UA-3 kriterium 2 har ingen kapabilitet
   ennå og er kandidater, likeledes UA-4 punkt (4) (Finance Integrity Gateway-audit/reconciliation-
   integrasjon for marketing spend) og UA-5 sitt incident→diagnose→fix-gap - se D-127 sin
   kandidatvurdering for full begrunnelse.
3. Separat, lavere prioritet: dokumentasjonslukking for D-126 review-runder G-K (formell D-ID-
   registrering av allerede-fullført arbeid som kun finnes i issue #68).
