import { describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import {
  CLASS_C_AUDIT_MAX_CHARS,
  CLASS_C_OWNER_OVERRIDE_ACTIONS,
  ClassCPipeline,
  canonicalJson,
  createClassCPipeline,
  diffStates,
  evaluateExpectation,
  isClassCOwnerOverride,
  parseClassCMode,
  requestDigestOf,
  sanitizeEvidence,
  type ClassCAdapter,
  type ClassCMutation,
  type ClassCReadFn,
  type ClassCRun
} from "@jarvis/tool-gateway";
import { ScriptedTransport } from "./support/class-c-baseline-harness.ts";

/**
 * WP-AUTH2a (K1/K2/K4): rammeverkskjernen uten database og uten nettverk. Alt er deterministisk og kjøres mot en generisk «items.rename»-adapter (ingen leverandør) og skriptede lesninger.
 */

const join = (...parts: string[]): string => parts.join("");
const GITHUB_LIKE_TOKEN = join("gh", "p_", "A".repeat(36));

interface Item { id: string; name: string; trashed: boolean; rev: string }
const item = (over: Partial<Item> = {}): { data: JsonValue } => ({ data: { id: "i1", name: "gammelt", trashed: false, rev: "r1", ...over } as unknown as JsonValue });

function itemAdapter(over: Partial<ClassCAdapter> = {}): ClassCAdapter {
  const view = (reads: Record<string, { ok: boolean; data?: JsonValue | null }>): Item => reads["item"]!.data as unknown as Item;
  return {
    key: "items.rename",
    validate: (p) => (typeof p["name"] === "string" && p["name"] !== "" ? null : "name_missing"),
    before: {
      reads: (p) => [{ id: "item", action: "get_item", parameters: { id: p["id"] ?? null } }],
      judge: (p, reads) => {
        const current = view(reads as never);
        if (current.trashed) return { block: "item_trashed" };
        return { block: null, ...(current.name === p["name"] ? { warnings: ["name_unchanged"] } : {}) };
      },
      snapshot: (_p, reads) => {
        const current = view(reads as never);
        return { state: { name: current.name, trashed: current.trashed }, context: { rev: current.rev } };
      }
    },
    after: {
      reads: (p) => [{ id: "item", action: "get_item", parameters: { id: p["id"] ?? null } }],
      snapshot: (_p, _m, reads) => {
        const current = view(reads as never);
        return { state: { name: current.name, trashed: current.trashed }, context: { rev: current.rev } };
      }
    },
    expect: (p) => [{ path: "name", op: "equals", value: p["name"] ?? null }, { path: "trashed", op: "unchanged" }],
    rollback: (p, _m, before) => ({
      kind: "compensating_action",
      steps: [{ tool_id: "items", action: "rename", parameters: { id: p["id"] ?? null, name: before.state["name"] ?? null } }],
      note: "Gi tilbake forrige navn"
    }),
    ...over
  };
}

const MUTATION: ClassCMutation = { external_id: "i1", data: null };
const PARAMS = { id: "i1", name: "nytt" };

function readFrom(script: ConstructorParameters<typeof ScriptedTransport>[1]): { read: ClassCReadFn; transport: ScriptedTransport } {
  const transport = new ScriptedTransport("items", script);
  return { read: (action, parameters) => transport.invoke(action, parameters), transport };
}

function run(mode: "observe" | "enforce", adapter: ClassCAdapter = itemAdapter(), extras: Parameters<ClassCPipeline["begin"]>[1] = {}): ClassCRun {
  const pipeline = createClassCPipeline({ mode, adapters: [adapter] });
  const r = pipeline.begin({ tool_id: "items", action: "rename", capability_class: "C" }, extras);
  if (r === null) throw new Error("forventet en kjøring");
  return r;
}

describe("A: modus (JARVIS_CLASS_C_PIPELINE)", () => {
  it("manglende, tom og off gir off uten feil; observe/enforce uavhengig av store/små bokstaver og blanke", () => {
    for (const raw of [undefined, null, "", "   ", "off", "OFF", " Off "]) expect(parseClassCMode(raw as string | undefined), String(raw)).toEqual({ mode: "off", invalid: false });
    expect(parseClassCMode("observe")).toEqual({ mode: "observe", invalid: false });
    expect(parseClassCMode(" ENFORCE ")).toEqual({ mode: "enforce", invalid: false });
  });
  it("en skrivefeil gir off (aldri en stille enforce) og meldes som ugyldig slik at oppstarten kan si fra", () => {
    for (const raw of ["enfroce", "on", "true", "1", "observer", "enforce,observe"]) expect(parseClassCMode(raw), raw).toEqual({ mode: "off", invalid: true });
  });
});

describe("B: kanonisk JSON og sammenligning", () => {
  it("nøkkelrekkefølge spiller ingen rolle, matriserekkefølge gjør det, undefined er null", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson("a")).not.toBe(canonicalJson(["a"]));
    expect(canonicalJson(1)).not.toBe(canonicalJson("1"));
  });
});

