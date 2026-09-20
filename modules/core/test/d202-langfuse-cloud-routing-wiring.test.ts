import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-202 (2026-09-20, direkte chat-instruks fra Tobias etter live host-verifisering):
 * `infra/local/docker-compose.yml` hardkodet FØR denne fiksen `LANGFUSE_BASE_URL:
 * "http://langfuse:3000"` for BÅDE `api`- og `worker`-tjenesten - dette overstyrte
 * stille enhver `.env`-verdi (f.eks. Langfuse Cloud), selv når eieren eksplisitt
 * hadde konfigurert Cloud-nøkler. Host-verifisert: Langfuse Cloud-dashbordet viste
 * 0 spor til tross for aktiv Jarvis-bruk, fordi container-trafikken faktisk gikk
 * til den selvhostede `langfuse`-tjenesten uansett. Denne suiten beviser at begge
 * tjenestene nå respekterer en eksplisitt `.env`-verdi via `${LANGFUSE_BASE_URL:-
 * http://langfuse:3000}` - SAMME default som før for det uendrede lokal-selvhostet-
 * tilfellet (ingen regresjon), men en satt `.env`-verdi vinner nå faktisk.
 * `INFISICAL_URL` er BEVISST UENDRET (kun selvhostet, intet cloud-alternativ).
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

describe("D-202: Langfuse Cloud-routing respekteres av api/worker, Infisical uendret selvhostet", () => {
  const compose = readCompose();

  it("api-tjenesten bruker ${LANGFUSE_BASE_URL:-http://langfuse:3000}, ikke en hardkodet verdi", () => {
    const apiBlock = extractServiceBlock(compose, "api");
    expect(apiBlock).toMatch(/LANGFUSE_BASE_URL:\s*"\$\{LANGFUSE_BASE_URL:-http:\/\/langfuse:3000\}"/);
    expect(apiBlock).not.toMatch(/LANGFUSE_BASE_URL:\s*"http:\/\/langfuse:3000"\s*$/m);
  });

  it("worker-tjenesten bruker SAMME ${LANGFUSE_BASE_URL:-http://langfuse:3000}-mønster", () => {
    const workerBlock = extractServiceBlock(compose, "worker");
    expect(workerBlock).toMatch(/LANGFUSE_BASE_URL:\s*"\$\{LANGFUSE_BASE_URL:-http:\/\/langfuse:3000\}"/);
    expect(workerBlock).not.toMatch(/LANGFUSE_BASE_URL:\s*"http:\/\/langfuse:3000"\s*$/m);
  });

  it("INFISICAL_URL forblir hardkodet container-intern i begge tjenester (kun selvhostet, bevisst uendret)", () => {
    const apiBlock = extractServiceBlock(compose, "api");
    const workerBlock = extractServiceBlock(compose, "worker");
    expect(apiBlock).toMatch(/INFISICAL_URL:\s*"http:\/\/infisical:8080"/);
    expect(workerBlock).toMatch(/INFISICAL_URL:\s*"http:\/\/infisical:8080"/);
  });

  it("default-verdien (uten .env-override) er identisk med den TIDLIGERE hardkodede verdien - ingen regresjon for lokal-selvhostet-oppsett", () => {
    const apiBlock = extractServiceBlock(compose, "api");
    const match = apiBlock.match(/LANGFUSE_BASE_URL:\s*"\$\{LANGFUSE_BASE_URL:-([^}]+)\}"/);
    expect(match?.[1]).toBe("http://langfuse:3000");
  });
});
