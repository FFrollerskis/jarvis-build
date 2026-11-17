# WP-B4 Claude-kreditten: 100 USD per periode, tempostyrt og behovsprioritert (D-476) - slik bruker og verifiserer du den

**Formål:** Anthropic gir Tobias 100 USD gratis API-kreditt som **fornyes den 15. hver måned**. Jarvis skal bruke den fornuftig over hele perioden - ikke brenne alt de første dagene, og ikke la bakgrunnsarbeid ta av det eieren selv trenger. Dette er en **tempokurve** (hvor mye som er «lov» å ha brukt etter X dager) kombinert med **tre behovsnivåer** (ESSENSIELL / VIKTIG / BAKGRUNN) og en **hard stopp** ved 100 %: da går alt til lokal modell til kreditten fornyes.
Håndhevelsen bor i **kode i `ModelGateway`** (aldri bare i en promptregel), og **sensitivitetsrutingen går alltid FØR kreditten og er uendret**: private/helse/finans-turer forblir lokale uansett hva kreditten sier.

**Status (ærlige ord - ingenting er VERIFIED før du har kjørt NAS-stegene under):**
| Del | Status | Merknad |
|---|---|---|
| Tempomotor (periode, kurve, nivå, beslutning) | **WIRED bak flagg, DORMANT som standard** | ren funksjon, ingen I/O; testet mot 28-31-døgns perioder, skuddår, sommertid og årsskiftet |
| Håndhevelse i `ModelGateway` (`complete` + `stream`, kritikk, rådsrunder) | **WIRED bak flagg, DORMANT som standard** | AV = byte-identisk innputt og ingen ekstra spørringer; fail-safe ved uleselig forbruk |
| Lokal fallback + tydelig norsk melding når ingen lokal modell finnes | **WIRED** (bak samme flagg) | samme mekanisme som eierens leverandørpause; fallbacken er **kun lokal** (aldri en annen betalt skyleverandør) |
| AI-senteret (Kost): tre nye elementer | **WIRED** (bak samme flagg) | kun for lokal modell og siden, aldri for en skymodell (Q-64 strengeste regel) |
| Daglig brief: én linje | **WIRED** (bak samme flagg) | leveres til eieren (Telegram/side), aldri til en modell |
| Telegram-varsel: 50/75/90/100 % og tempo over 1,3 x kurven | **WIRED** (bak samme flagg) | én gang per terskel per kredittperiode; worker-prosessen |
| Eier-override: miljøvariabler | **WIRED** | `JARVIS_CLAUDE_BUDGET_HARD_STOP=off`, `JARVIS_CLAUDE_BUDGET_USD` |
| Eier-override: «bruk mer denne måneden» fra chat/kontrollsenter | **DEFERRED** | se «Eier-override» |
| Bokføring av Claude Code-jobber (D-96) i kreditten | **DEFERRED** | se «Hva som telles» |
| Alt sammen mot NAS/ekte Anthropic-regning | **NOT VERIFIED** | se «Verifiser på NAS» |

Én rent additiv migrasjon (**115**: en dekkende indeks på `cost_events`, se «Dekkende indeks»). Ingen nye verktøy (status leses via den eksisterende `executive.get_control_center`, senteret `ai`). Ingen endring i sensitivitetsrutingen.

## Slå på og av
Alt styres av miljøvariabler i `.env` (se `.env.example`); de når **både api og worker** (`SERVICE_ENV.api`/`SERVICE_ENV.worker` i `infra/local/service-env.mjs`, og dermed den genererte compose-blokken). Endring krever restart: `docker compose up -d api worker`.

| Variabel | Standard | Betydning |
|---|---|---|
| `JARVIS_CLAUDE_BUDGET_USD` | tom = **AV** | kreditten i USD per periode, f.eks. `100`. Tom, ikke satt eller `off` = AV (alt som før). `0` og ugyldige verdier er FEIL (api/worker nekter å starte) |
| `JARVIS_CLAUDE_BUDGET_RESET_DAY` | `15` | dagen i måneden kreditten fornyes (kl. 00:00 Europe/Oslo). 1-31; dager som ikke finnes i en kort måned (29-31) brukes måneden siste dag |
| `JARVIS_CLAUDE_BUDGET_HARD_STOP` | `on` (når kreditten er på) | `on` = ved 100 % stenges Anthropic til fornyelsen og alt går til lokal modell. `off` = eierens override: egne turer og bestilte jobber fortsetter på Claude, bakgrunn går lokalt, og det sendes bare varsel |
| `JARVIS_CLAUDE_BUDGET_RESERVE_PCT` | `15` | andel (0-50) av kreditten som holdes tilbake til de aller viktigste behovene ut perioden (ESSENSIELL) |
| `JARVIS_CLAUDE_BUDGET_MARGIN_PCT` | `5` | andel (0-20) av kreditten som er «lov» å bruke allerede første dag (så kurven ikke starter på 0) |
| `JARVIS_CLAUDE_BUDGET_TIGHT_RATIO` | `1.3` | hvor mange ganger kurven forbruket kan ligge før det regnes som stramt (1,05-5) |
| `JARVIS_CLAUDE_BUDGET_ALERT_PCTS` | `50,75,90,100` | prosentene som gir Telegram-varsel (1-8 stigende heltall, 1-100). **100 legges alltid til hvis det mangler** (`50,75` gir `50,75,100`): oppbruksvarselet kan ikke konfigureres bort |
| `JARVIS_CLAUDE_BUDGET_TIERS` | tom | overstyr tiertabellen: `owner_turn.CODE=important,background.VISION=important` (ukjent opphav/formål/tier = FEIL, aldri en stille rar tabell) |

