# Jarvis – databehandler- og regionmatrise

**Status:** v1.0-skjelett (fase 1-krav: eksplisitte felter for LLM, STT, TTS og realtime).
Fylles ut FØR en leverandør tas i bruk; «TBD / benchmark required» betyr at valget ikke er tatt.

**Oppdatert 2026-09-05 (D-122, UA-7 kriterium 4):** STT- og TTS-radene sto `TBD` samtidig som
`apps/voice-gateway` faktisk kalte OpenAI live (host-bevist, se `RUNTIME_GATES.md` BO-12). En
`TBD`-rad ved siden av et live leverandørkall er en USANN rad. Radene NAVNGIR derfor nå behandleren
som er i bruk — det er **ikke** det samme som at vilkårene er avklart: region, databehandleravtale,
treningsvilkår og leverandør-retensjon står eksplisitt som `IKKE VERIFISERT` og krever en
eier-/juridisk handling (**Q-32**). Full vurdering: `docs/UA7_COMMUNICATIONS_DPIA.md`.

**Rettet 2026-09-05 etter uavhengig arkitekt-review av PR #71 (samme D-122, ingen ny beslutnings-ID):**
første versjon lot en NAVNGITT rad alene kvalifisere en ekstern behandler i koden — altså regel 1
håndhevet, regel 3 ikke. Det gjorde denne filens egen regel 3 til en ren tekstpåstand. Regel 3 er nå
også strukturell: en ekstern behandler må ha `processor_terms_status: "VERIFIED"` for å slippe
gjennom `evaluateSpeechRouting()`. **Konsekvens, uttrykt rett ut: OpenAI STT/TTS er i dag AVVIST for
ALLE memory spaces**, ikke bare `health`. Talekjeden fra BO-12 er dermed policy-blokkert til Q-32
faktisk er besvart av eieren. Det er den ærlige tilstanden — ikke en regresjon som skjules.

| Kategori | Leverandør | Tjeneste | Region | Databehandleravtale | Trener på data? | Retensjon hos leverandør | Tillatte memory spaces | Status |
|---|---|---|---|---|---|---|---|---|
| LLM | TBD / benchmark required | – | – | – | – | – | – | Velges i fase 3 (D-14/Q-04) |
| LLM (lokal) | TBD | – | lokalt (NAS/PC) | ikke relevant | nei | ingen | alle inkl. health (D-23) | Vurderes fase 3+/10 |
| STT | OpenAI | `POST /v1/audio/transcriptions` (`whisper-1`) — rå wav sendes ut av huset | IKKE VERIFISERT | IKKE VERIFISERT | IKKE VERIFISERT | IKKE VERIFISERT | **INGEN** — avvist for alle spaces til regel 3 er oppfylt | **KONFIGURERT baseline, men POLICY-BLOKKERT** (`processor_terms_status: "NOT_VERIFIED"`). Raden er NAVNGITT (regel 1 ok), IKKE verifisert (regel 3 ikke ok) — Q-32. Ingen lyd sendes ut av huset så lenge raden står slik |
| STT (lokal) | whisper.cpp | `LocalWhisperStt` (`JARVIS_WHISPER_BIN`) | lokalt | ikke relevant | nei | ingen | alle inkl. `health` (D-23) | **IKKE I BRUK** — `startStream()` kaster `local_whisper_not_implemented_in_pilot`. Dette er grunnen til at `health`-tale i praksis avvises i dag (`UA7_COMMUNICATIONS_DPIA.md` §7.1) |
| TTS | OpenAI | `POST /v1/audio/speech` (`gpt-4o-mini-tts`) — svartekst sendes ut av huset | IKKE VERIFISERT | IKKE VERIFISERT | IKKE VERIFISERT | IKKE VERIFISERT | **INGEN** — avvist for alle spaces til regel 3 er oppfylt | **KONFIGURERT baseline, men POLICY-BLOKKERT** (`processor_terms_status: "NOT_VERIFIED"`). Raden er NAVNGITT, IKKE verifisert — Q-32 |
| TTS (lokal) | piper | `LocalPiperTts` (`JARVIS_PIPER_BIN`) | lokalt | ikke relevant | nei | ingen | alle inkl. `health` (D-23) | **IKKE I BRUK** — `synthesize()` kaster `local_piper_not_implemented_in_pilot` |
| Realtime (tale-til-tale) | TBD / benchmark required | – | – | – | – | – | – | Egen kategori i fase 5-benchmark — IKKE i bruk |
| Embeddings | TBD | – | – | – | – | – | – | Velges i fase 4 |

## Regler

1. En rad med «TBD» kan ikke tas i produksjonsbruk. Punktum.
   **D-122: håndhevet strukturelt for tale-siden** — en ekstern STT/TTS-behandler uten en navngitt
   rad her har `processor_row_declared: false` og avvises av `evaluateSpeechRouting()`
   (`packages/contracts/src/speech.ts`) for ALLE memory spaces. En ny leverandør kan derfor ikke
   legges til stille uten at denne matrisen oppdateres først.
2. `health`-space kan aldri sendes til en radleverandør uten egen eksplisitt beslutning + sterk
   minimering (D-23, CANONICAL_SPEC §3).
   **D-122: håndhevet strukturelt for tale-siden, men KUN så langt space-verdien er til å stole på**
   — `health` klassifiseres `SECRET_RESTRICTED` og avvises mot enhver `locality: "external"`-behandler,
   fail-closed og uten stille fallback. En ukjent/manglende memory space tolkes ALDRI som lav-sensitiv.
   **Viktig forbehold (arkitekt-review av PR #71):** i voice-transporten oppgis `memory_space` av
   KLIENTEN og valideres ikke mot en server-side sesjonsautoritet, så en feilmerket samtale kan ikke
   avsløres av porten. Derfor kan en kun klient-oppgitt space ikke KVALIFISERE for ekstern behandling
   i det hele tatt (`DENIED_MEMORY_SPACE_NOT_SERVER_VERIFIED`) — den kan bare NEKTE. D-23 er dermed
   IKKE påstått ferdig lukket for tale; garantien fullføres først når en betrodd server-side
   space-autoritet finnes (**Q-32**). Bevist i `apps/voice-gateway/test/ua7-speech-routing.test.ts`
   (seksjon F, adversarielle tester). For LLM-siden gjelder den EKSISTERENDE `isSensitivityEligible()`
   (D-79/D-81) uendret — tale-porten er en gjenbruk av samme regelform, aldri en parallell
   sikkerhetsvei.
3. Hver utfylt rad krever: verifisert region, signert/akseptert databehandleravtale, dokumenterte
   trenings- og retensjonsvilkår, og dato for kontroll (vilkår endrer seg – kontrolleres på nytt ved
   implementasjon eller kjøp, jf. masterplanen).
   **D-122: håndhevet strukturelt for tale-siden** — feltet `processor_terms_status` på
   `SpeechProcessorDeclaration` (`packages/contracts/src/speech.ts`) er den kanoniske statusen for
   denne regelen. Kun `VERIFIED` kvalifiserer en ekstern behandler; `NOT_VERIFIED` er fail-closed
   default (også når feltet mangler helt), og en ekstern behandler kan ikke slippe unna ved å påstå
   `NOT_APPLICABLE_LOCAL`. Verdien settes KUN sammen med at radens felter over faktisk fylles ut og
   dateres — aldri for å få en talekjede i gang igjen. Jarvis utleder ALDRI verdien selv, og feltet
   inneholder ingen juridiske vurderinger eller hemmeligheter, kun en registrert status.
4. Matrisen revideres ved hvert leverandørvalg og minst per fase-port.
