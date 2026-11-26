TS: 2026-11-26T00:10:16.063Z
**WP-G2c: sluttrapport fra BYGGEREN (K1–K6 bygget og pushet, 0 mutanter overlevde)**

Ingen `CORE_DEPENDENCY_DECISION_REQUIRED` og ingen `HARD_EXTERNAL_BLOCKER`.

**Branch**
- Branch `claude/wp-g2c-personal-rest`, HEAD `2bd0dedc`. Pushet til origin (`https://github.com/FFrollerskis/jarvis-build.git`, verifisert før hver push). Arbeidstreet er rent, ingen PR, ingen merge.
- 15 commits, 47 filer, +3311/-92. Delte dokumenter er ikke rørt.
- Migrasjon 145 er ubrukt.

```
924fc6ac feat K2 pool connectionTimeoutMillis      0585452f feat K1 eier-rute for avstemming
4ddad4a5 fix  K4 felles låsrekkefølge              5ea7743b, 113558ec test K4 (midt i flukt, radrekkefølge)
c0a66603, 8a75702d test K1 (lagrede parametre, hull fra mutanter)
cac66f40 fix  K3 detectTrips e/1-4                 c585eafc fix K3 invitasjons-orakel e/8
8c00529f feat K3 DAV-grense + decision e/6-7       14a3c261 fix K3 «nå»-sted maks alder + no-store e/5
c48931f7 docs K3 HealthKit-kontrakt + tester       cf7b2ed9 test DAV ventetid
b5660abb docs K6 runbook/inventar/DPIA             2bd0dedc chore gitleaks falsk positiv
```

**K1–K6 status**

| K | Status | Hva som er gjort |
|---|---|---|
| K2 | Ferdig | `createPool` har `connectionTimeoutMillis`. Standard 30 s, `0` = ingen grense, ellers 1000–600000 ms, alt annet er oppstartsfeil. Variabelen `JARVIS_DB_CONNECT_TIMEOUT_MS` står i `SERVICE_ENV` for api, worker og migrate; compose er regenerert og `.env.example` oppdatert. Testene viser rask feil, uendret normalbruk og ingen lekkasje av streng eller passord. `advisory-lock.ts` er urørt. |
| K1 | Ferdig | Eier-rute `POST /personal/actions/reconcile` (krever eier og signert økt, ingen modellflate). Den leser målets tilstand via eksisterende lese-handling og kaller aldri skrive-verktøyet. `applied` kun med bevis, `failed` kun med strengt bevis, ellers forblir raden `outcome_unknown` med årsakskode. Idempotent og revidert. `p1a_outcome_reconcile` er markert bygget i `status.ts`. Migrasjon 144-hodet og runbook korrigerer 125-kommentaren. |
| K4 | Ferdig | `lockDeviceRowsOn` låser alle berørte enhetsrader med `ORDER BY device_id FOR UPDATE` før `device_proof`-innrullering, i samme rekkefølge som fjerningen. De deterministiske kappløpene er røde uten fiksen og grønne med den. Hele transaksjonen ruller fortsatt tilbake ved feil. |
| K3 e/1–4 | Fikset | `detectTrips`: hjemmested er eksakt normalisert treff (tidligere delstreng), tom eller blank liste gir fail closed, og algoritmen er lineær uten `Math.max(...)`. `trip_id` er en intern hash (`trip-` + 24 hex), og `byCode` erstatter `localeCompare`. |
| K3 e/5 | 2 fikset, 3 DEFERRED | Fikset: «nå»-sted i familievisningen vises kun med siste observasjon ≤ 6 t (`observed_at` = sist sett), og `/personal/*` svarer med `no-store`. DEFERRED som appkontrakt (tester + doc): sammenslåing også for puls, søvnsum uten uuid, skritt fra iPhone og Watch. De krever appen, og en prøve bærer bare `observed_at`. |
| K3 e/6 | Fikset | DAV har egen grense: 30/enhet, 60/person og 10 mutasjoner/person per minutt. 429 kommer etter eier-sjekken og før step-up, stoppvakt, revisjon og klient. |
| K3 e/7 | Fikset | Revisjonens `decision` følger utfallet. ALLOW kun for requested/SUCCESS/REPLAYED, ellers REJECTED/MISMATCH/UNKNOWN, og uventet utfall er aldri ALLOW. |
| K3 e/8 | Fikset | Invitasjon slås opp scopet til kalleren: en annens invitasjon og en ukjent id gir identisk 404, uten radlås på andres rad. `not_the_invitee` er fjernet. |
| K5 | Ferdig | Guard-batch grønn, se Tester. Ingen ekstern baseline er endret. |
| K6 | Ferdig | Runbook §0, §2.7, §4.5 (ny), §5, §6 regel 12–13, §8, §9, §10 steg 7–14 (`NOT VERIFIED`), §11 og Q-G2-13..17 i §12. PROCESSING_INVENTORY (journal og familievisning) og DPIA §9 er oppdatert. |

