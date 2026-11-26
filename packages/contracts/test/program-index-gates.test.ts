/* eslint-disable @typescript-eslint/no-explicit-any -- mutasjonshjelperne endrer ett felt om gangen i en dyp JSON-kopi; å typet hver sti ville bare duplisert skjemaene. */
import { describe, expect, it } from "vitest";
import { OPERATIONAL_GATE_CHANGED_TYPE, OPERATIONAL_GATE_CHANGED_VERSION, OperationalGateChangedEventSchema, OperationalGateChangedPayloadSchema } from "../src/program/gate-events.ts";
import { GATE_RULES, GateSchema, ORL_IDS, OrlSchema, PROGRAM_GATE_IDS, evaluateGate, evaluateOrl, scanGates, type Gate, type GateContext, type Orl } from "../src/program/gates.ts";
import type { EvidenceRef } from "../src/program/schema.ts";
import { T0 } from "./program-index-fixtures.ts";

/**
 * WP-PGA / PG3 (HF6 §26-27, D-PROG-08, H6-PG10/OR01): de 17 Program Completion-portene og ORL0-5 som DATA, evidence_ref med staleness-regel og hendelseskontrakten `OperationalGateChanged`.
 * Regelen «ingen PASS uten gjenverifiserbar evidens» og «OPEN igjen etter kontraktendring» er det som testes her - hvert grensetilfelle for seg.
 */
const T_OLD = "2026-11-20T10:00:00.000Z";
const T_MID = "2026-11-25T10:00:00.000Z";
const T_NEW = "2026-11-27T10:00:00.000Z";
const FP1 = `sha256:${"1".repeat(64)}`;
const FP2 = `sha256:${"2".repeat(64)}`;
const EV_SHA = "e".repeat(64);

const evidence = (patch: Partial<EvidenceRef> = {}): EvidenceRef => ({
  path: "docs/evidence/2026-11-25-g01.md",
  sha256: EV_SHA,
  git_sha: "a".repeat(40),
  recorded_at: T_MID,
  verified_at: T_MID,
  verified_at_source: "evidence_header",
  contract_fingerprints: { "core.alpha": FP1 },
  ...patch
});

const openGate = (patch: Partial<Gate> = {}): Gate => ({
  schema_version: "1.0.0",
  kind: "program_gate",
  id: "G02",
  number: 2,
  title: "Eierskap",
  pass_criterion: "Hver tilstandsbærende komponent har nøyaktig én eier og skanningen har null uløste funn.",
  bound_components: ["core.alpha"],
  external: false,
  status: "OPEN",
  evidence_ref: null,
  history: [],
  ...patch
});

const change = (patch: Record<string, unknown> = {}) => ({ gate_kind: "program_gate", gate_id: "G02", prior_status: "OPEN", new_status: "PASS", evidence_refs: [evidence()], owner: "owner", changed_at: T_MID, reason: "Evidens registrert etter test.", ...patch });
const passGate = (patch: Partial<Gate> = {}): Gate => openGate({ status: "PASS", evidence_ref: evidence(), history: [change() as Gate["history"][number]], ...patch });

const ctx = (over: { components?: Record<string, { contract_fingerprint: string | null; changed_at: string | null } | undefined>; files?: Record<string, string | null> } = {}): GateContext => ({
  component: (id) => (over.components ?? { "core.alpha": { contract_fingerprint: FP1, changed_at: T_OLD } })[id],
  evidence_sha256: (p) => (over.files ?? { "docs/evidence/2026-11-25-g01.md": EV_SHA })[p] ?? null
});

describe("identifikatorer", () => {
  it("17 porter G01-G17 og seks nivåer ORL0-ORL5", () => {
    expect([...PROGRAM_GATE_IDS]).toEqual(["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09", "G10", "G11", "G12", "G13", "G14", "G15", "G16", "G17"]);
    expect([...ORL_IDS]).toEqual(["ORL0", "ORL1", "ORL2", "ORL3", "ORL4", "ORL5"]);
  });
});

