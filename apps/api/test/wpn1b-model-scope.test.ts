import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  FINANCE_WITHHELD_REASON, MeshToolExecutor, ToolGateway, currentServingModel, withholdFinanceFromCurrentModel,
  type FinanceExecutionLock, type MeshToolMapping, type ToolDefinition, type ToolGatewayOptions, type ToolInvocationContext
} from "@jarvis/tool-gateway";
import { FINANCE_EXECUTION_LOCK } from "../src/restricted-context-guard.ts";

/**
 * WP-N1b (JARVIS-116 b, K1): `servingModel` gjennom NØSTEDE kall (AsyncLocalStorage, som `call-signal.ts`). Før: kun det øverste verktøykallet bar modellen, så hvert nøstet finansoppslag måtte holdes tilbake per tjeneste
 * (kun `executive` var dekket). Nå settes den modell-stemplede konteksten ÉN gang i `ToolGateway.execute()` (kun med begrenset-vakten på), nøstede `execute()`-kall arver den, og utførelseslåsen for `finance*` leser den sentralt.
 *
 *  A. Hullet (rød på main): en transport som IKKE er executive gjør et nøstet `finance.get_kill_switch` uten `servingModel` - for en skymodell ble det utført; nå nektes det sentralt (`finance_withheld_from_cloud_model`).
 *  B. Lokal modell og eierens ruter (ingen modell) får fortsatt alt (K1 ii).
 *  C. Ingen lekkasje mellom samtidige forespørsler (K1 i): mange samtidige kall med ulike modeller, tilfeldige ventetider, nøstede kall i `Promise.all`.
 *  D. Feil-lukket (K1 iii): blank/ukjent leverandør, predikat som kaster, lås uten predikat, og et nøstet kall kan aldri LØSNE et skyskop.
 *  E. Vakt AV (ingen lås) er identisk med main (K1 flagg AV): ingen skop, ingen arvet modell, nøstet finanskall utføres som før.
 *  F. Den ekte `MeshToolExecutor` (adapter-stemplet leverandør) gir skopet; nøstede lesere ser samme modell.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-n1bscope", memory_space_id: "personal", session_id: "sess-n1bscope",
  device_id: "jarvis-web", channel: "web", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-n1bscope-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const conn = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...conn, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_n1bscope LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_n1bscope");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-n1bscope','N1BSCOPE','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-n1bscope');
  `);
  appPool = new pg.Pool({ ...conn, user: "jarvis_n1bscope", password: "pw2" });
  appPool.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

const LOCK: FinanceExecutionLock = FINANCE_EXECUTION_LOCK;
const CLOUD = { provider: "anthropic", model: "claude-sonnet-5-5" };
const LOCAL = { provider: "gemma_local", model: "gemma3:4b" };
const SECRET_MARKER = "N1B-FINANCE-STATE-MARKER";

interface Seen {
  tag: string;
  /** Det øverste kallets kontekst. */
  topModel: { provider: string; model: string } | undefined;
  ambientModel: { provider: string; model: string } | undefined;
  ambientWithheld: boolean;
  /** Det nøstede bladkallets kontekst (en annen transport, kalt via `gateway.execute` uten `servingModel`). */
  leaf?: { ctxModel: { provider: string; model: string } | undefined; ambientModel: { provider: string; model: string } | undefined; ambientWithheld: boolean };
  /** Det nøstede finansoppslaget (uten `servingModel`): utført eller nektet? */
  finance?: { ok: boolean; reason?: string };
}

interface Rig { gateway: ToolGateway; financeCalls: Array<{ tool: string; action: string; context: ToolInvocationContext | undefined }>; seen: Map<string, Seen> }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const jitter = async (i: number): Promise<void> => {
  // blander mikrotasks, setImmediate og timere slik at asynkrone kontekster krysses så mye som mulig
  const kind = i % 4;
  if (kind === 0) await sleep(1 + (i * 7) % 13);
  else if (kind === 1) await new Promise<void>((r) => setImmediate(r));
  else if (kind === 2) await Promise.resolve().then(() => Promise.resolve());
  else await new Promise<void>((r) => queueMicrotask(r));
};

