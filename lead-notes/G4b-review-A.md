TS: 2026-11-26T06:08:04.706Z
VERDICT: MERGE ETTER FIKSER. 0 HIGH og 2 MEDIUM (én integrasjon mot N1b, én K2-semantikk) pluss 5 LOW. K1–K5 holder mekanisk under mine uavhengige prober.

Worktree er rent (`git status --short` tom, HEAD `c28e2b85`). Den midlertidige N1b-flettingen er avbrutt med `git merge --abort`.

## Funn (rangert; fil:linje mot HEAD)

**MEDIUM-1: G4b + N1b gir rød vakt etter andre merge.**
- Reprodusert med `git merge --no-commit origin/claude/wp-n1b-finance-serving-model` i min worktree.
- 24 N1b-filer kjørt: 23 grønne. `apps/api/test/wpn1b-structure.test.ts` gruppe G feiler (3 tester, 648 av 651 grønne), fordi `apps/api/src/local-model-endpoints.ts:42-44` har 3 leverandør-literaler som ikke står i N1b-listene (22 → 23 filer, 25 → 26).
- `git merge-tree` melder ingen tekstkonflikt, så byggeren oppdaget det ikke.
- Ingen runtime-risiko. Filen tar ingen lokalitetsbeslutning, bare env-mapping.
- Fiks i den grenen som merges sist: legg `"apps/api/src/local-model-endpoints.ts": 3` i `ALLOWED` og `ALLOWED_BARE` i `wpn1b-structure.test.ts`.

**MEDIUM-2: K2-taket (Q-G4-12) er ikke trygt når den brede raden fjernes.**
- Bred rad avslått eller utløpt gir tak. Men et vanlig `clear` av den raden (`service.ts:1681`, brukt av `executive.revoke_autonomy_binding`) gjenoppliver aktive regel- og kategoribindinger uten ny eierhandling.
- Probe `zz-g4b-review-a-k2-db`: bred rad aktiv/avslått/utløpt + aktiv regelrad. Før clear: 0 utførelser for avslått/utløpt. Etter clear: 1 utførelse i alle tre tilfeller.
- Nødventilen «Tilbakekall autonomi» stopper altså ikke smale bindinger. Byggeren har advart i knappeteksten (`authority.ts:283`) og stilt Q-G4-15, men sikkerhetsvirkemidlet gjør ikke det navnet sier.
- Fiks (a): `clearAutonomyPolicy` uten skop gjør `UPDATE enabled=false` på den brede raden i stedet for `DELETE` når smale rader finnes i samme (rom, domene). Taket består da.
- Fiks (b): `revoke_autonomy_binding` deaktiverer også smale rader, med før-bilde.

**LOW-1: K5 sender på nytt etter transportfeil.** `morning-summary.ts:105/123`.
- «Ukjent utfall sendes aldri på nytt» gjelder krasj (`reserved`) og gateway-tidsavbrudd (`unverified`).
- En `ECONNRESET` på klasse B gir ledger `failed` og sendes på nytt neste tikk. Probe: 2 transportkall. Gatewayens `mayDuplicateOnRetry` (`gateway.ts:558`) utelater klasse B bevisst.
- Fire samtidige `deliver` ga `sent,sent,already_sent,already_sent` med 1 transportkall. `morning_summaries` kan dermed over-telle.
- Fiks: dokumenter, eller la telegram-transporten kaste `outcome_unknown:` ved reset/timeout.

**LOW-2: K1-vakten er ikke «fysisk først» for lese-handlinger.** `autonomy-guard.ts:69` og `autonomyActionBlocker`.
- En feilmerket `home-assistant.list_states` eller `car.read_vehicle_state` med `autonomy_bindable` kan bindes og utføres (probe: bind OK, 1–2 utførelser).
- Kun manifest-invarianten stenger den, ved oppstart (`main.ts:1286`, `worker-main.ts:556`).
- Fiks: returner `physical_action_not_bindable` for ethvert verktøy i `PHYSICAL_NAMESPACES` før definisjonssjekken.

**LOW-3: Ukjent handling gir ingen advarsel.**
- `authority.ts:299`: en lagret binding til en uregistrert, ikke-fysisk handling vises som OK. Motoren nekter den likevel.
- `simulation.ts:119`: `bindable: null` for ukjent definisjon gir ingen blokkering.
- Fiks: ukjent definisjon ⇒ WARN i kontrollsenteret og `action_not_bindable` i simuleringen.

