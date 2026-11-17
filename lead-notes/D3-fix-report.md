# WP-D3 (D-459) - fikserens rapport etter uavhengig review (2026-11-17 ~06:00Z)
Gren `claude/wp-d3-growth-writes`, head `f9b269e40284326ee9e090e071efbe495c22fa20`, 18 nye commits oppå de 8 opprinnelige (reviewet head = `a0aab5ae`); ren arbeidskopi; push forsøkt én gang -> 503 (HARD_EXTERNAL_BLOCKER, lokalt).
Bevis: hver fiks har en test som feller gammel kode og passerer ny (verifisert ved å gjenopprette gamle kildefiler); 5 mutanter (inkl. de 3 reviewer fant overlevende) drept.

## Funn -> fiks (testnavn = describe-grupper; chain-db = modules/growth/test/wpd3-write-chain-db.test.ts, engine = modules/growth/test/wpd3-write-engine.test.ts)
- H1/L4 FIXED 5e992f18: transportfeil ETTER sendt mutasjon, uleselig/for stor 2xx, redirect etter sending, ikke-4xx status, TikTok-svar uten envelope, feilet etterkontroll => `outcome_unknown`, ledger-rad `unverified`, aldri terminal FAILED. Kun bevist før-sending-feil (ECONNREFUSED osv.) forblir FAILED. Tester: chain-db J, engine C, `wpd3-pre-send-transport-errors` (3).
- M1 FIXED 36b9d7f0: nøkkel gjenbrukt på tvers av verktøy -> `growth_write_idempotency_key_collision` (ikke falsk `applied`). chain-db K.
- M2 FIXED 8f965777: modell-lesbar tidslinje bærer kun id-er, statuskoder, tall, booleans, ISO-valuta (executor.ts:217). chain-db L, engine B2.
- M3 FIXED d6cf1d07: YouTube sender hele originalressursen tilbake; `update_video_metadata` og `set_video_privacy` er klasse D. engine E2 (fake med leverandørens replace-semantikk).
- M4 FIXED facf545d: GBP-tilstand = én anmeldelse via `reviews.get` (ny klasse A-handling `get_review`); omtaletekst og anmelders navn lagres aldri; eierens svar kun som digest. Kun journalen er hemmelighetsskannet (ledger/audit ikke; dokumentert). chain-db M, engine E3.
- M5 FIXED (googleads/metaads) / PARTIAL (seks nye id-er) 53ed8e11: frys av lese-connectoren stanser også vekst-skrivingen; alle åtte plattformer fryses også via tool-id. De seks nye er ikke i CONNECTOR_REGISTRY => ingen dashboard-frys-knapp (WP-I-oppfølging). chain-db N, `apps/api/test/wpd3-growth-freeze` (3).
- M6 FIXED 0af3dfc4: kommando-bundet skriving kan kun SENKE levende budsjett; forventet nåverdi tvinges til kommandoens verdi; beløp/kampanje/status sjekkes (executor.ts:169). chain-db O, engine B3.
- L1 FIXED 21226b44: ni handlinger fra klasse C til D (slett, publisering/eksponering, anmeldelsessvar): 16 C / 27 D, tellelås. chain-db P, engine D.
- L2 FIXED 292ebeaa: normalisert href sendes; backslash, kontrolltegn, ikke-standard port avvist. engine A2/E4, chain-db Q.
- L3 FIXED 5cf0ddd9: Google Ads developer token valgfritt for skriving (header kun når satt). engine E5.
- L5 FIXED e09babee (+102d6320 fixture): replay markerer kommandoen; migrasjon 114: unik indeks (tenant_id, execution_write_id) + trigger som krever journalrad utstedt for SAMME kommando; DPIA sier nå at journalen IKKE er append-only; ekstra bug funnet og fikset: replay av kommando-bundet skriving etter `execution_unknown`/`executed` kastet `growth_command_not_pending`. chain-db R/S, growth-erasure (8).
- L6 FIXED 9e9a6f47: >1000 nøkkelord, >200 annonser, >5 GAQL-sider feiler lukket; GBP-svargrense 4096 byte; rekkevidde 50 anmeldelser dokumentert. engine E6/E3.
- L7 FIXED e09babee + 2a30cdd6: mutant-drepende tester; ny HTTP e2e (`/growth/mutate|read|writes/list`, ekte server+gateway+step-up+RLS-Postgres, lokal fake Google Ads; 7 tester; kun `grants.verify` stubbet); gateway-tidsavbrudd gjennom growth-transport (chain-db U).
- L8 FIXED cefe91a9: svarkropp strømmes med 1 MB hard grense og feiler lukket (http.ts:60). engine C.
- INFO FIXED 264ded05: boot-logg betinget; kun `JARVIS_GROWTH_EXPERIMENTS=on` gir bare eksperimentruten (mutate/read/list = 404). `wpd3-growth-routes` (10). `.gitleaksignore` beholdt.
- Docs f9b269e4: runbook, DPIA (B6, B9, §5, §6), PROCESSING_INVENTORY oppdatert; D-420-vakten grønn; delte docs urørt.