const fakeDef = (tool_id: string, action: string, transport: ToolDefinition["transport"]): ToolDefinition => ({
  tool_id, action, description: "fake", input_schema: z.record(z.any()) as never, capability_class: "A", scopes: [], reversible: true, rollback_procedure: "ingen", idempotent_external: true,
  timeout_ms: 8000, rate_limit_per_minute: 100000, credential_ref: "", output_trust: "trusted", transport
});

/**
 * `probe.read` er en vilkårlig modellnåbar transport som IKKE er executive: den gjør (a) et nøstet kall til en ANNEN transport (`leaf.read`) og (b) et nøstet finansoppslag, begge via `gateway.execute` UTEN `servingModel`
 * (nøyaktig det en fremtidig tjeneste uten egen tilbakehold ville gjort), med tilfeldige ventetider imellom.
 */
function rig(opts: { lock?: FinanceExecutionLock; lockOptions?: ToolGatewayOptions } = {}): Rig {
  const financeCalls: Rig["financeCalls"] = [];
  const seen = new Map<string, Seen>();
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch(),
    authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
  });
  const options: ToolGatewayOptions = opts.lockOptions ?? (opts.lock ? { financeExecutionLock: opts.lock } : {});
  const gateway = new ToolGateway(appPool, policy, { name: "test", async get() { return "secret"; } }, undefined, undefined, options);
  gateway.register(fakeDef("finance", "get_kill_switch", {
    async invoke(_action, _p, _c, context) {
      financeCalls.push({ tool: "finance", action: "get_kill_switch", context });
      return { data: { state: SECRET_MARKER } };
    }
  }));
  gateway.register(fakeDef("leaf", "read", {
    async invoke(_action, parameters, _c, context) {
      const tag = String(parameters["tag"]);
      const entry = seen.get(tag) as Seen;
      await jitter(Number(parameters["i"] ?? 0) + 1);
      entry.leaf = { ctxModel: context?.servingModel, ambientModel: currentServingModel(), ambientWithheld: withholdFinanceFromCurrentModel() };
      return { data: { ok: true } };
    }
  }));
  gateway.register(fakeDef("probe", "read", {
    async invoke(_action, parameters, _c, context) {
      const tag = String(parameters["tag"]);
      const i = Number(parameters["i"] ?? 0);
      const entry: Seen = { tag, topModel: context?.servingModel, ambientModel: currentServingModel(), ambientWithheld: withholdFinanceFromCurrentModel() };
      seen.set(tag, entry);
      await jitter(i);
      // to nøstede kall parallelt: et blad (annen transport) og selve finansoppslaget - begge UTEN servingModel
      const [, fin] = await Promise.all([
        gateway.execute({ identity, tool_id: "leaf", action: "read", parameters: { tag, i }, idempotency_key: `k-${randomUUID()}` }),
        (async () => {
          await jitter(i + 2);
          return gateway.execute({ identity, tool_id: "finance", action: "get_kill_switch", parameters: {}, idempotency_key: `k-${randomUUID()}` });
        })()
      ]);
      await jitter(i + 3);
      entry.finance = fin.ok ? { ok: true } : { ok: false, reason: fin.reason };
      // etter alle ventene: skopet er fortsatt DETTE kallets
      if (currentServingModel()?.provider !== entry.ambientModel?.provider) throw new Error("scope_changed_during_call");
      return { data: { tag } as JsonValue };
    }
  }));
  return { gateway, financeCalls, seen };
}

const call = (gateway: ToolGateway, tag: string, i: number, servingModel?: { provider: string; model: string }) =>
  gateway.execute({ identity, tool_id: "probe", action: "read", parameters: { tag, i }, idempotency_key: `k-${randomUUID()}`, ...(servingModel !== undefined ? { servingModel } : {}) });