Kun `JARVIS_CLAUDE_BUDGET_USD` slår styringen på; de andre variablene leses først når den er satt. Ugyldig verdi i en av dem stopper oppstarten med en klar melding (`ugyldig JARVIS_CLAUDE_BUDGET_...`) - aldri en stille annen verdi.
**AV = identisk med main:** gatewayen får ikke enforceren, ingen hint settes på kallene, ingen ekstra SQL kjøres, AI-senteret har ingen nye elementer, briefen har ingen ny kilde og workeren starter ingen varslingsrunde (`wpb4-claude-budget-wiring.test.ts`, `wpb4-claude-budget-gateway.test.ts`).

## Perioden (fornyelse den 15., ikke kalendermåneden)
Perioden går fra **fornyelsesdagen kl. 00:00 (Europe/Oslo) til neste fornyelsesdag**, så den er 28-31 døgn lang, og kurven bruker den **faktiske** lengden:
| Periode | Lengde |
|---|---|
| 15. nov → 15. des 2026 | 30 døgn (720 t) |
| 15. des 2026 → 15. jan 2027 | 31 døgn (årsskiftet) |
| 15. jan → 15. feb 2027 | 31 døgn |
| 15. feb → 15. mar 2027 | 28 døgn (2028 er skuddår: 29) |
| 15. mar → 15. apr 2027 | 30 døgn og 23 timer (sommertid 28. mars: 743 t) |
| 15. okt → 15. nov 2027 | 31 døgn og 1 time (tilbake til normaltid: 745 t) |
Raden som ligger på nøyaktig fornyelsestidspunktet hører til den NYE perioden (start inklusiv, slutt eksklusiv) - bevist mot ekte Postgres i `wpb4-claude-budget-db.test.ts`.

## Kurven - regnet eksempel (100 USD, periode 15. nov → 15. des, 30 døgn)
Kreditten `B` = 100 USD (≈ 1 050 kr, kurs 10,5 kr/USD fra prislisten; `PRICING_NOK_PER_USD`). Tempobudsjettet `P` = `B` minus reserven på 15 % = **85 USD**. Startmarginen `M` = 5 % = **5 USD**. Kurven (hvor mye som er «lov» å ha brukt etter en andel `f` av perioden) er
`C(f) = min(P, M + (P - M) x f)`.

| Etter | Kurven C | 1,3 x C (grensen for «stramt») |
|---|---|---|
| dag 0 (fornyelsen) | 5,00 USD | 6,50 USD |
| 5 døgn | 18,33 USD | 23,83 USD |
| 10 døgn | 31,67 USD | 41,17 USD |
| 15 døgn | 45,00 USD | 58,50 USD |
| 20 døgn | 58,33 USD | 75,83 USD |
| 25 døgn | 71,67 USD | 93,17 USD |
| 30 døgn (like før neste fornyelse) | 85,00 USD | (over tempobudsjettet: reserven) |

(Tabellen er regnet ut med motoren selv, ikke for hånd.)

**Nivåene** (S = forbruk så langt):
| Nivå | Når | Kort |
|---|---|---|
| **på tempo** (`on_pace`) | S ≤ C | alt tillatt |
| **foran tempo** (`ahead`) | C < S ≤ 1,3 x C | bakgrunnsarbeid går på billigere Claude-modell |
| **stramt** (`tight`) | S > 1,3 x C, ELLER S ≥ P (inne i reserven) | kun det viktigste bruker Claude |
| **oppbrukt** (`exhausted`) | S ≥ B (100 USD) | hard stopp (standard) |

Eksempel dag 15 (C = 45 USD, 1,3 x C = 58,50 USD): 38 USD = på tempo · 52 USD = foran tempo · 67 USD = stramt · 85 USD = stramt og inne i reserven · 100 USD = oppbrukt. Tallene er regnet ut med motoren (`decide()`), og nivågrensene er låst av enhetstestene (`wpb4-claude-budget-engine.test.ts`).

