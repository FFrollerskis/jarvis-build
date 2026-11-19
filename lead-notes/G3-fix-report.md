TS: 2026-11-19T13:44:34.506Z
# WP-G3 (D-465) fiksrunde: sluttrapport fra BUILDER (2026-11-19)

**Ny HEAD: `c6488c10d42e5bf061c014bd3ca565571da79a2d`**, gren `claude/wp-g3-vision`. Det er 14 commits over `0716b6a9`: 13 fiksrunde-commits `92d2d07a..e3e22600` og `3b7b6770`, pluss ett docs-commit med testtall. Base er uendret (`b2d43703`). Arbeidskopien er ren. Migrasjon 133-136 er endret på stedet (ingen 138).

Push: ett forsøk gav 503 («credential service temporarily unavailable»), så branchen er ikke publisert. Ingen PR eller merge, og delte docs er ikke rørt. Ingenting er VERIFIED mot ekte kamera, HA eller modell.

## Funn, status og bevis
Alle punkter i begge review-filene er behandlet. T = test som feller gammel kode. M = mutasjoner felt av kjørt, alle kjørt på nytt mot `3b7b6770`.

- **A-M1 LUKKET:** ærlig tekst (classifier, DPIA §7.10) og DB-CHECK på formen (133 NOT VALID + betinget VALIDATE, 135 streng). JS- og SQL-regelen er bevist enige over hele Unicode. T g3-migrations, g3-pure. M 7/7.
- **A-M2 LUKKET:** env-verdien når selve modellkallet, grense 5000-180000 uten stille klemming. T wpg3-vision-runtime (e2e mot treg server). M 2/2.
- **B-M1 LUKKET:** lagring og vedlikehold bygges når STORAGE_DIR er satt, mens STORE_SNAPSHOTS kun styrer skriving. T wpg3-vision-runtime-db. M 2/2.
- **B-M2 LUKKET:** koblingen `tenantIds:[ownerTenantId]` er pinnet (runtime-db og MAIN_SRC). M 2/2.
- **A-L1 LUKKET:** critic med kamerabilde kaster `critic_restricted_media_nonlocal` mot ikke-lokal critic. T wpg3-restricted-media. M 1/1.
- **A-L2 LUKKET:** vakt feller adapterfil med bildemapping uten `assertNoRestrictedMedia`. T g3-guards. M 3/3.
- **A-L3 LUKKET:** `local_vision`-profil og leverandørnavn registreres kun med adapteren, så flagg av gir identisk register. T wpg3-vision-runtime. M 4/4.
- **A-L4 LUKKET (som anbefalt):** ordliste utvidet, repo-bredt kameraomfang for video og nett, frossen prompt. Vaktene er dokumentert som NAIVE (AST-vakt DEFERRED). M 5/5.
- **A-L5 LUKKET:** vertsnavn løses ved oppstart, link-lokale og offentlige adresser avvises, Tailscale kun med `JARVIS_VISION_ALLOW_TAILSCALE`. Per-kall DNS-pinning er DEFERRED (kun oppstartssjekk). T wpg3-vision-runtime. M 5/5.
- **A-INFO-4 LUKKET:** embedding-URL valideres. En ikke-lokal URL gir ingen vision-vektorer, men API-et starter. M 2/2.
- **A-L6 LUKKET:** bredde og høyde leses fra bildehodet (8192 px per side, 50 MP, ingen dekoder), svar fra modellen maks 1 MiB. T g3-pure, wpg3-local-vision, g3-pipeline. M 10/10.
  - `al6-f` er ekvivalent: en udefinert bredde avvises uansett.
  - `al6-i` kjøres ikke: uten bytetak OOM-dreper den testprosessen. Taket bevises av i2, j og k.
