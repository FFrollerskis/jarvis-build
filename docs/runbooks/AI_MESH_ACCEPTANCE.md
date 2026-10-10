# AI Mesh akseptanse (UA-1): «≥3 live providers med fallback og kost-synlighet»

**Formål:** vise, med dine egne nøkler, at Jarvis' AI Mesh faktisk har minst tre leverandører som svarer, at en
fallback virker når én av dem er nede, at hver leverandørs kostnad er synlig - og at helse/økonomi/hemmeligheter
(`SECRET_RESTRICTED`) aldri havner hos en skyleverandør. Dette er **WP-D4** (JARVIS-033/036/078).

Claude Code sitt sandbox-miljø har hverken dine nøkler eller nett mot leverandørene. Alt under er derfor bygget og
testet mot lokale fake-servere og ekte Postgres, men **`NOT VERIFIED` mot ekte leverandører** til du har kjørt det.
Røyktesten gjør alt arbeidet og skriver en evidensfil uten hemmeligheter - du trenger ikke feilsøke noe internt.

## 0. Hva «akseptert» betyr (fire punkter, alle må holde)

| # | Krav | Slik bevises det |
|---|---|---|
| 1 | ≥3 leverandører er **bevist live** | ett lite kall per konfigurert leverandør må gi **synlig tekst** (`LIVE`). Transportsuksess uten tekst er `EMPTY_OUTPUT`, ikke live (D-106) |
| 2 | **Fallback er bevist** | én live leverandør **sperres** (en wrapper som alltid feiler uten å røre nettet), ett kall gjennom den ekte `ModelGateway` med kjeden `[sperret, …øvrige]`; en annen må svare og svaret må være merket som fallback fra den sperrede. Med `--db` leses kostraden tilbake og må ha `fallback = true` |
| 3 | **Kost er synlig** | kall, feil, kostnad, tokens og p50-latens **per leverandør siste 7 døgn** i `executive.get_ai_mesh_status` (leses fra `cost_events`) |
| 4 | **Sensitivitetsporten holdt** | `SECRET_RESTRICTED` mot en kjede der skyleverandørene står **først** kaller aldri en skyleverandør (frakoblet test med tripwire-adaptere, ingen nettkall). Ett skykall gir `FAIL` uansett hvor mange som er live |

Kostnad: ett kall med maks 256 tokens ut per leverandør, hele kjøringen har kostnadstak (`--max-cost-ore`, standard 100 øre).
Når taket nås stopper kjøringen og verdiktet blir `INCOMPLETE` - aldri en falsk `PASS`.

## 1. Forutsetninger: nøkler og adresser

Legg dem i `.env` på NAS-en (aldri i chat, aldri i `.env.example`) og kjør
`sudo docker compose --env-file .env -f infra/local/docker-compose.yml up -d` slik at api-containeren leser dem.
Skriptet leser nøklene fra miljøet via adapterne og **skriver dem aldri** (evidensen avvises før skriving hvis den inneholder noe som ligner en hemmelighet).

| Leverandør | Slå på med | Merknad |
|---|---|---|
| `gemma_local` | `JARVIS_GEMMA_LOCAL_URL` (+ `JARVIS_GEMMA_LOCAL_MODEL`) | lokal, gratis. ROOT-URL uten `/v1` (se `D106_LOCAL_GEMMA_HOST_ACCEPTANCE.md`) |
| `local_llm` | `LOCAL_LLM_BASE_URL` (+ `LOCAL_LLM_MODEL`) | lokal, valgfri |
| `ollama` | `JARVIS_OLLAMA_URL` | lokal, valgfri |
| `gemma_hosted` | `GEMMA_API_KEY` (faller tilbake til `GEMINI_API_KEY`) | sky, gratis delt tier - brukes kun for lav sensitivitet |
| `kimi` | `KIMI_API_KEY` (+ `JARVIS_KIMI_MODEL`, `JARVIS_KIMI_URL`) | sky. Standard: `kimi-k3` / `https://api.moonshot.ai` |
| `hermes` | `HERMES_API_KEY` (+ `JARVIS_HERMES_MODEL`, `JARVIS_HERMES_URL`) | sky. Standard: `Hermes-4-70B` / `https://inference-api.nousresearch.com` |
| `anthropic` | `ANTHROPIC_API_KEY` | sky, betalt |
| `openai` | `OPENAI_API_KEY` | sky, betalt |
| `gemini` | `GEMINI_API_KEY` (+ `JARVIS_GEMINI_MODEL`) | sky, betalt |

