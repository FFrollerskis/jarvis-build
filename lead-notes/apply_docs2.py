import re

ROOT = "/home/user/jarvisbuild/.claude/worktrees/docs2/"

D459 = (
    "| D-459 | **WP-D3: UA-4 GROWTH-SKRIVING (GOOGLE ADS, META, GA4, SEARCH CONSOLE, GBP, YOUTUBE, LINKEDIN, TIKTOK) + EKSPERIMENTREGISTER (mandat: D-450, D-470)** "
    "(branch `claude/wp-d3-growth-writes`; migrasjon 112-114; uavhengig review (1 HIGH, 6 MEDIUM, 8 LOW), to fiks-runder, to re-reviewer og én delta-re-review; siste verdict MERGE) | "
    "**Besluttet.** UA-4 Growth, WP-D3. Skriving mot Google Ads, Meta, GA4, Search Console, GBP, YouTube, LinkedIn og TikTok (19 lese- og 43 skrivehandlinger, 16 klasse C og 27 klasse D; sletting og publisering/eksponering er klasse D) "
    "går gjennom én motor: eier-eksklusive `growth_*`-navnerom, mål-allowlist (eierens EGNE konto-/eiendoms-id-er i `JARVIS_GROWTH_WRITE_TARGETS`), step-up på alle skrivinger, klasse D-kjede og Jarvis' egen før/etter-journal "
    "(`growth_write_journal`, migrasjon 113) med idempotensnøkkel og readback. Transportfeil etter sendt mutasjon er alltid UKJENT utfall (`outcome_unknown`/`unverified`); kun bevist før-sending-feil er FAILED; "
    "en replay av en rad som kan være utført og som stoppes av en port før leverandøren gir UKJENT og lar raden stå åpen (aldri terminal `failed`). Idempotensnøkkelen kan ikke gjenbrukes på tvers av verktøy. "
    "Kommando-bundet utførelse kan kun REDUSERE et levende budsjett. Eierens frys av googleads/metaads (og growth_*-id-en) stanser også skrivingen; frysen er kun API (de åtte plattformene står ikke i `CONNECTOR_REGISTRY`, så "
    "kontrollsenteret har ingen frys-knapp ennå). Den modell-lesbare tidslinjen bærer kun id-er, statuser fra en eksplisitt allowlist og tall (regel 7); omtaletekst, anmelders navn og telefonnummer lagres og leses aldri. "
    "YouTube sender hele originalressursen tilbake og sammenligner eksakt form. Kreativ-URL sendes normalisert. Avkortede leverandørlister (nøkkelord, annonser, GAQL-sider, GBP-innlegg, Meta-annonser, GA4 key events, "
    "GSC-nettstedskart) feiler lukket. Budsjettvalutaer er begrenset til de ti verifiserte (NOK, SEK, DKK, EUR, USD, GBP, CHF, CAD, AUD, NZD). Google Ads developer token er valgfritt for skriving. "
    "Migrasjon 114 åpner `executed` kun med en `applied` journalrad utstedt for SAMME kommando og kampanje, ett bevis per kommando; journalen er ikke append-only (erasure); 114 ble endret på stedet FØR første anvendelse "
    "i en vedvarende DB (ingen 115 nødvendig). Pengeøkende handlinger nektes når finans-nødbryteren er på eller ukjent (ikke et beløpstak; D-41/UA-6). Eksperimentregisteret (hypotese, variant, tidsvindu, metrikk, utfall) "
    "og kreativ-intelligens er rene beslutningsfunksjoner over data Jarvis allerede har; attribusjon spend, klikk, lead, kunde: koblingspunktene er bygget, resten er `DEFERRED`. Alt er DORMANT/AV bak flagg "
    "(`JARVIS_GROWTH_WRITE_PLATFORMS`, `JARVIS_GROWTH_WRITE_TARGETS`, `JARVIS_GROWTH_CREATIVE_URL_HOSTS`, `JARVIS_GROWTH_EXPERIMENTS`; alle AV = identisk med main) og `NOT VERIFIED`; live er `BLOCKED_EXTERNAL` per plattform "
    "(Google Ads developer token og tilgangsnivå, Meta-verifisering, GBP API-godkjenning, LinkedIn MDP, TikTok-godkjenning; D-108). Leverandørfakta (sidestørrelser, enum-lister, YouTube-normalisering, Meta-valutaoffset) er "
    "UVERIFISERT mot primærkilder (developers.google.com og developers.facebook.com var utilgjengelige i byggemiljøet). Åpne oppfølginger: JARVIS-106 til 108; eierspørsmål Q-68. DPIA `docs/UA4_GROWTH_DPIA.md`, "
    "runbook `docs/runbooks/WPD3_GROWTH_WRITES.md`. Test: full suite 14423 av 14428 før runde 2 (5 kjente sandkasse-feil); målrettet og vaktbatch grønne etter runde 2 og delta-reviewen. |"
)