**Avvik og begrensninger**
- `json()` globalt er uendret: `no-store` gjelder kun `/personal/*` for å bevare flagg-AV-paritet med main. K3 e/5 sitt `json()`-punkt er dermed delvis (PARTIAL).
- **Kapabilitetstabellen:** pool-rader i §0 står utenfor `PERSONAL_CAPABILITY_STATUS`, fordi `wpg2-status` krever eksakt id-likhet.

**Forslag til D-483 (nummererte antakelser)**
1. Pool-tidsavbrudd 30 s er ikke flagg-styrt og er eneste atferdsforskjell mot main med alle flagg AV. `0` gir main-atferden.
2. Avstemming krever eier og signert økt, fordi utfallet styrer hva replay med samme nøkkel returnerer. Ingen retry, ingen skrive-kall, ingen delegat.
3. `applied` krever at `op.post` holder på en brukbar, settlet lesing og at ingen nyere handling i eierens egen journal rammer samme mål. Bil krever i tillegg fersk lesing med `observed_at` ≥ forespørselen.
4. `failed` krever at HA `last_changed` + 60 s ≤ requested_at og tilstanden fortsatt er før-tilstanden (eller uendret scene-/skriptmarkør, og skript kjører ikke). I tillegg må det gå ≥ 5 min siden `completed_at`. Bil kan aldri bli `failed`, og jammet lås aldri.
5. `requested`-rader fra krasj avstemmes ikke. DAV har ingen journal, så `UNKNOWN` løses med `get`.
6. `request_params` lagres kun hvis de består det strenge zod-skjemaet, og digest verifiseres på nytt ved avstemming. 125-kommentaren er foreldet men uforanderlig.
7. HA `last_changed` er lagt til i normalisert tilstand (kun strengt ISO, ellers `null`), med NTP-antakelse < 60 s. Revisjonstype er `personal.action_reconciled`.
8. Låsrekkefølgen i K4 er flagg-uavhengig (kun rekkefølge, ingen utfallsendring).
9. Hjemmested er eksakt (eieren oppgir «Oslo S» separat), og tom liste gir fail closed. `trip_id` er hash.
10. «Nå»-sted maks 6 t, målt på siste observasjon. Produsenten må melde oftere.
11. DAV-grensene er en kodebeslutning uten env. Ingen revisjonsrad per avvisning, og manglende begrenser gir fail closed.
12. API-endring: 403 `not_the_invitee` er nå 404 `not_found`.

**Migrasjon**
- 144 (`144_personal_action_reconcile.sql`, kun ASCII/æøå, d124-guard grønn): additive kolonner `request_params` og `reconcile_*`, CHECK-er og erstattet triggerfunksjon.
- Rollback: kolonnene kan stå urørt. For å fjerne må triggerfunksjonen settes tilbake til 125-versjonen i en ny migrasjon (aldri redigere 144, checksum-vakt). Gamle rader har `request_params NULL` og kan ikke avstemmes.

**Tester** (som postgres, `timeout -k 5`, maks 2 workers: `pnpm exec vitest run --maxWorkers=2 <filer>`)
- Ca. 165 nye tester: pool 10, avstemming 28+24+12+11, K4 9, derive 25, family-service +4, family-integration +1, DAV 20, freshness 11, no-store 3, health-erstatning 6, og 1 ny hostile-test i `wpg2-home-critical-unit`.
- K5-batch: 230 filer, 3334 tester, 3331 grønne. Baselinene (wph1/wph2, D-420, tool-manifest, env-drift, compose-isolation, schema-invariants/scope-FK, erasure-dekning, d124, connector-registry) er alle grønne. De 3 feilene er kjente sandbox-feil, `wpc3-review1-hardening` F10a/b/c, ikke mine.
- Rød på main: nye derive-tester gir 14 røde mot gammel kode, og de to tunge skalatestene fullførte ikke på 200+ s. Tidligere målt: 20 000 lenkede hendelser tok 3,1 s på main.
- Mutanter: K1 56 (55 drept, 1 ekvivalent kommentar-mutant), K2 11/11, K4 8 (7 drept, 1 ekvivalent: tom-liste-vakt), K3 56/56. Totalt 131, 129 drept, 0 overlevde.
- Ingen full suite kjørt.