Anbefalt minimum: `gemma_local` (lokal) pluss to uavhengige skyleverandører. `gemini` og `gemma_hosted` går mot **samme leverandør (Google)**:
skriptet teller begge, men advarer om at de ikke er uavhengige ved et Google-utfall.

## 2. Steg 1: se status uten å bruke penger

Skriv i chatten: «hvordan står AI-mesh-en?» (også «hvilke modeller har du», «fungerer Kimi og Hermes», «er fallback i orden», «hva koster modellene»).
Verktøyet `executive.get_ai_mesh_status` er klasse A (kun lesing), gjør **aldri** et modellkall, og viser ukjent som ukjent. Før røyktesten forventer du omtrent dette:

```
AI Mesh (kun observasjon): 0 av 3 nødvendige leverandører er bevist live, fallback observert 0 ganger siste 7 døgn. Akseptansen «≥3 live providers med fallback»: IKKE OPPFYLT ennå.
Router: HEALTHY. Standardkjede for vanlig prat: gemma_local → gemma_hosted (siste reserve: vanlig ruting).
- gemma_local (lokal): konfigurert, aldri bevist · 7 døgn: 0 kall, 0 feil, 0,00 kr
- kimi (sky): konfigurert, aldri bevist · 7 døgn: 0 kall, 0 feil, 0,00 kr
- hermes (sky): konfigurert, aldri bevist · 7 døgn: 0 kall, 0 feil, 0,00 kr
- anthropic (sky): ikke konfigurert
Mangler: Bare 0 av 3 nødvendige leverandører er bevist live (konfigurert, men aldri bevist: gemma_local, kimi, hermes). Ingen vellykket fallback er observert (…) - kjør mesh-live-smoke.ts.
```

«Konfigurert» betyr kun at nøkkel/URL er satt (presence, aldri verdien) - det er **ikke** det samme som bevist.

## 3. Steg 2: kjør røyktesten

**På NAS-en (anbefalt)** - kjøres inne i den kjørende api-containeren, som allerede har nøklene, databasetilgangen og eierens tenant (`JARVIS_TENANT_ID`):

```
sudo docker compose --env-file .env -f infra/local/docker-compose.yml exec -T api \
  node --experimental-transform-types modules/model-gateway/scripts/mesh-live-smoke.ts \
  --db --tools --parallel --out /tmp/mesh-smoke.json
```

`--out /tmp/…` er nødvendig i containeren: rotfilsystemet er skrivebeskyttet (`/tmp` er tmpfs). Skriptet sjekker skrivbarheten **før** det gjør noe betalt kall.
Utenfor Docker (dev-maskin, `.env` lastet i miljøet) holder det med `node --experimental-transform-types modules/model-gateway/scripts/mesh-live-smoke.ts --tools --parallel`
(uten `--db`: ingen kostrader, ingen database).