## Hva som skjer på hvert nivå (per tier)
| Nivå | ESSENSIELL (egne turer) | VIKTIG (bestilte jobber, kritikk) | BAKGRUNN (minneuttrekk, sammendrag, klassifisering, automatisk rådsrunde, planlagte jobber) |
|---|---|---|---|
| på tempo | tillat | tillat | tillat |
| foran tempo | tillat | tillat | **nedgrader** til billigste valgbare Claude-modell (Haiku) |
| stramt (ikke i reserven) | tillat | tillat | **utsett**: lokal modell |
| stramt, inne i reserven (S ≥ 85 USD), hard stopp PÅ | tillat | **utsett**: lokal modell (reserven er forbeholdt ESSENSIELL) | utsett |
| stramt, inne i reserven, hard stopp AV (`=off`) | tillat | **tillat** (reserven har ingenting å beskytte mot når ingenting stenges, se «Monotoni») | utsett |
| oppbrukt, hard stopp PÅ (standard) | **stengt**: lokal modell | stengt | stengt |
| oppbrukt, hard stopp AV (`=off`) | tillat (varsel) | tillat (varsel) | utsett |

«Utsett/stengt» betyr: Anthropic fjernes fra kandidatene, og kallet går til **lokal modell** (Q-67: hard stopp = lokal fallback). **Fallbacken er kun lokal:** et kall uten eksplisitt leverandør eller preferanseliste planlegges som `mode: LOCAL` når Anthropic er stengt for det - aldri til en annen betalt skyleverandør (openai/gemini ville brukt eierens penger i stedet for den gratis kreditten). Sensitivitets- og betalt-modell-reglene i ruteren gjelder uendret oppå (LOCAL kan bare snevre inn). Finnes ingen lokal modell som kan svare (også for PRIVATE-innhold og for bilde-/vision-krav), får eieren en **tydelig norsk melding** med når kreditten fornyes (`ClaudeBudgetBlockedError`) - aldri et stille betalt kall, aldri en stille omruting av et eksplisitt valg, og aldri et kryptisk avslag. Eksplisitte valg beholder sin egen semantikk: `provider: openai` er eierens eget valg (ingen kredittbeslutning), en preferanseliste (spesialistdelegering `[anthropic, openai, gemini]`) går videre til neste medlem i sin egen liste, og et eksplisitt `provider: anthropic` avvises med den tydelige feilen - men **Anthropic får aldri et kall mens den er stengt**. Kritikk-kallet (andre meninger) er lokalt når kallet er snevret inn (aldri en betalt skyleverandør som erstatning).
Regler som alltid gjelder: (1) sensitivitetsrutingen før kreditten; (2) **fortsettelsesregelen** (se under); (3) de eksisterende budsjettgrensene (`JARVIS_COST_*`, BudgetGuard) gjelder uendret og sjekkes FØRST; (4) uleselig forbruk - lesefeil, ugyldig eller ikke-endelig svar fra databasen, eller INGEN svar innen 3 sekunder - gir **fail-safe**: ESSENSIELL tillates, VIKTIG nedgraderes, BAKGRUNN utsettes (aldri «tillat alt» og aldri «steng alt», og eierens tur venter aldri for alltid på en hengende database); ikke-endelige tall (NaN, ±Infinity) er alltid uleselig, aldri «på tempo»; `begin()` kaster aldri.

### Fortsettelsesregelen (verktøyturer)
En verktøytur har flere runder. Gatewayens **egen** verktøyløkke (`completeWithTools`, leverandøren er stemplet av adapteren) vet hva tidligere runder gjorde, og bærer det til neste runde - en `tool_exchanges` i selve forespørselen er bare data og åpner ingenting:
- **En tidligere runde ble faktisk betjent av Anthropic** → turen er påbegynt der og fullføres: neste runde bærer den runden sin billett videre (samme modell og begrensning - en nedgradert tur fortsetter på den billigere modellen), uten ny lesing av forbruket. Turen kan dermed passere 100 % med høyst runde-taket (4 runder).
- **En tidligere runde ble STENGT av kreditten** (utsatt/avvist, betjent lokalt) → resten av turen forblir stengt og lokal, selv om forbruket i mellomtiden ser ut til å ha rom. En tur som startet lokalt går aldri tilbake til Anthropic midt i (og verktøyresultater en lokal modell har fått se går ikke videre dit). Hver runde er ett kall og revideres som eget kall (`round_rule: earlier_round_closed` i sporet).
- **Alt annet** (også en forespørsel som bare HAR `tool_exchanges`, f.eks. fra en annen kaller) er en vanlig, ny beslutning.
Konsekvens: revisjonen viser ikke lenger en egen «overstyrt»-rad per fortsettelsesrunde; fortsettelsen står i sporet (`round_rule: continuation`, årsak `continuation_round_allowed`), og at en tur endte over 100 % ser du i kostradene og i 100 %-varselet.

### Monotoni (HARD_STOP=off)
Beslutningstabellen er **monoton**: mer forbruk gjør aldri en beslutning mildere, og tiden (kurven stiger) gjør den aldri strengere - låst av en test over 121 forbruksnivåer (0-120 %) × hele perioden × alle tier × hard stopp på/av. For at det skal gjelde også med `HARD_STOP=off` er reserven **ikke forbeholdt ESSENSIELL når ingenting stenges ved 100 %**: VIKTIG tillates da også i reserven (årsak `reserve_open_hard_stop_off`; ellers ville VIKTIG vært utsatt ved 85-99 % og tillatt igjen fra 100 %). BAKGRUNN er uendret (lokal/utsatt hele veien), og med hard stopp PÅ er alt som før (VIKTIG utsatt i reserven, avvist ved 100 %).

