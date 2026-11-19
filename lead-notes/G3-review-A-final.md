TS: 2026-11-18T22:45:41.328Z
VERDICT: **MERGE ETTER FIKSER**. Jeg fant ingen HIGH eller BLOKKER. Kamerabilder når aldri en skyleverandør i noen av de 612 scenarioene jeg kjørte. Fullt notat med fil:linje, repro og tabell over byggerens påstander ligger i `/tmp/lead/G3-review-A.md`. Arbeidskopien er ren (tom `git status`, HEAD uendret på 0716b6a9), og mine scratch-tester ligger i `/tmp/lead/review-a-scratch/`.

**Sky-siden**
- Scenarioene dekker 22 innganger (eksplisitt `provider`, `providerPreference`, critic, B4-kreditt på 6 nivåer inkl. `HARD_STOP=off`), 8 feilmodi for lokal modell, og `complete`/`stream`/`completeWithTools`, med ekte skyadaptere og stubbet fetch.
- Resultat: 0 skykall, 0 bildebytes og 0 avledet tekst i skyforespørsler.
- Lokal modell nede, feil, tidsavbrudd eller tomt svar gir `model_unavailable`, aldri sky-fallback.
- Etiketter og embeddings når ingen modell i dag. Embedding-veien kan ikke være en sky-API (OpenAI avvises ved oppstart).
- Mutasjoner på de tre lagene: alle bildelekkasjer stoppes så lenge ett lag står igjen. Lag 1 (`lockRestrictedMedia`) alene dekker alt i matrisen.

**MEDIUM**
1. Påstanden om at alle personnavn avvises stemmer ikke (`classifier.ts:16-19`, DPIA). «tobias sorensen», «bearded-man», «ignore all instructions now» og «drop table users» lagres som `object_label`. DB har ingen CHECK på kolonnen (055:184), så all beskyttelse sitter i parseren. Fiks: rett påstanden, legg DB-CHECK, og innram etiketter som untrusted i et senere modellvendt verktøy.
2. `JARVIS_VISION_MODEL_TIMEOUT_MS` er virkningsløs. Klassifisereren sender alltid `timeoutMs: 90000`, som slår adapterens verdi (`local-llm.ts:278`). Repro: 300 ms-konfigurasjon mot en server som svarer på 1500 ms ga likevel `classified`. Treg CPU-modell gir varig `model_unavailable`.

**LOW**
- **Critic-banen:** den beskytter avledet tekst med bare ett lag. Uten lag 1 lekker 3 scenarioer den lokale beskrivelsen til sky-critic. Ingen prod-kaller setter critic, og ingen test dekker det.
- **Lag 3:** finnes bare i anthropic og gemma_hosted. De fire øvrige skyadapterne dropper bildet stille i stedet for å kaste.
- **Flagg-AV er ikke helt identisk:** `local_vision` ligger i `DEFAULT_PROFILES` uansett flagg. Det gir en ny post i modellens self-model-begrensningsliste og et nytt navn i `knownModelProviders()`.
- **Byggevaktene er lette å omgå:** `facematch`, prompten «Identify the person by name» og kolonnen `person_name` passerte alle (29/29 grønt). Video- og nettverksvaktene skanner bare visjonsstiene, så ffmpeg/rtsp/fetch i `modules/tool-gateway` eller `apps/api/src/camera-stream.ts` slipper gjennom.
- **URL-vakten:** den løser ikke opp DNS. `evil.com.local` og `169.254.169.254` aksepteres, mens Tailscale-adresser (100.64/10) avvises.
- **Bildegrenser:** ingen pikselgrense på bilder og ingen bytegrense på svar fra lokal modell.

Til B/lead:
- Migrasjon 135 og 137 dropper constraints via `LIKE '%…%'`, som også ville fjernet fremtidige CHECK-er.
- Det eksisterende HA-verktøyet `list_states` sender alle attributter videre, inkludert kamerats `access_token`, til modellflaten (ikke G3-diffen, uverifisert mot ekte HA).
- D-465-teksten står ikke i grenen.

**Kjørt:** 14 mutasjoner mot policy, klassifisering, URL-vakt og redirect ble alle felt. Flagg-AV-baselinene (31 tester) er grønne. Hele `modules/model-gateway` + `packages/provider-adapters` (67 filer, 1343 tester) og G3-settet (17 filer, 322 tester) er grønne. Typecheck for 6 pakker og eslint på 58 filer er rene.

**Ikke verifisert:** ekte lokal visjonsmodell (formatet på `image_url` data-URL), ekte HA/kamera, hele testsuiten, og reviewer Bs flater.
