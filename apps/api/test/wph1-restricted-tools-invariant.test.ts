import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  CLOUD_WITHHELD_CENTERS, CONTROL_CENTER_READ_TOOLS, EXECUTION_GUARDED_RESTRICTED_KEYS, ExecutiveService, ExecutiveTransport, controlCenterForReadAction, controlItem, controlSection, executiveToolDefinitions,
  type ControlCenterDefinition, type ControlCenterId
} from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  KnowledgeSearchTransport, MemorySearchTransport, buildToolManifest, firstWaveTools, homeAssistantTools, isSelectionLockedTool, knowledgeToolDefinitions, memoryToolDefinitions,
  type ToolDefinition, type ToolGateway, type ToolManifest, type ToolManifestEntry
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { createControlCenterRegistry } from "../src/control-center/register.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";

/**
 * Gjennomgang M2 (H-review): «Manifestet merker verktøyet `restricted` og runbook sier «aldri til sky» - men låsen gjaldt bare når verktøyet ble VALGT av utvalget». En lås i utvalget er ikke en lås ved utførelse
 * (`MeshToolExecutor` sjekker bare flate-tildelingen), så en skymodell som kaller et ikke-valgt verktøy omgår den. INVARIANTEN som låser det her, over hele produksjonsmanifestet (alle senter-flagg på):
 *
 *   hvert verktøy som manifestet merker `restricted` og som står på en modellflate er enten
 *     (a) HÅNDHEVET VED UTFØRELSE mot skymodeller (`EXECUTION_GUARDED_RESTRICTED_KEYS` - transporten holder dataene tilbake når `servingModel` er en skymodell), eller
 *     (b) en EKSPLISITT AKSEPTERT «valg-kun-lås» (`ACCEPTED_SELECTION_ONLY` under: de eksisterende `finance_*`-verktøyene fra main, som ikke er endret av WP-H1) - aldri stille.
 *   Og i begge tilfeller er verktøyet låst i utvalget (turen blir lokal når det velges).
 *
 * Et NYTT `restricted` verktøy på en modellflate som ikke er i noen av de to mengdene feiler denne testen - da må forfatteren enten håndheve ved utførelse eller bevisst akseptere (og logge) valg-kun-låsen.
 */
const ALL_CENTERS: ReadonlyArray<ControlCenterId> = CONTROL_CENTER_READ_TOOLS.map((t) => t.center);
const keyOf = (e: { tool_id: string; action: string }): string => `${e.tool_id}.${e.action}`;

/**
 * De EKSISTERENDE finans-verktøyene (`finance`, `finance_spend`, `finance_stripe`, `finance_vipps`, `finance_neonomics`, `finance_wallester` ...): `restricted` og låst i utvalget siden før WP-H1. En valg-kun-lås er
 * NOE SVAKERE enn en utførelses-lås (en skymodell som hallusinerer/injiseres til å kalle et ikke-valgt `finance_*`-verktøy omgår den) - akseptert som det er og IKKE endret av WP-H1 (flagg-uavhengig, utenfor
 * kontrollsenter-scope); åpen anbefaling til leder: en generell utførelses-lås i ToolGateway/MeshToolExecutor for alle `restricted` verktøy. Se H1-sluttrapporten.
 */
const ACCEPTED_SELECTION_ONLY = /^finance(_[a-z]+)?$/;

function productionManifest(): ToolManifest {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  const defs: ToolDefinition[] = firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, {})), { controlCenters: ALL_CENTERS }),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never)),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never))
    ]
  });
  return buildToolManifest(defs);
}

/** Alle `restricted` verktøy på en modellflate som er verken utførelses-håndhevet eller eksplisitt akseptert, pluss de som ikke er låst i utvalget. */
function restrictedGaps(manifest: ToolManifest, guarded: ReadonlySet<string>): string[] {
  const gaps: string[] = [];
  for (const entry of manifest.values()) {
    if (entry.sensitivity !== "restricted" || entry.surfaces.length === 0) continue;
    const key = keyOf(entry);
    if (!isSelectionLockedTool(entry.tool_id, entry.action)) gaps.push(`${key}: restricted på ${entry.surfaces.join("/")} men IKKE låst i utvalget`);
    if (!guarded.has(key) && !ACCEPTED_SELECTION_ONLY.test(entry.tool_id)) gaps.push(`${key}: restricted på ${entry.surfaces.join("/")} - hverken håndhevet ved utførelse eller eksplisitt akseptert valg-kun-lås`);
  }
  return gaps.sort();
}