D475 = (
    "| D-475 | **WP-B3: UA-11 EVOLUSJON-SENTERET (EV-22) OG EIERENS AVGJØRELSE OM ENDRINGSFORSLAG (EV-23) (mandat: D-450, D-470)** "
    "(branch `claude/wp-b3-evolution-centers`; ingen migrasjon; uavhengig review (1 HIGH, 1 MEDIUM, 5 LOW), re-review MERGE og lead-sjekket oppfølger) | "
    "**Besluttet.** EV-22: Evolusjon er et tilleggssenter (`EXTENSION_CONTROL_CENTER_IDS`) utenfor masterplanens ti, kun lesing av eksisterende kilder bak `JARVIS_CONTROL_CENTER_EVOLUTION`; kost i øre holdes tilbake HELT fra sky "
    "ved utførelse (strengeste regel, Q-64 åpent). Forslagslisten viser de nyeste forslagene uten din registrerte avgjørelse (nyest først på numerisk ledger-seq, skjulte telles); kosttrenden seedes med forbruket før "
    "run-rate-vinduet og er ukjent når kildene ikke stemmer overens; ugyldige tall og tidspunkt er ukjent; kjede-/konstitusjonsraden er et oppstartsresultat (ikke målt nå); databasens tidssone vises som en faktarad i kostmodellen "
    "(ikke UTC gir advarsel, aldri blokkerende; tidssonen er ikke festet). EV-23 er snevret inn til en registrering uten virkning: klasse C, `JARVIS_CONTROL_EVOLUTION_APPROVAL`, kun eier, signert enhet og step-up, aldri modell "
    "(`servingModel` avvises), bundet til forslagets numerisk siste ledger-rad; lagringen er revisjonssporet (`audit_events`, type `evolution.owner_decision`), ikke endringsregisteret (en `approved`-rad der ville vært første "
    "produksjonsskriver av EV-0-kjeden, og registeret mangler `deferred`). Selvendring forblir frosset (D-397); ingen kodevei leser avgjørelsen som tillatelse (kildevakt over apps, modules, ops, packages og infra; vaktene er "
    "tripwires, atferdstestene er beviset); `activation_decision` er alltid false. `executive` sendes til incident-produsenten som `configured:false`: et avslag åpner aldri en hendelse, og en allerede åpen hendelse kan fortsatt "
    "auto-lukkes. Konsekvens: knappene har ingenting å vise før en forslagsprodusent finnes; å bruke avgjørelsen til noe krever en ny navngitt D-beslutning. Alt er DORMANT/AV bak flagg og `NOT VERIFIED`; beredskapen "
    "(EV-22/EV-23 i matrisen) forblir `DORMANT`. Åpne oppfølginger: JARVIS-109; eierspørsmål Q-69. Runbook `docs/runbooks/WPB3_EVOLUTION_CENTERS.md`. Test: full suite 14511 av 14516 (5 kjente sandkasse-feil), "
    "`vitest list` 14536 tester i 855 filer. |"
)

