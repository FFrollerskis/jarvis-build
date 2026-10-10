import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  ControlCenterAccessError, ControlCenterRegistry, ExecutiveService, ExecutiveTransport, controlAction, controlItem, controlSection, executiveToolDefinitions, isEffectiveRedactor,
  type ControlCenterDefinition
} from "@jarvis/executive";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway, resolveAuthorityMode, type AuthorityConfig } from "@jarvis/policy";
import type { ToolDefinition, ToolGateway } from "@jarvis/tool-gateway";
import { createControlCenterRegistry, ownerPredicate } from "../src/control-center/register.ts";

/**
 * WP-H0, gjennomgang av PR #316 (M-2): EIER-PORTEN OG SISTE FORSVARSLINJE MOT HEMMELIGHETER ER LÅST AV TESTER.
 *
 * Funnet: `main.ts` satt sammen eier-predikatet (`resolveAuthorityMode(...) === "SOVEREIGN"`) og redigereren (`scanForSecrets`) inline, og ingen test berørte den koblingen. Mutant A
 * (`=== "SOVEREIGN"` → `!== "DENIED"`: `resolveAuthorityMode` returnerer aldri DENIED, så alle SCOPED-identiteter slipper inn) og mutant B (`redact: (t) => t`) ga begge grønne tester. Konsekvens hvis
 * koblingen glir: enhver innrullert person kan lese sentrene og kalle `executive.cancel_task` (klasse B, uten step-up).
 *
 * To låser:
 *  1. KILDEVAKT (leser `main.ts` som tekst, som `d442-sweep-failure-escalation`-mønsteret): `main.ts` lager registeret KUN via `createControlCenterRegistry({ authority: ownerAuthority })`, med DET SAMME
 *     `ownerAuthority`-objektet som `PolicyGateway` og `registerControlCenters` får; ingen egen `isOwner`/`redact`, ingen `new ControlCenterRegistry(`.
 *  2. KJØRETID: ikke-eier-identiteter (SCOPED, delegat, gjest, annen person, annen tenant) mot registeret bygd fra samme `AuthorityConfig` som en ekte `PolicyGateway` → nektet, på alle veier
 *     (rapport, oversikt, forklaring, begge verktøyportene), og `build` kjøres aldri for dem. Fabrikken redigerer hemmeligheter, og kan ikke gis en redigerer som ikke redigerer.
 */
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const MAIN = readFileSync(resolve(REPO_ROOT, "apps/api/src/main.ts"), "utf8");
/** `main.ts` uten kommentarer (linje- og blokkommentarer): de negative vaktene skal gjelde KODEN, ikke forklaringene. Kan kutte en linje etter «//» i en streng, men det gjør kun de negative vaktene mildere, aldri strengere. */
const MAIN_CODE = MAIN.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

/** Kroppen til første `{ ... }` som starter etter `marker` (balansert klammeparentes) - brukes til å isolere ett kall i `main.ts`. */
function blockAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`fant ikke «${marker}» i main.ts`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`ubalansert blokk etter «${marker}»`);
}