| Flagg | Betydning |
|---|---|
| `--providers a,b` | begrens til disse leverandørene (standard: alle konfigurerte). Ukjente navn avvises |
| `--block <navn>` | leverandøren som sperres i fallback-testen (standard: første live i rekkefølgen lokale → sky) |
| `--tools` | verktøykall (kall, rundtur med resultat, streaming) for live leverandører som oppgir `tool_calling` - se §7 |
| `--parallel` | kontrollert måling av parallell-delegerings-overhead (alene-kall mot samtidige kall) - se §8 |
| `--solo-calls N` / `--parallel-calls N` | antall alene-kall (2-10, standard 3) / samtidige kall (2-6, standard 3) per leverandør |
| `--max-cost-ore N` | kostnadstak for hele kjøringen i øre (1-10000, standard 100) |
| `--timeout-ms N` | tidsavbrudd per modellkall (1000-120000, standard 30000) |
| `--out fil.json` | evidensfil (standard `var/mesh-smoke/mesh-smoke-<tid>.json`, git-ignorert) |
| `--db` | fase 1 og fallback-kallet går gjennom den **ekte `ModelGateway`** og skrives som vanlige kostrader i `cost_events` for eierens tenant (§5) |
| `--tenant id` | tenant for `--db` (standard `JARVIS_TENANT_ID`; uten begge avvises `--db` - skriptet gjetter aldri en tenant) |

Avslutningskode: **0 = PASS**, **1 = FAIL**, **2 = INCOMPLETE** (for få konfigurerte leverandører, kostnadstak, uskrivbar evidens) eller ugyldige flagg.
Linjene `{"msg":"model_attempt_failed","provider":"…","kind":"network"}` i utskriften er **forventet støy**: den sperrede leverandøren feiler med vilje.

Forventet utskrift (eksempel fra en testkjøring mot fake-servere uten `--db` - tallene dine vil avvike, og med `--db` står `(med database)`):

```
AI Mesh røyktest (uten database): PASS
  gemma_local  lokal  LIVE - 73 ms, 21/2 tokens, 0 øre
  local_llm    lokal  IKKE KONFIGURERT
  ollama       lokal  IKKE KONFIGURERT
  gemma_hosted sky    IKKE KONFIGURERT
  kimi         sky    LIVE - 15 ms, 21/2 tokens, 1 øre
  hermes       sky    LIVE - 12 ms, 21/2 tokens, 1 øre
  anthropic    sky    IKKE KONFIGURERT
  openai       sky    IKKE KONFIGURERT
  gemini       sky    IKKE KONFIGURERT
  fallback: PROVEN (gemma_local sperret → svart av kimi)
  sensitivitetsport (SECRET_RESTRICTED): PASS (SERVED_LOCAL, skykall 0)
  verktøy kimi: kall=TOOL_CALL_OK rundtur=ROUNDTRIP_OK streaming=STREAM_TOOL_CALL_OK
  verktøy hermes: kall=TOOL_CALL_OK rundtur=ROUNDTRIP_OK streaming=SKIPPED
  parallell kimi: alene p50 8 ms, samtidig p50 24 ms, overhead +16 ms
  kostnad: 19 av 100 øre

Evidens skrevet: /tmp/mesh-smoke.json
```

Med `--db` står det i tillegg `fallback: PROVEN (… ; kostraden har fallback=true)` og en linje
`Kostrader i cost_events for <din tenant>: N rader (task_id smoke-…-probe og smoke-…-fallback)`.

## 4. Steg 3: les resultatet

- **PASS** = minst tre leverandører `LIVE` **og** `fallback: PROVEN` **og** sensitivitetsporten `PASS`. Da er punkt 1, 2 og 4 i §0 bevist for din konfigurasjon.
- **FAIL** = noe er konfigurert men virker ikke, fallback er ikke bevist, eller (verst) `SECRET_RESTRICTED` nådde en skyleverandør. Linjene under tallene sier hvilken og hvorfor.
- **INCOMPLETE** = du må gjøre noe først (for få nøkler) eller kostnadstaket stoppet kjøringen.

Evidensen ligger i containerens `/tmp` (nullstilles ved omstart). Les den ut slik:

```
sudo docker compose --env-file .env -f infra/local/docker-compose.yml exec -T api cat /tmp/mesh-smoke.json
```

