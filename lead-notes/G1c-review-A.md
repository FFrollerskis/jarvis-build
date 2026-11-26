TS: 2026-11-26T00:24:39.050Z
VERDICT: MERGE ETTER FIKSER – 0 HIGH, 2 MEDIUM (K3: gyldig stor Meta-batch gir 413 og STOP registreres aldri; K2: «STOP vinner samtidig» holder ikke ved ms-overlapp). Resten av K1–K9 er bekreftet.

Worktree er urørt (`git status` tom, HEAD `f43f06e6`). Alle prober, mutantlister og logger ligger i `/tmp/lead/G1c-review-A-probes/`.

## Funn (rangert; fil:linje mot HEAD)

**1. MEDIUM, K3: en gyldig signert Meta-batch over 256 KB gir 413 før signatur, og STOP registreres aldri.**
- Rå-grensen er `ingest.ts:61` (256 KB), håndhevet i `apps/api/src/server.ts:1893`. Taket på 1000 hendelser (`parsers.ts:46`) er dermed praktisk talt uoppnåelig.
- En realistisk Meta-batch er 439 B per melding. Bare 597 meldinger får plass; 1000 meldinger blir 439 034 B.
- Probe `zz-g1c-review-a-k3-route.test.ts` (`RVA_K3_ROUTE`): 1000 meldinger med STOP som nr. 1000 gir **413, og tjenesten kalles aldri**. 590 meldinger gir 200.
- Samme batch via `handle()` registrerer STOP (`RVA_K3_MATRIX`, 2,7 s per 1000 hendelser). Det er altså bare byte-grensen som stopper den.
- Retry: søkeutdrag fra tredjepart sier at Meta resender samme kropp ~7 dager. Da gir 413 igjen, og STOP går permanent tapt.
- 413 logges ikke: `server.ts:742-748` svarer `HttpError` uten `console.error`.
- Byggeren oppgir grensen som «kjent begrensning, egen Q» (runbook §5, `parsers.ts:46`) men merker K3 «LUKKET».
- **Fiks:** per-leverandør byte-grense ved `server.ts:1893`, f.eks. `meta` 4 MiB (Meta oppgir 3 MB) og 256 KB for resten. Legg til test med signert 1000-meldingsbatch (200 og STOP registrert), og logg 413 med provider og årsakskode. Alternativ: sett K3 til PARTIAL.

**2. MEDIUM (lav sannsynlighet), K2: «samtidig → STOP vinner» (141-header, byggerordre, runbook) holder ikke ved ms-overlapp.**
- START får `recv_seq` tidlig og uten lås (`store.ts:370-372`). STOP får `stop_seq` først under låsen, midt i transaksjonen (`store.ts:323`). Vinneren er den som allokerer sekvensen først.
- Deterministisk (3 av 3 kjøringer, `RVA_K2_OVERLAP`): STOP#2 har allokert seq 113 og holder låsen ucommittet. START mottas (recv 114) og løfter STOP#2 etter commit, så mottaker er **fri**.
- Naturlig samtidighet, differensial mot main (`diff-main` og `stagger`). Tall = runder der mottaker endte fri, men STOP skulle vunnet:

| Gap mellom START og STOP#2 | main (av 60) | HEAD (av 60) |
|---|---|---|
| 0 ms | 33 | 9 |
| 1 ms | 43 | 5 |
| 2 ms | 21 | 1 |
| 3 ms | 13 | 3 |
| 5 ms | 5 | 0 |
| 8 ms | 1 | 0 |
| 12 ms | 0 | 0 |

