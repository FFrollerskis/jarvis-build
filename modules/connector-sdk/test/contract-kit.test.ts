import { describe, expect, it } from "vitest";
import { deriveSkeletonManifests, isUnknown, productionConnectorDefinitions, validateConnectorManifest, type ConnectorManifest } from "../src/index.ts";
import {
  CONTRACT_CHECK_IDS, FAKE_CREDENTIAL_CANARY, FAKE_DEFECTS, INJECTION_PAYLOAD, VirtualClock, createFakeConnector, errorLabel, messageOf, runConnectorContract, secretShapes, scoreAcceptance,
  type ContractReport, type FakeDefect
} from "../src/testing.ts";
import { adapterKindOf, brandRealTransportAdapter } from "../src/contract/provenance.ts";
import { ACME_KEYS, secretShapedActionKeys, validFullManifest, validSkeletonManifest } from "./fixtures.ts";

const failedIds = (r: ContractReport) => r.checks.filter((c) => c.status === "fail").map((c) => c.id);
const statusOf = (r: ContractReport, id: string) => r.checks.find((c) => c.id === id)?.status;
const run = (manifest: ConnectorManifest, defects: readonly FakeDefect[] = []) => runConnectorContract(manifest, createFakeConnector({ manifest, defects }));
const withDeferredD = (): ConnectorManifest => {
  const m = validFullManifest();
  const a = m.actions.find((x) => x.key === ACME_KEYS.setting)!;
  a.reversibility.evidence = { before_state: false, postcondition: "none" };
  a.reversibility.class_d_chain = { status: "deferred", missing: ["fresh_state_read", "postcondition"] };
  return m;
};

