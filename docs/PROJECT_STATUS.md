# PROJECT STATUS

**Oppdatert:** 2026-09-06 (branch `claude/d124-windows-db-migration-encoding`, base
`main=4a3c15d4ba72f6dd4b5829acc7e3648be9344fd3`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her.

## Aktiv fase/oppgave

**D-124 - Windows-trygg migrasjonsencoding: `040_stripe.sql` reparert og regresjonsvaktet.**
Derivert, ikke fritt valgt. Dette er IKKE en ny masterplan-slice, men reparasjonen av en
PRE-EKSISTERENDE blocker som D-121 registrerte som «separat, IKKE-relatert funn (bevisst IKKE rettet
i den sliceen)», og som D-123 måtte rapportere som årsaken til at 14 av sliceens egne RLS-tester
ALDRI kunne kjøres lokalt. Oppgaven er 100% leverandør-uavhengig og var derfor den dependency-korrekte
neste. Full begrunnelse: D-124 i DECISIONS_AND_ASSUMPTIONS.md.

## Hva som faktisk var galt på `main@4a3c15d`

`modules/core/src/db/migrations/040_stripe.sql:55` inneholdt tegnet `Ē` (U+0112) i en SQL-KOMMENTAR
(`kun ĒN tenant faktisk er konfigurert` - en mojibake av `ÉN`).

Filen var gyldig UTF-8, så INGEN eksisterende port fanget den: `tsc` og `eslint` leser ikke `.sql`,
og Linux-CI initialiserer klyngen som UTF8 der tegnet er uskadelig. På Tobias sin Windows-host
initialiserer `embedded-postgres` derimot klyngen med `server_encoding=WIN1252`, og U+0112 har INGEN
WIN1252-ekvivalent:

```
ERROR: character with byte sequence 0xc4 0x92 in encoding "UTF8" has no equivalent in encoding "WIN1252"
Migrasjon 040_stripe.sql feilet: ...
```

Fordi `runMigrations()` kjører filene i rekkefølge FØR noen test kjører, feilet **ENHVER DB-suite på
hosten ved migrasjon 040** - også suiter uten noe forhold til Stripe. Reprodusert på rent tre FØR
endring: `modules/core/test/fase8-device.test.ts` → 5 tester skippet, 0 kjørt.

## Hva som faktisk ble bygget

**NULL nye tabeller, NULL nye migrasjoner, NULL nye kolonner, NULL nye leverandører, NULL nye
credentials/scopes, NULL nye produktkapabiliteter, NULL urelatert refactor.**

1. **Reparasjonen** - `Ē` → ASCII `EN`, KUN i kommentaren. Diffen er **én linje**; eksekverbar SQL,
   skjema, RLS, GRANT, indekser og tabellsemantikk er bit-for-bit uendret. Ingen ny migrasjonsfil ble
   lagt til for å «rette» den gamle: `040_stripe.sql` er aldri kjørt i noen produksjonsdatabase, så
   in-place kommentarretting etterlater ingen drift mellom kilde og anvendt skjema, og
   `schema_migrations` bruker filnavn som nøkkel.
2. **Regresjonsvakten** (`modules/core/test/d124-migration-encoding.test.ts`) - policyen er «hvert
   tegn i en migrasjons-`.sql` må kunne representeres i WIN1252». Repertoaret utledes fra
   `TextDecoder("windows-1252")` over 0x00-0xFF framfor fra en håndskrevet liste, minus de fem bytene
   som er UDEFINERTE i WIN1252 (0x81/0x8D/0x8F/0x90/0x9D).
   **Dette er ingen ASCII-vakt:** `ø`, `å`, `æ`, `Ø`, `Å`, `Æ`, `É`, `§`, `«»` ligger alle i WIN1252
   og passerer uendret, så historiske norske kommentarer skrives IKKE om. Vakten dekker KUN
   migrasjons-SQL - nøyaktig de filene som sendes ordrett til en server som kan være
   WIN1252-initialisert; docs og TypeScript berøres ikke, fordi de aldri går gjennom en
   database-encoding-konvertering. Hver fil valideres også som streng UTF-8 (`fatal: true`), fordi
   `runMigrations()` leser med `"utf8"`.
   Vakten **beviser seg selv framfor å passere vakuøst**: egne tester på at den faktisk flagger
   U+0112 med linje/kolonne/kodepunkt, at den finner brudd på andre linjer enn første, at den flagger
   andre smugtegn (U+0100, U+0435 kyrillisk homoglyf, U+4E2D, U+1F600, U+202F - merk at U+00A0 IKKE
   er brudd), at norske tegn IKKE flagges, og at fillisten ikke er tom.

## Kvalitetsporter

- **Reproduksjon FØR fiks:** `fase8-device.test.ts` feilet på `Migrasjon 040_stripe.sql feilet: …`
  (5 skippet, 0 kjørt). Feilen er altså bevist, ikke antatt.
- **Full migrasjonskjede mot ekte embedded Postgres på denne Windows-hosten:**
  `server_encoding=WIN1252`, `datcollate/datctype=English_American Samoa.1252`,
  **46/46 migrasjoner anvendt** (`001_identity.sql` → `046_conversation_graph.sql`, inkl.
  `040_stripe.sql`), 46 rader i `schema_migrations`, 100 tabeller i `public`, andre kjøring anvendte
  **0** (idempotens bevart). Bevisskriptet ble kjørt UTENFOR repoet (scratch-disiplin).
- **Tidligere blokkerte suiter kjører nå faktisk: 25/25 grønt** -
  `modules/core/test/fase8-device.test.ts` · `modules/core/test/d123-voice-session-authority.test.ts`
  (D-123 sine 14 RLS-tester, som ALDRI hadde kjørt lokalt før) ·
  `apps/voice-gateway/test/voice-e2e.test.ts`.
- **Regresjonsvakten:** 52/52 grønt (46 migrasjonsfiler + 6 vakt-egentester).
- `pnpm -r typecheck`: **21/21 pakker rent.**
- `pnpm lint` (`eslint .`): **rent.**
- **Full lokal regresjonssuite:** se `CLAUDE_REPORT` på issue #68 for eksakt fil-/testtelling på
  endelig HEAD.
- gitleaks: egen CI-jobb over hele historikken - **IKKE kjørt lokalt** (binæren finnes ikke på denne
  hosten).
- **CI på eksakt endelig HEAD:** denne filen navngir BEVISST ingen run-id (enhver commit som skriver
  run-id-en hit endrer selv HEAD og gjør påstanden umiddelbart usann). Run-id + status for
  `build-test`, `windows-git-auth` og `gitleaks` rapporteres i `CLAUDE_REPORT` på GitHub-issue **#68**.

## Flagg-status

`WINDOWS_MIGRATION_ENCODING_SAFE=true`, `MIGRATION_ENCODING_GUARD_ENFORCED=true`,
`LOCAL_DB_SUITES_RUNNABLE_ON_WINDOWS_HOST=true` (**endret fra `false`**), `NEW_TABLES_ADDED=0`,
`NEW_PROVIDERS_ADDED=0`, `HOST_ACCEPTANCE_REQUIRED=false`, `HARD_EXTERNAL_BLOCKER=false`.

**INGEN sannhetsflagg er flippet av denne oppgaven.** Uendret og fortsatt åpent:
`Q32_POINT1=OPEN_EXTERNAL_OWNER_ACTION`, `UA7_ACCEPTANCE_4=PARTIAL`, `UA7_COMPLETE=false`,
`D108_COMPLETE=false`, `UA6_COMPLETE=false`, `UA7_MEETING_TRANSCRIPTION=DEFERRED_WITHIN_PHASE`,
`UA7_SPEECH_EXTERNAL_PROCESSING=DENIED_PENDING_Q32_POINT1`. Denne oppgaven rørte hverken credentials,
leverandør-verifisering, juridisk vurdering eller D-108, og gjør **ingen UA-7-påstand sannere enn
før**. Det eneste som er endret er at UA-7-arbeidet nå er lokalt verifiserbart på Tobias sin egen
host framfor å måtte utsettes til Linux-CI. UA-7-akseptansekriterier uendret: **1 PASS** (D-121),
**2 PASS**, **3 PASS**, **4 PARTIAL**. **Q-32 er FORTSATT ÅPEN** (punkt 1 og 3).

## PR-status

Draft-PR på branch `claude/d124-windows-db-migration-encoding` mot `main`. **IKKE merget, IKKE
self-approved** (`ARCHITECT_MERGE_APPROVED=false` i byggeordren). Fersk CI på eksakt endelig HEAD
kjøres etter push og rapporteres med run-id og jobbstatus i `CLAUDE_REPORT` på issue #68. Venter på
uavhengig ChatGPT-arkitekt-review (D-120).

## Blokkeringer

Ingen tekniske. `HARD_EXTERNAL_BLOCKER=false`.

Uendret fra før, og IKKE berørt av denne oppgaven: **Q-32 punkt (1)** krever en eier-/juridisk
handling fra Tobias (kontroll av OpenAI som databehandler for tale - region, databehandleravtale,
treningsvilkår, retensjon - og utfylling av radene i `PROCESSOR_REGION_MATRIX.md`); dette er den
eneste gjenstående avhengigheten for `UA7_ACCEPTANCE_4`, og kode kan ikke lukke den. **Q-32 punkt
(3)** krever at Tobias installerer whisper.cpp/piper-binærer på hosten før `health`-tale blir reelt
tilgjengelig. Tobias har eksplisitt sekvensert alle credentials, leverandør-live-verifisering,
juridisk/kontraktsverifisering og D-108-arbeid til den avsluttende integrasjons-/deploy-fasen.

## Neste oppgave

Avventer uavhengig arkitekt-review av denne PR-en. INGEN merge, INGEN neste slice, INGEN D-108,
INGEN UA-8 startet av denne runden. Naturlig kandidat etter review er den som sto oppført før denne
oppgaven: Telegram inngående som samtalekanal - det eneste gjenstående
`NOT_STARTED_PROVIDER_INDEPENDENT`-elementet, med det dokumenterte forbeholdet om manglende
deterministisk koblingsnøkkel i IMPLEMENTATION_PLAN sin D-122-matrise. Q-32 punkt 1 og 3 forblir
eier-/host-handlinger Tobias må gjøre selv.
