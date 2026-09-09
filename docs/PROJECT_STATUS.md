# PROJECT STATUS

**Oppdatert:** 2026-09-09 (branch `claude/ua8-personal-digital-twin-core`, base `main=5df11e5add901f3fff10c2ef266c40e3e35e3f48`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## D-129: MERGET (korreksjon av forrige versjon av denne filen)

PR #78 (D-129, `operations` → Native Jarvis Operations Core, pluss arkitekt-review MERGE BLOCKER-fiks
for kryss-tenant/space-relasjonsintegritet) er MERGET til `main` som ekte to-forelder-merge-commit
`5df11e5add901f3fff10c2ef266c40e3e35e3f48` (verifisert `git log --pretty=raw`, fersk post-merge CI
grønn på run `34295189226`). `BUSINESS_DOMAIN_COVERAGE` viste 5/5 domener på `main` FØR denne sliceen
startet.

## Aktiv fase/oppgave

**UA-8: Personal Digital Twin - provider-uavhengig kjerne + UA-3 kriterium 1-fiks (D-130). PR ikke
opprettet ennå i denne økten, branch `claude/ua8-personal-digital-twin-core`, base eksakt
`main=5df11e5add901f3fff10c2ef266c40e3e35e3f48`.** Manuell fortsettelse etter D-129-merget, derivert
fra en frisk read-only rekonstruksjon (`git fetch origin --prune`, lokal HEAD=origin/main verifisert,
rent worktree). Ny arbeidsregel fra denne sliceen: STØRSTE TRYGGE SAMMENHENGENDE
masterplan-leveranse per slice, ikke minste mulige.