describe("A: nøstet finansoppslag fra en vilkårlig modellnåbar transport (rød på main: utført for sky)", () => {
  it("SKYMODELL: det nøstede `finance.get_kill_switch` (uten servingModel) nektes SENTRALT med finans-årsaken - transporten kalles ikke", async () => {
    const { gateway, financeCalls, seen } = rig({ lock: LOCK });
    const r = await call(gateway, "cloud-1", 1, CLOUD);
    expect(r.ok).toBe(true);
    expect(seen.get("cloud-1")?.finance).toEqual({ ok: false, reason: FINANCE_WITHHELD_REASON });
    expect(financeCalls, "finance-transporten skal ikke kalles fra et skykall").toEqual([]);
  });

  it("det nøstede bladkallet (annen transport) ser SAMME modell og at den er sky - arvet, ikke gjettet", async () => {
    const { gateway, seen } = rig({ lock: LOCK });
    await call(gateway, "cloud-2", 2, CLOUD);
    const s = seen.get("cloud-2") as Seen;
    expect(s.topModel).toEqual(CLOUD);
    expect(s.ambientModel).toEqual(CLOUD);
    expect(s.ambientWithheld).toBe(true);
    expect(s.leaf).toEqual({ ctxModel: CLOUD, ambientModel: CLOUD, ambientWithheld: true });
  });

  it("revisjon: nektelsen er en vanlig `tool.denied`-rad med KUN årsakskoden (aldri innhold, aldri parametre)", async () => {
    const { gateway } = rig({ lock: LOCK });
    const before = await adminPool.query("SELECT count(*)::int AS n FROM audit_events WHERE type = 'tool.denied' AND reason = $1 AND tool_id = 'finance'", [FINANCE_WITHHELD_REASON]);
    await call(gateway, "cloud-audit", 3, CLOUD);
    const after = await adminPool.query("SELECT count(*)::int AS n, bool_or(payload::text LIKE $2) AS leaked FROM audit_events WHERE type = 'tool.denied' AND reason = $1 AND tool_id = 'finance'", [FINANCE_WITHHELD_REASON, `%${SECRET_MARKER}%`]);
    expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n + 1);
    expect((after.rows[0] as { leaked: boolean | null }).leaked).not.toBe(true);
  });
});

describe("B: lokal modell og eierens ruter får fortsatt alt (K1 ii)", () => {
  it("LOKAL modell: det nøstede finansoppslaget utføres, og skopet sier «ikke sky»", async () => {
    const { gateway, financeCalls, seen } = rig({ lock: LOCK });
    await call(gateway, "local-1", 4, LOCAL);
    const s = seen.get("local-1") as Seen;
    expect(s.finance).toEqual({ ok: true });
    expect(financeCalls.length).toBe(1);
    expect(s.ambientWithheld).toBe(false);
    expect(s.leaf?.ambientModel).toEqual(LOCAL);
    expect(s.leaf?.ambientWithheld).toBe(false);
  });

  it("INGEN modell (eierens HTTP-ruter, /control, eier-godkjent bekreftelse): ingen skop, ingen arvet modell, finansoppslaget utføres", async () => {
    const { gateway, financeCalls, seen } = rig({ lock: LOCK });
    await call(gateway, "owner-1", 5);
    const s = seen.get("owner-1") as Seen;
    expect(s.topModel).toBeUndefined();
    expect(s.ambientModel).toBeUndefined();
    expect(s.ambientWithheld).toBe(false);
    expect(s.leaf).toEqual({ ctxModel: undefined, ambientModel: undefined, ambientWithheld: false });
    expect(s.finance).toEqual({ ok: true });
    expect(financeCalls.length).toBe(1);
  });

  it("utenfor ethvert kall er det ingen modell: lesehjelperne gir `undefined`/`false` (eierens kode har aldri et skop)", () => {
    expect(currentServingModel()).toBeUndefined();
    expect(withholdFinanceFromCurrentModel()).toBe(false);
  });
});