Den har skjemaet `jarvis.mesh-smoke/1`: per leverandør `status` (`LIVE`/`EMPTY_OUTPUT`/`FAILED`/`NOT_CONFIGURED`/`SKIPPED_COST_CAP`), latens, tokens, øre, `finish_reason` og en kort, redigert feilklasse/-kode;
`fallback` (sperret, kjede, hvem som svarte, `fallback_from`, `blocked_attempts`, `gateway_state`, `cost_row_fallback`); `sensitivity_gate`; valgfritt `tools` og `parallel`; `cost` og `cost_rows`;
samlet `verdict`, `reasons` og `notes`. Den inneholder **aldri** nøkler, URL-er eller innhold fra modellsvar - du kan lime den inn i en review.

## 5. Steg 4: bekreft kost-synlighet i statusverktøyet

Rett etter en `--db`-kjøring (ingen omstart nødvendig) spør du Charlie igjen: «hvordan står AI-mesh-en?». Forventet:

```
AI Mesh (kun observasjon): 3 av 3 nødvendige leverandører er bevist live, fallback observert 1 ganger siste 7 døgn. Akseptansen «≥3 live providers med fallback»: OPPFYLT (observert i trafikk eller røyktest).
- gemma_local (lokal): bevist live siste 7 døgn (ingen trafikk i denne prosessen siden oppstart) · p50 410 ms · 7 døgn: 2 kall, 2 feil, 0,00 kr
- kimi (sky): bevist live siste 7 døgn (…) · p50 1200 ms · 7 døgn: 2 kall, 0 feil, 0,03 kr
- hermes (sky): bevist live siste 7 døgn (…) · p50 950 ms · 7 døgn: 1 kall, 0 feil, 0,02 kr
```

(Tallene er illustrasjon.) `gemma_local` viser 2 feil fordi den ble sperret med vilje; det er de feilede radene fra fallback-testen. Rapporten teller en leverandør som bevist live når den enten er `LIVE` i
denne prosessen eller har minst ett vellykket kall siste 7 døgn; røyktesten kjører i en annen prosess enn api-et, så beviset kommer fra `cost_events`, ikke fra prosessens eget minne.

Kontroll direkte i databasen (radene fra røyktesten er vanlige kostrader og teller i 7-døgnstallene til de er eldre enn 7 døgn):

```
sudo docker exec -it $(sudo docker ps -qf name=postgres) psql -U postgres -d jarvis -P pager=off -c \
  "SELECT provider, success, fallback, task_id, amount_ore, latency_ms FROM cost_events WHERE task_id LIKE 'smoke-%' ORDER BY cost_id DESC LIMIT 20;"
```

Forventet: én rad per live leverandør med `task_id` som ender på `-probe`, og under `-fallback` feilede rader for den sperrede leverandøren pluss **én** vellykket rad med `fallback = t` for reserven.
**Ikke** med i cost_events: `--tools`/`--parallel` (målinger rett mot adapteren, ikke trafikk - kostnaden står i evidensen under `cost`/`tools`/`parallel`).

**Bivirkning du bør kjenne til:** radene er vanlige modellrader (`purpose = QUICK_CLASSIFICATION`, `task_id` starter med `smoke-`), så de teller også i SLO-serien «model:BACKGROUND» (suksessrate og latens), i 30-dagers run-rate og i
kostnadstallene (noen få øre). Den sperrede leverandørens to feilede forsøk kan gi et kortvarig utslag i SLO-suksessraten når trafikken ellers er lav. Leser du `cost_events` direkte og vil se bort fra røyktesten, bruk `task_id NOT LIKE 'smoke-%'`.

## 6. Hvis noe feiler