**LOW-4: K4 har hull i testing og dekning.**
- `main.ts:860` (live-lokalitet til assist-vakten) og videreføringen i `situation-signals-wiring.ts` er ikke testet. Mutantene M49 og M70 overlevde. Enkelt-testen M71 (assist-opsjonen) ble drept.
- `local-model-endpoints.ts:94`: et navn som ikke løses ved oppstart beholdes lokalt. Samme avveining som G3, men reelt åpent.
- `JARVIS_EMBEDDING_URL` valideres ikke (PARTIAL, dokumentert). `run-rate.ts:15` er en visningskopi av lokalitetsregelen (dokumentert). En demotert `gemma_local` regnes fortsatt til 0 øre.

**LOW-5: `starts_with` i episodesøket er ikke overflødig i produksjon.** `signal-bus.ts:259`.
- Byggeren kalte det ekvivalent og `NOT VERIFIED` utenfor C-kollasjon. Jeg har verifisert det.
- Under `und-x-icu` og `en-US-x-icu` returnerer søket uten `starts_with` også `camera.A`-nøkler for `camera.a`. Med `starts_with` er resultatet riktig under alle testede kollasjoner.
- Koden er riktig. Testen mangler en ICU-variant, så fjerning av filteret oppdages ikke.

**INFO.**
- K1 stenger D-160 de facto for alt unntatt tre handlinger. I et utvalg på 23 klasse D-handlinger uten step-up feller manifestet 18 på effekt. 5 åpnes med én linje og en begrunnelse.
- K3-ankeret er hendelsestid, ikke varseltid. For episoder holdt i stille timer kan to varsler komme nærmere hverandre enn vinduet. Dette er innenfor designet.
- Migrasjon 148 gjør at eldre kode ikke kan upserte bindinger (`ON CONFLICT (tenant, rom, domene)` finnes ikke lenger). Dokumentert i §14.

## Byggerens påstander → dom

| Påstand | Dom | Bevis |
|---|---|---|
| K1: nøyaktig `telegram.notify`, `business.create_followup`, `business.assign_open_loop` er bindbare | BEKREFTET | Sveip over 489 produksjonsdefinisjoner mot ekte motor og Postgres: kun disse 3 bundet, 482 `action_not_bindable`, 4 `physical`. Kildeskanning gir 3 tilordninger. |
| K1: avvist ved bind-tid, utførelse og simulering; lagret binding feiler lukket | BEKREFTET | 486 direkteskrevne bindinger: 0 gateway-kall, 0 claim, 0 ledger-rader, rad ikke slettet, `blocked_code` satt. 23 alias-, case- og whitespace-varianter: 0 kall. Definisjon som mister erklæringen: 0 kall, utføres igjen når den kommer tilbake. |
| K1: manifest-invarianter | BEKREFTET | Mutérte produksjonsdefinisjoner: fysisk navnerom (alle handlinger), pay/control/delete, step-up og 13 ugyldige former feller alle. Ren manifest passerer. |
| K1: fysisk-først | DELVIS | Gjelder alle handlinger unntatt tillatte lese-handlinger (LOW-2). |
| K2: migrasjon 148 | BEKREFTET | 147 migrasjoner + 5 eldre rader → 148: kun 148 anvendt, ingen rad tapt, alle `scope_key='*'`, PK med 4 kolonner. RLS/FORCE og RESTRICTIVE-policy uendret. CHECK: 27 ugyldige avvist, 14 regler og 9 kategorier passerer. |
| K2: presedens og tak | BEKREFTET | 64 radtilstander × 4 situasjonstyper = 256 DB-scenarier mot et uavhengig orakel: 0 avvik, 55 utførelser. Kryss-regel-claim gir BindingChanged. 3 samtidige tikk gir 1 utførelse. Rom- og tenantisolasjon OK. |
| K2: «uten bred rad finnes ikke tak» er trygt | FEIL | MEDIUM-2. |
| K3: glidende vindu | BEKREFTET | 40 tilfeldige sekvenser og 398 hendelser (2 kameraer × 3 typer, batcher i tilfeldig rekkefølge, kantverdier ±1 ms og ±1 s) gir nøyaktig referansemodellens ankere. Haste har fast bøtte. Tenantisolasjon OK. 3 samtidige tikk gir 1 episode. Plan: Index Only Scan, 0,9 ms per publish med 4000 rader. |
| K4: vakt flyttet uendret | BEKREFTET | Diff lest: ren flytting. |
| K4: adressevakt | BEKREFTET | 97 uavhengige grensetilfeller: RFC1918 og 172.15/172.32, 100.64/10 med og uten flagg, 169.254, 0.0.0.0, IPv6, desimal/hex/oktal, `localhost.evil.com`, brukerinfo, trailing dot. Alle som forventet; mapped-IPv6 avvises fail-lukket. |
| K4: demotering og N1b-samspill | BEKREFTET | 4/4 integrasjonsprober: offentlig `ollama`-URL gir 0 kall i finanslåsen, `gemma_local` og `local_llm` uendret, gateway bygget før demotering ser den per kall, flagg AV uendret. Alle øvrige N1b-tester grønne i flettet tre. Kun MEDIUM-1 feiler. |
| K4: ingen fjerde kopi | DELVIS | `run-rate.ts:15` er en visningskopi. Dokumentert. |
| K5: idempotens, telling, konstant tekst | BEKREFTET | 15 prober: grenser `[start,slutt)`, domene/stadium/prioritet/status/tenant/rom teller ikke, tekst uten tall. Pause og kill switch gir ingen ledger-rad og prøves igjen. `reserved`/`unverified`/`succeeded` gir `already_sent`, `failed` prøves igjen. Etterfylling akkurat 12 t sender, +1 ms gjør det ikke. |
| K5: «ukjent utfall aldri på nytt» | DELVIS | LOW-1. |
| K6: flagg AV = main | DELVIS | Guards (9 filer / 128 tester) grønne. `modules/situations/test`: 34 filer / 557 grønne. `apps/api` wpg4*, wph0, wph2 og relaterte: 19 / 256 grønne. `modules/model-gateway/test`: 55 / 1086 grønne. De 15 endrede testene gjennomgått: kun fiksturbytte, lookup-injeksjon og omskrivinger som følger av K1 og K3. Ingen assertion svekket, ingen `.skip` eller `.only`. Avvikene jeg fant er nøyaktig de listede i 19.6. Ikke gjort: full kjøring av en main-kopi. |
| K7: PROCESSING_INVENTORY | DELVIS | D-420-guard grønn og raden lest; ikke min vinkel. |