## Tier-tabellen (formål × opphav)
**Opphav** utledes slik: eksplisitt hint fra en betrodd kaller (rådet; en delegert jobb fra chat = `owner_task` kun når jobben er ATTESTERT, se under) > har jobb-id = `background` > har økt-id = `owner_turn` > ellers `background`. Hintet settes aldri av en modell eller av innhold; kun av Jarvis' egen kode.
**Attestert «bestilt av eier» (review M2):** en delegert jobb er VIKTIG bare når kontrakten bærer BÅDE markøren `delegated_from_chat` og det interne flagget `cloud_tool_turns_allowed`. Begge er **reserverte nøkler**: `POST /tasks/submit` avviser en innsendt kontrakt som bærer dem (`reserved_input_key`), og bare `TasksDelegateTransport` setter dem - flagget først når turen som delegerte er betrodd (betjent av en skymodell, eller eierens egne ord, og ikke SECRET_RESTRICTED). En jobb uten attesteringen (forfalsket markør, lokalt betjent tur, planlagt jobb) er bakgrunnsarbeid. Å skrive `budget_origin` i kontraktdata har ingen virkning (leses aldri).
| Formål | `owner_turn` (egen tur) | `owner_task` (bestilt jobb) | `background` |
|---|---|---|---|
| CHAT, CODE, REASON, PLAN, RESEARCH, VISION, UNSPECIFIED | ESSENSIELL | VIKTIG | BAKGRUNN |
| CRITIQUE | VIKTIG | VIKTIG | BAKGRUNN |
| QUICK_CLASSIFICATION, SUMMARIZE, EXTRACT, BACKGROUND | BAKGRUNN | VIKTIG | BAKGRUNN |
Minneuttrekk og sammendrag bærer økt-id, men er bakgrunnsarbeid etter formål. **AI-rådet:** en eksplisitt bestilling («bruk AI-rådet») er en bestilt oppgave (VIKTIG); den automatiske triggeren (høy-innvirkning-klassifisering) er BAKGRUNN. Se «Kjente begrensninger» (tolkning).

## Hard stopp (eierens svar Q-67)
- Standard (`JARVIS_CLAUDE_BUDGET_HARD_STOP` tom eller `on`): ved 100 % stenges Anthropic **til neste fornyelse**, og alt går til lokal modell. Chat-svaret får en merknad («Claude-kreditten: perioden er brukt opp, så dette svaret kom fra den lokale modellen. Kreditten fornyes 15. desember.») - uten beløp.
- Ingen lokal modell kan svare: «Claude-kreditten for perioden er brukt opp, så Anthropic er stengt til neste fornyelse, og ingen lokal modell kunne svare i stedet. Kreditten fornyes 15. desember. Du kan heve grensen med JARVIS_CLAUDE_BUDGET_USD eller skru av hardstoppen med JARVIS_CLAUDE_BUDGET_HARD_STOP=off.»
- Merknaden sier «den lokale modellen» **kun når en lokal modell faktisk svarte**; svarte noe annet (egen preferanseliste), står det «kom ikke fra Claude».
- Eier-override: `JARVIS_CLAUDE_BUDGET_HARD_STOP=off` + restart. Da fortsetter egne turer og bestilte jobber på Claude over 100 % (og det koster penger hvis kreditten faktisk er tom), bakgrunn går fortsatt lokalt, og du får bare varsel. Ingen kunstig godkjenningssperre for eier (D-41), og ingen automatisk påfyll eller kjøp - aldri.

