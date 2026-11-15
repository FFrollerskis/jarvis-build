import { describe, expect, it } from "vitest";
import { FULL_MANIFESTS, type ConnectorManifest } from "../../src/index.ts";
import { runConnectorContract, type ContractAdapter, type ContractReport } from "../../src/testing.ts";
import { createCloudflareFake } from "./cloudflare.fake.ts";
import { createGithubFake } from "./github.fake.ts";
import { createStripeFake } from "./stripe.fake.ts";

/**
 * WP-I (D-472): kontraktstest-kittet anvendt på de tre referanseconnectorene (GitHub, Cloudflare/WP-E1, Stripe/WP-F1) med FAKE-adaptere. Ingen nettverk, ingen ekte leverandør, ingen ekte nøkler.
 * HVA DETTE BEVISER: at manifestenes deklarerte garantier (idempotens, evidens, klasse D-kjede, autoritet, tidsavbrudd, redigering, pause/tilbakekall) er konsistente og at kittet kjører dem mot en
 * adapter som følger kontrakten. HVA DET IKKE BEVISER: at de ekte transportene (`GithubTransport`, `CloudflareTransport`, Stripe-transporten) holder dem - det krever en bro mot en ekte transport bak
 * en fake leverandørserver (DEFERRED) eller en live smoke mot en sandbox (BLOCKED_EXTERNAL). De ekte transportene har egne tester (se manifestenes `tests`-felt).
 */
/** Kjent og legitimt: Stripe har kun handlinger uten automatisk rollback (en refusjon korrigeres av en NY finansoperasjon - dokumentert manuell reversering), så rollback-sjekken hoppes over med årsak. */
const EXPECTED_SKIPS: Record<string, string[]> = { github: [], cloudflare: [], stripe: ["recovery.rollback_restores_state"] };

const REFERENCES: Array<[string, ConnectorManifest, () => ContractAdapter]> = [
  ["github", FULL_MANIFESTS.find((m) => m.identity.id === "github")!, () => createGithubFake()],
  ["cloudflare", FULL_MANIFESTS.find((m) => m.identity.id === "cloudflare")!, () => createCloudflareFake()],
  ["stripe", FULL_MANIFESTS.find((m) => m.identity.id === "stripe")!, () => createStripeFake()]
];

/**
 * De NAVNGITTE gapene hver referanse har i dag (pinnet: en endring i manifestet som lukker eller åpner et gap må gjøres bevisst). Alle tre deklarerer circuit breaker `partial` (ingen automatisk bryter på
 * feilrate; manuell pause/frys og porter finnes), og Cloudflare/Stripe har scopes som ikke er fullt verifisert mot dokumentasjon.
 */
const EXPECTED_GAPS: Record<string, string[]> = {
  github: ["R.health_retry_breaker_runbook", "A.all_level_r"],
  cloudflare: ["R.docs_checked", "R.health_retry_breaker_runbook", "A.all_level_r"],
  stripe: ["R.docs_checked", "R.health_retry_breaker_runbook", "A.all_level_r"]
};

const reports = new Map<string, ContractReport>();
const reportOf = async (id: string, manifest: ConnectorManifest, make: () => ContractAdapter): Promise<ContractReport> => {
  const cached = reports.get(id);
  if (cached !== undefined) return cached;
  const r = await runConnectorContract(manifest, make());
  reports.set(id, r);
  return r;
};

