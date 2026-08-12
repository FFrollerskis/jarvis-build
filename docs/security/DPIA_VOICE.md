# DPIA – taledelen (fase 5-pilot)

**Status:** Fullført for pilotens omfang 2026-08-13. MÅ revideres FØR en ekstern STT/TTS/realtime-
leverandør tas i bruk (leverandørrader i [PROCESSOR_REGION_MATRIX.md](PROCESSOR_REGION_MATRIX.md)
er fortsatt TBD og er en hard port).

## Pilotens faktiske behandling

- Piloten kjører med deterministiske testadaptere og/eller lokale binærer: **ingen rå lyd forlater
  maskinen**, ingen skyleverandør mottar tale, ingen lyd lagres permanent (kun flyktige buffere i
  prosessminnet under en tur).
- Ingen kontinuerlig lytting: klienten sender lyd eksplisitt; wake-word/satellitt kommer i fase 9
  med fysisk mute og synlig indikator (bindende krav derfra).
- Transkripter behandles som samtaledata i eksisterende minnesystem (tenant/space-RLS, karantene,
  audit) – ingen egen «voice memory».
- Stemmeprofil brukes ikke, og skal aldri alene autentisere noe (arkitekturinvariant); tale gir
  ingen forhøyet auth_strength.

## Ved leverandørvalg (gate før produksjonsbruk)

Per kandidat skal dokumenteres før bruk: formål, behandlingsgrunnlag, region, retensjon hos
leverandør, om data brukes til trening, kryptering under transport, sletting, og om rå lyd forlater
huset. Norsk benchmark (≥100 prøver, se [../VOICE_BENCHMARK.md](../VOICE_BENCHMARK.md)) og denne
DPIA-en oppdateres sammen i stop/go-beslutningen (D-10). Lyd kan avsløre helse/sensitive forhold:
`health`-space-samtaler skal aldri gå til skyleverandør uten egen eksplisitt beslutning (D-23).

## Risikovurdering (pilot)

| Risiko | Vurdering |
|---|---|
| Lydlekkasje til tredjepart | Ingen i pilot (ingen eksterne kall); gate før leverandør aktiveres |
| Feilaktig transkribert kommando utfører handling | Fast Router går alltid gjennom Policy Gateway; klasse D krever signert godkjenning også via tale (ingen «sagt høyt»-unntak) |
| Kryss-sesjons-lyd | Én VoiceSession per tilkobling; TTS kanselleres ved barge-in; ingen delt lydtilstand mellom sesjoner |
| Replay av talekommandoer ved failover | Utterance-journal gjør turer idempotente (testet) |
