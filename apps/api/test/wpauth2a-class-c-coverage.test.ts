import { describe, expect, it } from "vitest";
import { businessClassCAdapters } from "@jarvis/business";
import { growthClassCAdapters } from "@jarvis/growth";
import {
  CLASS_C_COVERAGE,
  CLASS_C_OWNER_OVERRIDE_ACTIONS,
  assessClassCCoverage,
  defaultClassCAdapters,
  hasOwnFullChain,
  isClassCOwnerOverride,
  type ClassCCoverageEntry,
  type ToolDefinition
} from "@jarvis/tool-gateway";
import { createClassCWiring } from "../src/class-c-wiring.ts";
import { productionClassCUniverse } from "./support/class-c-universe.ts";

/**
 * WP-AUTH2a (K5/K6): VAKT som tvinger hver klasse C-handling til å ta stilling til dekning (mønster: `part3-tool-manifest.test.ts`). Universet er HELE produksjonsregisteret med alle flaggstyrte sett PÅ
 * (`support/class-c-universe.ts`). En ny klasse C-handling uten oppføring i `CLASS_C_COVERAGE` feller denne testen; det samme gjør en adapter uten stilling, en foreldet oppføring og en utsatt handling uten begrunnelse.
 * AUTH2a-taket er ÅTTE dekkede handlinger (WP-AUTH2b hever det bevisst ved å endre `AUTH2A_COVERED_CAP` med en beslutning).
 */
const AUTH2A_COVERED_CAP = 8;

const defs = productionClassCUniverse();
const classC = defs.filter((d) => d.capability_class === "C");
const key = (d: Pick<ToolDefinition, "tool_id" | "action">): string => `${d.tool_id}.${d.action}`;
const allAdapterKeys = [...defaultClassCAdapters(), ...growthClassCAdapters(), ...businessClassCAdapters()].map((a) => a.key);

describe("A: hver klasse C-handling i produksjonsregisteret har en stilling", () => {
  it("universet er stort nok til å være ekte (alle flaggstyrte sett er med), og klasse C-listen er den vakten ser", () => {
    expect(defs.length).toBeGreaterThan(650);
    expect(classC.length).toBeGreaterThan(100);
    // flaggstyrte sett som SKAL være med (ellers ville vakten vært blind for dem)
    for (const k of ["growth_googleads.pause_campaign", "comms.edit_message", "situations.subscribe", "cloudflare.purge_cache", "executive.record_evolution_decision", "executive.revoke_autonomy_binding", "growth.conclude_experiment"]) {
      expect(classC.map(key), k).toContain(k);
    }
  });

  it("dekningstabellen er konsistent med definisjonene og adapterne (ingen mangler, ingen foreldede, ingen adapter uten stilling)", () => {
    expect(assessClassCCoverage(defs, allAdapterKeys)).toEqual([]);
  });

  it("nøklene i tabellen er NØYAKTIG klasse C-nøklene (begge veier)", () => {
    expect(Object.keys(CLASS_C_COVERAGE).sort()).toEqual(classC.map(key).sort());
  });

  it("fordelingen er pinnet (en endring er en bevisst beslutning): 8 dekket, 16 egen kjede, 19 eierens kontrollhandlinger, resten utsatt", () => {
    const by = (status: string) => Object.values(CLASS_C_COVERAGE).filter((e) => e.status === status).length;
    expect({ covered: by("covered"), existing_chain: by("existing_chain"), owner_override: by("owner_override"), deferred: by("deferred") }).toEqual({ covered: 8, existing_chain: 16, owner_override: 19, deferred: 66 });
    expect(by("covered")).toBeLessThanOrEqual(AUTH2A_COVERED_CAP);
  });
});

describe("B: de åtte dekkede handlingene er nøyaktig adapterne som kobles inn", () => {
  const covered = Object.entries(CLASS_C_COVERAGE).filter(([, e]) => e.status === "covered").map(([k]) => k).sort();
  it("tabellen og adapterne er samme sett, og produksjonskoblingen (api/worker) registrerer dem alle", () => {
    expect(covered).toEqual([...allAdapterKeys].sort());
    expect(createClassCWiring({ JARVIS_CLASS_C_PIPELINE: "enforce" }).options.classCPipeline?.adapterKeys()).toEqual(covered);
    expect(covered).toEqual([
      "business.update_lead_status", "drive.create_file", "drive.move", "drive.rename", "drive.trash", "drive.update_content", "github.create_pr", "growth.set_campaign_status"
    ]);
  });
  it("hver dekket handling er klasse C i registeret", () => {
    for (const k of covered) expect(classC.map(key), k).toContain(k);
  });
});