## Se det
- **AI-senteret** (`/control` → AI → Kost, eller «vis kontrollsentrene» i web-chat fra en signert enhetsøkt - `executive.get_control_center`, kun lesing, ingen nytt verktøy): tre elementer - **kreditten** (brukt i USD og kr, nivå, kurve, dag i perioden, rom per døgn, prognose, hva som skjer på dette nivået), **forbruk siste 7/30 døgn per tier og formål**, og **antall kall styrt bort fra Claude** (nedgradert/utsatt/stengt, fra revisjonsradene `claude_budget.decision`). En kilde som ikke kan leses gir **UKJENT** for sitt element, aldri «i orden». **Disse elementene bygges ikke når mottakeren er en skymodell** (`restrictFinance`): AI-kostnad i øre følger strengeste regel inntil Q-64 er besvart, så en sky-Claude får ikke se dem.
- **Daglig brief:** én linje («Claude-kreditten: 38,10 av 100,00 USD brukt (38 %, ca. 400 kr) - på tempo. Dag 16 av 30, ...») under FYI når alt er i orden, under NEEDS ATTENTION med handling når det er stramt eller oppbrukt. Kan forbruket ikke leses, står «Connector utilgjengelig: claude-budget».
- **Telegram (worker):** varsel **én gang per terskel per kredittperiode** (50/75/90/100 % og når tempoet er over 1,3 x kurven). Flere terskler passert mellom to runder gir ÉN melding (høyeste tone) og alle markeres. Idempotensen er en revisjonsrad `claude_budget.alert` per (periode, terskel) - den overlever omstart og slettes aldri (audit er append-only). Markøren skrives ETTER levering: leveringsfeil gir nytt forsøk i neste runde (5 min), og en feil i selve markøren gir i verste fall ÉTT duplikat etter en omstart av workeren (instansen husker hva den har levert, så en vedvarende markørfeil gir aldri en melding hvert 5. minutt; heller dobbelt enn tapt). Runder går aldri samtidig. **Levering er minst-én-gang (ikke nøyaktig-én-gang):** en krasj mellom sending og markør, eller en ANDRE worker-replika, gir et duplikat. Det finnes ingen låsemekanikk for flere replikaer - **forutsetningen er ÉN worker** (slik compose kjører i dag); skaleres worker opp, kan hvert varsel komme én gang per replika. Varselet bruker vakthundens eksisterende Telegram-vei (samme sink som kostnadsvarselet D-395).
- **Spor og revisjon:** hvert vurdert kall gir en trace-span `budget` (nivå, tier, beslutning, årsak - aldri innhold). Kun beslutninger som GJORDE noe (nedgradert/utsatt/stengt), fail-safe og kall som tillates OVER en oppbrukt kreditt (eierens `HARD_STOP=off`: beviset på hvilke kall som gikk forbi kreditten) gir en revisjonsrad `claude_budget.decision`; en vanlig «tillat på tempo» står kun i sporet. **Tilskriving:** raden bærer kallets EGEN person (økta sin person, ellers jobbens eier); eieren kun for systemkall i eierens tenant, og `system` (actor_kind=system) i andre tenanter. **Telling:** en chat-verktøytur ved hard stopp (første forsøk med hard preferanse + samtalemotorens D-354-fallback) er ÉTT avvist kall og gir ÉN rad (fallbacken bærer den samme avvisningen i 10 s; et ubrukt merke kan i en flyt uten gjentakelse skjule raden til et neste kall fra samme jobb innen 10 s).

## Eier-override
- **Nå (WIRED):** miljø. Heve/senke kreditten: `JARVIS_CLAUDE_BUDGET_USD`. Hard stopp av: `JARVIS_CLAUDE_BUDGET_HARD_STOP=off`. Slå alt av: `JARVIS_CLAUDE_BUDGET_USD=off` (eller fjern linjen). Alle krever `docker compose up -d api worker`.
- **«Bruk mer denne måneden» fra chat/kontrollsenter (DEFERRED):** ikke bygget. Det som trengs: (1) et tilstandsfelt (eller en revisjonsbasert overstyring med utløp ved neste fornyelse) som `ClaudeBudgetEnforcer` leser ved hvert kall, i stedet for en prosess-env; (2) en handling i `/executive/mutate` (klasse C, step-up) som setter «løft til X USD eller hard stopp av til fornyelsen» med eksplisitt eier-bekreftelse; (3) en knapp i AI-senteret og et chat-uttrykk; (4) test av at overstyringen utløper ved fornyelsen og at den aldri kan settes av innhold. Ingen ny migrasjon er nødvendig hvis den lagres som revisjon/`owner_control_state`-lignende rad, men det er en egen WP.

## Lesing av forbruket (buffer, enkeltflyt, negativ buffer) og dekkende indeks
Håndhevelsen leser summen av Anthropic-radene i perioden (`cost_events`, tenant-RLS) før en beslutning. For at en treg database ikke skal forsterkes til en treg tur:
- **Fortsettelsesrunder leser ikke** (de bærer billetten fra forrige runde; se «Fortsettelsesregelen»). En 4-kalls verktøytur på en frisk database gjør dermed én lesing, ikke fire.
- **Buffer (3 s):** den leste summen gjenbrukes per tenant og kredittperiode i 3 sekunder (aldri over fornyelsen, aldri mellom tenanter). Bufferen har et **overlegg**: pågående reservasjoner + det hvert fullført kall (og hvert avbrutt kall, med anslaget) har bokført siden lesingen startet, så den ikke kan undervurdere forbruket fra denne prosessen.
- **Enkeltflyt:** samtidige kall for samme tenant og periode deler ÉN lesing.
- **Negativ buffer (30 s):** etter en lesefeil eller utløpt frist (3 s) hoppes lesingen over i 30 sekunder; fail-safe per tier gjelder så lenge (ESSENSIELL tillates, VIKTIG nedgraderes, BAKGRUNN utsettes), og deretter prøves lesingen igjen. En hengende database koster dermed ÉN frist (ikke én per kall), holder høyst én pool-klient, og eierens turer er upåvirket (test: fire kall mot en hengende database tar ca. én frist).
- **Dekkende indeks (migrasjon 115):** `CREATE INDEX IF NOT EXISTS cost_events_tenant_provider_at_idx ON cost_events (tenant_id, provider, at) INCLUDE (amount_ore)`. Med 300 000 rader valgte planleggeren et skann (RLS-predikatet slo ut den gamle `cost_events_tenant_at_idx`); den nye indeksen lar lesingen bli en index-only scan (bevist brukbar under RLS som `jarvis_app` i `wpb4-claude-budget-db.test.ts`). Rent additiv, `IF NOT EXISTS`; rollback = `DROP INDEX cost_events_tenant_provider_at_idx` (ingen avhengigheter). Under bygging tar `CREATE INDEX` en kort skrivelås på `cost_events` - tabellen er liten i drift og migratoren kjører før appen starter (etter backup).