| Utfall | Betyr | Gjør |
|---|---|---|
| `IKKE KONFIGURERT` | nøkkel/URL mangler i api-containerens miljø | legg den i `.env`, kjør `docker compose … up -d`, kjør igjen |
| `FAILED (auth)` | leverandøren avviste nøkkelen | sjekk nøkkel, kontotype og modellnavn (`JARVIS_KIMI_MODEL`/`JARVIS_HERMES_MODEL`) |
| `FAILED (rate_limit)` | for mange kall / lav tier | vent og kjør med `--providers` for én om gangen |
| `FAILED (timeout)` / `(network)` | ingen kontakt (feil URL, lokal modell nede, brannmur) | sjekk URL fra containeren; `gemma_local`: ROOT-URL uten `/v1` |
| `FAILED (BudgetExceededError)` | (kun med `--db`, som går gjennom gatewayen) budsjettvakten nektet kallet (månedsbudsjett) | heve grensen med signert overstyring eller vente - røyktesten omgår aldri budsjettvakten |
| `FAILED (NoEligibleProviderError)` | leverandøren er ikke konfigurert eller helsen er `UNAVAILABLE` | se status i §2 |
| `EMPTY_OUTPUT` | svaret kom, men uten synlig tekst (tenkemodell brukte budsjettet, `finish_reason=length`) | bytt modell for leverandøren; ikke bruk den som live før den gir tekst |
| `fallback: NOT_PROVEN - kostraden ble ikke funnet i cost_events` | `--db`: tenanten finnes ikke eller databasen er ikke skrivbar (se `model_cost_bookkeeping_failed` i utskriften) | sjekk `JARVIS_TENANT_ID` / `--tenant`; fallback-kallet selv kan likevel ha virket |
| `fallback: NOT_PROVEN - den sperrede leverandøren ble aldri forsøkt` | kjeden startet ikke med den sperrede | meld til arkitekt (feil i kjeden) |
| `INCOMPLETE - Bare N konfigurerte leverandører` | færre enn tre nøkler | legg inn flere |
| `FAIL … SIKKERHET: SECRET_RESTRICTED nådde en skyleverandør` | **sikkerhetsbrudd i ruteren** | **STOPP.** Bruk ikke skynøkler i produksjon før dette er rettet; send evidensfilen til arkitekten |

## 7. Verktøykall for Kimi og Hermes (`--tools`, JARVIS-036)

Adapterene for Kimi (OpenAI-kompatibelt `tools`/`tool_calls`, SSE-streaming) og Hermes (modellens eget prompt-protokoll med `<tool_call>`-tagger; hosted `tools` er udokumentert, så adapteren sender aldri `tools`)
er bevist mot fake-servere i testene. Registeret påstår `tool_calling` for dem **kun** fordi testene beviser det - **mot ekte Moonshot/Nous er det ikke verifisert før du har kjørt `--tools`.**
Testverktøyet `smoke_get_time` utfører ingenting; skriptet leverer selv et falskt resultat tilbake i «rundtur»-steget.