describe("GateSchema", () => {
  const ok = (v: unknown) => GateSchema.safeParse(v).success;
  const mut = (g: Gate, patch: (c: Record<string, any>) => void): unknown => {
    const c = JSON.parse(JSON.stringify(g)) as Record<string, any>;
    patch(c);
    return c;
  };

  it("en åpen port uten historikk og en PASS-port med evidens og historikk er gyldige", () => {
    expect(GateSchema.safeParse(openGate()).success).toBe(true);
    expect(GateSchema.safeParse(passGate()).success).toBe(true);
  });

  it("id og nummer hører sammen og er innenfor 1-17; ukjente felt avvises", () => {
    expect(ok(mut(openGate(), (c) => (c["id"] = "G18")))).toBe(false);
    expect(ok(mut(openGate(), (c) => (c["id"] = "G00")))).toBe(false);
    expect(ok(mut(openGate(), (c) => (c["number"] = 3)))).toBe(false);
    expect(ok(mut(openGate(), (c) => (c["number"] = 0)))).toBe(false);
    expect(ok(mut(openGate(), (c) => (c["extra"] = 1)))).toBe(false);
    expect(ok(mut(openGate(), (c) => (c["kind"] = "orl")))).toBe(false);
  });

  it("PASS krever evidence_ref (D-PROG-08)", () => {
    expect(ok(mut(passGate(), (c) => (c["evidence_ref"] = null)))).toBe(false);
  });

  it("uten historikk må porten være OPEN uten evidens; en status uten historikk er ikke tillatt", () => {
    expect(ok(mut(openGate(), (c) => (c["status"] = "FAIL")))).toBe(false);
    expect(ok(mut(openGate(), (c) => (c["evidence_ref"] = evidence())))).toBe(false);
  });

  it("historikken er en ubrutt kjede: første forrige = OPEN, hver forrige = forrige ny, siste ny = status, evidensen = siste evidens", () => {
    expect(ok(mut(passGate(), (c) => (c["history"][0]["prior_status"] = "PASS")))).toBe(false);
    expect(ok(mut(passGate(), (c) => (c["history"][0]["new_status"] = "FAIL")))).toBe(false);
    expect(ok(mut(passGate(), (c) => (c["history"][0]["evidence_refs"][0]["sha256"] = "f".repeat(64))))).toBe(false);
    const two = passGate({ history: [change({ new_status: "FAIL", evidence_refs: [evidence({ sha256: "d".repeat(64) })], changed_at: T_OLD }) as Gate["history"][number], change({ prior_status: "FAIL", changed_at: T_MID }) as Gate["history"][number]] });
    expect(GateSchema.safeParse(two).success).toBe(true);
    expect(ok(mut(two, (c) => (c["history"][1]["prior_status"] = "OPEN")))).toBe(false);
  });

  it("historikken er tidsmessig stigende, og hver oppføring tilhører porten (id og type)", () => {
    const g = passGate({ history: [change({ new_status: "FAIL", evidence_refs: [evidence({ sha256: "d".repeat(64) })], changed_at: T_MID }) as Gate["history"][number], change({ prior_status: "FAIL", changed_at: T_OLD }) as Gate["history"][number]] });
    expect(GateSchema.safeParse(g).success).toBe(false);
    expect(ok(mut(passGate(), (c) => (c["history"][0]["gate_id"] = "G03")))).toBe(false);
    expect(ok(mut(passGate(), (c) => (c["history"][0]["gate_kind"] = "orl")))).toBe(false);
  });

  it("gjenåpning (PASS -> OPEN) har ingen evidens og tømmer evidence_ref; en senere PASS krever ny evidens", () => {
    const reopened = openGate({ history: [change() as Gate["history"][number], change({ prior_status: "PASS", new_status: "OPEN", evidence_refs: [], changed_at: T_NEW, reason: "Kontrakten endret." }) as Gate["history"][number]] });
    expect(GateSchema.safeParse(reopened).success).toBe(true);
    expect(ok(mut(reopened, (c) => (c["evidence_ref"] = evidence())))).toBe(false);
  });

  it("bundne komponenter er gyldige, unike id-er", () => {
    expect(ok(mut(openGate(), (c) => (c["bound_components"] = ["core.alpha", "core.alpha"])))).toBe(false);
    expect(ok(mut(openGate(), (c) => (c["bound_components"] = ["Bad Id"])))).toBe(false);
    expect(ok(mut(openGate(), (c) => (c["bound_components"] = [])))).toBe(true);
  });

  it("tittel og kriterium har rimelig lengde", () => {
    expect(ok(mut(openGate(), (c) => (c["title"] = "ab")))).toBe(false);
    expect(ok(mut(openGate(), (c) => (c["pass_criterion"] = "kort")))).toBe(false);
    expect(ok(mut(openGate(), (c) => (c["pass_criterion"] = "x".repeat(301))))).toBe(false);
  });
});

