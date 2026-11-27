/* eslint-disable @typescript-eslint/no-explicit-any -- mutasjonshjelperne endrer ett felt om gangen i en dyp JSON-kopi; å typet hver sti ville bare duplisert skjemaene. */
import { describe, expect, it } from "vitest";
import { BaselineSchema, ComponentShardSchema, EvidenceRefSchema, ManifestSchema, type ComponentShard } from "../src/program/schema.ts";
import { manifest, planned, shard, T0 } from "./program-index-fixtures.ts";

/**
 * WP-PGA / PG1: skjemaene for programindeksen (HF6 §24.3). Hvert felt og hver kryssfeltregel har et negativt tilfelle: skjemaet er første forsvarslinje mot en skjerv som sier mer enn den kan bevise.
 */
const ok = (v: unknown) => ComponentShardSchema.safeParse(v).success;
const issues = (v: unknown): string[] => {
  const r = ComponentShardSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};
const mut = (base: ComponentShard, patch: (c: Record<string, any>) => void): unknown => {
  const copy = JSON.parse(JSON.stringify(base)) as Record<string, any>;
  patch(copy);
  return copy;
};
const EVIDENCE = { path: "docs/evidence/2026-11-26-x.md", sha256: "a".repeat(64), git_sha: "b".repeat(40), recorded_at: T0, verified_at: T0, verified_at_source: "evidence_header", contract_fingerprints: { "core.x": `sha256:${"c".repeat(64)}` } };

describe("ComponentShardSchema: gyldige skjerver", () => {
  it("en bygd og en planlagt komponent er gyldige", () => {
    expect(issues(shard("core.alpha"))).toEqual([]);
    expect(issues(planned("ci.beta"))).toEqual([]);
  });

  it("en bygd komponent med tabeller, migrasjoner, tjenester, hendelser, avhengigheter, kontraktfiler og venteliste er gyldig", () => {
    const full = shard("core.alpha", {
      contract: { version: "1.2.3", schema_version: "0.4.0", files: ["packages/contracts/src/a.ts"], fingerprint: `sha256:${"d".repeat(64)}`, changed_at: T0 },
      state_store: { tables: ["t_a"], planned_tables: ["t_future"], runtime_tables: ["schema_x"], migrations: ["001_a.sql"], services: ["svc"], files: ["config/x.json"] },
      events_out: [{ type: "ThingHappened", schema_version: "1.0.0", status: "active", idempotency: "key per thing", contract_ref: "modules/alpha/src/e.ts" }],
      events_in: [{ type: "OtherThing" }],
      dependencies: [{ component_id: "core.beta", min: "0.1.0", max: "0.x" }]
    });
    full.pending_work = [{ wp: "WP-S1", note: "Pågående arbeid uten antatte detaljer.", reserved_migrations: ["149", "150"] }];
    expect(issues(full)).toEqual([]);
  });
});

