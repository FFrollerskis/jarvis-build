import { describe, expect, it } from "vitest";
import { z } from "zod";
import type pg from "pg";
import { PolicyGateway, InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch } from "@jarvis/policy";
import { ToolGateway, allMeshTools, type SecretProvider, type ToolTransport } from "../src/index.ts";

/**
 * D-289 (Tobias direkte i chat: "vil ha alt at han har full kontroll" -
 * retningsvalg på D-288 sitt funn om at samtaleflaten strukturelt kun kunne
 * kalle 5 av ~28 registrerte tool_id-er): beviser at `allMeshTools()`
 * faktisk genererer én mesh-mapping PER REGISTRERT `tool_id:action`-par,
 * med et gyldig, konvertert JSON-schema og bevart `capability_class`-info i
 * beskrivelsen - RENT strukturell/generator-test, ingen DB/policy-utførelse
 * nødvendig (selve autorisasjonssemantikken - klasse A-D, sovereign owner,
 * ingen ny godkjenningssperre - er allerede bevist av
 * `ua1-p1a-dclass-mesh.test.ts` mot ekte embedded Postgres og er UENDRET av
 * denne generatoren; `MeshToolExecutor` selv er heller ikke endret, kun
 * hvilken `MeshToolMapping[]`-liste som sendes inn).
 */

const noopSecrets: SecretProvider = { name: "noop", async get() { return null; } };
const noopTransport: ToolTransport = { async invoke() { return { data: null }; } };

function buildGateway(): ToolGateway {
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch()
  });
  // Konstruktøren rører aldri poolen synkront (kun lagret for senere execute()-
  // kall, se gateway.ts) - trygt å sende en fake her for en ren generator-test.
  return new ToolGateway({} as pg.Pool, policy, noopSecrets);
}

