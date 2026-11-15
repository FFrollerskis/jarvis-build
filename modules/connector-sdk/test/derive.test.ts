import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CONNECTOR_REGISTRY, MIN_RISK_BY_EFFECT, buildToolManifest, inferEffect, type ConnectorDefinition, type ToolDefinition
} from "@jarvis/tool-gateway";
import {
  ACTION_EFFECTS, MIN_RISK_FOR_EFFECT, claimedDefinitions, deriveSkeletonManifests, isUnknown, productionConnectorDefinitions, requiredInputOf, validateConnectorManifest,
  DEFAULT_INTERNAL_CREDENTIAL_REFS, DERIVED_MANIFEST_VERSION, type ConnectorManifest
} from "../src/index.ts";

const definitions = productionConnectorDefinitions();
const skeletons = deriveSkeletonManifests({ definitions });
const byId = new Map(skeletons.map((m) => [m.identity.id, m]));

describe("avledning: ett skeleton per connector i registeret (registeret forblir sannheten)", () => {
  it("nøyaktig én gyldig skeleton per registeroppføring, i registerets rekkefølge", () => {
    expect(skeletons.map((m) => m.identity.id)).toEqual(CONNECTOR_REGISTRY.map((c) => c.id));
    expect(skeletons.length).toBeGreaterThanOrEqual(58);
    for (const m of skeletons) {
      const r = validateConnectorManifest(m);
      expect(r.issues, m.identity.id).toEqual([]);
      expect(m.completeness).toBe("skeleton");
      expect(m.source).toBe("derived_from_registry");
    }
  });

  it("avledningen er ren: samme inndata gir identisk utdata, og inndata muteres ikke", () => {
    const again = deriveSkeletonManifests({ definitions });
    expect(JSON.stringify(again)).toBe(JSON.stringify(skeletons));
  });

  it("en ny/endret registeroppføring gir et nytt/endret skeleton uten kodeendring (registeret er kilden)", () => {
    const extra: ConnectorDefinition = { id: "acme_probe", display_name: "Acme Probe", category: "tool_gateway", credential_refs: ["ACME_PROBE_TOKEN"] };
    const out = deriveSkeletonManifests({ registry: [...CONNECTOR_REGISTRY, extra], definitions });
    expect(out.length).toBe(CONNECTOR_REGISTRY.length + 1);
    const m = out.find((x) => x.identity.id === "acme_probe")!;
    expect(m.actions).toEqual([]);
    expect(m.secrets.refs.map((r) => r.ref)).toEqual(["ACME_PROBE_TOKEN"]);
    expect(validateConnectorManifest(m).issues).toEqual([]);
    expect(deriveSkeletonManifests({ registry: CONNECTOR_REGISTRY.filter((c) => c.id !== "github"), definitions }).some((x) => x.identity.id === "github")).toBe(false);
  });
});

describe("avledning: handling -> connector speiler Integrasjonssenteret", () => {
  const claimed = claimedDefinitions(CONNECTOR_REGISTRY, definitions);

  it("ingen handling tilhører to connectorer, og hver live-test-handling er blant connectorens egne handlinger", () => {
    const seen = new Map<string, string>();
    for (const [id, defs] of claimed) {
      for (const d of defs) {
        const key = `${d.tool_id}.${d.action}`;
        expect(seen.get(key), `${key} er knyttet til både ${seen.get(key)} og ${id}`).toBeUndefined();
        seen.set(key, id);
      }
    }
    for (const c of CONNECTOR_REGISTRY) {
      if (!c.live_test) continue;
      const keys = (claimed.get(c.id) ?? []).map((d) => `${d.tool_id}.${d.action}`);
      expect(keys, `${c.id}: live-testen ${c.live_test.tool_id}.${c.live_test.action} er ikke registrert`).toContain(`${c.live_test.tool_id}.${c.live_test.action}`);
    }
  });

  it("bygde connectorer har handlinger (unntatt modellleverandørene, som går via ModelGateway), backlog har ingen", () => {
    for (const c of CONNECTOR_REGISTRY) {
      const n = (claimed.get(c.id) ?? []).length;
      if (c.category === "backlog" || c.category === "backlog_d64_gate" || c.category === "model_provider") expect(n, c.id).toBe(0);
      else expect(n, c.id).toBeGreaterThan(0);
    }
  });

  it("de tre standardeksemplene: Google Calendar og Drive deler token men har hver sine handlinger", () => {
    const keys = (id: string) => (claimed.get(id) ?? []).map((d) => d.tool_id);
    expect(new Set(keys("google_calendar"))).toEqual(new Set(["calendar"]));
    expect(new Set(keys("google_drive"))).toEqual(new Set(["drive"]));
    expect((claimed.get("home_assistant") ?? []).length).toBeGreaterThanOrEqual(6);
  });
});