describe("ComponentShardSchema: strenghet", () => {
  it("ukjente felt avvises på alle nivåer", () => {
    const base = shard("core.alpha");
    expect(ok(mut(base, (c) => (c["extra"] = 1)))).toBe(false);
    for (const key of ["contract", "state_store", "risk", "owner", "canonical_owner"]) expect(ok(mut(base, (c) => (c[key]["extra"] = 1))), key).toBe(false);
    const withLists = shard("core.alpha", { events_out: [{ type: "EvtA", schema_version: null, status: "planned", idempotency: null, contract_ref: null }], events_in: [{ type: "EvtB" }], dependencies: [{ component_id: "core.b", min: "0.1.0", max: "0.x" }] });
    withLists.pending_work = [{ wp: "WP-X", note: "venter", reserved_migrations: [] }];
    expect(ok(withLists)).toBe(true);
    expect(ok(mut(withLists, (c) => (c["events_out"][0]["extra"] = 1)))).toBe(false);
    expect(ok(mut(withLists, (c) => (c["events_in"][0]["extra"] = 1)))).toBe(false);
    expect(ok(mut(withLists, (c) => (c["dependencies"][0]["extra"] = 1)))).toBe(false);
    expect(ok(mut(withLists, (c) => (c["pending_work"][0]["extra"] = 1)))).toBe(false);
  });

  it.each(["schema_version", "component_id", "title", "summary", "kind", "canonical_owner", "runtime_state", "verification", "last_verified", "evidence_ref", "contract", "code_paths", "state_store", "events_out", "events_in", "dependencies", "risk", "owner", "pending_work", "notes"])("påkrevd felt %s kan ikke utelates", (key) => {
    expect(ok(mut(shard("core.alpha"), (c) => delete c[key]))).toBe(false);
  });

  it("skjemaversjonen er nøyaktig 1.0.0", () => {
    expect(ok(mut(shard("core.alpha"), (c) => (c["schema_version"] = "1.0.1")))).toBe(false);
    expect(ok(mut(shard("core.alpha"), (c) => (c["schema_version"] = 1)))).toBe(false);
  });

  it("felt-formater: id, semver, fingeravtrykk, tidspunkt (Z kreves, ingen offset), stier, tabell-, migrasjons- og hendelsesnavn", () => {
    const base = shard("core.alpha");
    for (const bad of ["Core.alpha", "core", "core..a", "core.a b"]) expect(ok(mut(base, (c) => (c["component_id"] = bad))), bad).toBe(false);
    expect(ok(mut(base, (c) => (c["contract"]["version"] = "1.0")))).toBe(false);
    expect(ok(mut(base, (c) => (c["contract"]["changed_at"] = "2026-11-26T12:00:00+01:00")))).toBe(false);
    expect(ok(mut(base, (c) => (c["contract"]["changed_at"] = "2026-11-26")))).toBe(false);
    expect(ok(mut(base, (c) => (c["code_paths"] = ["../outside"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["code_paths"] = ["/abs"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["state_store"]["tables"] = ["Bad-Name"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["state_store"]["migrations"] = ["1_a.sql"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["events_out"] = [{ type: "x y", schema_version: null, status: "planned", idempotency: null, contract_ref: null }])))).toBe(false);
    expect(ok(mut(base, (c) => (c["canonical_owner"]["d_refs"] = ["D-xyz"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["canonical_owner"]["plan"] = "HF7")))).toBe(false);
    expect(ok(mut(base, (c) => (c["risk"]["data_sensitivity"] = "TOP_SECRET")))).toBe(false);
    expect(ok(mut(base, (c) => (c["risk"]["memory_spaces"] = ["work"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["risk"]["max_action_class"] = "E")))).toBe(false);
    expect(ok(mut(base, (c) => (c["risk"]["authority_domain"] = "everything")))).toBe(false);
    expect(ok(mut(base, (c) => (c["owner"]["role"] = "en-person")))).toBe(false);
    expect(ok(mut(base, (c) => (c["runtime_state"] = "running")))).toBe(false);
    expect(ok(mut(base, (c) => (c["verification"] = "DONE")))).toBe(false);
  });
});

describe("ComponentShardSchema: kryssfeltregler", () => {
  it("kind «planned» og runtime_state «planned» hører sammen (begge veier)", () => {
    expect(ok(mut(shard("core.alpha"), (c) => (c["kind"] = "planned")))).toBe(false);
    expect(ok(mut(planned("ci.beta"), (c) => (c["kind"] = "module")))).toBe(false);
  });

  it("en planlagt komponent har ingen kode, tabeller, tjenester, filer, migrasjoner, kontraktversjon, kontraktfiler eller tidspunkt", () => {
    const base = planned("ci.beta");
    expect(ok(mut(base, (c) => (c["code_paths"] = ["modules/x"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["state_store"]["tables"] = ["t"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["state_store"]["runtime_tables"] = ["t"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["state_store"]["migrations"] = ["001_a.sql"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["state_store"]["services"] = ["s"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["state_store"]["files"] = ["f.json"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["contract"]["version"] = "0.1.0")))).toBe(false);
    expect(ok(mut(base, (c) => (c["contract"]["files"] = ["a.ts"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["contract"]["changed_at"] = T0)))).toBe(false);
    expect(ok(mut(base, (c) => (c["contract"]["schema_version"] = "0.1.0")))).toBe(false);
    expect(ok(mut(base, (c) => (c["state_store"]["planned_tables"] = ["ci_future"])))).toBe(true);
  });

  it("en bygd komponent har minst én kodesti, en kontraktversjon og et endringstidspunkt", () => {
    const base = shard("core.alpha");
    expect(ok(mut(base, (c) => (c["code_paths"] = [])))).toBe(false);
    expect(ok(mut(base, (c) => (c["contract"]["version"] = null)))).toBe(false);
    expect(ok(mut(base, (c) => (c["contract"]["changed_at"] = null)))).toBe(false);
  });

  it("fingeravtrykk finnes hvis og bare hvis kontraktfiler finnes", () => {
    const fp = `sha256:${"e".repeat(64)}`;
    expect(ok(mut(shard("core.alpha"), (c) => (c["contract"]["files"] = ["a.ts"])))).toBe(false);
    expect(ok(mut(shard("core.alpha"), (c) => (c["contract"]["fingerprint"] = fp)))).toBe(false);
    expect(ok(mut(shard("core.alpha"), (c) => { c["contract"]["files"] = ["a.ts"]; c["contract"]["fingerprint"] = fp; }))).toBe(true);
  });

  it("schema_version finnes hvis og bare hvis komponenten eier tabeller (tabeller eller runtime-tabeller)", () => {
    expect(ok(mut(shard("core.alpha"), (c) => (c["state_store"]["tables"] = ["t"])))).toBe(false);
    expect(ok(mut(shard("core.alpha"), (c) => { c["state_store"]["tables"] = ["t"]; c["contract"]["schema_version"] = "0.1.0"; }))).toBe(true);
    expect(ok(mut(shard("core.alpha"), (c) => { c["state_store"]["runtime_tables"] = ["t"]; c["contract"]["schema_version"] = "0.1.0"; }))).toBe(true);
    expect(ok(mut(shard("core.alpha"), (c) => (c["contract"]["schema_version"] = "0.1.0")))).toBe(false);
  });

  it("VERIFIED krever evidence_ref og last_verified; en evidence_ref krever last_verified", () => {
    const base = shard("core.alpha");
    expect(ok(mut(base, (c) => (c["verification"] = "VERIFIED")))).toBe(false);
    expect(ok(mut(base, (c) => { c["verification"] = "VERIFIED"; c["last_verified"] = T0; }))).toBe(false);
    expect(ok(mut(base, (c) => { c["verification"] = "VERIFIED"; c["evidence_ref"] = EVIDENCE; }))).toBe(false);
    expect(ok(mut(base, (c) => { c["verification"] = "VERIFIED"; c["evidence_ref"] = EVIDENCE; c["last_verified"] = T0; }))).toBe(true);
    expect(ok(mut(base, (c) => (c["evidence_ref"] = EVIDENCE)))).toBe(false);
    expect(ok(mut(base, (c) => (c["last_verified"] = T0)))).toBe(true);
  });

  it("duplikater avvises i hver liste (kodestier, kontraktfiler, tabeller, migrasjoner, tjenester, hendelser, avhengigheter, d_refs)", () => {
    const base = shard("core.alpha");
    expect(ok(mut(base, (c) => (c["code_paths"] = ["modules/a", "modules/a"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["state_store"]["tables"] = ["t", "t"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["state_store"]["services"] = ["s", "s"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["state_store"]["migrations"] = ["001_a.sql", "001_a.sql"])))).toBe(false);
    expect(ok(mut(base, (c) => (c["canonical_owner"]["d_refs"] = ["D-1", "D-1"])))).toBe(false);
    const ev = { type: "EvtA", schema_version: null, status: "planned", idempotency: null, contract_ref: null };
    expect(ok(mut(base, (c) => (c["events_out"] = [ev, ev])))).toBe(false);
    expect(ok(mut(base, (c) => (c["events_in"] = [{ type: "EvtA" }, { type: "EvtA" }])))).toBe(false);
    const dep = { component_id: "core.b", min: "0.1.0", max: "0.x" };
    expect(ok(mut(base, (c) => (c["dependencies"] = [dep, dep])))).toBe(false);
    expect(ok(mut(base, (c) => { c["contract"]["files"] = ["a.ts", "a.ts"]; c["contract"]["fingerprint"] = `sha256:${"e".repeat(64)}`; }))).toBe(false);
  });

  it("tabell-, planlagt- og runtime-tabell-listene er disjunkte", () => {
    expect(ok(mut(shard("core.alpha"), (c) => { c["state_store"]["tables"] = ["t"]; c["state_store"]["planned_tables"] = ["t"]; c["contract"]["schema_version"] = "0.1.0"; }))).toBe(false);
    expect(ok(mut(shard("core.alpha"), (c) => { c["state_store"]["tables"] = ["t"]; c["state_store"]["runtime_tables"] = ["t"]; c["contract"]["schema_version"] = "0.1.0"; }))).toBe(false);
    expect(ok(mut(shard("core.alpha"), (c) => { c["state_store"]["planned_tables"] = ["t"]; c["state_store"]["runtime_tables"] = ["t"]; c["contract"]["schema_version"] = "0.1.0"; }))).toBe(false);
  });

  it("en komponent kan ikke avhenge av seg selv, og avhengighetsintervallet må være gyldig", () => {
    expect(ok(mut(shard("core.alpha"), (c) => (c["dependencies"] = [{ component_id: "core.alpha", min: "0.1.0", max: "0.x" }])))).toBe(false);
    expect(ok(mut(shard("core.alpha"), (c) => (c["dependencies"] = [{ component_id: "core.b", min: "1.0.0", max: "0.x" }])))).toBe(false);
    expect(ok(mut(shard("core.alpha"), (c) => (c["dependencies"] = [{ component_id: "core.b", min: "1", max: "2.x" }])))).toBe(false);
    expect(ok(mut(shard("core.alpha"), (c) => (c["dependencies"] = [{ component_id: "core.b", min: "0.1.0", max: "^1" }])))).toBe(false);
  });

  it("hendelseserklæring: planlagt har ingen kontraktreferanse eller skjemaversjon; contract_only/active har begge", () => {
    const base = shard("core.alpha");
    const ev = (patch: Record<string, unknown>) => mut(base, (c) => (c["events_out"] = [{ type: "EvtA", schema_version: null, status: "planned", idempotency: null, contract_ref: null, ...patch }]));
    expect(ok(ev({}))).toBe(true);
    expect(ok(ev({ contract_ref: "a/b.ts" }))).toBe(false);
    expect(ok(ev({ schema_version: "1.0.0" }))).toBe(false);
    expect(ok(ev({ status: "contract_only", schema_version: "1.0.0", contract_ref: "a/b.ts" }))).toBe(true);
    expect(ok(ev({ status: "contract_only", schema_version: "1.0.0" }))).toBe(false);
    expect(ok(ev({ status: "active", contract_ref: "a/b.ts" }))).toBe(false);
    expect(ok(ev({ status: "active", schema_version: "1.0.0", contract_ref: "a/b.ts" }))).toBe(true);
    expect(ok(ev({ status: "shipped" }))).toBe(false);
  });

  it("ventende arbeid: reserverte migrasjonsnumre er tresifret", () => {
    const base = shard("core.alpha");
    const wp = (nums: string[]) => mut(base, (c) => (c["pending_work"] = [{ wp: "WP-S1", note: "venter", reserved_migrations: nums }]));
    expect(ok(wp(["149", "150"]))).toBe(true);
    expect(ok(wp(["49"]))).toBe(false);
    expect(ok(wp(["1490"]))).toBe(false);
    expect(ok(wp(["149", "149"]))).toBe(false);
  });
});

describe("EvidenceRefSchema", () => {
  it("gyldig referanse: sti under docs/evidence, hash, git-sha, tidspunkter og fingeravtrykk-snapshot", () => {
    expect(EvidenceRefSchema.safeParse(EVIDENCE).success).toBe(true);
  });

  it("avviser sti utenfor docs/evidence, undermapper, annen filtype, ugyldig hash/sha og verified_at etter recorded_at", () => {
    const bad = (patch: Record<string, unknown>) => EvidenceRefSchema.safeParse({ ...EVIDENCE, ...patch }).success;
    expect(bad({ path: "docs/x.md" })).toBe(false);
    expect(bad({ path: "docs/evidence/sub/x.md" })).toBe(false);
    expect(bad({ path: "docs/evidence/x.txt" })).toBe(false);
    expect(bad({ path: "docs/evidence/../x.md" })).toBe(false);
    expect(bad({ sha256: "a".repeat(63) })).toBe(false);
    expect(bad({ git_sha: "b".repeat(39) })).toBe(false);
    expect(bad({ verified_at: "2026-11-26T12:00:01.000Z" })).toBe(false);
    expect(bad({ verified_at_source: "guess" })).toBe(false);
    expect(bad({ contract_fingerprints: { "Bad Id": null } })).toBe(false);
    expect(bad({ contract_fingerprints: { "core.x": "sha256:short" } })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
    expect(bad({ contract_fingerprints: { "core.x": null } })).toBe(true);
  });
});

describe("ManifestSchema", () => {
  const m = () => JSON.parse(JSON.stringify(manifest())) as Record<string, any>;
  const mok = (v: unknown) => ManifestSchema.safeParse(v).success;

  it("gyldig manifest", () => {
    expect(ManifestSchema.safeParse(manifest()).success).toBe(true);
  });

  it("modus må være report eller enforce; ukjente felt avvises", () => {
    const bad = m();
    bad["guard"]["mode"] = "warn";
    expect(mok(bad)).toBe(false);
    const extra = m();
    extra["extra"] = 1;
    expect(mok(extra)).toBe(false);
    const nested = m();
    nested["guard"]["extra"] = 1;
    expect(mok(nested)).toBe(false);
  });

  it("en plan kan bare stå ACTIVE med en navngitt beslutning i loggen (D-nnn), ikke et dokument (fiks 1, M5/D7: tidligere godtok et vilkårlig eksisterende dokument)", () => {
    const a = m();
    a["plans"][0]["status"] = "ACTIVE";
    expect(mok(a)).toBe(false);
    a["plans"][0]["decision_ref"] = "docs/remediation/ADR-001-dokumenthierarki.md";
    expect(mok(a)).toBe(false);
    a["plans"][0]["decision_ref"] = "D-500";
    expect(mok(a)).toBe(true);
  });

  it("planstatus og versjonsformat valideres", () => {
    const a = m();
    a["plans"][0]["status"] = "ADOPTED";
    expect(mok(a)).toBe(false);
    const b = m();
    b["plans"][0]["version"] = "4.0";
    expect(mok(b)).toBe(false);
    const c = m();
    c["plans"][0]["plan"] = "HF9";
    expect(mok(c)).toBe(false);
  });

  it("regex-mønstre i reglene må kunne kompileres, og tomme/lange mønstre avvises", () => {
    const a = m();
    a["exclusive_names"][0]["pattern"] = "(unclosed";
    expect(mok(a)).toBe(false);
    const b = m();
    b["exclusive_names"][0]["allowed_owner_patterns"] = ["["];
    expect(mok(b)).toBe(false);
    const c = m();
    c["reserved_prefixes"][0]["owner_patterns"] = [];
    expect(mok(c)).toBe(false);
    const d = m();
    d["no_active_state"]["forbidden_literal_pattern"] = "a".repeat(250);
    expect(mok(d)).toBe(false);
    const e = m();
    e["exclusive_names"][0]["pattern"] = "";
    expect(mok(e)).toBe(false);
  });

  it("dekningsstier må være gyldige repo-stier", () => {
    const a = m();
    a["coverage"]["migrations_dir"] = "../x";
    expect(mok(a)).toBe(false);
    const b = m();
    b["coverage"]["workspace_roots"] = [];
    expect(mok(b)).toBe(false);
  });
});

describe("BaselineSchema", () => {
  const entry = { id: "table_orphan:some_table", reason: "Kjent brudd som venter på en eierbeslutning.", since: "2026-11-26", decision_ref: null };
  it("gyldig (også tom) baseline", () => {
    expect(BaselineSchema.safeParse({ schema_version: "1.0.0", entries: [] }).success).toBe(true);
    expect(BaselineSchema.safeParse({ schema_version: "1.0.0", entries: [entry] }).success).toBe(true);
  });

  it("avviser duplikate id-er, ugyldig id-format, kort begrunnelse, ugyldig dato og ukjente felt", () => {
    const b = (entries: unknown[]) => BaselineSchema.safeParse({ schema_version: "1.0.0", entries }).success;
    expect(b([entry, entry])).toBe(false);
    expect(b([{ ...entry, id: "ingenkolon" }])).toBe(false);
    expect(b([{ ...entry, id: "Table_Orphan:x" }])).toBe(false);
    expect(b([{ ...entry, reason: "kort" }])).toBe(false);
    expect(b([{ ...entry, since: "26.11.2026" }])).toBe(false);
    expect(b([{ ...entry, since: "2026-13-40" }])).toBe(false);
    expect(b([{ ...entry, extra: 1 }])).toBe(false);
    expect(b([{ ...entry, decision_ref: "D-497" }])).toBe(true);
    expect(b([{ ...entry, decision_ref: "bad" }])).toBe(false);
  });
});
