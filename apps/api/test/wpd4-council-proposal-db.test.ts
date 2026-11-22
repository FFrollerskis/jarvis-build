import { mkdtemp, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { ConfirmationStore, ContextBuilder, MessageStore, createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { AiCouncil, MemoryTraceSink, ModelGateway, buildCouncilProposal, type ProposableAction } from "@jarvis/model-gateway";
import type { ModelProviderAdapter, ModelRequest, ModelResult } from "@jarvis/provider-adapters";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  COUNCIL_PROPOSAL_TAINT, CouncilProposalGate, KnowledgeSearchTransport, MemorySearchTransport, describeBoundParameters, buildToolManifest, firstWaveTools, homeAssistantTools, knowledgeToolDefinitions, memoryToolDefinitions, resolveModelToolSurface,
  type CouncilSubmitIdentity, type MeshToolMapping, type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";
import { ConversationEngine } from "../src/conversation.ts";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * WP-D4 (JARVIS-078, rådets bekreftelsesflyt) mot ekte Postgres og de ekte produksjonsdefinisjonene: et forslag fra AI-rådet blir et bundet, engangs bekreftelseskort i den EKSISTERENDE veien (`ConfirmationStore`, D-382) -
 * og INGENTING utføres før eieren godkjenner via den ekte `POST /confirmations`-ruten. Rådet/porten har ingen eksekutor; testene beviser det både atferdsmessig (ingen utførelse uten godkjenning) og strukturelt (kilde-vakt).
 */
const TENANT = "tenant-a";
const OWNER = "person-tobias";
const OTHER = "person-annen";
const identity: CouncilSubmitIdentity = { tenant_id: TENANT, person_id: OWNER, memory_space_id: "personal", device_id: "dev-pc", session_id: "sess-1" };

function productionDefinitions(): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw))),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never)),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never))
    ]
  });
}
const defs = productionDefinitions();
const gw = { list: () => defs } as unknown as ToolGateway;
const manifest = buildToolManifest(defs);
const surface = resolveModelToolSurface(gw, { includeChatReadTier: true, includeChatActTier: true, includeChatDelegateTier: true });

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let store: ConfirmationStore;
let gate: CouncilProposalGate;
let nowMs = Date.now();
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ["JARVIS_GITHUB_ALLOW_OTHER_REPOS", "JARVIS_GITHUB_REPO"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const dir = await mkdtemp(join(tmpdir(), "jarvis-cprop-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_cp LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_cp;");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a', 'A', 'person'), ('tenant-b', 'B', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias', 'Tobias'), ('person-annen', 'Annen');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias', 'tenant-a'), ('person-annen', 'tenant-a'), ('person-tobias', 'tenant-b');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_cp", password: "pw2" });
  store = new ConfirmationStore(app, () => new Date(nowMs));
  gate = new CouncilProposalGate({ mappings: surface, manifest, definitions: defs, confirmations: store });
}, 240_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const who = { tenant_id: TENANT, person_id: OWNER, device_id: "dev-pc", session_id: "sess-1" };
const task = (content: string) => ({ tool_id: "todoist", action: "create_task", parameters: { content } as Record<string, JsonValue> });
const rowOf = async (id: string) => (await admin.query("SELECT * FROM action_confirmations WHERE confirmation_id = $1", [id])).rows[0] as Record<string, unknown>;
const pendingCount = async (content: string) => Number((await admin.query("SELECT count(*)::int AS n FROM action_confirmations WHERE status = 'pending' AND parameters->>'content' = $1", [content])).rows[0].n);

