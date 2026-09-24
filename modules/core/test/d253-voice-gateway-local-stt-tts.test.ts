import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-253 (Tobias direkte i chat, etter D-251/D-252-fiksene: "alle" - som svar
 * på valget mellom OpenAI-basert og lokal whisper.cpp/piper STT/TTS).
 *
 * Root cause for at tale aldri produserte ekte tale (verken på PC-en eller
 * NAS-en, samme `.env` uendret): `OPENAI_API_KEY` var en nesten tom
 * plassholderverdi, og INGEN lokal whisper.cpp/piper-binær/modell var noensinne
 * konfigurert - `main.ts` sin fallback-kjede endte derfor alltid på
 * `MarkerStt`/`FakeTts` (rene testadaptere, "ingen lyd forlater maskinen").
 *
 * Denne suiten beviser at `voice-gateway.Dockerfile` faktisk bygger/henter
 * whisper.cpp + piper og setter miljøvariablene `LocalWhisperStt`/
 * `LocalPiperTts` (apps/voice-gateway/src/stt.ts/tts.ts) allerede leser -
 * IKKE at selve talen fungerer live (det krever en ekte kjørende container,
 * utenfor denne sandboxens rekkevidde - se D-253 i
 * DECISIONS_AND_ASSUMPTIONS.md for hvilke kilder URL-ene/versjonene er
 * verifisert mot, ALDRI gjettet).
 */
function readDockerfile(): string {
  return readFileSync(fileURLToPath(new URL("../../../infra/local/voice-gateway.Dockerfile", import.meta.url)), "utf8");
}

describe("D-253: voice-gateway.Dockerfile bygger/henter ekte lokal STT/TTS", () => {
  const dockerfile = readDockerfile();

  it("runtime-steget bruker et glibc-baseimage (node:*-bookworm*), ikke alpine - Piper sin offisielle binær er glibc-lenket", () => {
    expect(dockerfile).toMatch(/FROM node:22-bookworm-slim AS runtime/);
    expect(dockerfile).not.toMatch(/FROM node:22-alpine/);
  });

  it("whisper.cpp bygges fra en PINNET tag (reproduserbart bygg, ikke en flytende master-HEAD)", () => {
    expect(dockerfile).toMatch(/git clone --branch v1\.9\.4 --depth 1 https:\/\/github\.com\/ggml-org\/whisper\.cpp\.git/);
  });

  it("whisper-binæren lokaliseres etter navn i stedet for å anta ETT navn (main/whisper-cli har variert mellom versjoner)", () => {
    expect(dockerfile).toMatch(/-name "whisper-cli" -o -name "main"/);
  });

  it("henter en ekte ggml-modell fra den offisielle huggingface.co/ggerganov/whisper.cpp-kilden", () => {
    expect(dockerfile).toMatch(
      /https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\/ggml-base\.bin/
    );
  });

  it("henter Piper sin offisielle forhåndsbygde Linux x86_64-binær fra rhasspy/piper sitt GitHub-release", () => {
    expect(dockerfile).toMatch(
      /https:\/\/github\.com\/rhasspy\/piper\/releases\/download\/2023\.11\.14-2\/piper_linux_x86_64\.tar\.gz/
    );
  });

  it("henter den norske Piper-stemmen (no_NO-talesyntese-medium, ENESTE norske stemme i det offisielle piper-voices-registeret) - BÅDE .onnx og .onnx.json", () => {
    expect(dockerfile).toMatch(
      /https:\/\/huggingface\.co\/rhasspy\/piper-voices\/resolve\/v1\.0\.0\/no\/no_NO\/talesyntese\/medium\/no_NO-talesyntese-medium\.onnx(?!\.json)/
    );
    expect(dockerfile).toMatch(
      /https:\/\/huggingface\.co\/rhasspy\/piper-voices\/resolve\/v1\.0\.0\/no\/no_NO\/talesyntese\/medium\/no_NO-talesyntese-medium\.onnx\.json/
    );
  });

  it("setter JARVIS_WHISPER_BIN/_MODEL og JARVIS_PIPER_BIN/_MODEL - EKSAKT variablene LocalWhisperStt/LocalPiperTts leser (stt.ts/tts.ts)", () => {
    expect(dockerfile).toMatch(/ENV JARVIS_WHISPER_BIN=\/opt\/whisper\/whisper-cli/);
    expect(dockerfile).toMatch(/ENV JARVIS_WHISPER_MODEL=\/opt\/whisper\/ggml-base\.bin/);
    expect(dockerfile).toMatch(/ENV JARVIS_PIPER_BIN=\/opt\/piper\/piper/);
    expect(dockerfile).toMatch(/ENV JARVIS_PIPER_MODEL=\/opt\/piper\/voices\/no_NO-talesyntese-medium\.onnx/);
  });

  it("installerer wget i runtime-steget - docker-compose.yml sin healthcheck for denne tjenesten bruker wget, som IKKE er del av Debian slim by default (i motsetning til Alpine/busybox)", () => {
    expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends curl wget/);
  });

  it("kjøres som en flertrinns-bygg (whisper-builder + runtime) - build-toolchainen (build-essential/cmake/git) havner ALDRI i det endelige kjøre-imaget", () => {
    expect(dockerfile).toMatch(/FROM debian:bookworm-slim AS whisper-builder/);
    expect(dockerfile).toMatch(/COPY --from=whisper-builder/);
  });
});