- **A-EKSISTERENDE LUKKET (avvik):** `normalizeHomeState` fjerner camera `access_token` og `entity_picture(_local)`, og token-attributter i alle domener. T d388-connectors-v2. M 5/5. Lekkasjen lå i `read_state`; `list_states` gir kun id, state og navn.
- **B-L3 LUKKET:** audit_events-rad i samme transaksjon for register, update, remove (med antall bilder) og opptak. T wpg3-vision-routes. M 6/6.
- **B-L4 LUKKET:** egen grense på 20 per minutt per IP før kroppen leses (429). M 2/2.
- **B-L5 LUKKET:** ukjent rom gir 400 `vision_validation`. M 1/1.
- **B-L6 LUKKET:** deterministisk barriere i capture-testen og opplasting nær `maxUploadBytes`. M 2/2.
- **B-L7 LUKKET:** advisory-lås per (tenant, space), testet med 8 samtidige og plass til 1. T g3-lifecycle. M 1/1. Første testversjon lot mutanten overleve i 1 av 3 kjøringer; den er skjerpet med en pool-proxy og er nå 3/3 felt.
- **B-L8 DELVIS:** stuck gravstein er sveipefeil (lett kjøring kaster, full kjøring feiler jobben), poller-backoff (x2, tak 5 min), ny `POST /vision/status` (kun eier, kun koder og tall). Kort i Personvern-/helsesenteret er DEFERRED (delt H2-kode). T g3-lifecycle, g3-poller, wpg3-vision-routes, wpg3-vision-runtime-db. M 11/11.
- **B-L9 LUKKET:** kolonne-GRANT UPDATE i 133-136, ingen tabell-UPDATE. Katalogtest og setningstest i g3-migrations. M 7/7.
- **B-L10 LUKKET:** skrivetest ved oppstart og runbook-steg (bind-mount eller chown for `USER node`). M 1/1.
- **B-L11 LUKKET:** reaperen tømmer køen (batcher med markør, maks ett forsøk per gravstein per kall). Eier-rute for `retention_days` er DEFERRED (D-41), som anbefalt. M 4/4.
  - Mutasjonsløpet avdekket en egen feil jeg først innførte: ORDER BY mot et tekst-alias hoppet over gravsteiner ved sifferbredde-skifte. Rettet i `8c337b0e` med regresjonstest.
- **B-L12 LUKKET:** ha-pipeline-testen assert'er nå raden. M 1/1.
- **A «til lead» (1), migrasjon 135/137 dropper CHECK via LIKE: ÅPEN, bevisst urørt.** Ingen feil i dag, og B bekreftet én CHECK per kolonne mot integ2. Kan hardnes med conkey-filter hvis du ønsker det.
- **INFO-punktene** (A-INFO-1 til 3, ingen bildeservering) ga ingen handling. Bildeservering er dokumentert som DEFERRED.

## Avvik
- **A-EKSISTERENDE** er en flaggUAVHENGIG endring av eksisterende oppførsel (D-388). Den er bevisst bredere enn camera: token-/hemmelighetsnavn og token-URL-er fjernes i alle domener (samme lekkasjeklasse, én trakt).
- **Strammet eller endret oppførsel:**
  - Tidsavbrudd er nå 5000-180000 og stopper oppstarten utenfor (dokumentasjonen sa 5-600 s).
  - Link-lokale adresser (169.254/16, fe80::/10) godtas ikke lenger.
  - Nytt flagg `JARVIS_VISION_ALLOW_TAILSCALE` (`.env.example`, `service-env.mjs`, compose: +1 linje, kun api).
  - Ny rute `/vision/status` (10 ruter totalt).
  - `local_vision` ligger ikke lenger i `DEFAULT_PROFILES`.
- **Berørt utenfor UA-9, flaggnøytralt:**
  - `memory/embedding.ts`: ny eksport `embeddingEndpointFromEnv`, samme valg som før.
  - `model-gateway`: profilregistrering og critic-kast kun ved restricted media.
  - `provider-pause.ts` og `main.ts`: kun med flagg (startup-DNS, registry).
- **Tester:** ingen eksisterende ikke-G3-test er endret eller svekket. G3-egne tester er justert til strukturelt gyldige bilder, siden dimensjonsparsing gjør at tamper-tester nå flipper siste innholdsbyte. `d388-connectors-v2` har fått 2 nye tester.
- **Egne docs** (DPIA, runbook, PROCESSING_INVENTORY) er oppdatert. De er fortsatt UTKAST uten juridisk gjennomgang.

