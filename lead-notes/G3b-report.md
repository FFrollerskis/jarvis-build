TS: 2026-11-26T09:54:40.360Z
Slutt: WP-G3b er ferdig og pushet. Treet er rent, og HEAD er lik `origin/claude/wp-g3b-vision-rest`.

**Gren og commits**
- Gren `claude/wp-g3b-vision-rest`, tipp `36ea26656173ff2982496bc03706242a9cb3c184`, pushet til `https://github.com/FFrollerskis/jarvis-build.git` (origin bekreftet).
- Ni commits på `origin/main..HEAD`, 21 filer, +3059/-33. Ingen force-push, reset, stash eller rebase.
- f358140b lå bare lokalt ved oppstart. Det er nå pushet.
- Commits: 7d3f4b5f baseline, 1d42fc04 K1, 35a9060e K2, 3edc5c91 K3, f358140b lekkasje-tester, 39443861 fix (200-svaret), 5c4b0b3b DPIA + inventar, 589ec9ec runbook, 36ea2665 H2-peker.
- Ingen `CORE_DEPENDENCY_DECISION_REQUIRED` og ingen `HARD_EXTERNAL_BLOCKER`.

**WIP-valideringen**
- `vision-routes.ts`-endringen var en fullført forbedring, ikke halvferdig. 200-svaret gir nå `shortened` som liste med vindusnavn, som 409-svaret og revisjonsraden. Før ble tjenestens interne objekt sendt ut.
- Testene var oppdatert tilsvarende. Jeg committet den som 39443861 (`fix:`) uten å reverte noe.
- De 3 dokumentene fra WIP var korrekte mot koden og er committet. Jeg la til:
  - to DEFERRED-rader i DPIA §5
  - svarformer og beviskvalitet i runbook §4
  - §8 tilbakerulling
  - §9 testbevis
  - en peker i H2-runbooken

**K1–K5**
- **K1, ferdig (DORMANT, NOT VERIFIED):** `/vision/retention/get` (eier-les) og `/vision/retention/set` (eier-skriv med step-up).
  - Kode: `vision-routes.ts:106,111,156-167,281-309`; `service.ts:172-205,294-330`.
  - Test: `wpg3b-vision-retention-routes` (39), `g3b-retention` (37), `wpg3-vision-routes` og `wpg3-vision-runtime` er utvidet.
  - Tak per space (2 GiB) er DEFERRED. Det er prosess-konfigurasjon (`JARVIS_VISION_MAX_STORED_MB`), og per space krever ny kolonne og omkobling av kvotesjekken.
- **K2, ferdig (DORMANT, NOT VERIFIED):** Syn-kort som sjette og siste seksjon i Personvern-senteret.
  - Kode: `privacy-vision.ts`, `privacy.ts:596`, `register.ts:201`, `main.ts:805-831,1540`.
  - Test: `wpg3b-privacy-vision-card` (26), `wpg3b-privacy-vision-db` (6), `wpg3b-privacy-parity` (2).
  - Kortet finnes bare med vision og Personvern-senteret på. Uten dem er senteret byte-identisk med et opptak fra ren main (`71a31d8b`). Ingen festet baseline er endret.
  - Fail-lukket: kaster `status()`, vises «Utilgjengelig» og senteret svarer likevel. Kortet viser kun tellere, tilstander og koder.
- **K3, ACCEPTED/PINNED, ingen migrasjon:** nål i `modules/vision/test/g3b-label-gap-pin.test.ts` (10 tester). En stramming i SQL kunne gjøre databasen strengere enn JS (23514 og tilbakerulling av hele hendelsen), og kan ikke bevises i `en_US.UTF-8`.
- **K4, ferdig:** ingen nye flagg, migrasjoner eller pakker. Flagg AV er identisk med main. `wph1-flag-off-selection-baseline` (7) og `wph2-flag-off-main-parity` (12) er grønne.
- **K5, ferdig:** tester følger koden. Runbook §1,2,4,6,7,8,9, DPIA §2/§5/§6.10 og PROCESSING_INVENTORY er oppdatert; D-420 er grønn.

**Funn (dokumentert ærlig)**
- Retensjon er forankret ved skriving (`retention_expires_at` og `expires_at` settes ved insert). Å forkorte vinduet sletter dermed ikke eksisterende vision-rader. Det er bevist av en tripwire-test mot alle sveipene i `g3b-retention`.
- G4 sin signal-retensjon bruker `retention_days` ved sveip (`signal-retention.ts:93`, wiring `situation-signals-wiring.ts:266`). Å forkorte kan derfor slette eldre avledede signalsituasjoner i domenet `vision`. Det er årsaken til typet bekreftelse.
- Kjeden rute → signalsveip er lest i kode, og `visionDays`-grenen er testet i `wpg4-fix-lifecycle`. Ingen test kjører den ende-til-ende (NOT VERIFIED).

