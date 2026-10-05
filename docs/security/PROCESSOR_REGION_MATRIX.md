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
gjennom `evaluateSpeechRouting()`.

**OPPDATERT 2026-09-22 (D-226): Q-32 punkt 1 er FULLSTENDIG LUKKET.** Tobias har selv gjennomgått
`platform.openai.com` sin `Data controls`-side og OpenAI sin offentlige API-FAQ og bekreftet alle
fire regel-3-felt for OpenAI STT/TTS (se rader under). `processor_terms_status` er derfor flippet fra
`"NOT_VERIFIED"` til `"VERIFIED"` i `apps/voice-gateway/src/stt.ts`/`tts.ts` - dette er den forhåndsdefinerte,
tiltenkte fullføringen av denne porten, ikke en ny mekanisme. **Konsekvens: OpenAI STT/TTS er nå
TILLATT for alle memory spaces UNNTATT `health`** (D-23/SECRET_RESTRICTED, egen, UENDRET grense som
krever lokal behandler uansett vilkårsstatus), og kun ved faktisk `SERVER_VERIFIED`
memory-space-autoritet (D-123 - en klient-oppgitt space gir aldri ekstern tilgang).

| Kategori | Leverandør | Tjeneste | Region | Databehandleravtale | Trener på data? | Retensjon hos leverandør | Tillatte memory spaces | Status |
|---|---|---|---|---|---|---|---|---|
| LLM | TBD / benchmark required | – | – | – | – | – | – | Velges i fase 3 (D-14/Q-04) |
| LLM (lokal) | TBD | – | lokalt (NAS/PC) | ikke relevant | nei | ingen | alle inkl. health (D-23) | Vurderes fase 3+/10 |
| STT | OpenAI | `POST /v1/audio/transcriptions` (`whisper-1`) — rå wav sendes ut av huset | EU (Tobias sin egen konto-lesning, 2026-09-22) | GODKJENT (Tobias sin egen konto, 2026-09-22, ingen dato-/versjonsreferanse notert) | **NEI** (Tobias deaktiverte selv "Share inputs and outputs with OpenAI" for Default project i Data controls → Sharing, 2026-09-22, skjermbilde-bekreftet + Save bekreftet — stod tidligere PÅ, en reell feilkonfigurasjon rettet i denne sesjonen, IKKE en antakelse) | **Inntil 30 dager, deretter slettet** (OpenAI sin offentlige API-FAQ, "Hvordan håndterer OpenAI datalagring og overvåking for API-bruk?", 2026-09-22: "kan OpenAI lagre API-inndata og -utdata på en sikker måte i opptil 30 dager for å kunne levere tjenestene og avdekke misbruk. Etter 30 dager slettes API-inn- og utdata... med mindre vi er lovpålagt å oppbevare dem." Null datalagring/ZDR tilgjengelig for kvalifiserte enheter - ikke søkt om) | **ALLE unntatt `health`** — TILLATT for enhver space med faktisk `SERVER_VERIFIED` memory-space-autoritet (D-123); `health` forblir avvist (D-23/SECRET_RESTRICTED) | **VERIFISERT OG ÅPNET (D-226, 2026-09-22)** — `processor_terms_status: "VERIFIED"` i produksjonskode. Alle fire regel-3-felt faktisk bekreftet av Tobias. Q-32 punkt 1 FULLSTENDIG LUKKET |
| STT (lokal) | whisper.cpp | `LocalWhisperStt` (`JARVIS_WHISPER_BIN` + `JARVIS_WHISPER_MODEL`) | lokalt | ikke relevant | nei | ingen | alle inkl. `health` (D-23) | **INSTALLERT OG HOST-VERIFISERT (D-223, 2026-09-22)**: `startStream()` kjører en ekte subprosess (WAV via STDIN, ALDRI disk - §22). Tobias har installert `whisper-cli.exe`+`ggml-small.bin` og satt begge miljøvariablene på egen maskin - `available()` returnerer nå `true`, og de tidligere UVERIFISERTE CLI-flaggene er bevist korrekte mot en ekte binær (Q-32 punkt 3 fullstendig lukket) |
| STT (egen server) | Whisper på eierens PC (GPU) | `RemoteWhisperStt` (`JARVIS_STT_REMOTE_URL`, OpenAI-kompatibelt `/v1/audio/transcriptions`) | lokalt (eierens eget nett/tailnet) | ikke relevant | nei | ingen | alle inkl. `health` (D-23) — KUN fordi adressen håndheves privat i kode | **BYGGET OG ENHETSTESTET MOT FAKE SERVER (D-403, 2026-10-05), IKKE VERIFISERT MOT EN EKTE WHISPER-SERVER.** `locality: "local"` utledes av at adressen er loopback/RFC1918/Tailscale 100.64/10 (`isPrivateSttHost`); en offentlig/ugyldig adresse gjør adapteren utilgjengelig (fail-closed), redirects følges ikke, og feil/tidsavbrudd faller tilbake til lokal whisper.cpp (aldri til sky). Lyd forlater NAS-en (over WireGuard-kryptert tailnet) til eierens egen maskin. |
| STT | Deepgram | `POST /v1/listen` (forhåndsinnspilt/batch) — rå wav sendes ut av huset | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **INGEN** (fail-closed inntil `VERIFIED`) | **NAVNGITT, IKKE VERIFISERT (D-320, 2026-09-27)** — `DeepgramStt` (`apps/voice-gateway/src/stt.ts`) er bygget og enhetstestet, `processor_terms_status: "NOT_VERIFIED"` eksplisitt satt i koden (fail-closed default, ALDRI utledet av Jarvis selv). `evaluateSpeechRouting()` avviser denne behandleren for ALLE memory spaces inntil Tobias selv gjennomgår Deepgram sin Data controls-side (SAMME Q-32-mønster som D-226 for OpenAI) og denne raden oppdateres til `VERIFIED`. BEVISST IKKE wiret inn i `main.ts` sin aktive adapter-utvelgelse - se D-320 i DECISIONS_AND_ASSUMPTIONS.md |
| STT (strømmende) | Deepgram | `wss://api.deepgram.com/v1/listen` (ekte streaming) — rå PCM16-lyd strømmes binært ut av huset fortløpende, IKKE én ferdig wav-fil | **IKKE VERIFISERT** (SAMME uverifiserte konto/leverandør som batch-raden over - en strømmings-variant er IKKE mer godkjent enn batch-varianten) | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **INGEN** (fail-closed inntil `VERIFIED`) | **NAVNGITT, IKKE VERIFISERT (D-356, 2026-09-30)** — `DeepgramStreamingStt` (`apps/voice-gateway/src/stt.ts`) er bygget og enhetstestet (18 tester, WS-protokollen fake'et - ingen ekte tilkobling), `processor_terms_status: "NOT_VERIFIED"` eksplisitt satt i koden (egen `processor_id` fra batch-raden, D-122 regel 3 gjelder per tjeneste). `evaluateSpeechRouting()` avviser denne for ALLE memory spaces til Tobias selv gjennomgår Deepgram sin Data controls-side (SAMME gjennomgang som ville dekke batch-raden over - én Tobias-handling lukker trolig begge) og BEGGE Deepgram-radene oppdateres til `VERIFIED`. BEVISST IKKE wiret inn i `main.ts` sin aktive adapter-utvelgelse - se D-320. Bygget som svar på Tobias sin direkte instruks "fortsett og fikse voice ferdig" (D-353s eksplisitt utsatte latens-funn) - et FØRSTE forsøk mot OpenAI sitt Realtime-API ble reversert midt i byggingen da det viste seg å motsi en tidligere, nettverksverifisert arkitekturbeslutning (D-328/Q-42, "ikke kodbar før presisert") - se D-356 i DECISIONS_AND_ASSUMPTIONS.md for full ærlighetsnotat om reverseringen. D-297-ærlighetsforbehold: nettverksegress til `api.deepgram.com` bekreftet blokkert i byggesesjonen - selve WS-meldingsprotokollen er trent kunnskap, IKKE denne-økten-verifisert; Tobias må selv teste mot en ekte tilkobling FØR protokollen regnes bekreftet, HELT UAVHENGIG av DPA-statusen |
| TTS | OpenAI | `POST /v1/audio/speech` (`gpt-4o-mini-tts`) — svartekst sendes ut av huset | EU (Tobias sin egen konto-lesning, 2026-09-22) | GODKJENT (Tobias sin egen konto, 2026-09-22, ingen dato-/versjonsreferanse notert) | **NEI** (samme org-nivå-bryter som STT-raden over - "Share inputs and outputs with OpenAI" gjelder BEGGE tjenester på samme konto, deaktivert 2026-09-22) | **Inntil 30 dager, deretter slettet** — samme OpenAI API-FAQ som STT-raden over, se den for ordrett sitat | **ALLE unntatt `health`** — TILLATT for enhver space med faktisk `SERVER_VERIFIED` memory-space-autoritet (D-123); `health` forblir avvist (D-23/SECRET_RESTRICTED) | **VERIFISERT OG ÅPNET (D-226, 2026-09-22)** — `processor_terms_status: "VERIFIED"` i produksjonskode. Q-32 punkt 1 FULLSTENDIG LUKKET |
| TTS (lokal) | piper | `LocalPiperTts` (`JARVIS_PIPER_BIN` + `JARVIS_PIPER_MODEL`) | lokalt | ikke relevant | nei | ingen | alle inkl. `health` (D-23) | **INSTALLERT OG HOST-VERIFISERT (D-223, 2026-09-22)**: `synthesize()` kjører en ekte, STRØMMENDE subprosess (tekst via STDIN, rå PCM fortløpende fra STDOUT, `cancel()` dreper hele prosessgruppen umiddelbart for barge-in). Tobias har installert `piper.exe`+`no_NO-talesyntese-medium.onnx` og satt begge miljøvariablene - `available()` returnerer nå `true`, og ekte norsk tale-syntese er bekreftet (Q-32 punkt 3 fullstendig lukket) |
| TTS | ElevenLabs | `POST /v1/text-to-speech/{voice_id}?output_format=pcm_16000` (`eleven_multilingual_v2`) — svartekst sendes ut av huset | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **INGEN** (fail-closed inntil `VERIFIED`) | **NAVNGITT, IKKE VERIFISERT (D-319, 2026-09-27)** — `ElevenLabsTts` (`apps/voice-gateway/src/tts.ts`) er bygget og enhetstestet, `processor_terms_status: "NOT_VERIFIED"` eksplisitt satt i koden (fail-closed default, ALDRI utledet av Jarvis selv). `evaluateSpeechRouting()` avviser denne behandleren for ALLE memory spaces inntil Tobias selv gjennomgår ElevenLabs sin Data controls-side (SAMME Q-32-mønster som D-226 for OpenAI) og denne raden oppdateres til `VERIFIED`. BEVISST IKKE wiret inn i `main.ts` sin aktive adapter-utvelgelse - se D-319 i DECISIONS_AND_ASSUMPTIONS.md |
| Meldingskanal | Telegram | Bot API (`sendMessage`/`getUpdates`) — varsler, daglig brief, klasse D-godkjenningsvarsler og kommandoer går via Telegrams servere (`TelegramTransport`/`TelegramCommandPoller`) | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** | **IKKE VERIFISERT** (Bot API-meldinger er ikke ende-til-ende-krypterte) | Kun korte, strukturerte varsler til eierens egen chat; **aldri `health`/`SECRET_RESTRICTED`-innhold** (D-23/D-378) | **NAVNGITT, IKKE VERIFISERT (D-398/JARVIS-087):** kanalen var i bruk uten rad. Region, databehandleravtale, treningsvilkår og retensjon krever eier-/juridisk verifisering (**NEEDS_TOBIAS**, samme mønster som Q-32). Raden gjør bruken synlig; den kvalifiserer ikke Telegram for sensitive data. |
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