describe("kittet mot en korrekt fake: hver sjekk består (ingen feil) og ingenting regnes bestått ved å hoppe over", () => {
  it("alle sjekkene i kittet kjører og består for et fullt manifest", async () => {
    const r = await run(validFullManifest());
    expect(r.checks.map((c) => c.id)).toEqual([...CONTRACT_CHECK_IDS]);
    expect(r.checks.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.detail ?? ""} ${(c.subjects ?? []).join("; ")}`)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.failed).toBe(0);
    expect(r.passed + r.skipped).toBe(CONTRACT_CHECK_IDS.length);
    // Alle sjekkene har noe å teste i dette manifestet (skrivehandlinger, påkrevde parametre, klasse D, delegert modus, reversible handlinger).
    expect(r.skipped).toBe(0);
  });

  it("kjører på virtuell tid: ingen ekte ventetid (tidsavbrudd på 10 s x 10 simuleres på millisekunder)", async () => {
    const t0 = Date.now();
    await run(validFullManifest());
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("et skeleton kan kjøres: ukjente felt gir `skip` med årsak (aldri bestått), og kittet feiler ikke", async () => {
    const r = await run(validSkeletonManifest());
    expect(r.failed).toBe(0);
    expect(statusOf(r, "authority.delegated")).toBe("skip");
    expect(statusOf(r, "data.delete_semantics_declared")).toBe("skip");
    expect(statusOf(r, "idempotency.same_key_one_effect")).toBe("pass");
  });

  it("en ren lese-connector hopper over alle nivå A-sjekker med årsak, og får nivå R i scoring", async () => {
    const m = validFullManifest();
    m.actions = m.actions.filter((a) => a.effect === "read");
    m.capabilities.write = { status: "provider_limited" }; m.capabilities.actions = { status: "provider_limited" };
    m.idempotency = { dedupe_key: "none", retry_semantics: { on_timeout: "safe_retry", on_rate_limit: "retry_after", on_server_error: "safe_retry" }, exactly_once_target: "not_applicable" };
    delete (m.authority as Record<string, unknown>)["approval_policy"];
    m.auth.scopes.provider = [{ scope: "tasks:read", needed_for: [ACME_KEYS.list] }];
    m.data.delete_semantics = { provider_side: "not_offered", jarvis_side: "revisjon beholdes; leverandøren tilbyr ikke sletting" };
    m.d41_audit = {
      classification: "READ_ONLY", read_only_reason: "provider_offers_nothing",
      read: { provider_offers: "yes", implemented: "full", action_keys: [ACME_KEYS.list] }, write: { provider_offers: "no", implemented: "none", action_keys: [] },
      delete: { provider_offers: "no", implemented: "none", action_keys: [] }, access_control: { provider_offers: "no", implemented: "none", action_keys: [] },
      scopes_verified_against_docs: true, unverified_scopes: [], verified_on: "2026-11-14", docs_reference: ["Acme API (fiktiv)"], gaps: []
    };
    m.operations.timeout = { max_ms: 10_000 };
    const r = await run(m);
    expect(r.failed).toBe(0);
    expect(r.checks.filter((c) => c.level === "A").every((c) => c.status === "skip")).toBe(true);
    expect(r.checks.find((c) => c.level === "A")?.detail).toContain("nivå R");
    expect(r.acceptance.required_level).toBe("R");
    expect(r.acceptance.items.every((i) => i.level === "R")).toBe(true);
  });
});

describe("MUTASJONSTESTER: hver defekt i fakeen feller NØYAKTIG de kontraktsegenskapene den bryter (ikke mer, ikke mindre)", () => {
  /**
   * Hver rad: defekten og den EKSAKTE mengden sjekker den feller (sortert sammenligning, `toEqual` - ikke `toContain`). Første id er egenskapen defekten bryter; resten er følgefeil som er legitime fordi sjekkene
   * bygger på samme egenskap (f.eks. avhenger rollback, gjentakelse etter ukjent utfall og nøkkelgjenbruk alle av idempotens-ledgeren, så `no_dedupe` feller dem også). Endres kittet, må tabellen endres bevisst.
   */
  const cases: Array<[FakeDefect, string[]]> = [
    ["no_dedupe", ["idempotency.same_key_one_effect", "idempotency.key_reuse_other_payload", "timeout.after_effect_unknown_not_replayed", "errors.write_5xx_is_outcome_unknown", "recovery.rollback_restores_state"]],
    ["required_key_not_enforced", ["idempotency.required_key_enforced"]],
    ["params_not_validated", ["params.validated_before_provider"]],
    ["wrong_trust_label", ["trust.labelling", "trust.injection_is_data"]],
    ["leaks_credential", ["audit.no_secret_values", "redaction.no_secret_shapes"]],
    ["no_redaction", ["redaction.no_secret_shapes"]],
    ["health_never_degrades", ["health.degrades_and_recovers"]],
    ["ignores_abort", ["timeout.abort", "timeout.after_effect_unknown_not_replayed", "timeout.before_effect_applies_nothing"]],
    ["timeout_masks_as_ok", ["timeout.abort", "timeout.after_effect_unknown_not_replayed", "timeout.before_effect_applies_nothing"]],
    ["no_evidence", ["evidence.before_after", "classd.chain_and_notification"]],
    ["cross_tenant_allowed", ["authority.tenant_isolation"]],
    ["delegated_allowed", ["authority.delegated"]],
    ["pause_ignored", ["control.pause_blocks_all"]],
    ["revoke_ignored", ["revoke.and_reauth"]],
    ["no_notification", ["classd.chain_and_notification"]],
    ["auth_reported_as_other", ["errors.taxonomy", "health.degrades_and_recovers"]],
    ["unknown_outcome_replay_executes", ["timeout.after_effect_unknown_not_replayed", "errors.write_5xx_is_outcome_unknown"]],
    ["compensate_noop", ["recovery.rollback_restores_state"]],
    ["key_reuse_executes", ["idempotency.key_reuse_other_payload"]],
    ["provider_text_in_control_field", ["trust.injection_is_data", "redaction.no_secret_shapes"]],
    // Review M4 - de fem subtilt gale adapterne (+ 5xx) og de to sjekkene uten innebygd mutant:
    ["key_reuse_returns_stale", ["idempotency.key_reuse_other_payload"]],
    ["leaks_credential_in_rate_limit", ["redaction.no_secret_shapes"]],
    ["leaks_credential_in_server_error", ["redaction.no_secret_shapes"]],
    ["leaks_credential_in_timeout", ["redaction.no_secret_shapes"]],
    ["evidence_before_is_after", ["evidence.before_after"]],
    ["validates_only_first_required", ["params.validated_before_provider"]],
    ["dedupe_before_authority", ["authority.tenant_isolation", "control.pause_blocks_all", "revoke.and_reauth", "idempotency.key_reuse_other_payload"]],
    ["server_error_not_unknown", ["errors.write_5xx_is_outcome_unknown"]],
    ["read_has_effect", ["read.returns_data"]],
    ["dedupe_ignores_key", ["idempotency.distinct_keys_distinct_effects", "idempotency.same_key_one_effect", "idempotency.key_reuse_other_payload", "timeout.after_effect_unknown_not_replayed", "timeout.before_effect_applies_nothing", "errors.write_5xx_is_outcome_unknown", "authority.delegated", "recovery.rollback_restores_state", "classd.chain_and_notification"]]
  ];
  it.each(cases)("%s", async (defect, expected) => {
    const r = await run(validFullManifest(), [defect]);
    expect([...failedIds(r)].sort(), `${defect} burde felle nøyaktig ${expected.join(", ")}; feilet: ${failedIds(r).join(", ")}`).toEqual([...expected].sort());
    expect(failedIds(r)).toContain(expected[0]);
    expect(r.ok).toBe(false);
  });

  it("deferred_chain_executes: en ufullstendig klasse D-kjede som likevel kan utføres feller klasse D-sjekken", async () => {
    const m = withDeferredD();
    expect(failedIds(await run(m))).toEqual([]);
    expect(failedIds(await run(m, ["deferred_chain_executes"]))).toContain("classd.chain_and_notification");
  });

  it("hver defekt i FAKE_DEFECTS er dekket av en test (ingen defekt uten en kontraktsegenskap som feller den)", () => {
    expect([...cases.map(([d]) => d), "deferred_chain_executes"].sort()).toEqual([...FAKE_DEFECTS].sort());
  });

  it("uten defekter feiler ingen av de sjekkene (kontroll: mutantene feller dem av riktig grunn, ikke fordi sjekken er skjør)", async () => {
    expect(failedIds(await run(validFullManifest()))).toEqual([]);
  });

  it("en adapter som kaster i stedet for å returnere en feil, eller har feil handlingsmengde, feller sjekkene", async () => {
    const m = validFullManifest();
    const good = createFakeConnector({ manifest: m });
    const thrower = { ...good, invoke: async () => { throw new Error("boom"); } } as unknown as typeof good;
    const t = await runConnectorContract(m, thrower);
    expect(t.ok).toBe(false);
    expect(t.checks.some((c) => c.status === "fail" && /kastet/.test(`${c.detail ?? ""} ${(c.subjects ?? []).join(" ")}`))).toBe(true);
    const missing = { ...good, actions: good.actions.slice(1) } as unknown as typeof good;
    const mm = await runConnectorContract(m, missing);
    expect(failedIds(mm)).toContain("manifest.adapter_matches");
    const wrongId = { ...good, connector_id: "other" } as unknown as typeof good;
    expect(failedIds(await runConnectorContract(m, wrongId))).toContain("manifest.adapter_matches");
  });

  it("et ugyldig manifest og et manifest med hemmelighetsform feller manifest-sjekkene", async () => {
    const bad = validFullManifest();
    bad.secrets.refs[0]!.ref = secretShapes()[0]!;
    const r = await run(bad);
    expect(failedIds(r)).toEqual(expect.arrayContaining(["manifest.valid", "manifest.secret_scan"]));
    expect(JSON.stringify(r).includes(secretShapes()[0]!)).toBe(false);
  });
});

describe("review M4: subtilt gale adaptere bygget UTENFRA (wrappere rundt en korrekt adapter, som i reviewens eksperimenter) feller nøyaktig de sjekkene som skal", () => {
  const manifest = validFullManifest();
  const base = () => createFakeConnector({ manifest });
  type Adapter = ReturnType<typeof base>;
  type Req = Parameters<Adapter["invoke"]>[0];
  const wrap = (b: Adapter, invoke: (req: Req) => ReturnType<Adapter["invoke"]>): Adapter => ({ ...b, invoke });
  const failedWith = async (adapter: Adapter): Promise<string[]> => [...failedIds(await runConnectorContract(manifest, adapter))].sort();

  it("kontroll: den korrekte adapteren feller ingenting (og wrapper-mekanikken endrer ingenting)", async () => {
    const b = base();
    expect(await failedWith(wrap(b, (req) => b.invoke(req)))).toEqual([]);
  });

  it("(1)+(5) ledgeren slår opp på nøkkelen alene, FØR nyttelast- og tenant-sjekk: annen nyttelast gir gammelt ok:true+deduplicated:true, og en fremmed tenant får eierens resultat", async () => {
    const staleByKey = (): { b: Adapter; a: Adapter } => {
      const b = base();
      const cache = new Map<string, Awaited<ReturnType<Adapter["invoke"]>>>();
      const a = wrap(b, async (req) => {
        const k = req.idempotency_key;
        if (k !== undefined && cache.has(k)) return { ...cache.get(k)!, deduplicated: true } as never;
        const r = await b.invoke(req);
        if (k !== undefined && r.ok) cache.set(k, r);
        return r;
      });
      return { b, a };
    };
    // Manuelt bevis på feilen (som i reviewen): annen nyttelast under samme nøkkel gir det gamle resultatet, og en fremmed tenant får eierens resultat.
    const { b, a } = staleByKey();
    const own = await a.invoke({ action: ACME_KEYS.create, parameters: b.sampleParameters(ACME_KEYS.create), idempotency_key: "shared", identity: b.identities.owner });
    const stale = await a.invoke({ action: ACME_KEYS.create, parameters: { title: "HELT ANNEN NYTTELAST" }, idempotency_key: "shared", identity: b.identities.owner });
    const foreign = await a.invoke({ action: ACME_KEYS.create, parameters: b.sampleParameters(ACME_KEYS.create), idempotency_key: "shared", identity: b.identities.foreign_tenant });
    expect(own.ok && stale.ok && stale.deduplicated).toBe(true);
    expect(foreign.ok && foreign.external_id).toBe(own.ok && own.external_id);
    // Kittet feller nøyaktig egenskapene som brytes (nøkkelgjenbruk, tenant, og gjentakelse under pause/tilbakekall):
    expect(await failedWith(staleByKey().a)).toEqual(["authority.tenant_isolation", "control.pause_blocks_all", "idempotency.key_reuse_other_payload", "revoke.and_reauth"]);
  });

  it("(2) credential ekkoet i 429-feilen (kittet skannet før bare auth/nettverk/ugyldig)", async () => {
    const b = base();
    const a = wrap(b, async (req) => {
      const r = await b.invoke(req);
      return !r.ok && r.error.category === "rate_limit" ? { ok: false, error: { ...r.error, message: `${r.error.message} Authorization=${b.credentialCanary()}` } } : r;
    });
    expect(await failedWith(a)).toEqual(["redaction.no_secret_shapes"]);
  });

  it("(3) før-evidensen er lik etter-evidensen (lest etter effekten) selv om tilstanden endret seg", async () => {
    const b = base();
    const a = wrap(b, async (req) => {
      const r = await b.invoke(req);
      return r.ok && r.evidence !== undefined && r.evidence.after !== null ? { ...r, evidence: { before: r.evidence.after, after: r.evidence.after } } : r;
    });
    expect(await failedWith(a)).toEqual(["evidence.before_after"]);
  });

  it("(4) adapteren setter stille en standardverdi for andre og senere påkrevde parametre (kittet fjernet bare den første)", async () => {
    const b = base();
    const a = wrap(b, async (req) => {
      const act = manifest.actions.find((x) => x.key === req.action);
      const required = act !== undefined && Array.isArray(act.data.input_required) ? act.data.input_required : [];
      const params = { ...req.parameters };
      for (const r of required.slice(1)) if (params[r] === undefined) params[r] = "silent-default";
      return b.invoke({ ...req, parameters: params });
    });
    expect(await failedWith(a)).toEqual(["params.validated_before_provider"]);
  });

  it("(6) 5xx på en skriving rapporteres som retry-bar leverandørfeil i stedet for ukjent utfall", async () => {
    const b = base();
    const a = wrap(b, async (req) => {
      const r = await b.invoke(req);
      return !r.ok && r.error.code === "outcome_unknown" && r.error.category === "network" ? { ok: false, error: { ...r.error, code: "provider_server_error", retryable: true } } : r;
    });
    expect(await failedWith(a)).toEqual(["errors.write_5xx_is_outcome_unknown"]);
  });

  it("effekt utført selv om kallet gikk ut på tid FØR leverandøren handlet (avbrudd skal ikke gi en effekt)", async () => {
    const b = base();
    let slowBefore = false;
    const a = { ...wrap(b, async (req) => {
      const act = manifest.actions.find((x) => x.key === req.action);
      if (slowBefore && act !== undefined && act.effect !== "read") {
        b.injectFault(null);
        await b.invoke(req);
        b.injectFault({ kind: "slow", ms: 99_999, effect: "before" });
        return { ok: false, error: { category: "timeout", code: "timeout", message: "aborted", retryable: true } };
      }
      return b.invoke(req);
    }), injectFault: (f: Parameters<Adapter["injectFault"]>[0]) => { slowBefore = f !== null && f.kind === "slow" && f.effect === "before"; b.injectFault(f); } };
    expect(await failedWith(a)).toEqual(["timeout.before_effect_applies_nothing"]);
  });

  it("SLUTT: hver sjekk i kittet kan feile (ingen vakuøse sjekker): hver er felt av minst én defekt eller manifest-/adaptermutasjon", async () => {
    const failedByDefects = new Set<string>();
    for (const d of FAKE_DEFECTS) for (const id of failedIds(await run(withDeferredD(), [d]))) failedByDefects.add(id);
    for (const d of FAKE_DEFECTS) for (const id of failedIds(await run(validFullManifest(), [d]))) failedByDefects.add(id);
    // Manifest-nivå-sjekkene har ingen fake-defekt; de felles av mutasjoner av manifestet/adapteren (testet over og her).
    const emptyDelete = validFullManifest();
    (emptyDelete.data.delete_semantics as { jarvis_side: string }).jarvis_side = "";
    for (const id of failedIds(await run(emptyDelete))) failedByDefects.add(id);
    const secretRef = validFullManifest();
    secretRef.secrets.refs[0]!.ref = secretShapes()[0]!;
    for (const id of failedIds(await run(secretRef))) failedByDefects.add(id);
    const g = base();
    for (const id of failedIds(await runConnectorContract(validFullManifest(), { ...g, actions: g.actions.slice(1) } as unknown as typeof g))) failedByDefects.add(id);
    expect(CONTRACT_CHECK_IDS.filter((id) => !failedByDefects.has(id))).toEqual([]);
  });
});

describe("review M4: fakeen modellerer en 5xx på en SKRIVING som ukjent utfall (aldri en retry-bar nettverksfeil), og en 5xx på en lesing som vanlig nettverksfeil", () => {
  it("skriving: outcome_unknown, ikke retry-bar, helse unavailable; samme nøkkel etter fjernet feil gir aldri en ny effekt og krever avstemming", async () => {
    const f = createFakeConnector({ manifest: validFullManifest() });
    const params = f.sampleParameters(ACME_KEYS.create);
    f.injectFault({ kind: "server" });
    const first = await f.invoke({ action: ACME_KEYS.create, parameters: params, idempotency_key: "s1", identity: f.identities.owner });
    f.injectFault(null);
    expect(!first.ok && [first.error.category, first.error.code, first.error.retryable]).toEqual(["network", "outcome_unknown", false]);
    expect(f.health()?.state).toBe("unavailable");
    const again = await f.invoke({ action: ACME_KEYS.create, parameters: params, idempotency_key: "s1", identity: f.identities.owner });
    expect(!again.ok && again.error.code).toBe("outcome_unknown");
    expect(f.effects(ACME_KEYS.create)).toBe(0);
    // Uten nøkkel finnes ingen ledger å avstemme mot, men utfallet meldes fortsatt som ukjent.
    f.injectFault({ kind: "server" });
    const noKey = await f.invoke({ action: ACME_KEYS.create, parameters: params, identity: f.identities.owner });
    expect(!noKey.ok && noKey.error.code).toBe("outcome_unknown");
  });

  it("lesing: vanlig, retry-bar nettverksfeil (ingenting å miste ved å prøve igjen)", async () => {
    const f = createFakeConnector({ manifest: validFullManifest() });
    f.injectFault({ kind: "server" });
    const r = await f.invoke({ action: ACME_KEYS.list, parameters: f.sampleParameters(ACME_KEYS.list), identity: f.identities.owner });
    expect(!r.ok && [r.error.category, r.error.code, r.error.retryable]).toEqual(["network", "provider_server_error", true]);
  });

  it("kittet har sjekken, og et manifest med bare lese-handlinger hopper den over med årsak (aldri bestått)", async () => {
    expect(CONTRACT_CHECK_IDS).toContain("errors.write_5xx_is_outcome_unknown");
    const readOnly = validFullManifest();
    readOnly.actions = readOnly.actions.filter((a) => a.effect === "read");
    const r = await runConnectorContract(readOnly, createFakeConnector({ manifest: readOnly }));
    expect(statusOf(r, "errors.write_5xx_is_outcome_unknown")).toBe("skip");
  });
});

describe("review M4: adapter_kind - en fake bygget fra manifestet kan aldri gi «proven»; kun en ekte transport kan", () => {
  it("harnessen er fake_from_manifest, rapporten bærer det (kit og akseptanse), og alle kit-bevis er «modelled» - ingen «proven» uansett hvor mange sjekker som består", async () => {
    const m = validFullManifest();
    const f = createFakeConnector({ manifest: m });
    expect(f.adapter_kind).toBe("fake_from_manifest");
    const r = await run(m);
    expect(r.adapter_kind).toBe("fake_from_manifest");
    expect(r.acceptance.adapter_kind).toBe("fake_from_manifest");
    expect(r.acceptance.summary.proven).toBe(0);
    expect(r.acceptance.summary.modelled).toBeGreaterThan(5);
    expect(r.acceptance.items.filter((i) => i.status === "modelled").every((i) => i.evidence.includes("modellert"))).toBe(true);
  });

  it("scoreAcceptance (ren funksjon, kallerens påstand): samme sjekkresultater gir «proven» KUN når kalleren oppgir real_transport; manglende eller ukjent proveniens er fake (fail-safe) - runConnectorContract utleder den av branden (N3)", async () => {
    const m = validFullManifest();
    const r = await run(m);
    const statuses = (kind?: Parameters<typeof scoreAcceptance>[2]) => scoreAcceptance(m, r.checks, kind).items.map((i) => `${i.id}:${i.status}`);
    const real = scoreAcceptance(m, r.checks, "real_transport");
    expect(real.adapter_kind).toBe("real_transport");
    expect(real.summary.proven).toBeGreaterThan(5);
    expect(real.summary.modelled).toBe(0);
    expect(statuses("real_transport").map((x) => x.replace(":proven", ":modelled"))).toEqual(statuses("fake_from_manifest"));
    expect(statuses()).toEqual(statuses("fake_from_manifest"));
    expect(statuses("bogus" as never)).toEqual(statuses("fake_from_manifest"));
  });

  it("review N3: en KOPI av en fake med adapter_kind: real_transport gir ALDRI proven (spread, Object.create, Proxy, Object.assign, endret felt) - feltet er en påstand, ikke et bevis", async () => {
    const m = validFullManifest();
    const f = createFakeConnector({ manifest: m });
    const spoofs: Array<[string, () => typeof f]> = [
      ["spread (reviewens reprodusjon)", () => ({ ...f, adapter_kind: "real_transport" }) as unknown as typeof f],
      ["Object.create", () => Object.create(f, { adapter_kind: { value: "real_transport", enumerable: true } }) as typeof f],
      ["Proxy", () => new Proxy(f, { get: (t, k, r) => (k === "adapter_kind" ? "real_transport" : Reflect.get(t, k, r)) })],
      ["Object.assign", () => Object.assign(Object.create(null) as object, f, { adapter_kind: "real_transport" }) as typeof f],
      ["feltet endret på fakeen selv", () => { const g = createFakeConnector({ manifest: m }); (g as { adapter_kind: string }).adapter_kind = "real_transport"; return g; }]
    ];
    for (const [label, make] of spoofs) {
      const spoofed = make();
      expect(spoofed.adapter_kind, label).toBe("real_transport"); // påstanden er faktisk satt - og likevel:
      const r = await runConnectorContract(m, spoofed);
      expect(r.adapter_kind, label).toBe("fake_from_manifest");
      expect(r.acceptance.adapter_kind, label).toBe("fake_from_manifest");
      expect(r.acceptance.summary.proven, label).toBe(0);
      expect(r.acceptance.summary.modelled, label).toBeGreaterThan(5);
    }
  });

  it("review N3: kun en adapter MERKET av den modul-private branden (og med feltet) gir proven; merket uten feltet, eller feltet uten merke, er fake - og en manglende/ukjent verdi er fake", async () => {
    const m = validFullManifest();
    const f = createFakeConnector({ manifest: m });
    const branded = brandRealTransportAdapter({ ...f, adapter_kind: "real_transport" } as unknown as typeof f);
    const real = await runConnectorContract(m, branded);
    expect(real.adapter_kind).toBe("real_transport");
    expect(real.acceptance.adapter_kind).toBe("real_transport");
    expect(real.acceptance.summary.proven).toBeGreaterThan(5);
    expect(real.acceptance.summary.modelled).toBe(0);
    // Begge kravene må være oppfylt: merket alene (feltet sier fake) er ikke nok.
    const brandedButFake = brandRealTransportAdapter({ ...f } as typeof f);
    expect((await runConnectorContract(m, brandedButFake)).adapter_kind).toBe("fake_from_manifest");
    expect(adapterKindOf(branded)).toBe("real_transport");
    expect(adapterKindOf({ ...branded })).toBe("fake_from_manifest"); // en kopi av den merkede er ikke merket
    for (const odd of [null, undefined, "real_transport", 42, {}]) expect(adapterKindOf(odd), String(odd)).toBe("fake_from_manifest");
    const missing = { ...f } as Record<string, unknown>;
    delete missing["adapter_kind"];
    expect((await runConnectorContract(m, missing as unknown as typeof f)).adapter_kind).toBe("fake_from_manifest");
    expect((await runConnectorContract(m, { ...f, adapter_kind: "whatever" } as unknown as typeof f)).adapter_kind).toBe("fake_from_manifest");
  });

  it("verdiktet er uendret (gaps / live_evidence_pending / complete_on_paper) - modelled er ikke «live», og ingenting heter VERIFIED", async () => {
    const m = validFullManifest();
    m.operations.circuit_breaker = { status: "implemented", mechanism: "automatisk bryter (fiktiv)" };
    m.tests.live_smoke = { status: "present", paths: ["modules/connector-sdk/test/fixtures.ts"] };
    const r = await run(m);
    expect(r.acceptance.verdict).toBe("complete_on_paper");
    expect(JSON.stringify(r.acceptance)).not.toContain("VERIFIED");
    expect(JSON.stringify(r.acceptance)).not.toContain('"status":"proven"');
  });
});

describe("review N1: ingen vakuøse pass når connectoren bare har utsatte klasse D-skrivehandlinger (executableWrites er tom)", () => {
  /** De seks sjekkene som løper over `executableWrites` og før ga `pass` med null kall (reviewens :383, :400, :484, :509, :530, :582). */
  const OVER_EXECUTABLE_WRITES = [
    "idempotency.same_key_one_effect", "idempotency.distinct_keys_distinct_effects", "timeout.after_effect_unknown_not_replayed",
    "timeout.before_effect_applies_nothing", "errors.write_5xx_is_outcome_unknown", "authority.delegated"
  ] as const;
  /** Et GYLDIG manifest der den eneste skrivehandlingen er en utsatt klasse D (lesing + `acme.update_setting` uten komplett kjede) - slik microsoft_outlook og zapier ligger i registeret. */
  const onlyDeferredWrite = (): ConnectorManifest => {
    const m = withDeferredD();
    m.actions = m.actions.filter((a) => a.key === ACME_KEYS.list || a.key === ACME_KEYS.setting);
    m.capabilities.actions = { status: "not_implemented" };
    m.auth.scopes.provider = [{ scope: "tasks:read", needed_for: [ACME_KEYS.list] }, { scope: "tasks:write", needed_for: [ACME_KEYS.setting] }];
    m.d41_audit = {
      classification: "PARTIAL",
      read: { provider_offers: "yes", implemented: "full", action_keys: [ACME_KEYS.list] }, write: { provider_offers: "yes", implemented: "partial", action_keys: [ACME_KEYS.setting] },
      delete: { provider_offers: "yes", implemented: "none", action_keys: [] }, access_control: { provider_offers: "yes", implemented: "none", action_keys: [] },
      scopes_verified_against_docs: true, unverified_scopes: [], verified_on: "2026-11-14", docs_reference: ["Acme API-referanse (fiktiv)"],
      gaps: [{ capability: "klasse D-kjeden", status: "DEFERRED", reason: "kjeden er ikke komplett" }]
    };
    return m;
  };
  const executableWritesOf = (m: ConnectorManifest) => m.actions.filter((a) => a.effect !== "read" && !(a.authority.risk_class === "D" && a.reversibility.class_d_chain?.status === "deferred"));
  const itemStatus = (r: ContractReport, id: string) => r.acceptance.items.find((i) => i.id === id)?.status;

  it("kontroll: fixturen er et gyldig manifest, og den eneste skrivehandlingen er en utsatt klasse D", () => {
    const m = onlyDeferredWrite();
    expect(validateConnectorManifest(m).issues).toEqual([]);
    expect(m.actions.filter((a) => a.effect !== "read").map((a) => a.key)).toEqual([ACME_KEYS.setting]);
    expect(executableWritesOf(m)).toEqual([]);
  });

  it("de seks sjekkene hopper over med årsak (aldri pass), og A.idempotency_replay er not_proven - ALDRI modelled", async () => {
    const r = await run(onlyDeferredWrite());
    expect(r.failed).toBe(0);
    for (const id of OVER_EXECUTABLE_WRITES) {
      expect(statusOf(r, id), id).toBe("skip");
      expect(r.checks.find((c) => c.id === id)?.detail, id).toContain("utførbare skrivehandlinger");
    }
    expect(itemStatus(r, "A.idempotency_replay")).toBe("not_proven");
    expect(r.acceptance.items.find((i) => i.id === "A.idempotency_replay")?.evidence).toContain("hoppet over");
    // Kravene som hviler på en hoppet over sjekk er heller ikke modellert:
    expect(itemStatus(r, "A.authority_target_resolution")).toBe("not_proven");
    expect(itemStatus(r, "A.param_validation_state_readback")).toBe("not_proven");
    expect(itemStatus(r, "A.before_after_evidence")).toBe("not_proven");
    expect(r.acceptance.summary.proven).toBe(0);
  });

  it("sjekkene som FORTSATT har noe å kjøre, kjører og består (lesing, og den utsatte klasse D-kjeden bevises utilgjengelig) - de hoppes ikke over", async () => {
    const r = await run(onlyDeferredWrite());
    for (const id of ["classd.chain_and_notification", "authority.tenant_isolation", "control.pause_blocks_all", "trust.labelling", "read.returns_data", "revoke.and_reauth"]) expect(statusOf(r, id), id).toBe("pass");
    expect(itemStatus(r, "A.classd_snapshot_notification")).toBe("gap");
  });

  it("kontroll: de samme sjekkene kjører og består (ingen hopp) så snart connectoren har en utførbar skrivehandling", async () => {
    const r = await run(withDeferredD());
    for (const id of OVER_EXECUTABLE_WRITES) expect(statusOf(r, id), id).toBe("pass");
    expect(itemStatus(r, "A.idempotency_replay")).toBe("modelled");
  });

  it("uten noe å prøve (verken lesing eller utførbar skriving) hopper også de generelle sjekkene over i stedet for å bestå tomt", async () => {
    const m = onlyDeferredWrite();
    m.actions = m.actions.filter((a) => a.key === ACME_KEYS.setting);
    m.capabilities.read = { status: "not_implemented" };
    m.trust.output = { class: "internal" };
    m.trust.injection_exposure = { level: "possible", note: "ingen lesehandlinger; innstillingen skrives bare" };
    m.operations.health_check = { method: "none", action_key: null };
    m.auth.scopes.provider = [{ scope: "tasks:write", needed_for: [ACME_KEYS.setting] }];
    if (!isUnknown(m.d41_audit)) { m.d41_audit.read = { provider_offers: "yes", implemented: "none", action_keys: [] }; }
    expect(validateConnectorManifest(m).issues).toEqual([]);
    const r = await run(m);
    expect(r.failed).toBe(0);
    for (const id of ["trust.labelling", "authority.tenant_isolation", "control.pause_blocks_all", ...OVER_EXECUTABLE_WRITES]) expect(statusOf(r, id), id).toBe("skip");
    expect(statusOf(r, "classd.chain_and_notification")).toBe("pass");
  });

  it("reviewens reprodusjon: skeletonene for microsoft_outlook og zapier (bare en utsatt klasse D-skriving) gir not_proven for idempotens - ikke modelled", async () => {
    const skeletons = new Map(deriveSkeletonManifests({ definitions: productionConnectorDefinitions() }).map((m) => [m.identity.id, m]));
    for (const id of ["microsoft_outlook", "zapier"]) {
      const m = skeletons.get(id)!;
      // Forutsetningen for reproduksjonen (endres den når en klasse D-kjede fullføres, er det bra - da gjelder den syntetiske fixturen over):
      if (m.actions.some((a) => a.effect !== "read") && executableWritesOf(m).length === 0) {
        const r = await run(m);
        expect(r.failed, id).toBe(0);
        for (const check of OVER_EXECUTABLE_WRITES) expect(statusOf(r, check), `${id} ${check}`).toBe("skip");
        expect(itemStatus(r, "A.idempotency_replay"), id).toBe("not_proven");
      }
    }
  });

  it("invariant over ALLE avledede skeletons: kittet feller ingen (ukjent er skip, aldri fail), og idempotens er aldri modelled uten en utførbar skrivehandling", async () => {
    for (const m of deriveSkeletonManifests({ definitions: productionConnectorDefinitions() })) {
      const r = await run(m);
      expect(failedIds(r), m.identity.id).toEqual([]);
      if (itemStatus(r, "A.idempotency_replay") === "modelled") expect(executableWritesOf(m).length, m.identity.id).toBeGreaterThan(0);
    }
  });

  it("scoring alene: en hoppet over idempotenssjekk (bortsett fra de to med legitim hopp-over) kan aldri gi modelled", async () => {
    const m = validFullManifest();
    const r = await run(m);
    const withSkipped = (ids: readonly string[]) => scoreAcceptance(m, r.checks.map((c) => (ids.includes(c.id) ? { ...c, status: "skip" as const } : c))).items.find((i) => i.id === "A.idempotency_replay")?.status;
    expect(withSkipped([])).toBe("modelled");
    expect(withSkipped(["idempotency.required_key_enforced", "idempotency.key_reuse_other_payload"])).toBe("modelled");
    for (const id of OVER_EXECUTABLE_WRITES.filter((x) => x.startsWith("idempotency.") || x.startsWith("timeout.") || x.startsWith("errors."))) expect(withSkipped([id]), id).toBe("not_proven");
    expect(withSkipped(["idempotency.same_key_one_effect", "idempotency.required_key_enforced"])).toBe("not_proven");
  });
});

describe("review N4/N7: kittet kaster aldri, og unntakstekst redigeres FØR den kuttes", () => {
  const good = () => createFakeConnector({ manifest: validFullManifest() });
  const withThrowingSampleParameters = (thrown: unknown) => ({ ...good(), sampleParameters: () => { throw thrown; } }) as unknown as ReturnType<typeof good>;

  it("N4: et token som krysser 120-tegnskuttet (≥ 9 tegn av det før kuttet) lekker ikke et prefiks - redigering skjer før kutt", async () => {
    // Token starter ved tegn 108 i meldingen, så et kutt ved 120 uten forutgående redigering ville latt «ghp_a1a1a1a1» stå (12 tegn, under skannerens 20-tegns minimum).
    const token = secretShapes()[0]!;
    const message = `${"x".repeat(107)} ${token} ${"y".repeat(40)}`;
    expect(message.indexOf(token)).toBe(108);
    expect(message.slice(0, 120).includes(token.slice(0, 12))).toBe(true); // forutsetningen: et rå kutt etterlater prefikset
    for (const prefixLen of [9, 12, 19]) {
      const m = validFullManifest();
      const r = await runConnectorContract(m, withThrowingSampleParameters(new Error(message)));
      const json = JSON.stringify(r);
      expect(json.includes(token.slice(0, prefixLen)), `prefiks på ${prefixLen} tegn`).toBe(false);
      expect(json).toContain("[REDACTED:");
    }
    const r = await runConnectorContract(validFullManifest(), withThrowingSampleParameters(new Error(message)));
    const thrown = r.checks.filter((c) => c.status === "fail" && /sjekken kastet/.test(c.detail ?? ""));
    expect(thrown.length).toBeGreaterThan(0);
    for (const c of thrown) expect((c.detail ?? "").length).toBeLessThanOrEqual("sjekken kastet: ".length + 120);
  });

  it("N4/N7: også ting som IKKE er Error (streng, objekt med message, tall, undefined) kastes uten at kittet selv kaster - og strengen redigeres", async () => {
    const token = secretShapes()[0]!;
    for (const thrown of [`rå streng ${token}`, { message: `objekt ${token}` }, 42, undefined, null]) {
      const r = await runConnectorContract(validFullManifest(), withThrowingSampleParameters(thrown));
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r).includes(token.slice(0, 12)), String(thrown)).toBe(false);
    }
    expect(messageOf("a")).toBe("a");
    expect(messageOf({ message: "b" })).toBe("b");
    expect([messageOf(1), messageOf(undefined), messageOf(null), messageOf({}), messageOf({ message: 5 })]).toEqual(["", "", "", "", ""]);
  });

  it("N7: en adapter som ikke oppfyller ContractAdapter (ikke et objekt, uten actions, uten invoke) gir en fail-closed rapport i stedet for at runConnectorContract kaster", async () => {
    const m = validFullManifest();
    const base = good();
    const bad: unknown[] = [undefined, null, "adapter", 7, {}, { actions: "ikke en liste", invoke: async () => ({}) }, { ...base, actions: undefined }, { ...base, invoke: undefined }];
    for (const adapter of bad) {
      const r = await runConnectorContract(m, adapter as never);
      expect(r.ok, String(adapter)).toBe(false);
      expect(r.failed).toBe(1);
      expect(failedIds(r)).toEqual(["manifest.adapter_matches"]);
      expect(r.checks.every((c) => c.id === "manifest.adapter_matches" || c.status === "skip")).toBe(true);
      expect(r.passed).toBe(0);
      expect(r.checks.length).toBe(CONTRACT_CHECK_IDS.length);
      expect(r.adapter_kind).toBe("fake_from_manifest");
      expect(r.acceptance.verdict).toBe("gaps");
      expect(r.acceptance.summary.proven + r.acceptance.summary.modelled).toBe(0);
    }
  });

  it("N7: en adapter uten kontrollkrokene (injectFault/setPaused/... mangler) feiler per sjekk uten at kittet kaster (kit.reset er trygg)", async () => {
    const m = validFullManifest();
    const base = good();
    const crippled = { ...base, injectFault: undefined, setPaused: undefined, setCredentialRevoked: undefined, seedProviderText: undefined } as unknown as typeof base;
    const r = await runConnectorContract(m, crippled);
    expect(r.ok).toBe(false);
    expect(r.checks.some((c) => c.status === "fail" && /sjekken kastet/.test(c.detail ?? ""))).toBe(true);
  });

  it("N4: errorLabel viser kun navn og kode (aldri melding), slipper bare allowlistede former, og redigerer en token-formet del", () => {
    const token = secretShapes()[0]!;
    expect(errorLabel(new Error(`boom ${token}`))).toBe("Error");
    expect(errorLabel(Object.assign(new TypeError(`x ${token}`), { code: "ERR_INVALID_ARG_TYPE" }))).toBe("TypeError (ERR_INVALID_ARG_TYPE)");
    expect(errorLabel(Object.assign(new Error("m"), { code: "ENOENT" }))).toBe("Error (ENOENT)");
    // En kode eller et navn med liten bokstav/tegnsetting (token-formet) slippes aldri gjennom allowlisten:
    expect(errorLabel(Object.assign(new Error("m"), { code: token }))).toBe("Error");
    expect(errorLabel(Object.assign(new Error("m"), { name: token }))).toBe("Error");
    // Et token som tilfeldigvis passer allowlisten (AKIA + 16 tegn) redigeres av den sentrale skanneren:
    const awsShaped = secretShapes()[2]!;
    expect(awsShaped).toMatch(/^[A-Za-z][A-Za-z0-9]{0,39}$/);
    expect(errorLabel(Object.assign(new Error("m"), { name: awsShaped }))).toBe("[REDACTED:aws_access_key]");
    for (const odd of ["streng", 3, undefined, null, {}, { name: 5, code: 6 }]) expect(errorLabel(odd), String(odd)).toBe("Error");
  });
});

describe("akseptanse-scoring (Appendiks B): ærlig skille mellom bevist, deklarert, gap og ikke bevist", () => {
  const score = async (m: ConnectorManifest, defects: readonly FakeDefect[] = []) => (await run(m, defects)).acceptance;
  const item = (a: Awaited<ReturnType<typeof score>>, id: string) => a.items.find((i) => i.id === id)!;

  it("et skrivekapabelt manifest krever nivå A og har 10 nivå R- og 11 nivå A-krav; circuit breaker «partial» er et NAVNGITT gap (ikke skjult)", async () => {
    const a = await score(validFullManifest());
    expect(a.required_level).toBe("A");
    expect(a.items.filter((i) => i.level === "R").length).toBe(10);
    expect(a.items.filter((i) => i.level === "A").length).toBe(11);
    expect(item(a, "R.health_retry_breaker_runbook").status).toBe("gap");
    expect(item(a, "R.health_retry_breaker_runbook").evidence).toContain("circuit breaker er partial");
    expect(a.verdict).toBe("gaps");
    expect(a.gaps).toContain("R.health_retry_breaker_runbook");
    expect(item(a, "A.all_level_r").status).toBe("gap");
  });

  it("uten gap men uten live-evidens er verdict «live_evidence_pending» - og live smoke er aldri bevist av kittet", async () => {
    const m = validFullManifest();
    m.operations.circuit_breaker = { status: "implemented", mechanism: "automatisk bryter på feilrate (fiktiv)" };
    const a = await score(m);
    expect(a.gaps).toEqual([]);
    expect(a.verdict).toBe("live_evidence_pending");
    expect(item(a, "R.live_read_smoke").status).toBe("not_proven");
    expect(item(a, "A.live_reversible_action_smoke").status).toBe("not_proven");
    expect(item(a, "A.all_level_r").status).toBe("not_proven");
  });

  it("når manifestet oppgir en live smoke blir kravene «declared», verdict «complete_on_paper» - fortsatt aldri «proven»/«VERIFIED»", async () => {
    const m = validFullManifest();
    m.operations.circuit_breaker = { status: "implemented", mechanism: "automatisk bryter (fiktiv)" };
    m.tests.live_smoke = { status: "present", paths: ["modules/connector-sdk/test/fixtures.ts"] };
    const a = await score(m);
    expect(item(a, "R.live_read_smoke").status).toBe("declared");
    expect(item(a, "A.live_reversible_action_smoke").status).toBe("declared");
    expect(a.verdict).toBe("complete_on_paper");
    expect(JSON.stringify(a)).not.toContain("VERIFIED");
  });

  it("kit-bevisene mot en fake gir modelled (aldri proven - det krever en ekte transport); manifest-deklarasjonene gir declared", async () => {
    const a = await score(validFullManifest());
    for (const id of ["R.fake_adapter_contract_tests", "R.injection_classification", "R.audit_without_secret_values", "A.authority_target_resolution", "A.param_validation_state_readback", "A.idempotency_replay", "A.before_after_evidence", "A.rollback_or_documented_recovery", "A.classd_snapshot_notification", "A.pause_revoke_kill_switch"]) {
      expect(item(a, id).status, id).toBe("modelled");
    }
    for (const id of ["R.docs_checked", "R.minimal_scopes_vault_refs", "R.data_schema_provenance_freshness_retention", "R.cost_maintenance_measurement", "A.risk_class_a_d"]) expect(item(a, id).status, id).toBe("declared");
  });

  it("review N2: A.idempotency_replay er modelled MED forbeholdet at kontrakten er strengere enn dagens ToolGateway-ledger (nøklet på nøkkelen alene) - forbeholdet står i selve evidensen", async () => {
    const a = await score(validFullManifest());
    expect(item(a, "A.idempotency_replay").status).toBe("modelled");
    expect(item(a, "A.idempotency_replay").evidence).toContain("STRENGERE enn dagens ToolGateway-ledger");
    expect(item(a, "A.idempotency_replay").evidence).toContain("runbook §5");
    // Forbeholdet gjelder bare idempotens - de andre modellerte kravene bærer det ikke:
    expect(item(a, "A.authority_target_resolution").evidence).not.toContain("ToolGateway-ledger");
  });

  it("en brutt kontrakt blir et gap i riktig Appendiks B-krav", async () => {
    expect(item(await score(validFullManifest(), ["no_dedupe"]), "A.idempotency_replay").status).toBe("gap");
    expect(item(await score(validFullManifest(), ["leaks_credential"]), "R.audit_without_secret_values").status).toBe("gap");
    expect(item(await score(validFullManifest(), ["delegated_allowed"]), "A.authority_target_resolution").status).toBe("gap");
    expect(item(await score(validFullManifest(), ["pause_ignored"]), "A.pause_revoke_kill_switch").status).toBe("gap");
    expect(item(await score(validFullManifest(), ["no_evidence"]), "A.before_after_evidence").status).toBe("gap");
    expect(item(await score(validFullManifest(), ["wrong_trust_label"]), "R.injection_classification").status).toBe("gap");
    expect(item(await score(validFullManifest(), ["compensate_noop"]), "A.rollback_or_documented_recovery").status).toBe("gap");
  });

  it("en ufullstendig klasse D-kjede er et gap selv om kittet beviser at handlingen er utilgjengelig (fail-closed er ikke det samme som akseptert)", async () => {
    const a = await score(withDeferredD());
    expect(item(a, "A.classd_snapshot_notification").status).toBe("gap");
    expect(item(a, "A.classd_snapshot_notification").evidence).toContain(ACME_KEYS.setting);
  });

  it("avstemming for penge-berørende handlinger: påkrevd og deklarert = declared; manglende = gap; ingen penger = not_applicable", async () => {
    expect(item(await score(validFullManifest()), "A.finance_reconciliation").status).toBe("not_applicable");
    const money = validFullManifest();
    const n = money.actions.find((x) => x.key === ACME_KEYS.notify)!;
    n.effect = "pay";
    expect(item(await score(money), "A.finance_reconciliation").status).toBe("gap");
    money.operations.reconciliation = { required: true, method: "daglig avstemming (fiktiv)" };
    expect(item(await score(money), "A.finance_reconciliation").status).toBe("declared");
  });

  it("et skeleton scorer mange gap (ukjent er aldri «declared»)", async () => {
    const a = await score(validSkeletonManifest());
    for (const id of ["R.docs_checked", "R.minimal_scopes_vault_refs", "R.data_schema_provenance_freshness_retention", "R.fake_adapter_contract_tests", "R.delete_revoke_reauth", "R.cost_maintenance_measurement"]) expect(item(a, id).status, id).toBe("gap");
    expect(a.verdict).toBe("gaps");
  });

  it("scoreAcceptance er en ren funksjon av manifest + sjekkresultater", async () => {
    const m = validFullManifest();
    const r = await run(m);
    expect(JSON.stringify(scoreAcceptance(m, r.checks))).toBe(JSON.stringify(r.acceptance));
  });
});

describe("fake-harnessen: modellen holder kontrakten den påstår", () => {
  it("virtuell klokke: sleep venter på advance, avbrytes av signal, og fyrer i rekkefølge", async () => {
    const clock = new VirtualClock(0);
    const order: number[] = [];
    void clock.sleep(30).then(() => order.push(30));
    void clock.sleep(10).then(() => order.push(10));
    await clock.advance(5);
    expect(order).toEqual([]);
    await clock.advance(30);
    expect(order).toEqual([10, 30]);
    const c = new AbortController();
    const p = clock.sleep(1000, c.signal);
    c.abort();
    await expect(p).rejects.toThrow("aborted");
    expect(clock.pending()).toBe(0);
    await expect(clock.sleep(1, c.signal)).rejects.toThrow("aborted");
  });

  it("samme nøkkel: andre kall er deduplisert og gir samme eksterne id; en annen nyttelast under samme nøkkel avvises som konflikt", async () => {
    const m = validFullManifest();
    const f = createFakeConnector({ manifest: m });
    const params = f.sampleParameters(ACME_KEYS.create);
    const a = await f.invoke({ action: ACME_KEYS.create, parameters: params, idempotency_key: "k1", identity: f.identities.owner });
    const b = await f.invoke({ action: ACME_KEYS.create, parameters: params, idempotency_key: "k1", identity: f.identities.owner });
    const c = await f.invoke({ action: ACME_KEYS.create, parameters: { title: "other" }, idempotency_key: "k1", identity: f.identities.owner });
    expect(a.ok && b.ok && b.deduplicated && a.external_id === b.external_id).toBe(true);
    expect(!c.ok && c.error.category === "conflict" && c.error.code === "idempotency_key_reuse_mismatch").toBe(true);
    expect(f.effects(ACME_KEYS.create)).toBe(1);
  });

  it("klasse A (lesing) har ingen ledger: to like lesninger kjører begge, og ingen effekt telles", async () => {
    const f = createFakeConnector({ manifest: validFullManifest() });
    const req = { action: ACME_KEYS.list, parameters: f.sampleParameters(ACME_KEYS.list), identity: f.identities.owner };
    const a = await f.invoke(req); const b = await f.invoke(req);
    expect(a.ok && b.ok && !b.deduplicated).toBe(true);
    expect(f.effects()).toBe(0);
    expect(f.providerCalls()).toBe(2);
  });

  it("credential og hemmelighetsformer lekker ikke, verken i svar, feil, logg eller revisjon, selv når leverandøren siterer dem", async () => {
    const f = createFakeConnector({ manifest: validFullManifest() });
    f.seedProviderText(`${secretShapes().join(" ")} ${FAKE_CREDENTIAL_CANARY}`);
    f.injectFault({ kind: "auth" });
    const err = await f.invoke({ action: ACME_KEYS.list, parameters: f.sampleParameters(ACME_KEYS.list), identity: f.identities.owner });
    f.injectFault(null);
    const ok = await f.invoke({ action: ACME_KEYS.list, parameters: f.sampleParameters(ACME_KEYS.list), identity: f.identities.owner });
    const everything = JSON.stringify([err, ok, f.observed]);
    expect(everything.includes(FAKE_CREDENTIAL_CANARY)).toBe(false);
    for (const s of secretShapes()) expect(everything.includes(s)).toBe(false);
    expect(!err.ok && err.error.category).toBe("auth");
  });

  it("injeksjonstekst fra leverandøren returneres som data (ubetrodd), aldri som kontrollfelt", async () => {
    const f = createFakeConnector({ manifest: validFullManifest() });
    f.seedProviderText(INJECTION_PAYLOAD);
    const r = await f.invoke({ action: ACME_KEYS.list, parameters: f.sampleParameters(ACME_KEYS.list), identity: f.identities.owner });
    expect(r.ok && r.output_trust).toBe("untrusted");
    expect(r.ok && JSON.stringify(r.data).includes("ignore all previous instructions")).toBe(true);
    expect(Object.keys(r).sort()).toEqual(["data", "deduplicated", "ok", "output_trust"]);
  });

  it("kompensasjon gjenoppretter tilstanden; handlinger uten automatisk rollback nektes ærlig", async () => {
    const f = createFakeConnector({ manifest: validFullManifest() });
    const before = JSON.stringify(f.snapshot());
    await f.invoke({ action: ACME_KEYS.create, parameters: f.sampleParameters(ACME_KEYS.create), idempotency_key: "r1", identity: f.identities.owner });
    expect(JSON.stringify(f.snapshot())).not.toBe(before);
    expect((await f.compensate(ACME_KEYS.create, "r1")).restored).toBe(true);
    expect(JSON.stringify(f.snapshot())).toBe(before);
    await f.invoke({ action: ACME_KEYS.notify, parameters: f.sampleParameters(ACME_KEYS.notify), idempotency_key: "n1", identity: f.identities.owner });
    expect((await f.compensate(ACME_KEYS.notify, "n1")).reason).toBe("no_automatic_rollback");
    expect((await f.compensate(ACME_KEYS.create, "unknown-key")).reason).toBe("no_executed_row");
  });

  it("delegert modus ukjent er fail-closed; delegert godkjenning kreves kun for klasse C/D", async () => {
    const sk = createFakeConnector({ manifest: validSkeletonManifest() });
    const denied = await sk.invoke({ action: ACME_KEYS.list, parameters: sk.sampleParameters(ACME_KEYS.list), identity: sk.identities.delegated });
    expect(!denied.ok && denied.error.code).toBe("credential_not_bound_to_identity");
    const f = createFakeConnector({ manifest: validFullManifest() });
    const b = await f.invoke({ action: ACME_KEYS.create, parameters: f.sampleParameters(ACME_KEYS.create), idempotency_key: "d1", identity: f.identities.delegated });
    const c = await f.invoke({ action: ACME_KEYS.remove, parameters: f.sampleParameters(ACME_KEYS.remove), idempotency_key: "d2", identity: f.identities.delegated });
    const c2 = await f.invoke({ action: ACME_KEYS.remove, parameters: f.sampleParameters(ACME_KEYS.remove), idempotency_key: "d3", identity: f.identities.delegated_approved });
    expect(b.ok).toBe(true);
    expect(!c.ok && c.error.code).toBe("approval_required");
    expect(c2.ok).toBe(true);
  });

  it("det ukjente skjer ikke stille: ukjent handling nektes uten helsepåvirkning", async () => {
    const f = createFakeConnector({ manifest: validFullManifest() });
    const r = await f.invoke({ action: "acme.nope", parameters: {}, identity: f.identities.owner });
    expect(!r.ok && r.error.code).toBe("unknown_action");
    expect(f.health()).toBeNull();
    expect(isUnknown(validFullManifest().d41_audit)).toBe(false);
  });
});

describe("review M2: kittets utdata (detail, subjects, evidens) ekkoer aldri en hemmelighetsform - heller ikke fra adapteren eller et uvalidert manifest", () => {
  it("et UVALIDERT, typet manifest med hemmelighetsformet handlingsnøkkel (duplikat) og uverifiserte scopes: hele rapporten er ren, og manifest.valid feller det", async () => {
    for (const key of secretShapedActionKeys()) {
      const m = validFullManifest();
      m.actions[0]!.key = key;
      m.actions.push(structuredClone(m.actions[0]!));
      const d41 = m.d41_audit as { scopes_verified_against_docs: boolean; unverified_scopes: string[] };
      d41.scopes_verified_against_docs = false;
      d41.unverified_scopes = [key];
      const r = await run(m);
      expect(failedIds(r)).toContain("manifest.valid");
      expect(JSON.stringify(r).includes(key), key.slice(0, 6)).toBe(false);
      expect(JSON.stringify(scoreAcceptance(m, r.checks)).includes(key), `scoreAcceptance ${key.slice(0, 6)}`).toBe(false);
    }
  });

  it("verdier FRA ADAPTEREN (connector-id, handlingsliste, feilkode, feilkategori, helsetilstand, unntakstekst) med hemmelighetsform redigeres bort", async () => {
    const shape = secretShapes()[0]!;
    const m = validFullManifest();
    const good = createFakeConnector({ manifest: m });
    const evil = {
      ...good, connector_id: shape, actions: [...good.actions, `${shape}.read`],
      invoke: async (req: Parameters<typeof good.invoke>[0]) => { const r = await good.invoke(req); return r.ok ? r : { ok: false as const, error: { ...r.error, code: shape, category: shape as never } }; },
      health: () => ({ state: shape as never, at: "ikke-en-dato" })
    } as unknown as typeof good;
    const r = await runConnectorContract(m, evil);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r).includes(shape)).toBe(false);
    const thrower = { ...good, invoke: async () => { throw new Error(`boom ${shape} ${good.credentialCanary()}`); } } as unknown as typeof good;
    const t = await runConnectorContract(m, thrower);
    expect(t.checks.some((c) => c.status === "fail" && /kastet/.test(`${c.detail ?? ""} ${(c.subjects ?? []).join(" ")}`))).toBe(true);
    expect(JSON.stringify(t).includes(shape)).toBe(false);
    expect(JSON.stringify(t).includes(good.credentialCanary())).toBe(false);
  });

  it("en kjent credential (kanarifuglen) i adapterens egen feiltekst redigeres også når den ikke har noen kjent hemmelighetsform", async () => {
    const m = validFullManifest();
    const good = createFakeConnector({ manifest: m });
    const canary = good.credentialCanary();
    const leaky = { ...good, invoke: async (req: Parameters<typeof good.invoke>[0]) => { const r = await good.invoke(req); return r.ok ? r : { ok: false as const, error: { ...r.error, code: `bad_${canary}` } }; } } as unknown as typeof good;
    const r = await runConnectorContract(m, leaky);
    expect(JSON.stringify(r).includes(canary)).toBe(false);
  });
});
