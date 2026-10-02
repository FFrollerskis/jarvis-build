import { describe, expect, it } from "vitest";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  MIN_RISK_BY_EFFECT,
  OWNER_ONLY_NAMESPACES,
  SURFACES,
  SURFACE_TOOL_GRANTS,
  MemorySearchTransport,
  ToolManifestViolationError,
  assertManifestInvariants,
  buildToolManifest,
  firstWaveTools,
  inferEffect,
  memoryToolDefinitions,
  requiresConfirmationWhenTainted,
  type ToolDefinition,
  type ToolGateway
} from "@jarvis/tool-gateway";

/** Del 3 (JARVIS-002/015): ett sentralt manifest avledet fra de ekte produksjonsdefinisjonene, med deterministiske invarianter. */
function productionDefinitions(): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw))),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never))
    ]
  });
}

const defs = productionDefinitions();
const manifest = buildToolManifest(defs);
const entries = [...manifest.values()];

describe("manifest dekker ALLE registrerte handlinger", () => {
  it("én oppføring per definisjon, ingen duplikater, alle felt satt", () => {
    expect(entries.length).toBe(defs.length);
    expect(entries.length).toBeGreaterThan(400);
    for (const e of entries) {
      expect(["A", "B", "C", "D"]).toContain(e.risk);
      expect(["read", "write", "send", "pay", "delete", "control"]).toContain(e.effect);
      expect(["internal", "vendor_cloud", "financial"]).toContain(e.data_zone);
      expect(["public", "private", "business", "restricted"]).toContain(e.sensitivity);
      expect(["free", "metered", "paid"]).toContain(e.cost);
      expect(["none", "vendor", "owner_configured_url"]).toContain(e.network);
    }
  });

  it("invariantene holder for produksjonsregisteret (effekt→minimumsklasse, ingen farlige handlinger på modellflater)", () => {
    expect(() => assertManifestInvariants(manifest)).not.toThrow();
  });

  it("klasse D krever idempotens; send/pay/delete/control er aldri klasse A/B (unntatt begrunnede unntak)", () => {
    for (const e of entries) {
      if (e.risk === "D") expect(e.idempotency).toBe("required");
    }
    const exceptions = new Set(["telegram.notify", "memory.propose", "finance_wallester.freeze_card"]);
    for (const e of entries) {
      if (["send", "pay", "delete", "control"].includes(e.effect) && !exceptions.has(e.key)) {
        expect(["C", "D"], `${e.key} (${e.effect})`).toContain(e.risk);
      }
    }
    expect(MIN_RISK_BY_EFFECT.send).toBe("C");
  });
});

describe("reklassifisering (JARVIS-015): utgående og betalte handlinger er ikke lenger uskyldig klasse B", () => {
  const mustBeC = [
    "slack.notify", "discord.notify", "twilio.notify", "whatsapp.notify", "telnyx.notify",
    "make.run_scenario", "n8n.activate_workflow",
    "openai_images.generate_image", "runway.generate_video", "kling.generate_video", "google_veo.generate_video", "higgsfield.generate_video",
    "github.comment_on_issue", "github.rerun_workflow_run", "github.cancel_workflow_run"
  ];
  for (const key of mustBeC) {
    it(`${key} er minst klasse C`, () => {
      expect(["C", "D"]).toContain(manifest.get(key)?.risk);
    });
  }
  it("betalt kostnadstype er merket på SMS og mediegenerering", () => {
    for (const key of ["twilio.notify", "openai_images.generate_image", "runway.generate_video"]) expect(manifest.get(key)?.cost).toBe("paid");
  });
});

describe("flater (surfaces)", () => {
  it("default er INGEN flate: kun eksplisitt tildelte handlinger har surfaces", () => {
    const granted = new Set(SURFACES.flatMap((s) => SURFACE_TOOL_GRANTS[s].map((g) => `${g.tool_id}.${g.action}`)));
    for (const e of entries) {
      if (granted.has(e.key)) expect(e.surfaces.length).toBeGreaterThan(0);
      else expect(e.surfaces, e.key).toEqual([]);
    }
  });

  it("Telegram, tale og bakgrunn er read-only; coding har ingen gateway-verktøy", () => {
    for (const surface of ["telegram", "voice", "background"] as const) {
      for (const g of SURFACE_TOOL_GRANTS[surface]) expect(manifest.get(`${g.tool_id}.${g.action}`)?.effect, `${surface}:${g.action}`).toBe("read");
    }
    expect(SURFACE_TOOL_GRANTS.coding).toEqual([]);
    expect(manifest.get("memory.propose")?.surfaces).toEqual(["web_chat"]);
  });

  it("structural invariant: eier-eksklusive navnerom (kontroll, penger, infra, selvmod, samtykke) finnes ikke på NOEN flate", () => {
    for (const e of entries) {
      if (OWNER_ONLY_NAMESPACES.has(e.tool_id)) expect(e.surfaces, e.key).toEqual([]);
    }
    for (const key of [
      "owner_controls.set_connector_credential", "owner_controls.revoke_device", "owner_controls.activate_kill_switch",
      "executive.revoke_device", "executive.activate_kill_switch", "finance.submit_payment_intent", "consent.record_decision", "email.send"
    ]) {
      const e = manifest.get(key);
      if (e) expect(e.surfaces, key).toEqual([]);
    }
  });

  it("ingen flate-handling har identitetsfelt (tenant/person/space) i modellskjemaet", () => {
    for (const e of entries) if (e.surfaces.length > 0) expect(e.scope_fields, e.key).toEqual([]);
  });

  it("en utvidelse som bryter reglene feiler lukket (mutasjonstest)", () => {
    const bad = new Map(manifest);
    const base = manifest.get("email.send")!;
    bad.set("email.send", { ...base, surfaces: ["web_chat"] });
    expect(() => assertManifestInvariants(bad)).toThrow(ToolManifestViolationError);
    const bad2 = new Map(manifest);
    const sms = manifest.get("twilio.notify")!;
    bad2.set("twilio.notify", { ...sms, risk: "B" });
    expect(() => assertManifestInvariants(bad2)).toThrow(/krever minst klasse C/);
  });
});

describe("taint-regelen: hva krever ny bekreftelse når turen er tainted", () => {
  it("C/D og utgående/betalt/ekstern skriving ja; lesing og interne karantene-skrivinger nei", () => {
    const need = (key: string) => requiresConfirmationWhenTainted(manifest.get(key)!);
    expect(need("email.send")).toBe(true);
    expect(need("twilio.notify")).toBe(true);
    expect(need("google_sheets.append_row")).toBe(true); // ekstern skriving, klasse B
    expect(need("hubspot.create_object")).toBe(true);
    expect(need("telegram.notify")).toBe(true); // utgående B
    expect(need("email.read_inbox")).toBe(false);
    expect(need("memory.search")).toBe(false);
    expect(need("memory.propose")).toBe(false);
  });
});

describe("effektinferens", () => {
  it("klassiske verb", () => {
    expect(inferEffect("x", "get_thing")).toBe("read");
    expect(inferEffect("x", "list_items")).toBe("read");
    expect(inferEffect("x", "send_mail")).toBe("send");
    expect(inferEffect("x", "delete_file")).toBe("delete");
    expect(inferEffect("x", "submit_refund")).toBe("pay");
    expect(inferEffect("x", "create_issue")).toBe("write");
  });
});