describe("C: eierens kontrollhandlinger er aldri blokkerbare", () => {
  const overrides = Object.entries(CLASS_C_COVERAGE).filter(([, e]) => e.status === "owner_override").map(([k]) => k).sort();
  it("tabellen og koden er enige om hvilke de er, og listen er pinnet", () => {
    expect(classC.filter(isClassCOwnerOverride).map(key).sort()).toEqual(overrides);
    expect(overrides).toEqual([
      "comms.revoke_account",
      "executive.freeze_connector", "executive.pause_domain", "executive.restore_credential", "executive.resume_domain", "executive.revoke_autonomy_binding", "executive.revoke_credential", "executive.revoke_device", "executive.unfreeze_connector",
      "owner_controls.freeze_connector", "owner_controls.restore_credential", "owner_controls.revoke_credential", "owner_controls.revoke_device", "owner_controls.set_connector_credential", "owner_controls.unfreeze_connector",
      "situations.pause_all", "situations.pause_domain", "situations.unpause_all", "situations.unpause_domain"
    ]);
    for (const k of CLASS_C_OWNER_OVERRIDE_ACTIONS) expect(classC.map(key), `${k} finnes som klasse C`).toContain(k);
  });
  it("ingen eierens kontrollhandling har en adapter", () => {
    for (const k of overrides) expect(allAdapterKeys, k).not.toContain(k);
  });
});

describe("D: handlinger med egen kjede har den fortsatt (ingen stille forvitring)", () => {
  it("alle 16 growth_*-skrivehandlinger har hele WP-D3-kjeden", () => {
    const own = Object.entries(CLASS_C_COVERAGE).filter(([, e]) => e.status === "existing_chain").map(([k]) => k);
    expect(own).toHaveLength(16);
    for (const k of own) {
      const def = classC.find((d) => key(d) === k)!;
      expect(hasOwnFullChain(def), k).toBe(true);
    }
  });
  it("ingen annen klasse C-handling har hele kjeden uten å stå som existing_chain (så en ny handling med kjede ikke står som utsatt)", () => {
    for (const d of classC) {
      if (CLASS_C_COVERAGE[key(d)]?.status === "existing_chain") continue;
      expect(hasOwnFullChain(d), key(d)).toBe(false);
    }
  });
});

describe("E: utsatte handlinger er begrunnet (kategori + konkret tekst), aldri tomme", () => {
  const deferred = Object.entries(CLASS_C_COVERAGE).filter(([, e]) => e.status === "deferred");
  it("hver har en kjent kategori og en begrunnelse på minst 40 tegn", () => {
    expect(deferred.length).toBe(66);
    const categories = new Set(deferred.map(([, e]) => e.category));
    expect([...categories].sort()).toEqual(["async_effect", "effect_not_observable", "finance_owner_gated", "internal_registration", "no_live_write_transport", "no_readback_action", "sibling_of_covered"]);
    for (const [k, e] of deferred) expect(e.reason.trim().length, k).toBeGreaterThanOrEqual(40);
  });
  it("de tre handlingene eieren pekte på er utsatt av DOKUMENTERTE grunner: kalender (ingen live skriving), produksjonsdeploy (uobserverbar pekeren) og cache-purge (ingen lesing av cache)", () => {
    expect(CLASS_C_COVERAGE["calendar.create_event"]).toMatchObject({ status: "deferred", category: "no_live_write_transport" });
    expect(CLASS_C_COVERAGE["vercel.rollback_deployment"]).toMatchObject({ status: "deferred", category: "effect_not_observable" });
    expect(CLASS_C_COVERAGE["vercel.promote_deployment"]).toMatchObject({ status: "deferred", category: "effect_not_observable" });
    expect(CLASS_C_COVERAGE["cloudflare.purge_cache"]).toMatchObject({ status: "deferred", category: "no_readback_action" });
  });
});

