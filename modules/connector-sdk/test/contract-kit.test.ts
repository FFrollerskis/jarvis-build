import { describe, expect, it } from "vitest";
import { isUnknown, type ConnectorManifest } from "../src/index.ts";
import {
  CONTRACT_CHECK_IDS, FAKE_CREDENTIAL_CANARY, FAKE_DEFECTS, INJECTION_PAYLOAD, VirtualClock, createFakeConnector, runConnectorContract, secretShapes, scoreAcceptance,
  type ContractReport, type FakeDefect
} from "../src/testing.ts";
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

describe("MUTASJONSTESTER: hver defekt i fakeen feller nøyaktig den kontraktsegenskapen den bryter", () => {
  const cases: Array<[FakeDefect, string[]]> = [
    ["no_dedupe", ["idempotency.same_key_one_effect"]],
    ["required_key_not_enforced", ["idempotency.required_key_enforced"]],
    ["params_not_validated", ["params.validated_before_provider"]],
    ["wrong_trust_label", ["trust.labelling"]],
    ["leaks_credential", ["audit.no_secret_values", "redaction.no_secret_shapes"]],
    ["no_redaction", ["redaction.no_secret_shapes"]],
    ["health_never_degrades", ["health.degrades_and_recovers"]],
    ["ignores_abort", ["timeout.abort"]],
    ["timeout_masks_as_ok", ["timeout.abort"]],
    ["no_evidence", ["evidence.before_after"]],
    ["cross_tenant_allowed", ["authority.tenant_isolation"]],
    ["delegated_allowed", ["authority.delegated"]],
    ["pause_ignored", ["control.pause_blocks_all"]],
    ["revoke_ignored", ["revoke.and_reauth"]],
    ["no_notification", ["classd.chain_and_notification"]],
    ["auth_reported_as_other", ["errors.taxonomy", "health.degrades_and_recovers"]],
    ["unknown_outcome_replay_executes", ["timeout.after_effect_unknown_not_replayed"]],
    ["compensate_noop", ["recovery.rollback_restores_state"]],
    ["key_reuse_executes", ["idempotency.key_reuse_other_payload"]],
    ["provider_text_in_control_field", ["trust.injection_is_data"]]
  ];
  it.each(cases)("%s", async (defect, expected) => {
    const r = await run(validFullManifest(), [defect]);
    const failed = failedIds(r);
    for (const id of expected) expect(failed, `${defect} burde felle ${id}; feilet: ${failed.join(", ")}`).toContain(id);
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

  it("kit-bevisene gir proven; manifest-deklarasjonene gir declared", async () => {
    const a = await score(validFullManifest());
    for (const id of ["R.fake_adapter_contract_tests", "R.injection_classification", "R.audit_without_secret_values", "A.authority_target_resolution", "A.param_validation_state_readback", "A.idempotency_replay", "A.before_after_evidence", "A.rollback_or_documented_recovery", "A.classd_snapshot_notification", "A.pause_revoke_kill_switch"]) {
      expect(item(a, id).status, id).toBe("proven");
    }
    for (const id of ["R.docs_checked", "R.minimal_scopes_vault_refs", "R.data_schema_provenance_freshness_retention", "R.cost_maintenance_measurement", "A.risk_class_a_d"]) expect(item(a, id).status, id).toBe("declared");
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
