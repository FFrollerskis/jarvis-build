# DPIA – taledelen (fase 5-pilot)

**Status:** Fullført for pilotens omfang 2026-08-13. **KORRIGERT 2026-09-05 (D-122, UA-7
akseptansekriterium 4).**

> **RETTELSE.** Dette notatet påsto at «ingen rå lyd forlater maskinen» og at det MÅTTE revideres
> FØR en ekstern STT/TTS-leverandør ble tatt i bruk. Begge deler var **utdatert fra og med BO-12**
> (2026-08-14): `apps/voice-gateway/src/main.ts` velger `OpenAiStt`/`OpenAiTts` så snart
> `OPENAI_API_KEY` finnes, rå wav POSTes til `api.openai.com`, og dette er host-verifisert i
> `RUNTIME_GATES.md` («ekte OpenAI TTS/STT (norsk) PASS»). Revisjonen ble aldri gjort. Den gjøres
> her. Seksjonen «Pilotens faktiske behandling» under er derfor omskrevet til å beskrive den
> FAKTISKE tilstanden, ikke pilotens opprinnelige.
>
> Full, gjeldende vurdering for tale-/transkripsjons-/samtalebehandling:
> **[../UA7_COMMUNICATIONS_DPIA.md](../UA7_COMMUNICATIONS_DPIA.md)** (D-122). Dette notatet beholdes
> som pilot-/fase-5-historikk og for risikotabellen under.

## Faktisk behandling i dag (korrigert D-122)

- **Rå lyd FORLATER maskinen** når `OPENAI_API_KEY` er satt: `OpenAiStt` POSTer wav til
  `https://api.openai.com/v1/audio/transcriptions`, og `OpenAiTts` sender svarteksten til
  `https://api.openai.com/v1/audio/speech`. Uten nøkkel faller gatewayen til
  `MarkerStt`/`FakeTts` (lokale testadaptere) — det var DEN konfigurasjonen den opprinnelige
  pilotteksten beskrev.
- Ingen lyd lagres permanent (kun flyktige buffere i prosessminnet under en tur) — dette er
  fortsatt korrekt, og `/status` eksponerer `audio_persistence: "none"`.
- **NYTT (D-122):** `health`-space kan ikke lenger nå en ekstern behandler. Rutingsporten
  `evaluateSpeechRouting()` (`packages/contracts/src/speech.ts`) avviser det fail-closed, uten
  stille fallback, og ikke én lydramme når adapteren. Se
  [../UA7_COMMUNICATIONS_DPIA.md](../UA7_COMMUNICATIONS_DPIA.md) §6 — og §6.1 for hva porten IKKE
  garanterer (klient-oppgitt `memory_space`).
- **RETTET 2026-09-05 etter uavhengig arkitekt-review av PR #71:** det første strekpunktet over —
  «rå lyd FORLATER maskinen» — beskriver hva koden GJORDE. Med regel 3 håndhevet er ekstern
  tale-behandling nå **avvist for alle memory spaces** så lenge OpenAI-radene står `IKKE VERIFISERT`.
  I praksis forlater altså ingen lyd huset i dag; talekjeden er policy-blokkert, ikke lokal.
  Blir radene verifisert (Q-32), gjelder første strekpunkt igjen.
- Leverandørens region/databehandleravtale/treningsvilkår/retensjon er fortsatt **IKKE VERIFISERT**
  (Q-32) — radene i [PROCESSOR_REGION_MATRIX.md](PROCESSOR_REGION_MATRIX.md) navngir nå behandleren,
  men er ikke ferdig verifisert.
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
| Lydlekkasje til tredjepart | **KORRIGERT D-122:** ikke lenger «ingen» — rå lyd sendes til OpenAI når nøkkelen er satt (se rettelsen øverst). Gjeldende kontroll: `health` avvises strukturelt mot enhver ekstern behandler, og en ekstern behandler uten navngitt matriserad avvises helt. Leverandørvilkårene selv er fortsatt ikke verifisert (Q-32) |
| Feilaktig transkribert kommando utfører handling | Fast Router går alltid gjennom Policy Gateway; klasse D krever signert godkjenning også via tale (ingen «sagt høyt»-unntak) |
| Kryss-sesjons-lyd | Én VoiceSession per tilkobling; TTS kanselleres ved barge-in; ingen delt lydtilstand mellom sesjoner |
| Replay av talekommandoer ved failover | Utterance-journal gjør turer idempotente (testet) |