D476 = (
    "| D-476 | **EIERENS ORDRE 2026-11-16: 100 USD GRATIS CLAUDE-API PER MÅNED SKAL BRUKES FORNUFTIG OVER MÅNEDEN (mandat: D-450, D-470)** (Tobias direkte i chat, ordrett: «En ny ting du må ta inn vi har 100 dollar gratis "
    "api hos Claude hver måned pass på at jarvis bruker de fornuftig over måneden hver måned til ting som den trenger»; svar på Q-67: «15 hver måned og nr 2 gjør det du tenker er best») | "
    "**Besluttet og bygget (WP-B4, branch `claude/wp-b4-claude-budget-pacing`; migrasjon 115; uavhengig review (3 MEDIUM, 7 LOW), fiks, re-review MERGE og lead-sjekket oppfølger).** "
    "Kreditten (100 USD per periode, FORNYES DEN 15. Europe/Oslo, 28 til 31 døgn, ikke kalendermåned) styres av en ren tempomotor og håndheves i kode i `ModelGateway` bak `JARVIS_CLAUDE_BUDGET_USD` (AV = identisk med main). "
    "Kurve med 15 % reserve kun for ESSENSIELL og 5 % startmargin; nivåene gir allow, nedgrader, utsett eller stopp per tier (ESSENSIELL = eierens egne turer, VIKTIG = ATTESTERTE bestilte jobber og kritikk, BAKGRUNN = resten). "
    "Q-67: hard stopp av Anthropic ved 100 % med LOKAL fallback (for kall uten eksplisitt leverandørliste aldri en annen betalt skyleverandør; tydelig norsk melding uten lokalt alternativ; merknaden sier «lokale modellen» kun når "
    "en lokal modell svarte); `JARVIS_CLAUDE_BUDGET_HARD_STOP=off` er eierens override som fortsetter og bare varsler, og reserven er da ikke forbeholdt ESSENSIELL (tabellen er monoton). Sensitivitetsrutingen går alltid før kreditten "
    "(privat, helse og finans forblir lokalt); `BudgetGuard` for alle leverandører og dagstakene for verktøyturer er uendret ytre vern. Kun en tur som faktisk går på Anthropic fullføres der, en lukket tur forblir lukket. "
    "Forbruket leses med 3 s buffer og overlegg av reservasjoner, enkeltflyt og 30 s negativ buffer (uleselig eller ikke-endelig forbruk = fail-safe per tier); avbrutte Anthropic-kall bokføres med anslag; revisjonen tilskrives "
    "kallets egen person; varsler (50, 75, 90 og 100 % og tempo over 1,3) er minst-én-gang og forutsetter én worker. Kredittnotatet står på sluttsvaret også for flerrunde chat-verktøyturer og delegerte skyrute-jobber. "
    "Ved stengt Anthropic går alle automatisk-rutede kall lokalt, og feilteksten beskriver kredittens tilstand, ikke kallets opprinnelige rute. Fortsettelsesrunder over 100 % gir ingen revisjonsrad (trace-span `round_rule`). "
    "`delegated_from_chat` er en reservert nøkkel i `/tasks/submit` (også med flagget AV; bevisst herding). Restrisiko: en skybetjent modell i en ren tur kan delegere en jobb som får VIKTIG (avgrenset av bekreftelse i tainted tur, "
    "MAX_ACTIVE_JOBS=5, 6 per minutt og dagstaket for skyrute). Spesialist-delegering med eksplisitt liste (anthropic, openai, gemini) kan gå til openai/gemini når Anthropic er stengt (Q-70 pkt 1). Eneste skjemaendring: "
    "migrasjon 115 (dekkende indeks, gjelder uavhengig av flagget). Konsekvenser: forbruket er et anslag; Claude Code-jobber (D-96) er `DEFERRED`; rest-overskridelse mellom prosesser opptil 3 s. Anbefalt innstilling ved aktivering: "
    "`JARVIS_CLAUDE_BUDGET_USD=95` til tellingen er kalibrert mot konsollen. Åpne oppfølginger: JARVIS-110; eierspørsmål Q-70. Runbook `docs/runbooks/WPB4_CLAUDE_BUDGET_PACING.md`. Alt er `NOT VERIFIED` til det er kjørt på NAS "
    "(full suite 14487 av 14492 med 5 kjente sandkasse-feil før oppfølgeren). |"
)

for name, row in (("D459", D459), ("D475", D475), ("D476", D476)):
    cells = row.strip().strip("|").split("|")
    assert len(cells) == 3, (name, len(cells), [c[:40] for c in cells])