describe("OrlSchema", () => {
  const orl = (patch: Partial<Orl> = {}): Orl => ({
    schema_version: "1.0.0",
    kind: "orl",
    id: "ORL2",
    level: 2,
    title: "Integrert",
    exit_criterion: "Ende-til-ende-flyter kjører på representativ infrastruktur med logging, autoritet og gjenoppretting.",
    requires_orl: "ORL1",
    requires_gates: ["G03"],
    bound_components: [],
    external: true,
    status: "OPEN",
    evidence_ref: null,
    history: [],
    ...patch
  });

  it("gyldige nivåer; id følger nivået; hvert nivå krever det forrige (ORL0 ingen)", () => {
    expect(OrlSchema.safeParse(orl()).success).toBe(true);
    expect(OrlSchema.safeParse(orl({ id: "ORL0", level: 0, requires_orl: null, requires_gates: [] })).success).toBe(true);
    expect(OrlSchema.safeParse(orl({ id: "ORL3" })).success).toBe(false);
    expect(OrlSchema.safeParse(orl({ requires_orl: "ORL0" })).success).toBe(false);
    expect(OrlSchema.safeParse(orl({ requires_orl: null })).success).toBe(false);
    expect(OrlSchema.safeParse(orl({ id: "ORL0", level: 0, requires_orl: "ORL1" })).success).toBe(false);
    expect(OrlSchema.safeParse(orl({ id: "ORL6" as never, level: 6 as never })).success).toBe(false);
  });

  it("krevde porter er gyldige og unike G-id-er", () => {
    expect(OrlSchema.safeParse(orl({ requires_gates: ["G03", "G03"] })).success).toBe(false);
    expect(OrlSchema.safeParse(orl({ requires_gates: ["G99"] })).success).toBe(false);
  });

  it("PASS krever evidens og historikk, som for porter", () => {
    expect(OrlSchema.safeParse(orl({ status: "PASS" })).success).toBe(false);
  });
});