describe("C: sanering av bevis (felles hemmelighetsskanner)", () => {
  it("tokenformer sladdes, og lossless er usann", () => {
    const out = sanitizeEvidence({ name: `fil ${GITHUB_LIKE_TOKEN} slutt` });
    expect(JSON.stringify(out.value)).not.toContain(GITHUB_LIKE_TOKEN);
    expect(JSON.stringify(out.value)).toContain("[REDACTED:github_token]");
    expect(out.lossless).toBe(false);
  });
  it("nøkler som ser ut som hemmelighetsnavn får verdien erstattet, uansett innhold", () => {
    for (const key of ["token", "client_secret", "Password", "api_key", "apiKey", "private-key", "Authorization", "credential_ref", "cookie"]) {
      const out = sanitizeEvidence({ [key]: "harmlos" });
      expect((out.value as Record<string, JsonValue>)[key], key).toBe("[REDACTED:secret_key_name]");
      expect(out.lossless).toBe(false);
    }
  });
  it("ordinære verdier er uendret og lossless; blanke kollapses (ikke lossless); lange strenger kuttes til 200", () => {
    expect(sanitizeEvidence({ a: "ok", n: 3, b: true, z: null, arr: [1, "x"] })).toEqual({ value: { a: "ok", n: 3, b: true, z: null, arr: [1, "x"] }, lossless: true });
    expect(sanitizeEvidence("a   b").lossless).toBe(false);
    const long = sanitizeEvidence("x".repeat(500));
    expect((long.value as string).length).toBe(200);
    expect(long.lossless).toBe(false);
  });
  it("dybde, matrisestørrelse og antall nøkler er begrenset", () => {
    let deep: JsonValue = "bunn";
    for (let i = 0; i < 8; i += 1) deep = { n: deep };
    expect(JSON.stringify(sanitizeEvidence(deep).value)).toContain("[TRUNCATED:depth]");
    const arr = sanitizeEvidence(Array.from({ length: 100 }, (_, i) => i));
    expect((arr.value as JsonValue[]).length).toBe(40);
    expect(arr.lossless).toBe(false);
    const wide = sanitizeEvidence(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])));
    expect(Object.keys(wide.value as object).length).toBe(40);
  });
  it("undefined og null gir null", () => {
    expect(sanitizeEvidence(undefined)).toEqual({ value: null, lossless: true });
    expect(sanitizeEvidence(null)).toEqual({ value: null, lossless: true });
  });
});

