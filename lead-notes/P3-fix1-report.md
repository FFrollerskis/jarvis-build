TS: 2026-11-26T15:11:23.298Z
**Sluttrapport fiks-runde 1, WP-P3**

**Ny tipp:** `ea202c29` på `claude/wp-p3-small-fixes`, pushet, rent tre. Det er 9 nye commits etter `cdf7b46a`, hver pushet etter sin fix. Jeg ble i worktreen, rørte ingen delte docs og ingen `.gitleaksignore`, og la ikke til nye pakker, flagg eller migrasjoner.

**FIX-1, F1: ferdig, rød først.**
- `executor.ts:140` `mayHaveMutated` har fått `|| (begun.row.status === "requested" && prior === null)`.
- Test: `wpd3-write-chain-db.test.ts` blokk V5 (l.1529, 6 tester). Kappløpet er deterministisk uten tidsavhengighet: A holdes foran gatewayen eller inne i leverandørkallet, og B avvises av `class_d_notifier_not_ready` eller `connector_frozen`. Det finnes også en kommando-bundet variant.
- Rød før fiks: 4 av 6, med `growth_write_journal_terminal_status`. Etter fiks er journalen `applied`, taperen `UNKNOWN`, én mutasjon og kommandoen `executed`.
- Reviewerens 35 K2-prober er grønne mot sluttkoden (HEAD 3/3 runder, `main` 2/2 feil).

**FIX-2, F2: ferdig.**
- V6 (l.1652, 5 tester) dreper K2-12, som overlevde før testen (SURVIVED, så KILLED med 4 røde).
- Ny support-test (2 tester) dreper K3-06 (1 rød).
- K1-07 kjørt som F4-M3: drept (4 røde).

**FIX-3, F3: ferdig, rød først.**
- `server.ts:2531-2567`: registeret listes kun når `deps.ownerGate(authed.identity) === true`. Porten er fail-closed og leser registeret ikke for andre. Ellers får kalleren `[]` og `frozen_connectors_readable:false`.
- Øvrig respons er byte-lik eierens (testet). Det er ikke et avslag: 200, ingen revisjonsrad.
- Test: `remediation-2-control-plane-auth.test.ts` H2 (3 nye tester, alle røde først). Testen fikk `apiDeps`, en medlems-person og en eier-port som settes kun i H2.
- Ingen kilde-vakter brutt: ingen `/*` eller `*/` i endringen.

**FIX-4, F4: ferdig, rød først.**
- `meta-ads-write.ts:237-241`: `unreadable = list === null || !Array.isArray(list["data"])`.
- `paging` er fail-lukket også når `paging.next` ikke er en streng eller når `paging` ikke er et objekt. `next: null` regnes som fraværende.
- Test: `wpd3-write-engine.test.ts` «K1-rest» (l.1269, 20 tester). Rød først: 14 røde. De seks formene gir 0 POST.

**FIX-5, F5: ferdig, rød først.**
- `gbp-write.ts:219-228`: en fortsettelsesside må være et objekt med en `localPosts`-liste, ellers `truncated`. En eksplisitt `[]`-liste er lesbar og komplett.
- Tillegg utover ordren: også side 1 er `truncated` hvis den ikke er et objekt (`[]`, `null`, tall, streng). Det kom fra en artefakt i reviewerens probe. Side 1 `{}` er uendret en tom liste.
- Test: «K6-rest» (l.1460, 13 tester). Rød først: 8 røde, så 4 til for side 1.

**FIX-6: ferdig.** Begge punkter i `WPD3_GROWTH_WRITES.md` er rettet (paginering og `growth_write_replay_ledger_unproven`). `WPP3_SMALL_FIXES.md` har advarsel i §9 steg 1, oppdaterte referanser og tall, og ny §9b med kjente begrensninger (F4/F5-rester, INFO-punktene og omvendt kappløp).

**Mutanter.**
- Mine egne kjøringer mot FIX-1/3/4/5: 37, hvorav 36 drept. FIX-1 6/6, FIX-3 8/8, FIX-4 9/9, FIX-5 13/14.
- Den ene overlevende er F5-M7 og er ekvivalent: `asArr(ikke-liste)` er `[]`, så rekkefølgen mot vakten er uten effekt.
- I tillegg K2-12 og K3-06 (begge drept nå). K1-07 er kjørt som F4-M3 (drept).

**Tester og statiske kontroller på tipp `ea202c29`.**
- `modules/growth/test` + `modules/support/test`: 28 filer / 632 tester (46 nye).
- Hele `apps/api/test`: 229 filer / 3417 tester, exit 0. Det dekker `wph1-flag-off-selection-baseline`, `wph2-flag-off-main-parity`, tool-manifest, d398, d420 og wpj-closure-matrix.
- `env-drift` + `wpk-*`: 20 filer / 276 tester grønne.
- Reviewerens prober: K2 35/35, K1/K6 + K3 + K5 39/39. Alle seks fail-åpne K1-former og GBP side 2 (`[]`/tom kropp) er nå `truncated`.
- `pnpm -r --workspace-concurrency=2 run typecheck`, `pnpm lint` og `pnpm check:containment` gir alle exit 0.
- gitleaks `origin/main..HEAD`: 18 commits, no leaks.
- `merge-tree` er ren mot `fin2`, `g1c`, `g3b`, `g4b` og `n1b`.

**Nye antakelser til D-495 (fra nr. 8).**
- **8.** En `requested` journalrad uten ledger-rad eies av et annet kall som kan være i gang. En port-avvisning gir `UNKNOWN` og låser aldri raden `failed`. Atferdsendring: en replay av en krasj-før-gateway-rad som en port avviser gir nå `UNKNOWN` i stedet for terminal `failed`.
- **9.** Kjent begrensning, verifisert i et midlertidig forsøk: omvendt kappløp (skaperen avvises og låser `failed`, duplikatet slipper gjennom etter et portskifte) gir journal `failed`, ledger `succeeded` og én mutasjon. Full løsning krever serialisering per nøkkel.
- **10.** En HTTP 200 uten `data`-liste fra Metas `ads`-kant er uleselig, ikke tom. Uforståelig `paging` regnes som `truncated`.
- **11.** En GBP-fortsettelsesside etter et token må ha en `localPosts`-liste. Tom kropp blir `{}` i `VendorHttp`, så den kan ikke skilles fra `{}`. En legitim tom siste side uten liste kan gi en falsk avvisning. Alt er uverifisert mot Google.
- **12.** `/infra/status` er en eier-flate for det globale frys-registeret.
- **13.** En tom `ticket_id` er et oppslag som ikke finnes.

**NOT VERIFIED.**
- Ingenting er deployet eller kjørt mot NAS-en, og alle leverandørfakta er uverifiserte (Googles `pageToken`/`nextPageToken` og «fraværende token = slutt», Metas `ads`-kant).
- Det omvendte kappløpet er kun sett i et midlertidig forsøk, ikke i en permanent test.
- Konfliktrisiko: `remediation-2-control-plane-auth.test.ts` har fått mer omstrukturering (`apiDeps`, `SUBJECT_M`).

Notater: `/tmp/pg-home/p3-fix1-notes/NOTES.md`.
