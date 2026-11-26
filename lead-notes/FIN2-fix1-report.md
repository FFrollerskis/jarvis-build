TS: 2026-11-26T09:56:42.611Z
**Sluttrapport WP-FIN2 fiks-runde 1 (avslutter)**

Ingen `CORE_DEPENDENCY_DECISION_REQUIRED` eller `HARD_EXTERNAL_BLOCKER`. Alt er `NOT VERIFIED` mot ekte leverandør.

**Tipp og push:** `766ac671`, pushet (lokal HEAD = origin, `git status` ren). 16 commits siden `61f68c51`: 8 fra forrige bygger og 8 fra meg (`ecd0c086`, `420919d9`, `6272cbd7`, `1bf4e9bb`, `7f797d87`, `d6190400`, `be338245`, `766ac671`). Delte docs og `.gitleaksignore` er urørt.

**Rekonstruert status:** forrige bygger hadde gjort all kode og de fleste tester for FIX-1/2/4–11. Den uncommittede endringen var en docs-linje (§11.5), nå committet.

**Per FIX (alle ferdige; ingen DEFERRED i FIX-listen)**
- **FIX-1 ferdig.** `wallester-transport.ts:310` (`mapCard(…, lifecycleOf)`) og `:388-405`; `card-service.ts:409-418`.
  - Tom eller ufullstendig 2xx gir lokal måltilstand med `provider_state='unconfirmed'` og hendelse `confirmed:false`. Jeg la ikke på flagg: `sync_card_state` og nattsveipet bekrefter eller korrigerer.
  - Tester: `fin2-wallester-lifecycle-ack` (35; A W1-W4, B-K8-4) og FIX-1-blokken i `fin2-minimal-response-contract`. 28 av 35 er røde mot `61f68c51`-kilden.
- **FIX-2 ferdig.** `provider-response.ts:157` `acknowledgedFrom`; `vipps-transport.ts:286` og `:325-355`; `stripe-transport.ts:217`; `service.ts:701`.
  - `createPayment` krever kun `reference`; `state` og `amount` lagres NULL hvis de mangler. Ekte feil (ikke-JSON, liste, feil `reference`) er fortsatt `outcome_unknown`.
  - Tester: `fin2-vipps-ack-and-locks` (28) og `fin2-minimal-response-contract` (219).
- **FIX-3 ferdig (docs).** Runbook §4, §11.3 C og Q-K5b rettet og utvidet; «må besluttes før Vipps aktiveres» står i teksten.
- **FIX-4 ferdig.** `service.ts:2476-2483`. A `regress`-proben viser at `cancelVippsPayment` uten credentials er lik `main` igjen.
- **FIX-5 ferdig.** `neonomics-transport.ts:364`, `banking-service.ts:346-385`, nytt flagg `BANK_TRANSACTION_STATUS_UNKNOWN`. Ukjent status gir karantene: `pending`, aldri bokført eller avstemt, selv-korrigerende.
  - Tester: `neonomics-service` blokk I (5 tester, 5 av 5 røde mot gammel kilde) og ny attention-test i `modules/business/test/fin2-card-submit-attention.test.ts`.
- **FIX-6 ferdig.**
  - «undefined», «null» og «NaN» avvises som id, status og valuta (`provider-response.ts:53`).
  - Fiken-lesere validerer liste og positiv heltalls-id (`fiken-transport.ts:243`).
  - Neonomics `listAccounts` validerer `^[A-Z]{3}$` (`neonomics-transport.ts:335`).
  - Wallester-listenøkler og `?? "NOK"` (PARTIAL) er dokumentert i §11.1.
- **FIX-7 ferdig.** `service.ts:2004`; hendelsen skrives én gang per (intensjon, årsak).
- **FIX-8 ferdig.** `open-loop-service.ts:976`; admin-SQL A.1 har alderspredikat. A.1 er kjørt mot migrert Postgres.
- **FIX-9 ferdig (valgfri, gjort).** `service.ts:2347` `FOR SHARE` før capture-låsen. B sitt stress mot HEAD gir 0 av 60 runder med `cancelled` + oppgjort capture (før 10-18 av 60), og ingen deadlock.
- **FIX-10 ferdig.** M19 og M01 er assertert, M04 er pinnet, vakten har `listContacts`/`listBankAccounts` og `fetch` som referanse. At vakten er navnebasert står i §11.2.
- **FIX-11 ferdig.** `call-signal.ts:33` rettet. Testtall i §0/§11.6 oppdatert. Klasse C-svelging og A I-4 står som kjent atferd.

**Utover ordren**
- Fikstur-tokens er sammensatt i resten av FIN2-testene (8 filer).
- Ny attention-test for bank-karantene.
- Ny lås-modus-test for `FOR SHARE`.
- Fiken-id-kanttilfeller (0, «0», 1e21, siffer-streng).
- Ny test for at avviksveipen ikke fjerner karantene-flagget.
- §11.6 har bevisavsnitt og §11.1 restpunkt 6.

**Rød-først:** mot kilden fra `61f68c51` feiler 275 av 896 tester i ni filer. Resten er festetester som er grønne før og etter.

**Mutanter:** 64 totalt (FIX-1 8, FIX-2 18, FIX-4 3, FIX-5 9, FIX-6 9, FIX-7 3, FIX-8 5, FIX-9 3, FIX-10 6).
- 61 drept første gang, 3 overlevde: F6-7 (`expectNumericId` godtok 0), F9-3 (`FOR UPDATE` i stedet for `FOR SHARE`), F5-9 (avviksveipen fjernet karantene-flagget). Alle tre er drept etter nye tester; 0 overlevende.
- Reviewernes overlevende er drept: A M01, M19, M56, M57 og B M04, M56. Ekvivalente er urørt: A M28, M47 og B M07, M15, M26, M37.