describe("D-289: allMeshTools() - full-kapabilitet mesh-generator", () => {
  it("genererer én mapping per registrert tool_id:action-par, ingen mer og ingen mindre", () => {
    const gateway = buildGateway();
    gateway.register({
      tool_id: "demo_a", action: "read_thing", description: "Les noe (klasse A)",
      input_schema: z.object({}).strict() as never, capability_class: "A", scopes: [], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true, timeout_ms: 5000,
      rate_limit_per_minute: 60, credential_ref: "DEMO_A_REF", output_trust: "internal", transport: noopTransport
    });
    gateway.register({
      tool_id: "demo_d", action: "critical_thing", description: "Kritisk handling (klasse D)",
      input_schema: z.object({ note: z.string() }).strict() as never, capability_class: "D", scopes: [], reversible: false,
      rollback_procedure: "ikke reverserbar", idempotent_external: false, timeout_ms: 5000,
      rate_limit_per_minute: 10, credential_ref: "DEMO_D_REF", output_trust: "internal", transport: noopTransport
    });
    const mappings = allMeshTools(gateway);
    expect(mappings).toHaveLength(2);
    const names = mappings.map((m) => m.def.name).sort();
    expect(names).toEqual(["demo_a__read_thing", "demo_d__critical_thing"]);
  });

  it("verktøynavn er unike per konstruksjon (${tool_id}__${action}) selv når tool_id selv inneholder understreking", () => {
    const gateway = buildGateway();
    gateway.register({
      tool_id: "finance_stripe", action: "read_balance", description: "Les saldo",
      input_schema: z.object({}).strict() as never, capability_class: "A", scopes: [], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true, timeout_ms: 5000,
      rate_limit_per_minute: 60, credential_ref: "STRIPE_REF", output_trust: "internal", transport: noopTransport
    });
    gateway.register({
      tool_id: "finance", action: "stripe_read_balance", description: "En annen, urelatert handling",
      input_schema: z.object({}).strict() as never, capability_class: "A", scopes: [], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true, timeout_ms: 5000,
      rate_limit_per_minute: 60, credential_ref: "FINANCE_REF", output_trust: "internal", transport: noopTransport
    });
    const names = allMeshTools(gateway).map((m) => m.def.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("konverterer Zod-skjemaet til et gyldig JSON-schema modellen kan lese (object/properties/required/additionalProperties)", () => {
    const gateway = buildGateway();
    gateway.register({
      tool_id: "demo", action: "act", description: "En handling med felter",
      input_schema: z.object({ note: z.string(), max: z.number().optional(), kind: z.enum(["a", "b"]) }).strict() as never,
      capability_class: "B", scopes: [], reversible: true, rollback_procedure: "manuell",
      idempotent_external: true, timeout_ms: 5000, rate_limit_per_minute: 60,
      credential_ref: "DEMO_REF", output_trust: "internal", transport: noopTransport
    });
    const mapping = allMeshTools(gateway)[0];
    expect(mapping?.def.input_schema).toMatchObject({
      type: "object",
      properties: {
        note: { type: "string" },
        max: { type: "number" },
        kind: { type: "string", enum: ["a", "b"] }
      },
      required: ["note", "kind"],
      additionalProperties: false
    });
  });

  it("bevarer risikoklassen synlig i beskrivelsen (chat-modellen ser ALDRI en klasse D-handling som om den var klasse A)", () => {
    const gateway = buildGateway();
    gateway.register({
      tool_id: "demo_d", action: "critical_thing", description: "Kritisk handling",
      input_schema: z.object({}).strict() as never, capability_class: "D", scopes: [], reversible: false,
      rollback_procedure: "ikke reverserbar", idempotent_external: false, timeout_ms: 5000,
      rate_limit_per_minute: 10, credential_ref: "DEMO_D_REF", output_trust: "internal", transport: noopTransport
    });
    const mapping = allMeshTools(gateway)[0];
    expect(mapping?.def.description).toContain("klasse D");
  });

  it("ingen parameters-bygger-closure - rå modell-argumenter skal gå direkte til gateway.execute() (validert deterministisk der)", () => {
    const gateway = buildGateway();
    gateway.register({
      tool_id: "demo", action: "act", description: "En handling",
      input_schema: z.object({ note: z.string() }).strict() as never, capability_class: "A", scopes: [], reversible: true,
      rollback_procedure: "ingen", idempotent_external: true, timeout_ms: 5000, rate_limit_per_minute: 60,
      credential_ref: "DEMO_REF", output_trust: "internal", transport: noopTransport
    });
    const mapping = allMeshTools(gateway)[0];
    expect(mapping?.parameters).toBeUndefined();
  });

  it("et tomt register gir en tom, ikke en kastet, liste", () => {
    expect(allMeshTools(buildGateway())).toEqual([]);
  });

  it("D-344: konverterer OpenAPI-3.0-boolske exclusiveMinimum/exclusiveMaximum (fra Zod sin .positive()/.negative()/.gt()/.lt()) til standard JSON-Schema-draft-07-TALL, IKKE en strip - Anthropic (og andre standard-JSON-Schema-providere) forventer exclusiveMinimum som et tall, ikke et boolsk flagg + separat minimum", () => {
    const gateway = buildGateway();
    gateway.register({
      tool_id: "demo_finance", action: "create_payment_intent", description: "Opprett betaling",
      input_schema: z.object({ amount_ore: z.number().int().positive(), discount_ore: z.number().negative().optional() }).strict() as never,
      capability_class: "B", scopes: [], reversible: false, rollback_procedure: "manuell refusjon",
      idempotent_external: true, timeout_ms: 5000, rate_limit_per_minute: 60,
      credential_ref: "DEMO_FINANCE_REF", output_trust: "internal", transport: noopTransport
    });
    const mapping = allMeshTools(gateway)[0];
    const properties = (mapping?.def.input_schema as { properties: Record<string, unknown> }).properties;
    // amount_ore: .positive() -> {exclusiveMinimum: true, minimum: 0} -> {exclusiveMinimum: 0}
    expect(properties["amount_ore"]).toEqual({ type: "integer", exclusiveMinimum: 0 });
    // discount_ore: .negative() -> {exclusiveMaximum: true, maximum: 0} -> {exclusiveMaximum: 0}
    expect(JSON.stringify(properties["discount_ore"])).not.toContain('"exclusiveMaximum":true');
    expect(properties["discount_ore"]).toMatchObject({ exclusiveMaximum: 0 });
  });

  it("D-344: inklusive grenser (.min()/.max(), INGEN boolsk flagg fra zod-to-json-schema) forblir UENDRET", () => {
    const gateway = buildGateway();
    gateway.register({
      tool_id: "demo_range", action: "act", description: "Handling med inklusiv grense",
      input_schema: z.object({ count: z.number().min(1).max(10) }).strict() as never,
      capability_class: "A", scopes: [], reversible: true, rollback_procedure: "ingen",
      idempotent_external: true, timeout_ms: 5000, rate_limit_per_minute: 60,
      credential_ref: "DEMO_RANGE_REF", output_trust: "internal", transport: noopTransport
    });
    const mapping = allMeshTools(gateway)[0];
    const properties = (mapping?.def.input_schema as { properties: Record<string, unknown> }).properties;
    expect(properties["count"]).toEqual({ type: "number", minimum: 1, maximum: 10 });
  });
});