## Kommandoer og resultater
typecheck/lint/check:containment rent. Målrettet: 37 filer / 563 tester grønne + vaktbatch 380 grønne. Full suite (som postgres, 2 workers, ipv4-contention ekskl.): Test Files 3 failed | 843 passed (846); Tests 5 failed | 14423 passed (14428); 1942 s; logg `/tmp/lead/logs/d3-fix-full-suite.log`. De 5 = kjente sandkasse-feil (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate). +74 tester vs. 14354 før fiks. Per fil: chain-db 59 (27), engine 52 (26), wpd3-growth-routes 10 (7), growth-erasure 8. wph1/wph2-baselinene grønne uten regenerering. gitleaks: 26 commits, ingen funn. IKKE kjørt: ekte nettkall, live leverandøratferd.

## Steder som trenger uavhengig blikk (fil:linje)
modules/growth/src/write/executor.ts:99-136 (replay-deteksjon, `collide()` pre/post-sjekk), :169 (`bindCommand`), :191 (`markCommand`), :217 (`timelineProjection`); http.ts:60 (`readBodyCapped`), :108 (`afterSendFailure`); modules/tool-gateway/src/transport-errors.ts:99 (`isProvenPreSendTransportError` - ENESTE endring utenfor growth/api/core; additiv; standard er nå ukjent utfall, kun bevist før-sending = FAILED); youtube-write.ts:47,63,129 (hel-ressurs-rundtur; kun sjekket mot offisielt eksempel, ikke live); migrasjon 114:52 + unik indeks (114 endret på stedet fordi grenen er umerget; trenger 115 hvis noe miljø allerede har brukt gammel 114); tool-factory.ts:95 (`connector_ids_for`); apps/api/src/server.ts:2144-2203 (rutegating); apps/api/src/main.ts:1488; gbp-write.ts:74,165 (`get_review`); google-ads-write.ts:48-49,254 (avkortingsgrenser).

## Oppdatert D-459-tekst (til DECISIONS_AND_ASSUMPTIONS)
«UA-4 Growth, WP-D3, rettet etter uavhengig review. Skriving mot Google Ads, Meta, GA4, Search Console, GBP, YouTube, LinkedIn og TikTok (19 lese + 43 skrive, 16 klasse C / 27 klasse D; sletting og publisering/eksponering er klasse D) går gjennom én motor: eier-eksklusive growth_*-navnerom, mål-allowlist, step-up på alle skrivinger, klasse D-kjede og Jarvis' egen før/etter-journal (growth_write_journal, mig. 113). Transportfeil etter sendt mutasjon er alltid UKJENT utfall (`outcome_unknown`/`unverified`); bare bevist før-sending-feil er FAILED. Idempotensnøkkelen kan ikke gjenbrukes på tvers av verktøy. Kommando-bundet utførelse kan kun REDUSERE et levende budsjett. Eierens frys av googleads/metaads (og growth_*-id-en) stanser også skrivingen. Tidslinjen bærer kun id-er, statuser og tall (regel 7); omtaletekst og anmelders navn lagres aldri. YouTube sender hele originalressursen. Kreativ-URL sendes normalisert. Avkortede leverandørlister feiler lukket. Google Ads developer token er valgfritt (avviklet 2026-09-09). Migrasjon 114 åpner `executed` kun med `applied` journalrad utstedt for SAMME kommando og kampanje, ett bevis per kommando; journalen er ikke append-only (erasure). Pengeøkende handlinger nektes når finans-nødbryteren er på/ukjent (ikke et beløpstak; D-41/UA-6). Alt DORMANT og NOT VERIFIED; live BLOCKED_EXTERNAL per plattform.»

## Nye eierspørsmål (med anbefaling)
1) GBP `update_location_hours` også klasse D? Nå C. Anbefaling: behold C.
2) Lempe step-up for `pause_*`? Anbefaling: nei før NAS-verifisering, siden via navngitt D-beslutning.
3) Journal-retensjon? Anbefaling: knytt til regnskapsoppbevaring; sletting via erasure fortsatt mulig.
4) Hvem søker Google Ads-tilgangsnivå (Cloud-prosjekt), Meta-verifisering, GBP API-godkjenning, LinkedIn MDP og TikTok - og hvilke testkontoer i `JARVIS_GROWTH_WRITE_TARGETS`?
5) Registrere de seks nye connectorene (manifest + dashboard-frysknapp) som WP-I-oppfølging? Anbefaling: ja.
6) Gjøre developer token valgfritt også i lese-transporten `GoogleAdsTransport` (ikke rørt)? Anbefaling: ja, liten egen endring.
7) Flere valutaer for Meta/LinkedIn/TikTok? Anbefaling: kun ved behov.