**Statiske kontroller:** `pnpm -r --workspace-concurrency=2 run typecheck`, `pnpm lint` og `pnpm check:containment` ga alle exit 0. Gitleaks over `origin/main..HEAD`: `no leaks found`.

**Tester** (som `postgres`, 2 arbeidere, `timeout -k 5`):

| Sett | Filer | Tester |
|---|---|---|
| `modules/finance/test` + business `fin2-card-submit-attention` + docs-vaktene (`d398-doc-banners`, `wpj-closure-matrix`) | 53 | 1629 |
| tool-gateway `wpk-/wpf1-/d392-/part3-/fin2-` | 23 | 365 |
| erasure/business/api `wpf1-` + `open-loop` + business `fin2-` | 14 | 140 |
| guarder (`wph1`, `wph2`, tool-manifest, env-drift, d420, connector-sdk, comms-manifest) | 19 | 456 |

**Reviewernes prober mot HEAD** (kopiert midlertidig, slettet etterpå)

| Probe | Resultat |
|---|---|
| A db | 78 av 80 |
| A k7 | 97 av 124 |
| B fuzz | 19 av 25 |
| B money | 10 av 12 |
| A k2 | 37 av 37 |
| A k3 | 8 av 8 |
| B abort | 3 av 3 |
| A guard | 53 grønne |

- Alle 37 røde er tilsiktede forskjeller. Ti av dem (A db 2, B money 2, A regress 1, A k7-wallester-kropp 3 og to til) viser at fiksene virker. De øvrige er A/B sine antakelser om gammel overstrenghet (FIX-1/2/5).
- B fuzz: «undefined» står nå bare igjen i frie tekstfelt, ikke i id, status eller valuta.
- A `lawful` mot `main`: Wallester er lik bortsett fra `unconfirmed` mot `unknown`. Neonomics ukjent status er karantene i stedet for `main` sin stille `booked`.
- `lawful` viser også at A sin Vipps-fake (vilkårlig `REF2`) nå avvises. Se antakelse 10.

**Nye antakelser til D-483 (fra nr. 8)**
8. Valider det koden bruker; ubrukte felt kun hvis til stede. Capture/cancel/refund bekreftes av en 2xx med JSON-objekt; tom, ikke-JSON eller liste er `outcome_unknown`.
9. Wallester livssyklus: gyldig 2xx uten status anvender måltilstanden med `provider_state='unconfirmed'`, `confirmed:false` og ingen flagg.
10. Vipps `createPayment`: `reference` må være lik den forespurte, ellers `reference_mismatch` (bevisst strengere enn `main`; vern mot at en annen betaling blir `provider_ref`). `state` og `amount` er NULL til første webhook eller oppfriskning; `provider_status_updated_at` er NULL.
11. Neonomics ukjent status er karantene (se FIX-5). Avviksveipen eier ikke flagget.
12. Sentinel-strenger er aldri id, status eller valuta. Frie tekstfelt er ikke dekket.
13. K8: reservasjon uten flagg vises i attention etter 5 minutter. A.1 krever alderspredikat og minst 2 minutters ventetid.
14. K5: capture-reservasjonen tar intensjonen `FOR SHARE` før capture-låsen; cancel, webhook og `apply` tar `FOR UPDATE`. A sin gamle lock-order-probe feiler derfor tilsiktet.
15. `cancelVippsPayment` slår bare opp credentials når `provider_ref` finnes og intensjonen ikke er terminal.
16. Konflikthendelsen skrives én gang per (intensjon, årsak).
17. K1-vakten er navnebasert; kjøretidsprobene mot Postgres er den egentlige låsen. A sine 9 av 14 omgåelser er kjent begrensning.

**Q-forslag**
- **K5b (utvidet, må besluttes før Vipps aktiveres):** (1) egen sluttilstand for delvis captured og så avsluttet intensjon, (2) refusjon mot oppgjorte captures på en ikke-`settled` intensjon, (3) cancel av resten når oppgjorte captures finnes (D-41).
- K6 og K8 er uendret.
- Ny (DEFERRED, ikke i FIX-listen): Neonomics `bookingDate`, `valueDate` og `nextPageToken` valideres ikke. En ugyldig dato gir synlig DB-feil som stopper siden; forslag er karantene.
- Sandbox-sjekk (`BLOCKED_EXTERNAL`): Vipps `reference`-ekko, 2xx-kropp på capture/cancel/refund (en legitim 204 ville nå bli `outcome_unknown`), Wallester PATCH-svar, Stripe-refusjonens nullbarhet.

**NOT VERIFIED**
- Alle leverandørfakta (docs ikke hentbare; D-41); ingen ekte nettverk, NAS eller produksjon.
- Full suite (ca. 45 min under `flock`) er ikke kjørt, kun ordrens sett.
- Deadlock er bare vist under testinterleavings (60 runder pluss 8×3).
- Lease er testet med `submitLeaseMs`, ikke 120 s i sanntid.
- `FOR SHARE` mot en ekte Vipps som godtar capture etter cancel er `unverified`.
- Forhåndseksisterende, ikke rørt: non-2xx-feilmeldinger bærer leverandørtekst (B F9).

**Notater:** `/tmp/pg-home/fin2-fix-notes/NOTES.md`.
