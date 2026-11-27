# D-403 - Whisper på eierens PC (GPU) for tale

Status: adapteren er bygget og enhetstestet mot en fake server. **Ingenting under er kjørt mot en ekte server av Claude** - dette er stegene Tobias gjør på PC-en og NAS-en, og testene som avgjør om det faktisk er bedre.

## 1. Start en OpenAI-kompatibel Whisper-server på PC-en (host-handling)

Kandidat: `faster-whisper-server` ([github.com/fedirz/faster-whisper-server](https://github.com/fedirz/faster-whisper-server); prosjektet kan være omdøpt/flyttet - følg README der, ikke denne filen, hvis noe avviker). Fra README (kontrollert via websøk 2026-10-05, ikke kjørt):

```
docker run --gpus=all --publish 8000:8000 --volume ~/.cache/huggingface:/root/.cache/huggingface fedirz/faster-whisper-server:latest-cuda
```

Krever Docker med GPU-støtte (NVIDIA Container Toolkit / Docker Desktop med WSL2-GPU). Modellen lastes ned ved første kall. Alle servere som tilbyr `POST /v1/audio/transcriptions` (multipart: `file`, valgfritt `model`, `language`, `prompt`) fungerer.

PC-ens brannmur/Tailscale må slippe NAS-en til port 8000 (Tailscale-adresse, f.eks. `100.101.102.103`).

## 2. Test serveren FØR Jarvis berøres (fra NAS-en)

```
curl -s -m 60 http://100.101.102.103:8000/v1/audio/transcriptions -F "file=@prøve.wav" -F "language=no"
```

Svaret skal være JSON med `text`. Mål tiden (`time`) og sjekk at norsken er riktig.

## 3. Pek Jarvis på serveren (`.env` på NAS-en)

```
JARVIS_STT_REMOTE_URL=http://100.101.102.103:8000
JARVIS_STT_REMOTE_MODEL=        # tom = serverens standardmodell; ellers modellnavnet serveren forventer
JARVIS_STT_REMOTE_TIMEOUT_MS=   # tom = 4000
```

Deretter `docker compose --env-file .env -f infra/local/docker-compose.yml up -d --build voice-gateway`.

## 4. Verifiser

- `docker compose ... logs voice-gateway` skal vise at `stt` er `remote-whisper` ved oppstart.
- Snakk i `/voice` og sammenlign «ms til lyd» i HUD-et før og etter.
- Slå PC-en av og snakk igjen: du skal få `stt_remote_whisper_fallback_local` i loggen og fortsatt svar (via Whisper small på NAS-en). Serveren hoppes over i 30 s mellom forsøkene.

## Sikkerhetsregler (håndhevet i kode)

- `JARVIS_STT_REMOTE_URL` må være en privat adresse (loopback, RFC1918, link-local, Tailscale 100.64/10 eller enkelt vertsnavn). En offentlig adresse avvises (`stt_remote_whisper_rejected`) - lyd sendes aldri ut av huset herfra.
- Redirects følges ikke. Ingen lyd skrives til disk (§22).
- Fallbacken er alltid lokal whisper.cpp, aldri sky.

## Rollback

Tøm `JARVIS_STT_REMOTE_URL` i `.env` og kjør `up -d voice-gateway` på nytt - da brukes Whisper small på NAS-en som før.