describe("avledning: fakta er identiske med verktøymanifestet og definisjonene (aldri oppfunnet)", () => {
  const toolManifest = buildToolManifest(definitions);

  it("effekt-, risiko- og bøtteregelen er låst mot verktøymanifestet (drift-vakt)", () => {
    expect([...ACTION_EFFECTS].sort()).toEqual(Object.keys(MIN_RISK_BY_EFFECT).sort());
    expect(MIN_RISK_FOR_EFFECT).toEqual(MIN_RISK_BY_EFFECT);
  });

  it("hver avledet handling stemmer med definisjonen og verktøymanifestet (risiko, effekt, idempotens, tillit, grenser, tidsavbrudd, step-up)", () => {
    let n = 0;
    for (const m of skeletons) {
      for (const a of m.actions) {
        n += 1;
        const [toolId, action] = a.key.split(".") as [string, string];
        const def = definitions.find((d) => d.tool_id === toolId && d.action === action)!;
        const entry = toolManifest.get(a.key)!;
        expect(a.effect, a.key).toBe(inferEffect(toolId, action));
        expect(a.authority.risk_class, a.key).toBe(def.capability_class);
        expect(a.authority.step_up_required, a.key).toBe(def.step_up_required === true);
        expect(a.authority.owner_only, a.key).toBe(def.owner_only === true);
        expect(a.idempotency.requirement, a.key).toBe(entry.idempotency);
        expect(a.idempotency.provider_idempotent, a.key).toBe(def.idempotent_external);
        expect(a.trust.output, a.key).toBe(def.output_trust);
        expect(a.limits.rate_limit_per_minute, a.key).toBe(def.rate_limit_per_minute);
        expect(a.operations.timeout_ms, a.key).toBe(def.timeout_ms);
        expect(a.reversibility.reversible, a.key).toBe(def.reversible);
        expect(a.reversibility.evidence.before_state, a.key).toBe(def.preflight_action !== undefined);
        expect(a.data.identity_fields, a.key).toEqual(entry.scope_fields);
        expect(a.reversibility.rollback_procedure.endsWith("…"), `${a.key}: rollback-teksten er avkortet - hev grensen i skjemaet`).toBe(false);
      }
    }
    expect(n).toBeGreaterThan(200);
  });

  it("klasse D-kjeden er hentet fra den eksisterende statiske vurderingen: nøyaktig de to kjente DEFERRED-handlingene er ufullstendige", () => {
    const deferred: string[] = [];
    for (const m of skeletons) {
      for (const a of m.actions) {
        const chain = a.reversibility.class_d_chain;
        if (a.authority.risk_class === "D") {
          expect(chain, a.key).toBeDefined();
          if (chain?.status === "deferred") { deferred.push(a.key); expect(chain.missing.length, a.key).toBeGreaterThan(0); }
        } else expect(chain, a.key).toBeUndefined();
      }
    }
    // Speiler EXPECTED_DEFERRED i modules/tool-gateway/test/part3-class-d-pipeline.test.ts (en ny D-handling uten kjede gjør denne testen rød - ingen stille utelatelse).
    expect(deferred.sort()).toEqual(["mcp_zapier.call_tool", "microsoft_outlook.send_mail"]);
  });

  it("risiko under minimum for effekten forekommer bare med den begrunnelsen verktøymanifestet selv har (MIN_RISK_EXCEPTIONS)", () => {
    for (const m of skeletons) for (const a of m.actions) {
      const below = ["A", "B", "C", "D"].indexOf(a.authority.risk_class) < ["A", "B", "C", "D"].indexOf(MIN_RISK_BY_EFFECT[a.effect]);
      expect(below, `${a.key}: ${a.authority.risk_class} < ${MIN_RISK_BY_EFFECT[a.effect]}`).toBe(a.authority.risk_exception !== undefined);
    }
  });

  it("påkrevde parametre leses fra zod-skjemaet; ikke-objektskjema gir ukjent (aldri en gjetning)", () => {
    const def = definitions.find((d) => d.tool_id === "github" && d.action === "create_issue")!;
    expect(requiredInputOf(def)).toEqual(["repo", "title"]);
    const loose = { ...def, input_schema: z.record(z.string()) as unknown as ToolDefinition["input_schema"] };
    expect(requiredInputOf(loose)).toBeNull();
  });

  it("de interne credential-referansene speiler det verktøydefinisjonene bruker for Jarvis-kjernen", () => {
    expect([...DEFAULT_INTERNAL_CREDENTIAL_REFS]).toEqual(["JARVIS_BUSINESS_INTERNAL_TOKEN"]);
    const internal = definitions.filter((d) => d.credential_ref === "JARVIS_BUSINESS_INTERNAL_TOKEN");
    expect(internal.length).toBeGreaterThan(50);
    for (const d of internal) for (const c of CONNECTOR_REGISTRY) expect(c.credential_refs).not.toContain(d.credential_ref);
  });
});