## Mutasjoner
74 egne eksakte mutanter ble kjørt med byggerens relevante tester og `--bail=1`. 68 ble drept og 6 overlevde. Byggeren hadde 64, hvorav 63 ble drept. Alle 74 ble gjenopprettet med `git checkout` etter hver kjøring.

| Overlevende | Vurdering |
|---|---|
| M30: `autoActPending` sjekker ikke lenger at tool/action er uendret | Redundant lag. Claim-fingerprinten i `actOn` stopper uansett. Ingen sikkerhetspåvirkning. Pre-eksisterende G4-linje. |
| M34: `starts_with` fjernet | Ikke ekvivalent i produksjon (LOW-5). Test-hull. |
| M49 og M70: live-lokalitet til assist-vakten ikke koblet | Test-hull (LOW-4). Router og demotering dekker øvrige veier. |
| M58: `opened_at < $4` → `<=` | Test-hull på eksakt grense. Min probe «at-end» dreper den. |
| M62: `stage IN ('remember','inform')` | I praksis ekvivalent: `inform` gir alltid `last_notified_at`. |

## Ikke verifisert av meg
- Ekte NAS, Home Assistant, kamera, lokal modell, Telegram og tailnet-DNS. Ingenting kjørt mot ekte nett.
- Postgres med glibc `en_US`-kollasjon. Sandkassen har kun C, POSIX og ICU. ICU er testet (und, en-US).
- Full suite, `typecheck`, `lint`, `check:containment` og gitleaks (lead kjører disse).
- `modules/tool-gateway/test` og de fleste `modules/core`-filer. Kun guardene er kjørt.
- Differensial mot en kjørende main-kopi. K6 er dekket av guards, gjennomlesing av alle endrede produksjonsfiler og de 15 endrede testene.
- Høy belastning på maskinen (load 5–6) kan ha påvirket tidsmålinger. Ingen test var tidsavhengig.

## Probe-mappe
`/tmp/lead/G4b-review-A-probes/`
- Prober: `zz-g4b-review-a-{k1-db, k2-db, k3-db, k4, k5-db, mig148, manifest, n1b-integ, collate2}.test.ts`.
- Mutanter: `mutants.py` og `mutants2.py` (M01–M75, M24 utelatt) med `mutate.py` og resultater i `mutant-results.tsv`, `mutant-run.log` og `mutant-run2.log`.
- Notater: `NOTES.md`.
- Kjørescripts: `run.sh` og `run-nobail.sh`.