describe("kildevakt: main.ts kobler eier-porten og redigeringen via fabrikken, med det samme eier-objektet som Policy Gateway", () => {
  it("ÉN `ownerAuthority`-definisjon med eierens person og tenant - ingen annen inline eier-konfigurasjon for kontrollsentrene", () => {
    expect(MAIN.match(/const ownerAuthority\b/g)).toHaveLength(1);
    expect(MAIN).toMatch(/const ownerAuthority: AuthorityConfig = \{ owner_person_id: owner\.owner_person_id, owner_tenants: \[owner\.tenant_id\] \};/);
    // ingen inline `{ owner_person_id: ..., owner_tenants: [...] }`-literal igjen i kallene til PolicyGateway/kontrollsentrene
    expect(MAIN.match(/owner_tenants:\s*\[owner\.tenant_id\]/g)?.length).toBe(2); // definisjonen + ToolGateway sin credentialBinding (en annen type, uendret)
  });

  it("Policy Gateway, registeret og registerControlCenters får ALLE `ownerAuthority`", () => {
    expect(blockAfter(MAIN, "new PolicyGateway(")).toMatch(/authority:\s*ownerAuthority\b/);
    expect(MAIN).toMatch(/createControlCenterRegistry\(\{ authority: ownerAuthority \}\)/);
    expect(blockAfter(MAIN, "registerControlCenters(controlCenters,")).toMatch(/authority:\s*ownerAuthority\b/);
  });

  it("registeret lages ÉN gang og KUN via fabrikken; main.ts har ingen egen isOwner, redact, eier-sammenligning eller `new ControlCenterRegistry(`", () => {
    expect(MAIN_CODE.match(/createControlCenterRegistry\(/g)).toHaveLength(1);
    expect(MAIN_CODE).not.toMatch(/new ControlCenterRegistry\s*\(/);
    expect(MAIN_CODE).not.toMatch(/\bisOwner\b/);
    expect(MAIN_CODE).not.toMatch(/\bredact\s*[:(]/);
    expect(MAIN_CODE).not.toMatch(/resolveAuthorityMode/);
    expect(MAIN_CODE).not.toMatch(/["']SOVEREIGN["']|["']DENIED["']/);
    // fabrikken tar ingen annen parameter enn eier-konfigurasjonen fra main.ts
    const call = /createControlCenterRegistry\(([^)]*)\)/.exec(MAIN_CODE)?.[1] ?? "";
    expect(call.replace(/\s+/g, " ").trim()).toBe("{ authority: ownerAuthority }");
  });

  it("det samme registeret går til ExecutiveService (porten for lesing og avbryt) og registerControlCenters (sentrene)", () => {
    expect(MAIN).toMatch(/registerControlCenters\(controlCenters,/);
    expect(MAIN).toMatch(/new ExecutiveService\(toolGateway,[\s\S]*?\bcontrolCenters,/);
    expect(MAIN.match(/\bcontrolCenters\b/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("fabrikkfilen finnes og bruker den samme `resolveAuthorityMode` som Policy Gateway og `scanForSecrets` (ingen egen kopi av reglene)", () => {
    const file = resolve(REPO_ROOT, "apps/api/src/control-center/register.ts");
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, "utf8");
    expect(src).toMatch(/resolveAuthorityMode\(authority, identity\) === "SOVEREIGN"/);
    expect(src).toMatch(/const redactSecrets = \(text: string\): string => scanForSecrets\(text\)\.text;/);
    expect(src).toMatch(/isOwner: ownerPredicate\(authority\),\s*redact: redactSecrets,/);
    // `ControlCenterRegistryWiring` har hverken `redact` eller `isOwner`: ingen kaller kan overstyre dem
    const wiring = blockAfter(src, "export interface ControlCenterRegistryWiring");
    expect(wiring).not.toMatch(/\bredact\b|\bisOwner\b/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Kjøretid
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const authority: AuthorityConfig = { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] };
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const NON_OWNERS: ReadonlyArray<readonly [string, IdentityContext]> = [
  ["annen innrullert person i eierens tenant (SCOPED)", { ...owner, person_id: "person-member" }],
  ["delegat: eierens person_id MED delegation_id", { ...owner, delegation_id: "deleg-1" }],
  ["gjest (gjesterommet, annen person)", { ...owner, person_id: "person-guest", memory_space_id: "guest" }],
  ["eierens person i en ANNEN tenant", { ...owner, tenant_id: "tenant-annen" }],
  ["annen person i annen tenant", { ...owner, person_id: "person-x", tenant_id: "tenant-y" }],
  ["passiv (talekanal) annen person", { ...owner, person_id: "person-voice", channel: "voice", auth_strength: "passive" }]
];

let builds = 0;
const spyCenter: ControlCenterDefinition = {
  id: "ai", title_no: "AI", description_no: "Leverandører",
  build: async () => {
    builds += 1;
    return {
      sections: [controlSection({ id: "providers", title_no: "Leverandører", source: "modellmeshen", summary_no: "1 leverandør", items: [controlItem({ id: "ollama", label: "Ollama", status: "OK" })] })],
      actions: [controlAction({
        id: "agent.cancel:t1", label: "Avbryt jobb", endpoint: "/executive/mutate", body: { action: "cancel_task", parameters: { task_id: "t1" } },
        risk_class: "B", requires_step_up: false, reversible: false, description_no: "Avbryter jobben"
      })]
    };
  }
};

function fixture(): { registry: ControlCenterRegistry } {
  const registry = createControlCenterRegistry({ authority, now: () => new Date("2026-10-09T10:00:00.000Z") });
  registry.register(spyCenter);
  return { registry };
}

describe("kjøretid: registeret bygd av samme AuthorityConfig som Policy Gateway slipper kun den suverene eieren inn", () => {
  it("referanse: den ekte PolicyGateway klassifiserer identitetene likt (SOVEREIGN kun for eieren) - registeret følger samme fasit", async () => {
    const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), authority });
    const { registry } = fixture();
    const classC = (identity: IdentityContext) => policy.authorize({ identity, toolCall: { tool_id: "executive", action: "freeze_connector", capability_class: "C", parameters: {} } });
    expect(await classC(owner)).toMatchObject({ decision: "ALLOW", reason: "class_c_sovereign_authority" });
    expect(registry.authorize(owner)).toEqual({ allowed: true, reason: "owner" });
    for (const [label, identity] of NON_OWNERS) {
      expect(resolveAuthorityMode(authority, identity), label).toBe("SCOPED");
      expect(await classC(identity), label).toMatchObject({ decision: "DENY", reason: "class_c_no_mandate" });
      expect(registry.authorize(identity), label).toEqual({ allowed: false, reason: "control_center_owner_only" });
    }
  });

  it("eieren får rapport, oversikt og forklaring; ikke-eier-identitetene får ControlCenterAccessError på ALLE veier og `build` kjøres aldri for dem", async () => {
    const { registry } = fixture();
    builds = 0;
    expect((await registry.report("ai", owner))?.center).toBe("ai");
    expect((await registry.overview(owner)).centers).toHaveLength(1);
    expect(await registry.explain("ai", owner)).toContain("AI");
    const ownerBuilds = builds;
    expect(ownerBuilds).toBeGreaterThanOrEqual(3);
    for (const [label, identity] of NON_OWNERS) {
      await expect(registry.report("ai", identity), `${label} report`).rejects.toBeInstanceOf(ControlCenterAccessError);
      await expect(registry.report("ukjent-senter", identity), `${label} ukjent senter`).rejects.toBeInstanceOf(ControlCenterAccessError);
      await expect(registry.overview(identity), `${label} overview`).rejects.toBeInstanceOf(ControlCenterAccessError);
      await expect(registry.explain("ai", identity), `${label} explain`).rejects.toBeInstanceOf(ControlCenterAccessError);
    }
    expect(builds).toBe(ownerBuilds); // ingenting ble bygd for noen ikke-eier
  });

  it("verktøyportene: `executive.get_control_center` og `executive.cancel_task` nekter alle ikke-eiere og slipper eieren", () => {
    const { registry } = fixture();
    const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
    const defs = executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, { controlCenters: registry })));
    const read = defs.find((d) => d.action === "get_control_center") as ToolDefinition;
    const cancel = defs.find((d) => d.action === "cancel_task") as ToolDefinition;
    for (const d of [read, cancel]) {
      expect(d.parameterAuthorizer?.({}, owner), d.action).toEqual({ allowed: true, reason: "owner" });
      for (const [label, identity] of NON_OWNERS) {
        expect(d.parameterAuthorizer?.({}, identity), `${d.action}: ${label}`).toEqual({ allowed: false, reason: "control_center_owner_only" });
      }
    }
  });

  it("ownerPredicate selv: kun SOVEREIGN er eier; tom/ugyldig konfigurasjon gir ingen eier; predikatet kaster ikke på rare identiteter", () => {
    const isOwner = ownerPredicate(authority);
    expect(isOwner(owner)).toBe(true);
    for (const [label, identity] of NON_OWNERS) expect(isOwner(identity), label).toBe(false);
    expect(ownerPredicate({ owner_person_id: "person-owner", owner_tenants: [] })(owner)).toBe(false);
    expect(ownerPredicate({ owner_person_id: "andre", owner_tenants: ["tenant-owner"] })(owner)).toBe(false);
  });

  it("fabrikken avviser en eier-konfigurasjon uten eier-person eller uten eier-tenant (fail-closed ved oppstart)", () => {
    for (const bad of [
      { owner_person_id: "", owner_tenants: ["t"] }, { owner_person_id: "   ", owner_tenants: ["t"] }, { owner_person_id: "p", owner_tenants: [] }, { owner_person_id: "p", owner_tenants: [""] },
      { owner_person_id: undefined, owner_tenants: ["t"] }, { owner_person_id: "p", owner_tenants: undefined }
    ]) {
      expect(() => createControlCenterRegistry({ authority: bad as never }), JSON.stringify(bad)).toThrow(/control_center_authority_missing_owner/);
    }
    expect(() => createControlCenterRegistry({ authority: undefined as never })).toThrow(/control_center_authority_missing_owner/);
  });
});

describe("kjøretid: siste forsvarslinje mot hemmeligheter er på i registeret fabrikken lager (mutant B: `redact: (t) => t`)", () => {
  // Syntetiske, IKKE-ekte hemmeligheter bygd under kjøring (kildekoden inneholder ingenting som ligner en nøkkel).
  const anthropic = ["sk", "ant", "api03", "Z".repeat(32)].join("-");
  const github = `ghp_${"Q".repeat(36)}`;
  const named = `JARVIS_EXAMPLE_TOKEN=${"v".repeat(20)}`;
  const bearer = `Bearer ${"b".repeat(30)}`;
  const leaks = [anthropic, github, named.split("=")[1] as string, bearer.slice(7)];

  it("alle menneskelesbare felt redigeres (tittel, sammendrag, kilde, etikett, detalj, tekstfakta, handlingstekster), men id-er, endepunkt og kropper røres ikke", async () => {
    const { registry } = fixture();
    const leaky = `nøkkel ${anthropic} og ${github} og ${named} og ${bearer}`;
    registry.register({
      id: "integration", title_no: `T ${leaky}`, description_no: "Connectorer",
      build: async () => ({
        sections: [controlSection({
          id: "sec-1", title_no: `T ${leaky}`, source: `S ${leaky}`, summary_no: `Sum ${leaky}`,
          items: [controlItem({ id: "item-1", label: `L ${leaky}`, status: "OK", detail_no: `D ${leaky}`, facts: { tekst: `F ${leaky}`, tall: 7 } })]
        })],
        actions: [controlAction({
          id: "act-1", label: `A ${leaky}`, endpoint: "/executive/mutate", body: { action: "freeze_connector", parameters: { connector_id: "github", reason: "begrunnelse" } },
          risk_class: "C", requires_step_up: false, reversible: true, description_no: `B ${leaky}`, rollback_no: `R ${leaky}`
        })]
      })
    });
    const report = await registry.report("integration", owner);
    const human = JSON.stringify({
      t: report?.title_no, s: report?.summary_no, sec: report?.sections.map((s) => [s.title_no, s.source, s.summary_no, s.items.map((i) => [i.label, i.detail_no, i.facts])]),
      act: report?.actions.map((a) => [a.label, a.description_no, a.rollback_no])
    });
    for (const secret of leaks) expect(human).not.toContain(secret);
    expect(human).toContain("[REDACTED:");
    expect(report?.sections[0]?.id).toBe("sec-1");
    expect(report?.actions[0]?.endpoint).toBe("/executive/mutate");
    expect(report?.actions[0]?.body).toEqual({ action: "freeze_connector", parameters: { connector_id: "github", reason: "begrunnelse" } });
  });

  it("L-1: en URL med passord i en rapport redigeres av fabrikkens registry (kun passordet; skjema, bruker og vert beholdes)", async () => {
    const { registry } = fixture();
    const pw = ["hunt", "er2"].join(""); // satt sammen i testen (gitleaks)
    const urls = [`https://admin:${pw}@intern.example.org/panel`, `postgres://u:${pw}b@db:5432/jarvis`, `redis://:${pw}c@cache.example.org:6379`];
    registry.register({
      id: "integration", title_no: "Integrasjoner", description_no: "Connectorer",
      build: async () => ({
        sections: [controlSection({
          id: "sec-1", title_no: "T", source: "S", summary_no: `Sum ${urls[0]}`,
          items: [controlItem({ id: "item-1", label: "L", status: "OK", detail_no: `D ${urls[1]} og ${urls[2]}`, facts: { url: urls[0] as string } })]
        })],
        actions: []
      })
    });
    const report = await registry.report("integration", owner);
    const human = JSON.stringify(report?.sections);
    expect(human).not.toContain(pw);
    expect(human).toContain("https://admin:[REDACTED:url_credentials]@intern.example.org/panel");
    expect(human).toContain("redis://:[REDACTED:url_credentials]@cache.example.org:6379");
  });

  it("registeret avviser en redigerer som ikke redigerer (identitetsfunksjonen, store bokstaver, kast, ikke-streng) - allerede ved konstruksjon", () => {
    const bad: Array<[string, (t: string) => string]> = [
      ["identitet", (t) => t], ["store bokstaver", (t) => t.toUpperCase()], ["kaster", () => { throw new Error("x"); }], ["ikke-streng", (() => 42) as never], ["legger til mellomrom", (t) => ` ${t}`]
    ];
    for (const [label, redact] of bad) {
      expect(isEffectiveRedactor(redact), label).toBe(false);
      expect(() => new ControlCenterRegistry({ isOwner: () => true, redact }), label).toThrow("control_center_redact_not_effective");
    }
    const redacting = (t: string): string => t.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]");
    expect(isEffectiveRedactor(redacting)).toBe(true);
    expect(() => new ControlCenterRegistry({ isOwner: () => true, redact: redacting })).not.toThrow();
    expect(() => new ControlCenterRegistry({ isOwner: () => true })).not.toThrow(); // ingen redigerer oppgitt = som før (kun rene enhetstester av byggerne)
  });
});