**Designvalg og antakelser (forslag til D-485)**
1. Vinduene er forankret ved skriving. En endring gjelder rader som skrives etter den, og retroaktiv sletting er DEFERRED.
2. Grenser: hendelser 1–365 døgn, bilder 1–90, bildevindu aldri lengre enn hendelsesvindu (`exceeds_retention_days`). Standardene 30/7 er uendret. Grensene er min antakelse.
3. PUT med absolutte verdier. Begge felt kreves, og `null` betyr eksplisitt standard.
4. Typet bekreftelse (`confirm: true` + `confirm_memory_space` = grantets space) kreves bare når et effektivt vindu blir kortere. Forlengelse og gjenspilling krever den ikke, og overflødig bekreftelse er ufarlig.
5. Step-up er sesjons- og kanalbundet, ikke nyttelastbundet. Kanalpåstanden er klient-påstått inntil WP-S1/JARVIS-111. Jeg har ikke bygget noe der.
6. Idempotens ved konstruksjon: en gjenspilling gir `changed:false`, ingen skriving og ingen revisjonsrad. Advisory-lås per (tenant, space) avgjør «forkorting?» mot raden som faktisk overskrives.
7. Revisjon `vision.retention_set` i samme transaksjon, kun tall og enums. Nektede kall og gjenspillinger skriver ingen rad.
8. Svaret bygges eksplisitt uten spread, så en utvidet rad ikke kan lekke tenant eller aktør.
9. Ruten er eierens HTTP-flate og ikke et modellverktøy. Retensjonsrutene gir 404 når vision er av, og `503 retention_unavailable` hvis tjenesten mangler.
10. Kortet viser bevisst ikke `last_inventory_skip_at` (aktivitetsinformasjon). Helse-spacet er utelatt fra retensjonsradene.
11. Retensjonsvinduene ligger igjen i `vision_retention_policies` hvis flagget slås av. De gjelder da videre for det flagguavhengige D-153-sveipet og for G4.

**Tester som `postgres`, 2 arbeidere, `--bail=1`, mot endelig kode**
- `modules/vision` (alle): 18 filer / 382 tester grønne.
- `apps/api` `wpg3-*`, `wpg3b-*`, `wph0-*`, `wph1-*`, `wph2-*`: 52 filer / 1025 tester grønne. Fordelt: wpg3 136, wpg3b 73, wph0 329, wph1 237, wph2 250.
- Doc- og manifestvakter: 7 filer / 87 tester grønne. De er d420, d398-doc-banners, d398-processor-matrix, d398-vacuous-test-guard, env-drift, part3-tool-manifest og connector-sdk/guard. Etter runbook-endringene kjørte jeg 6 filer / 89 tester på nytt, også grønne (inkl. `wph2-privacy-doc-reader` og `wph2-control-centers`).
- Hele suiten er ikke kjørt.

**Mutanter**
- 56 mutanter: validering 11, forkorting/idempotens/lås/revisjon 13, rute 15, kort 17. Alle er DREPT i sluttilstanden.
- R11 (spread-lekkasje) og C09 (negative tellere) overlevde først og ble felt av nye tester (f358140b). Det er byggerens «53/53».
- Jeg la til R13–R15 (`shortened` som rått objekt, invertert filter, kun hendelsesvindu) etter svarform-endringen. Hele rute-serien R01–R15 kjørte jeg på nytt mot endelig kode: 15/15 drept. Kilden ble gjenopprettet og er verifisert ren.
- V/S/C-resultatene er fra byggerens kjøring. Koden i `service.ts` og kortet er uendret siden (`git diff f358140b HEAD` viser kun rute og rute-test).

**Statiske kontroller (alle exit 0)**
- `pnpm -r --workspace-concurrency=2 run typecheck` (35 pakker), `pnpm lint`, `pnpm check:containment`.
- gitleaks `origin/main..HEAD`: 9 commits, `no leaks found`. Jeg brukte ingen `.gitleaksignore`.

**Security surfaces for uavhengig review**
- `vision-routes.ts:187-196` (grant → eier → step-up), `:295` (`confirmed`-utledningen), `:302` (`shortened`-mappingen), `:156-167` (eksplisitt svarbygging).
- `service.ts:184-200` (validering og forkortingsregel), `:294-330` (lås, no-op, bekreftelse, upsert, revisjon i samme transaksjon).
- `privacy-vision.ts:47-55` (RLS-lesing uten health-space), `:59-61` (`code`/`count`, ingen fri tekst), `:207-230` (fail-lukket bygging).
- `register.ts:201` og `main.ts:805-831,1540` (kortet bare med begge flagg; sen referanse til kjøretiden).
- Koblingen til G4: `signal-retention.ts:93` og `situation-signals-wiring.ts:266`.

**Kjente begrensninger og Q-forslag**
- En gammel, forsinket forespørsel som gjenspilles etter en senere endring er en ny gyldig forespørsel (ingen `expected_updated_at`).
- Bekreftelsen er et ekko av spacenavnet, ikke en nonce.
- G4-kjeden er ikke bevist ende-til-ende. NAS-trinn 11–12 i §6 er ikke kjørt.
- Q-forslag: (a) Skal forkorting kunne gjelde lagrede rader som egen klasse D-handling? Anbefaling: nei inntil eieren ber om det. (b) Versjons-forutsetning på ruten når første klient faktisk kaller den. (c) Tak per space som eier-innstilling: utsett til behov. (d) Skal G4-signalretensjonen ha egen innstilling i stedet for å følge hendelsesvinduet?

**Forslag til JARVIS-114-status**
- **(e):** (e1) rute og (e2) kort er BUILT, DORMANT og NOT VERIFIED (kun embedded Postgres og falske kilder). Tak per space, retroaktiv anvendelse og versjons-forutsetning står igjen som DEFERRED.
- **(k):** ACCEPTED/PINNED med permanent nål.
- **Fortsatt NOT VERIFIED:** NAS-trinn 11–12, G4-kjeden ende-til-ende, `en_US.UTF-8` (l) og ekte step-up-kanal (WP-S1/JARVIS-111).