describe("ConfirmationStore.propose - forslagsvei som aldri utfører", () => {
  it("oppretter en PENDING bundet til det kanoniske kallet: lagrede parametre, årsak, rådets kontekst i summary.context og valgt levetid", async () => {
    const context: Record<string, JsonValue> = { source: "ai_council", council_id: "council-1", proposal_id: "cprop-1", expected_effect: "Oppretter en oppgave.", safety_class: "B", supporting_models: ["anthropic"], dissenting_models: [] };
    const res = await store.propose(task("propose-1"), who, [COUNCIL_PROPOSAL_TAINT], { ttlMs: 15 * 60_000, context });
    expect(res).toMatchObject({ ok: true, reused: false });
    if (!res.ok) return;
    const row = await rowOf(res.confirmation_id);
    expect(row).toMatchObject({ status: "pending", tool_id: "todoist", action: "create_task", person_id: OWNER, tenant_id: TENANT, device_id: "dev-pc", session_id: "sess-1", taint_reasons: ["council_proposal"], parameters: { content: "propose-1" } });
    expect((row["summary"] as { context: unknown }).context).toEqual(context);
    expect((row["summary"] as { tool: string }).tool).toBe("todoist.create_task");
    expect(new Date(String(row["expires_at"])).getTime() - nowMs).toBeGreaterThan(14.9 * 60_000);
    expect(new Date(String(row["expires_at"])).getTime() - nowMs).toBeLessThanOrEqual(15 * 60_000 + 1_000);
    expect(row["consumed_at"]).toBeNull();
    expect(row["executed_at"]).toBeNull();
    // Kortet vises i eierens liste, med rådets kontekst.
    const listed = (await store.listPending({ tenant_id: TENANT, person_id: OWNER })).find((c) => c.confirmation_id === res.confirmation_id);
    expect(listed?.taint_reasons).toEqual(["council_proposal"]);
    expect((listed?.summary as { context: { council_id: string } }).context.council_id).toBe("council-1");
  });

  it("er idempotent: samme forslag igjen gjenbruker kortet (reused) og lager ikke en ny rad", async () => {
    const first = await store.propose(task("propose-2"), who, [COUNCIL_PROPOSAL_TAINT]);
    const second = await store.propose(task("propose-2"), who, [COUNCIL_PROPOSAL_TAINT]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.confirmation_id).toBe(first.confirmation_id);
    expect(second.reused).toBe(true);
    expect(first.reused).toBe(false);
    expect(await pendingCount("propose-2")).toBe(1);
  });

  it("forbruker ALDRI en godkjent bekreftelse: en identisk godkjent rad forblir 'approved', og forslaget får et NYTT pending-kort", async () => {
    const created = await store.checkAndConsume(task("propose-3"), who, ["owner_action_tier"]);
    const approvedId = (created as { confirmation_id: string }).confirmation_id;
    expect(await store.decide(who, approvedId, "approve")).toBe(true);
    const proposed = await store.propose(task("propose-3"), who, [COUNCIL_PROPOSAL_TAINT]);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.confirmation_id).not.toBe(approvedId);
    expect((await rowOf(approvedId))["status"]).toBe("approved");
    expect((await rowOf(approvedId))["consumed_at"]).toBeNull();
    expect((await rowOf(proposed.confirmation_id))["status"]).toBe("pending");
  });

  it("en nylig AVVIST identisk handling gir confirmation_rejected (rådet maser ikke); etter utløp kan den foreslås på nytt", async () => {
    const first = await store.propose(task("propose-4"), who, [COUNCIL_PROPOSAL_TAINT]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await store.decide(who, first.confirmation_id, "reject")).toBe(true);
    expect(await store.propose(task("propose-4"), who, [COUNCIL_PROPOSAL_TAINT])).toEqual({ ok: false, reason: "confirmation_rejected", confirmation_id: first.confirmation_id });
    nowMs += 16 * 60_000;
    const again = await store.propose(task("propose-4"), who, [COUNCIL_PROPOSAL_TAINT]);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.confirmation_id).not.toBe(first.confirmation_id);
  });

  it("utløpt pending erstattes av en ny, og den gamle merkes utløpt", async () => {
    const first = await store.propose(task("propose-5"), who, [COUNCIL_PROPOSAL_TAINT], { ttlMs: 2 * 60_000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    nowMs += 3 * 60_000;
    const second = await store.propose(task("propose-5"), who, [COUNCIL_PROPOSAL_TAINT], { ttlMs: 2 * 60_000 });
    expect(second.ok && second.confirmation_id !== first.confirmation_id && !second.reused).toBe(true);
    expect((await rowOf(first.confirmation_id))["status"]).toBe("expired");
  });

  it("levetiden klemmes til [1 min, 30 min]", async () => {
    const short = await store.propose(task("propose-6a"), who, [COUNCIL_PROPOSAL_TAINT], { ttlMs: 1 });
    const long = await store.propose(task("propose-6b"), who, [COUNCIL_PROPOSAL_TAINT], { ttlMs: 10 * 3_600_000 });
    const standard = await store.propose(task("propose-6c"), who, [COUNCIL_PROPOSAL_TAINT]);
    expect(short.ok && long.ok && standard.ok).toBe(true);
    if (!short.ok || !long.ok || !standard.ok) return;
    expect(new Date(short.expires_at).getTime() - nowMs).toBe(60_000);
    expect(new Date(long.expires_at).getTime() - nowMs).toBe(30 * 60_000);
    expect(new Date(standard.expires_at).getTime() - nowMs).toBe(5 * 60_000);
  });

  it("kontekst som er for stor eller inneholder en hemmelighet avvises - og lager ingen rad", async () => {
    const secret = `ghp_${"A1b2C3d4".repeat(5)}`;
    await expect(store.propose(task("propose-7a"), who, [COUNCIL_PROPOSAL_TAINT], { context: { note: "x".repeat(4100) } })).rejects.toThrow("confirmation_context_too_large");
    await expect(store.propose(task("propose-7b"), who, [COUNCIL_PROPOSAL_TAINT], { context: { note: `bruk ${secret}` } })).rejects.toThrow("confirmation_context_contains_secret");
    expect(await pendingCount("propose-7a")).toBe(0);
    expect(await pendingCount("propose-7b")).toBe(0);
  });

  it("revisjonsspor: confirmation.requested med proposed=true, source og council_id (uten parametre)", async () => {
    const res = await store.propose(task("propose-8"), who, [COUNCIL_PROPOSAL_TAINT], { context: { source: "ai_council", council_id: "council-audit" } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const audit = await admin.query("SELECT type, tool_id, action, person_id, session_id, payload FROM audit_events WHERE payload->>'confirmation_id' = $1", [res.confirmation_id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ type: "confirmation.requested", tool_id: "todoist", action: "create_task", person_id: OWNER, session_id: "sess-1", payload: { confirmation_id: res.confirmation_id, taint_reasons: ["council_proposal"], proposed: true, source: "ai_council", council_id: "council-audit" } });
    expect(JSON.stringify(audit.rows[0].payload)).not.toContain("propose-8");
  });

  it("isolasjon: en annen tenant ser ikke kortet, en annen person kan ikke godkjenne det, og approveAndTake gir nøyaktig kallet én gang", async () => {
    const res = await store.propose(task("propose-9"), who, [COUNCIL_PROPOSAL_TAINT]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((await store.listPending({ tenant_id: "tenant-b", person_id: OWNER })).some((c) => c.confirmation_id === res.confirmation_id)).toBe(false);
    expect(await store.approveAndTake({ tenant_id: TENANT, person_id: OTHER, device_id: "dev-x" }, res.confirmation_id)).toBeNull();
    expect(await store.approveAndTake({ tenant_id: "tenant-b", person_id: OWNER, device_id: "dev-pc" }, res.confirmation_id)).toBeNull();
    const taken = await store.approveAndTake({ ...who, device_id: "dev-phone" }, res.confirmation_id);
    // WP-N1 (F2-A1): `approveAndTake` returnerer i tillegg grunnene kortet ble opprettet med (`taint_reasons`).
    expect(taken).toEqual({ confirmation_id: res.confirmation_id, tool_id: "todoist", action: "create_task", parameters: { content: "propose-9" }, taint_reasons: [COUNCIL_PROPOSAL_TAINT] });
    expect(await store.approveAndTake(who, res.confirmation_id)).toBeNull();
  });

  it("manipulert parameter etter at kortet ble laget ugyldiggjør bindingen (ingenting kan tas ut)", async () => {
    const res = await store.propose(task("propose-10"), who, [COUNCIL_PROPOSAL_TAINT]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await admin.query("UPDATE action_confirmations SET parameters = $2 WHERE confirmation_id = $1", [res.confirmation_id, JSON.stringify({ content: "slett alt" })]);
    expect(await store.approveAndTake(who, res.confirmation_id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
function proposalFor(tool: string, args: Record<string, JsonValue>, actions: readonly ProposableAction[], over: { consensus?: "CONSENSUS" | "MAJORITY" } = {}) {
  const built = buildCouncilProposal({
    council_id: "council-gate-1", draft: { tool, arguments: args, expected_effect: "Gjør noe nyttig." }, actions, consensus_status: over.consensus ?? "MAJORITY",
    supporting_models: ["anthropic", "openai"], dissenting_models: ["kimi"], confidence: 77, risk_summary: "lav risiko"
  });
  if (!built.ok) throw new Error(`proposalFor: ${built.reason}`);
  return built.proposal;
}
const offered = (text: string) => gate.actionsFor({ surface: "web_chat", text });
const names = (text: string) => offered(text).actions.map((a) => a.name);

describe("CouncilProposalGate.actionsFor - lukket liste fra SAMME utvalg som chattens handlingsnivå", () => {
  it("handlingsord + tjeneste gir act-handlinger med klasse og effekt fra manifestet - aldri lesing, minne eller delegering", () => {
    const { actions } = offered("legg til en todoist-oppgave: ring leverandøren");
    const create = actions.find((a) => a.name === "todoist__create_task");
    expect(create).toMatchObject({ risk: "B", effect: "write" });
    expect(create?.description).not.toMatch(/HANDLING/);
    expect(create?.input_schema).toMatchObject({ required: ["content"] });
    for (const a of actions) {
      const entry = manifest.get(a.name.replace("__", "."));
      expect(entry, a.name).toBeDefined();
      expect(a.risk).toBe(entry?.risk);
      expect(a.effect).toBe(entry?.effect);
      expect(["B", "C"], a.name).toContain(a.risk);
      expect(["write", "send", "delete"], a.name).toContain(a.effect);
    }
    expect(actions.some((a) => /list_tasks|search|propose|delegate/.test(a.name))).toBe(false);
  });

  it("uten handlingsord (kun lesing), småprat, ukjent tjeneste og strategi-spørsmål gir ingen forslagsvei", () => {
    for (const text of ["vis todoist-oppgavene mine", "hei", "takk", "Bør vi kjøpe opp konkurrenten for 5 millioner kroner?", "hva synes du om planen vår"]) {
      expect(names(text), text).toEqual([]);
    }
  });

  it("tale, Telegram, bakgrunn og koding har aldri en forslagsvei, selv med handlingsord", () => {
    for (const s of ["voice", "telegram", "background", "coding"] as const) expect(gate.actionsFor({ surface: s, text: "legg til en todoist-oppgave: ring leverandøren" }).actions, s).toEqual([]);
  });

  it("finanshandlinger gjør rådet SECRET_RESTRICTED (D-381) - ellers settes ikke nivået", () => {
    const finance = offered("opprett et nytt abonnement på utgifter: legg til månedlig kostnad");
    expect(finance.actions.some((a) => a.name.startsWith("finance_spend__"))).toBe(true);
    expect(finance.min_sensitivity).toBe("SECRET_RESTRICTED");
    expect(offered("legg til en todoist-oppgave: ring leverandøren").min_sensitivity).toBeUndefined();
  });

  it("aldri over budsjettet for chatten (maks 12 skjema, 16 handlinger)", () => {
    expect(offered("opprett og oppdater og slett alt i kalender, todoist, notion, slack, github, drive og trello").actions.length).toBeLessThanOrEqual(12);
  });
});

describe("CouncilProposalGate.submit - bekreftelseskort uten utførelse", () => {
  const todoist = () => offered("legg til en todoist-oppgave: ring leverandøren").actions;

  it("gyldig forslag blir et PENDING kort bundet til det kanoniske kallet; ingenting utføres (porten har ingen eksekutor)", async () => {
    const proposal = proposalFor("todoist__create_task", { content: "gate-1: ring leverandøren" }, todoist());
    const res = await gate.submit(identity, "web_chat", proposal);
    expect(res).toMatchObject({ ok: true, tool: "todoist.create_task", reused: false, ttl_minutes: 15 });
    if (!res.ok) return;
    const row = await rowOf(res.confirmation_id);
    expect(row).toMatchObject({ status: "pending", tool_id: "todoist", action: "create_task", taint_reasons: ["council_proposal"], parameters: { content: "gate-1: ring leverandøren" }, consumed_at: null, executed_at: null, result: null });
    const ctx = (row["summary"] as { context: Record<string, unknown> }).context;
    expect(ctx).toMatchObject({ source: "ai_council", council_id: "council-gate-1", proposal_id: proposal.proposal_id, safety_class: "B", effect: "write", consensus: "MAJORITY", supporting_models: ["anthropic", "openai"], dissenting_models: ["kimi"], confidence: 77 });
    // Samme forslag igjen: samme kort.
    const again = await gate.submit(identity, "web_chat", proposal);
    expect(again.ok && again.confirmation_id === res.confirmation_id && again.reused).toBe(true);
  });

  it("scope-felt modellen la inn overstyres av eierens identitet (tenant_id, memory_space, owner_person_id)", async () => {
    const actions = offered("opprett en ny lead i forretning: ny kunde").actions;
    expect(actions.some((a) => a.name === "business__create_lead")).toBe(true);
    const proposal = proposalFor("business__create_lead", { title: "Ny lead (gate-scope)", tenant_id: "tenant-evil", owner_person_id: "person-evil", memory_space: "business" }, actions);
    const res = await gate.submit(identity, "web_chat", proposal);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect((await rowOf(res.confirmation_id))["parameters"]).toMatchObject({ title: "Ny lead (gate-scope)", tenant_id: TENANT, owner_person_id: OWNER, memory_space: "personal" });
  });

  it("avslag: ikke-foreslåbare verktøy (lesing, klasse D, ukjent, minne, delegering) og alle andre flater enn web_chat", async () => {
    const fake = (name: string, risk: "A" | "B" | "C" | "D" = "B", effect = "write"): ProposableAction => ({ name, description: "x", input_schema: {}, risk, effect });
    for (const name of ["todoist__list_tasks", "email__send", "github__merge_pr", "owner_controls__activate_kill_switch", "memory__propose", "tasks__delegate_background_task", "finance__submit_payment_intent", "ukjent__verktoy", "docker__stop_container"]) {
      const res = await gate.submit(identity, "web_chat", proposalFor(name, {}, [fake(name)]));
      expect(res, name).toEqual({ ok: false, reason: "tool_not_proposable" });
    }
    const valid = proposalFor("todoist__create_task", { content: "gate-surface" }, todoist());
    for (const s of ["voice", "telegram", "background", "coding"] as const) expect(await gate.submit(identity, s, valid), s).toEqual({ ok: false, reason: "surface_not_allowed" });
    expect(await pendingCount("gate-surface")).toBe(0);
  });

  it("endret sikkerhetsklasse/effekt siden rådet fikk listen gir safety_class_mismatch (manifestet vinner)", async () => {
    const lying: ProposableAction = { ...todoist().find((a) => a.name === "todoist__create_task")!, risk: "A" };
    expect(await gate.submit(identity, "web_chat", proposalFor("todoist__create_task", { content: "gate-lie" }, [lying]))).toEqual({ ok: false, reason: "safety_class_mismatch" });
    const wrongEffect: ProposableAction = { ...todoist().find((a) => a.name === "todoist__create_task")!, effect: "read" };
    expect(await gate.submit(identity, "web_chat", proposalFor("todoist__create_task", { content: "gate-lie2" }, [wrongEffect]))).toEqual({ ok: false, reason: "safety_class_mismatch" });
    expect(await pendingCount("gate-lie")).toBe(0);
  });

  it("ugyldige argumenter legges aldri frem: mangler påkrevd felt, ukjent felt, feil type, farlig nøkkel - detaljen har kun feltnavn", async () => {
    const actions = todoist();
    const missing = await gate.submit(identity, "web_chat", proposalFor("todoist__create_task", {}, actions));
    expect(missing).toMatchObject({ ok: false, reason: "invalid_parameters", detail: "content" });
    const extra = await gate.submit(identity, "web_chat", proposalFor("todoist__create_task", { content: "ok", slettAlt: true }, actions));
    expect(extra).toMatchObject({ ok: false, reason: "invalid_parameters" });
    const wrongType = await gate.submit(identity, "web_chat", proposalFor("todoist__create_task", { content: 42 }, actions));
    expect(wrongType).toMatchObject({ ok: false, reason: "invalid_parameters", detail: "content" });
    const polluted = JSON.parse('{"content": "ok", "__proto__": {"x": 1}}') as Record<string, JsonValue>;
    expect(await gate.submit(identity, "web_chat", { ...proposalFor("todoist__create_task", { content: "ok" }, actions), action: { tool: "todoist__create_task", arguments: polluted } })).toEqual({ ok: false, reason: "invalid_parameters", detail: "forbidden_key" });
    expect(JSON.stringify([missing, extra, wrongType])).not.toContain("slettAlt");
  });

  it("Q-50 B: GitHub-forslag er låst til eierens repo (som for modellstyrte kall i chatten)", async () => {
    const actions = offered("opprett en github-issue: feil i innlogging").actions;
    expect(actions.some((a) => a.name === "github__create_issue")).toBe(true);
    expect(await gate.submit(identity, "web_chat", proposalFor("github__create_issue", { repo: "evil/other-repo", title: "x" }, actions))).toEqual({ ok: false, reason: "github_repo_locked" });
    const ok = await gate.submit(identity, "web_chat", proposalFor("github__create_issue", { repo: "tsworkflow/jarvisbuild", title: "gate-github" }, actions));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });

  it("et AVVIST kort gir confirmation_rejected ved ny innlevering (rådet maser ikke)", async () => {
    const proposal = proposalFor("todoist__create_task", { content: "gate-rejected" }, todoist());
    const first = await gate.submit(identity, "web_chat", proposal);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await store.decide(who, first.confirmation_id, "reject")).toBe(true);
    expect(await gate.submit(identity, "web_chat", proposal)).toEqual({ ok: false, reason: "confirmation_rejected" });
  });

  it("feil i bekreftelsestjenesten gir confirmation_unavailable (ingenting legges frem, ingenting utføres)", async () => {
    const broken = new CouncilProposalGate({ mappings: surface, manifest, definitions: defs, confirmations: { propose: async () => { throw new Error("db nede"); } } });
    expect(await broken.submit(identity, "web_chat", proposalFor("todoist__create_task", { content: "gate-broken" }, todoist()))).toEqual({ ok: false, reason: "confirmation_unavailable" });
  });

  it("uten manifest-oppføring eller registrert definisjon legges ingenting frem (fail-closed)", async () => {
    const noManifest = new CouncilProposalGate({ mappings: surface, manifest: new Map(), definitions: defs, confirmations: store });
    expect(await noManifest.submit(identity, "web_chat", proposalFor("todoist__create_task", { content: "gate-nomanifest" }, todoist()))).toEqual({ ok: false, reason: "tool_not_in_manifest" });
    const noDefinition = new CouncilProposalGate({ mappings: surface, manifest, definitions: [], confirmations: store });
    expect(await noDefinition.submit(identity, "web_chat", proposalFor("todoist__create_task", { content: "gate-nodef" }, todoist()))).toEqual({ ok: false, reason: "tool_not_in_manifest" });
    expect(await pendingCount("gate-nomanifest")).toBe(0);
    expect(await pendingCount("gate-nodef")).toBe(0);
  });

  it("hemmeligheter i rådets tekst havner redigert på kortet (kontekst), aldri i klartekst", async () => {
    const secret = `ghp_${"A1b2C3d4".repeat(5)}`;
    const base = proposalFor("todoist__create_task", { content: "gate-secret" }, todoist());
    const res = await gate.submit(identity, "web_chat", { ...base, expected_effect: `Oppretter oppgave med ${secret}`, risk_summary: `risiko ${secret}`, supporting_models: [`a${secret}`] });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const summary = JSON.stringify((await rowOf(res.confirmation_id))["summary"]);
    expect(summary).not.toContain("ghp_");
    expect(summary).toContain("REDACTED");
  });

  it("kilde-vakt: porten og rådsmodellen har ingen vei til utførelse (ingen ToolGateway, execute-kall eller eksekutor)", async () => {
    for (const file of ["../../../modules/tool-gateway/src/council-proposal-gate.ts", "../../../modules/model-gateway/src/council-proposal.ts"]) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/\.execute\s*\(|ToolGateway|ToolExecutor|MeshToolExecutor|approveAndTake|checkAndConsume|recordResult/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Ende til ende: forslag -> kort -> eierens godkjenning via den EKSISTERENDE, ekte /confirmations-ruten
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe("ende til ende: rådets forslag utføres kun via eierens godkjenning i /confirmations (D-382)", () => {
  const executed: Array<{ tool_id: string; action: string; parameters: unknown; person: string; idempotency_key: string }> = [];
  let url = "";
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    const grantFor = (token: string) => (token === "grant-owner" ? OWNER : token === "grant-other" ? OTHER : null);
    const deps = {
      grants: {
        verify: async (token: string) => {
          const person = grantFor(token);
          return person ? { ok: true, grant: { person_id: person, tenant_id: TENANT, memory_space: "personal", session_id: "s-e2e", device_id: "d-e2e", channel: "web", auth_strength: "signed" } } : { ok: false, reason: "grant_invalid" };
        }
      },
      identity: { resolveIdentity: async (i: Record<string, string>) => ({ ok: true, identity: { ...i, memory_space_id: i["memory_space"] } }) },
      executive: {
        gateway: {
          // WP-F1: godkjenningsruten slår opp definisjonen for å avgjøre om step-up kreves (pengehandlinger) - rådets forslag (todoist) er ingen pengehandling.
          get: () => undefined,
          execute: async (call: { identity: { person_id: string }; tool_id: string; action: string; parameters: unknown; idempotency_key: string }) => {
            executed.push({ tool_id: call.tool_id, action: call.action, parameters: call.parameters, person: call.identity.person_id, idempotency_key: call.idempotency_key });
            return { ok: true, data: { id: "t-e2e" }, external_id: "ext-e2e" };
          }
        }
      },
      confirmations: store
    } as unknown as ApiDeps;
    const server = createApiServer(deps);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeServer = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  });
  afterAll(async () => { await closeServer?.(); });

  const post = (grant: string, parameters: Record<string, unknown>, action = "decide") =>
    fetch(`${url}/confirmations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_token: grant, action, parameters }) });

  it("forslaget alene utfører ingenting; eierens godkjenning utfører NØYAKTIG én gang med eierens identitet og confirmation:<id> som idempotensnøkkel; ny godkjenning gir 404", async () => {
    const actions = offered("legg til en todoist-oppgave: ring leverandøren").actions;
    const submitted = await gate.submit(identity, "web_chat", proposalFor("todoist__create_task", { content: "e2e: ring leverandøren" }, actions));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    // 1. Etter innlevering, FØR godkjenning: ingenting er utført, kortet venter.
    expect(executed).toHaveLength(0);
    const list = await (await post("grant-owner", {}, "list")).json() as { data: Array<{ confirmation_id: string; taint_reasons: string[]; summary: { context: { source: string } } }> };
    const card = list.data.find((c) => c.confirmation_id === submitted.confirmation_id);
    expect(card?.taint_reasons).toEqual(["council_proposal"]);
    expect(card?.summary.context.source).toBe("ai_council");
    // 2. En annen persons grant kan ikke godkjenne.
    const foreign = await post("grant-other", { confirmation_id: submitted.confirmation_id, decision: "approve" });
    expect(foreign.status).toBe(404);
    expect(executed).toHaveLength(0);
    // 3. Eierens godkjenning utfører.
    const approved = await post("grant-owner", { confirmation_id: submitted.confirmation_id, decision: "approve" });
    expect(approved.status).toBe(200);
    expect(executed).toEqual([{ tool_id: "todoist", action: "create_task", parameters: { content: "e2e: ring leverandøren" }, person: OWNER, idempotency_key: `confirmation:${submitted.confirmation_id}` }]);
    const row = await rowOf(submitted.confirmation_id);
    expect(row).toMatchObject({ status: "consumed", decided_by_person_id: OWNER, result: { ok: true, external_id: "ext-e2e" } });
    // 4. Engangs.
    expect((await post("grant-owner", { confirmation_id: submitted.confirmation_id, decision: "approve" })).status).toBe(404);
    expect(executed).toHaveLength(1);
  });

  it("avvisning utfører aldri; et avvist forslag kan ikke godkjennes etterpå", async () => {
    const before = executed.length;
    const submitted = await gate.submit(identity, "web_chat", proposalFor("todoist__create_task", { content: "e2e: avvises" }, offered("legg til en todoist-oppgave: x").actions));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect((await post("grant-owner", { confirmation_id: submitted.confirmation_id, decision: "reject" })).status).toBe(200);
    expect((await post("grant-owner", { confirmation_id: submitted.confirmation_id, decision: "approve" })).status).toBe(404);
    expect(executed.length).toBe(before);
  });

  it("utløpt kort utføres aldri, selv om det godkjennes", async () => {
    const before = executed.length;
    const submitted = await gate.submit(identity, "web_chat", proposalFor("todoist__create_task", { content: "e2e: utløper" }, offered("legg til en todoist-oppgave: x").actions));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    await admin.query("UPDATE action_confirmations SET expires_at = now() - interval '1 minute' WHERE confirmation_id = $1", [submitted.confirmation_id]);
    expect((await post("grant-owner", { confirmation_id: submitted.confirmation_id, decision: "approve" })).status).toBe(404);
    expect(executed.length).toBe(before);
  });

  it("HELE KJEDEN: melding -> ekte AiCouncil (scriptede medlemmer) -> forslag -> ekte port -> bekreftelseskort i chatten -> ingenting utført -> eierens godkjenning utfører én gang", async () => {
    const before = executed.length;
    const members = ["anthropic", "openai", "gemini", "kimi", "gemma_local"];
    const seen: ModelRequest[] = [];
    const adapters: ModelProviderAdapter[] = members.map((name) => ({
      name,
      model: "scripted-1",
      available: () => true,
      complete: async (request: ModelRequest): Promise<ModelResult> => {
        seen.push(request);
        const first = request.messages[0]?.content;
        const text = typeof first === "string" ? first : "";
        const match = text.match(/MEDLEMMER SOM SVARTE \(([^)]*)\)/);
        const out = match
          ? JSON.stringify({
              decision: "Opprett oppgaven nå.", supporting_models: (match[1] as string).split(",").map((x) => x.trim()), dissenting_models: [], key_evidence: [], key_disagreements: [], risk_summary: "lav", confidence: 90,
              recommended_action: "Opprett oppgaven.",
              proposed_action: { tool: "todoist__create_task", arguments: { content: "e2e-kjede: ring leverandøren" }, expected_effect: "Oppretter en Todoist-oppgave «ring leverandøren»." }
            })
          : JSON.stringify({ conclusion: `ja fra ${name}`, reasoning_summary: "r", assumptions: [], evidence_provenance: [], risks: [], confidence: 80, unresolved_questions: [] });
        return { text: out, usage: { input_tokens: 5, output_tokens: 5 }, provider: name, model: "scripted-1" };
      }
    }));
    const costPool = { connect: async () => ({ query: async (sql: string) => (String(sql).includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [], rowCount: 0 }), release: () => undefined }) } as unknown as pg.Pool;
    const gateway = new ModelGateway({ pool: costPool, trace: new MemoryTraceSink(), providers: adapters });
    const owner: IdentityContext = { person_id: OWNER, tenant_id: TENANT, memory_space_id: "personal", session_id: "sess-chain", device_id: "dev-pc", channel: "web", auth_strength: "active" };
    const engine = new ConversationEngine({
      messages: new MessageStore(costPool), context: new ContextBuilder(costPool), gateway, tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
      council: new AiCouncil(gateway),
      councilProposals: { actionsFor: (input) => gate.actionsFor(input), submit: (who, surface, proposal) => gate.submit(who, surface, proposal) }
    });

    const reply = await engine.handle(owner, "bruk AI-rådet: legg til en todoist-oppgave om å ringe leverandøren");
    expect(reply.routed).toBe("model");
    expect(reply.reply).toContain("Opprett oppgaven nå.");
    expect(reply.reply).toContain("Forslag fra rådet (IKKE utført)");
    expect(reply.reply).toContain("(konsensus: CONSENSUS");
    expect(reply.confirmations).toHaveLength(1);
    const card = reply.confirmations?.[0];
    expect(card).toMatchObject({ tool: "todoist.create_task", status: "confirmation_required" });
    // Rådet (alle runder + syntese) har ALDRI fått verktøy; handlingskatalogen står kun i synteseforespørselen.
    expect(seen.length).toBeGreaterThanOrEqual(10);
    for (const request of seen) {
      expect(request.tools).toBeUndefined();
      expect(request.tool_exchanges).toBeUndefined();
    }
    expect(seen.filter((r) => (r.system ?? "").includes("todoist__create_task"))).toHaveLength(1);
    // FØR godkjenning: kortet er pending, ingenting er utført.
    const row = await rowOf(card?.confirmation_id as string);
    expect(row).toMatchObject({ status: "pending", tool_id: "todoist", action: "create_task", taint_reasons: ["council_proposal"], parameters: { content: "e2e-kjede: ring leverandøren" } });
    expect((row["summary"] as { context: { consensus: string; supporting_models: string[] } }).context).toMatchObject({ source: "ai_council", consensus: "CONSENSUS" });
    expect((row["summary"] as { context: { supporting_models: string[] } }).context.supporting_models.sort()).toEqual([...members].sort());
    expect(executed.length).toBe(before);
    // Eierens godkjenning (den ekte ruten) utfører nøyaktig én gang.
    expect((await post("grant-owner", { confirmation_id: card?.confirmation_id, decision: "approve" })).status).toBe(200);
    expect(executed.slice(before)).toEqual([{ tool_id: "todoist", action: "create_task", parameters: { content: "e2e-kjede: ring leverandøren" }, person: OWNER, idempotency_key: `confirmation:${card?.confirmation_id}` }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Gjennomgang av PR #315 (M4, L7, M5 ii/iii): kortet viser det handlingen FAKTISK gjør, modelltekst er ren tekst, og vaktene er låst av tester.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const cpt = (...codes: number[]) => String.fromCodePoint(...codes);
const MARKUP_CHARS = /[[\]()<>`*_#!|\\]/;
const HIDDEN_CHARS = /[\p{C}\p{Zl}\p{Zp}]/u;

describe("M4: kortets kontekst - modelltekst er ren tekst, og det handlingen faktisk gjør står først", () => {
  const todoist = () => offered("legg til en todoist-oppgave: ring leverandøren").actions;
  const evil = `Sender ${cpt(0x202e)}moc.liamg${cpt(0x202c)} [trykk her](https://evil.example/x) ![x](http://evil.example/p.png) <img src=x onerror=alert(1)> a${cpt(0x200b)}b ${cpt(0x2066)}c${cpt(0x2069)} ${cpt(0xe0041)}`;

  it("reviewerens eksempler i expected_effect og risk_summary lagres som ren tekst (ingen bidi/nullbredde/markdown/HTML/lenke) - porten renser selv, uavhengig av rådet", async () => {
    const base = proposalFor("todoist__create_task", { content: "m4-evil-text" }, todoist());
    const res = await gate.submit(identity, "web_chat", { ...base, expected_effect: evil, risk_summary: evil });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const ctx = ((await rowOf(res.confirmation_id))["summary"] as { context: Record<string, string> }).context;
    for (const field of ["expected_effect", "risk_summary"] as const) {
      const text = ctx[field] as string;
      expect(text, field).not.toMatch(MARKUP_CHARS);
      expect(text, field).not.toMatch(HIDDEN_CHARS);
      expect(text, field).not.toMatch(/https?:\/\//i);
      expect(text, field).toContain("Sender");
    }
  });

  it("kortet sier at effektbeskrivelsen er modellskrevet, og har en fast linje med det handlingen faktisk gjør - hentet fra de bundne parameterne, ikke fra modelltekst", async () => {
    const base = proposalFor("todoist__create_task", { content: "m4-bound-line" }, todoist());
    // Modellen lyver i effektbeskrivelsen: den påstår en annen handling enn den som er bundet.
    const res = await gate.submit(identity, "web_chat", { ...base, expected_effect: "Sletter alle oppgaver og sender en e-post til noen@example.com." });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const ctx = ((await rowOf(res.confirmation_id))["summary"] as { context: Record<string, string> }).context;
    expect(ctx["effect_author"]).toBe("model");
    expect(ctx["effect_note_no"]).toBe("Effektbeskrivelsen er skrevet av en modell og er ingen garanti for hva som skjer - godkjenn ut fra parameterne.");
    expect(ctx["bound_parameters_no"]).toBe("Handlingen gjør dette (hentet fra selve kallet, ikke fra rådet): Tekst (content): «m4-bound-line».");
    expect(res.bound_summary).toBe(ctx["bound_parameters_no"]);
    expect(ctx["bound_parameters_no"]).not.toContain("noen@example.com");
  });

  it("slack__notify: mottaker (kanal) og tekst vises fra parameterne; kanalen modellen nevner i prosa spiller ingen rolle", async () => {
    const actions = offered("send en melding i slack: møtet er flyttet").actions;
    expect(actions.some((a) => a.name === "slack__notify")).toBe(true);
    const base = proposalFor("slack__notify", { channel: "#ops", message: "Møtet er flyttet til 14:00" }, actions);
    const res = await gate.submit(identity, "web_chat", { ...base, expected_effect: "Varsler #generelt." });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.bound_summary).toBe("Handlingen gjør dette (hentet fra selve kallet, ikke fra rådet): Mottaker (channel): #ops · Tekst (message): «Møtet er flyttet til 14:00».");
  });

  it("usynlige tegn i argumentene AVVISES (invalid_parameters/hidden_characters) i stedet for å vises «renset» - ellers godkjenner eieren noe annet enn det som utføres", async () => {
    const before = await pendingCount("m4-hidden");
    for (const [label, bad] of [
      ["bidi-overstyring", `m4-hidden${cpt(0x202e)}x`], ["bidi-isolat", `m4-hidden${cpt(0x2066)}x${cpt(0x2069)}`], ["nullbredde", `m4-hidden${cpt(0x200b)}x`], ["ZWJ", `m4-hidden${cpt(0x200d)}x`],
      ["tag-tegn", `m4-hidden${cpt(0xe0041)}x`], ["NUL", "m4-hidden\u0000x"], ["ESC", "m4-hidden\u001bx"], ["løst surrogat", `m4-hidden${String.fromCharCode(0xd800)}x`]
    ] as const) {
      const res = await gate.submit(identity, "web_chat", proposalFor("todoist__create_task", { content: bad }, todoist()));
      expect(res, label).toEqual({ ok: false, reason: "invalid_parameters", detail: "hidden_characters" });
    }
    expect(await pendingCount("m4-hidden")).toBe(before);
    // også i nøkler, og i nøstede verdier
    const nested = await gate.submit(identity, "web_chat", { ...proposalFor("todoist__create_task", { content: "m4-nested" }, todoist()), action: { tool: "todoist__create_task", arguments: { content: "m4-nested", extra: { a: [`x${cpt(0x200b)}`] } } } });
    expect(nested).toEqual({ ok: false, reason: "invalid_parameters", detail: "hidden_characters" });
  });

  it("vanlig innhold passerer: æøå, emoji og linjeskift i teksten", async () => {
    const res = await gate.submit(identity, "web_chat", proposalFor("todoist__create_task", { content: "m4-ok: Ring Åse 😀\nTakk – Ærlig Ødegård" }, todoist()));
    expect(res.ok, JSON.stringify(res)).toBe(true);
  });

  it("argumenter lengre enn kortet kan vise (CARD_PREVIEW_MAX_CHARS) avvises (too_long_for_card) - aldri en avkortet visning; nøyaktig grensen passerer", async () => {
    const make = (content: string) => ({ ...proposalFor("todoist__create_task", { content: "x" }, todoist()), action: { tool: "todoist__create_task", arguments: { content } } });
    const overhead = JSON.stringify({ content: "" }).length;
    const fits = await gate.submit(identity, "web_chat", make(`m4-fit-${"x".repeat(1000 - overhead - 7)}`));
    expect(fits.ok, JSON.stringify(fits)).toBe(true);
    if (fits.ok) {
      const preview = ((await rowOf(fits.confirmation_id))["summary"] as { parameters_preview: string }).parameters_preview;
      expect(preview).toHaveLength(1000);
      expect(JSON.parse(preview)).toEqual({ content: `m4-fit-${"x".repeat(1000 - overhead - 7)}` }); // hele handlingen er synlig, ikke kuttet
    }
    const tooLong = await gate.submit(identity, "web_chat", make(`m4-long-${"x".repeat(1000 - overhead - 7)}`));
    expect(tooLong).toEqual({ ok: false, reason: "invalid_parameters", detail: "too_long_for_card" });
    expect(await pendingCount(`m4-long-${"x".repeat(1000 - overhead - 7)}`)).toBe(0);
  });

  it("ledetekst og verdier i den faste linjen: rensede (ingen lenke-/bilde-/HTML-tegn), kappet, og lister/objekter/tall vises uten å lekke noe annet", () => {
    expect(describeBoundParameters({ to: ["a@x.no", "b@x.no", "c@x.no", "d@x.no", "e@x.no", "f@x.no"], subject: "Møte [x](http://evil/p.png) <b>nå</b>", body: "kort" })).toBe(
      "Handlingen gjør dette (hentet fra selve kallet, ikke fra rådet): Mottaker (to): a@x.no, b@x.no, c@x.no, d@x.no (+2 til) · Tittel (subject): «Møte x http://evil/p.png b nå /b» · Tekst (body): «kort»."
    );
    expect(describeBoundParameters({ repo: "tsworkflow/jarvisbuild", amount_ore: 12000, title: "Feil i innlogging" })).toBe(
      "Handlingen gjør dette (hentet fra selve kallet, ikke fra rådet): Mål (repo): tsworkflow/jarvisbuild · Beløp (amount_ore): 12000 · Tittel (title): «Feil i innlogging»."
    );
    const none = describeBoundParameters({ a: 1, b: { c: 2 } });
    expect(none).toContain("ingen mottaker, mål, beløp eller tittel");
    expect(none).toContain("felt: a, b");
    const long = describeBoundParameters({ body: "å".repeat(500), subject: "s".repeat(500) });
    expect(long.length).toBeLessThan(400);
    expect(describeBoundParameters({ to: { a: 1 } })).toContain("Mottaker (to): ");
  });
});

describe("L7: ttl_minutes følger kortets faktiske utløp (også for et gjenbrukt PENDING-kort)", () => {
  it("nytt kort: 15 minutter; samme forslag 11 minutter senere gjenbruker kortet og sier 4 (ikke en hardkodet 15)", async () => {
    const timed = new CouncilProposalGate({ mappings: surface, manifest, definitions: defs, confirmations: store, now: () => new Date(nowMs) });
    const actions = offered("legg til en todoist-oppgave: ring leverandøren").actions;
    const proposal = proposalFor("todoist__create_task", { content: "l7-ttl" }, actions);
    const first = await timed.submit(identity, "web_chat", proposal);
    expect(first).toMatchObject({ ok: true, reused: false, ttl_minutes: 15 });
    nowMs += 11 * 60_000;
    const again = await timed.submit(identity, "web_chat", proposal);
    expect(again).toMatchObject({ ok: true, reused: true, ttl_minutes: 4 });
    if (first.ok && again.ok) expect(again.expires_at).toBe(first.expires_at);
    nowMs += 3 * 60_000 + 30_000; // 30 sekunder igjen: aldri «0 minutter»
    expect(await timed.submit(identity, "web_chat", proposal)).toMatchObject({ ok: true, reused: true, ttl_minutes: 1 });
  });
});

describe("M5 (ii): gate-konstruktørens act-tier-filter - alt utenfor handlingsnivået blir aldri et forslag, selv om kalleren sender det i mappings", () => {
  const realTodoist = () => surface.find((m) => m.def.name === "todoist__create_task") as MeshToolMapping;
  const forged = (tool_id: string, action: string, kind: "act" | "read" = "act"): MeshToolMapping => ({ ...realTodoist(), tool_id, action, kind, def: { ...realTodoist().def, name: `${tool_id}__${action}`, description: `${tool_id} ${action} opprett legg til send` } });
  // klasse D, betaling, kontroll, eier-/sikkerhetsnavnerom og vanlige lesinger som en (feilaktig) bygd mappingliste kunne inneholdt
  const OUTSIDE: Array<[string, string]> = [
    ["github", "merge_pull_request"], ["finance", "submit_payment_intent"], ["finance_wallester", "freeze_card"], ["owner_controls", "activate_kill_switch"], ["docker", "stop_container"],
    ["gce", "delete_instance"], ["self_modification", "apply_change"], ["memory", "propose"], ["tasks", "delegate_background_task"], ["email", "send"], ["todoist", "list_tasks"]
  ];

  it("actionsFor tilbyr aldri en forfalsket act-mapping utenfor nivået", () => {
    const withForged = new CouncilProposalGate({ mappings: [...surface, ...OUTSIDE.map(([t, a]) => forged(t, a))], manifest, definitions: defs, confirmations: store });
    const text = "opprett og legg til og send: todoist, github, finance, docker, gce, email, memory, owner_controls, merge, betaling, kill switch, frys kort";
    const offeredNames = withForged.actionsFor({ surface: "web_chat", text }).actions.map((a) => a.name);
    for (const [t, a] of OUTSIDE) expect(offeredNames, `${t}__${a}`).not.toContain(`${t}__${a}`);
    // og de ekte handlingene er fortsatt der (filteret fjerner kun det som er utenfor nivået)
    expect(offeredNames.length).toBeGreaterThan(0);
  });

  it("submit avviser en forfalsket act-mapping med tool_not_proposable (konstruktørfilteret, ikke bare et senere lag), og ingenting legges frem", async () => {
    const withForged = new CouncilProposalGate({ mappings: [...surface, ...OUTSIDE.map(([t, a]) => forged(t, a))], manifest, definitions: defs, confirmations: store });
    const before = Number((await admin.query("SELECT count(*)::int AS n FROM action_confirmations")).rows[0].n);
    for (const [t, a] of OUTSIDE) {
      const action: ProposableAction = { name: `${t}__${a}`, description: "x", input_schema: {}, risk: "B", effect: "write" };
      expect(await withForged.submit(identity, "web_chat", proposalFor(`${t}__${a}`, {}, [action])), `${t}__${a}`).toEqual({ ok: false, reason: "tool_not_proposable" });
    }
    expect(Number((await admin.query("SELECT count(*)::int AS n FROM action_confirmations")).rows[0].n)).toBe(before);
  });

  it("et par på handlingsnivået (todoist.create_task) forblir foreslåbart gjennom en gate bygd av en blandet mappingliste", async () => {
    const mixed = new CouncilProposalGate({ mappings: [...OUTSIDE.map(([t, a]) => forged(t, a)), realTodoist()], manifest, definitions: defs, confirmations: store });
    const actions = mixed.actionsFor({ surface: "web_chat", text: "legg til en todoist-oppgave: ring leverandøren" }).actions;
    expect(actions.map((a) => a.name)).toContain("todoist__create_task");
    const res = await mixed.submit(identity, "web_chat", proposalFor("todoist__create_task", { content: "m5-ii-ok" }, actions));
    expect(res.ok, JSON.stringify(res)).toBe(true);
  });
});

describe("M5 (iii): ConfirmationStore.propose gjenbruker aldri et avvist, utløpt eller forbrukt kort", () => {
  it("AVVIST: aldri ok/reused - svaret er confirmation_rejected med det avviste kortets id, og INGEN ny rad opprettes", async () => {
    const first = await store.propose(task("m5iii-rej"), who, [COUNCIL_PROPOSAL_TAINT]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await store.decide(who, first.confirmation_id, "reject")).toBe(true);
    const again = await store.propose(task("m5iii-rej"), who, [COUNCIL_PROPOSAL_TAINT]);
    expect(again).toEqual({ ok: false, reason: "confirmation_rejected", confirmation_id: first.confirmation_id });
    expect((again as { reused?: boolean }).reused).toBeUndefined();
    expect(await pendingCount("m5iii-rej")).toBe(0);
    expect(Number((await admin.query("SELECT count(*)::int AS n FROM action_confirmations WHERE parameters->>'content' = 'm5iii-rej'")).rows[0].n)).toBe(1);
    expect((await rowOf(first.confirmation_id))["status"]).toBe("rejected");
  });

  it("avvist og så utløpt: nytt forslag lager et NYTT kort (aldri det gamle), og det gamle merkes utløpt", async () => {
    const first = await store.propose(task("m5iii-rej-exp"), who, [COUNCIL_PROPOSAL_TAINT], { ttlMs: 2 * 60_000 });
    if (!first.ok) throw new Error("forventet ok");
    expect(await store.decide(who, first.confirmation_id, "reject")).toBe(true);
    nowMs += 3 * 60_000;
    const again = await store.propose(task("m5iii-rej-exp"), who, [COUNCIL_PROPOSAL_TAINT]);
    expect(again).toMatchObject({ ok: true, reused: false });
    if (!again.ok) return;
    expect(again.confirmation_id).not.toBe(first.confirmation_id);
    expect((await rowOf(first.confirmation_id))["status"]).toBe("expired");
    expect((await rowOf(again.confirmation_id))["status"]).toBe("pending");
  });

  it("UTLØPT pending: aldri gjenbrukt (reused=false, ny id), selv når utløpet er ett millisekund unna", async () => {
    const first = await store.propose(task("m5iii-exp"), who, [COUNCIL_PROPOSAL_TAINT], { ttlMs: 60_000 });
    if (!first.ok) throw new Error("forventet ok");
    nowMs += 60_000; // nøyaktig utløpstidspunktet: expires_at <= now regnes som utløpt
    const again = await store.propose(task("m5iii-exp"), who, [COUNCIL_PROPOSAL_TAINT]);
    expect(again).toMatchObject({ ok: true, reused: false });
    if (again.ok) expect(again.confirmation_id).not.toBe(first.confirmation_id);
  });

  it("FORBRUKT (godkjent og utført): propose lager et nytt pending-kort og rører ikke det forbrukte", async () => {
    const first = await store.propose(task("m5iii-used"), who, [COUNCIL_PROPOSAL_TAINT]);
    if (!first.ok) throw new Error("forventet ok");
    expect(await store.approveAndTake(who, first.confirmation_id)).not.toBeNull();
    const consumed = await rowOf(first.confirmation_id);
    const again = await store.propose(task("m5iii-used"), who, [COUNCIL_PROPOSAL_TAINT]);
    expect(again).toMatchObject({ ok: true, reused: false });
    if (!again.ok) return;
    expect(again.confirmation_id).not.toBe(first.confirmation_id);
    expect((await rowOf(first.confirmation_id))["status"]).toBe(consumed["status"]);
    expect((await rowOf(first.confirmation_id))["consumed_at"]).toEqual(consumed["consumed_at"]);
  });

  it("GODKJENT (ikke forbrukt): propose forbruker den aldri og gjenbruker den ikke - den forblir 'approved' og et nytt pending-kort opprettes", async () => {
    const created = await store.checkAndConsume(task("m5iii-appr"), who, ["owner_action_tier"]);
    const approvedId = (created as { confirmation_id: string }).confirmation_id;
    expect(await store.decide(who, approvedId, "approve")).toBe(true);
    const proposed = await store.propose(task("m5iii-appr"), who, [COUNCIL_PROPOSAL_TAINT]);
    expect(proposed).toMatchObject({ ok: true, reused: false });
    if (!proposed.ok) return;
    expect(proposed.confirmation_id).not.toBe(approvedId);
    const row = await rowOf(approvedId);
    expect(row["status"]).toBe("approved");
    expect(row["consumed_at"]).toBeNull();
  });
});
