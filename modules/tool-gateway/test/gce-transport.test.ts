import { afterEach, describe, expect, it, vi } from "vitest";
import { GceApiError, GceTransport } from "../src/gce-transport.ts";

/**
 * D-337 (Google Cloud "servere"-sliceen): rene wiring-/kontraktstester (INGEN
 * embedded Postgres, INGEN ekte GCP-kall - SAMME `fetch`-stubbing-mønster som
 * `google-ads-transport.test.ts`). Beviser: operation-polling til DONE FØR
 * `invoke()` returnerer, retry/backoff KUN på retry-bare statuser,
 * feilklassifisering uten hemmelighetslekkasje, path-segment-validering
 * (injeksjons-/path-forveksling-forsvar), og bounded polling (ALDRI en
 * uendelig venting).
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const OK_TOKEN_RESPONSE = () => new Response(JSON.stringify({ access_token: "fake-access-token" }), { status: 200 });

function stubGoogleOAuthEnv() {
  vi.stubEnv("JARVIS_GOOGLE_CLIENT_ID", "client-id");
  vi.stubEnv("JARVIS_GOOGLE_CLIENT_SECRET", "client-secret");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("A: konfigurasjonsvalidering - kaster FØR noe HTTP-kall gjøres", () => {
  it("mangler project_id (verken konstruktør- eller env-satt) kaster gce_project_id_not_configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new GceTransport(undefined);
    await expect(transport.invoke("list_instances", { zone: "europe-west1-b" }, "refresh-token")).rejects.toThrow("gce_project_id_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ukjent action kaster gce_action_not_implemented", async () => {
    stubGoogleOAuthEnv();
    vi.stubGlobal("fetch", vi.fn(async () => OK_TOKEN_RESPONSE()));
    const transport = new GceTransport("my-project");
    await expect(transport.invoke("delete_forever", {}, "refresh-token")).rejects.toThrow("gce_action_not_implemented:delete_forever");
  });

  it("ugyldig zone-tegnsett (path-injeksjonsforsøk) kastes FØR noe Compute-kall gjøres", async () => {
    stubGoogleOAuthEnv();
    const fetchSpy = vi.fn(async (url: string) => (url === TOKEN_URL ? OK_TOKEN_RESPONSE() : new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new GceTransport("my-project");
    await expect(transport.invoke("list_instances", { zone: "../../../etc" }, "refresh-token")).rejects.toThrow(/gce_invalid_zone/);
    const computeCall = fetchSpy.mock.calls.find((c) => (c[0] as string).includes("compute.googleapis.com"));
    expect(computeCall).toBeUndefined();
  });

  it("ugyldig instance_name-tegnsett kastes FØR noe Compute-kall gjøres", async () => {
    stubGoogleOAuthEnv();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === TOKEN_URL ? OK_TOKEN_RESPONSE() : new Response("{}", { status: 200 }))));
    const transport = new GceTransport("my-project");
    await expect(transport.invoke("get_instance", { zone: "europe-west1-b", instance_name: "bad;rm -rf" }, "refresh-token")).rejects.toThrow(/gce_invalid_instance_name/);
  });
});

describe("B: list_instances/get_instance - ren leverandør-speiling, korrekt URL-sti", () => {
  it("list_instances kaller GET projects/{project}/zones/{zone}/instances og returnerer items", async () => {
    stubGoogleOAuthEnv();
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) =>
      url === TOKEN_URL ? OK_TOKEN_RESPONSE() : new Response(JSON.stringify({ items: [{ name: "vm-1", status: "RUNNING" }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new GceTransport("my-project");
    const result = await transport.invoke("list_instances", { zone: "europe-west1-b" }, "refresh-token");
    expect(result.data).toEqual([{ name: "vm-1", status: "RUNNING" }]);
    const computeCall = fetchSpy.mock.calls.find((c) => (c[0] as string).includes("compute.googleapis.com"))!;
    expect(computeCall[0]).toBe("https://compute.googleapis.com/compute/v1/projects/my-project/zones/europe-west1-b/instances");
    expect((computeCall[1] as RequestInit).method).toBe("GET");
    expect((computeCall[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer fake-access-token" });
  });

  it("get_instance kaller GET .../instances/{instance_name}", async () => {
    stubGoogleOAuthEnv();
    const fetchSpy = vi.fn(async (url: string) =>
      url === TOKEN_URL ? OK_TOKEN_RESPONSE() : new Response(JSON.stringify({ name: "vm-1", status: "TERMINATED" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new GceTransport("my-project");
    const result = await transport.invoke("get_instance", { zone: "europe-west1-b", instance_name: "vm-1" }, "refresh-token");
    expect(result.data).toEqual({ name: "vm-1", status: "TERMINATED" });
    const computeCall = fetchSpy.mock.calls.find((c) => (c[0] as string).includes("compute.googleapis.com"))!;
    expect(computeCall[0]).toBe("https://compute.googleapis.com/compute/v1/projects/my-project/zones/europe-west1-b/instances/vm-1");
  });
});

describe("C: start_instance/stop_instance/reset_instance - asynkron operation-polling til DONE FØR retur", () => {
  it("start_instance poller operasjonen til DONE, DERETTER leser instans-tilstanden på nytt - external_id er operasjonsnavnet", async () => {
    stubGoogleOAuthEnv();
    let operationPolls = 0;
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/start")) {
        return new Response(JSON.stringify({ name: "operation-123", status: "PENDING" }), { status: 200 });
      }
      if (url.includes("/operations/operation-123")) {
        operationPolls++;
        if (operationPolls < 2) return new Response(JSON.stringify({ name: "operation-123", status: "RUNNING" }), { status: 200 });
        return new Response(JSON.stringify({ name: "operation-123", status: "DONE" }), { status: 200 });
      }
      if (url.endsWith("/instances/vm-1")) return new Response(JSON.stringify({ name: "vm-1", status: "RUNNING" }), { status: 200 });
      throw new Error(`unexpected_url:${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new GceTransport("my-project");
    const result = await transport.invoke("start_instance", { zone: "europe-west1-b", instance_name: "vm-1" }, "refresh-token");
    expect(operationPolls).toBe(2);
    expect(result.external_id).toBe("operation-123");
    expect(result.data).toEqual({ name: "vm-1", status: "RUNNING" });
  }, 10_000);

  it("stop_instance kaller POST .../stop og verifiserer sluttilstanden", async () => {
    stubGoogleOAuthEnv();
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/stop")) return new Response(JSON.stringify({ name: "op-stop", status: "DONE" }), { status: 200 });
      if (url.includes("/operations/op-stop")) return new Response(JSON.stringify({ name: "op-stop", status: "DONE" }), { status: 200 });
      if (url.endsWith("/instances/vm-1")) return new Response(JSON.stringify({ name: "vm-1", status: "TERMINATED" }), { status: 200 });
      throw new Error(`unexpected_url:${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new GceTransport("my-project");
    const result = await transport.invoke("stop_instance", { zone: "europe-west1-b", instance_name: "vm-1" }, "refresh-token");
    expect(result.data).toEqual({ name: "vm-1", status: "TERMINATED" });
  });

  it("reset_instance kaller POST .../reset", async () => {
    stubGoogleOAuthEnv();
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/reset")) return new Response(JSON.stringify({ name: "op-reset", status: "DONE" }), { status: 200 });
      if (url.includes("/operations/op-reset")) return new Response(JSON.stringify({ name: "op-reset", status: "DONE" }), { status: 200 });
      if (url.endsWith("/instances/vm-1")) return new Response(JSON.stringify({ name: "vm-1", status: "RUNNING" }), { status: 200 });
      throw new Error(`unexpected_url:${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new GceTransport("my-project");
    const result = await transport.invoke("reset_instance", { zone: "europe-west1-b", instance_name: "vm-1" }, "refresh-token");
    expect(result.data).toEqual({ name: "vm-1", status: "RUNNING" });
  });

  it("en operasjon som fullfører med en feil (status DONE + error.errors) kaster gce_operation_failed, ALDRI et stille ok:true", async () => {
    stubGoogleOAuthEnv();
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/start")) return new Response(JSON.stringify({ name: "op-fail", status: "PENDING" }), { status: 200 });
      if (url.includes("/operations/op-fail")) {
        return new Response(
          JSON.stringify({ name: "op-fail", status: "DONE", error: { errors: [{ code: "QUOTA_EXCEEDED", message: "no more cpus" }] } }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected_url:${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new GceTransport("my-project");
    await expect(transport.invoke("start_instance", { zone: "europe-west1-b", instance_name: "vm-1" }, "refresh-token")).rejects.toThrow(
      /gce_operation_failed:QUOTA_EXCEEDED:no more cpus/
    );
  });

  it("operasjonen konvergerer ALDRI til DONE -> gce_operation_poll_timeout, ALDRI en uendelig løkke", async () => {
    stubGoogleOAuthEnv();
    let polls = 0;
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/start")) return new Response(JSON.stringify({ name: "op-stuck", status: "PENDING" }), { status: 200 });
      if (url.includes("/operations/op-stuck")) {
        polls++;
        return new Response(JSON.stringify({ name: "op-stuck", status: "RUNNING" }), { status: 200 });
      }
      throw new Error(`unexpected_url:${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    // Injiserer et MINIMALT poll-intervall (test-hull, se GceTransport sin
    // konstruktør-kommentar) - unngår en EKTE 60s ventetid i test-suiten
    // (30 poller x 2000ms produksjons-default) uten å endre selve
    // MAX_OPERATION_POLLS-grensen som testen beviser.
    const transport = new GceTransport("my-project", 1);
    await expect(transport.invoke("start_instance", { zone: "europe-west1-b", instance_name: "vm-1" }, "refresh-token")).rejects.toThrow(
      "gce_operation_poll_timeout"
    );
    expect(polls).toBe(30); // MAX_OPERATION_POLLS, aldri mer
  });
});

describe("D: retry/backoff - KUN på bekreftede retry-bare statuser, ALDRI en retry-storm", () => {
  it("429 etterfulgt av suksess lykkes ETTER retry (bounded, eksponentiell backoff)", async () => {
    stubGoogleOAuthEnv();
    let attempts = 0;
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
      attempts++;
      if (attempts === 1) return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "rate limited" } }), { status: 429 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new GceTransport("my-project");
    const result = await transport.invoke("list_instances", { zone: "europe-west1-b" }, "refresh-token");
    expect(attempts).toBe(2);
    expect(result.data).toEqual([]);
  }, 10_000);

  it("429 vedvarende over maks forsøk kaster GceApiError, ALDRI en uendelig retry-løkke", async () => {
    stubGoogleOAuthEnv();
    let attempts = 0;
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
      attempts++;
      return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "rate limited" } }), { status: 429 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new GceTransport("my-project");
    await expect(transport.invoke("list_instances", { zone: "europe-west1-b" }, "refresh-token")).rejects.toBeInstanceOf(GceApiError);
    expect(attempts).toBe(3); // MAX_ATTEMPTS, aldri mer
  }, 10_000);

  it("401/403 (autentiserings-/autorisasjonsfeil) forsøkes ALDRI på nytt - kastes umiddelbart", async () => {
    stubGoogleOAuthEnv();
    let attempts = 0;
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return OK_TOKEN_RESPONSE();
      attempts++;
      return new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "insufficient scope" } }), { status: 403 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new GceTransport("my-project");
    await expect(transport.invoke("list_instances", { zone: "europe-west1-b" }, "refresh-token")).rejects.toBeInstanceOf(GceApiError);
    expect(attempts).toBe(1);
  });

  it("en ikke-JSON feilkropp klassifiseres trygt (UNCLASSIFIED_ERROR_BODY) uten å knekke", async () => {
    stubGoogleOAuthEnv();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === TOKEN_URL ? OK_TOKEN_RESPONSE() : new Response("<html>502</html>", { status: 502 }))));
    const transport = new GceTransport("my-project");
    await expect(transport.invoke("list_instances", { zone: "europe-west1-b" }, "refresh-token")).rejects.toThrow(/gce_api_error_502:UNCLASSIFIED_ERROR_BODY/);
  }, 10_000);
});

describe("E: nulllekkasje-regresjon - INGEN access-/refresh-token forekommer noe sted i kastede feilmeldinger", () => {
  it("en 403-feil sin melding inneholder ALDRI access-tokenet eller refresh-tokenet", async () => {
    stubGoogleOAuthEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === TOKEN_URL ? OK_TOKEN_RESPONSE() : new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "denied" } }), { status: 403 })))
    );
    const transport = new GceTransport("my-project");
    try {
      await transport.invoke("list_instances", { zone: "europe-west1-b" }, "hemmelig-refresh-token-abc");
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("hemmelig-refresh-token-abc");
      expect(message).not.toContain("fake-access-token");
    }
  });
});
