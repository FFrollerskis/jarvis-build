import { describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import {
  createClassCPipeline,
  driveCreateFileAdapter,
  driveMoveAdapter,
  driveRenameAdapter,
  driveTrashAdapter,
  driveUpdateContentAdapter,
  githubCreatePrAdapter,
  type ClassCAdapter,
  type ClassCMutation,
  type ClassCRun
} from "@jarvis/tool-gateway";
import { ScriptedTransport } from "./support/class-c-baseline-harness.ts";

/**
 * WP-AUTH2a (K3): adapterne uten database og uten nettverk, mot skriptede lesninger i den formen de EKSISTERENDE lesehandlingene faktisk returnerer. Dekker kantene som e2e-testene ikke naturlig treffer:
 * feilformede leverandørsvar (fail-lukket), uventet tilstand etter handlingen og de rene valideringsreglene.
 */
const META = (over: Record<string, JsonValue> = {}): { data: JsonValue } => ({ data: { id: "f1", name: "rapport.txt", mimeType: "text/plain", trashed: false, parents: ["p1"], headRevisionId: "rev-1", modifiedTime: "2026-01-01T00:00:00.000Z", ...over } });
const FOLDER = (over: Record<string, JsonValue> = {}): { data: JsonValue } => META({ id: "d1", name: "Mappe", mimeType: "application/vnd.google-apps.folder", parents: [], headRevisionId: null, ...over });
const BRANCH = (sha: string | null): { data: JsonValue } => ({ data: sha === null ? { name: "x" } : { name: "x", sha, protected: false } });
const PR = (over: Record<string, JsonValue> = {}): JsonValue => ({ number: 7, title: "Endring", state: "open", draft: false, head_ref: "feature/x", head_sha: "s1", base_ref: "main", html_url: "https://example.invalid/pr/7", merged: false, mergeable: null, mergeable_state: null, ...over });

function begin(adapter: ClassCAdapter): ClassCRun {
  const [toolId, action] = adapter.key.split(".") as [string, string];
  const run = createClassCPipeline({ mode: "enforce", adapters: [adapter] }).begin({ tool_id: toolId, action, capability_class: "C" }, { isRegistered: () => true });
  if (run === null) throw new Error("ingen kjøring");
  return run;
}

async function drive(adapter: ClassCAdapter, params: Record<string, JsonValue>, script: ConstructorParameters<typeof ScriptedTransport>[1], mutation: ClassCMutation): Promise<{ block: string | null; reason: string | null; audit: Record<string, JsonValue> }> {
  const t = new ScriptedTransport("t", script);
  const run = begin(adapter);
  const pre = await run.preflight(params, (a, p) => t.invoke(a, p), { replay: false });
  if (pre.block !== null) return { block: pre.block, reason: null, audit: run.auditBlock() };
  const post = await run.verify(params, mutation, (a, p) => t.invoke(a, p));
  return { block: null, reason: post.postconditionReason, audit: run.auditBlock() };
}

const GH = { repo: "owner/repo", branch: "feature/x", title: "Endring", base: "main" };

describe("github.create_pr: rene regler", () => {
  it("validate: alle avvikene har sin kode, og et gyldig kall er null", () => {
    const v = (over: Record<string, JsonValue>) => githubCreatePrAdapter.validate({ ...GH, ...over });
    expect(v({})).toBeNull();
    expect(v({ repo: "owner" })).toBe("repo_invalid");
    expect(v({ repo: "-owner/repo" })).toBe("repo_invalid");
    expect(v({ branch: "" })).toBe("branch_invalid");
    expect(v({ branch: "a b" })).toBe("branch_invalid");
    expect(v({ branch: "a".repeat(256) })).toBe("branch_invalid");
    expect(v({ branch: "tab\there" })).toBe("branch_invalid");
    expect(v({ branch: `del${String.fromCharCode(127)}x` })).toBe("branch_invalid");
    expect(v({ base: "" })).toBeNull(); // tom base = standard main (som transporten)
    expect(v({ base: "x y" })).toBe("base_invalid");
    expect(v({ branch: "main" })).toBe("head_equals_base");
    expect(v({ base: "feature/x" })).toBe("head_equals_base");
    expect(v({ title: "" })).toBe("title_missing");
    expect(v({ title: " \n " })).toBe("title_missing");
    expect(githubCreatePrAdapter.validate({ repo: "owner/repo", branch: "main", title: "t" })).toBe("head_equals_base"); // utelatt base er main
    expect(githubCreatePrAdapter.validate({ repo: "owner/repo", branch: "master", title: "t" })).toBeNull(); // og master er ikke main
  });

  it("preflight: grener uten sha er ulesbare (fail-lukket) - head og base hver for seg; lik sha er kun en advarsel", async () => {
    const mutation: ClassCMutation = { external_id: "7", data: { created: true } };
    expect((await drive(githubCreatePrAdapter, GH, { get_branch: [BRANCH(null), BRANCH("s2")], list_pull_requests: [{ data: { pull_requests: [] } }] }, mutation)).block).toBe("class_c_preflight_invalid:head_branch_unreadable");
    expect((await drive(githubCreatePrAdapter, GH, { get_branch: [BRANCH("s1"), BRANCH(null)], list_pull_requests: [{ data: { pull_requests: [] } }] }, mutation)).block).toBe("class_c_preflight_invalid:base_branch_unreadable");
    const same = await drive(githubCreatePrAdapter, GH, { get_branch: [BRANCH("s1"), BRANCH("s1")], list_pull_requests: [{ data: { pull_requests: [] } }], get_pull_request: [{ external_id: "7", data: PR() }] }, mutation);
    expect(same.block).toBeNull();
    expect(same.audit["preflight"]).toMatchObject({ warnings: ["head_equals_base_sha"] });
  });

  it("etterkontroll: hver avvikende PR-egenskap er et brudd (nummer, åpen, head, base, merget, og tittel kun for en opprettet PR - blanke normaliseres)", async () => {
    const base = { get_branch: [BRANCH("s1"), BRANCH("s2")], list_pull_requests: [{ data: { pull_requests: [] } }] };
    const run = async (pr: JsonValue, created: boolean) => drive(githubCreatePrAdapter, GH, { ...base, get_pull_request: [{ external_id: "7", data: pr }] }, { external_id: "7", data: { created } });
    expect((await run(PR(), true)).reason).toBeNull();
    expect((await run(PR({ title: "  Endring  " }), true)).reason).toBeNull(); // leverandøren trimmer: ikke et brudd
    expect((await run(PR({ title: "En\n  annen" }), true)).reason).toBe("postcondition_mismatch");
    expect((await run(PR({ title: "En annen" }), false)).reason).toBeNull(); // idempotent treff: eksisterende tittel
    for (const [over, path] of [[{ number: 8 }, "pr.number"], [{ state: "closed" }, "pr.state"], [{ head_ref: "annen" }, "pr.head_ref"], [{ base_ref: "annen" }, "pr.base_ref"], [{ merged: true }, "pr.merged"]] as const) {
      const out = await run(PR(over), true);
      expect(out.reason, path).toBe("postcondition_mismatch");
      expect((out.audit["violations"] as Array<{ path: string }>).map((x) => x.path), path).toContain(path);
    }
  });

  it("etterkontroll uten gyldig PR-nummer kan ikke leses tilbake (unverified), og et ulesbart PR-svar er predicate_error", async () => {
    const base = { get_branch: [BRANCH("s1"), BRANCH("s2")], list_pull_requests: [{ data: { pull_requests: [] } }] };
    for (const external_id of [null, "", "abc", "7a", "12345678901", "-1", "1.5"]) {
      expect((await drive(githubCreatePrAdapter, GH, base, { external_id, data: { created: true } })).reason, String(external_id)).toBe("postcondition_unverified:class_c_no_readback");
    }
    expect((await drive(githubCreatePrAdapter, GH, { ...base, get_pull_request: [{ data: null }] }, { external_id: "7", data: { created: true } })).reason).toBe("postcondition_unverified:predicate_error");
  });

  it("rollback: opprettet = lukk PR-en; idempotent treff = none; uklart = manuell (aldri en kompenserende handling basert på gjetting)", () => {
    const b = { state: {}, context: {} };
    expect(githubCreatePrAdapter.rollback(GH, { external_id: "7", data: { created: true } }, b, null)).toMatchObject({ kind: "compensating_action", steps: [{ tool_id: "github", action: "update_pr", parameters: { repo: "owner/repo", pr_number: "7", state: "closed" } }] });
    expect(githubCreatePrAdapter.rollback(GH, { external_id: "7", data: { created: false } }, b, null)).toMatchObject({ kind: "none", steps: [] });
    expect(githubCreatePrAdapter.rollback(GH, { external_id: "7", data: {} }, b, null)).toMatchObject({ kind: "manual", steps: [] });
    expect(githubCreatePrAdapter.rollback(GH, { external_id: null, data: { created: true } }, b, null)).toMatchObject({ kind: "manual", steps: [] });
  });
});

describe("drive.*: feilformede metadata er ulesbare (fail-lukket), ikke et stille bestått", () => {
  const malformed: Array<[string, JsonValue]> = [
    ["uten trashed", { id: "f1", name: "x", mimeType: "text/plain", parents: [] }],
    ["trashed som streng", { id: "f1", name: "x", mimeType: "text/plain", trashed: "false", parents: [] }],
    ["uten parents", { id: "f1", name: "x", mimeType: "text/plain", trashed: false }],
    ["parents med ikke-streng", { id: "f1", name: "x", mimeType: "text/plain", trashed: false, parents: [1] }],
    ["uten id", { name: "x", mimeType: "text/plain", trashed: false, parents: [] }],
    ["uten name", { id: "f1", mimeType: "text/plain", trashed: false, parents: [] }],
    ["ikke et objekt", ["x"]]
  ];
  for (const adapter of [driveRenameAdapter, driveTrashAdapter, driveUpdateContentAdapter]) {
    it(`${adapter.key}: alle feilformer blokkerer i enforce (snapshot kaster før dommen) og dommen selv er også lukket`, async () => {
      const params: Record<string, JsonValue> = { file_id: "f1", new_name: "y", content: "z" };
      for (const [label, data] of malformed) {
        const out = await drive(adapter, params, { get_metadata: [{ data }] }, { external_id: "f1", data: {} });
        // pipelinen tar før-snapshot FØR dommen; adapterens snapshot kaster på en ulesbar form, og det er en blokkering (aldri et stille bestått)
        expect(out.block, label).toBe("class_c_preflight_failed:adapter_error:class_c_drive_metadata_unreada");
        // forsvar i dybden: også adapterens egen dom (kalt direkte) avviser den samme formen
        expect(adapter.before.judge(params, { file: { ok: true, data, external_id: null } }), label).toEqual({ block: "metadata_unreadable" });
      }
      // en lesing som feilet er også ulesbar for dommen
      expect(adapter.before.judge(params, { file: { ok: false, error: "x", timed_out: false, not_found: false } })).toEqual({ block: "metadata_unreadable" });
      expect(adapter.before.judge(params, {})).toEqual({ block: "metadata_unreadable" });
    });
  }
  it("drive.move: ulesbar destinasjon blokkerer, og en trashed destinasjon er kun en advarsel", async () => {
    const params = { file_id: "f1", new_parent_folder_id: "d1" };
    expect((await drive(driveMoveAdapter, params, { get_metadata: [META(), { data: malformed[0]![1] }] }, { external_id: "f1", data: {} })).block).toBe("class_c_preflight_invalid:destination_unreadable");
    const trashed = await drive(driveMoveAdapter, params, { get_metadata: [META(), FOLDER({ trashed: true }), META({ parents: ["d1"] })] }, { external_id: "f1", data: {} });
    expect(trashed.block).toBeNull();
    expect(trashed.audit["preflight"]).toMatchObject({ warnings: ["destination_trashed"] });
  });
});

describe("drive.create_file: etterkontrollen sjekker hver egenskap ved den opprettede filen", () => {
  const created = (over: Record<string, JsonValue> = {}) => ({ get_metadata: [{ data: { id: "n1", name: "ny.txt", mimeType: "text/plain", trashed: false, parents: ["d1"], headRevisionId: "r1", modifiedTime: null, ...over } as JsonValue }] });
  const mutation: ClassCMutation = { external_id: "n1", data: {} };
  const params = { name: "ny.txt" };
  it("riktig fil er verifisert; feil id, navn, papirkurv og (oppgitt) forelder er hvert for seg et brudd", async () => {
    expect((await drive(driveCreateFileAdapter, params, created(), mutation)).reason).toBeNull();
    for (const [over, path] of [[{ id: "annen" }, "file.id"], [{ name: "feil.txt" }, "file.name"], [{ trashed: true }, "file.trashed"]] as const) {
      const out = await drive(driveCreateFileAdapter, params, created(over), mutation);
      expect(out.reason, path).toBe("postcondition_mismatch");
      expect((out.audit["violations"] as Array<{ path: string }>).map((v) => v.path), path).toContain(path);
    }
    const withParent = { name: "ny.txt", parent_folder_id: "d1" };
    const t = { get_metadata: [FOLDER(), created().get_metadata[0]!] };
    expect((await drive(driveCreateFileAdapter, withParent, t, mutation)).reason).toBeNull();
    const wrong = { get_metadata: [FOLDER(), created({ parents: ["annen"] }).get_metadata[0]!] };
    const out = await drive(driveCreateFileAdapter, withParent, wrong, mutation);
    expect(out.reason).toBe("postcondition_mismatch");
    expect((out.audit["violations"] as Array<{ path: string }>).map((v) => v.path)).toContain("file.parents");
  });
  it("uten brukbar fil-id kan opprettelsen ikke leses tilbake; rollback er manuell uten id", async () => {
    for (const external_id of [null, "", "a/b"]) expect((await drive(driveCreateFileAdapter, params, created(), { external_id, data: {} })).reason, String(external_id)).toBe("postcondition_unverified:class_c_no_readback");
    expect(driveCreateFileAdapter.rollback(params, { external_id: null, data: null }, { state: {}, context: {} }, null)).toMatchObject({ kind: "manual" });
  });
});

describe("drive.update_content: revisjonen avgjør", () => {
  const params = { file_id: "f1", content: "nytt" };
  it("endret revisjon lik transportens svar = verifisert; samme revisjon eller en annen enn returnert = brudd; ingen revisjon = unobservable", async () => {
    const ok = await drive(driveUpdateContentAdapter, params, { get_metadata: [META({ headRevisionId: "r1" }), META({ headRevisionId: "r2" })] }, { external_id: "f1", data: { head_revision_id: "r2" } });
    expect(ok.reason).toBeNull();
    const same = await drive(driveUpdateContentAdapter, params, { get_metadata: [META({ headRevisionId: "r1" }), META({ headRevisionId: "r1" })] }, { external_id: "f1", data: { head_revision_id: "r1" } });
    expect(same.reason).toBe("postcondition_mismatch");
    expect((same.audit["violations"] as Array<{ rule: string }>)[0]?.rule).toBe("expected_changed");
    const other = await drive(driveUpdateContentAdapter, params, { get_metadata: [META({ headRevisionId: "r1" }), META({ headRevisionId: "r3" })] }, { external_id: "f1", data: { head_revision_id: "r2" } });
    expect(other.reason).toBe("postcondition_mismatch");
    expect((other.audit["violations"] as Array<{ rule: string; path: string }>).map((v) => v.rule)).toEqual(["expected_equals"]);
    const none = await drive(driveUpdateContentAdapter, params, { get_metadata: [META({ headRevisionId: null }), META({ headRevisionId: null })] }, { external_id: "f1", data: { head_revision_id: null } });
    expect(none.reason).toBe("postcondition_unverified:class_c_unobservable");
    // transporten oppgir ingen revisjon, men den leste revisjonen har endret seg: fortsatt verifisert (kun «endret»-kravet)
    const noReturn = await drive(driveUpdateContentAdapter, params, { get_metadata: [META({ headRevisionId: "r1" }), META({ headRevisionId: "r2" })] }, { external_id: "f1", data: {} });
    expect(noReturn.reason).toBeNull();
  });
  it("innhold må være en streng; navn/foreldre/papirkurv er uendret (ellers brudd)", async () => {
    expect(driveUpdateContentAdapter.validate({ file_id: "f1", content: 5 as never })).toBe("content_missing");
    const moved = await drive(driveUpdateContentAdapter, params, { get_metadata: [META({ headRevisionId: "r1" }), META({ headRevisionId: "r2", parents: ["annen"] })] }, { external_id: "f1", data: { head_revision_id: "r2" } });
    expect(moved.reason).toBe("postcondition_mismatch");
  });
});

describe("drive.rename/move/trash: valideringsregler og advarsler", () => {
  it("rename: navn uten innhold avvises; uendret navn er en advarsel; rollback none når navnet allerede var det ønskede", async () => {
    expect(driveRenameAdapter.validate({ file_id: "f1", new_name: "" })).toBe("new_name_missing");
    expect(driveRenameAdapter.validate({ file_id: "f1", new_name: "x" })).toBeNull();
    expect(driveRenameAdapter.validate({ file_id: "", new_name: "x" })).toBe("file_id_invalid");
    expect(driveRenameAdapter.validate({ file_id: "a?b", new_name: "x" })).toBe("file_id_invalid");
    const out = await drive(driveRenameAdapter, { file_id: "f1", new_name: "rapport.txt" }, { get_metadata: [META(), META()] }, { external_id: "f1", data: {} });
    expect(out.reason).toBeNull();
    expect(out.audit["preflight"]).toMatchObject({ warnings: ["name_unchanged"] });
    expect(out.audit["rollback"]).toMatchObject({ kind: "none" });
  });
  it("move: mål må ha trygg id og kan ikke være filen selv; flytting til samme forelder gir rollback none; flere foreldre gir manuell rollback", async () => {
    expect(driveMoveAdapter.validate({ file_id: "f1", new_parent_folder_id: "f1" })).toBe("destination_is_self");
    expect(driveMoveAdapter.validate({ file_id: "f1", new_parent_folder_id: "a/b" })).toBe("new_parent_folder_id_invalid");
    expect(driveMoveAdapter.validate({ file_id: "f1", new_parent_folder_id: "d1" })).toBeNull();
    const same = await drive(driveMoveAdapter, { file_id: "f1", new_parent_folder_id: "p1" }, { get_metadata: [META(), FOLDER({ id: "p1" }), META()] }, { external_id: "f1", data: {} });
    expect(same.audit["rollback"]).toMatchObject({ kind: "none" });
    const multi = await drive(driveMoveAdapter, { file_id: "f1", new_parent_folder_id: "d1" }, { get_metadata: [META({ parents: ["p1", "p2"] }), FOLDER(), META({ parents: ["d1"] })] }, { external_id: "f1", data: {} });
    expect(multi.reason).toBeNull();
    expect(multi.audit["rollback"]).toMatchObject({ kind: "manual", steps: [] });
  });
  it("trash: allerede i papirkurven = verifisert uten endring og rollback none; ellers manuell", async () => {
    const already = await drive(driveTrashAdapter, { file_id: "f1" }, { get_metadata: [META({ trashed: true }), META({ trashed: true })] }, { external_id: "f1", data: {} });
    expect(already.reason).toBeNull();
    expect(already.audit["rollback"]).toMatchObject({ kind: "none" });
    expect(already.audit["preflight"]).toMatchObject({ warnings: ["target_trashed", "already_trashed"] });
  });
  it("create_file: forelder som ikke finnes i lesingen eller ikke er en mappe blokkerer, og ugyldig navn/forelder-id avvises", async () => {
    expect(driveCreateFileAdapter.validate({ name: "" })).toBe("name_missing");
    expect(driveCreateFileAdapter.validate({ name: "x", parent_folder_id: "a/b" })).toBe("parent_folder_id_invalid");
    expect(driveCreateFileAdapter.validate({ name: "x", parent_folder_id: "d1" })).toBeNull();
    expect(driveCreateFileAdapter.validate({ name: "x" })).toBeNull();
    expect((await drive(driveCreateFileAdapter, { name: "x", parent_folder_id: "d1" }, { get_metadata: [{ data: { name: "x" } }] }, { external_id: "n1", data: {} })).block).toBe("class_c_preflight_invalid:parent_unreadable");
    expect((await drive(driveCreateFileAdapter, { name: "x", parent_folder_id: "d1" }, { get_metadata: [META()] }, { external_id: "n1", data: {} })).block).toBe("class_c_preflight_invalid:parent_not_folder");
  });
});
