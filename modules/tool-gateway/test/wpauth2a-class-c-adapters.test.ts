import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  GithubTransport,
  GoogleDriveTransport,
  ToolGateway,
  createClassCPipeline,
  defaultClassCAdapters,
  firstWaveTools,
  resetGoogleAccessTokenCache,
  type ClassCAdapter,
  type ClassCMode,
  type ToolResult
} from "@jarvis/tool-gateway";
import { HARNESS_IDENTITY, ScriptedTransport } from "./support/class-c-baseline-harness.ts";
import { FakeDrive, FakeGithub, installFakeVendors } from "./support/class-c-fake-vendors.ts";
import { startClassCTestDb, type ClassCTestDb } from "./support/class-c-test-db.ts";

/**
 * WP-AUTH2a (K3): de første adapterne (GitHub `create_pr`, Drive `create_file`/`update_content`/`rename`/`move`/`trash`) mot de EKTE transportene og de EKTE produksjonsdefinisjonene, gjennom den EKTE gatewayen med
 * ekte (embedded) Postgres. Leverandørene er tilstandsfulle falske (`support/class-c-fake-vendors.ts`): ingen nettverk. Domene-adapterne (vekst, forretning) testes i sine egne moduler.
 */

const SECRET = ["tok", "en-", "A1B2C3D4E5F6G7"].join("");
let db: ClassCTestDb;
let github: FakeGithub;
let drive: FakeDrive;
let restore: () => void;

beforeAll(async () => {
  db = await startClassCTestDb();
  process.env["JARVIS_GOOGLE_CLIENT_ID"] = "client-id-test";
  process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "client-secret-test";
}, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);
beforeEach(() => {
  github = new FakeGithub();
  drive = new FakeDrive();
  resetGoogleAccessTokenCache();
  restore = installFakeVendors({ github, drive });
});
afterEach(() => restore());

let counter = 0;
function rig(mode: ClassCMode): { gw: ToolGateway; run(tool: string, action: string, parameters: Record<string, JsonValue>, key?: string): Promise<ToolResult> } {
  const killSwitch = new KillSwitch();
  const policy = new PolicyGateway({ devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch, authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-a"] } });
  const gw = new ToolGateway(db.appPool, policy, { name: "t", get: async () => SECRET }, new OwnerControls(killSwitch), undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async () => undefined } },
    credentialBinding: { owner_person_id: "person-owner", owner_tenants: ["tenant-a"], internalRefs: new Set<string>() },
    classCPipeline: createClassCPipeline({ mode, adapters: defaultClassCAdapters() })
  });
  for (const def of firstWaveTools({ github: new GithubTransport(), drive: new GoogleDriveTransport("owner@example.invalid") })) gw.register(def);
  return {
    gw,
    run: (tool, action, parameters, key = `auth2a-ad-${(counter += 1)}`) => gw.execute({ identity: HARNESS_IDENTITY, tool_id: tool, action, parameters, idempotency_key: key })
  };
}

