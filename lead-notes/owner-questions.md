# Samlede forslag til Q-er (til den samlede docs-PR-en; nummereres av lead fra Q-79). Ikke blokkerende: byggingen går videre med anbefalt/strengeste valg, eieren kan veto.
Kilde -> spørsmål (anbefaling i parentes der byggeren/planleggeren ga en)

## Fra WP-G1c (rapport /tmp/lead/G1c-report.md)
- G1c-1: Skal mottakerens START løfte `recipient_request`-rader? (kode/trigger: aldri; ordren sa «som i dag»; reviewer A sjekker hva main gjør)
- G1c-2: Skal erasure av et rom slette tenant-brede avmeldingsrader som ligger i rommet?
- G1c-3: Rå kroppsgrense (256 KB) vs Metas mulige 3 MB webhook-payload: hva skal grensen være? (batchtak 1000 er `unverified`)
- G1c-4: Skal eierens eget nummer unntas fra den eldre notify-STOP-vakten?
- G1c-5: Skal vakten også dekke worker-prosessen (krever compose-env-endring)?
- G1c-6: Skal mottakerhasher saltes (krever re-nøkling av eksisterende avmeldinger)?
- G1c-7: Skal signert leverandørtid (Meta, Telnyx, Slack) være ekstra beskyttelse for STOP/START-rekkefølge?
- G1c-8: Skal stille-helligdags-timer/julaften gjelde for samtaler?
- G1c-9: Bekreft kald-regelen for kontaktbok-lenker (Q-72 pkt 11).

## Fra WP-N1b (rapport /tmp/lead/N1b-report.md)
- N1b-1: Er AI-kost i øre finans? (Q-64: nei; strengeste regel gjelder inntil svar)
- N1b-2: Er kampanjeutgift fra Growth-kjernen finans? (ja => `growth.*` trenger samme tilbakehold = egen WP)
- N1b-3: Skal Autoritet/Integrasjoner/AI-sentrene bygges finansfritt slik at skyen får en nyttig visning?
- N1b-4: Trengs en «trusted»-markør for lokale svar som kan følge historikken til en senere skytur (JARVIS-116 e)?
- N1b-5: Skal executive sin per-tjeneste-holdback fjernes etter NAS-steg 7g? (behold)
- N1b-6: Churn (forfalte kundefakturaer fra produktbruk) og helse-situasjoner har samme mønster men er ikke finans: klassifiser separat?

## Fra planleggeren FIN2/SEC2/V2
- FIN2-1: Stripe `payment_failed`: forbli terminal (dagens oppførsel låst av test) eller kan et senere leverandør-`succeeded` løfte?
- FIN2-2: Vipps cancel/utløp etter delvis capture: ny «delvis oppgjort»-tilstand eller bare blokkere? (ordren: blokkere)
- V2-1: Skal talekanalen ha en varig utterance-journal på tvers av gjenstart (krever Core-rute + migrasjon)?

## Fra planleggeren P3/OPS2a
- P3-1: Skal manuelle tickets få svaret på seg selv (Q-63 pkt 8)? (bygges under veto)
- P3-2: Skal GBP-paginering bygges `unverified` (Q-68 pkt 5)? Kan developers.google.com og developers.facebook.com tillates i byggemiljøet (Q-68 pkt 6)?
- OPS2a-1: Skal vakthunden dekke alle tenants (flere varsler hvis business-tenant finnes)?
- OPS2a-2: Vil du opprette en egen ekstern monitor for worker/vakthund (`BLOCKED_EXTERNAL`)?
- OPS2a-3: Skal vakthundens tilstand kobles fra incident-automatikken?
- OPS2a-4: Aksept for å endre `.github/workflows` slik at EV-7 dependency-check kjører i CI?
- OPS2a-5: Hvilken beslutning skal EV-1 confidence-gaten styre?
- OPS2a-6: Skal vakthunden bli en egen prosess (compose-profil)? (OPS2b)

## Fra kartleggingen (kategori B; allerede i OPEN_QUESTIONS): Q-43, Q-71 (S1), Q-77 pkt 1-3 (D-192 stående fullmakt, Actions, grenbeskyttelse), Q-68 pkt 6, Q-61/62, Q-64/76, Q-72..75, Q-78, ny D om adopsjon av v4.0/autonomi-graduering.
