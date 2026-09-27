import { describe, expect, it } from "vitest";
import { CONNECTOR_REGISTRY, listConnectorStatus } from "../src/connector-registry.ts";

/**
 * Task #119 (integrasjons-dashboard, D-211): DB-uavhengige tester - en fake
 * `{ hasSecret, health }` (nøyaktig `Pick<ToolGateway, "hasSecret"|"health">`
 * `listConnectorStatus()` selv krever) er nok til å bevise presence-/helse-
 * komposisjonen uten embedded Postgres.
 */
function fakeGateway(configured: Set<string>, health: Array<[string, { state: string; at: string; detail?: string }]> = []) {
  return {
    hasSecret: async (ref: string) => configured.has(ref),
    health: new Map(health)
  };
}

describe("A: CONNECTOR_REGISTRY - ren data, ingen duplikate id-er, live_test peker på kjente tool_id/action", () => {
  it("hver connector har en unik id", () => {
    const ids = CONNECTOR_REGISTRY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("hver connector har minst én credential_ref", () => {
    for (const c of CONNECTOR_REGISTRY) {
      expect(c.credential_refs.length).toBeGreaterThan(0);
    }
  });

  it("live_test er satt for 17 av 20 connectorer - github/calendar/gmail (D-211) + google_drive/telegram/vercel/neonomics/wallester (D-213, task #122) + fiken/stripe/vipps (D-242) + slack (D-292) + discord (D-294) + twilio (D-295) + brave_search (D-296) + sentry (D-297) + google_maps (D-298) - resten bevisst avgrenset (anthropic/openai/gemini går via ModelGateway, ikke ToolGateway)", () => {
    const withLiveTest = CONNECTOR_REGISTRY.filter((c) => c.live_test).map((c) => c.id).sort();
    expect(withLiveTest).toEqual(
      ["gmail", "google_calendar", "github", "google_drive", "telegram", "vercel", "neonomics", "wallester", "fiken", "stripe", "vipps", "slack", "discord", "twilio", "brave_search", "sentry", "google_maps"].sort()
    );
  });

  it("live_test.parameters er en FUNKSJON (bygges friskt ved kalletidspunkt, aldri frosset ved modul-last)", () => {
    for (const c of CONNECTOR_REGISTRY) {
      if (c.live_test) expect(typeof c.live_test.parameters).toBe("function");
    }
  });

  it("kun gyldige category-verdier forekommer", () => {
    const valid = new Set(["tool_gateway", "model_provider", "finance", "infra", "backlog", "backlog_d64_gate"]);
    for (const c of CONNECTOR_REGISTRY) {
      expect(valid.has(c.category)).toBe(true);
    }
  });
});

describe("D-232: D-231 backlog-synlighet - opprinnelig 50 NY_BACKLOG-punkter registrert som ikke-tilkoblede oppføringer (D-292/D-294/D-295/D-296/D-297/D-298: 'slack'/'discord'/'twilio'/'brave_search'/'sentry'/'google_maps' gradvis flyttet UT av denne listen og inn i de ekte, bygde connectorene over - registerets TOTALE lengde er uendret, kun kategorien for disse seks id-ene endret)", () => {
  const BACKLOG_IDS = [
    "notion", "onedrive", "dropbox", "google_sheets",
    "microsoft_outlook", "microsoft_365",
    "google_cloud",
    "tavily", "exa", "playwright",
    "openai_realtime", "elevenlabs", "deepgram", "livekit", "telnyx",
    "whatsapp", "higgsfield", "runway", "kling", "google_veo", "openai_images",
    "spotify", "apple_music",
    "n8n", "zapier", "make", "apple_shortcuts",
    "homekit", "philips_hue",
    "folio", "hubspot", "pipedrive", "meta_ads", "linear", "jira", "trello", "todoist",
    "google_places", "google_routes",
    "grafana", "prometheus",
    "apns", "ios_shortcuts", "apple_watch"
  ];

  const D64_GATE_IDS = ["hubspot", "pipedrive", "linear", "jira", "trello", "todoist"];

  it("eksakt 44 gjenværende backlog-id-er finnes, hver nøyaktig én gang, i registeret (50 - 'slack' D-292 - 'discord' D-294 - 'twilio' D-295 - 'brave_search' D-296 - 'sentry' D-297 - 'google_maps' D-298)", () => {
    expect(new Set(BACKLOG_IDS).size).toBe(44);
    expect(BACKLOG_IDS.length).toBe(44);
    const registryIds = new Set(CONNECTOR_REGISTRY.map((c) => c.id));
    for (const id of BACKLOG_IDS) {
      expect(registryIds.has(id)).toBe(true);
    }
  });

  it("registeret har nøyaktig 64 oppføringer totalt (20 bygde, inkl. slack D-292/discord D-294/twilio D-295/brave_search D-296/sentry D-297/google_maps D-298 + 44 gjenværende D-232-backlog-punkter)", () => {
    expect(CONNECTOR_REGISTRY.length).toBe(64);
  });

  it("INGEN av de 50 nye backlog-oppføringene har live_test", () => {
    for (const id of BACKLOG_IDS) {
      const def = CONNECTOR_REGISTRY.find((c) => c.id === id);
      expect(def?.live_test).toBeUndefined();
    }
  });

  it("hver av de 50 nye backlog-oppføringene har category 'backlog' eller 'backlog_d64_gate', aldri en av de fire ekte, bygde kategoriene", () => {
    for (const id of BACKLOG_IDS) {
      const def = CONNECTOR_REGISTRY.find((c) => c.id === id);
      expect(["backlog", "backlog_d64_gate"]).toContain(def?.category);
    }
  });

  it("nøyaktig de seks D-64-port-krevende CRM-/prosjektstyrings-leverandørene har category 'backlog_d64_gate' - resten av backlogen har 'backlog'", () => {
    const actualD64 = CONNECTOR_REGISTRY.filter((c) => c.category === "backlog_d64_gate").map((c) => c.id).sort();
    expect(actualD64).toEqual([...D64_GATE_IDS].sort());
    const actualPlainBacklog = CONNECTOR_REGISTRY.filter((c) => c.category === "backlog").map((c) => c.id).sort();
    expect(actualPlainBacklog).toEqual(
      BACKLOG_IDS.filter((id) => !D64_GATE_IDS.includes(id)).sort()
    );
  });

  it("Supabase/Neo4j/1Password/Windows/macOS er BEVISST IKKE registrert (Q-36/Q-37/Q-38/Q-39, se D-232 i DECISIONS_AND_ASSUMPTIONS.md)", () => {
    const registryIds = new Set(CONNECTOR_REGISTRY.map((c) => c.id));
    for (const excluded of ["supabase", "neo4j", "1password", "windows", "macos"]) {
      expect(registryIds.has(excluded)).toBe(false);
    }
  });

  it("hver nye backlog-oppføring rendres som 'ikke konfigurert', presence_only, helse null - EKSAKT samme mønster som en eksisterende ukonfigurert connector (Fiken/Stripe/Vipps)", async () => {
    const gateway = fakeGateway(new Set());
    const statuses = await listConnectorStatus(gateway);
    for (const id of BACKLOG_IDS) {
      const status = statuses.find((s) => s.id === id);
      expect(status?.configured).toBe(false);
      expect(status?.test_method).toBe("presence_only");
      expect(status?.health).toBeNull();
    }
  });
});

describe("B: listConnectorStatus() - presence per credential_ref, ALDRI selve verdien", () => {
  it("configured=true KUN når ALLE påkrevde refs for connectoren er tilstede", async () => {
    const gateway = fakeGateway(new Set(["JARVIS_GITHUB_TOKEN"]));
    const statuses = await listConnectorStatus(gateway);
    const github = statuses.find((s) => s.id === "github");
    expect(github?.configured).toBe(true);

    const wallester = statuses.find((s) => s.id === "wallester");
    // wallester krever ALLE FIRE refs (D-246: API_BASE_URL/ACCOUNT_ID lagt til) - ingen konfigurert her.
    expect(wallester?.configured).toBe(false);
    expect(wallester?.credentials).toEqual([
      { ref: "JARVIS_WALLESTER_API_KEY", configured: false },
      { ref: "JARVIS_WALLESTER_PRIVATE_KEY_PEM", configured: false },
      { ref: "JARVIS_WALLESTER_API_BASE_URL", configured: false },
      { ref: "JARVIS_WALLESTER_ACCOUNT_ID", configured: false }
    ]);
  });

  it("credentials[] inneholder KUN {ref, configured} - aldri et 'value'-felt eller lignende", async () => {
    const gateway = fakeGateway(new Set(["JARVIS_GITHUB_TOKEN"]));
    const statuses = await listConnectorStatus(gateway);
    for (const status of statuses) {
      for (const cred of status.credentials) {
        expect(Object.keys(cred).sort()).toEqual(["configured", "ref"]);
      }
    }
  });

  it("test_method er 'live' for de 17 utvidede connectorene (D-211/D-213/D-242/D-292/D-294/D-295/D-296/D-297/D-298), 'presence_only' for resten", async () => {
    const gateway = fakeGateway(new Set());
    const statuses = await listConnectorStatus(gateway);
    const byId = new Map(statuses.map((s) => [s.id, s]));
    for (const id of ["github", "google_calendar", "gmail", "google_drive", "telegram", "vercel", "neonomics", "wallester", "fiken", "stripe", "vipps", "slack", "discord", "twilio", "brave_search", "sentry", "google_maps"]) {
      expect(byId.get(id)?.test_method).toBe("live");
    }
    for (const id of ["anthropic", "openai", "gemini"]) {
      expect(byId.get(id)?.test_method).toBe("presence_only");
    }
  });

  it("health speiler gateway.health for connectorer med live_test (nøkkel = live_test.tool_id), null når intet forsøkt ennå", async () => {
    const gateway = fakeGateway(new Set(), [["github", { state: "healthy", at: "2026-09-20T12:00:00.000Z" }]]);
    const statuses = await listConnectorStatus(gateway);
    const github = statuses.find((s) => s.id === "github");
    expect(github?.health).toEqual({ state: "healthy", at: "2026-09-20T12:00:00.000Z" });
    const telegram = statuses.find((s) => s.id === "telegram");
    expect(telegram?.health).toBeNull();
  });

  it("returnerer nøyaktig ETT element per registeroppføring, i samme rekkefølge", async () => {
    const gateway = fakeGateway(new Set());
    const statuses = await listConnectorStatus(gateway);
    expect(statuses.map((s) => s.id)).toEqual(CONNECTOR_REGISTRY.map((c) => c.id));
  });
});
