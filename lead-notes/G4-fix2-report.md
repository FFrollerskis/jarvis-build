TS: 2026-11-20T00:02:36.960Z
# G4 mikro-fiks-runde: tillegg til rapporten

Alle åtte punkter er lukket eller dokumentert, og alle 60 egne mutanter er drept (0 overlevde). Branchen er ikke publisert: det ene push-forsøket gav 503 («credential service temporarily unavailable»), og jeg har ikke prøvd igjen. Ingen full suite er kjørt, som avtalt.

**Ny HEAD:** `baa2cf80c8cd793d29e0f3bece13b25a0911b327` på `claude/wp-g4-situation-bridges`, arbeidskopien ren. Ikke rebasert, og integrasjonsgrenen er ikke slått inn. Seks commits over `f2c70362`:
- `59b58253` D-MEDIUM-1 + retensjonsmål + wiring-test
- `e65e465a` ruter og revisjonsmerking
- `8646c2fc` erasure per person
- `8c6da242` test av status
- `0f71b549` docs
- `baa2cf80` docs (§17/§18)

17 filer, +855/-60.

## Tabell per punkt

| # | Punkt | Status | Test | Mutasjonsbevis |
|---|---|---|---|---|
| 1 | B D-MEDIUM-1: referert situasjon velter retensjonssveipet | LUKKET | `wpg4-fix-lifecycle` (8 nye) | 20/20 |
| 2 | A D-LOW-1 = B D-LOW-2: `simulate` ukjent situasjon ga 500 | LUKKET | `wpg4-signal-routes` (2 nye) | 6/6 |
| 3 | A D-LOW-2 + B INFO-8: `critical_bypass_set` uten økt, rute-rader uten `task_id` | LUKKET | `wpg4-signal-routes` (1 ny + 2 utvidede), `wpg4-signals-transport` (utvidet) | 8/8 |
| 4 | B D-LOW-3: retensjon kun for rom med påslått kilde | LUKKET | `wpg4-fix-lifecycle` (4 nye), `wpg4-signals-retention-wiring` | 8/8 |
| 5 | B D-LOW-4: N22/N56/N57/N58 | LUKKET | `wpg4-signals-retention-wiring` (7) | 6/6 |
| 6 | A D-INFO-1: `SituationActStaleError` i hopp-over-listen | LUKKET | `wpg4-fix-lifecycle` (1 ny) | 1/1 |
| 7 | B INFO-9: erasure per person | LUKKET | `modules/erasure/test/wpg4-signals-erasure` (4), d395 grønn | 11/11 |
| 8 | Docs: §1, §5 punkt 4, A D-LOW-3/D-LOW-4/D-INFO-2, B INFO-5/INFO-7 | dokumentert | d420 og `wph2-privacy-*` grønne etter endringen | - |

- **Punkt 1:** `retireSignalSituations` sletter ikke en situasjon en beslutning refererer. Beslutningsloggen beholder dermed situasjonen den peker på, og unntaket er dokumentert. Sletting og løsing går i hver sin transaksjon, og begge forsøkes alltid. Løperen teller en feilet opprydding (`retention_failures`, `errors` `purge:<kode>`/`retention:<kode>`), og samme resultat ligger i `status().last` som eier-ruten viser. Loggen har kode og SQLSTATE-årsak, aldri innhold. Andre rom stoppes ikke, og et feilet rom prøves igjen etter én time i stedet for neste døgn. Reviewer Bs akseptansetest (rød på f2c70362) er grønn mot den nye koden. Testene dekker også at en feilet loggopprydding rapporteres som `purge:<kode>` uten å stoppe situasjonsoppryddingen. En skjemavakt låser at beslutningsloggen er den eneste fremmednøkkelen mot `situations` uten kaskade.
- **Punkt 2:** svaret er 404 `not_found` med `reason: situation_not_found`, også for en annen tenants situasjon. En skjemavakt låser at hver feilklasse tjenestene kaster er mappet i ruten. Jeg kontrollerte alle 12 rutene, og dette var den eneste umappede feilklassen.
- **Punkt 3:** `setCriticalQuietBypass` tar en valgfri `context` med økt og oppgave. Ruten merker radene med `task_id` = `situation-signals-api:<handling>`. Testen sjekker at abonnement, tilbakemelding, regeltuning og revisjon bærer person, økt og oppgave.
- **Punkt 4:** ny `retentionTargets` i løperen (kun opprydding, kill switch gjelder). Wiringen setter den til eierens tenant i alle rom en kilde kan bo i (`home`, `health`, `business`). Med hovedbryteren av kjører ingenting, og det er dokumentert (erasure er veien da).
- **Punkt 5:** G2/G3-oppbevaring og `JARVIS_SITUATION_LOG_RETENTION_DAYS` er testet gjennom ekte wiring, løper og sveip. Reviewer Bs egne DW1/DW2 er kjørt som midlertidige kopier mot koden og er grønne, og kopiene er slettet igjen.
- **Punkt 7:** `planPerson` tar signallogg, vurderinger, tilbakemeldinger og abonnementer i alle rom. `situation_rule_tuning` og `situations` er med vilje ikke med (rommets konfigurasjon og avledede kø uten person-kolonne), og begrunnelsen står i `plan.ts` og runbook §4.
- **Punkt 8:** runbook §1 og §5 punkt 4 er rettet, og `home-bridge.ts`-filhodet (kun kommentar) rettet. Nye §5 punkt 11-13 dekker (a), (b) og (c) fra briefen, og §15 dekker (d). Nytt eierspørsmål Q-G4-11 med anbefaling: bindbarhet som egenskap per verktøydefinisjon (default-deny) i stedet for navnerom-vakt, og inntil videre ikke binde slike verktøy til `home`. Runbook §17 og §18 er oppdatert, og UA10 §11.10 og PROCESSING_INVENTORY er rettet.