describe("C: ingen lekkasje mellom samtidige forespørsler (K1 i)", () => {
  const MODELS: Array<{ label: string; model: { provider: string; model: string } | undefined; cloud: boolean }> = [
    { label: "sky", model: CLOUD, cloud: true },
    { label: "lokal", model: LOCAL, cloud: false },
    { label: "ingen", model: undefined, cloud: false },
    { label: "blank", model: { provider: "", model: "x" }, cloud: true },
    { label: "ukjent", model: { provider: "ukjent-leverandor", model: "x" }, cloud: true },
    { label: "hermes", model: { provider: "hermes", model: "h" }, cloud: true },
    { label: "ollama", model: { provider: "ollama", model: "o" }, cloud: false }
  ];

  it("126 samtidige kall med blandede modeller, tilfeldige ventetider og nøstede kall i Promise.all: hvert kall ser KUN sin egen modell, og utfallet følger modellen", async () => {
    const { gateway, financeCalls, seen } = rig({ lock: LOCK });
    const N = 126; // 18 av hver av de 7 modellene: 72 sky/ukjent og 54 lokal/ingen
    const plan = Array.from({ length: N }, (_, i) => ({ i, tag: `c-${i}`, m: MODELS[i % MODELS.length] as (typeof MODELS)[number] }));
    const results = await Promise.all(plan.map((p) => call(gateway, p.tag, p.i, p.m.model)));
    expect(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok))).toBe(true);
    let cloudCount = 0;
    for (const p of plan) {
      const s = seen.get(p.tag) as Seen;
      expect(s.topModel, p.tag).toEqual(p.m.model);
      expect(s.ambientModel, p.tag).toEqual(p.m.model);
      expect(s.ambientWithheld, p.tag).toBe(p.m.cloud);
      expect(s.leaf, p.tag).toEqual({ ctxModel: p.m.model, ambientModel: p.m.model, ambientWithheld: p.m.cloud });
      expect(s.finance, p.tag).toEqual(p.m.cloud ? { ok: false, reason: FINANCE_WITHHELD_REASON } : { ok: true });
      if (p.m.cloud) cloudCount += 1;
    }
    // finance-transporten ble kalt nøyaktig for de IKKE-sky kallene - ingen kryssing den ene eller andre veien
    expect(financeCalls.length).toBe(N - cloudCount);
    expect(cloudCount).toBe(72);
    expect(N - cloudCount).toBe(54);
  });

  it("skopet lekker ikke ut av et kall: etter at 40 kall er ferdige er det fortsatt ingen modell i den omsluttende konteksten", async () => {
    const { gateway } = rig({ lock: LOCK });
    await Promise.all(Array.from({ length: 40 }, (_, i) => call(gateway, `after-${i}`, i, i % 2 === 0 ? CLOUD : LOCAL)));
    expect(currentServingModel()).toBeUndefined();
    expect(withholdFinanceFromCurrentModel()).toBe(false);
    // og et eier-kall rett etterpå får alt
    const { gateway: g2, financeCalls } = rig({ lock: LOCK });
    await call(g2, "owner-after", 1);
    expect(financeCalls.length).toBe(1);
  });
});

