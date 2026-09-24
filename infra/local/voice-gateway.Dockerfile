# D-253: voice-gateway sin EGEN image, atskilt fra api.Dockerfile sitt delte
# image (api/worker/migrate) - lokal STT/TTS (whisper.cpp/piper) trenger en
# C/C++-toolchain OG (for piper sin offisielle forhåndsbygde binær) et
# glibc-baseimage, som ville blåst opp de tre andre, rent Node-baserte
# tjenestene helt unødvendig. `node:XX-alpine` (musl libc) er BEVISST byttet
# ut med `node:XX-bookworm(-slim)` (Debian, glibc) her - KUN her - fordi
# Piper sin offisielle Linux-binær er glibc-lenket (onnxruntime-avhengighet)
# og ikke kjører på musl uten en kompatibilitetslag.
#
# whisper.cpp bygges derimot alltid fra kildekode (ingen offisiell Linux
# x86_64-forhåndsbygd binær finnes - kun kildekode-bygg er dokumentert,
# verifisert mot github.com/ggml-org/whisper.cpp, ikke gjettet) - portabelt
# på tvers av libc uansett, men bygges her i samme steg for én konsistent
# byggeprosess.
#
# Modell-/stemmevalg (BEGGE verifisert mot offisiell dokumentasjon, ALDRI
# gjettet - se D-253 i DECISIONS_AND_ASSUMPTIONS.md for kildene):
#   - whisper: `ggml-base.bin` (flerspråklig, ~142MB) - balansert
#     hastighet/nøyaktighet for CPU-bare NAS-maskinvare uten GPU. Kan byttes
#     til `ggml-small.bin`/`ggml-medium.bin` for bedre norsk-nøyaktighet på
#     bekostning av latens - se models/README.md i whisper.cpp for alle
#     navn, samme nedlastings-URL-mønster.
#   - piper: `no_NO-talesyntese-medium` - eneste norske stemme i det
#     offisielle piper-voices-registeret (rhasspy/piper VOICES.md).

FROM debian:bookworm-slim AS whisper-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --branch v1.9.4 --depth 1 https://github.com/ggml-org/whisper.cpp.git /build/whisper.cpp
WORKDIR /build/whisper.cpp
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release -j"$(nproc)"
# Binærnavnet har variert mellom whisper.cpp-versjoner (`main` historisk,
# `whisper-cli` i nyere - se stt.ts sin egen kommentar om nøyaktig dette) -
# lokaliser den faktiske outputen i stedet for å anta ett navn, og legg den
# på en FAST, versjonsuavhengig sti runtime-steget kan stole på.
RUN find build -type f \( -name "whisper-cli" -o -name "main" \) -exec cp {} /build/whisper-bin \;

FROM node:22-bookworm-slim AS runtime
# wget: docker-compose.yml sin healthcheck for denne tjenesten bruker wget -
# til stede by default på Alpine (busybox) men IKKE på Debian slim, uendret
# fra api.Dockerfile-æraen for minst mulig diff der.
RUN apt-get update && apt-get install -y --no-install-recommends curl wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY modules ./modules
RUN pnpm install --frozen-lockfile --prod

# --- whisper.cpp: binær fra byggesteget + flerspråklig base-modell ---
COPY --from=whisper-builder /build/whisper-bin /opt/whisper/whisper-cli
RUN curl -fL --retry 3 -o /opt/whisper/ggml-base.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin

# --- piper: offisiell forhåndsbygd Linux x86_64-binær + norsk stemme ---
RUN curl -fL --retry 3 -o /tmp/piper.tar.gz \
      https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz \
    && mkdir -p /opt/piper && tar -xzf /tmp/piper.tar.gz -C /opt/piper --strip-components=1 \
    && rm /tmp/piper.tar.gz
RUN mkdir -p /opt/piper/voices \
    && curl -fL --retry 3 -o /opt/piper/voices/no_NO-talesyntese-medium.onnx \
      https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/no/no_NO/talesyntese/medium/no_NO-talesyntese-medium.onnx \
    && curl -fL --retry 3 -o /opt/piper/voices/no_NO-talesyntese-medium.onnx.json \
      https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/no/no_NO/talesyntese/medium/no_NO-talesyntese-medium.onnx.json

ENV JARVIS_WHISPER_BIN=/opt/whisper/whisper-cli
ENV JARVIS_WHISPER_MODEL=/opt/whisper/ggml-base.bin
ENV JARVIS_PIPER_BIN=/opt/piper/piper
ENV JARVIS_PIPER_MODEL=/opt/piper/voices/no_NO-talesyntese-medium.onnx

EXPOSE 3020
CMD ["node", "--experimental-transform-types", "apps/voice-gateway/src/main.ts"]
