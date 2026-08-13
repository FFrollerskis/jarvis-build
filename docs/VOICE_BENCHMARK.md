# Norsk tale-benchmark (D-10-porten)

**Status:** Harness levert i fase 5 (`apps/voice-gateway/src/benchmark.ts`, WER-funksjonen er
testet). **Selve benchmarken er IKKE kjørt** – utsatt via bindende beslutning **D-30**
(se DECISIONS_AND_ASSUMPTIONS.md): den kjøres når ekte STT/TTS-kandidater og ≥100 representative
norske lydprøver finnes, og SENEST før bred utrulling (mobil/Watch/satellitter/bil). Inntil da er
Voice Gateway prototype/utviklingsklar – ikke produksjonsverifisert. Råmålinger og sammendrag skal
dokumenteres i denne filen når porten kjøres.

## Slik kjøres den (når forutsetningene er på plass)

1. Samle **minst 100** norske lydprøver (WAV PCM16 16 kHz) med fasittekst, fordelt på kategoriene:
   `generell`, `tall`, `navn`, `adresse`, `dialekt` – inkludert støy/avstandsvarianter.
2. Lag `benchmark/manifest.json`: `{ "samples": [{ "audio": "...", "reference": "...", "category": "..." }] }`
3. Sett nøkler/stier i `.env`: `OPENAI_API_KEY` og/eller `JARVIS_WHISPER_BIN`/`JARVIS_PIPER_BIN`.
4. Kjør harnesset per STT-adapter (OpenAI, lokal whisper, ev. flere kandidater) – det håndhever
   ≥100-kravet og rapporterer WER totalt + per kategori og latens-P50/P95.
5. TTS vurderes med samme prøvetekster: naturlighet (subjektiv skala), norsk uttale av navn,
   første-byte-latens, pris, datavilkår.
6. Realtime-/tale-til-tale-API-er sammenlignes som egen kategori med samme krav.
7. Oppdater [security/PROCESSOR_REGION_MATRIX.md](security/PROCESSOR_REGION_MATRIX.md) og
   [security/DPIA_VOICE.md](security/DPIA_VOICE.md) for kandidatene.
8. **Stop/go-beslutning** dokumenteres i DECISIONS_AND_ASSUMPTIONS: leverandørvalg + satellitt,
   ELLER eksplisitt valg av lokal STT/TTS, ELLER justerte mål – aldri stille aksept.
   Mål som skal vurderes: barge-in ≤250 ms og median talerespons <1,5 s med reelle leverandører.
