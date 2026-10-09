import { describe, expect, it } from "vitest";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";
import {
  CHAT_ACT_TIER, CHAT_READ_TIER, MODEL_SURFACE_ALLOWLIST, MODEL_SURFACE_QUARANTINE_WRITES, MemorySearchTransport, MeshToolExecutor, SURFACE_TOOL_GRANTS,
  assertChatActTier, assertManifestInvariants, assertReadOnlyModelSurface, buildToolManifest, createTurnContext, firstWaveTools, homeAssistantTools,
  memoryToolDefinitions, resolveModelToolSurface, selectSurfaceTools, type ConfirmationGate, type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";

/**
 * WP-D2 (JARVIS-049): de nye pipeline-handlingene står i chattens HANDLINGSNIVÅ (bak eierens bundne bekreftelse) og ALDRI på MODEL_SURFACE_ALLOWLIST
 * (ADR-001 §2.3 pkt 1). Denne filen låser mengden bevisst: en ny business-handling på modellflaten krever at denne testen endres.
 */
const NEW_ACT_KEYS = [
  "business.update_lead", "business.update_opportunity", "business.set_next_action",
  "business.close_lead", "business.close_opportunity", "business.delete_lead", "business.delete_opportunity"
];
const CLASS_C = new Set(["business.close_lead", "business.close_opportunity", "business.delete_lead", "business.delete_opportunity"]);

function productionDefinitions(): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw))),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never))
    ]
  });
}
const defs = productionDefinitions();
const gw = { list: () => defs } as unknown as ToolGateway;
const manifest = buildToolManifest(defs);
const surface = resolveModelToolSurface(gw, { includeChatReadTier: true, includeChatActTier: true });
const identity = { tenant_id: "tenant-1", person_id: "person-1", memory_space_id: "business", device_id: "dev-1", session_id: "s-1" };
const key = (g: { tool_id: string; action: string }) => `${g.tool_id}.${g.action}`;

describe("handlingsnivået: nøyaktig de nye pipeline-handlingene, riktig risikoklasse og effekt", () => {
  it("alle 7 står i CHAT_ACT_TIER, men ALDRI på MODEL_SURFACE_ALLOWLIST, karantene-skriving eller lese-nivået", () => {
    const act = new Set(CHAT_ACT_TIER.map(key));
    for (const k of NEW_ACT_KEYS) {
      expect(act.has(k), k).toBe(true);
      expect(MODEL_SURFACE_ALLOWLIST.map(key), k).not.toContain(k);
      expect(MODEL_SURFACE_QUARANTINE_WRITES.map(key), k).not.toContain(k);
      expect(CHAT_READ_TIER.map(key), k).not.toContain(k);
    }
    // modellflaten uten handlingsnivå er fortsatt ren lese-flate (assertReadOnlyModelSurface består uendret)
    expect(() => assertReadOnlyModelSurface(gw)).not.toThrow();
    expect(() => assertChatActTier(gw)).not.toThrow();
    expect(() => assertManifestInvariants(manifest)).not.toThrow();
  });

  it("klasse: opprett/oppdater/neste-handling = B/write; lukk = C/write; slett = C/delete (aldri D, aldri pay/control)", () => {
    for (const k of NEW_ACT_KEYS) {
      const e = manifest.get(k)!;
      expect(e.owner, k).toBe("jarvis_core");
      expect(e.data_zone, k).toBe("internal");
      expect(e.risk, k).toBe(CLASS_C.has(k) ? "C" : "B");
      expect(e.effect, k).toBe(k.includes("delete_") ? "delete" : "write");
      expect(e.surfaces, k).toEqual(["web_chat"]);
      expect(e.cost, k).toBe("free");
      expect(["pay", "control"]).not.toContain(e.effect);
    }
    expect(manifest.get("business.delete_lead")!.recovery).toBe("none"); // ikke reverserbar som sletting
    expect(manifest.get("business.close_lead")!.preflight).toBe(true); // før/etter-evidens
    expect(manifest.get("business.delete_opportunity")!.preflight).toBe(true);
    // de to eksisterende klasse C-handlingene fikk også før/etter-evidens
    expect(manifest.get("business.update_lead_status")!.preflight).toBe(true);
    expect(manifest.get("business.update_opportunity_stage")!.preflight).toBe(true);
  });

  it("tale, Telegram, bakgrunn og kode har ALDRI en av dem (kun web_chat)", () => {
    for (const s of ["voice", "telegram", "background", "coding"] as const) {
      const granted = SURFACE_TOOL_GRANTS[s].map(key);
      for (const k of NEW_ACT_KEYS) expect(granted, `${s}: ${k}`).not.toContain(k);
    }
  });

  it("modellens skjema har ikke identitetsfelt (tenant_id/memory_space) og update-skjemaene har IKKE owner_person_id (ville blitt bundet til aktøren)", () => {
    for (const k of NEW_ACT_KEYS) {
      const mapping = surface.find((m) => key(m) === k)!;
      expect(mapping.kind, k).toBe("act");
      const props = Object.keys((mapping.def.input_schema as { properties: Record<string, unknown> }).properties);
      for (const forbidden of ["tenant_id", "memory_space", "owner_person_id", "person_id", "actor_person_id"]) expect(props, `${k}: ${forbidden}`).not.toContain(forbidden);
      expect(props, k).toContain("idempotency_key");
      expect(mapping.scope_bindings, k).toEqual(expect.arrayContaining(["tenant_id", "memory_space"]));
    }
    const upd = surface.find((m) => key(m) === "business.update_lead")!;
    expect(Object.keys((upd.def.input_schema as { properties: Record<string, unknown> }).properties)).toContain("assign_to_person_id");
  });
});