**Formell re-evaluering (parallelle background research-agenter, kode-nivå, ikke docs-tekst):**
UA-4 og UA-5 begge COMPLETE (uavhengig re-bekreftet, samme konklusjon som D-129); UA-6 og UA-7 begge
kode-komplette, kun eksterne D-108-credential-blokkere (pluss Q-32 punkt 1 for UA-7) gjenstår - ZERO
provider-uavhengig kode igjen for noen av de fire. **Kritisk funn:** UA-3 kriterium 1 ("Hva skjer med
kunde X?") var IKKE faktisk VERIFIED som D-73/Q-25 påsto - support-tickets/kontrakter skrev aldri til
`business_activities`. Rettet i SAMME PR (ikke en separat docs-only-PR, per ordren).

**Bygget (seks parallelle, filsti-partisjonerte agentleveranser, sentralt integrert av meg selv):**

1. **UA-3 kriterium 1-fiks:** `SupportService`/`AgreementsService` skriver nå til `business_activities`
   ved ticket-/kontrakt-opprettelse og status-/versjonsoverganger. 16 nye tester inkl. ekte
   ende-til-ende-bevis (`apps/api/test/ua3-business-timeline-e2e.test.ts`). Fant, men rettet IKKE i
   denne sliceen, en pre-eksisterende kryss-tenant `company_id`/`contact_id`-valideringsgap (Q-33,
   samme feilklasse som D-119, urelatert til UA-8, egen fremtidig fiks).
2. **`@jarvis/context`** (`049_context_engine.sql`): person+tenant+space-skopet kontekstmotor
   (sted/enhet/møte/aktivitet), `basis` deterministisk-vinner-alltid-presedens, møtekontekst utledet
   fra eksisterende `business_activities` (ærlig `end_time_known: false` der ukjent).
3. **`@jarvis/location`** (`050_location.sql`): provider-nøytral geofencing (sirkulære soner,
   Haversine, ingen PostGIS), eier-KONFIGURERT retensjon faktisk håndhevet, sammensatte
   `(tenant_id, memory_space_id, id)`-FK-er (D-129-lærdommen gjenbrukt direkte).
4. **`@jarvis/health`** (`051_health.sql`): provider-nøytral helse-ingestion, `health`-space
   STRUKTURELT låst (DB-CHECK + RLS), `HealthMetricSource`-adapterkontrakt + `FakeHealthMetricSource`.
5. **`ChannelSessionAuthority`** (`modules/core/src/services/channel-session-authority.ts`):
   generaliserer `VoiceSessionAuthority`-komposisjonsmønsteret til ALLE kanaler (`VoiceSessionAuthority`
   selv bevisst uendret). Ny `"desktop"`-kanal, lokal-agent modellert fullt ut via eksisterende
   `devices`-tabell (ingen ny migrasjon, ingen klientkode). Kanalbytte uten duplikate handlinger
   bevist via EKSISTERENDE `ToolGateway`-idempotency-dedupe.
6. **HA-kritisk-handling-bevis** (fant ett reelt, IKKE rettet gap - mål-eksistens-sjekk, Q-34, for
   bred blast radius for denne sliceen), **`MobilityAdapter`-kontrakt** (typer only, ingen
   bilprovider valgt), **familie/delt-space-audit** (eksisterende modell bekreftet trygg, Q-15
   oppdatert med et presist funn: `memory_spaces` er tenant-scoped, ikke person-scoped).

**Sentral integrasjon:** migrasjonsnummer-kollisjon mellom to agenter selv-oppdaget/-rettet
(context=049, location=050, health=051, tenant-catalog=052); erasure-plan utvidet for alle tre nye
domener (fant og rettet en RLS-blind person-scoped erasure-spørring i EGET førsteutkast FØR commit -
`context_observations` krever `jarvis.memory_spaces` satt, `setTenantOnlyContext` alene var
utilstrekkelig); ny `jarvis_list_all_tenant_ids()` (Q-27/D-65-mønster, uten `kind='business'`-filter)
for lokasjon/helse-sveip; to nye `DailyScheduler`-retensjonssveip; 2 lint-feil fra parallelle agenters
testfiler rettet; ny DPIA `docs/UA8_PERSONAL_TWIN_DPIA.md`; `OPEN_QUESTIONS.md` Q-29(4)/Q-31(3)
rettet til STALE, Q-13/Q-14/Q-15 oppdatert, Q-33/Q-34 nye funn logget (ikke rettet, bevisst).

**UA8_ACCEPTANCE:** (1) session continuity PASS, (2) helse/lokasjon routing+retensjon PASS,
(3) HA/car pre/post-verifisering PARTIAL (Q-34, ingen falsk PASS), (4) DPIA PASS.
**UA3_COMPLETE=true** etter kriterium 1-fiksen (alle fire kriterier nå faktisk VERIFIED mot kode).

## Kvalitetsporter kjørt i denne økten

- Seks nye/utvidede pakker: `modules/context/`, `modules/location/`, `modules/health/` (nye), samt
  endringer i `modules/support/src/service.ts`, `modules/agreements/src/service.ts`,
  `modules/core/src/services/channel-session-authority.ts` (ny), `modules/core/src/index.ts`,
  `packages/contracts/src/identity.ts`, `packages/contracts/src/mobility.ts` (ny),
  `packages/contracts/src/index.ts`, `modules/erasure/src/plan.ts`, `apps/api/src/main.ts`,
  `apps/api/package.json`.
- Fire nye migrasjoner: `049_context_engine.sql`, `050_location.sql`, `051_health.sql`,
  `052_tenant_catalog_all.sql`.
- Ny testmatrise (82 nye tester på tvers av 11 nye testfiler): `modules/context/test/service-rls.test.ts`
  (12), `modules/location/test/{service-rls,zone-scope-integrity}.test.ts` (14),
  `modules/health/test/service-rls.test.ts` (18), `modules/support/test/support-business-timeline.test.ts`
  (9), `modules/agreements/test/agreements-business-timeline.test.ts` (6),
  `apps/api/test/ua3-business-timeline-e2e.test.ts` (1), `modules/core/test/channel-session-authority.test.ts`
  (7), `modules/tool-gateway/test/channel-session-continuity-dedupe.test.ts` (1),
  `modules/core/test/shared-space-authority.test.ts` (3), `modules/tool-gateway/test/home-assistant-critical-action.test.ts`
  (11).
- `pnpm -w typecheck` (26/26 pakker) og `pnpm -w lint` (`eslint .`) - begge grønne, ingen nye
  feil/warnings (2 lint-feil fra parallelle agenters testfiler funnet og rettet FØR denne rapporten).
- **FULL arbeidsområde-testsuite (`npx vitest run`, ingen filter): 3764/3770 grønt (6 forventet skip,
  uendret fra tidligere) på 228 testfiler.** ÉN fil (`modules/knowledge/test/rls-role-isolation.test.ts`,
  urørt av denne sliceen) feilet under full-suite-kjøringen (600s) med en `afterAll`-hook-TIMEOUT
  (`appPool?.end()`), IKKE en assertion-feil - sannsynlig ressurskonkurranse fra hundrevis av
  parallelle embedded-Postgres-instanser i én prosess. Isolert re-kjøring: 6/6 grønt på 2.4s -
  bekreftet flake, IKKE en reell regresjon, rapportert ærlig og eksplisitt.
- Hemmelighetsskann av full diff: 0 reelle treff (kun Norsk prosa-tekst som inneholder ordet "token"/
  "password"/"secret" i beskrivende sammenheng, verifisert manuelt; targetert regex mot faktiske
  nøkkelmønstre i `.ts`/`.sql`-diffen: 0 treff).
- `git status`/`git diff --stat` gjennomgått manuelt: alle endrede/nye filer innenfor D-130 sitt scope,
  ingen urelaterte filer rørt, ingen D-108/credential-arbeid startet, ingen issue #68-mutasjon,
  worker/supervisor urørt.

## Blokkeringer

Ingen for D-130 selv (ingen credential, ingen ny leverandør, ingen host-avhengighet). To reelle,
bevisst IKKE rettede funn er logget for fremtidig arbeid (Q-33: kryss-tenant company_id/contact_id-gap
i Support/Agreements, pre-eksisterende; Q-34: HA-gateway mål-eksistens-sjekk-gap, krever en bredere
cross-domene-audit av gateway.ts FØR en trygg generisk fiks). Den automatiske arkitekt-loopen forblir
bevisst PAUSET av Tobias - INGEN posting til issue #68 i denne økten.

## Neste oppgave

1. **Umiddelbart:** commit/push denne branchen, opprett draft-PR, verifiser CI grønn på eksakt HEAD.
   INGEN merge/self-approval under noen omstendighet - kontrollsløyfen er pauset, ingen `ARCHITECT_TASK`
   postes.
2. Etter D-130 er merget (av arkitekten/Tobias, ikke av denne økten): egen, dedikert sikkerhetsfiks-
   slice for Q-33 (kryss-tenant `company_id`/`contact_id`-vakt i Support/Agreements, samme mønster som
   D-119/D-129). Egen, dedikert cross-domene-audit-slice for Q-34 FØR en generisk `gateway.ts`-fiks
   for mål-eksistens-sjekk vurderes.
3. Deretter: re-derivere neste STØRSTE TRYGGE SAMMENHENGENDE leveranse fra faktisk repo-/masterplan-
   status på nytt (ikke anta en fast rekkefølge) - kandidater inkluderer videre UA-8-utvidelser (når
   fysiske Apple-/leverandørporter åpnes) eller andre gjenstående masterplan-kapabiliteter.