describe("D: feil-lukket (K1 iii) - ukjent/uleselig regnes som sky, og et nøstet kall kan aldri LØSNE et skyskop", () => {
  it("blank, feilstavet, STORE BOKSTAVER og ikke-registrert leverandør: det nøstede finansoppslaget nektes", async () => {
    const { gateway, financeCalls, seen } = rig({ lock: LOCK });
    const models = [{ provider: "", model: "x" }, { provider: "   ", model: "x" }, { provider: "GEMMA_LOCAL", model: "x" }, { provider: "gemma_local ", model: "x" }, { provider: "ukjent", model: "x" }];
    for (const [i, model] of models.entries()) {
      await call(gateway, `fc-${i}`, i, model);
      expect(seen.get(`fc-${i}`)?.finance, JSON.stringify(model)).toEqual({ ok: false, reason: FINANCE_WITHHELD_REASON });
    }
    expect(financeCalls).toEqual([]);
  });

  it("lås uten predikat (`servedLocally` mangler) og predikat som KASTER: alt med modell regnes som sky; uten modell er det fortsatt eierens rute", async () => {
    for (const lock of [{} as FinanceExecutionLock, { servedLocally: () => { throw new Error("boom"); } } as FinanceExecutionLock, { servedLocally: (() => "yes") as never } as FinanceExecutionLock]) {
      const { gateway, financeCalls, seen } = rig({ lock });
      await call(gateway, "x-local", 1, LOCAL);
      await call(gateway, "x-cloud", 2, CLOUD);
      await call(gateway, "x-owner", 3);
      expect(seen.get("x-local")?.finance).toEqual({ ok: false, reason: FINANCE_WITHHELD_REASON });
      expect(seen.get("x-cloud")?.finance).toEqual({ ok: false, reason: FINANCE_WITHHELD_REASON });
      expect(seen.get("x-owner")?.finance).toEqual({ ok: true });
      expect(financeCalls.length).toBe(1);
    }
  });

  it("et nøstet kall som selv oppgir en LOKAL modell inne i et skykall får ikke løsnet skopet: skymodellen gjelder (strengest vinner)", async () => {
    const { gateway, financeCalls } = rig({ lock: LOCK });
    let nestedResult: { ok: boolean; reason?: string } | undefined;
    gateway.register(fakeDef("downgrade", "try", {
      async invoke() {
        const r = await gateway.execute({ identity, tool_id: "finance", action: "get_kill_switch", parameters: {}, idempotency_key: `k-${randomUUID()}`, servingModel: LOCAL });
        nestedResult = r.ok ? { ok: true } : { ok: false, reason: r.reason };
        return { data: {} };
      }
    }));
    await gateway.execute({ identity, tool_id: "downgrade", action: "try", parameters: {}, idempotency_key: `k-${randomUUID()}`, servingModel: CLOUD });
    expect(nestedResult).toEqual({ ok: false, reason: FINANCE_WITHHELD_REASON });
    expect(financeCalls).toEqual([]);
  });

  it("det motsatte er lov: et nøstet kall kan STRAMME inn (lokalt skop, nøstet kall oppgir sky)", async () => {
    const { gateway, financeCalls } = rig({ lock: LOCK });
    let nestedResult: { ok: boolean; reason?: string } | undefined;
    gateway.register(fakeDef("tighten", "try", {
      async invoke() {
        const r = await gateway.execute({ identity, tool_id: "finance", action: "get_kill_switch", parameters: {}, idempotency_key: `k-${randomUUID()}`, servingModel: CLOUD });
        nestedResult = r.ok ? { ok: true } : { ok: false, reason: r.reason };
        return { data: {} };
      }
    }));
    await gateway.execute({ identity, tool_id: "tighten", action: "try", parameters: {}, idempotency_key: `k-${randomUUID()}`, servingModel: LOCAL });
    expect(nestedResult).toEqual({ ok: false, reason: FINANCE_WITHHELD_REASON });
    expect(financeCalls).toEqual([]);
  });
});

