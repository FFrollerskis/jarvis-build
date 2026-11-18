import { describe, expect, it } from "vitest";
import type { ToolDefinition, ToolTransport } from "@jarvis/tool-gateway";
import { OWNER_ONLY_NAMESPACES, ToolManifestViolationError, assertManifestInvariants, buildToolManifest, inferEffect } from "@jarvis/tool-gateway";
import { InvalidCommsConfigError, commsToolDefinitions, parseCommsConfig, type CommsStore } from "../src/index.ts";

/**
 * WP-G1 fiks-runde A-H1: `JARVIS_COMMS_CONTACTS=on` / `JARVIS_COMMS_MEETINGS=on` stoppet API-oppstarten fordi sju klasse A-lesehandlinger (`contacts_list`, `meeting_commitments`, ...) ble tolket som SKRIVING av
 * `inferEffect` (verbet står ikke først i navnet), og `assertManifestInvariants` avviser klasse A + effekt write. Den gamle gateway-chain-testen bygde kun basis-verktøyene og så aldri feilen.
 * Her bygges manifestet for HVER gyldig flaggkombinasjon (16 kombinasjoner med `OUTBOUND=on`) og invariantene kjøres på hver - akkurat som `main.ts` gjør ved oppstart.
 */
const transport = { name: "stub" } as unknown as ToolTransport;
const store = {} as unknown as CommsStore;

const DEPENDENT_FLAGS = ["JARVIS_COMMS_VENDOR_READS", "JARVIS_COMMS_CALLS", "JARVIS_COMMS_CONTACTS", "JARVIS_COMMS_MEETINGS"] as const;

function combinations(): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (let mask = 0; mask < 1 << DEPENDENT_FLAGS.length; mask++) {
    const env: Record<string, string> = { JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "slack,sms,phone" };
    DEPENDENT_FLAGS.forEach((flag, i) => { if ((mask & (1 << i)) !== 0) env[flag] = "on"; });
    out.push(env);
  }
  return out;
}

function defsFor(env: Record<string, string>): ToolDefinition[] {
  const config = parseCommsConfig(env);
  return commsToolDefinitions({ transport, store, vendorReads: config.vendor_reads, calls: config.calls, contacts: config.contacts, meetings: config.meetings });
}

describe("A-H1: manifest-invariantene består for HVER gyldig flaggkombinasjon (oppstartsporten i main.ts)", () => {
  it("alle 16 kombinasjoner av VENDOR_READS/CALLS/CONTACTS/MEETINGS (med OUTBOUND=on) bygger manifest og består assertManifestInvariants", () => {
    const all = combinations();
    expect(all).toHaveLength(16);
    for (const env of all) {
      const label = DEPENDENT_FLAGS.filter((f) => env[f] === "on").join("+") || "kun OUTBOUND";
      const defs = defsFor(env);
      expect(() => assertManifestInvariants(buildToolManifest(defs), { ignoreUnregisteredGrants: true }), label).not.toThrow();
      // verktøy-id-er er unike per kombinasjon (en dobbeltregistrering stopper også oppstarten)
      expect(new Set(defs.map((d) => d.action)).size, label).toBe(defs.length);
    }
  });

  it("ALLE flagg på samtidig: hver klasse A-handling er effekt `read`, hver D-handling krever idempotens, ingen står på en modellflate", () => {
    const env = { ...combinations()[15]! };
    expect(DEPENDENT_FLAGS.every((f) => env[f] === "on")).toBe(true);
    const defs = defsFor(env);
    const manifest = buildToolManifest(defs);
    expect(() => assertManifestInvariants(manifest, { ignoreUnregisteredGrants: true })).not.toThrow();
    expect(OWNER_ONLY_NAMESPACES.has("comms")).toBe(true);
    for (const def of defs) {
      const entry = manifest.get(`${def.tool_id}.${def.action}`)!;
      expect(entry.surfaces, def.action).toEqual([]);
      if (def.capability_class === "A") expect(entry.effect, `${def.action} er klasse A og må være en ren lesing`).toBe("read");
      if (def.capability_class === "D") expect(entry.idempotency, def.action).toBe("required");
    }
    // de sju handlingene som sprengte oppstarten (A-H1) - eksplisitt låst
    for (const action of ["meeting_list", "meeting_commitments", "meeting_check_target", "contacts_list", "contacts_search", "contacts_get", "contacts_check_target"]) {
      expect(inferEffect("comms", action), action).toBe("read");
      expect(manifest.get(`comms.${action}`), action).toMatchObject({ risk: "A", effect: "read" });
    }
  });

  it("en klasse A-handling som tolkes som skriving STOPPER oppstarten (kontroll: porten er ekte, ikke tom)", () => {
    const defs = defsFor(combinations()[15]!);
    const renamed = defs.map((d) => (d.action === "contacts_list" ? { ...d, action: "contacts_enumerate_all" } : d));
    expect(() => assertManifestInvariants(buildToolManifest(renamed), { ignoreUnregisteredGrants: true })).toThrow(ToolManifestViolationError);
  });

  it("avhengige flagg uten OUTBOUND=on stopper oppstarten (fail-closed), hver for seg", () => {
    for (const flag of DEPENDENT_FLAGS) {
      expect(() => parseCommsConfig({ [flag]: "on" }), flag).toThrow(InvalidCommsConfigError);
      expect(() => parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", [flag]: "on" }), flag).not.toThrow();
    }
    // `OUTBOUND=1` er ikke `on` (kun den eksakte verdien slår på)
    expect(() => parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "1", JARVIS_COMMS_MEETINGS: "on" })).toThrow(InvalidCommsConfigError);
  });
});
