import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type { ToolInvocationContext, ToolTransport } from "@jarvis/tool-gateway";
import { buildCommsRuntime } from "../src/comms-wiring.ts";

/**
 * WP-G1c (D-481, JARVIS-112 g5): oppkoblingen av STOP-vakten rundt de eldre `*.notify`-transportene (uten database; selve vakten og avmeldingsoppslaget er bevist mot ekte Postgres i `modules/comms/test/legacy-notify-guard.test.ts`).
 *  - ALLE `JARVIS_COMMS_*` AV: `guardLegacyNotifyTransport` returnerer transporten UENDRET (samme objekt) - identisk med main.
 *  - comms PÅ: de fem transportene pakkes inn; en `notify` slås opp mot avmeldingsregisteret og FEILER LUKKET når oppslaget ikke går (her: en tom pool), mens alle andre handlinger går rett gjennom.
 *  - main.ts pakker nøyaktig de fem transportene, via fabrikken (kildevakt).
 */
const LEGACY = ["twilio", "telnyx", "whatsapp", "slack", "discord"] as const;
const identity: IdentityContext = { person_id: "p-wire", tenant_id: "tenant-wire", memory_space_id: "business", session_id: "s-wire", device_id: "d-wire", channel: "api", auth_strength: "signed" };
const context: ToolInvocationContext = { identity };
const recorder = (): ToolTransport & { readonly calls: string[] } => {
  const calls: string[] = [];
  return { calls, async invoke(action: string) { calls.push(action); return { external_id: "ok" }; } };
};
const build = (env: Record<string, string>, warn?: (e: Record<string, unknown>) => void) =>
  buildCommsRuntime({ env, pool: {} as never, graph: {} as never, business: {} as never, secrets: { get: async () => null }, ...(warn ? { warn } : {}) });

describe("flagg AV: identisk med main", () => {
  it("ingen innpakking: samme transportobjekt tilbake for alle de fem (og for ukjente id-er), uavhengig av hvilke ugyldige flaggverdier som står", () => {
    for (const env of [{}, { JARVIS_COMMS_OUTBOUND: "" }, { JARVIS_COMMS_OUTBOUND: "true" }, { JARVIS_COMMS_WEBHOOKS: "" }]) {
      const rt = build(env);
      for (const id of [...LEGACY, "telegram", "email"]) {
        const t = recorder();
        expect(rt.guardLegacyNotifyTransport(id, t), `${JSON.stringify(env)} ${id}`).toBe(t);
      }
    }
  });
});

describe("comms PÅ: vakten er koblet inn", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  it("de fem eldre transportene pakkes inn; øvrige id-er (telegram, e-post) pakkes IKKE inn", () => {
    const rt = build({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "sms" });
    for (const id of LEGACY) {
      const t = recorder();
      expect(rt.guardLegacyNotifyTransport(id, t), id).not.toBe(t);
    }
    for (const id of ["telegram", "email", "github"]) {
      const t = recorder();
      expect(rt.guardLegacyNotifyTransport(id, t), id).toBe(t);
    }
    log.mockClear();
  });

  it("også med KUN webhooks på (STOP registreres, selv om utgående er av): `notify` slås opp og feiler LUKKET når oppslaget ikke går; lesehandlinger går rett gjennom; loggen har kun en fast kode", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const rt = build({ JARVIS_COMMS_WEBHOOKS: "twilio", JARVIS_COMMS_TENANT_ID: "tenant-wire" }, (e) => warnings.push(e));
    for (const id of LEGACY) {
      const inner = recorder();
      const guarded = rt.guardLegacyNotifyTransport(id, inner);
      const params: Record<string, JsonValue> = id === "slack" ? { channel: "C0AAAAAAAA", message: "hei" } : id === "discord" ? { channel_id: "1".repeat(18), message: "hei" } : { to: "+4799001122", message: "hei" };
      await expect(guarded.invoke("notify", params, "cred", context), id).rejects.toThrow("comms_policy_denied:opt_out_check_unavailable");
      expect(inner.calls, `${id}: transporten skal ikke nås`).toEqual([]);
      await guarded.invoke("get_account_info", {}, "cred", context);
      expect(inner.calls, `${id}: lesing går gjennom`).toEqual(["get_account_info"]);
    }
    expect(warnings.every((w) => w["msg"] === "comms_legacy_notify_optout_check_failed")).toBe(true);
    expect(JSON.stringify(warnings)).not.toContain("4799001122");
    log.mockClear();
  });
});

describe("main.ts: kildevakt", () => {
  const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");

  it("nøyaktig de fem eldre transportene pakkes inn via fabrikken, og fabrikken er bygget FØR transportene", () => {
    for (const id of LEGACY) expect(main.match(new RegExp(`commsRuntime\\.guardLegacyNotifyTransport\\("${id}"`, "g")), id).toHaveLength(1);
    expect(main.match(/commsRuntime\.guardLegacyNotifyTransport\(/g)).toHaveLength(5);
    expect(main.indexOf("const commsRuntime = buildCommsRuntime(")).toBeGreaterThan(0);
    expect(main.indexOf("const commsRuntime = buildCommsRuntime(")).toBeLessThan(main.indexOf('commsRuntime.guardLegacyNotifyTransport("slack"'));
  });
});