describe("D: diff og forventninger", () => {
  it("diff finner alle endrede blad-stier (sortert), behandler manglende som null og matriser som blader", () => {
    const d = diffStates({ a: 1, n: { x: 1, y: [1, 2] }, gone: "v" }, { a: 2, n: { x: 1, y: [1, 3] }, fresh: true });
    expect(d).toEqual([
      { path: "a", before: 1, after: 2 },
      { path: "fresh", before: null, after: true },
      { path: "gone", before: "v", after: null },
      { path: "n.y", before: [1, 2], after: [1, 3] }
    ]);
    expect(diffStates({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([]);
    expect(diffStates({}, {})).toEqual([]);
  });
  it("objekt som blir til null (opprettelse) gir en diff på bladene", () => {
    expect(diffStates({ pr: null }, { pr: { number: 7 } })).toEqual([{ path: "pr.number", before: null, after: 7 }]);
  });
  it("equals/unchanged/changed/present/absent: oppfylt og brutt, med presist brudd", () => {
    const before = { name: "a", n: { v: 1 }, gone: "x", nul: null };
    const after = { name: "b", n: { v: 1 }, nul: null, made: "y" };
    expect(evaluateExpectation({ path: "name", op: "equals", value: "b" }, before, after)).toBeNull();
    expect(evaluateExpectation({ path: "name", op: "equals", value: "c" }, before, after)).toEqual({ path: "name", rule: "expected_equals", expected: "c", actual: "b" });
    expect(evaluateExpectation({ path: "n.v", op: "unchanged" }, before, after)).toBeNull();
    expect(evaluateExpectation({ path: "name", op: "unchanged" }, before, after)).toEqual({ path: "name", rule: "expected_unchanged", expected: "a", actual: "b" });
    expect(evaluateExpectation({ path: "name", op: "changed" }, before, after)).toBeNull();
    expect(evaluateExpectation({ path: "n.v", op: "changed" }, before, after)).toEqual({ path: "n.v", rule: "expected_changed", actual: 1 });
    expect(evaluateExpectation({ path: "made", op: "present" }, before, after)).toBeNull();
    expect(evaluateExpectation({ path: "nul", op: "present" }, before, after)).toEqual({ path: "nul", rule: "expected_present" });
    expect(evaluateExpectation({ path: "gone", op: "absent" }, before, after)).toBeNull();
    expect(evaluateExpectation({ path: "made", op: "absent" }, before, after)).toEqual({ path: "made", rule: "expected_absent", actual: "y" });
  });
  it("unobservable er aldri oppfylt: gir et brudd med årsaken (verdiktet avgjøres av pipelinen, ikke av evalueringen)", () => {
    expect(evaluateExpectation({ path: "v", op: "unobservable", reason: "ingen_revisjon" }, { v: 1 }, { v: 1 })).toEqual({ path: "v", rule: "unobservable", expected: "ingen_revisjon" });
  });
  it("equals sammenligner dypt og strukturelt (matriser i rekkefølge, objekter uavhengig av nøkkelrekkefølge)", () => {
    expect(evaluateExpectation({ path: "p", op: "equals", value: ["a", "b"] }, {}, { p: ["a", "b"] })).toBeNull();
    expect(evaluateExpectation({ path: "p", op: "equals", value: ["a", "b"] }, {}, { p: ["b", "a"] })).not.toBeNull();
    expect(evaluateExpectation({ path: "p", op: "equals", value: { x: 1, y: 2 } }, {}, { p: { y: 2, x: 1 } })).toBeNull();
  });
});

describe("E: registeret og eierens kontrollhandlinger", () => {
  const adapter = (key: string): ClassCAdapter => itemAdapter({ key });
  it("ugyldig nøkkel og duplikat avvises ved oppsett", () => {
    for (const key of ["", "noaction", "UPPER.case", "a.b.c d", "a..b", ".x"]) expect(() => new ClassCPipeline({ mode: "observe", adapters: [adapter(key)] }), key).toThrow(/class_c_adapter_key_invalid/);
    expect(() => new ClassCPipeline({ mode: "observe", adapters: [adapter("items.rename"), adapter("items.rename")] })).toThrow("class_c_adapter_duplicate:items.rename");
  });
  it("adaptere for eierens kontrollhandlinger nektes: owner_controls, kill switch, selvgjenoppretting og pause/frys/tilbakekall", () => {
    for (const key of [
      "owner_controls.freeze_connector", "owner_controls.set_connector_credential", "owner_controls.get_control_state",
      "executive.activate_kill_switch", "finance.enable_kill_switch", "executive.get_control_surface_status", "situations.get_pause_state", "finance.get_kill_switch",
      ...CLASS_C_OWNER_OVERRIDE_ACTIONS
    ]) {
      expect(() => new ClassCPipeline({ mode: "enforce", adapters: [adapter(key)] }), key).toThrow(`class_c_adapter_forbidden:${key}`);
    }
  });
  it("begin gir aldri en kjøring for eierens kontrollhandlinger, uansett modus", () => {
    const p = new ClassCPipeline({ mode: "enforce", adapters: [adapter("items.rename")] });
    for (const key of CLASS_C_OWNER_OVERRIDE_ACTIONS) {
      const [tool_id, action] = key.split(".") as [string, string];
      expect(p.begin({ tool_id, action, capability_class: "C" }), key).toBeNull();
      expect(isClassCOwnerOverride({ tool_id, action }), key).toBe(true);
    }
  });
  it("begin: off = null, ikke klasse C = null, uten adapter = null, ellers en kjøring i riktig modus", () => {
    const def = { tool_id: "items", action: "rename", capability_class: "C" as const };
    expect(new ClassCPipeline({ mode: "off", adapters: [adapter("items.rename")] }).begin(def)).toBeNull();
    for (const capability_class of ["A", "B", "D"] as const) expect(new ClassCPipeline({ mode: "enforce", adapters: [adapter("items.rename")] }).begin({ ...def, capability_class }), capability_class).toBeNull();
    expect(new ClassCPipeline({ mode: "enforce", adapters: [adapter("items.rename")] }).begin({ ...def, action: "other" })).toBeNull();
    expect(new ClassCPipeline({ mode: "observe", adapters: [adapter("items.rename")] }).begin(def)?.mode).toBe("observe");
    expect(new ClassCPipeline({ mode: "enforce", adapters: [adapter("items.rename")] }).begin(def)?.mode).toBe("enforce");
  });
  it("adapterKeys er sortert og describe bærer kun navn", () => {
    const p = new ClassCPipeline({ mode: "observe", adapters: [adapter("zeta.run"), adapter("alfa.run")] });
    expect(p.adapterKeys()).toEqual(["alfa.run", "zeta.run"]);
    expect(p.describe()).toEqual({ msg: "class_c_pipeline", mode: "observe", adapters: ["alfa.run", "zeta.run"] });
  });
});

describe("F: preflight", () => {
  it("bestått: lesingene kjøres i rekkefølge, før-snapshot er sladdet JSON, ingen blokk", async () => {
    const { read, transport } = readFrom({ get_item: [item()] });
    const r = run("enforce");
    const out = await r.preflight(PARAMS, read, { replay: false });
    expect(out.block).toBeNull();
    expect(out.beforeState).toEqual({ state: { name: "gammelt", trashed: false }, context: { rev: "r1" } });
    expect(transport.calls.map((c) => c.action)).toEqual(["get_item"]);
    expect(r.auditBlock()["preflight"]).toMatchObject({ outcome: "passed", reason: null, reads: [{ id: "item", action: "get_item", ok: true }] });
  });

  it("ugyldig mål: enforce blokkerer UTEN å lese noe; observe slipper gjennom og registrerer «ville blokkert»", async () => {
    const e = readFrom({ get_item: [item()] });
    const enforce = run("enforce");
    expect(await enforce.preflight({ id: "i1" }, e.read, { replay: false })).toEqual({ block: "class_c_target_invalid:name_missing", beforeState: null });
    expect(e.transport.calls).toEqual([]);
    const o = readFrom({ get_item: [item()] });
    const observe = run("observe");
    const out = await observe.preflight({ id: "i1" }, o.read, { replay: false });
    expect(out.block).toBeNull();
    expect(observe.auditBlock()["would_block"]).toEqual(["preflight:target_invalid:name_missing"]);
    expect(observe.auditBlock()["preflight"]).toMatchObject({ outcome: "would_block", reason: "target_invalid:name_missing" });
  });

  it("vurderingen blokkerer med adapterens kode; advarsler blokkerer aldri og registreres", async () => {
    const trashed = readFrom({ get_item: [item({ trashed: true })] });
    expect((await run("enforce").preflight(PARAMS, trashed.read, { replay: false })).block).toBe("class_c_preflight_invalid:item_trashed");
    const same = readFrom({ get_item: [item({ name: "nytt" })] });
    const r = run("enforce");
    expect((await r.preflight(PARAMS, same.read, { replay: false })).block).toBeNull();
    expect(r.auditBlock()["preflight"]).toMatchObject({ outcome: "passed", warnings: ["name_unchanged"] });
  });

  it("en nødvendig lesing som feiler blokkerer (fail-lukket) med typen: tidsavbrudd, ikke funnet eller annen feil - og vurderingen kjøres ikke", async () => {
    let judged = 0;
    const adapter = itemAdapter({ before: { ...itemAdapter().before, judge: () => { judged += 1; return { block: null }; } } });
    for (const [thrown, expected] of [
      ["tool_timeout", "class_c_preflight_failed:item:timeout"],
      ["github_api_error_404:Not Found", "class_c_target_not_found:item"],
      ["drive_not_found_x", "class_c_target_not_found:item"],
      ["vendor_500", "class_c_preflight_failed:item:read_failed"]
    ] as const) {
      const { read } = readFrom({ get_item: [{ throw: thrown }] });
      expect((await run("enforce", adapter).preflight(PARAMS, read, { replay: false })).block, thrown).toBe(expected);
    }
    expect(judged).toBe(0);
  });

  it("en valgfri lesing som feiler blokkerer ikke", async () => {
    const adapter = itemAdapter({
      before: {
        ...itemAdapter().before,
        reads: (p) => [{ id: "item", action: "get_item", parameters: { id: p["id"] ?? null } }, { id: "extra", action: "list_extra", parameters: {}, optional: true }]
      }
    });
    const { read } = readFrom({ get_item: [item()], list_extra: [{ throw: "vendor_500" }] });
    const r = run("enforce", adapter);
    expect((await r.preflight(PARAMS, read, { replay: false })).block).toBeNull();
    expect(r.auditBlock()["preflight"]).toMatchObject({ reads: [{ id: "item", ok: true }, { id: "extra", ok: false, error: "vendor_500" }] });
  });

  it("en adapter som kaster (validate, reads, judge, snapshot, ugyldig state-nøkkel) er fail-lukket i enforce og kun registrert i observe", async () => {
    const boom = (): never => { throw new Error("adapter_bug"); };
    const variants: ClassCAdapter[] = [
      itemAdapter({ validate: boom }),
      itemAdapter({ before: { ...itemAdapter().before, reads: boom } }),
      itemAdapter({ before: { ...itemAdapter().before, judge: boom } }),
      itemAdapter({ before: { ...itemAdapter().before, snapshot: boom } }),
      itemAdapter({ before: { ...itemAdapter().before, snapshot: () => ({ state: { "a.b": 1 }, context: {} }) } })
    ];
    for (const adapter of variants) {
      const e = readFrom({ get_item: [item()] });
      const blocked = (await run("enforce", adapter).preflight(PARAMS, e.read, { replay: false })).block;
      expect(blocked).toMatch(/^class_c_preflight_failed:adapter_error:/);
      const o = readFrom({ get_item: [item()] });
      const observe = run("observe", adapter);
      expect((await observe.preflight(PARAMS, o.read, { replay: false })).block).toBeNull();
      expect((observe.auditBlock()["would_block"] as string[])[0]).toMatch(/^preflight:preflight_failed:adapter_error:/);
    }
  });

  it("replay hopper over hele fasen (ingen lesing, ingen vurdering) og kan aldri blokkere", async () => {
    const { read, transport } = readFrom({ get_item: [item({ trashed: true })] });
    const r = run("enforce");
    expect(await r.preflight(PARAMS, read, { replay: true })).toEqual({ block: null, beforeState: null });
    expect(transport.calls).toEqual([]);
    expect(r.auditBlock()["preflight"]).toMatchObject({ outcome: "skipped", reason: "replay" });
  });

  it("årsakskoder er alltid et trygt tegnsett og begrenset i lengde", async () => {
    const adapter = itemAdapter({ validate: () => "Ugyldig mål! med mellomrom\nog linjeskift".repeat(8) });
    const { read } = readFrom({ get_item: [item()] });
    const block = (await run("enforce", adapter).preflight(PARAMS, read, { replay: false })).block!;
    expect(block).toMatch(/^class_c_target_invalid:[A-Za-z0-9_:.-]+$/);
    expect(block.length).toBeLessThanOrEqual(120);
  });
});

describe("G: etterkontroll (readback, diff, verdikt)", () => {
  async function preflighted(mode: "observe" | "enforce", adapter: ClassCAdapter = itemAdapter(), script: ConstructorParameters<typeof ScriptedTransport>[1] = { get_item: [item(), item({ name: "nytt", rev: "r2" })] }, extras = {}) {
    const { read, transport } = readFrom(script);
    const r = run(mode, adapter, extras);
    await r.preflight(PARAMS, read, { replay: false });
    return { r, read, transport };
  }

  it("verifisert: alle forventninger holder og ingenting uventet endret seg; kontekst (rev) er ikke en del av diffen", async () => {
    const { r, read } = await preflighted("enforce");
    const out = await r.verify(PARAMS, MUTATION, read);
    expect(out.postconditionReason).toBeNull();
    expect(out.afterState).toEqual({ state: { name: "nytt", trashed: false }, context: { rev: "r2" } });
    const block = r.auditBlock();
    expect(block["verdict"]).toBe("verified");
    expect(block["diff"]).toEqual([{ path: "name", before: "gammelt", after: "nytt" }]);
    expect(block["violations"]).toEqual([]);
    expect(block["expected"]).toEqual([{ path: "name", op: "equals", value: "nytt" }, { path: "trashed", op: "unchanged" }]);
  });

  it("brudd på en forventning er mismatch -> postcondition_mismatch (enforce), registrert men uten statusendring (observe)", async () => {
    const script = { get_item: [item(), item({ name: "feil-navn" })] };
    const e = await preflighted("enforce", itemAdapter(), script);
    expect((await e.r.verify(PARAMS, MUTATION, e.read)).postconditionReason).toBe("postcondition_mismatch");
    expect(e.r.auditBlock()["violations"]).toEqual([{ path: "name", rule: "expected_equals", expected: "nytt", actual: "feil-navn" }]);
    const o = await preflighted("observe", itemAdapter(), script);
    expect((await o.r.verify(PARAMS, MUTATION, o.read)).postconditionReason).toBeNull();
    expect(o.r.auditBlock()["verdict"]).toBe("mismatch");
    expect(o.r.auditBlock()["would_block"]).toEqual(["verify:postcondition_mismatch"]);
  });

  it("en UVENTET endring (felt uten forventning) er mismatch; en tolerert sti er det ikke", async () => {
    const adapter = (tolerated?: string[]) => itemAdapter({
      ...(tolerated ? { tolerated } : {}),
      before: { ...itemAdapter().before, snapshot: (_p, reads) => { const c = (reads["item"] as unknown as { data: Item }).data; return { state: { name: c.name, trashed: c.trashed, rev: c.rev }, context: {} }; } },
      after: { ...itemAdapter().after, snapshot: (_p, _m, reads) => { const c = (reads["item"] as unknown as { data: Item }).data; return { state: { name: c.name, trashed: c.trashed, rev: c.rev }, context: {} }; } }
    });
    const script = { get_item: [item(), item({ name: "nytt", rev: "r2" })] };
    const bad = await preflighted("enforce", adapter(), script);
    expect((await bad.r.verify(PARAMS, MUTATION, bad.read)).postconditionReason).toBe("postcondition_mismatch");
    expect(bad.r.auditBlock()["violations"]).toEqual([{ path: "rev", rule: "unexpected_change", expected: "r1", actual: "r2" }]);
    const ok = await preflighted("enforce", adapter(["rev"]), script);
    expect((await ok.r.verify(PARAMS, MUTATION, ok.read)).postconditionReason).toBeNull();
  });

  it("toleranse dekker også underordnede stier, men ikke søsken med lignende navn", async () => {
    const adapter = itemAdapter({
      tolerated: ["meta"],
      before: { ...itemAdapter().before, snapshot: () => ({ state: { name: "gammelt", trashed: false, meta: { a: 1 }, metadata: 1 }, context: {} }) },
      after: { ...itemAdapter().after, snapshot: () => ({ state: { name: "nytt", trashed: false, meta: { a: 2 }, metadata: 2 }, context: {} }) }
    });
    const { r, read } = await preflighted("enforce", adapter);
    expect((await r.verify(PARAMS, MUTATION, read)).postconditionReason).toBe("postcondition_mismatch");
    expect((r.auditBlock()["violations"] as Array<{ path: string }>).map((v) => v.path)).toEqual(["metadata"]);
  });

  it("readback som feiler: tidsavbrudd/feil = readback_failed, ikke funnet = target_missing; verdiktet er unverified", async () => {
    for (const [thrown, reason] of [["tool_timeout", "postcondition_unverified:readback_failed"], ["vendor_500", "postcondition_unverified:readback_failed"], ["drive_not_found_i1", "postcondition_unverified:target_missing"]] as const) {
      const { r, read } = await preflighted("enforce", itemAdapter(), { get_item: [item(), { throw: thrown }] });
      expect((await r.verify(PARAMS, MUTATION, read)).postconditionReason, thrown).toBe(reason);
      expect(r.auditBlock()["verdict"]).toBe("unverified");
      expect(r.auditBlock()["after"]).toBeNull();
    }
  });

  it("adapter uten mulig readback (null/tom liste) er unverified - aldri suksess", async () => {
    for (const reads of [() => null, () => []]) {
      const adapter = itemAdapter({ after: { ...itemAdapter().after, reads } });
      const { r, read } = await preflighted("enforce", adapter);
      expect((await r.verify(PARAMS, MUTATION, read)).postconditionReason).toBe("postcondition_unverified:class_c_no_readback");
    }
  });

  it("adapter som kaster i etterkontrollen er predicate_error (enforce) og kun registrert (observe)", async () => {
    const adapter = itemAdapter({ expect: () => { throw new Error("adapter_bug"); } });
    const e = await preflighted("enforce", adapter);
    expect((await e.r.verify(PARAMS, MUTATION, e.read)).postconditionReason).toBe("postcondition_unverified:predicate_error");
    const o = await preflighted("observe", adapter);
    expect((await o.r.verify(PARAMS, MUTATION, o.read)).postconditionReason).toBeNull();
    expect(o.r.auditBlock()["would_block"]).toEqual(["verify:postcondition_unverified:predicate_error"]);
    expect(o.r.auditBlock()["verdict_detail"]).toMatch(/^adapter_error:/);
  });

  it("uten før-tilstand (replay eller preflight som ikke ble ferdig) kan ingen diff beregnes: unverified (enforce), aldri verifisert", async () => {
    const { read } = readFrom({ get_item: [item({ name: "nytt" })] });
    const r = run("enforce");
    await r.preflight(PARAMS, read, { replay: true });
    expect((await r.verify(PARAMS, MUTATION, read)).postconditionReason).toBe("postcondition_unverified:class_c_no_baseline");
    expect(r.auditBlock()["verdict_detail"]).toBe("before_state_missing:replay");
    const fresh = run("enforce");
    expect((await fresh.verify(PARAMS, MUTATION, read)).postconditionReason).toBe("postcondition_unverified:class_c_no_baseline");
    expect(fresh.auditBlock()["verdict_detail"]).toBe("before_state_missing");
  });

  it("en effekt som ikke kan observeres gir unverified (aldri verified), også når alt annet stemmer; et reelt brudd går foran og gir mismatch", async () => {
    const adapter = itemAdapter({ expect: (p) => [{ path: "name", op: "equals", value: p["name"] ?? null }, { path: "trashed", op: "unobservable", reason: "ikke_lesbar" }] });
    const { r, read } = await preflighted("enforce", adapter);
    expect((await r.verify(PARAMS, MUTATION, read)).postconditionReason).toBe("postcondition_unverified:class_c_unobservable");
    expect(r.auditBlock()["verdict"]).toBe("unverified");
    expect(r.auditBlock()["verdict_detail"]).toBe("unobservable:trashed");
    expect(r.auditBlock()["violations"]).toEqual([{ path: "trashed", rule: "unobservable", expected: "ikke_lesbar" }]);
    const both = itemAdapter({ expect: () => [{ path: "name", op: "equals", value: "feil" }, { path: "trashed", op: "unobservable", reason: "ikke_lesbar" }] });
    const m = await preflighted("enforce", both);
    expect((await m.r.verify(PARAMS, MUTATION, m.read)).postconditionReason).toBe("postcondition_mismatch");
    const o = await preflighted("observe", adapter);
    expect((await o.r.verify(PARAMS, MUTATION, o.read)).postconditionReason).toBeNull();
    expect(o.r.auditBlock()["would_block"]).toEqual(["verify:postcondition_unverified:class_c_unobservable"]);
  });

  it("ugyldige stier i forventninger er en adapterfeil (ikke en stille bestått kontroll)", async () => {
    const adapter = itemAdapter({ expect: () => [{ path: "a..b", op: "present" }] });
    const { r, read } = await preflighted("enforce", adapter);
    expect((await r.verify(PARAMS, MUTATION, read)).postconditionReason).toBe("postcondition_unverified:predicate_error");
  });

  it("observe endrer ALDRI utfallet: verdikt registreres, reason er alltid null", async () => {
    for (const script of [
      { get_item: [item(), item({ name: "nytt" })] },
      { get_item: [item(), item({ name: "feil" })] },
      { get_item: [item(), { throw: "vendor_500" }] }
    ]) {
      const { r, read } = await preflighted("observe", itemAdapter(), script);
      expect((await r.verify(PARAMS, MUTATION, read)).postconditionReason).toBeNull();
    }
  });
});

describe("H: rollback-plan", () => {
  it("planen registreres med stabil referanse; samme plan gir samme referanse, ulik plan en annen", async () => {
    const make = async (name: string) => {
      const { read } = readFrom({ get_item: [item({ name }), item({ name: "nytt" })] });
      const r = run("enforce", itemAdapter(), { isRegistered: (t, a) => t === "items" && a === "rename" });
      await r.preflight(PARAMS, read, { replay: false });
      await r.verify(PARAMS, MUTATION, read);
      return r.auditBlock()["rollback"] as { kind: string; ref: string; complete: boolean; registered: boolean[]; steps: Array<{ parameters: { name: string } }> };
    };
    const a = await make("gammelt");
    const b = await make("gammelt");
    const c = await make("annet");
    expect(a).toMatchObject({ kind: "compensating_action", complete: true, registered: [true], steps: [{ tool_id: "items", action: "rename", parameters: { id: "i1", name: "gammelt" } }] });
    expect(a.ref).toMatch(/^crb-[0-9a-f]{16}$/);
    expect(b.ref).toBe(a.ref);
    expect(c.ref).not.toBe(a.ref);
  });

  it("uten register-oppslag er trinnene ikke merket som utførbare; ukjent verktøy er ikke utførbart", async () => {
    const { read } = readFrom({ get_item: [item(), item({ name: "nytt" })] });
    const r = run("enforce");
    await r.preflight(PARAMS, read, { replay: false });
    await r.verify(PARAMS, MUTATION, read);
    expect((r.auditBlock()["rollback"] as { registered: boolean[] }).registered).toEqual([false]);
    const r2 = run("enforce", itemAdapter(), { isRegistered: () => false });
    await r2.preflight(PARAMS, read, { replay: false });
    await r2.verify(PARAMS, MUTATION, read);
    expect((r2.auditBlock()["rollback"] as { registered: boolean[] }).registered).toEqual([false]);
  });

  it("en plan med verdier som sladdes er ikke komplett (kan ikke gjenskapes ordrett)", async () => {
    const { read } = readFrom({ get_item: [item({ name: `hemmelig ${GITHUB_LIKE_TOKEN}` }), item({ name: "nytt" })] });
    const r = run("enforce");
    await r.preflight(PARAMS, read, { replay: false });
    await r.verify(PARAMS, MUTATION, read);
    const plan = r.auditBlock()["rollback"] as { complete: boolean; steps: Array<{ parameters: { name: string } }> };
    expect(plan.complete).toBe(false);
    expect(JSON.stringify(plan)).not.toContain(GITHUB_LIKE_TOKEN);
  });

  it("en adapter som kaster i rollback gir en manuell plan, ikke en feil; uten før-tilstand en manuell plan", async () => {
    const { read } = readFrom({ get_item: [item(), item({ name: "nytt" })] });
    const r = run("enforce", itemAdapter({ rollback: () => { throw new Error("bug"); } }));
    await r.preflight(PARAMS, read, { replay: false });
    await r.verify(PARAMS, MUTATION, read);
    expect(r.auditBlock()["rollback"]).toMatchObject({ kind: "manual", steps: [] });
    const r2 = run("enforce");
    await r2.verify(PARAMS, MUTATION, read);
    expect(r2.auditBlock()["rollback"]).toMatchObject({ kind: "manual", steps: [] });
  });

  it("rollback beregnes også når etterkontrollen feiler (planen er mest nyttig da)", async () => {
    const { r, read } = await (async () => {
      const f = readFrom({ get_item: [item(), { throw: "vendor_500" }] });
      const rr = run("enforce");
      await rr.preflight(PARAMS, f.read, { replay: false });
      return { r: rr, read: f.read };
    })();
    await r.verify(PARAMS, MUTATION, read);
    expect(r.auditBlock()["rollback"]).toMatchObject({ kind: "compensating_action" });
  });
});

describe("I: audit-blokken", () => {
  it("har et fast skjema; request_digest tas kun imot som gyldig SHA-256 (felt, ikke kodeavhengighet)", async () => {
    const digest = "ab".repeat(32);
    for (const [given, expected] of [[digest, digest], ["xyz", null], [undefined, null], [null, null], ["AB".repeat(32), null]] as const) {
      const r = run("enforce", itemAdapter(), given === undefined ? {} : { requestDigest: given });
      expect(r.auditBlock()).toMatchObject({ schema: 1, mode: "enforce", adapter: "items.rename", request_digest: expected, verdict: "not_run", preflight: null, before: null, after: null, rollback: null });
    }
    expect(requestDigestOf({ request_digest: digest })).toBe(digest);
    expect(requestDigestOf({ request_digest: "kort" })).toBeNull();
    expect(requestDigestOf({})).toBeNull();
    expect(requestDigestOf({ request_digest: 5 })).toBeNull();
  });

  it("alt i blokken er sladdet: hemmeligheter i leverandørtekst når aldri audit", async () => {
    const { read } = readFrom({ get_item: [item({ name: `a ${GITHUB_LIKE_TOKEN}` }), item({ name: `b ${GITHUB_LIKE_TOKEN}` })] });
    const r = run("enforce", itemAdapter({ expect: () => [{ path: "name", op: "present" }] }));
    await r.preflight(PARAMS, read, { replay: false });
    await r.verify(PARAMS, MUTATION, read);
    expect(JSON.stringify(r.auditBlock())).not.toContain(GITHUB_LIKE_TOKEN);
    expect(JSON.stringify(r.auditBlock())).toContain("[REDACTED:github_token]");
  });

  it("en for stor blokk kuttes i to trinn (kontekst, så verdier) og forblir under grensen; verdikt og stier beholdes", async () => {
    const big = (tag: string): ClassCAdapter => itemAdapter({
      before: {
        ...itemAdapter().before,
        snapshot: () => ({ state: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, `${tag}${"x".repeat(190)}`])), context: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, "y".repeat(190)])) })
      },
      after: {
        ...itemAdapter().after,
        snapshot: () => ({ state: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, `${tag}${"z".repeat(190)}`])), context: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, "y".repeat(190)])) })
      },
      expect: () => [{ path: "f0", op: "changed" }]
    });
    const { read } = readFrom({ get_item: [item(), item()] });
    const r = run("enforce", big("a"));
    await r.preflight(PARAMS, read, { replay: false });
    await r.verify(PARAMS, MUTATION, read);
    const block = r.auditBlock();
    expect(JSON.stringify(block).length).toBeLessThanOrEqual(CLASS_C_AUDIT_MAX_CHARS);
    expect(block["truncated"]).toBe(true);
    expect(block["verdict"]).toBe("mismatch");
    expect(block["rollback"]).not.toBeNull();
  });
});