**Statiske sjekker**
- `pnpm -r --workspace-concurrency=2 run typecheck`: exit 0.
- `pnpm lint`: exit 0.
- `pnpm check:containment`: exit 0.
- gitleaks `origin/main..HEAD`: `no leaks found`. Funnet underveis var test-sentinelen `SENTINEL_PASSWORD` i `wpg2c-pool-connect-timeout.test.ts` (generic-api-key, commit 924fc6ac, linje 26), en oppdiktet streng. Verdien er byttet, og fingeravtrykket står med begrunnelse i `.gitleaksignore` som tidligere WP-er gjorde.
- Når grenen merges: to-forelder merge beholder hashen. Cherry-pick ville kreve nytt fingeravtrykk.

**Sikkerhetsflater som trenger uavhengig review**
- `apps/api/src/personal-routes.ts:306`: reconcile-rute, eier og step-up, aldri skrive-verktøyet.
- `modules/tool-gateway/src/personal/action-reconcile.ts:81` og `:138`: bevisreglene og terskler (`:51`, `:53`).
- `144_personal_action_reconcile.sql`: triggerfunksjonen (tilstandsmaskin og uforanderlig `request_params`).
- `action-journal.ts:163`: `recordReconcile` med betinget UPDATE og revisjon i samme transaksjon.
- `home-critical.ts:154-164`: `last_changed` i normalisert tilstand. Pinnet nøkkelsett i `wpg2-home-critical-unit.test.ts` er oppdatert (WP-eid test) og ny hostile-test lagt til.
- `modules/core/src/db/pool.ts:65-70`: pool-tidsavbrudd, ikke flagg-styrt.
- `device-service.ts:315` og `device-enrollment-service.ts:172`: låsrekkefølge i identitetslaget.
- `modules/context/src/family/service.ts:254`: invitee-scopet oppslag (autorisasjon og orakel).
- `apps/api/src/personal-dav.ts:36`, `:61`, `:174`: decision-mapping, begrenser og fail-closed.
- `apps/api/src/personal-family-readers.ts:90`: ferskhet. `apps/api/src/server.ts:2082`: `no-store`.
- `modules/context/src/derive.ts:88` og `:117`: trip-id og hjemmested-match.

**Kjente begrensninger**
- DAV-begrenseren er prosess-lokal, som de globale.
- Avstemming ser kun eierens egen journal.
- `failed` forutsetter lite klokkeavvik mot HA.
- Lenke- og kapabilitetstall i runbook følger testene.

**Q-forslag** (runbook-lokale Q-G2-13..17, også til OPEN_QUESTIONS)
- 30 s pool-standard.
- 6 t «nå»-grense og produsentkontrakt.
- DAV-tall 30/60/10.
- HealthKit-kontrakt for appen.
- 60 s/5 min-terskler for `failed`.

**Forslag til ny JARVIS-113-status**
- `PARTIAL`, rest `OPEN`.
- Løst: (b) avstemming, (d) pool-timeout, (e) alle punktene (e/5 delvis: tre HealthKit-punkter DEFERRED som appkontrakt, `json()` globalt uendret) og (j) låsrekkefølge.
- Åpent: (a) step-up-kanalen er klient-påstått (JARVIS-111/WP-S1), (c) tverr-prosess-lås, (f) iCloud-iTIP og vCard mot ekte, (g) 125/126 endret på stedet, (h) 30 s bil-readback, (i) live-verifisering.

**NOT VERIFIED / BLOCKED_EXTERNAL**
- `NOT VERIFIED`: alt mot ekte HA, bil, iCloud og HealthKit. Pool-tidsavbrudd under NAS-last, kappløp mot NAS-Postgres, DAV-grenser og no-store mot ekte server (runbook §10 steg 7–14).
- `BLOCKED_EXTERNAL`: iPhone/Watch-app og bil-leverandør.

**Til lead**
- Regenerer compose etter merge med `node ops/security/generate-compose-env.mjs --write`.
- `.gitleaksignore` er appendet på slutten og kan gi en triviell konflikt.
- Bash med `HOME=/tmp/pg-home` mister git-identiteten. Bruk `HOME=/root` for git.