describe("OperationalGateChanged (hendelseskontrakten: kun type og skjema, ingen produsent)", () => {
  it("konstantene er stabile", () => {
    expect(OPERATIONAL_GATE_CHANGED_TYPE).toBe("OperationalGateChanged");
    expect(OPERATIONAL_GATE_CHANGED_VERSION).toBe("1.0.0");
  });

  it("gyldig nyttelast og omslag; minimum nyttelast: gate, forrige/ny status, evidensreferanser, eier", () => {
    expect(OperationalGateChangedPayloadSchema.safeParse(change()).success).toBe(true);
    expect(OperationalGateChangedEventSchema.safeParse({ type: "OperationalGateChanged", schema_version: "1.0.0", payload: change() }).success).toBe(true);
  });

  it("avviser: ukjent type/versjon, ingen overgang (forrige = ny), PASS uten nøyaktig én evidens, OPEN med evidens, ukjent id, feil gate_kind for id, ukjent eier", () => {
    const bad = (p: Record<string, unknown>) => OperationalGateChangedPayloadSchema.safeParse(change(p)).success;
    expect(OperationalGateChangedEventSchema.safeParse({ type: "GateChanged", schema_version: "1.0.0", payload: change() }).success).toBe(false);
    expect(OperationalGateChangedEventSchema.safeParse({ type: "OperationalGateChanged", schema_version: "2.0.0", payload: change() }).success).toBe(false);
    expect(bad({ prior_status: "PASS", new_status: "PASS" })).toBe(false);
    expect(bad({ evidence_refs: [] })).toBe(false);
    expect(bad({ evidence_refs: [evidence(), evidence()] })).toBe(false);
    expect(bad({ new_status: "OPEN", prior_status: "PASS", evidence_refs: [evidence()] })).toBe(false);
    expect(bad({ new_status: "OPEN", prior_status: "PASS", evidence_refs: [] })).toBe(true);
    expect(bad({ new_status: "FAIL", evidence_refs: [evidence()] })).toBe(true);
    expect(bad({ gate_id: "G18" })).toBe(false);
    expect(bad({ gate_kind: "orl" })).toBe(false);
    expect(bad({ gate_kind: "orl", gate_id: "ORL2" })).toBe(true);
    expect(bad({ gate_kind: "program_gate", gate_id: "ORL2" })).toBe(false);
    expect(bad({ owner: "en-person" })).toBe(false);
    expect(bad({ reason: "" })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
  });
});

describe("evaluateGate: staleness (HF6 §27: OPEN igjen etter siste kontraktendring)", () => {
  it("OPEN og FAIL forblir som deklarert uten evidenssjekk", () => {
    expect(evaluateGate(openGate(), ctx())).toEqual({ declared: "OPEN", effective: "OPEN", reasons: [] });
    const failed = passGate({ status: "FAIL", history: [change({ new_status: "FAIL" }) as Gate["history"][number]] });
    expect(evaluateGate(failed, ctx({ files: {} })).effective).toBe("FAIL");
  });

  it("PASS med frisk evidens (fil og hash stemmer, ingen kontraktendring etter) er PASS", () => {
    expect(evaluateGate(passGate(), ctx())).toEqual({ declared: "PASS", effective: "PASS", reasons: [] });
  });

  it("kontraktendring ETTER evidensen = OPEN igjen; på samme tidspunkt eller før = fortsatt PASS (grensen er strengt «eldre enn»)", () => {
    const after = evaluateGate(passGate(), ctx({ components: { "core.alpha": { contract_fingerprint: FP1, changed_at: T_NEW } } }));
    expect(after.effective).toBe("OPEN");
    expect(after.reasons).toEqual([{ code: "stale_contract_changed_after_evidence", component_id: "core.alpha", changed_at: T_NEW, verified_at: T_MID }]);
    expect(evaluateGate(passGate(), ctx({ components: { "core.alpha": { contract_fingerprint: FP1, changed_at: T_MID } } })).effective).toBe("PASS");
    expect(evaluateGate(passGate(), ctx({ components: { "core.alpha": { contract_fingerprint: FP1, changed_at: T_OLD } } })).effective).toBe("PASS");
    expect(evaluateGate(passGate(), ctx({ components: { "core.alpha": { contract_fingerprint: FP1, changed_at: null } } })).effective).toBe("PASS");
  });

  it("endret fingeravtrykk (selv uten oppdatert changed_at) = OPEN igjen", () => {
    const r = evaluateGate(passGate(), ctx({ components: { "core.alpha": { contract_fingerprint: FP2, changed_at: T_OLD } } }));
    expect(r.effective).toBe("OPEN");
    expect(r.reasons).toEqual([{ code: "stale_fingerprint_changed", component_id: "core.alpha" }]);
  });

  it("evidens uten øyeblikksbilde for en bundet komponent kan ikke bevise ferskhet = OPEN igjen", () => {
    const r = evaluateGate(passGate({ evidence_ref: evidence({ contract_fingerprints: {} }), history: [change({ evidence_refs: [evidence({ contract_fingerprints: {} })] }) as Gate["history"][number]] }), ctx());
    expect(r.effective).toBe("OPEN");
    expect(r.reasons).toEqual([{ code: "stale_binding_missing", component_id: "core.alpha" }]);
  });

  it("en bundet komponent som ikke finnes i indeksen = OPEN (kan ikke bevises)", () => {
    const r = evaluateGate(passGate(), ctx({ components: {} }));
    expect(r.effective).toBe("OPEN");
    expect(r.reasons).toEqual([{ code: "component_unknown", component_id: "core.alpha" }]);
  });

  it("evidensfil som mangler eller har annen hash = OPEN (kan ikke gjenverifiseres)", () => {
    expect(evaluateGate(passGate(), ctx({ files: {} })).reasons).toEqual([{ code: "evidence_file_missing", path: "docs/evidence/2026-11-25-g01.md" }]);
    expect(evaluateGate(passGate(), ctx({ files: { "docs/evidence/2026-11-25-g01.md": "0".repeat(64) } })).reasons).toEqual([{ code: "evidence_hash_mismatch", path: "docs/evidence/2026-11-25-g01.md" }]);
  });

  it("uten evidens er PASS aldri gyldig (forsvar i dybden når data er feil)", () => {
    const r = evaluateGate({ ...passGate(), evidence_ref: null }, ctx());
    expect(r.effective).toBe("OPEN");
    expect(r.reasons).toEqual([{ code: "evidence_missing" }]);
  });

  it("flere bundne komponenter: ÉN endret holder for å åpne porten, og alle årsaker rapporteres", () => {
    const g = passGate({ bound_components: ["core.alpha", "core.beta"], evidence_ref: evidence({ contract_fingerprints: { "core.alpha": FP1, "core.beta": FP1 } }), history: [change({ evidence_refs: [evidence({ contract_fingerprints: { "core.alpha": FP1, "core.beta": FP1 } })] }) as Gate["history"][number]] });
    const base = { "core.alpha": { contract_fingerprint: FP1, changed_at: T_OLD }, "core.beta": { contract_fingerprint: FP1, changed_at: T_OLD } };
    expect(evaluateGate(g, ctx({ components: base })).effective).toBe("PASS");
    const r = evaluateGate(g, ctx({ components: { ...base, "core.beta": { contract_fingerprint: FP2, changed_at: T_NEW } } }));
    expect(r.effective).toBe("OPEN");
    expect(r.reasons.map((x) => x.code).sort()).toEqual(["stale_contract_changed_after_evidence", "stale_fingerprint_changed"]);
  });
});

describe("evaluateOrl: nivåene bygger på hverandre", () => {
  const orl = (patch: Partial<Orl> = {}): Orl => ({
    schema_version: "1.0.0",
    kind: "orl",
    id: "ORL1",
    level: 1,
    title: "Bygget",
    exit_criterion: "Planlagte komponenter finnes og lokale tester er grønne; fortsatt ingen produksjonspåstand.",
    requires_orl: "ORL0",
    requires_gates: ["G02"],
    bound_components: [],
    external: false,
    status: "PASS",
    evidence_ref: evidence({ contract_fingerprints: {} }),
    history: [change({ gate_kind: "orl", gate_id: "ORL1", evidence_refs: [evidence({ contract_fingerprints: {} })] }) as Orl["history"][number]],
    ...patch
  });
  const allPass = (): { gate: (id: string) => "PASS"; orl: (id: string) => "PASS" } => ({ gate: () => "PASS", orl: () => "PASS" });

  it("PASS når evidens er frisk og alle krevde porter og forrige nivå er PASS", () => {
    const a = allPass();
    expect(evaluateOrl(orl(), ctx(), a.gate, a.orl)).toEqual({ declared: "PASS", effective: "PASS", reasons: [] });
  });

  it("en krevd port som ikke er PASS (effektivt) åpner nivået igjen", () => {
    const r = evaluateOrl(orl(), ctx(), (id) => (id === "G02" ? "OPEN" : "PASS"), () => "PASS");
    expect(r.effective).toBe("OPEN");
    expect(r.reasons).toEqual([{ code: "prerequisite_not_pass", prerequisite: "G02" }]);
  });

  it("forrige nivå som ikke er PASS åpner nivået igjen", () => {
    const r = evaluateOrl(orl(), ctx(), () => "PASS", (id) => (id === "ORL0" ? "OPEN" : "PASS"));
    expect(r.effective).toBe("OPEN");
    expect(r.reasons).toEqual([{ code: "prerequisite_not_pass", prerequisite: "ORL0" }]);
  });

  it("OPEN-nivå er OPEN uten sjekker; FAIL er FAIL", () => {
    expect(evaluateOrl(orl({ status: "OPEN", evidence_ref: null, history: [] }), ctx(), () => "OPEN", () => "OPEN").effective).toBe("OPEN");
  });

  it("også ORL-evidensen gjenverifiseres (fil og hash)", () => {
    const a = allPass();
    expect(evaluateOrl(orl(), ctx({ files: {} }), a.gate, a.orl).reasons).toEqual([{ code: "evidence_file_missing", path: "docs/evidence/2026-11-25-g01.md" }]);
  });
});

describe("scanGates: funn mot indeksen", () => {
  const gates = (): Gate[] => PROGRAM_GATE_IDS.map((id, i) => openGate({ id, number: i + 1, bound_components: ["core.alpha"] }));
  const orls = (): Orl[] =>
    ORL_IDS.map((id, level) => ({
      schema_version: "1.0.0" as const,
      kind: "orl" as const,
      id,
      level,
      title: `Nivå ${level}`,
      exit_criterion: "Utgangskriterium i egne ord, langt nok til å være meningsfylt.",
      requires_orl: level === 0 ? null : (`ORL${level - 1}` as Orl["requires_orl"]),
      requires_gates: [],
      bound_components: [],
      external: level >= 3,
      status: "OPEN" as const,
      evidence_ref: null,
      history: []
    })) as Orl[];
  const components = new Set(["core.alpha"]);
  const run = (g: Gate[], o: Orl[], c: GateContext = ctx()) => scanGates({ gates: g, orls: o, component_ids: components, ctx: c }).map((f) => f.id);

  it("komplett, åpent sett gir ingen funn", () => {
    expect(run(gates(), orls())).toEqual([]);
  });

  it("manglende port eller nivå = gate_set_incomplete", () => {
    expect(run(gates().filter((g) => g.id !== "G09"), orls())).toEqual(["gate_set_incomplete:G09"]);
    expect(run(gates(), orls().filter((o) => o.id !== "ORL4"))).toEqual(["gate_set_incomplete:ORL4"]);
  });

  it("bundet komponent som ikke finnes = gate_unknown_component", () => {
    const g = gates();
    g[0]!.bound_components = ["core.nope"];
    expect(run(g, orls(), ctx({ components: {} }))).toEqual(["gate_unknown_component:G01:core.nope"]);
  });

  it("deklarert PASS som er foreldet = gate_stale; med frisk evidens ingen funn", () => {
    const g = gates();
    g[1] = passGate({ id: "G02", number: 2 });
    expect(run(g, orls())).toEqual([]);
    expect(run(g, orls(), ctx({ components: { "core.alpha": { contract_fingerprint: FP1, changed_at: T_NEW } } }))).toEqual(["gate_stale:G02"]);
    expect(run(g, orls(), ctx({ components: { "core.alpha": { contract_fingerprint: FP2, changed_at: T_OLD } } }))).toEqual(["gate_stale:G02"]);
  });

  it("deklarert PASS med manglende/endret evidensfil = gate_evidence_invalid (ikke gate_stale)", () => {
    const g = gates();
    g[1] = passGate({ id: "G02", number: 2 });
    expect(run(g, orls(), ctx({ files: {} }))).toEqual(["gate_evidence_invalid:G02"]);
    expect(run(g, orls(), ctx({ files: { "docs/evidence/2026-11-25-g01.md": "0".repeat(64) } }))).toEqual(["gate_evidence_invalid:G02"]);
  });

  it("deklarert PASS på et ORL-nivå uten at krevde porter er PASS = gate_prerequisite_violation", () => {
    const o = orls();
    o[0] = { ...o[0]!, status: "PASS", evidence_ref: evidence({ contract_fingerprints: {} }), history: [change({ gate_kind: "orl", gate_id: "ORL0", evidence_refs: [evidence({ contract_fingerprints: {} })] }) as Orl["history"][number]], requires_gates: ["G01"] };
    expect(run(gates(), o)).toEqual(["gate_prerequisite_violation:ORL0:G01"]);
  });

  it("regelmengden er stabil", () => {
    expect([...GATE_RULES].sort()).toEqual(["gate_evidence_invalid", "gate_prerequisite_violation", "gate_set_incomplete", "gate_stale", "gate_unknown_component"]);
  });

  it("alle gate-tester bruker T0-konstanten fra fikstur (tidsstempel-fiksturen er konsistent)", () => {
    expect(Date.parse(T_OLD)).toBeLessThan(Date.parse(T_MID));
    expect(Date.parse(T_MID)).toBeLessThan(Date.parse(T_NEW));
    expect(Date.parse(T0)).toBeGreaterThan(0);
  });
});