## Tester og kommandoer
Alt kjørt som `postgres` med `HOME=/tmp/pg-home` og `npm_config_manage_package_manager_versions=false`, maks 2 workers.
- `pnpm -r run typecheck`, `pnpm lint` og `pnpm check:containment`: alle exit 0 (kjørt på nytt etter containeren startet om).
- gitleaks `0716b6a9..HEAD` (14 commits): ingen funn.
- **Vaktbatch** (43 filer, 751 tester): grønn. Den dekker g3, d395/d420/d442, flagg-av-baselinene wph1/wph2, env-drift, compose-isolasjon, schema-invariants, migration-order, erasure og model-gateway/adaptere.
- **G3-settet:** 20 filer, 418 tester grønne (373 er nye G3-tester i 17 filer, pluss 2 i `d388`). Fase 1 hadde 19 filer og 333 tester.
- **Mutasjoner:** 86 spesifikasjoner, 84 felt, 1 ekvivalent, 1 ikke kjørt (se A-L6).
- **Full suite** (én gang, under `flock`, `--exclude "**/embedded-postgres-ipv4-contention*"`, log `/tmp/lead/logs/g3-fix-full-suite.log`): 888 filer og 15 386 tester på 2 302 s. 885 filer og 15 381 tester er grønne.
  - De 3 røde filene (5 tester) er kun de kjente sandkasse-feilene: `wpc3-review1-hardening` F10a/b/c, `break-glass-guard`, `nas-ua0-gate` «friskt system». Ingen er knyttet til G3. Til sammenligning hadde fase 1 887 filer og 15 298 tester.
  - Suiten kjørte på `3b7b6770`. `c6488c10` er docs-only (runbook §9); gitleaks, d420 og privacy-doc-reader (23/23) er kjørt på nytt på den.

## Oppdatert D-465-tekst (kun endringer, resten uendret)
«(1) Lokal modell- og embedding-URL valideres ved oppstart både syntaktisk og ved navneoppløsning. Offentlige og link-lokale adresser avvises, og Tailscale tillates kun med eierens flagg. Per-kall DNS-pinning er DEFERRED. (2) `local_vision` registreres i kapabilitetsregisteret og modellprofilene kun når adapteren er på, så flagg av er identisk med main. Et critic-trinn med kamerabilde kaster mot ikke-lokal critic. (3) Objektnavn fra modellen er åpent ordforråd og UBETRODD data: DB-CHECK på formen, ingen garanti mot personnavn. Byggevaktene er naive brudd-vakter, ikke bevis. (4) Lagringstaket (2 GiB per space) holder også under samtidighet. Bildefiler slettes også med skriveflagget av (STORAGE_DIR styrer vedlikeholdet), og en gravstein som ikke lar seg slette er en sveipefeil. (5) Eier-handlinger revideres i samme transaksjon. Runtime-rollen har kun kolonne-UPDATE, opplasting har egen IP-grense, og `POST /vision/status` gir eieren helsebildet. (6) Det eksisterende `home-assistant`-verktøyet `read_state` fjerner nå kamera-token og token-URL-er (flaggUAVHENGIG, D-388). Retensjonsvinduene kan kun settes via tjenesten eller databasen (eier-rute DEFERRED, D-41).»

## Nye eierspørsmål (med anbefaling)
1. Skal Tailscale tillates for modellen på PC-en din? Anbefaling: bare hvis modellen faktisk nås via ditt eget tailnett, ellers la flagget stå av.
2. Skal vi bygge en eier-rute for retensjonsvinduene (D-41) før lagring slås på? Anbefaling: ja, den er liten. Sett 3 dager for bilder.
3. Skal kamera-fjerning også slette kameraets hendelser, inventar og vektorer? Anbefaling: nei som standard (egen retensjon, 30 d), men tilby «fjern også historikk» via erasure med typet bekreftelse.
4. Lukket etikett-ordforråd i stedet for åpent? Anbefaling: behold åpent til et modellvendt verktøy bygges. Da må det være en lukket liste eller untrusted-innramming.
5. Bildevolum: bind-mount eller navngitt volum med engangs-chown? Anbefaling: bind-mount.
6. Kort for `/vision/status` i Personvern-/helsesenteret (delt H2-kode)? Anbefaling: ja, når UA-9 slås på i drift.
7. Per-kall DNS-pinning for modell-endepunktet? Anbefaling: ikke nå, vurder hvis modellen flyttes utenfor eget nett.