describe.each(REFERENCES)("referanse: %s", (id, manifest, make) => {
  it("kontraktstest-kittet består uten feil, og ingen sjekk hoppes over (alle nivå R og A er kjørt)", async () => {
    const r = await reportOf(id, manifest, make);
    expect(r.checks.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.detail ?? ""} ${(c.subjects ?? []).join("; ")}`)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.filter((c) => c.status === "skip").map((c) => c.id)).toEqual(EXPECTED_SKIPS[id]);
  });

  it("nivå A kreves (skrive-/utførende handlinger), og akseptanse-gapene er nøyaktig de navngitte", async () => {
    const r = await reportOf(id, manifest, make);
    expect(r.acceptance.required_level).toBe("A");
    expect(r.acceptance.gaps).toEqual(EXPECTED_GAPS[id]);
    expect(r.acceptance.verdict).toBe("gaps");
  });

  it("live smoke og live reversibel handling er IKKE bevist (BLOCKED_EXTERNAL), og ingenting er «verified»", async () => {
    const r = await reportOf(id, manifest, make);
    const live = r.acceptance.items.filter((i) => i.id === "R.live_read_smoke" || i.id === "A.live_reversible_action_smoke");
    expect(live.map((i) => i.status)).toEqual(["not_proven", "not_proven"]);
    // Ingenting er «bevist mot ekte leverandør»: verken en status eller en dom heter «verified».
    expect(r.acceptance.items.map((i) => String(i.status))).not.toContain("verified");
    expect(["gaps", "live_evidence_pending", "complete_on_paper"]).toContain(r.acceptance.verdict);
  });

  it("kittets bevis (idempotens, evidens, klasse D-kjede, autoritet, pause/tilbakekall, redigering, ubetrodd-merking) er MODELLERT mot en fake fra manifestet - aldri «proven» (review M4)", async () => {
    const r = await reportOf(id, manifest, make);
    expect(r.adapter_kind).toBe("fake_from_manifest");
    expect(r.acceptance.adapter_kind).toBe("fake_from_manifest");
    const modelled = new Set(r.acceptance.items.filter((i) => i.status === "modelled").map((i) => i.id));
    for (const item of ["R.fake_adapter_contract_tests", "R.injection_classification", "R.audit_without_secret_values", "A.authority_target_resolution", "A.param_validation_state_readback", "A.idempotency_replay", "A.before_after_evidence", "A.classd_snapshot_notification", "A.pause_revoke_kill_switch"]) {
      expect(modelled.has(item), item).toBe(true);
    }
    // Referansene er fakes bygget fra SINE EGNE manifester: ingenting er bevist mot en ekte transport, så «proven» finnes ikke (GitHub har f.eks. et dokumentert ekte replay-gap som en fake aldri kan vise).
    expect(r.acceptance.items.filter((i) => i.status === "proven").map((i) => i.id)).toEqual([]);
    expect(r.acceptance.summary.proven).toBe(0);
  });
});

describe("referansespesifikt", () => {
  it("Stripe: penge-berørende handling krever avstemming (deklarert), og refusjonen er klasse D med komplett kjede", async () => {
    const [, manifest, make] = REFERENCES[2]!;
    const r = await reportOf("stripe", manifest, make);
    expect(r.acceptance.items.find((i) => i.id === "A.finance_reconciliation")?.status).toBe("declared");
    expect(r.acceptance.items.find((i) => i.id === "A.classd_snapshot_notification")?.status).toBe("modelled");
  });

  it("GitHub: merge_pr (klasse D, irreversibel) har dokumentert manuell reversering, ikke automatisk rollback; øvrige reversible handlinger rulles tilbake", async () => {
    const [, manifest, make] = REFERENCES[0]!;
    const f = make();
    const merge = manifest.actions.find((a) => a.key === "github.merge_pr")!;
    expect(merge.reversibility).toMatchObject({ reversible: false, rollback_method: "manual", destructive: true });
    await f.invoke({ action: "github.merge_pr", parameters: f.sampleParameters("github.merge_pr"), idempotency_key: "m1", identity: f.identities.owner });
    expect((await f.compensate("github.merge_pr", "m1")).reason).toBe("no_automatic_rollback");
    const rollback = (await reportOf("github", manifest, () => make())).checks.find((c) => c.id === "recovery.rollback_restores_state");
    expect(rollback?.status).toBe("pass");
  });

  it("Cloudflare: alle skrivehandlinger krever step-up i manifestet, og purge_cache (klasse C) er irreversibel uten lesbar evidens", async () => {
    const [, manifest] = REFERENCES[1]!;
    expect(manifest.actions.filter((a) => a.effect !== "read").every((a) => a.authority.step_up_required)).toBe(true);
    const purge = manifest.actions.find((a) => a.key === "cloudflare.purge_cache")!;
    expect(purge.reversibility).toMatchObject({ reversible: false, rollback_method: "none", destructive: true, evidence: { before_state: false, postcondition: "none" } });
  });

  it("en handler som siterer leverandørtekst uten å redigere den felles av kittet (utvidelsespunktet er trygt å bruke, og et brudd fanges)", async () => {
    const [, manifest] = REFERENCES[0]!;
    const naive = createGithubFake({ handlers: { "github.read_issues": { read: (_p, _s, ctx) => ({ issues: [{ title: ctx.providerText ?? "x" }] }), sample: { repo: "owner/sandbox-repo" } } } });
    const r = await runConnectorContract(manifest, naive);
    expect(r.checks.filter((c) => c.status === "fail").map((c) => c.id)).toContain("redaction.no_secret_shapes");
    expect(r.acceptance.items.find((i) => i.id === "R.audit_without_secret_values")?.status).toBe("gap");
  });

  it("fakene lekker aldri credential: ingen revisjonslinje, logglinje eller svar inneholder credential-kanarifuglen", async () => {
    for (const [, manifest, make] of REFERENCES) {
      const f = make();
      await runConnectorContract(manifest, f);
      const blob = JSON.stringify(f.observed);
      expect(blob.includes(f.credentialCanary())).toBe(false);
      expect(f.observed.audit.length).toBeGreaterThan(10);
    }
  });
});
