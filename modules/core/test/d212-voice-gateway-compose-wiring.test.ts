import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-212 (task #120): `apps/voice-gateway` hadde ingen egen docker-compose-
 * tjeneste - fraværende fra det containeriserte lokale oppsettet ved siden av
 * postgres/langfuse/infisical/migrate/api/worker. Denne suiten beviser at
 * `voice-gateway`-tjenesten faktisk finnes, bruker SAMME runtime-image som
 * api/worker/migrate (api.Dockerfile kopierer hele workspacet), og peker på
 * `api`-tjenestens CONTAINER-INTERNE adresse for `JARVIS_CORE_URL` - IKKE
 * gatewayens egen localhost-default (som ville vært feil inne i
 * compose-nettverket).
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

  it("bruker SAMME runtime-image (api.Dockerfile) som api/worker/migrate, ikke et eget image", () => {
    expect(block).toMatch(/dockerfile:\s*infra\/local\/api\.Dockerfile/);
  });

  it("kommandoen starter apps/voice-gateway/src/main.ts, samme node --experimental-transform-types-mønster som worker", () => {
    expect(block).toMatch(/command:\s*\["node",\s*"--experimental-transform-types",\s*"apps\/voice-gateway\/src\/main\.ts"\]/);
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
});