## Hva som telles - og hva som IKKE telles
- **Telles:** alle modellkall gjennom `ModelGateway` med leverandør `anthropic` (`cost_events`, per tenant, inkludert kritikk-kall). **Avbrutte, utløpte og brutte kall bokføres med et ANSLAG, ikke 0 øre** (Anthropic fakturerer input og det som er generert før et avbrudd; taleavbrudd/barge-in er hovedkilden): inn-tokens fra forespørselen (tegn / 3) + ut-tokens fra tegnene som er strømmet så langt (tegn / 3, aldri mer enn `max_tokens`), priset med modellens sats. Gjelder kun feilklasser som kan være fakturert (cancelled, timeout, stream_interrupted, invalid_tool_call, invalid_response, og feil etter at tekst er generert); auth, kvote, dårlig forespørsel og serverfeil uten tekst er fortsatt 0 øre, andre leverandører er alltid 0 øre, og et kall som aldri ble sendt (avbrutt før et begrenset retry) får ikke et anslag. Raden er `kind = model:failed:<klasse>`, `success = false`, `model = (failed)` (tokenkolonnene er 0 - anslaget står kun i `amount_ore`). Uten Claude-kreditten er alt som før (0 øre). Forbruket er **et anslag fra tokenregnskapet** (innputt-/utputt-tokens x prislisten, kurs 10,5 kr/USD), **ikke Anthropics faktura**. `cost_events` slettes ikke av dagens oppbevaring (kostnadsledgeren beholdes; `073_operational_retention.sql`), så en periode på 31 døgn leses alltid helt.
- **Telles IKKE:**
  - **Claude Code-jobber (D-96, `ClaudeCodeAgent`)**: CLI-en kjøres i jobb-sandboxen med `ANTHROPIC_API_KEY` og går rett til Anthropic; kostnaden bokføres ikke i `cost_events`, så kreditten ser den ikke. Hvis jobbene bruker samme nøkkel som modellkallene, spiser de av samme 100 USD uten at tempokurven vet det - les Anthropic-konsollen. Bokføring av CLI-ens kostnad er **DEFERRED** (CLI-ens JSON-utgang leses i dag kun for `result`; om den bærer et kostnadsfelt er ikke verifisert her). Endringer i Claude Code-abonnement er utenfor denne WP-en.
  - API-bruk utenfor Jarvis med samme nøkkel, og manuelle verifiseringsskript som kaller adapteren direkte (`modules/model-gateway/scripts/d106-live-verify.ts` m.fl.). Live-skriptene som går via `ModelGateway` bokfører i `cost_events` (teller), men har ingen enforcer (blir ikke styrt av kreditten).
  - Andre leverandører (OpenAI, Gemini, ...): de teller i det eksisterende månedsbudsjettet (`JARVIS_COST_*`), ikke i kreditten.
- **Kalibrering:** sammenlign «brukt» i AI-senteret med Anthropic-konsollen etter en hel periode. Avviker de, juster `JARVIS_CLAUDE_BUDGET_USD` (f.eks. 95) til anslaget treffer. Hard stopp skjer ved 100 % av ANSLAGET - er anslaget for lavt kan faktisk forbruk passere 100 USD før Jarvis stenger.

