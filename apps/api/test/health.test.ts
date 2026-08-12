import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "../src/server.js";

const server = createApiServer();
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("Test 9: health-endepunkt", () => {
  it("API-et starter og /health svarer korrekt", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["service"]).toBe("jarvis-api");
    expect(typeof body["time"]).toBe("string");
  });

  it("ukjent rute gir 404", async () => {
    const response = await fetch(`${baseUrl}/finnes-ikke`);
    expect(response.status).toBe(404);
  });
});