describe("F: vakten er selv mutasjonstestet (den feller det den skal felle)", () => {
  const base = (): Record<string, ClassCCoverageEntry> => ({ ...CLASS_C_COVERAGE });
  const synthetic = (over: Partial<ToolDefinition> = {}): ToolDefinition => ({ ...classC[0]!, tool_id: "ny_tjeneste", action: "gjor_noe", ...over });

  it("en NY klasse C-handling uten stilling feller vakten, og meldingen sier hva som må gjøres", () => {
    const violations = assessClassCCoverage([...defs, synthetic()], allAdapterKeys);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("ny_tjeneste.gjor_noe: ny klasse C-handling uten dekningsstilling");
  });
  it("en ny handling i klasse B/A/D krever ingen stilling", () => {
    for (const capability_class of ["A", "B", "D"] as const) expect(assessClassCCoverage([...defs, synthetic({ capability_class })], allAdapterKeys), capability_class).toEqual([]);
  });
  it("en foreldet oppføring (handlingen finnes ikke lenger) feller vakten", () => {
    const stale = { ...base(), "borte.handling": { status: "deferred", category: "no_readback_action", reason: "Finnes ikke lenger i registeret (foreldet oppføring i testen)." } as ClassCCoverageEntry };
    expect(assessClassCCoverage(defs, allAdapterKeys, stale).some((v) => v.startsWith("borte.handling: står i CLASS_C_COVERAGE"))).toBe(true);
  });
  it("covered uten adapter, adapter uten covered, og adapter for en handling som ikke er klasse C feller vakten", () => {
    expect(assessClassCCoverage(defs, allAdapterKeys.filter((k) => k !== "drive.rename"))).toContain("drive.rename: erklært covered uten registrert adapter");
    expect(assessClassCCoverage(defs, [...allAdapterKeys, "calendar.create_event"])).toContain("calendar.create_event: har en registrert adapter men står som deferred");
    expect(assessClassCCoverage(defs, [...allAdapterKeys, "memory.search"])).toContain("memory.search: adapter for en handling som ikke er klasse C i produksjonsregisteret");
  });
  it("owner_override-uenighet (begge retninger) feller vakten", () => {
    const wrong = { ...base(), "drive.trash": { status: "owner_override", reason: "x".repeat(50) } as ClassCCoverageEntry };
    expect(assessClassCCoverage(defs, allAdapterKeys.filter((k) => k !== "drive.trash"), wrong).some((v) => v.startsWith("drive.trash: erklært owner_override"))).toBe(true);
    const missing = { ...base(), "owner_controls.revoke_device": { status: "deferred", category: "no_readback_action", reason: "x".repeat(50) } as ClassCCoverageEntry };
    expect(assessClassCCoverage(defs, allAdapterKeys, missing).some((v) => v.startsWith("owner_controls.revoke_device: er eierens kontrollhandling"))).toBe(true);
  });
  it("existing_chain uten hele kjeden (validator eller etterbetingelse fjernet) feller vakten", () => {
    const eroded = defs.map((d) => (key(d) === "growth_googleads.pause_campaign" ? ({ ...d, preflight_validator: undefined } as unknown as ToolDefinition) : d));
    expect(assessClassCCoverage(eroded, allAdapterKeys).some((v) => v.startsWith("growth_googleads.pause_campaign: erklært existing_chain"))).toBe(true);
    const noPost = defs.map((d) => (key(d) === "growth_metaads.pause_ad" ? ({ ...d, postcondition_predicate: undefined } as unknown as ToolDefinition) : d));
    expect(assessClassCCoverage(noPost, allAdapterKeys).some((v) => v.startsWith("growth_metaads.pause_ad: erklært existing_chain"))).toBe(true);
  });
  it("deferred uten kategori, kategori på noe annet enn deferred, og for kort begrunnelse feller vakten", () => {
    const noCategory = { ...base(), "slack.notify": { status: "deferred", reason: "x".repeat(60) } as ClassCCoverageEntry };
    expect(assessClassCCoverage(defs, allAdapterKeys, noCategory)).toContain("slack.notify: deferred uten kategori");
    const stray = { ...base(), "drive.rename": { status: "covered", category: "async_effect", reason: "x".repeat(60) } as ClassCCoverageEntry };
    expect(assessClassCCoverage(defs, allAdapterKeys, stray)).toContain("drive.rename: kategori er kun tillatt for deferred");
    const short = { ...base(), "slack.notify": { status: "deferred", category: "no_readback_action", reason: "for kort" } as ClassCCoverageEntry };
    expect(assessClassCCoverage(defs, allAdapterKeys, short).some((v) => v.startsWith("slack.notify: begrunnelsen er for kort"))).toBe(true);
  });
});

describe("G: hasOwnFullChain krever HVER egenskap i WP-D3-kjeden (ellers står en handling feilaktig som existing_chain)", () => {
  const full = {
    preflight_action: "get_state", preflight_requires_target: true, preflight_validator: () => true, postcondition_predicate: () => true, step_up_required: true, owner_only: true
  } as unknown as ToolDefinition;
  it("hele kjeden er sann; å fjerne eller slå av hver enkelt egenskap gjør den usann; postcondition_target_absent kan erstatte predikatet", () => {
    expect(hasOwnFullChain(full)).toBe(true);
    for (const drop of ["preflight_action", "preflight_requires_target", "preflight_validator", "postcondition_predicate", "step_up_required", "owner_only"]) {
      expect(hasOwnFullChain({ ...full, [drop]: undefined } as ToolDefinition), drop).toBe(false);
    }
    expect(hasOwnFullChain({ ...full, preflight_requires_target: false } as ToolDefinition)).toBe(false);
    expect(hasOwnFullChain({ ...full, step_up_required: false } as ToolDefinition)).toBe(false);
    expect(hasOwnFullChain({ ...full, owner_only: false } as ToolDefinition)).toBe(false);
    expect(hasOwnFullChain({ ...full, postcondition_predicate: undefined, postcondition_target_absent: true } as ToolDefinition)).toBe(true);
  });
});