## Avvik/forbehold
- Leaden sa 2 ucommitterte L2-testfiler; de ucommitterte var fikserens pågående L5-arbeid (executor.ts, journal.ts); L2/L3 var allerede committet.
- growth-erasure.test.ts setter nå `command_id` på journalraden (følge av strengere 114-vakt); ingen assertion svekket.
- Search Console feedpath/inspeksjons-URL sendes fortsatt rå, men backslash/kontrolltegn avvises.
- Leverandørfakta UVERIFISERT live: developers.google.com var utilgjengelig; brukt WebSearch-utdrag + offisielt YouTube-eksempel på raw.githubusercontent.com. Reviewers Meta Standard/Advanced -> Limited/Full-omdøping er ikke verifisert.
- Maskinhygiene holdt (HOME=/tmp/pg-home + pnpm-variabel, ingen pnpm-rekursjon, 2 workers kun for full suite).

---
# RUNDE 2 (etter re-review, 2026-11-17 ~07:10Z): ny head `3ecbdb62a3677e5cd7b8f5c05e6201cb5148fe75` (9 nye commits oppå f9b269e4), rent arbeidstre, push -> 503 (lokalt)
N1 MEDIUM LUKKET 4358ab1a (executor.ts:134,:159): replay av rad som KAN være utført låses ikke som `failed` når en port stopper den før leverandøren; raden står åpen, svaret er UNKNOWN, kommando-markeringen leges. chain-db V (a) varsler ikke klar (b) frosset connector (c) 503 på GAQL-lesing (e) `requested` med ferdig ledger-rad; mutant `mayHaveMutated=false` gir 4 røde. Runbook §7 rettet.
N2 LUKKET 4358ab1a (executor.ts:103): lempet kommando-binding gjelder kun en fullført journalrad (`applied`/`failed`/`outcome_unknown`), ikke `requested`. V2.
N3 LUKKET eadf023b: YouTube noop/etterbetingelse sammenligner eksakt form via digest (youtube-write.ts:50); kun CRLF->LF og usynlig sluttmellomrom normaliseres. engine E2 «N3».
N4 LUKKET 75b87ea3 (kun tester): de fem overlevende mutantene (a verifyAfter-wrappere, b prediktat-polaritet, c campaign-mismatch, d executed_at i 114-CHECK, e row.action) drept hver for seg. engine C/C2, chain-db V3/S.
N5 LUKKET fd4d5750: (a) `phone_primary`/`phoneNumbers` fjernet fra readMask (engine E3, chain-db M); (b) frys er kun API for alle åtte plattformer, runbook §1/§7b/§9 rettet; (c) e2e-header sier grants.verify/resolveIdentity/ownerGate er testdobler.
N6 LUKKET c4b4d947: GBP-innlegg, Meta list_ads, GA4 keyEvents, GSC-sitemaps kuttet ved full side/neste-side-token => nekter dedupe/NOOP/remove (funnet objekt kan fortsatt fjernes). engine E7 (én per leverandørfil). PARTIAL: >=20 GBP-innlegg kan ikke få nye via Jarvis før paginering.
N7 LUKKET a0e0c105: PLN/CZK/SGD fjernet fra delt valutaliste (også LinkedIn/TikTok). N8 LUKKET bd2ade8b: runbook §4 «114 endret på stedet før første anvendelse, ingen 115». N9 LUKKET 74be6144: statuskoder i tidslinjen fra eksplisitt allowlist per nøkkel (executor.ts:237); allowlist skrevet fra kunnskap, uverifisert mot primærkilder (ukjent verdi utelates i tidslinjen, journalen beholder den). Runbook-oppsummering 3ecbdb62.
Tall: typecheck/lint/containment exit 0; målrettet + vaktbatch 43 filer / 903 grønne (wph1/wph2 uten regenerering); chain-db 72 tester (var 59), engine 63 (var 52); gitleaks a0aab5ae..HEAD 27 commits: ingen funn; full suite IKKE kjørt (leaden kjører den i sluttintegrasjonen).
Avvik: N1(d) (avvise replay av kommando-bundet skriving med `precondition_changed`) skjer aldri i dag (gateway svarer fra ledger før validatoren) -> testen er en vakt, ikke rød på gammel kode; N2 implementert som «raden er ikke `requested`»; N5b tekst sto i runbook §7b/§9 (ikke §11).
D-459-tillegg (resten uendret): «En replay av en rad som kan være utført (journalraden `outcome_unknown`, eller ledgeren har en ikke-feilet rad) som stoppes av en port før leverandøren gir UKJENT og lar raden stå åpen, aldri terminal `failed`. Avkortede lister feiler lukket også for GBP-innlegg, Meta-annonser, GA4 og Search Console. Budsjettvalutaer er begrenset til de ti verifiserte. Tidslinjens statuskoder kommer fra en eksplisitt allowlist. Lokasjonens telefonnummer leses ikke.»
Nye eierspørsmål: 1) Bygge paginering for GBP-innlegg? [ja, før live-bruk]. 2) Tillate developers.facebook.com og developers.google.com i miljøets nettverk så valutaoffset, enum-lister og videos.update kan verifiseres (og PLN/CZK/SGD tilbake)? [ja]. 3) Frys-knapper i kontrollsenteret for alle åtte growth_*-plattformer = WP-I-oppfølger (ikke bare de seks nye).