describe("invariant: restricted + modellflate => låst i utvalget OG (håndhevet ved utførelse ELLER eksplisitt akseptert)", () => {
  const manifest = productionManifest();
  const restricted = [...manifest.values()].filter((e) => e.sensitivity === "restricted" && e.surfaces.length > 0);

  it("testen er ikke tom: produksjonsmanifestet har restricted verktøy på modellflater (finance_*, Finans-senteret og - fra WP-H2, gjennomgang M2 - Verdi-senteret)", () => {
    const keys = restricted.map(keyOf);
    expect(keys).toContain("executive.get_finance_center");
    expect(keys).toContain("executive.get_value_center");
    expect(keys.filter((k) => ACCEPTED_SELECTION_ONLY.test(k.split(".")[0] as string)).length).toBeGreaterThan(20);
  });

  it("INGEN gap: hvert restricted verktøy på en modellflate er låst i utvalget og enten utførelses-håndhevet eller eksplisitt akseptert", () => {
    expect(restrictedGaps(manifest, EXECUTION_GUARDED_RESTRICTED_KEYS)).toEqual([]);
  });

  it("Finans- og Verdi-senteret er IKKE valg-kun-låser: de står i EXECUTION_GUARDED_RESTRICTED_KEYS (og er restricted + låst), og mengden inneholder bare restricted, registrerte verktøy", () => {
    expect(EXECUTION_GUARDED_RESTRICTED_KEYS.has("executive.get_finance_center")).toBe(true);
    expect(EXECUTION_GUARDED_RESTRICTED_KEYS.has("executive.get_value_center")).toBe(true);
    expect(ACCEPTED_SELECTION_ONLY.test("executive")).toBe(false);
    for (const key of EXECUTION_GUARDED_RESTRICTED_KEYS) {
      const entry = manifest.get(key) as ToolManifestEntry | undefined;
      expect(entry, key).toBeDefined();
      expect(entry?.sensitivity, key).toBe("restricted");
      expect(isSelectionLockedTool(entry?.tool_id ?? "", entry?.action ?? ""), key).toBe(true);
    }
  });

  it("hvert senter i CLOUD_WITHHELD_CENTERS har sitt lese-verktøy i den utførelses-håndhevede mengden, og omvendt", () => {
    const toolKeys = CLOUD_WITHHELD_CENTERS.map((center) => {
      const tool = CONTROL_CENTER_READ_TOOLS.find((t) => t.center === center);
      expect(tool, center).toBeDefined();
      return `executive.${tool?.action}`;
    });
    expect([...EXECUTION_GUARDED_RESTRICTED_KEYS].sort()).toEqual(toolKeys.sort());
    for (const key of EXECUTION_GUARDED_RESTRICTED_KEYS) expect(CLOUD_WITHHELD_CENTERS).toContain(controlCenterForReadAction(key.split(".")[1] as string));
  });

  it("mutasjonstest: et NYTT restricted verktøy på en modellflate uten lås eller utførelses-vern FEILER invarianten (og en kun-valg-lås utenfor finans-namespacet også)", () => {
    const base = manifest.get("executive.get_memory_center") as ToolManifestEntry;
    const fake = (tool_id: string, action: string, surfaces: ToolManifestEntry["surfaces"]): ToolManifestEntry => ({ ...base, key: `${tool_id}.${action}`, tool_id, action, sensitivity: "restricted", surfaces });
    const withUnlocked: ToolManifest = new Map([...manifest, ["executive.get_health_center", fake("executive", "get_health_center", ["web_chat"])]]);
    expect(restrictedGaps(withUnlocked, EXECUTION_GUARDED_RESTRICTED_KEYS)).toEqual([
      "executive.get_health_center: restricted på web_chat - hverken håndhevet ved utførelse eller eksplisitt akseptert valg-kun-lås",
      "executive.get_health_center: restricted på web_chat men IKKE låst i utvalget"
    ].sort());
    // et verktøy uten modellflate (kun eier-/system-vei) er ikke omfattet
    const noSurface: ToolManifest = new Map([...manifest, ["executive.get_health_center", fake("executive", "get_health_center", [])]]);
    expect(restrictedGaps(noSurface, EXECUTION_GUARDED_RESTRICTED_KEYS)).toEqual([]);
    // fjernes utførelses-vernet for Finans- og Verdi-senteret, feiler invarianten (de er ikke et finance_*-namespace)
    expect(restrictedGaps(manifest, new Set())).toEqual([
      // WP-B3 (D-475): Evolusjon-senteret (kostmodellen) er det tredje restricted senteret
      "executive.get_evolution_center: restricted på web_chat - hverken håndhevet ved utførelse eller eksplisitt akseptert valg-kun-lås",
      "executive.get_finance_center: restricted på web_chat - hverken håndhevet ved utførelse eller eksplisitt akseptert valg-kun-lås",
      "executive.get_value_center: restricted på web_chat - hverken håndhevet ved utførelse eller eksplisitt akseptert valg-kun-lås"
    ]);
  });
});

describe("utførelses-vernet virker på selve verktøyene i den håndhevede mengden", () => {
  const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
  const probeFor = (id: ControlCenterId): ControlCenterDefinition => ({
    id, title_no: id, description_no: "test",
    build: async () => ({ sections: [controlSection({ id: "s1", title_no: "S", source: "test", summary_no: "x", items: [controlItem({ id: "i1", label: "Rad", status: "OK", detail_no: "d", facts: { amount_ore: 99_000 } })] })], actions: [] })
  });

  it("for hvert guardet verktøy: en skymodell får «holdt tilbake», en lokal modell og siden får rapporten - uten at noe utvalg er involvert", async () => {
    const registry = createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] } });
    for (const center of CLOUD_WITHHELD_CENTERS) registry.register(probeFor(center));
    const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
    const transport = new ExecutiveTransport(new ExecutiveService(fakeGw, { controlCenters: registry, servedLocally: (m) => m.provider === "gemma_local" }));
    for (const key of EXECUTION_GUARDED_RESTRICTED_KEYS) {
      const action = key.split(".")[1] as string;
      const run = async (servingModel?: { provider: string; model: string }) =>
        (await transport.invoke(action, {}, "cred", { identity: owner, ...(servingModel ? { servingModel } : {}) } as never)).data as unknown as { withheld?: boolean; report?: unknown };
      expect((await run({ provider: "anthropic", model: "m" })).withheld, `${key} sky`).toBe(true);
      expect(JSON.stringify(await run({ provider: "anthropic", model: "m" }))).not.toContain("99000");
      expect((await run({ provider: "gemma_local", model: "m" })).report, `${key} lokal`).toBeDefined();
      expect((await run()).report, `${key} siden`).toBeDefined();
    }
  });
});
