# D-106 host-akseptanse: lokal Gemma (RTX 4070-PC)

**Formål:** verifisere at Jarvis AI Mesh faktisk kan nå en Gemma-modell kjørt
LOKALT på din RTX 4070-PC (eller en annen dedikert vertsmaskin), distinkt fra
den hostede `gemma_hosted`-provideren (Google sin Gemini API, D-80).

Claude Code sitt sandbox-miljø har INGEN tilgang til din RTX 4070-PC - denne
verifiseringen MÅ kjøres av deg selv, på maskinen som faktisk har GPU-en.
Scriptet under gjør ALT arbeidet automatisk og printer klare markører - du
trenger IKKE feilsøke noe internt selv.

## Forutsetning: en lokal Gemma-server som snakker OpenAI-kompatibelt API

`gemma_local`-provideren i Jarvis snakker `POST /v1/chat/completions`
(OpenAI-kompatibelt skjema) - IKKE Ollamas native `/api/chat`-format (det
dekkes av den separate `ollama`-provideren). Enkleste vei på Windows:

1. Installer [Ollama for Windows](https://ollama.com/download/windows) hvis
   ikke allerede installert.
2. Hent en Gemma-modell (eksempel - bytt ut med modellen du faktisk vil kjøre):
   ```
   ollama pull gemma3:27b
   ```
3. Ollama eksponerer en OpenAI-kompatibel rute på
   `http://localhost:11434/v1` som standard når Ollama kjører (`ollama serve`,
   eller automatisk hvis Ollama-appen kjører i bakgrunnen).

## Steg 1: sett miljøvariablene

I `.env` (ALDRI i `.env.example`, ALDRI committet):

```
JARVIS_GEMMA_LOCAL_URL=http://localhost:11434/v1
JARVIS_GEMMA_LOCAL_MODEL=gemma3:27b
```

Bytt `JARVIS_GEMMA_LOCAL_MODEL` til nøyaktig navnet du `ollama pull`-et.

Hvis Gemma-serveren kjører på en ANNEN maskin enn Jarvis sin API-prosess
(f.eks. RTX 4070-PC-en er en egen node fra UGREEN 24/7-basen), pek
`JARVIS_GEMMA_LOCAL_URL` mot den maskinens nettverksadresse i stedet for
`localhost` (f.eks. `http://192.168.1.50:11434/v1`) - adapteren er en ren
HTTP-klient, ingen antakelse om samme maskin.

## Steg 2: kjør live-verifiseringsscriptet

Fra repo-roten, med `.env` lastet inn i miljøet:

```
node --experimental-transform-types modules/model-gateway/scripts/d106-live-verify.ts
```

## Steg 3: les resultatet

Scriptet printer én linje per modellfamilie. Se etter:

```
GEMMA_LOCAL_LIVE_STATUS=LIVE_VERIFIED
```

Dette betyr: Jarvis sin `gemma_local`-adapter kontaktet din lokale server
NÅ og fikk et faktisk svar tilbake. Skriptet tester OGSÅ OpenAI/Claude/
Gemini/Kimi/gemma_hosted samtidig - deres status er UENDRET av denne
runboken og reflekterer kun hvilke nøkler som faktisk er satt i ditt miljø.

**Mulige andre utfall for `GEMMA_LOCAL_LIVE_STATUS`:**
- `HOST_RUNTIME_REQUIRED` - `JARVIS_GEMMA_LOCAL_URL` er IKKE satt i `.env`.
  Gå tilbake til Steg 1.
- `UNAVAILABLE` - URL-en er satt, men kallet feilet (server ikke startet,
  feil port, feil modellnavn). Sjekk at `ollama serve` faktisk kjører og at
  `JARVIS_GEMMA_LOCAL_MODEL` er eksakt modellnavnet fra `ollama list`.

## Steg 4: rapporter tilbake

Kopier HELE output-blokken (alle seks `*_LIVE_STATUS=`-linjer) tilbake i
samtalen med Claude Code. INGEN secrets/API-nøkler er en del av denne
outputen (kun statusmarkører) - trygt å lime inn direkte.
