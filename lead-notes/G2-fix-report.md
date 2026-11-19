TS: 2026-11-19T12:59:11.641Z
WP-G2 fiks-runde er ferdig lokalt, men ikke pushet.

**Ny HEAD: `c7c57a6c2fbe93a91e0d48562152adf177356416`** (gren `claude/wp-g2-personal`, 12 commits over d91d2197, base b2d43703 uendret, 46 filer).

**Push:** ett forsøk ga 503 («credential service temporarily unavailable»), samme som første leveranse.

Nummerering er som i din melding. «Rød» betyr at den nye testen feller gammel kode (git checkout HEAD av filen).

**Per funn**

| Funn | Status | Test og mutasjonsbevis |
|---|---|---|
| A-M1 | LUKKET | wpg2-review-a-home-settle (9): 7 røde |
| A-M2 | LUKKET | wpg2-review-a-car (9) og kontraktskit: 8 røde |
| B-M1 | LUKKET | wpg2-apple-dav (23) og -routes (16): uten vakten 5 røde |
| B-M2 | LUKKET | review-b-intake-timestamps (14, DB): 13 røde |
| B-M3 | LUKKET | uten If-Match på PUT: 1 rød |
| A-L4, A-L5, A-L7, A-L11 | LUKKET | wpg2-review-a-executor (15, DB): 10 røde |
| A-L6, A-L12 | LUKKET | dekket av testene til A-M1 og A-M2 |
| A-L8 | DEFERRED | `p1a_outcome_reconcile` i status.ts, runbook §2.7 og migrasjon 125; wpg2-status låser id-en |
| A-L9 | LUKKET | wpg2-autonomy-step-up (5, DB): 2 røde |
| A-L10 | DOKUMENTERT | runbook §2.7 og §9 |
| Ordlyd | LUKKET | status.ts og runbook §0, §8, §9 |
| B-L1/2/3/7/8 | LUKKET | wpg2-review-b-dav (14) og 2 rutetester: 16 av 16 røde |
| B-L4 | DELVIS i form, LUKKET i effekt | review-b-family (9, DB): 8 røde |
| B-L5, B-L6 | LUKKET | review-b-family, samme fil |
| B-L9 | LUKKET | docs |
| A-M3 | ÅPEN, som avtalt | presisert i runbook §0, §9, §12 og DPIA §9 |

- **A-M1:** HA-venting venter nå til matched, eller (endret fra før-tilstand og settlet), eller fristen. Fristen er per domene, alarm 90 s (`JARVIS_PERSONAL_HOME_SETTLE_BY_DOMAIN`).
- **A-M2:** bil-readback krever `observed_at` ≥ akseptert − 30 s og riktig `vehicle_id`.
- **B-M1:** kill switch og credential-revokering sjekkes før hver DAV-utsendelse (rute 503 `dav_blocked` og transport). Uten stoppkontroller registreres ikke DAV.
- **B-M2:** tidsstempel valideres strengt før transaksjonen. Ett ugyldig gir 400 `invalid_timestamps` med indekser.
- **B-M3:** If-Match på PUT og DELETE er bevist med en test der en annen klient endrer ressursen midt i.
- **A-L4, A-L5, A-L7, A-L11:** dobbeltsending gir lagret utfall eller 409 `target_busy`, aldri DB-unntak. Journalens proveniens er uforanderlig, `notified`/`notify_error` lagres som faste koder, og det er advisory-lås per (tenant, domene, mål).
- **A-L6, A-L12:** lukket tilstandsliste per domene (ukjent blir `unknown`), og bil-adapteren får gatewayens nøkkel.
- **A-L8:** ikke bygget.
- **A-L9:** `set_autonomy_policy` avviser binding til `critical_*`/`car.*` ved bind-tid.
- **A-L10:** retning er per handling, ikke per mål.
- **Ordlyd:** sesjonskontinuitet er PASS som server-primitiv og PARTIAL ende-til-ende. Sveipens identitet er `api`/`active`, ikke `system`.
- **B-L1/2/3/7/8:**
  - vCard-grupper vises og erstattes.
  - Datoer valideres strengt.
  - Multistatus-parsing er lineær (12,8 s ned til under 1 s).
  - Hendelser med deltakere krever `allow_attendee_notification`, ellers 409.
  - Samlings-URL-vernet er et tastefeilvern: `localhost.`, `*.localhost`, `*.internal`, jokertegn-DNS og innebygd IPv4 avvises, `.local` er tillatt.
- **B-L4:** `removeMember` og `leave` tilbakekaller personens enheter og grants i sirkel-tenanten i samme transaksjon (permanent nøkkel). `person_tenants`-raden står igjen.
- **B-L5, B-L6:** grants er idempotente under samtidighet (deterministisk kappløp i testen), og avhuking av listepost revideres.
- **B-L9:** DAV-lesing krever eier-grant, kun mutasjon krever signert økt. Rettet i DPIA §9 og inventaret.
- **A-M3:** «tale/Telegram/klokke kan ikke åpne dør» gjelder bare ærlige klienter. Du fører ledger-posten (Q-G2-12).
- **Ekstra:** INFO-1 (`readShared` sjekker subjektets rolle for helse) og INFO-4 (migrasjon 126-kommentar) er lukket. Review A INFO 13–16 og review B INFO-2, 3, 5 er ikke gjort.