- Samtidig oppstart (STOP#2 og START i samme tick), 40 runder: main 30 frie; HEAD 11, 9 og 7 frie (3 kjøringer).
- Byggerens «deterministiske» 20 runder holder låsen til START-mottaket finnes, så STOP-seq alltid kommer etter. Den 24-runders frie testen sjekker bare intern konsistens (`stop-start-order.test.ts`).
- Modellen er likevel konsistent: en uavhengig sekvens-oracle (gjenspilling i seq-orden) stemte i 1200 scenarioer. Det var 3 seeds × 200 runder × 2 tenants med samme nummer og 722 injiserte rollbacks. 0 avvik, 0 deadlocks, og tenant A blokkerer ikke B (5 ms).
- Praktisk risiko er lav: mennesker sender STOP og START sekunder fra hverandre, ikke millisekunder.
- **Fiks:** (a) allokér STOP-seq ved mottak, i samme tidlige punkt som START. (b) Innfør en tie-margin Δ (2–5 s, DB-klokke) slik at START bare løfter STOP registrert mer enn Δ før mottaket. Alternativt skriv om påstanden til «sekvensorden; ved ms-overlapp kan START vinne».

**3. LOW, K7 testhull som står igjen (nøyaktig liste, punkt f).**
- Y19, M63: `ExclusiveLinkRace`-grenen (`conversation-graph/src/service.ts:351`) har ingen test.
- «Komplementære lag», review B: ingen av de to scenarioene er tatt inn. M65 (graf-lås `service.ts:317` fjernet) og M66 (etterkontroll fjernet) overlever hver for seg, selv mot hele `modules/comms/test/`. Review B fant 11 av 25 kryss-lenker uten lås, og 5 av 25 uten etterkontroll.
- Y5, M64: forhåndssjekken `service.ts:328` er ekvivalent og trenger ingen test.
- X6, M62: er nå drept, men av en self-deadlock/timeout (159 s), ikke av en ren assertion. Den nye låsen i `recordInbound` gjør «STOP i egen tx» umulig.
- M05: å erstatte `nextval('comms_event_seq')` med `clock_timestamp()` (`store.ts:311`) overlever alle 574 comms-tester. Ingen test pinner at sekvensen er DB-sekvensen.

**4. LOW, K4: byggerordrens eget tilfelle «samme kontakt, ulike verdier» er ikke bygget.**
- Probe `RVA_K4_VALUECHANGE`: samme Google-kontakt med ny telefon og e-post gir ny identitet i 2. synk (i1 ≠ i2). De 2 gamle lenkene forblir aktive, og 0 forslag og 0 konflikt lagres.
- Byggeren har dette under «Contradictions» i rapporten, og det er heller ikke i runbook.
- Det som er bygget virker: samme konflikt gir 1 rad etter 12 synker (`seen_count` 12), dismiss huskes, og accept etter dismiss virker.

**5. LOW, K1: DELETE-vernet kan omgås av app-rollen.**
- Probe `RVA_MIG_BYPASS`: med `set_config('jarvis.erasure_in_progress','true',true)` slettet app-rollen en `owner_recorded`-avmelding og en ikke-utløpt journalrad (rowcount 1).
- Samme mønster som 062/101, og byggeren har dokumentert det.
- TRUNCATE, `replica_role`, DISABLE/DROP TRIGGER og `setval` gir alle 42501.
- Ordren ba om «smaleste måte»; her er vernet kun mot kodefeil, ikke fri SQL. Eventuell skjerping er en SECURITY DEFINER-funksjon eller en egen erasure-rolle.

**6. LOW, K6 g5: omgåelser av notify-vakten (punkt d).**
- Slack `#general` og `@name` slipper gjennom (`legacy-notify-guard.ts:55`, `target === null`).
- Worker-transportene er uvaktet: `apps/api/src/worker-main.ts:385-440`. Byggeren oppgir dette som PARTIAL.
- Ingen tak eller journal, som avtalt. Sjette vei: generiske automasjonsverktøy (n8n, make, zapier-MCP).
- Alt annet er blokkert for alle fem leverandører: telefonvarianter (kanonisk, mellomrom, `00`-prefiks, trim, WhatsApp bar-sifre), Slack/Discord-ID (også små bokstaver og trim). Array/tall stoppes av `z.string()` i gateway (`gateway.ts:808`).

**7. INFO.**
- Runbook-raden B-NY (~:138) sier fortsatt «tak 100, id over 1000 og SID over 64 forkastes». `PROCESSING_INVENTORY.md:78` sier fortsatt at journal-hashen er usaltet.
- Over taket heler retry aldri halen: 5 av 45 STOP og 10 av 60 vanlige meldinger settes aldri inn etter 4 forsøk. Det er irrelevant hvis Meta aldri sender mer enn 1000.
- `throw null/undefined` fra en transport krasjer `ToolGateway.execute` (`gateway.ts` ~:1174). Pre-eksisterende, ikke G1c.
- Erasure-planen får to nye tabellnøkler selv med flagg AV (`erasure/plan.ts:369-371`).
- Retry-storm-risiko: Meta anbefaler svar innen 10 s (tredjepart), og 1000 hendelser tok 2,7 s på en dev-DB; NAS er ikke målt.

## Spesialpunktene

- **(a) `recipient_request`:** ikke en regresjon. `main` løfter den heller ikke ved START (differensial D1: main og HEAD gir `{recipient_request:false, owner_recorded:false, provider_error:true, inbound_stop_keyword:true}`). Byggerordrens «som i dag» var upresis. Triggeren tar nå det på DB-nivå: 24 av 24 kombinasjoner (4 kilder × 6 løftere) som spesifisert.
- **(b) K2:** se funn 2 og 3.
- **(c) K3:** se funn 1. Matrisen 99/100/101/120/1000/1001 × posisjon (første, midt, N-1, N) er alle OK på service-nivå. 1001 gir 503 og STOP registreres.
- **(d) g5:** se funn 6.
- **(e) baselines:** legitime. 21→19 og wrapped-formen er mekaniske, og identiteten er låst av `wpg1c-legacy-notify-wiring.test.ts`. M67–M70 (unwrap slack/telnyx, wrap ikke identitet, comms på men uinnpakket) ble alle drept. Ingen assertion er svekket: 32 testfiler diffet, kun konstruktør-argumenter, tellere og erstattede/styrkede assertions.
- **(f) K7:** se funn 3.
- **(g) migrasjon 142:** trygg.
  - Fra tom DB lykkes den.
  - Oppgradering fra main (001-140 via `git archive`) med en `health`/`home`/`guest`-rad i alle 7 tabeller lykkes, med 7 NOTICE.
  - Alle 7 constraints står NOT VALID, ingen rad er tapt, og nye rader med de rommene avvises.
  - UPDATE på en dårlig rad gir 23514, og appen ser dem ikke (RLS).
- **Rollback-vurderingen stemmer.** Main-kode mot HEAD-skjema (141-143): 31 av 32 filer og 404 av 405 tester grønne. Den ene feilen er main-sveipet i `funnel-db` med injisert app-klokke foran DB-klokken (`23514`). Det er kun klokkeskjevhet.

## Byggerens påstander → dom

| Påstand | Dom | Bevis |
|---|---|---|
| K1 trigger hvem kan løfte hva, append-only | BEKREFTET | matrise 24/24; `git diff --name-status` = 3×A |
| K1 DELETE-vern | DELVIS | funn 5 |
| K1 rom-CHECK NOT VALID + VALIDATE | BEKREFTET | probe `zz-g1c-review-a-mig.test.ts` |
| K1 saltet hash, fail-lukket, overgang | BEKREFTET | uavhengig HMAC-omregning (6 input × 2 formål); M32–M37 drept |
| K2 deterministisk, STOP vinner samtidig | DELVIS | seq-modell BEKREFTET, «samtidig» FEIL (funn 2) |
| K3 aldri 200 med droppede, STOP først, lange id-er | DELVIS | 503/STOP-først/hash BEKREFTET; 413 FEIL (funn 1) |
| K4 forslag, kald-regel pinnet | DELVIS | funn 4; M54 drept |
| K5 eier-angre | BEKREFTET | M09a, M10, M56, M74, M75 drept |
| K6 g1 kontotak | BEKREFTET | M57 drept |
| K6 g2 helligdager | BEKREFTET | uavhengig referanse 2024-2035, 21 915 instanter, 0 avvik |
| K6 g3 Slack | BEKREFTET | M45, M46 drept |
| K6 g4 `policy_denied` | BEKREFTET | 51 transportfeil byte-identiske main vs HEAD (`g4-main.out` / `g4-head.out`); M47, M48 drept |
| K6 g5 notify-vakt | PARTIAL, som erklært | funn 6; M49–M52 og M72 drept |
| K7 testhull | DELVIS | funn 3 |
| K8 flagg AV identisk | BEKREFTET | 11 guard-filer / 209 tester grønne (env-drift, compose, D-420, schema, wph1/wph2, manifest, model-surface); M69 og M70 drept |
| K9 runbook/DPIA | DELVIS | to foreldede linjer (funn 7) |

## Mutasjoner

- **76 mutanter kjørt:** 66 drept i første pass, 10 overlevde. Etter re-kjøring av 5 mot hele `modules/comms/test/` (F01, F05, F11, F65, F66) ble M01 og M11 drept av tester utenfor min gruppe. Endelig **68 drept, 8 overlevd**.
- **Overlevende:**

| Mutant | Vurdering |
|---|---|
| M03 | lås i `liftByStartKeyword`; test-only API, ikke nåbar i produksjon |
| M09c | kun-trigger for eier-angre; ekvivalent i effekt |
| M73 | `exists`-sjekk i preflight; ekvivalent |
| M64 | Y5 forhåndssjekk; ekvivalent |
| M05 | sekvens → klokke; reelt hull |
| M63 | Y19 race-gren; reelt hull |
| M65 | graf-lås; reelt hull |
| M66 | graf-etterkontroll; reelt hull |

- **Baseline** (mine 26 filer): 403 tester grønne på HEAD før mutasjon, 125 s.

## Ikke verifisert av meg

- Metas batch på 1000: bare tredjepart (Hookdeck). Meta-sidens søkeutdrag bekrefter 3 MB. Retry (~7 dager, samme kropp, svar innen 10 s) er også tredjepart. `developers.facebook.com` og `hookdeck.com` var ikke nåbare med WebFetch.
- Slack-feilkodene `fatal_error` og `internal_error`, og at Twilio mangler signert tidsstempel, er tatt på byggerens ord.
- Om `wamid` bærer avsendernummer: søket ga ikke bekreftelse. Hvis det stemmer, er receipts med 1825 dagers retensjon personopplysninger, i motstrid til DPIA-teksten.
- NAS, ekte leverandør, ekte pepper og vault-kjede, yteevne på NAS (fsync), produksjonsdata (finnes det health/home/guest-rader?), og worker-prosessen er ikke kjørt.
- `embedded-postgres-ipv4-contention` er ikke kjørt (som avtalt). Full suite, typecheck og lint er ikke kjørt. `generate-compose-env.mjs --check` finnes ikke; env-drift og compose-guardene dekker i stedet.

**Probe-mappe:** `/tmp/lead/G1c-review-A-probes/`. Prober er `zz-g1c-review-a-{k2-conc,k3-batch,k3-route,mig,diff-main,stagger,notify,holidays,k4,hash,g4-diff}.test.ts`. Mutantdriver: `mutate.py`, `mutants.log` (rader `F01…F66` er re-kjøringene). Øvrig: `NOTES.md`, `rollback-compat.log`, `baseline-builder-tests.log`, og `main/` (git archive av 71a31d8b).