Q68 = (
    "| Q-68 | **WP-D3 (D-459): valg og forutsetninger for eieren.** (1) Hvem søker Google Ads-tilgangsnivå (via Cloud-prosjektet), Meta-verifisering, GBP API-godkjenning, LinkedIn MDP og TikTok-godkjenning, og hvilke TESTKONTOER skal inn i "
    "`JARVIS_GROWTH_WRITE_TARGETS`? (2) Skal GBP `update_location_hours` også være klasse D? *Anbefaling:* behold C. (3) Skal step-up lempes for `pause_*`? *Anbefaling:* nei før NAS-verifisering, så via en navngitt D-beslutning "
    "(Q-55-presedens). (4) Retensjon for skrivejournalen? *Anbefaling:* knytt til regnskapsoppbevaring; sletting via erasure er fortsatt mulig. (5) Bygge paginering for GBP-innlegg (20 eller flere innlegg kan i dag ikke få nye via "
    "Jarvis)? *Anbefaling:* ja, før live-bruk. (6) Tillate developers.google.com og developers.facebook.com i byggemiljøets nettverk, så sidestørrelser, enum-lister, YouTube `videos.update` og Meta-valutaoffset kan verifiseres "
    "(og PLN, CZK og SGD kan komme tilbake)? *Anbefaling:* ja. (7) Registrere de åtte plattformene med manifest og frys-knapp i kontrollsenteret som WP-I-oppfølging? *Anbefaling:* ja. (8) Gjøre developer token valgfritt også i "
    "lese-transporten `GoogleAdsTransport`? *Anbefaling:* ja, liten egen endring. (9) Flere valutaer for Meta, LinkedIn og TikTok? *Anbefaling:* kun ved behov. | "
    "Åpen. Reist 2026-11-17 av WP-D3-gjennomgangene; ingenting blokkerer merge (alt er DORMANT/AV og `NOT VERIFIED`) |"
)

Q69 = (
    "| Q-69 | **WP-B3 (D-475): valg for eieren.** (1) Skal ALLE interne verktøy i prosessen (ikke bare `executive`) holdes utenfor «Tilkobling svikter»? *Anbefaling:* ja, i en egen oppfølging som auditerer hvert verktøy "
    "(`owner_controls`, `situations` og `tasks` har samme kast-ved-avslag-mønster; `owner_control_unauthorized` klassifiseres i dag `auth_failed` med HIGH i `gateway.ts`, eksisterende på main). (2) Skal et åpent forslag med "
    "registrert eieravgjørelse senke `proposals`-raden fra WARN? *Anbefaling:* behold WARN til punkt 6 er avgjort. (3) Skal DB-tidssonen festes til UTC (`ALTER DATABASE ... SET timezone`)? *Anbefaling:* ja, når NAS-tidssonen er "
    "avklart; til da viser kostmodellen avviket som en faktarad. (4) Er AI-kost i øre finansdata overalt (se Q-64)? (5) Skal en registrert avgjørelse lagres i revisjonssporet (i dag) og være klasse C (i dag), eller i et "
    "eget register og klasse D? *Anbefaling:* behold; endring krever en navngitt D-beslutning. (6) Hva skal en registrert avgjørelse BETY (i dag ingenting; D-397 er frosset), og hvem produserer endringsforslag? "
    "(7) Skal forslagsinnholdet vises i senteret, og skal avgjørelsen signeres per objekt? *Anbefaling:* avgjøres sammen med punkt 6. | "
    "Åpen. Reist 2026-11-17 av WP-B3-gjennomgangene; ingenting blokkerer merge (alt er DORMANT/AV og `NOT VERIFIED`) |"
)