**Ekvivalente mutanter, analysert men ikke kjørt:**
- `NOT EXISTS` uten tenant-/rom-vilkår: `situation_id` er unik.
- `firstCause ??=` mot `=`: begge årsakene er den samme feilen i testene.
- Retensjonsløkkens `status === "ok"`-vakt: dekket av den indre kill switch-sjekken.
- Tenant-filteret i person-scope-planen: RLS gir det samme.

## Avvik

- **Ny feilstruktur:** `retireSignalSituations` kaster nå `SignalRetentionFailedError` (steg, hva som lyktes, kort kode) etter at begge stegene er forsøkt. Før gikk alt i én transaksjon. Kun løperen kaller den.
- **Feilkoder:** løperens `codeOf` gir `pg_<SQLSTATE>` for databasefeil, der den før ga «error». `SignalTickResult` har et nytt additivt felt `retention_failures`. Ingen eksisterende test brøt.
- **404-koden:** `not_found` med `reason: situation_not_found`, slik at både briefens ordlyd og reviewernes forslag er dekket. Søsterruten bruker `subscription_not_found`.
- **Test-oppsett:** `db.reset()` i `wpg4-db.ts` rydder nå `decision_log`, ellers stopper FK-en reset av situasjoner.
- **Endret testfil utenfor de nye:** `wpg4-signals-transport` har fått én ekstra audit-assertion, og ingen assertion er svekket. De andre berørte testfilene er G4-filer fra før (`wpg4-fix-lifecycle`, `wpg4-signal-routes`) med nye tester.
- **Ingen miljøvariabler:** ingen nye env-variabler eller `process.env`-lesinger, ingen migrasjoner, og shared docs er ikke rørt.
- **Delt kode i `modules/erasure/src/plan.ts`:** den eneste endringen utenfor `modules/situations` og `apps/api`.

## Testtall og kommandoer

Alt kjørt som `postgres` med maks 2 workers, `timeout -k 5` og heap-tak, `--bail=1` på mutanter.
- **G4-settet** (`modules/situations/test`, `apps/api/test/wpg4-`, `wpg4-ha-state-detail`, `modules/health/test`, `modules/vision/test/service-rls` og `wpg4-fix-limit`, og nå hele `modules/erasure/test`): 65 filer, 724 tester grønne (før: 44 filer/612 uten erasure-pakken). G4-egne tester er 367, mot 340 før: lifecycle +13, routes +3, retention-wiring +7, erasure +4.
- **Vaktbatch** (67 filer): 1 113 tester grønne.
- **Inventar-lesere:** `wph2-privacy-doc-reader`, `wph2-control-centers`, `wph2-privacy-center-db` og `d420` (86 tester) kjørt separat etter docs-endringen, grønne.
- **Port:** typecheck over alle pakker, lint og `check:containment` gir exit 0. Hemmelighetsskann `f2c70362..HEAD` (6 commits): ingen funn.
- **Logger:** `/tmp/lead/logs/g4-delta-*.log`, mutantlisten i `/tmp/lead/logs/g4-delta-mutants.txt`, og spesifikasjonene i `g4-delta-genspecs-a.py` og `g4-delta-genspecs-bc.py`.

## En linje per endring for D-466

- Retensjonen sletter ikke en situasjon en beslutning refererer (`decision_log.related_situation_id`); sletting og løsing går i hver sin transaksjon, og feilen kastes etterpå (`SignalRetentionFailedError`).
- En feilet opprydding er synlig i tikkresultatet og loggen (kode og SQLSTATE uten innhold), stopper ikke andre rom og prøves igjen etter én time.
- Oppryddingen dekker alle kilderom så lenge hovedbryteren er på (`retentionTargets`), uavhengig av enkeltkilder; hovedbryteren AV = ingenting kjører, erasure er veien.
- `POST /situations/signals/simulate` med ukjent situasjon gir 404; hver feilklasse rutenes tjenester kaster er mappet.
- Revisjonsraden `situation.critical_bypass_set` og radene fra HTTP-ruten bærer økt og oppgave (`situation-signals-api:<handling>`).
- Person-scope erasure tar signallogg, vurderinger, tilbakemeldinger og abonnementer i alle rom; regeltuning og situasjoner er bevisst ikke med.
- Ærlige begrensninger dokumentert: vakten stenger kun `home-assistant`/`car` (Q-G4-11); haste-regler dempes aldri; `pause_domain` og binding kan feile med `domain_lock_busy` etter 30 s; nattlige kamerahendelser utenfor oppslagsvinduet varsles aldri (Q-G4-8).