async function mark(): Promise<number> { return Number((await db.adminPool.query("SELECT COALESCE(MAX(audit_id), 0) AS m FROM audit_events")).rows[0].m); }
async function auditSince(watermark: number): Promise<Array<{ type: string; reason: string | null; payload: Record<string, unknown> }>> {
  return (await db.adminPool.query("SELECT type, reason, payload FROM audit_events WHERE audit_id > $1 AND tenant_id = 'tenant-a' ORDER BY audit_id", [watermark])).rows as never;
}
async function ledger(key: string): Promise<{ status: string; postcondition_reason: string | null } | undefined> {
  return (await db.adminPool.query("SELECT status, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0] as never;
}
const classC = (row: { payload: Record<string, unknown> } | undefined): Record<string, any> => (row?.payload["class_c"] ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const lastClassC = async (w: number, types = ["tool.executed", "tool.postcondition_unverified", "tool.denied", "tool.failed"]): Promise<Record<string, any>> => // eslint-disable-line @typescript-eslint/no-explicit-any
  classC((await auditSince(w)).filter((a) => types.includes(a.type)).at(-1));

const PR = { repo: "owner/repo", branch: "feature/x", title: "Endring av rapport", base: "main" };

describe("A: github.create_pr mot den ekte GithubTransport", () => {
  it("enforce: preflight leser head, base og åpne PR-er; PR opprettes; readback bekrefter; rollback = lukk PR (registrert verktøy)", async () => {
    const r = rig("enforce");
    const w = await mark();
    const key = "auth2a-gh-1";
    const res = await r.run("github", "create_pr", PR, key);
    expect(res).toMatchObject({ ok: true, external_id: "1" });
    expect(github.prs).toHaveLength(1);
    expect(github.requests).toEqual([
      "GET /branches/feature%2Fx", "GET /branches/main", "GET /pulls?state=open&per_page=50", "POST /pulls", "GET /pulls/1"
    ]);
    expect(await ledger(key)).toMatchObject({ status: "succeeded", postcondition_reason: null });
    const block = await lastClassC(w);
    expect(block).toMatchObject({
      mode: "enforce", adapter: "github.create_pr", verdict: "verified", violations: [], unobservable: ["body"],
      preflight: { outcome: "passed", reason: null, warnings: [], reads: [{ id: "head", ok: true }, { id: "base", ok: true }, { id: "open_prs", ok: true }] },
      before: { state: { pr: null }, context: { head_sha: "sha-feature", base_sha: "sha-main", existing_open_pr: null } },
      after: { state: { pr: { number: 1, state: "open", head_ref: "feature/x", base_ref: "main", title: "Endring av rapport", merged: false, draft: false } } },
      rollback: { kind: "compensating_action", complete: true, registered: [true], steps: [{ tool_id: "github", action: "update_pr", parameters: { repo: "owner/repo", pr_number: "1", state: "closed" } }] }
    });
    expect((block["diff"] as Array<{ path: string }>).map((d) => d.path)).toContain("pr.number");
  });

  it("rollback-planen kan faktisk utføres: samme gateway lukker PR-en (kompenserende handling virker mot den ekte transporten)", async () => {
    const r = rig("enforce");
    const w = await mark();
    await r.run("github", "create_pr", PR);
    const plan = (await lastClassC(w))["rollback"].steps[0] as { tool_id: string; action: string; parameters: Record<string, JsonValue> };
    const undone = await r.run(plan.tool_id, plan.action, plan.parameters);
    expect(undone.ok).toBe(true);
    expect(github.prs[0]?.state).toBe("closed");
  });

  it("enforce: manglende head-branch blokkerer FØR PR-en opprettes (target_not_found), uten ledger-rad", async () => {
    const r = rig("enforce");
    const key = "auth2a-gh-2";
    expect(await r.run("github", "create_pr", { ...PR, branch: "finnes-ikke" }, key)).toEqual({ ok: false, reason: "class_c_target_not_found:head" });
    expect(github.prs).toHaveLength(0);
    expect(github.requests.some((q) => q.startsWith("POST"))).toBe(false);
    expect(await ledger(key)).toBeUndefined();
  });

  it("enforce: ugyldig mål (head = base, ugyldig repo, tom tittel, blank gren) avvises uten ett eneste nettverkskall", async () => {
    const r = rig("enforce");
    for (const [params, reason] of [
      [{ ...PR, branch: "main" }, "head_equals_base"],
      [{ ...PR, repo: "ikke et repo" }, "repo_invalid"],
      [{ ...PR, repo: "owner/../x" }, "repo_invalid"],
      [{ ...PR, title: "   " }, "title_missing"],
      [{ ...PR, branch: "har mellomrom" }, "branch_invalid"],
      [{ ...PR, base: "med\nlinjeskift" }, "base_invalid"]
    ] as const) {
      expect(await r.run("github", "create_pr", params as never), JSON.stringify(params)).toEqual({ ok: false, reason: `class_c_target_invalid:${reason}` });
    }
    expect(github.requests).toEqual([]);
  });

  it("standard base er main (som transporten): utelatt base gir PR mot main", async () => {
    const r = rig("enforce");
    const { base: _omit, ...withoutBase } = PR;
    void _omit;
    expect((await r.run("github", "create_pr", withoutBase)).ok).toBe(true);
    expect(github.prs[0]?.base).toBe("main");
  });

  it("idempotent treff (åpen PR fantes): ok, verdikt verified, ingen diff, rollback er `none` - og tittelen på den eksisterende PR-en er ikke et brudd", async () => {
    github.prs.push({ number: 5, title: "Annen tittel enn bedt om", state: "open", draft: false, head: "feature/x", base: "main", merged: false, body: null });
    const r = rig("enforce");
    const w = await mark();
    expect(await r.run("github", "create_pr", PR)).toMatchObject({ ok: true, external_id: "5" });
    const block = await lastClassC(w);
    expect(block).toMatchObject({ verdict: "verified", diff: [], rollback: { kind: "none", steps: [] }, preflight: { warnings: ["open_pr_exists"] } });
    expect(github.prs).toHaveLength(1);
  });

  it("enforce: en leverandør som oppretter PR mot en ANNEN base enn bedt om er mismatch -> unverified (replay-bart), og planen for å lukke PR-en finnes likevel", async () => {
    github.forceBase = "annen-base";
    const r = rig("enforce");
    const w = await mark();
    const key = "auth2a-gh-3";
    expect(await r.run("github", "create_pr", PR, key)).toEqual({ ok: false, reason: "postcondition_mismatch" });
    expect(await ledger(key)).toMatchObject({ status: "unverified", postcondition_reason: "postcondition_mismatch" });
    const block = await lastClassC(w);
    expect(block["violations"]).toEqual([{ path: "pr.base_ref", rule: "expected_equals", expected: "main", actual: "annen-base" }]);
    expect(block["rollback"]).toMatchObject({ kind: "compensating_action", registered: [true] });
    expect(await r.run("github", "create_pr", PR, key)).toEqual({ ok: false, reason: "postcondition_mismatch" });
    expect(github.prs).toHaveLength(1); // samme nøkkel oppretter aldri en ny PR
  });

  it("observe: samme leverandør som lyver endrer ikke utfallet (ok), men avviket er registrert", async () => {
    github.forceBase = "annen-base";
    const r = rig("observe");
    const w = await mark();
    expect((await r.run("github", "create_pr", PR)).ok).toBe(true);
    expect(await lastClassC(w)).toMatchObject({ mode: "observe", verdict: "mismatch", would_block: ["verify:postcondition_mismatch"] });
  });

  it("readback som feiler: ikke funnet gir target_missing, annen feil gir readback_failed (begge unverified)", async () => {
    for (const [status, reason] of [[404, "postcondition_unverified:target_missing"], [403, "postcondition_unverified:readback_failed"]] as const) {
      github = new FakeGithub();
      github.failures.set("GET /pulls/", status);
      restore();
      restore = installFakeVendors({ github, drive });
      const r = rig("enforce");
      expect(await r.run("github", "create_pr", PR), String(status)).toEqual({ ok: false, reason });
    }
  });

  it("en valgfri preflight-lesing (listen over åpne PR-er) som feiler blokkerer ikke", async () => {
    github.failures.set("GET /pulls?state=open&per_page=50", 403);
    const r = rig("enforce");
    const w = await mark();
    expect((await r.run("github", "create_pr", PR)).ok).toBe(true);
    expect((await lastClassC(w))["preflight"].reads.map((x: { id: string; ok: boolean }) => [x.id, x.ok])).toEqual([["head", true], ["base", true], ["open_prs", false]]);
  });

  it("modus AV: ingen forhåndslesing og ingen readback - kun selve opprettelsen (som før)", async () => {
    const r = rig("off");
    expect((await r.run("github", "create_pr", PR)).ok).toBe(true);
    expect(github.requests).toEqual(["POST /pulls"]);
  });
});

describe("B: Drive-handlingene mot den ekte GoogleDriveTransport", () => {
  it("rename: navnet endres, papirkurv/foreldre er uendret; rollback = gi tilbake forrige navn (registrert)", async () => {
    const r = rig("enforce");
    const w = await mark();
    const key = "auth2a-dr-1";
    expect(await r.run("drive", "rename", { file_id: "file-1", new_name: "nytt-navn.txt" }, key)).toMatchObject({ ok: true, external_id: "file-1" });
    expect(drive.files.get("file-1")?.name).toBe("nytt-navn.txt");
    expect(await ledger(key)).toMatchObject({ status: "succeeded" });
    const block = await lastClassC(w);
    expect(block).toMatchObject({
      verdict: "verified", adapter: "drive.rename", diff: [{ path: "name", before: "rapport.txt", after: "nytt-navn.txt" }],
      rollback: { kind: "compensating_action", registered: [true], steps: [{ tool_id: "drive", action: "rename", parameters: { file_id: "file-1", new_name: "rapport.txt" } }] }
    });
    expect(drive.requests.filter((q) => q.startsWith("GET")).length).toBe(2); // én forhåndslesing og én readback - ikke fire (den gamle preflight_action er erstattet)
  });

  it("rename: en leverandør som svarer OK men ikke endrer navnet er mismatch (aldri suksess)", async () => {
    drive.ignoreRename = true;
    const r = rig("enforce");
    const key = "auth2a-dr-2";
    expect(await r.run("drive", "rename", { file_id: "file-1", new_name: "nytt-navn.txt" }, key)).toEqual({ ok: false, reason: "postcondition_mismatch" });
    expect((await ledger(key))?.status).toBe("unverified");
  });

  it("rename/move/trash/update_content av en fil som ikke finnes: target_not_found før noe endres", async () => {
    const r = rig("enforce");
    for (const [action, params] of [
      ["rename", { file_id: "mangler", new_name: "x" }], ["trash", { file_id: "mangler" }], ["update_content", { file_id: "mangler", content: "x" }], ["move", { file_id: "mangler", new_parent_folder_id: "folder-b" }]
    ] as const) {
      expect(await r.run("drive", action, params as never), action).toEqual({ ok: false, reason: "class_c_target_not_found:file" });
    }
    expect(drive.requests.some((q) => q.startsWith("PATCH"))).toBe(false);
  });

  it("utdatert revisjon (expected_head_revision_id) blokkeres av preflight FØR noen PATCH - samme forutsetning som transporten, men med bevis i audit", async () => {
    const r = rig("enforce");
    const w = await mark();
    for (const [action, params] of [
      ["rename", { file_id: "file-1", new_name: "x", expected_head_revision_id: "gammel" }],
      ["trash", { file_id: "file-1", expected_head_revision_id: "gammel" }],
      ["update_content", { file_id: "file-1", content: "x", expected_head_revision_id: "gammel" }],
      ["move", { file_id: "file-1", new_parent_folder_id: "folder-b", expected_head_revision_id: "gammel" }]
    ] as const) {
      expect(await r.run("drive", action, params as never), action).toEqual({ ok: false, reason: "class_c_preflight_invalid:stale_revision" });
    }
    expect(drive.requests.some((q) => q.startsWith("PATCH"))).toBe(false);
    expect((await lastClassC(w)).before.context.head_revision_id).toMatch(/^rev-/);
    // stemmer revisjonen, går kallet gjennom
    const current = drive.files.get("file-1")!.headRevisionId!;
    expect((await r.run("drive", "rename", { file_id: "file-1", new_name: "ok.txt", expected_head_revision_id: current })).ok).toBe(true);
  });

  it("ugyldig fil-ID (sti-tegn) avvises uten nettverkskall", async () => {
    const r = rig("enforce");
    expect(await r.run("drive", "rename", { file_id: "a/b", new_name: "x" })).toEqual({ ok: false, reason: "class_c_target_invalid:file_id_invalid" });
    expect(await r.run("drive", "trash", { file_id: "../x" })).toEqual({ ok: false, reason: "class_c_target_invalid:file_id_invalid" });
    expect(await r.run("drive", "rename", { file_id: "file-1", new_name: "  " })).toEqual({ ok: false, reason: "class_c_target_invalid:new_name_missing" });
    expect(drive.requests).toEqual([]);
  });

  it("move: nøyaktig målmappen blir forelder; rollback flytter tilbake; ikke-mappe og seg selv som mål avvises", async () => {
    const r = rig("enforce");
    const w = await mark();
    expect((await r.run("drive", "move", { file_id: "file-1", new_parent_folder_id: "folder-b" })).ok).toBe(true);
    expect(drive.files.get("file-1")?.parents).toEqual(["folder-b"]);
    const block = await lastClassC(w);
    expect(block).toMatchObject({ verdict: "verified", diff: [{ path: "parents", before: ["folder-a"], after: ["folder-b"] }], rollback: { kind: "compensating_action", steps: [{ tool_id: "drive", action: "move", parameters: { file_id: "file-1", new_parent_folder_id: "folder-a" } }] } });
    expect(await r.run("drive", "move", { file_id: "file-1", new_parent_folder_id: "note-1" })).toEqual({ ok: false, reason: "class_c_preflight_invalid:destination_not_folder" });
    expect(await r.run("drive", "move", { file_id: "file-1", new_parent_folder_id: "file-1" })).toEqual({ ok: false, reason: "class_c_target_invalid:destination_is_self" });
    expect(await r.run("drive", "move", { file_id: "file-1", new_parent_folder_id: "finnes-ikke" })).toEqual({ ok: false, reason: "class_c_target_not_found:destination" });
  });

  it("trash: papirkurv settes; rollback er en manuell prosedyre (ingen registrert gjenopprettingshandling); allerede i papirkurven gir advarsel og rollback none", async () => {
    const r = rig("enforce");
    const w = await mark();
    expect((await r.run("drive", "trash", { file_id: "file-1" })).ok).toBe(true);
    expect(drive.files.get("file-1")?.trashed).toBe(true);
    const block = await lastClassC(w);
    expect(block).toMatchObject({ verdict: "verified", diff: [{ path: "trashed", before: false, after: true }], rollback: { kind: "manual", steps: [] } });
    expect(block["rollback"]["note"]).toMatch(/papirkurven/);
    const w2 = await mark();
    expect((await r.run("drive", "trash", { file_id: "file-1" })).ok).toBe(true);
    expect(await lastClassC(w2)).toMatchObject({ verdict: "verified", diff: [], preflight: { warnings: ["target_trashed", "already_trashed"] }, rollback: { kind: "none" } });
  });

  it("update_content: revisjonen endres (og er lik den transporten returnerte), innholdet står som uobserverbart; rollback er manuell med revisjons-ID", async () => {
    const r = rig("enforce");
    const w = await mark();
    const before = drive.files.get("file-1")!.headRevisionId!;
    const res = await r.run("drive", "update_content", { file_id: "file-1", content: "nytt innhold" });
    expect(res.ok).toBe(true);
    expect(drive.files.get("file-1")?.content).toBe("nytt innhold");
    const block = await lastClassC(w);
    expect(block).toMatchObject({ verdict: "verified", unobservable: ["content"], diff: [{ path: "head_revision_id", before: before }] });
    expect(block["rollback"]).toMatchObject({ kind: "manual" });
    expect(block["rollback"]["note"]).toContain(before);
  });

  it("update_content uten revisjons-ID (Google-egne dokumenttyper): innholdsendringen kan ikke observeres -> unverified i enforce (aldri verified), ok i observe", async () => {
    drive.noRevisions = true;
    drive.put({ id: "doc-1", name: "dokument", mimeType: "text/plain", parents: ["folder-a"], headRevisionId: null });
    const e = rig("enforce");
    const key = "auth2a-dr-3";
    expect(await e.run("drive", "update_content", { file_id: "doc-1", content: "x" }, key)).toEqual({ ok: false, reason: "postcondition_unverified:class_c_unobservable" });
    expect((await ledger(key))?.status).toBe("unverified");
    const o = rig("observe");
    const w = await mark();
    expect((await o.run("drive", "update_content", { file_id: "doc-1", content: "y" })).ok).toBe(true);
    expect(await lastClassC(w)).toMatchObject({ verdict: "unverified", would_block: ["verify:postcondition_unverified:class_c_unobservable"] });
  });

  it("create_file: filen finnes etterpå med riktig navn og forelder; rollback = legg den i papirkurven (drive.trash er registrert)", async () => {
    const r = rig("enforce");
    const w = await mark();
    const res = await r.run("drive", "create_file", { name: "ny.txt", content: "hei", parent_folder_id: "folder-b" });
    expect(res).toMatchObject({ ok: true });
    const id = (res as { external_id: string }).external_id;
    expect(drive.files.get(id)).toMatchObject({ name: "ny.txt", parents: ["folder-b"], trashed: false });
    const block = await lastClassC(w);
    expect(block).toMatchObject({
      verdict: "verified", adapter: "drive.create_file", before: { state: { file: null } },
      after: { state: { file: { id, name: "ny.txt", trashed: false, parents: ["folder-b"] } } },
      rollback: { kind: "compensating_action", registered: [true], steps: [{ tool_id: "drive", action: "trash", parameters: { file_id: id } }] }
    });
    const undo = block["rollback"].steps[0] as { tool_id: string; action: string; parameters: Record<string, JsonValue> };
    expect((await r.run(undo.tool_id, undo.action, undo.parameters)).ok).toBe(true);
    expect(drive.files.get(id)?.trashed).toBe(true);
  });

  it("create_file: forelder som ikke er en mappe (eller ikke finnes) blokkerer; uten forelder leses ingenting i forkant", async () => {
    const r = rig("enforce");
    expect(await r.run("drive", "create_file", { name: "x", parent_folder_id: "note-1" })).toEqual({ ok: false, reason: "class_c_preflight_invalid:parent_not_folder" });
    expect(await r.run("drive", "create_file", { name: "x", parent_folder_id: "finnes-ikke" })).toEqual({ ok: false, reason: "class_c_target_not_found:parent" });
    expect(await r.run("drive", "create_file", { name: " " })).toEqual({ ok: false, reason: "class_c_target_invalid:name_missing" });
    expect(drive.requests.filter((q) => q.startsWith("POST /upload"))).toEqual([]);
    drive.requests.length = 0;
    expect((await r.run("drive", "create_file", { name: "rotfil.txt" })).ok).toBe(true);
    expect(drive.requests.filter((q) => q.startsWith("GET")).length).toBe(1); // kun readback
  });
});

describe("C: ingen hemmeligheter i bevisene, og alle fire status-/replay-egenskaper holder for de ekte handlingene", () => {
  it("verken credential, tilgangstoken eller klient-hemmeligheter finnes i noe audit-objekt eller i ledgeren", async () => {
    const r = rig("enforce");
    const w = await mark();
    await r.run("github", "create_pr", PR);
    await r.run("drive", "rename", { file_id: "file-1", new_name: "a.txt" });
    await r.run("drive", "update_content", { file_id: "note-1", content: "x" });
    const text = JSON.stringify(await auditSince(w)) + JSON.stringify((await db.adminPool.query("SELECT before_state, after_state FROM tool_executions")).rows);
    for (const secret of [SECRET, "fake-access-token", "client-secret-test", "client-id-test"]) expect(text, secret).not.toContain(secret);
  });

  it("replay etter vellykket handling hopper over preflight (ingen nye lesinger) og gir deduplicated", async () => {
    const r = rig("enforce");
    const key = "auth2a-dr-replay";
    expect((await r.run("drive", "rename", { file_id: "file-1", new_name: "r.txt" }, key)).ok).toBe(true);
    const seen = drive.requests.length;
    expect(await r.run("drive", "rename", { file_id: "file-1", new_name: "r.txt" }, key)).toMatchObject({ ok: true, deduplicated: true });
    expect(drive.requests.length).toBe(seen);
  });

  it("adapterne dekker nøyaktig de åtte første handlingene (tool-gateway eier seks; vekst og forretning legges til av sine moduler)", () => {
    expect(defaultClassCAdapters().map((a: ClassCAdapter) => a.key).sort()).toEqual(["drive.create_file", "drive.move", "drive.rename", "drive.trash", "drive.update_content", "github.create_pr"]);
  });

  it("alle adaptere peker på en handling som faktisk er klasse C i produksjonsregisteret", () => {
    const defs = firstWaveTools({ github: new ScriptedTransport("g", {}), drive: new ScriptedTransport("d", {}) });
    for (const adapter of defaultClassCAdapters()) {
      const def = defs.find((d) => `${d.tool_id}.${d.action}` === adapter.key);
      expect(def?.capability_class, adapter.key).toBe("C");
    }
  });
});