**Erklæring (gjennomgang av PR #315, M3):** registeret påstår `tool_calling` for Kimi og Hermes (Kimi også `streaming`), men AUTO-ruting **bruker det ikke på tillit**. Uten din erklæring velges Kimi/Hermes aldri automatisk til en verktøyløkke
(bakgrunnsjobber med verktøy, den siste reserven D-354/D-404) og Kimi aldri som reserve for strømmet chat - de rangerer ellers høyt (rimelige skymodeller med høy kvalitetsklasse). Kjør først `--providers kimi,hermes --tools`.
Når en leverandør ga `kall=TOOL_CALL_OK` og `rundtur=ROUNDTRIP_OK` (Kimi også `streaming=STREAM_TOOL_CALL_OK`), sett `JARVIS_MESH_TOOLS_VERIFIED=kimi` (eller `kimi,hermes`) i `.env` og kjør `docker compose … up -d` (api OG worker leser variabelen).
Tom/usatt = ingen erklært (standard). Ugyldig verdi (store bokstaver, mellomrom i navn, tomme ledd, mer enn 16 navn) = tom liste og en logglinje `mesh_tools_verified_invalid` - en skrivefeil aktiverer aldri noe.
Erklæringen åpner ingen annen port: helse/økonomi/hemmeligheter går fortsatt aldri til sky, `paid_models_allowed=false` og `mode: LOCAL` gjelder, og en leverandør som er nede hoppes over som før.
Dine **eksplisitte** valg påvirkes ikke: står Kimi/Hermes i `JARVIS_CHAT_CANDIDATES`, eller ber du om «bruk Kimi», brukes de uten erklæring. Får AUTO-ruting kun uerklærte leverandører å velge mellom, feiler kallet lukket med
`no_eligible_provider … ikke live-verifisert, utelatt fra AUTO-ruting: kimi:tool_calling …` - aldri et stille kall. Chattens verktøyturer er ellers upåvirket: de går til den faste verktøyruten (`JARVIS_TOOL_TURN_MODEL`, D-431) eller den lokale kjeden.

| Resultat per leverandør | Betyr |
|---|---|
| `kall=TOOL_CALL_OK rundtur=ROUNDTRIP_OK` | modellen kalte riktig verktøy og skrev et sluttsvar etter verktøyresultatet |
| `streaming=STREAM_TOOL_CALL_OK` | strømmen leverte ett komplett verktøykall (Kimi). `SKIPPED` for Hermes er korrekt: strømming påstås ikke |
| `NO_TOOL_CALL` | modellen svarte med tekst i stedet for å kalle verktøyet - registerpåstanden er **ikke bevist** for akkurat denne modellen. Prøv en annen modell via `JARVIS_*_MODEL`, eller meld tilbake |
| `INVALID_TOOL_CALL` | Hermes-parseren avviste svaret (ukjent verktøy, ugyldig JSON, ukjente nøkler, uavsluttet/nestet blokk). **Ingenting utføres** ved avvist parsing |
| `WRONG_TOOL` | modellen kalte et annet verktøy enn det som ble tilbudt - ingen rundtur gjøres |

## 8. Parallell-delegerings-overhead (`--parallel`)

Samme lille forespørsel kjøres N ganger etter hverandre, deretter M samtidig. `overhead` = p50 samtidig minus p50 alene (ms) og vises bare med minst tre vellykkede prøver i begge grupper.
Tallet fanger kø/rate-begrensning hos leverandøren, ikke modellkvalitet. Statusverktøyet viser en **indikativ** variant fra vanlig trafikk (innholdet er ikke likt) - denne kontrollerte målingen er den pålitelige.

## 9. Standardkjeden: flere kandidater i vanlig prat (JARVIS-033)

«Gemma først» (D-354) er fortsatt en **hard** preferanse: ingen stille skyfallback. Standardstien har nå en **kjede** med failover inne i gatewayen, og enhver reservebruk er synlig. Alt er uendret som standard.

```
# Ordnet, kommaseparert. Tom/usatt = gemma_local,gemma_hosted (som før). Ugyldig = standardkjeden.
JARVIS_CHAT_CANDIDATES=gemma_local,local_llm,gemma_hosted        # neste lokale modell, så gratis delt sky (kun lav sensitivitet)
JARVIS_CHAT_CANDIDATES=gemma_local,gemma_hosted,anthropic        # eksplisitt, betalt sky-reserve
# Siste reserve (D-354/D-404: kjør om gjennom vanlig ruting når hele kjeden er uttømt). Tom/usatt = on. off = strengt «kun kjeden». Ugyldig = off.
JARVIS_CHAT_AUTO_FALLBACK=on
```

Hver port gjelder **per medlem**: `SECRET_RESTRICTED` (helse, økonomi, hemmeligheter) er alltid kun lokal (D-378), `paid_models_allowed=false` respekteres, `gemma_hosted` krever eksplisitt lav sensitivitet, og
`mode: LOCAL` utelukker skymedlemmer. Et sky-medlem i kjeden brukes derfor **kun** når sensitivitet og betalingspolicy tillater det og du selv har satt det inn.
**Synlighet:** svaret får «(Reservemodell brukt: X var ikke tilgjengelig, så svaret kom fra den lokale modellen/skymodellen Y.)» (ikke på tale), og loggen har `wpd4_chat_reserve_used` (kun leverandørnavn, aldri innhold).
Prøv: pek `JARVIS_GEMMA_LOCAL_URL` mot en adresse som ikke svarer, still et harmløst spørsmål og se merknaden; still et helsespørsmål og se at det **aldri** kommer fra en skymodell (enten besvart lokalt eller avvist).

## 10. Rådets forslagsvei (JARVIS-078)

AI-rådet er en vurderingsrolle og får **aldri verktøy** (§30). Tidligere ga det kun tekst. Med bryteren på kan syntesen i tillegg foreslå **én** konkret handling, og et gyldig forslag blir et bekreftelseskort i den
eksisterende bekreftelsesveien (D-382) - **ingenting skjer før du godkjenner kortet.**

```
JARVIS_COUNCIL_PROPOSALS=on      # standard: av. KUN eksakt «on» slår den på («true»/«1»/«yes»/«ON» gir av + en logglinje)
```

Prøv i chatten: «bruk AI-rådet: legg til en todoist-oppgave om å ringe leverandøren». Du får rådets vurdering og, hvis rådet er enig (CONSENSUS/MAJORITY) og foreslår en handling:

```
Forslag fra rådet (IKKE utført): <hva som endres>
Handling: todoist__create_task · sikkerhetsklasse B · støttet av: … · uenig: …
Ingenting skjer før du godkjenner bekreftelseskortet i chatten eller dashbordet (gyldig i 15 minutter).
```

Så kortet «Venter på din godkjenning» → «Godkjenn og utfør» (utføres i serveren, nøyaktig én gang) eller «Avvis». Grensene (alle håndhevet i kode og testet):

- kun chattens handlingsnivå (klasse B/C, skriv/send/slett) på `web_chat` - **aldri** klasse D, betaling, kontroll, eier-/sikkerhetsnavnerom, tale, Telegram eller bakgrunn;
- klassen og effekten leses fra manifestet, aldri fra rådet; identitets-/scope-felt bindes fra din identitet; GitHub er låst til ditt repo; argumentene valideres mot det registrerte skjemaet;
- et delt eller degradert råd (SPLIT/DEGRADED) legger ikke frem noe å godkjenne; innlimt tekst (e-post, dokumenter) gir aldri et forslag; finanshandlinger gjør rådet `SECRET_RESTRICTED` (kun lokale modeller);
- et avvist forslag legges ikke frem igjen så lenge avvisningen er gyldig (15 minutter); et forslag som ikke kan legges frem sies ærlig («Ingenting er utført»).

## 11. Hva som fortsatt IKKE er bevist etter at du har kjørt dette

- Kvalitet er ikke målt (kun tilgjengelighet, latens og kostnad). Kostnad for embeddings og tale er ikke med.
- Tallene «siden oppstart» i statusverktøyet nullstilles ved omstart; 7-døgnstallene kommer fra `cost_events` og dekker api og worker.
- Sensitivitetsporten testes frakoblet med tripwire-adaptere mot den ekte ruteren - det beviser ruteren, ikke at en bestemt leverandør er uskyldig. Lokale modeller får helse/økonomi usladdet (D-378).
- `--tools`/`--parallel` er stikkprøver mot én enkel forespørsel; de beviser ikke at en liten modell bruker verktøy pålitelig i lange samtaler (D-449).
- Hosted Hermes: om `tools`-formatet finnes for din modell er udokumentert; adapteren bruker modellens eget tag-format. `NO_TOOL_CALL`/`INVALID_TOOL_CALL` er et gyldig, ærlig svar.
- Rådets forslagsvei er testet ende til ende med scriptede medlemmer og ekte Postgres, ikke med ekte rådsmedlemmer. Om en ekte syntesemodell holder formatet `proposed_action` ser du første gang du prøver.
