import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserEngine } from "../src/browser-engine.ts";
import { createBrowserGateway } from "../src/server.ts";

/**
 * D-339: rene HTTP-kontraktstester mot `createBrowserGateway()` - en
 * `FakeBrowserEngine` (INGEN ekte Chromium startet) beviser rutings-/
 * feilhåndteringslogikken, SAMME "fake i test, ekte i drift"-mønster som
 * `FakeTransport` i `modules/tool-gateway`. Ekte nettleser-oppførsel
 * (`PlaywrightBrowserEngine`) forblir PENDING host-akseptanse - se
 * `BROWSER_GATEWAY_LIVE_GATE` i DECISIONS_AND_ASSUMPTIONS.md.
 */
class FakeBrowserEngine implements BrowserEngine {
  navigateCalls: string[] = [];
  closed = false;

  async navigate(url: string) {
    this.navigateCalls.push(url);
    return { url, title: "Fake Page Title" };
  }
  async extractText() {
    return "fake extracted text";
  }
  async screenshot() {
    return "ZmFrZS1wbmctYnl0ZXM=";
  }
  async close() {
    this.closed = true;
  }
}

let engine: FakeBrowserEngine;
let baseUrl: string;
let server: ReturnType<typeof createBrowserGateway>;

beforeEach(async () => {
  engine = new FakeBrowserEngine();
  server = createBrowserGateway({ engine });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function invoke(action: string, parameters: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, parameters })
  });
  return { status: response.status, body: (await response.json()) as { data?: unknown; error?: string } };
}

describe("A: /health", () => {
  it("svarer 200 med status ok", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});

describe("B: POST /invoke - navigate", () => {
  it("kaller engine.navigate med URL-en og returnerer resultatet", async () => {
    const { status, body } = await invoke("navigate", { url: "https://example.com" });
    expect(status).toBe(200);
    expect(body.data).toEqual({ url: "https://example.com/", title: "Fake Page Title" });
    expect(engine.navigateCalls).toEqual(["https://example.com/"]);
  });

  it("manglende url avvises FØR engine.navigate() kalles", async () => {
    const { status, body } = await invoke("navigate", {});
    expect(status).toBe(400);
    expect(body.error).toBe("browser_gateway_missing_url");
    expect(engine.navigateCalls).toEqual([]);
  });

  it("ugyldig protokoll (file://) avvises - kun http/https navigerbart", async () => {
    const { status, body } = await invoke("navigate", { url: "file:///etc/passwd" });
    expect(status).toBe(400);
    expect(body.error).toBe("browser_gateway_unsupported_url_protocol");
    expect(engine.navigateCalls).toEqual([]);
  });
});

describe("C: POST /invoke - extract_text/screenshot", () => {
  it("extract_text returnerer { text }", async () => {
    const { status, body } = await invoke("extract_text");
    expect(status).toBe(200);
    expect(body.data).toEqual({ text: "fake extracted text" });
  });

  it("screenshot returnerer { image_base64 }", async () => {
    const { status, body } = await invoke("screenshot");
    expect(status).toBe(200);
    expect(body.data).toEqual({ image_base64: "ZmFrZS1wbmctYnl0ZXM=" });
  });
});

describe("D: ukjent action / feilhåndtering", () => {
  it("click/fill_form/submit finnes IKKE denne sliceen - avvises som ukjent action, SAMME som en fabrikkert action", async () => {
    for (const action of ["click", "fill_form", "submit", "call_tool"]) {
      const { status, body } = await invoke(action);
      expect(status).toBe(400);
      expect(body.error).toBe(`browser_gateway_action_not_implemented:${action}`);
    }
  });

  it("ugyldig JSON-kropp avvises med 400, ALDRI en uhåndtert exception", async () => {
    const response = await fetch(`${baseUrl}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json"
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("browser_gateway_invalid_json");
  });

  it("ukjent sti/metode gir 404", async () => {
    const response = await fetch(`${baseUrl}/nonexistent`);
    expect(response.status).toBe(404);
  });
});