## Verifiser på NAS (NOT VERIFIED - ingen av disse er kjørt)
Forutsetter at koden er oppdatert på NAS (se `NAS_UPDATE_HF1_HF2.md` for selve oppdateringen) og at du har satt `JARVIS_CLAUDE_BUDGET_USD=100` i `.env`.
1. `docker compose up -d api worker` (migrate-tjenesten anvender migrasjon 115 først; sjekk `SELECT indexname FROM pg_indexes WHERE indexname = 'cost_events_tenant_provider_at_idx';`). Forventet: begge starter. Feiler en av dem med «ugyldig JARVIS_CLAUDE_BUDGET_...», les meldingen og rett verdien.
2. `docker compose logs api worker | grep -i claude_budget`. Forventet: ingen `claude_budget_*_failed`-linjer.
3. Åpne `/control` → AI → Kost. Forventet: tre elementer (`Claude-kreditten (100 USD per periode, fornyes den 15.)`, forbruk, kall styrt bort fra Claude), nivå «på tempo» og riktig periode (15. → 15.). Tallene skal ligne Anthropic-konsollen innenfor anslagets nøyaktighet.
4. Still et spørsmål som går via Claude (f.eks. verktøytur, D-431) og se at «brukt» øker og at nivået stemmer med tabellen over.
5. **Hard stopp-test uten å bruke penger:** sett `JARVIS_CLAUDE_BUDGET_USD=1` (mindre enn det som allerede er brukt denne perioden), `docker compose up -d api worker`, still et Claude-spørsmål. Forventet: svar fra lokal modell med merknaden «Claude-kreditten: perioden er brukt opp ...». Sett verdien tilbake til `100` og restart.
   **Bivirkning:** testen gir 100 %-varsel i Telegram og skriver markører for denne perioden, så terskelvarslene (50/75/90/100 %) for inneværende periode er da «brukt opp». Kjør den derfor helst rett etter en fornyelse, eller godta at denne periodens varsler uteblir.
   **Alternativ i en dedikert testtenant (valgfritt, krever databasetilgang som eier):** sett inn syntetisk forbruk for testtenanten, f.eks. `INSERT INTO cost_events (tenant_id, kind, amount_ore, provider, model, purpose, success, session_id) VALUES ('<testtenant>', 'model:anthropic', 70000, 'anthropic', 'claude-sonnet-5-5', 'CHAT', true, 'b4-test');` (70 000 øre ≈ 66,67 USD = «stramt» midt i perioden). Se nivået i AI-senteret for den tenanten, og at BAKGRUNN går lokalt. Appen kan ikke slette raden (kun SELECT/INSERT); fjern den som databaseeier etterpå. Aldri i eierens egen tenant (det vrir eierens faktiske regnskap).
6. `JARVIS_CLAUDE_BUDGET_HARD_STOP=off`-test (valgfritt): samme som 5, men forvent at egne turer fortsatt går til Claude og at bare bakgrunn går lokalt.
7. Daglig brief neste morgen: forvent én linje om kreditten.
Noter resultat og dato i `docs/PROJECT_STATUS.md`/lukkematrisen først etter at stegene er kjørt - til da er alt over **NOT VERIFIED**.

## Rollback
Fjern `JARVIS_CLAUDE_BUDGET_USD` fra `.env` (eller sett `off`) og kjør `docker compose up -d api worker`. Effekten er umiddelbar: ingen enforcer, ingen hint, ingen varslingsrunde, ingen nye elementer. Det er **ingenting å rydde**: den eneste migrasjonen (115) er en ren indeks som kan bli stående (eller `DROP INDEX cost_events_tenant_provider_at_idx`), og revisjonsradene `claude_budget.decision`/`claude_budget.alert` er append-only bevis og skal bli stående. Kode-rollback: revert merge-commit (indeksen i migrasjon 115 kan bli stående; en migrasjon kjøres aldri tilbake).

## Kjente begrensninger (ærlig)
1. **Anslag, ikke faktura** (se over): avvik mellom prislisten og Anthropics faktiske avregning (cache-rabatter, batch, verktøygebyrer) gir avvik i begge retninger.
2. **Samtidige kall, buffer og overskridelsen ved 100 %:** api og worker har hver sin reservasjon i minnet (anslag = tegn/3 + `max_tokens`, maks 5 % av kreditten per kall, utløper etter 5 min, frigis alltid i `finally`). Innen én prosess er sjekk-og-reserver atomisk (test: seks samtidige kall på kanten gir nøyaktig tre). Den leste summen **bufres i 3 sekunder per tenant og kredittperiode** (se «Lesing av forbruket»); bufferen bygger alltid på pågående reservasjoner + det HVERT fullført kall bokførte siden lesingen startet (høyeste av reservasjonen og det som ble bokført), så forbruk fra DENNE prosessen aldri slipper forbi taket mens bufferen er gyldig - overskridelsen forblir høyst ÉT kalls kostnad (test med injisert klokke: 12 kall på en buffer gir nøyaktig tre tillatt, og totalen ender høyst ett kall over). **Dokumentert rest:** forbruk fra en ANNEN prosess (api mot worker) er usynlig for denne prosessens beslutning i inntil 3 sekunder (bufferen) - overskridelsen ved 100 % er derfor begrenset til anslaget for kallene som var på vei samtidig i begge prosesser, pluss det den andre prosessen bruker i løpet av 3 sekunder (typisk ett til to kall). Samme størrelsesorden: et kall som ferdigstilles akkurat mens et annet kall leser forbruket kan være usynlig for det andre kallets beslutning (feilen er ett kalls kostnad).
3. **Retry etter avkortet svar** vurderes ikke på nytt (samme beslutning gjelder; ekstra forbruk bokføres, men er ikke reservert på forhånd).
4. **Tier per rad i AI-senteret er utledet** (formål + jobb-id/økt-id); eksplisitte hint (delegerte jobber, rådet) lagres ikke i `cost_events`, så fordelingen per tier er en tilnærming. Formålsfordelingen er eksakt.
5. **Rådet:** briefen sier «rådsrunder = BAKGRUNN». Her er en EKSPLISITT bestilling («bruk AI-rådet») tolket som en bestilt oppgave (VIKTIG) og den automatiske triggeren som BAKGRUNN. Si fra hvis eksplisitte rådsrunder også skal være BAKGRUNN: det er én endring i `budgetHint` i `council.ts`. `JARVIS_CLAUDE_BUDGET_TIERS` kan bare endre tier per (opphav, formål), så den ville også ramme andre bestilte jobber med samme formål.
6. **Spesialistdelegering (`CODE`)** arver opphav fra konteksten (økt = egen tur, jobb = bakgrunn); den har ingen egen tier-regel.
7. **Varsler gjelder eierens tenant** (workeren varsler for `owner.tenant_id`); håndhevelsen gjelder alle tenanter hver for seg (hver tenant har sin egen kreditt-lesing med samme budsjett).
   **Én kreditt, flere tenanter:** kostnad leses per tenant (RLS, som kravet er), så hver tenant får hele rammen i sin egen telling. Deler flere tenanter samme Anthropic-nøkkel (f.eks. eierens egen og en virksomhetstenant), kan summen overstige den ekte kreditten selv om hver tenant er «på tempo». Med én aktiv tenant (eierens) er det identisk. Å summere på tvers krever en bevisst privilegert lesing (definer-funksjon) - eierbeslutning, ikke gjort her (se åpne spørsmål).