**Avvik**
1. B-L4: `person_tenants` slettes ikke fordi historikk-FK-er hindrer det; enhetsrevokering gir samme tilgangseffekt.
2. A-L8 er ikke bygget (DEFERRED).
3. B-L7 er løst med eier-flagg, ikke DEFER.
4. Migrasjon 125 og 126 er rettet på stedet (ureleaset).
5. Under ekte samtidighet får A-L4-taperen 409 `target_busy` i stedet for lagret utfall. Lagret utfall kommer når vinneren er ferdig.
6. Eksisterende tester er justert til ny oppførsel: home-critical-unit, car-unit, personal-routes, health intake og apple-dav-routes.
7. Full suite #1 (52c81764) fant én reell feil: kildevakten i `wpg2-personal-routes` forventet gammel tekst i main.ts etter B-M1. Rettet i c7c57a6c. Vakten er strammet og er rød uten `controls` i main.ts, grønn 17/17.
8. Scratchpad er delt med WP-G3-bygger. `commit-fix-7.txt` ble overskrevet etter bruk, commit uskadd. Jeg bruker egne `g2fix-*`-filer siden.

**Testtall og kommandoer**
- `pnpm -r --workspace-concurrency=2 run typecheck`, `pnpm lint` og `pnpm check:containment`: alle exit 0.
- gitleaks d91d2197..HEAD: 12 commits, ingen funn.
- Vaktbatch #1: 3 røde, kun F10a/b/c. Vaktbatch #2 (213 filer, 3180 tester): F10a/b/c pluss `e1-postgres-ops-tools` «idempotens». Den siste er en lastflake, grønn 3 av 3 isolert og grønn i vaktbatch #1 og full suite #1 og #2.
- Full suite #1 (52c81764): 897 filer, 893 grønne, 15374 tester, 15368 grønne. 6 røde: de 5 kjente og den ene reelle (rettet).
- **Full suite #2 (endelig, c7c57a6c): 897 filer, 894 grønne; 15374 tester, 15369 grønne.** De 5 røde er de kjente sandkasse-feilene: wpc3-review1-hardening F10a/b/c, break-glass-guard og nas-ua0-gate «friskt system».
- Kommando: `flock /tmp/fullsuite.lock pnpm exec vitest run --maxWorkers=2 --exclude '**/embedded-postgres-ipv4-contention*'` som postgres med HOME=/tmp/pg-home. Log `/tmp/lead/logs/g2-fix-full-suite.log`; run 1 er bevart som `g2-fix-full-suite-run1-52c81764.log`.
- Nye G2-tester: home-settle 9, car 9, executor 15, autonomy 5, review-b-dav 14, intake-timestamps 14, review-b-family 9.

**D-464, bare endringer**
- **P1a:**
  - Venting er matched, eller (endret fra før-tilstand og settlet), eller frist per domene (alarm 90 s).
  - Lukket tilstandsliste.
  - Serialisering per mål med 409.
  - Uforanderlig proveniens.
  - `notified`/`notify_error` lagres.
  - `outcome_unknown` avstemmes ikke (DEFERRED).
  - Retning er per handling.
- **P1b:** readback krever `observed_at` ≥ akseptert − 30 s og riktig `vehicle_id`.
- **P1c:** fjerning og forlating tilbakekaller enheter og grants. Grants er idempotente. Avhuking revideres. Helsedeling sjekker subjektets rolle ved lesing.
- **P1d:** ugyldig `observed_at` avviser hele batchen med 400.
- **P2e:** egen stoppvakt, deltaker-flagg, vCard-grupper, strenge datoer og lineær parsing. URL-vernet er et tastefeilvern.
- **Autonomi:** umulige bindinger avvises ved bind-tid.
- **Status:** p1a er PARTIAL, `p1a_outcome_reconcile` er DEFERRED, sesjonskontinuitet er PARTIAL ende-til-ende. A-M3 er ÅPEN oppstrøms.

**Nye eierspørsmål (runbook §12)**
- **Q-G2-8:** permanent enhetsrevokering ved fjerning. Anbefaling: ja, pluss innrulleringsprosedyre (CLI) for re-invitasjon med ny nøkkel.
- **Q-G2-9:** DAV-endring av hendelser med deltakere. Anbefaling: behold flagget og verifiser iTIP mot en test-Apple-ID.
- **Q-G2-10:** `reconcile`-rute for `outcome_unknown`. Anbefaling: ja, i neste pakke, aldri automatisk retry.
- **Q-G2-11:** alarmens faktiske utgangsforsinkelse. Anbefaling: mål på panelet og sett per domene.
- **Q-G2-12:** A-M3, server-side kanal-autoritet før fysiske handlinger i live bruk. Anbefaling: ja.
