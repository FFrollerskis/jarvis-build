import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-212 (task #120): `apps/voice-gateway` hadde ingen egen docker-compose-
 * tjeneste - fraværende fra det containeriserte lokale oppsettet ved siden av
 * postgres/langfuse/infisical/migrate/api/worker. Denne suiten beviser at
 * `voice-gateway`-tjenesten faktisk finnes, og peker på `api`-tjenestens
 * CONTAINER-INTERNE adresse for `JARVIS_CORE_URL` - IKKE gatewayens egen
 * localhost-default (som ville vært feil inne i compose-nettverket).
 *
 * D-253: `voice-gateway` fikk sitt EGET image (`voice-gateway.Dockerfile`),
 * IKKE lenger det delte `api.Dockerfile`-imaget api/worker/migrate bruker -
 * lokal whisper.cpp/piper trenger et glibc-baseimage + en C/C++-toolchain.
 * `command:`-overstyringen er derfor også borte - det nye imagets egen CMD
 * starter `apps/voice-gateway/src/main.ts` direkte.
 */
function readCompose(): string {
  return readFileSync(fileURLToPath(new URL("../../../infra/local/docker-compose.yml", import.meta.url)), "utf8");
}

function extractServiceBlock(compose: string, serviceName: string): string {
  const lines = compose.split("\n");
  const startIdx = lines.findIndex((l) => new RegExp(`^\\s{2}${serviceName}:\\s*$`).test(l));
  expect(startIdx).toBeGreaterThan(-1);
  const endIdx = lines.findIndex((l, i) => i > startIdx && /^ {2}\S/.test(l));
  return lines.slice(startIdx, endIdx === -1 ? undefined : endIdx).join("\n");
}

describe("D-212: voice-gateway-tjenesten finnes i infra/local/docker-compose.yml", () => {
  const compose = readCompose();
  const block = extractServiceBlock(compose, "voice-gateway");

  it("D-253: bruker sitt EGET image (voice-gateway.Dockerfile), ikke lenger det delte api.Dockerfile", () => {
    expect(block).toMatch(/dockerfile:\s*infra\/local\/voice-gateway\.Dockerfile/);
    expect(block).not.toMatch(/dockerfile:\s*infra\/local\/api\.Dockerfile/);
  });

  it("D-253: ingen command:-overstyring - voice-gateway.Dockerfile sin egen CMD starter apps/voice-gateway/src/main.ts", () => {
    expect(block).not.toMatch(/command:/);
  });

  it("JARVIS_CORE_URL peker på api-tjenestens CONTAINER-INTERNE adresse, ikke localhost-defaulten fra main.ts", () => {
    expect(block).toMatch(/JARVIS_CORE_URL:\s*"http:\/\/api:\$\{JARVIS_API_PORT:-3010\}"/);
  });

  it("avhenger av at api-tjenesten er HELSEFRISK (service_healthy), ikke bare startet", () => {
    expect(block).toMatch(/depends_on:\s*\n\s*api:\s*\n\s*condition:\s*service_healthy/);
  });

  it("porter mappes via JARVIS_VOICE_PORT (default 3020), samme variabel som apps/voice-gateway/src/main.ts leser", () => {
    expect(block).toMatch(/"\$\{JARVIS_VOICE_PORT:-3020\}:\$\{JARVIS_VOICE_PORT:-3020\}"/);
  });

  it("har helsesjekk mot /health, samme mønster som api-tjenesten", () => {
    expect(block).toMatch(/wget -qO- http:\/\/127\.0\.0\.1:\$\{JARVIS_VOICE_PORT:-3020\}\/health/);
  });

  it("D-280: JARVIS_VOICE_DEBUG_DUMP_DIR videresendes EKSPLISITT i environment: - `docker compose` sender ALDRI automatisk hele .env inn i containeren, kun det som er listet her (live-funn: variabelen nådde ALDRI containeren FØR denne fiksen, til tross for at den sto i .env)", () => {
    expect(block).toMatch(/JARVIS_VOICE_DEBUG_DUMP_DIR:\s*"\$\{JARVIS_VOICE_DEBUG_DUMP_DIR:-\}"/);
  });

  it("D-280: monterer et fast volum til /voice-debug (D-279 sin debug-audio-dump.ts skriver dit) - harmløst når JARVIS_VOICE_DEBUG_DUMP_DIR er usatt, siden ingenting skriver til stien uansett", () => {
    expect(block).toMatch(/volumes:\s*\n(\s*#.*\n)*\s*-\s*\.\/voice-debug-dumps:\/voice-debug/);
  });
});