8. **Samtalehistorikk (N1, åpent hull):** tidligere lokale svar i en samtale er ikke merket som begrenset; kreditten bygger ikke på at historikken er ren. Chat-synlig tekst om kreditten har aldri beløp og unngår ordet «budsjett» (klassifiseringen reagerer på det); beløp står kun i AI-senteret, briefen og Telegram.
9. **Mot en ekte Anthropic-regning er ingenting verifisert** (se NAS-stegene).
10. **Varsler krever at worker kjører** (alerteren bor i `worker-main.ts`); uten worker finnes ingen Telegram-varsler, men håndhevelsen i api virker uavhengig. Levering er minst-én-gang og forutsetter ÉN worker (se «Se det»).
11. **Avbrutte kall er et anslag** (tegn/3 per token, aldri mer enn `max_tokens`): en norsk tekst har ofte litt flere tokens per tegn enn engelsk, og Anthropic kan avrunde annerledes - avviket går i begge retninger og er lite per kall.
12. **Retry-merket (10 s) og fortsettelsesregelen** er enkle, prosesslokale minnetilstander: de gir ingen varig tilstand, forsvinner ved omstart og kan aldri ÅPNE noe (de gjenbruker bare en stengt beslutning).

## Feilsøking
| Symptom | Sjekk |
|---|---|
| api/worker starter ikke | `docker compose logs api worker`: «ugyldig JARVIS_CLAUDE_BUDGET_...» - rett verdien (`0` er ugyldig; bruk `off`) |
| Claude brukes ikke lenger | AI-senteret → Kost: nivå? «stramt»/«oppbrukt» forklarer det; chat-merknaden sier også fra. Midlertidig: `JARVIS_CLAUDE_BUDGET_HARD_STOP=off` eller høyere `JARVIS_CLAUDE_BUDGET_USD` |
| Kost-elementene mangler | flagget er AV, eller du leser som en skymodell (`restrictFinance`) - åpne siden selv, eller bruk lokal modell |
| Elementet står som UKJENT | kilden (`cost_events`/`audit_events`) kunne ikke leses; se `docker compose logs api` for `claude_budget_*`. Håndhevelsen går da fail-safe (ESSENSIELL tillatt, VIKTIG nedgradert, BAKGRUNN utsatt) |
| Ingen Telegram-varsel | worker kjører? `docker compose logs worker \| grep claude_budget_alert`: `delivery_failed` = Telegram-veien; `markers_unreadable` = audit-lesing |
| Duplikat-varsel | markør-skrivingen feilet (`claude_budget_alert_marker_failed`) og workeren ble restartet etterpå, eller det kjører mer enn én worker: levering er minst-én-gang. Sjekk at `audit_events` kan skrives og at det bare finnes én worker |
| Mange `spend_unreadable_*`-beslutninger rett etter hverandre | en hengende/feilende database: etter første feil/frist hoppes lesingen over i 30 s (negativ buffer), så alle kall går fail-safe i den tiden og deretter prøves lesingen på nytt. Se «Lesing av forbruket» |
| Et avbrutt kall har en `model:failed:cancelled`-rad med øre | riktig: avbrutte Anthropic-kall bokføres med et anslag (se «Telles») |
| Tallene ligner ikke Anthropic-konsollen | se «Kalibrering» og «Telles IKKE» (Claude Code-jobber!) |