describe("E: vakt AV (ingen lås) er identisk med main", () => {
  it("ingen skop og ingen arvet modell: det nøstede kallet ser ingen modell, og finansoppslaget utføres også for en skymodell (som på main)", async () => {
    const { gateway, financeCalls, seen } = rig();
    await call(gateway, "off-cloud", 1, CLOUD);
    const s = seen.get("off-cloud") as Seen;
    expect(s.topModel).toEqual(CLOUD); // det øverste kallet bærer fortsatt modellen (D-317), uendret
    expect(s.ambientModel).toBeUndefined();
    expect(s.ambientWithheld).toBe(false);
    expect(s.leaf).toEqual({ ctxModel: undefined, ambientModel: undefined, ambientWithheld: false });
    expect(s.finance).toEqual({ ok: true });
    expect(financeCalls.map((c) => c.context?.servingModel ?? null)).toEqual([null]);
  });

  it("nøkkelen fraværende (slik main.ts bygger valgene uten flagget: `...(enabled ? { financeExecutionLock } : {})`) og eksplisitt `undefined` er det samme", async () => {
    for (const [i, lockOptions] of [{} as ToolGatewayOptions, { financeExecutionLock: undefined } as never as ToolGatewayOptions].entries()) {
      const { gateway, financeCalls } = rig({ lockOptions });
      await call(gateway, `off-explicit-${i}`, 2, CLOUD);
      expect(financeCalls.length).toBe(1);
      expect(currentServingModel()).toBeUndefined();
    }
  });

  it("FIX-9: en løsrevet `execute` (uten `this`) AVVISES med et løfte - den kaster ikke synkront (som før N1b, da `execute` var `async`) - både uten og med lås", async () => {
    for (const [label, options] of [["vakt AV", {}], ["vakt PÅ", { lock: LOCK }]] as const) {
      const { gateway } = rig(options);
      const detached = gateway.execute as unknown as (request: unknown) => Promise<unknown>;
      let returned: Promise<unknown> | undefined;
      expect(() => { returned = detached({ identity, tool_id: "probe", action: "read", parameters: {}, idempotency_key: `k-${randomUUID()}` }); }, `${label}: kastet synkront`).not.toThrow();
      expect(returned, label).toBeInstanceOf(Promise);
      await expect(returned, label).rejects.toBeInstanceOf(TypeError);
    }
  });
});

describe("F: den ekte MeshToolExecutor (adapter-stemplet leverandør) gir skopet", () => {
  const mapping: MeshToolMapping = { def: { name: "probe__read", description: "probe", input_schema: { type: "object", properties: {} } }, tool_id: "probe", action: "read", parameters: () => ({ tag: "mesh", i: 1 }) };

  it("sky-stemplet kall via executoren: nøstet finansoppslag nektes; lokal-stemplet: utføres; blank leverandør (adapteren stemplet ingenting): nektes", async () => {
    for (const [label, provider, expectOk] of [["sky", "anthropic", false], ["lokal", "gemma_local", true], ["blank", "", false]] as const) {
      const { gateway, financeCalls, seen } = rig({ lock: LOCK });
      const executor = new MeshToolExecutor(gateway, identity, 20_000, [mapping]);
      const result = await executor.execute({ tool_call_id: `m-${label}`, tool_name: "probe__read", arguments: {}, provider, model: "m" }, { tenant_id: identity.tenant_id, idempotency_key: `k-${randomUUID()}` });
      expect(result.success, label).toBe(true);
      expect(seen.get("mesh")?.finance, label).toEqual(expectOk ? { ok: true } : { ok: false, reason: FINANCE_WITHHELD_REASON });
      expect(financeCalls.length, label).toBe(expectOk ? 1 : 0);
      expect(seen.get("mesh")?.leaf?.ambientModel, label).toEqual({ provider, model: "m" });
    }
  });

  it("modellens egne argumenter kan ikke sette skopet: `servingModel`/`provider` i arguments påvirker ikke (adapterens stempel gjelder)", async () => {
    const { gateway, financeCalls, seen } = rig({ lock: LOCK });
    const forged: MeshToolMapping = { ...mapping, parameters: () => ({ tag: "forged", i: 1, servingModel: { provider: "gemma_local", model: "x" }, provider: "gemma_local" }) };
    const executor = new MeshToolExecutor(gateway, identity, 20_000, [forged]);
    await executor.execute({ tool_call_id: "f1", tool_name: "probe__read", arguments: { servingModel: { provider: "gemma_local", model: "x" } }, provider: "anthropic", model: "claude" }, { tenant_id: identity.tenant_id, idempotency_key: `k-${randomUUID()}` });
    expect(seen.get("forged")?.leaf?.ambientModel).toEqual({ provider: "anthropic", model: "claude" });
    expect(seen.get("forged")?.finance).toEqual({ ok: false, reason: FINANCE_WITHHELD_REASON });
    expect(financeCalls).toEqual([]);
  });
});

