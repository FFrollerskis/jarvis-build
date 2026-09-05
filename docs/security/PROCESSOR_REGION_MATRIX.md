# Jarvis – databehandler- og regionmatrise

**Status:** v1.0-skjelett (fase 1-krav: eksplisitte felter for LLM, STT, TTS og realtime).
Fylles ut FØR en leverandør tas i bruk; «TBD / benchmark required» betyr at valget ikke er tatt.

**Oppdatert 2026-09-05 (D-122, UA-7 kriterium 4):** STT- og TTS-radene sto `TBD` samtidig som
`apps/voice-gateway` faktisk kalte OpenAI live (host-bevist, se `RUNTIME_GATES.md` BO-12). En
`TBD`-rad ved siden av et live leverandørkall er en USANN rad. Radene NAVNGIR derfor nå behandleren
som er i bruk — det er **ikke** det samme som at vilkårene er avklart: region, databehandleravtale,
treningsvilkår og leverandør-retensjon står eksplisitt som `IKKE VERIFISERT` og krever en
eier-/juridisk handling (**Q-32**). Full vurdering: `docs/UA7_COMMUNICATIONS_DPIA.md`.

| Kategori | Leverandør | Tjeneste | Region | Databehandleravtale | Trener på data? | Retensjon hos leverandør | Tillatte memory spaces | Status |
|---|---|---|---|---|---|---|---|---|
| LLM | TBD / benchmark required | – | – | – | – | – | – | Velges i fase 3 (D-14/Q-04) |
| LLM (lokal) | TBD | – | lokalt (NAS/PC) | ikke relevant | nei | ingen | alle inkl. health (D-23) | Vurderes fase 3+/10 |
| STT | OpenAI | `POST /v1/audio/transcriptions` (`whisper-1`) — rå wav sendes ut av huset | IKKE VERIFISERT | IKKE VERIFISERT | IKKE VERIFISERT | IKKE VERIFISERT | alle UNNTATT `health` (håndhevet, se under) | **I BRUK** som BO-12-baseline (`OPENAI_API_KEY` live i runtime). Raden er NAVNGITT, IKKE ferdig verifisert — Q-32 |
| STT (lokal) | whisper.cpp | `LocalWhisperStt` (`JARVIS_WHISPER_BIN`) | lokalt | ikke relevant | nei | ingen | alle inkl. `health` (D-23) | **IKKE I BRUK** — `startStream()` kaster `local_whisper_not_implemented_in_pilot`. Dette er grunnen til at `health`-tale i praksis avvises i dag (`UA7_COMMUNICATIONS_DPIA.md` §7.1) |
| TTS | OpenAI | `POST /v1/audio/speech` (`gpt-4o-mini-tts`) — svartekst sendes ut av huset | IKKE VERIFISERT | IKKE VERIFISERT | IKKE VERIFISERT | IKKE VERIFISERT | alle UNNTATT `health` (håndhevet, se under) | **I BRUK** som BO-12-baseline. Raden er NAVNGITT, IKKE ferdig verifisert — Q-32 |
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
   **D-122: håndhevet strukturelt for tale-siden** — `health` klassifiseres `SECRET_RESTRICTED` og
   avvises mot enhver `locality: "external"`-behandler, fail-closed og uten stille fallback. En
   ukjent/manglende memory space tolkes ALDRI som lav-sensitiv. Bevist i
   `apps/voice-gateway/test/ua7-speech-routing.test.ts`. For LLM-siden gjelder den EKSISTERENDE
   `isSensitivityEligible()` (D-79/D-81) uendret — tale-porten er en gjenbruk av samme regelform,
   aldri en parallell sikkerhetsvei.
3. Hver utfylt rad krever: verifisert region, signert/akseptert databehandleravtale, dokumenterte
   trenings- og retensjonsvilkår, og dato for kontroll (vilkår endrer seg – kontrolleres på nytt ved
   implementasjon eller kjøp, jf. masterplanen).
4. Matrisen revideres ved hvert leverandørvalg og minst per fase-port.
