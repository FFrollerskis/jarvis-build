# PROJECT STATUS

**Oppdatert:** 2026-09-09 (branch `claude/ua8-personal-digital-twin-core`, base `main=5df11e5add901f3fff10c2ef266c40e3e35e3f48`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## D-131: D-130 arkitekt-review-herdingsrunde (samme PR #79, samme branch)

En ekte, uavhengig arkitekt-review (REVIEW_ID=5149129191, repo-eier `tsworkflow`, ikke Claude selv)
fant **fem MERGE BLOCKERS** i D-130 sin PR #79 mot faktisk kode/tester/CI/sikkerhet. Alle fem rettet
i ÉN sammenhengende herdingsrunde på SAMME PR/branch (ikke mikro-slices, ikke ny D-ID-kjede per
blocker), per reviewens eget krav.

**Fikset:**

1. **`ChannelSessionAuthority` koblet inn på den EKTE `/chat`/`/brief`-produksjonsstien** (var bygget
   i D-130, men aldri wired). Ny `POST /session/authorize`-rute (speiler `/voice/session/authorize`).
   `/chat`/`/brief` sin kropp er nå slank (`session_id`/`tenant_id`/`memory_space`/`channel`/
   `message`) - `person_id`/`device_id`/`auth_strength` er HELT fjernet fra kroppen, aldri lenger
   klient-oppgitt. Server slår opp person/enhet fra sesjonsraden (`SessionService.getActive()`, ny).
   Voice sin `VoiceSessionAuthority` uendret; mobil-/web-klienter wired til ny kontrakt (web-flyten
   verifisert ende-til-ende med Playwright mot en ekte lokal server). Ny ekte API-komposisjon-
   sikkerhetstest (`session-authority-e2e.test.ts`, 8 tester): kanalbytte-kontinuitet
   (mobile→web→watch, SAMME session_id) OG null sesjonsmutasjon på ugyldig/kryss-person/kryss-
   tenant/replayed bevis, pluss avvist evidence-smugling.
2. **UA-3 kriterium 1-tidslinjeskriving gjort atomisk** - `recordActivityInTransaction()` kjører nå
   INNI samme transaksjon som ticket/kontrakt-raden (var to separate transaksjoner). Ekte
   feilinjeksjonstest beviser rollback.
3. **Q-33 lukket NÅ** (var bevisst utsatt i D-130 - reviewen korrigerte at D-130 selv gjorde gapet
   relevant) - `assertCompanyContactInScope()` i Support/Agreements, speiler D-129s
   `OperationsService`-mønster.
4. **Person/tenant-integritet for alle fem nye UA-8-tabeller** - sammensatt FK mot `person_tenants`
   (ikke bare global `people`-FK); `location_zone_visits` sine D-129-mønster-FKer utvidet med
   `person_id`.
5. **Location-retensjon FK-trygg og observerbar** - avhengige visitter purges sammen med utløpte
   observasjoner (ingen FK-feil); sveip-feil logges/telles strukturert i stedet for å svelges stille
   (samme fiks anvendt på health-sveipet).
6. **Q-20 person-erasure utvidet** med alle fire nye Personal-Twin-tabeller (var kun
   `context_observations` i D-130).

**Kvalitetsporter (denne runden, hele arbeidsområdet):**

- `pnpm -w typecheck`: 26/26 pakker grønt (inkl. fire host-script-filer i `modules/finance/scripts/`
  som trengte `channelAuthority`-strukturfelt for den nye påkrevde `ApiDeps`).
- `pnpm -w lint`: rent, 0 feil/advarsler.
- **Full arbeidsområde-testsuite kjørt TO GANGER: 235/235 filer, 3820/3820 tester grønt begge
  ganger.** Første kjøring fant og rettet en REELL D-124-migrasjonsencoding-feil (`050_location.sql`
  inneholdt U+2194 i en doc-kommentar, ikke WIN1252-representerbart - rettet til ASCII, re-verifisert
  58/58 D-124-tester). Én embedded-Postgres `afterAll`-hook-timeout-flake i
  `modules/knowledge/test/chunking-safeguard.test.ts` (urørt av denne runden) - isolert re-kjøring
  2/2 grønt, andre full-suite-kjøring 235/235 grønt uten flake.
- Manuell hemmelighetsskann av full diff: 0 reelle treff.
- Ny testmatrise: 8 (session-authority-e2e) + 7 (support-timeline-atomicity) + 9
  (agreements-timeline-atomicity) + 3+3 (person-tenant-membership-fk context/health) + 6
  (health sweep) + ~23 (location retention+scope) + 3 (personal-digital-twin-erasure).

**UA8_ACCEPTANCE (re-evaluert etter rettelsene):** (1) session continuity PASS (nå faktisk wired og
bevist, ikke bare en isolert klasse); (2) helse/lokasjon routing+person/tenant-scope+retensjon PASS;
(3) HA/car pre/post-verifisering PARTIAL (Q-34, bevisst IKKE rørt denne runden - reviewen sa
eksplisitt vent på en dedikert cross-domene-audit); (4) DPIA PASS. **UA3_COMPLETE=true** (kriterium 1
er nå source-backed OG recovery-/relasjons-trygg).

Full detalj: D-131 i DECISIONS_AND_ASSUMPTIONS.md. D-130 sin opprinnelige leveranse (seks parallelle
agenter, UA-8-kjerne + UA-3 kriterium 1-fiks) uendret i innhold, kun herdet.

## Kvalitetsporter kjørt i denne økten

Se D-131-seksjonen over for full detalj. Kort: typecheck/lint/full-testsuite alle grønt, ingen
urelaterte filer rørt (kun de fem blockernes faktiske scope pluss fire host-script-filer som trengte
et strukturelt `ApiDeps`-felt).

## Blokkeringer

Ingen for D-131 selv. Q-34 (HA-gateway mål-eksistens-sjekk, krever egen cross-domene-audit av
`gateway.ts` FØR en generisk fiks) forblir bevisst urettet, per reviewens eget krav om å ikke fikse
den opportunistisk. Den automatiske arkitekt-loopen forblir bevisst PAUSET av Tobias - INGEN posting
til issue #68 i denne økten.

## Neste oppgave

1. **Umiddelbart:** push denne branchen (samme PR #79), verifiser CI grønn på eksakt ny HEAD. INGEN
   merge/self-approval under noen omstendighet - kontrollsløyfen er pauset, ingen `ARCHITECT_TASK`
   postes. Vent på ny arkitekt-runde mot denne HEAD-en.
2. Etter D-130/D-131 er merget (av arkitekten/Tobias, ikke av denne økten): egen, dedikert
   cross-domene-audit-slice for Q-34 FØR en generisk `gateway.ts`-fiks for mål-eksistens-sjekk
   vurderes.
3. Deretter: re-derivere neste STØRSTE TRYGGE SAMMENHENGENDE leveranse fra faktisk repo-/masterplan-
   status på nytt (ikke anta en fast rekkefølge).