describe("G: uleselige `servingModel`-former (fiks-runde 1, FIX-3): ALLE er sky (fail-lukket) - også `null`, som før var «ingen modell» for K2-leserne men sky for finanslåsen", () => {
  // [navn, verdi, holdes tilbake?]: kun et objekt med en leverandør registrert som lokal er lokal (modellen trenger ikke en gyldig `model`-streng); alt annet er sky
  const FORMS: Array<[string, unknown, boolean]> = [
    ["null", null, true], ["tom streng", "", true], ["0", 0, true], ["false", false, true], ["tom liste", [], true], ["tomt objekt", {}, true], ["streng med lokalt navn", "gemma_local", true],
    ["provider: tall", { provider: 5, model: "x" }, true], ["provider: blank", { provider: "   ", model: "x" }, true], ["provider: STORE bokstaver", { provider: "GEMMA_LOCAL", model: "x" }, true],
    ["provider: mellomrom foran", { provider: " gemma_local", model: "x" }, true], ["provider: null", { provider: null, model: "x" }, true], ["provider: undefined", { provider: undefined, model: "x" }, true],
    ["provider: tom", { provider: "", model: "x" }, true], ["sky", CLOUD, true], ["lokal", LOCAL, false], ["lokal uten `model`", { provider: "gemma_local" }, false]
  ];

  for (const [label, form, withheld] of FORMS) {
    it(`servingModel = ${label}: K2-leseren sier ${withheld ? "«hold tilbake»" : "«full tilgang»"}, og det nøstede finansoppslaget ${withheld ? "nektes" : "utføres"} (leser og lås er ENIGE)`, async () => {
      const { gateway, financeCalls, seen } = rig({ lock: LOCK });
      const r = await call(gateway, `g-${label}`, 1, form as never);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const entry = seen.get(`g-${label}`) as Seen;
      expect(entry.ambientWithheld, "den sentrale lesningen").toBe(withheld);
      expect(entry.leaf?.ambientWithheld, "bladkallet (nøstet) arver").toBe(withheld);
      expect(entry.finance, "det nøstede finansoppslaget").toEqual(withheld ? { ok: false, reason: FINANCE_WITHHELD_REASON } : { ok: true });
      expect(financeCalls.length).toBe(withheld ? 0 : 1);
    });

    it(`servingModel = ${label}: et DIREKTE finansoppslag med samme verdi ${withheld ? "nektes" : "utføres"} (kontroll: låsen har alltid vært fail-lukket)`, async () => {
      const { gateway, financeCalls } = rig({ lock: LOCK });
      const r = await gateway.execute({ identity, tool_id: "finance", action: "get_kill_switch", parameters: {}, idempotency_key: `k-${randomUUID()}`, servingModel: form as never });
      expect(r.ok, JSON.stringify(r)).toBe(!withheld);
      expect(financeCalls.length).toBe(withheld ? 0 : 1);
    });
  }
});

describe("H: setteren er IKKE offentlig API (fiks-runde 1, FIX-4): kun lesere og typer eksporteres fra pakken", () => {
  it("`@jarvis/tool-gateway` eksporterer lesehjelperne, men ikke `runWithModelScope` - en trusted modul kan ikke vaske skopet med `{ cloud: false }` inne i et skykall", async () => {
    const api = (await import("@jarvis/tool-gateway")) as Record<string, unknown>;
    for (const reader of ["currentModelScope", "currentServingModel", "withholdFinanceFromCurrentModel"]) expect(typeof api[reader], reader).toBe("function");
    expect("runWithModelScope" in api, "setteren er offentlig API").toBe(false);
  });
});
