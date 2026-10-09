import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  CLAIM_STATUSES,
  DEFAULT_MAX_EVIDENCE_AGE_DAYS,
  DEFAULT_MIN_INDEPENDENT_SOURCES,
  DEFAULT_REVERIFY_AFTER_DAYS,
  InvalidClaimPolicyError,
  InvalidClaimTransitionError,
  buildPromotionProposal,
  deriveIndependenceKey,
  effectiveClaimStatus,
  evaluateEvidence,
  isAllowedTransition,
  normalizeOriginKey,
  normalizeVerificationPolicy,
  reduceClaim,
  startResearchStatus,
  transitionPath,
  type ClaimEvidence,
  type ClaimStatus,
  type VerificationPolicy
} from "../src/claim-verification.ts";

/**
 * WP-D1 (UA-2, Q-26): Knowledge Verification / Truth Promotion - REN logikk. Invarianten: ukjent blir aldri stille sannhet; permanent kunnskap krever FLERE UAVHENGIGE kilder (tre kopier av samme
 * oppstrøms-påstand er ÉN kilde); primærkilde foretrekkes; enhver motstridende evidens gir DISPUTED; tidssensitive fakta må være ferske og har en re-verifiseringsfrist. Ingen database, ingen klokke.
 */
const NOW = new Date("2026-10-09T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

const policy = (over: Partial<VerificationPolicy> = {}): VerificationPolicy => normalizeVerificationPolicy(over);
function ev(key: string, over: Partial<ClaimEvidence> = {}): ClaimEvidence {
  return { stance: "supports", independence_key: key, is_primary: false, published_at: daysAgo(30), retrieved_at: daysAgo(5), retracted: false, ...over };
}
const statusOf = (evidence: ClaimEvidence[], p = policy(), from: ClaimStatus = "RESEARCHING") => reduceClaim({ status: from, verified_at: null, reverify_by: null }, evidence, p, NOW);

describe("A: policy (N, ferskhet) er fail-closed", () => {
  it("standarder", () => {
    expect(policy()).toEqual({ min_independent_sources: DEFAULT_MIN_INDEPENDENT_SOURCES, time_sensitive: false, max_evidence_age_days: DEFAULT_MAX_EVIDENCE_AGE_DAYS, reverify_after_days: DEFAULT_REVERIFY_AFTER_DAYS });
    expect(DEFAULT_MIN_INDEPENDENT_SOURCES).toBe(2);
  });

  it("N må være et heltall 2..10: én kilde kan aldri verifisere, og ugyldige verdier klemmes aldri stille", () => {
    for (const n of [1, 0, -1, 11, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "3" as unknown as number]) {
      expect(() => policy({ min_independent_sources: n }), String(n)).toThrow(InvalidClaimPolicyError);
    }
    for (const n of [2, 3, 10]) expect(policy({ min_independent_sources: n }).min_independent_sources).toBe(n);
  });

  it("ferskhetsgrensene har harde tak, og time_sensitive er kun sann når den er eksakt true", () => {
    for (const bad of [0, -1, 3651, 1.5]) expect(() => policy({ max_evidence_age_days: bad }), `age ${bad}`).toThrow(InvalidClaimPolicyError);
    for (const bad of [0, 366, 2.2]) expect(() => policy({ reverify_after_days: bad }), `reverify ${bad}`).toThrow(InvalidClaimPolicyError);
    expect(policy({ time_sensitive: "ja" as unknown as boolean }).time_sensitive).toBe(false);
    expect(policy({ time_sensitive: true }).time_sensitive).toBe(true);
  });
});

describe("B: uavhengighetsnøkkel - samme oppstrøms-påstand er ÉN kilde", () => {
  it("URL -> registrerbart domene (www, port, sti, spørring og store bokstaver spiller ingen rolle)", () => {
    expect(normalizeOriginKey("https://www.vg.no/a/1")).toBe("vg.no");
    expect(normalizeOriginKey("http://VG.no/b/2?x=1#y")).toBe("vg.no");
    expect(normalizeOriginKey("https://news.bbc.co.uk/x")).toBe("bbc.co.uk");
    expect(normalizeOriginKey("https://a.b.example.com:8443/x")).toBe("example.com");
    expect(normalizeOriginKey("http://10.0.0.1/x")).toBe("10.0.0.1");
    expect(normalizeOriginKey("https://www2.ssb.no/")).toBe("ssb.no");
  });

  it("ren domene-streng faller sammen med en URL til samme domene (deklarert oppstrøms og selve kilden er samme nøkkel)", () => {
    expect(normalizeOriginKey("NTB.no")).toBe("ntb.no");
    expect(normalizeOriginKey("https://www.ntb.no/artikkel")).toBe(normalizeOriginKey("ntb.no"));
  });

  it("doi/arxiv -> identifikatoren, kunnskapsdokument -> doc:, fritekst -> origin:<slug>, NFKC samler tegnvarianter", () => {
    expect(normalizeOriginKey("doi: 10.1000/xyz123")).toBe("doi:10.1000/xyz123");
    expect(normalizeOriginKey("arXiv:2401.00001")).toBe("arxiv:2401.00001");
    expect(normalizeOriginKey("kd-0f3a-bb")).toBe("doc:kd-0f3a-bb");
    expect(normalizeOriginKey("  Statistisk sentralbyrå  ")).toBe("origin:statistisk-sentralbyrå");
    expect(normalizeOriginKey("ＮＴＢ")).toBe("origin:ntb"); // fullbredde-tegn
    expect(normalizeOriginKey("NTB")).toBe("origin:ntb");
  });

  it("tom, for lang, ugyldig URL og ren tegnsetting kaster: evidens uten identifiserbart opphav kan aldri telle som uavhengig", () => {
    for (const bad of ["", "   ", "x".repeat(501), "http://", "https://", "!!!", "..."]) {
      expect(() => normalizeOriginKey(bad), JSON.stringify(bad.slice(0, 20))).toThrow(InvalidClaimPolicyError);
    }
  });

  it("deriveIndependenceKey: den DEKLARERTE oppstrøms-kilden vinner, ellers kilden selv", () => {
    expect(deriveIndependenceKey({ source_ref: "https://www.vg.no/a", upstream_origin: "NTB" })).toBe("origin:ntb");
    expect(deriveIndependenceKey({ source_ref: "https://www.dagbladet.no/b", upstream_origin: "NTB" })).toBe("origin:ntb");
    expect(deriveIndependenceKey({ source_ref: "https://www.vg.no/a", upstream_origin: "  " })).toBe("vg.no");
    expect(deriveIndependenceKey({ source_ref: "https://www.vg.no/a", upstream_origin: null })).toBe("vg.no");
    expect(deriveIndependenceKey({ source_ref: "https://www.vg.no/a" })).toBe("vg.no");
  });
});

describe("C: evaluering - VERIFIED-regelen", () => {
  it("tre kopier av samme oppstrøms-påstand teller som ÉN uavhengig kilde (og forklares)", () => {
    const e = evaluateEvidence([ev("origin:ntb"), ev("origin:ntb"), ev("origin:ntb")], policy(), NOW);
    expect(e.independent_support).toBe(1);
    expect(e.supporting_keys).toEqual(["origin:ntb"]);
    expect(e.rule_met).toBe(false);
    expect(e.reasons).toContain("too_few_independent_sources");
    expect(e.reasons).toContain("duplicate_copies_counted_once");
  });

  it("N=2: primærkilde + en annen = oppfylt; to sekundære alene = IKKE (krever primærkilde ELLER minst 3); tre sekundære = oppfylt", () => {
    expect(evaluateEvidence([ev("a.no", { is_primary: true }), ev("b.no")], policy(), NOW).rule_met).toBe(true);
    const two = evaluateEvidence([ev("a.no"), ev("b.no")], policy(), NOW);
    expect(two.rule_met).toBe(false);
    expect(two.reasons).toContain("no_primary_source");
    expect(evaluateEvidence([ev("a.no"), ev("b.no"), ev("c.no")], policy(), NOW).rule_met).toBe(true);
  });

  it("N er konfigurerbar: N=3 krever tre uavhengige OG (primær eller >=3 - som her er oppfylt av tallet), N=4 krever fire", () => {
    const three = [ev("a.no", { is_primary: true }), ev("b.no"), ev("c.no")];
    expect(evaluateEvidence(three, policy({ min_independent_sources: 3 }), NOW).rule_met).toBe(true);
    expect(evaluateEvidence(three, policy({ min_independent_sources: 4 }), NOW).rule_met).toBe(false);
    expect(evaluateEvidence([ev("a.no", { is_primary: true }), ev("b.no", { is_primary: true })], policy({ min_independent_sources: 3 }), NOW).rule_met).toBe(false);
  });

  it("en primærkilde som ikke teller (utdatert på en tidssensitiv påstand) gir ikke primærkilde-fordelen", () => {
    const p = policy({ time_sensitive: true });
    const e = evaluateEvidence([ev("a.no", { is_primary: true, published_at: daysAgo(900) }), ev("b.no"), ev("c.no", { published_at: null })], p, NOW);
    expect(e.independent_support).toBe(1);
    expect(e.has_primary_support).toBe(false);
    expect(e.excluded).toEqual({ stale: 1, undated: 1, self_contradicting: 0 });
  });

  it("tilbaketrukket evidens ignoreres helt (både støtte og motstrid)", () => {
    const e = evaluateEvidence([ev("a.no", { is_primary: true }), ev("b.no", { retracted: true }), ev("c.no", { stance: "contradicts", retracted: true })], policy(), NOW);
    expect(e.independent_support).toBe(1);
    expect(e.contradicting_count).toBe(0);
  });

  it("en nøkkel som både støtter og motsier teller IKKE som støtte (selvmotsigelse er motstrid)", () => {
    const e = evaluateEvidence([ev("a.no", { is_primary: true }), ev("a.no", { stance: "contradicts" }), ev("b.no")], policy(), NOW);
    expect(e.independent_support).toBe(1);
    expect(e.contradicting_keys).toEqual(["a.no"]);
    expect(e.excluded.self_contradicting).toBe(1);
  });

  it("tidssensitiv: utdatert utgivelse, manglende dato og for gammel sjekk faller ut; ikke-tidssensitiv ignorerer datoer; utløpet er tidligste sjekk + fristen", () => {
    const p = policy({ time_sensitive: true });
    const fresh = ev("a.no", { is_primary: true, published_at: daysAgo(10), retrieved_at: daysAgo(3) });
    const e = evaluateEvidence([
      fresh,
      ev("b.no", { published_at: daysAgo(10), retrieved_at: daysAgo(40) }), // sjekket for lenge siden
      ev("c.no", { published_at: daysAgo(400) }), // utgitt for lenge siden
      ev("d.no", { published_at: null }) // udatert
    ], p, NOW);
    expect(e.independent_support).toBe(1);
    expect(e.excluded).toEqual({ stale: 2, undated: 1, self_contradicting: 0 });
    expect(e.support_expires_at?.getTime()).toBe(fresh.retrieved_at.getTime() + 30 * DAY);
    const relaxed = evaluateEvidence([ev("a.no", { published_at: null, retrieved_at: daysAgo(900) }), ev("b.no", { published_at: daysAgo(5000) })], policy(), NOW);
    expect(relaxed.independent_support).toBe(2);
    expect(relaxed.support_expires_at).toBeNull();
  });

  it("konfidens er informativ (0..1): flere uavhengige og primærkilder gir høyere, motstrid lavere - og den styrer aldri regelen", () => {
    const one = evaluateEvidence([ev("a.no")], policy(), NOW).confidence;
    const two = evaluateEvidence([ev("a.no"), ev("b.no")], policy(), NOW).confidence;
    const primary = evaluateEvidence([ev("a.no", { is_primary: true })], policy(), NOW).confidence;
    const disputed = evaluateEvidence([ev("a.no"), ev("b.no"), ev("c.no", { stance: "contradicts" })], policy(), NOW).confidence;
    expect(one).toBeGreaterThan(0);
    expect(two).toBeGreaterThan(one);
    expect(primary).toBeGreaterThan(one);
    expect(disputed).toBeLessThan(two);
    for (const c of [one, two, primary, disputed, evaluateEvidence([], policy(), NOW).confidence]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    // To sekundære med høy konfidens er likevel ikke nok (regelen avgjør, ikke konfidensen).
    expect(evaluateEvidence([ev("a.no"), ev("b.no")], policy(), NOW).rule_met).toBe(false);
  });

  it("årsakene er kun kategorikoder (ingen fritekst som kan bære innhold)", () => {
    const known = new Set([
      "no_counted_support", "too_few_independent_sources", "no_primary_source", "verification_rule_met", "contradicting_evidence", "stale_evidence_excluded", "undated_evidence_excluded",
      "self_contradicting_source_excluded", "duplicate_copies_counted_once"
    ]);
    const all = [
      evaluateEvidence([], policy(), NOW), evaluateEvidence([ev("a.no")], policy(), NOW), evaluateEvidence([ev("a.no", { is_primary: true }), ev("b.no")], policy(), NOW),
      evaluateEvidence([ev("a.no"), ev("a.no", { stance: "contradicts" })], policy({ time_sensitive: true }), NOW), evaluateEvidence([ev("a.no", { published_at: null })], policy({ time_sensitive: true }), NOW)
    ];
    for (const e of all) for (const reason of e.reasons) expect(known.has(reason), reason).toBe(true);
  });
});

describe("D: tilstandsmaskinen", () => {
  it("de eneste lovlige overgangene: ingenting fører tilbake til UNKNOWN, og VERIFIED nås kun fra PROVISIONAL", () => {
    expect(ALLOWED_TRANSITIONS).toEqual({
      UNKNOWN: ["RESEARCHING"], RESEARCHING: ["PROVISIONAL", "DISPUTED"], PROVISIONAL: ["RESEARCHING", "VERIFIED", "DISPUTED"], VERIFIED: ["PROVISIONAL", "DISPUTED"], DISPUTED: ["PROVISIONAL", "RESEARCHING"]
    });
    for (const from of CLAIM_STATUSES) {
      expect(isAllowedTransition(from, "UNKNOWN"), `${from}->UNKNOWN`).toBe(false);
      expect(isAllowedTransition(from, "VERIFIED"), `${from}->VERIFIED`).toBe(from === "PROVISIONAL");
    }
  });

  it("transitionPath: korteste lovlige vei, hopper aldri over en tilstand, tom ved lik status, kaster for UNKNOWN som mål", () => {
    expect(transitionPath("RESEARCHING", "VERIFIED")).toEqual(["PROVISIONAL", "VERIFIED"]);
    expect(transitionPath("DISPUTED", "VERIFIED")).toEqual(["PROVISIONAL", "VERIFIED"]);
    expect(transitionPath("VERIFIED", "RESEARCHING")).toEqual(["PROVISIONAL", "RESEARCHING"]);
    expect(transitionPath("UNKNOWN", "VERIFIED")).toEqual(["RESEARCHING", "PROVISIONAL", "VERIFIED"]);
    expect(transitionPath("PROVISIONAL", "PROVISIONAL")).toEqual([]);
    for (const from of ["RESEARCHING", "PROVISIONAL", "VERIFIED", "DISPUTED"] as const) {
      expect(() => transitionPath(from, "UNKNOWN"), from).toThrow(InvalidClaimTransitionError);
    }
  });

  it("startResearchStatus: kun UNKNOWN -> RESEARCHING", () => {
    expect(startResearchStatus("UNKNOWN")).toBe("RESEARCHING");
    for (const from of ["RESEARCHING", "PROVISIONAL", "VERIFIED", "DISPUTED"] as const) expect(() => startResearchStatus(from), from).toThrow(InvalidClaimTransitionError);
  });

  it("UNKNOWN kan ikke ha evidens (research må startes først), og forblir UNKNOWN uten", () => {
    expect(() => statusOf([ev("a.no")], policy(), "UNKNOWN")).toThrow(InvalidClaimTransitionError);
    expect(statusOf([], policy(), "UNKNOWN")).toMatchObject({ status: "UNKNOWN", path: [] });
  });

  it("status avledes ALLTID av evidensen: ingenting som teller -> RESEARCHING, noe -> PROVISIONAL, regel oppfylt -> VERIFIED (via PROVISIONAL), motstrid -> DISPUTED", () => {
    expect(statusOf([])).toMatchObject({ status: "RESEARCHING", path: [] });
    expect(statusOf([ev("a.no")])).toMatchObject({ status: "PROVISIONAL", path: ["PROVISIONAL"] });
    const verified = statusOf([ev("a.no", { is_primary: true }), ev("b.no")]);
    expect(verified).toMatchObject({ status: "VERIFIED", path: ["PROVISIONAL", "VERIFIED"] });
    expect(verified.verified_at?.getTime()).toBe(NOW.getTime());
    expect(verified.reverify_by).toBeNull(); // ikke tidssensitiv
    expect(statusOf([ev("a.no", { is_primary: true }), ev("b.no"), ev("c.no", { stance: "contradicts" })])).toMatchObject({ status: "DISPUTED", path: ["DISPUTED"] });
  });

  it("motstrid slår en oppfylt regel (selv med mange kilder), og en omstridt påstand kommer tilbake via PROVISIONAL når motstriden er trukket tilbake", () => {
    const many = [ev("a.no", { is_primary: true }), ev("b.no"), ev("c.no"), ev("d.no"), ev("x.no", { stance: "contradicts" })];
    expect(statusOf(many).status).toBe("DISPUTED");
    const resolved = many.map((e) => (e.stance === "contradicts" ? { ...e, retracted: true } : e));
    const back = reduceClaim({ status: "DISPUTED", verified_at: null, reverify_by: null }, resolved, policy(), NOW);
    expect(back).toMatchObject({ status: "VERIFIED", path: ["PROVISIONAL", "VERIFIED"] });
  });

  it("VERIFIED beholder verified_at ved nye beregninger, og faller til DISPUTED når motstrid kommer (verified_at bevares som historikk)", () => {
    const before = new Date("2026-09-20T08:00:00Z");
    const stays = reduceClaim({ status: "VERIFIED", verified_at: before, reverify_by: null }, [ev("a.no", { is_primary: true }), ev("b.no")], policy(), NOW);
    expect(stays).toMatchObject({ status: "VERIFIED", path: [] });
    expect(stays.verified_at?.getTime()).toBe(before.getTime());
    const disputed = reduceClaim({ status: "VERIFIED", verified_at: before, reverify_by: null }, [ev("a.no", { is_primary: true }), ev("b.no"), ev("z.no", { stance: "contradicts" })], policy(), NOW);
    expect(disputed.status).toBe("DISPUTED");
    expect(disputed.verified_at?.getTime()).toBe(before.getTime());
  });

  it("tidssensitiv VERIFIED får re-verifiseringsfrist = når den tidligste tellende støtten eldes ut; evidens som eldes ut gir tilbake PROVISIONAL/RESEARCHING (aldri stille VERIFIED)", () => {
    const p = policy({ time_sensitive: true });
    const evidence = [ev("a.no", { is_primary: true, retrieved_at: daysAgo(10) }), ev("b.no", { retrieved_at: daysAgo(2) })];
    const verified = statusOf(evidence, p);
    expect(verified.status).toBe("VERIFIED");
    expect(verified.reverify_by?.getTime()).toBe(daysAgo(10).getTime() + 30 * DAY);
    // 25 dager senere er den første kilden ikke lenger «nylig sjekket»: regelen er ikke oppfylt, og statusen faller.
    const later = new Date(NOW.getTime() + 25 * DAY);
    const aged = reduceClaim({ status: "VERIFIED", verified_at: NOW, reverify_by: verified.reverify_by }, evidence, p, later);
    expect(aged.status).toBe("PROVISIONAL");
    const allAged = reduceClaim({ status: "VERIFIED", verified_at: NOW, reverify_by: verified.reverify_by }, evidence, p, new Date(NOW.getTime() + 90 * DAY));
    expect(allAged.status).toBe("RESEARCHING");
    expect(allAged.path).toEqual(["PROVISIONAL", "RESEARCHING"]);
  });

  it("egenskapstest (tilfeldige evidenssett): VERIFIED betyr alltid >= N uavhengige, (primær eller >=3) og ingen motstrid; motstrid betyr alltid DISPUTED; kopier endrer aldri statusen; stien er sammenhengende", () => {
    let seed = 987_654_321;
    const rnd = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const keys = ["a.no", "b.no", "c.no", "d.no", "e.no", "origin:ntb"];
    for (let round = 0; round < 400; round += 1) {
      const evidence: ClaimEvidence[] = [];
      const count = Math.floor(rnd() * 8);
      for (let i = 0; i < count; i += 1) {
        evidence.push(ev(keys[Math.floor(rnd() * keys.length)] as string, {
          stance: rnd() < 0.2 ? "contradicts" : "supports", is_primary: rnd() < 0.3, retracted: rnd() < 0.1,
          published_at: rnd() < 0.2 ? null : daysAgo(Math.floor(rnd() * 800)), retrieved_at: daysAgo(Math.floor(rnd() * 90))
        }));
      }
      const p = policy({ min_independent_sources: 2 + Math.floor(rnd() * 3), time_sensitive: rnd() < 0.5 });
      const from = (["RESEARCHING", "PROVISIONAL", "VERIFIED", "DISPUTED"] as const)[Math.floor(rnd() * 4)] as ClaimStatus;
      const result = reduceClaim({ status: from, verified_at: null, reverify_by: null }, evidence, p, NOW);
      const e = result.evaluation;
      const label = `runde ${round}`;
      expect(result.status, label).not.toBe("UNKNOWN");
      if (result.status === "VERIFIED") {
        expect(e.independent_support, label).toBeGreaterThanOrEqual(p.min_independent_sources);
        expect(e.has_primary_support || e.independent_support >= 3, label).toBe(true);
        expect(e.contradicting_count, label).toBe(0);
      }
      if (e.contradicting_count > 0) expect(result.status, label).toBe("DISPUTED");
      // Stien er sammenhengende fra `from` og ender i resultatet.
      let cursor: ClaimStatus = from;
      for (const step of result.path) {
        expect(isAllowedTransition(cursor, step), `${label}: ${cursor}->${step}`).toBe(true);
        cursor = step;
      }
      expect(cursor, label).toBe(result.status);
      // Kopier teller ikke: dupliserer vi hver rad, er statusen den samme.
      const doubled = reduceClaim({ status: from, verified_at: null, reverify_by: null }, [...evidence, ...evidence], p, NOW);
      expect(doubled.status, label).toBe(result.status);
      expect(doubled.evaluation.independent_support, label).toBe(e.independent_support);
    }
  });
});

describe("E: effektiv status (re-verifiseringsfrist)", () => {
  it("en VERIFIED påstand etter fristen vises som PROVISIONAL med reverification_due; før eller nøyaktig på fristen er den fortsatt VERIFIED", () => {
    const due = new Date(NOW.getTime() - 1);
    expect(effectiveClaimStatus({ status: "VERIFIED", reverify_by: due }, NOW)).toEqual({ status: "PROVISIONAL", reverification_due: true });
    expect(effectiveClaimStatus({ status: "VERIFIED", reverify_by: NOW }, NOW)).toEqual({ status: "VERIFIED", reverification_due: false });
    expect(effectiveClaimStatus({ status: "VERIFIED", reverify_by: new Date(NOW.getTime() + 1) }, NOW)).toEqual({ status: "VERIFIED", reverification_due: false });
    expect(effectiveClaimStatus({ status: "VERIFIED", reverify_by: null }, NOW)).toEqual({ status: "VERIFIED", reverification_due: false });
  });

  it("andre statuser er uendret uansett frist", () => {
    for (const status of ["UNKNOWN", "RESEARCHING", "PROVISIONAL", "DISPUTED"] as const) {
      expect(effectiveClaimStatus({ status, reverify_by: new Date(0) }, NOW)).toEqual({ status, reverification_due: false });
    }
  });
});

describe("F: forslag til promotering (aldri en skriving)", () => {
  const base = {
    claim_text: "Norges Bank  satte styringsrenten til 4,5 prosent.", status: "VERIFIED" as ClaimStatus, reverification_due: false,
    evaluation: { independent_support: 3, has_primary_support: true, supporting_keys: ["norges-bank.no", "origin:ntb", "ssb.no"] }, verified_at: new Date("2026-10-01T10:00:00Z")
  };

  it("kun VERIFIED og ikke utløpt kan foreslås - ukjent, foreløpig og omstridt kan aldri bli etablert kunnskap", () => {
    for (const status of ["UNKNOWN", "RESEARCHING", "PROVISIONAL", "DISPUTED"] as const) {
      expect(() => buildPromotionProposal({ ...base, status }), status).toThrow(InvalidClaimTransitionError);
    }
    expect(() => buildPromotionProposal({ ...base, reverification_due: true })).toThrow(InvalidClaimTransitionError);
  });

  it("forslaget bærer påstanden og grunnlaget (antall uavhengige, primærkilde, kilder, dato), som semantisk minne", () => {
    const proposal = buildPromotionProposal(base);
    expect(proposal.type).toBe("semantic");
    expect(proposal.subject).toBe("verifisert: Norges Bank satte styringsrenten til 4,5 prosent.");
    expect(proposal.content).toContain("Norges Bank satte styringsrenten til 4,5 prosent.");
    expect(proposal.content).toContain("Verifisert 2026-10-01: 3 uavhengige kilder, inkl. primærkilde");
    expect(proposal.content).toContain("norges-bank.no, origin:ntb, ssb.no");
  });

  it("grenser: emne <= 120, innhold <= 1000, maks 6 kilder, kontrolltegn fjernes fra emnet, lang påstand kuttes uten å miste grunnlaget", () => {
    const long = "x".repeat(5000);
    const proposal = buildPromotionProposal({ ...base, claim_text: long, evaluation: { ...base.evaluation, supporting_keys: ["a", "b", "c", "d", "e", "f", "g", "h"] } });
    expect(proposal.subject.length).toBeLessThanOrEqual(120);
    expect(proposal.content.length).toBeLessThanOrEqual(1000);
    expect(proposal.content).toContain("a, b, c, d, e, f]");
    expect(proposal.content).not.toContain(", g");
    const control = buildPromotionProposal({ ...base, claim_text: "linje\u0000en\u202e med tegn" });
    expect([...control.subject].every((ch) => ![0, 0x202e].includes(ch.codePointAt(0) as number))).toBe(true);
  });

  it("uten primærkilde og ukjent dato er det ærlig i teksten", () => {
    const proposal = buildPromotionProposal({ ...base, verified_at: null, evaluation: { independent_support: 3, has_primary_support: false, supporting_keys: ["a.no", "b.no", "c.no"] } });
    expect(proposal.content).toContain("Verifisert ukjent dato: 3 uavhengige kilder;");
    expect(proposal.content).not.toContain("primærkilde");
  });
});