Q70 = (
    "| Q-70 | **WP-B4 (D-476): valg for eieren.** (1) Skal spesialist-delegering (`delegate_code_task`, liste anthropic, openai, gemini) også holdes lokal eller avvises når Claude-kreditten er stengt, i stedet for å bruke ekte penger "
    "på openai/gemini? *Anbefaling:* behold (BudgetGuard er ytre vern) og si det i varselet. (2) Skal gratis hostet Gemma (`gemma_hosted`, kun OFFENTLIG innhold) telle som fallback når PC-en er av og Anthropic er stengt? "
    "*Anbefaling:* ja (liten ruter-endring). (3) Akseptere opptil 3 s overskridelse mellom prosesser, eller ønske delt teller? *Anbefaling:* aksepter. (4) Skal avbrutte kall til andre betalte leverandører også bokføre anslag, så "
    "BudgetGuard slutter å undertelle? *Anbefaling:* ja, som egen liten WP. (5) Skal kun eier-direkte jobber være VIKTIG, mens modell-delegerte (selv fra en skytur) behandles som BAKGRUNN? *Anbefaling:* behold dagens regel "
    "(bekreftelse i tainted tur, 5 aktive jobber, 6 per minutt, dagstak). (6) Worker utover én replika krever leader-lås for varsler: ikke nå. (7) Hva skal `JARVIS_CLAUDE_BUDGET_USD` stå på når den slås på? *Anbefaling:* 95 til "
    "forbruket er kalibrert mot konsollen (anslagsbasert telling); fornyelsesdagen er den 15. (8) Skal Claude Code-jobber (D-96) telle mot kreditten? *Anbefaling:* egen WP. | "
    "Åpen. Reist 2026-11-17 av WP-B4-gjennomgangene; Q-67 (fornyelse og hard stopp) er besvart; ingenting blokkerer merge (alt er AV til du slår på flagget) |"
)

for name, row in (("Q68", Q68), ("Q69", Q69), ("Q70", Q70)):
    cells = row.strip().strip("|").split("|")
    assert len(cells) == 3, (name, len(cells), [c[:30] for c in cells])

LEDGER = [
    "| JARVIS-106 | P3 | Meta `list_ads`: en uleselig `ads`-kant (HTTP 400 «missing permissions» svelges som «ikke funnet») gir tom liste uten avkorting, så `create_ad` hopper over dedupe; verste tilfelle én duplikat PAUSET annonse (WP-D3 delta-re-review, N10) | "
    "WP-D3 (D-459) | `OPEN` | `modules/growth/src/write/meta-ads-write.ts` (~:173-181, ~:226-235) | påvist med probe av reviewer (1 POST, readback gir UKJENT) | — | WP-D3 | "
    "Rest: la en uleselig `ads`-kant gi `truncated:true` eller kaste (liten fiks og test); `delete_ad` er `DEFERRED`. |",
    "| JARVIS-107 | P3 | WP-D3 replay-sikkerhet: (a) mutantene «ignorer ledger `reserved`» og «dropp helbredelsen `markCommand(..., false)`» overlever testene (koden er riktig i reviewerens prober); "
    "(b) N2d: journal `outcome_unknown` med ledger `failed` og kansellert kommando lar en replay utføre mutasjonen (krever samtidig duplikat, krasj og kansellering) | WP-D3 (D-459) | `OPEN` | "
    "`modules/growth/src/write/executor.ts` (~:103, ~:134-164) | reviewerens prober (scratchpad) kan overtas som tester | — | WP-D3 | Rest: legg til de to testene og behandle kombinasjonen i (b) som `collide()`. |",
    "| JARVIS-108 | P3 | WP-D3 leverandørantakelser uverifisert mot primærkilder og kjent begrensning: sidestørrelser (GBP 20, GA4 200, Meta 100), enum-listene for statuskoder, YouTubes faktiske normalisering og scope `youtube.force-ssl`, "
    "Meta-valutaoffset; GBP-innlegg har ikke paginering (20 eller flere innlegg kan ikke få nye via Jarvis) | WP-D3 (D-459) | `PARTIAL` | "
    "`modules/growth/src/write/{gbp,ga4,meta-ads,youtube}-write.ts`, `executor.ts` (~:237) | — | developers.google.com og developers.facebook.com var utilgjengelige i byggemiljøet (ENOTFOUND) | WP-D3 | "
    "Rest: tillat vertene (Q-68 pkt 6) og verifiser; paginering for GBP-innlegg (Q-68 pkt 5); live-oppførsel er NAS-steg 12. |",
    "| JARVIS-109 | P3 | WP-B3 oppfølgingsfunn: kildevaktene (H1 `ORDER BY ... ::text`, «ingen leser av avgjørelsen») er tripwires som kan omgås med annen formulering (atferdstestene er beviset); DB-tidssonen er ikke festet i repoet "
    "(senteret bruker UTC, `BudgetGuard` og `RunRate` følger DB-sesjonen; vist som faktarad); listegrensene i L5 (over 200 forslag, ugyldige id-er, 20 eller flere uavgjorte); andre interne verktøy (`owner_controls`, `situations`, `tasks`) "
    "kaster ved avslag og kan gi falske «Tilkobling svikter»-hendelser, og `owner_control_unauthorized` klassifiseres `auth_failed` med HIGH (eksisterende på main) | WP-B3 (D-475) | `OPEN` | "
    "`apps/api/src/evolution-decisions.ts`, `apps/api/src/control-center/evolution.ts`, `apps/api/src/incident-producers.ts` (~:69-72), `modules/tool-gateway/src/gateway.ts` (~:1129) | `wpb3-*` | — | WP-B3 | Rest: Q-69 pkt 1 og 3. |",
    "| JARVIS-110 | P3 | WP-B4 gjenstående: (a) spesialist-delegering (`delegate_code_task`, liste anthropic, openai, gemini) går til openai/gemini når Anthropic er stengt (Q-70 pkt 1); (b) avbrutte kall til andre betalte leverandører "
    "bokføres uten anslag (`BudgetGuard` kan undertelle; Q-70 pkt 4); (c) fortsettelsesrunder over 100 % har ingen revisjonsrad (kun trace-span `round_rule`); (d) opptil 3 s overskridelse mellom prosesser; "
    "(e) `delegated_from_chat` er en reservert nøkkel i `/tasks/submit` også med flagget AV (bevisst herding); (f) skybetjent modell i en ren tur kan delegere en VIKTIG-jobb | WP-B4 (D-476) | `OPEN` | "
    "`modules/model-gateway/src/{model-gateway,claude-budget-enforcer,claude-budget}.ts`, `apps/api/src/{executive,chat-jobs}.ts` | `wpb4-review-fixes.test.ts` (gateway og api) | — | WP-B4 | "
    "Rest: Q-70; dokumentert i runbook (begrensninger 13-15). |",
]
for r in LEDGER:
    cells = r.strip().strip("|").split("|")
    assert len(cells) == 10, (r[:20], len(cells))