describe("utvalg: handlingen eieren ber om rangeres først", () => {
  const pick = (text: string) => selectSurfaceTools("web_chat", text, surface).selected.filter((m) => m.tool_id === "business").map(key);
  it("«lukk salgsmuligheten som vunnet» -> close_opportunity; «slett leaden» -> delete_lead; «sett neste handling på leaden» -> set_next_action", () => {
    expect(pick("lukk salgsmuligheten som vunnet")).toContain("business.close_opportunity");
    expect(pick("slett leaden fra messa")).toContain("business.delete_lead");
    expect(pick("sett neste handling på leaden: ring på mandag")).toContain("business.set_next_action");
    expect(pick("oppdater muligheten med verdi 50 000 kr")).toContain("business.update_opportunity");
  });
  it("kun lesing nevnt -> ingen av de nye handlingene velges", () => {
    const read = selectSurfaceTools("web_chat", "vis meg leadene og mulighetene", surface).selected.map(key);
    for (const k of NEW_ACT_KEYS) expect(read, k).not.toContain(k);
  });
  it("tale velger aldri en av dem, selv med handlingsord", () => {
    const sel = selectSurfaceTools("voice", "slett leaden og lukk muligheten", surface).selected.map(key);
    for (const k of NEW_ACT_KEYS) expect(sel).not.toContain(k);
  });
});

describe("executor: HVER av dem krever bundet eierbekreftelse - utføres aldri direkte", () => {
  for (const k of NEW_ACT_KEYS) {
    it(`${k}: bekreftelse opprettes (owner_action_tier), ingenting kjøres`, async () => {
      const mapping = surface.find((m) => key(m) === k)!;
      const executed: string[] = [];
      const gateway = { execute: async (req: { tool_id: string; action: string }) => { executed.push(`${req.tool_id}.${req.action}`); return { ok: true, data: {}, output_trust: "internal" }; } } as unknown as ToolGateway;
      const seen: Array<{ tool: string; reasons: string[]; parameters: Record<string, unknown> }> = [];
      const gate: ConfirmationGate = {
        checkAndConsume: async (c, _who, reasons) => { seen.push({ tool: `${c.tool_id}.${c.action}`, reasons, parameters: c.parameters }); return { ok: false, reason: "confirmation_required", confirmation_id: "conf-1" }; }
      };
      const turn = createTurnContext("web_chat", "slett leaden");
      const ex = new MeshToolExecutor(gateway, identity, 20_000, surface, turn, { manifest, confirmations: gate });
      const res = await ex.execute({ tool_call_id: "c1", tool_name: mapping.def.name, arguments: { lead_id: "biz-ld-1", opportunity_id: "biz-op-1", outcome: "won", entity_type: "lead", entity_id: "biz-ld-1", next_action: "ring", tenant_id: "tenant-EVIL", memory_space: "personal" }, provider: "gemma_local", model: "m" }, { tenant_id: "tenant-1", idempotency_key: "k" });
      expect(res.success).toBe(false);
      expect(res.error_category).toBe("CONFIRMATION_REQUIRED");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.tool).toBe(k);
      expect(seen[0]!.reasons).toEqual(["owner_action_tier"]);
      // modellens forsøk på å oppgi tenant/space overstyres av identiteten FØR bekreftelsen bindes
      expect(seen[0]!.parameters["tenant_id"]).toBe("tenant-1");
      expect(seen[0]!.parameters["memory_space"]).toBe("business");
      expect(executed).toEqual([]);
    });
  }
});