describe("avledning: ærlighet - alt som ikke kan avledes er en Unknown-markør", () => {
  it("leverandør, auth-type, leverandør-scopes, rotasjon, D-41-revisjon og tester er aldri oppfunnet i et skeleton", () => {
    for (const m of skeletons) {
      expect(isUnknown(m.identity.vendor), m.identity.id).toBe(true);
      expect(isUnknown(m.auth.type), m.identity.id).toBe(true);
      expect(isUnknown(m.auth.scopes.provider), m.identity.id).toBe(true);
      expect(isUnknown(m.auth.rotation), m.identity.id).toBe(true);
      expect(isUnknown(m.d41_audit), m.identity.id).toBe(true);
      expect(isUnknown(m.operations.runbook), m.identity.id).toBe(true);
      expect(isUnknown(m.operations.maintenance_owner), m.identity.id).toBe(true);
      for (const t of Object.values(m.tests)) expect(isUnknown(t), m.identity.id).toBe(true);
      expect(m.identity.version.manifest).toBe(DERIVED_MANIFEST_VERSION);
      expect(m.core_boundary.basis).toBe("derived_default");
    }
  });

  it("API-versjon og synk-jobber avledes KUN når kalleren oppgir dem; ellers ukjent (aldri «ingen»)", () => {
    const github = byId.get("github")!;
    expect(isUnknown(github.identity.version.provider_api)).toBe(true);
    expect(isUnknown(github.capabilities.sync)).toBe(true);
    const withFacts = deriveSkeletonManifests({
      definitions, apiFacts: { github: { api_version: "X-GitHub-Api-Version 2022-11-28" } }, syncJobs: { gmail: ["business-events-sync"] }
    });
    const g = withFacts.find((m) => m.identity.id === "github")!;
    expect(g.identity.version.provider_api).toBe("X-GitHub-Api-Version 2022-11-28");
    expect(isUnknown(g.capabilities.sync) ? "unknown" : g.capabilities.sync.status).toBe("not_implemented");
    const gm = withFacts.find((m) => m.identity.id === "gmail")!;
    expect(isUnknown(gm.capabilities.sync) ? [] : gm.capabilities.sync.items).toEqual(["business-events-sync"]);
    expect(isUnknown(withFacts.find((m) => m.identity.id === "slack")!.identity.version.provider_api)).toBe(true);
  });

  it("backlog og modellleverandører: ingen handlinger, ingen oppfunnet helsesjekk, fail-closed tillit", () => {
    for (const id of ["apple_music", "homekit", "apns"]) {
      const m = byId.get(id)!;
      expect(m.actions).toEqual([]);
      expect(isUnknown(m.operations.health_check)).toBe(true);
      expect(m.trust.output.class).toBe("untrusted");
      expect(m.capabilities.read.status).toBe("not_implemented");
      expect(isUnknown(m.operations.timeout)).toBe(true);
    }
    const anthropic = byId.get("anthropic")!;
    expect(anthropic.actions).toEqual([]);
    expect(isUnknown(anthropic.operations.health_check) ? null : anthropic.operations.health_check.method).toBe("presence_only");
  });

  it("hvelvreferansene er nøyaktig registerets (påkrevde og valgfrie) og alle har gyldig referanseform", () => {
    for (const c of CONNECTOR_REGISTRY) {
      const m = byId.get(c.id)!;
      expect(m.secrets.refs.filter((r) => r.required).map((r) => r.ref)).toEqual(c.credential_refs);
      expect(m.secrets.refs.filter((r) => !r.required).map((r) => r.ref)).toEqual(c.optional_credential_refs ?? []);
      expect(m.secrets.model_visibility).toBe("never");
    }
  });

  it("skrivekapabel connector har dedupe-nøkkel i skeletonet; ren lese-connector har ingen (ingenting å dedupe)", () => {
    const stripe = byId.get("stripe") as ConnectorManifest;
    expect(stripe.idempotency.dedupe_key).toBe("jarvis_idempotency_key");
    const brave = byId.get("brave_search") as ConnectorManifest;
    expect(brave.idempotency.dedupe_key).toBe("none");
    expect(brave.actions.every((a) => a.effect === "read")).toBe(true);
  });
});