def edit(path, fn):
    p = ROOT + path
    s = open(p, encoding="utf-8").read()
    s2 = fn(s)
    assert s2 != s, path
    open(p, "w", encoding="utf-8").write(s2)


def dec(s):
    lines = s.split("\n")
    assert not any(l.startswith("| D-459 |") or l.startswith("| D-475 |") for l in lines)
    i458 = max(i for i, l in enumerate(lines) if l.startswith("| D-458 |"))
    lines[i458 + 1:i458 + 1] = [D459]
    i474 = max(i for i, l in enumerate(lines) if l.startswith("| D-474 |"))
    lines[i474 + 1:i474 + 1] = [D475]
    i476 = next(i for i, l in enumerate(lines) if l.startswith("| D-476 |"))
    lines[i476] = D476
    return "\n".join(lines)


edit("docs/DECISIONS_AND_ASSUMPTIONS.md", dec)


def oq(s):
    lines = s.split("\n")
    assert not any(l.startswith("| Q-68 |") for l in lines)
    h = next(i for i, l in enumerate(lines) if l.startswith("## Åpne spørsmål – krever Tobias"))
    sep = next(i for i in range(h, len(lines)) if lines[i].startswith("|---"))
    lines[sep + 1:sep + 1] = [Q70, Q69, Q68]
    return "\n".join(lines)


edit("docs/OPEN_QUESTIONS.md", oq)


def led(s):
    lines = s.split("\n")
    assert not any(l.startswith("| JARVIS-106 |") for l in lines)
    idx = max(i for i, l in enumerate(lines) if l.startswith("| JARVIS-105 |"))
    lines[idx + 1:idx + 1] = LEDGER
    out = "\n".join(lines)
    out = out.replace("# Funnregister – JARVIS-001 … JARVIS-105", "# Funnregister – JARVIS-001 … JARVIS-110", 1)
    return out


edit("docs/remediation/FINDINGS_LEDGER.md", led)
print("ok")
