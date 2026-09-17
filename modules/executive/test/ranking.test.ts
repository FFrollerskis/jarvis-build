import { describe, expect, it } from "vitest";
import type { Situation } from "@jarvis/situations";
import {
  PRIORITY_WEIGHT,
  STAGE_ATTENTION_WEIGHT,
  classifyActionKind,
  computeAttentionScore,
  isAttentionWorthy,
  isInNotificationCooldown,
  rankAttentionQueue,
  recommendNextAction
} from "../src/ranking.ts";

/**
 * UA-11 Executive Mode (P0, D-162): REN enhetstest - INGEN database, INGEN
 * embedded Postgres. Beviser at rangeringen er deterministisk/tie-break-
 * stabil/replay-stabil UTEN noe I/O, slik den er designet for (se
 * `ranking.ts` sitt filhode).
 */
let seq = 0;
function mkSituation(overrides: Partial<Situation> = {}): Situation {
  seq += 1;
  return {
    situation_id: `sit-${String(seq).padStart(3, "0")}`,
    tenant_id: "tenant-a",
    memory_space_id: "business",
    domain: "pipeline",
    owner_person_id: null,
    source_open_loop_id: null,
    detection_key: `key-${seq}`,
    stage: "inform",
    priority: "normal",
    confidence: null,
    reason: `Testgrunn ${seq}`,
    status: "open",
    last_notified_at: null,
    act_tool_id: null,
    act_action: null,
    act_result: null,
    act_idempotency_key: null,
    act_claimed_at: null,
    act_operation_fingerprint: null,
    act_notify_message: null,
    inform_message: null,
    inform_delivered_at: null,
    opened_at: "2026-09-01T00:00:00.000Z",
    resolved_at: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

const NOW = new Date("2026-09-17T12:00:00.000Z");
const noAuthority = { pausedDomains: new Set<string>(), autonomyBoundDomains: new Set<string>(), autonomyEnabledDomains: new Set<string>() };

describe("A: stage/priority-vekter og action-kind-klassifisering er totalordnet og dokumentert", () => {
  it("STAGE_ATTENTION_WEIGHT dekker alle syv stadier, escalate høyest, remember/ignore=0", () => {
    expect(Object.keys(STAGE_ATTENTION_WEIGHT).sort()).toEqual(["act", "act_notify", "escalate", "ignore", "inform", "remember", "suggest"].sort());
    expect(STAGE_ATTENTION_WEIGHT.escalate).toBeGreaterThan(STAGE_ATTENTION_WEIGHT.suggest);
    expect(STAGE_ATTENTION_WEIGHT.remember).toBe(0);
    expect(STAGE_ATTENTION_WEIGHT.ignore).toBe(0);
  });
  it("PRIORITY_WEIGHT: high > normal > low", () => {
    expect(PRIORITY_WEIGHT.high).toBeGreaterThan(PRIORITY_WEIGHT.normal);
    expect(PRIORITY_WEIGHT.normal).toBeGreaterThan(PRIORITY_WEIGHT.low);
  });
  it("classifyActionKind: suggest->suggest, act/act_notify/escalate->act, resten->read", () => {
    expect(classifyActionKind("suggest")).toBe("suggest");
    expect(classifyActionKind("act")).toBe("act");
    expect(classifyActionKind("act_notify")).toBe("act");
    expect(classifyActionKind("escalate")).toBe("act");
    expect(classifyActionKind("inform")).toBe("read");
    expect(classifyActionKind("remember")).toBe("read");
    expect(classifyActionKind("ignore")).toBe("read");
  });
  it("isAttentionWorthy er false KUN for remember/ignore", () => {
    for (const stage of ["ignore", "remember", "inform", "suggest", "act", "act_notify", "escalate"] as const) {
      expect(isAttentionWorthy(stage)).toBe(stage !== "ignore" && stage !== "remember");
    }
  });
});

describe("B: computeAttentionScore er en REN funksjon av stage/priority/confidence/cooldown", () => {
  it("samme input gir ALLTID samme score (kalt 100 ganger)", () => {
    const s = mkSituation({ stage: "suggest", priority: "high", confidence: 0.82 });
    const scores = Array.from({ length: 100 }, () => computeAttentionScore(s, NOW, 24));
    expect(new Set(scores).size).toBe(1);
  });
  it("escalate > suggest > inform > act > act_notify ved LIK priority/confidence", () => {
    const base = { priority: "normal" as const, confidence: null, last_notified_at: null };
    const score = (stage: Situation["stage"]) => computeAttentionScore({ ...base, stage }, NOW, 24);
    expect(score("escalate")).toBeGreaterThan(score("suggest"));
    expect(score("suggest")).toBeGreaterThan(score("inform"));
    expect(score("inform")).toBeGreaterThan(score("act"));
    expect(score("act")).toBeGreaterThan(score("act_notify"));
  });
  it("high priority slår aldri over en hel stage-terskel (priority er sekundær til stage)", () => {
    const suggestNormal = computeAttentionScore({ stage: "suggest", priority: "normal", confidence: null, last_notified_at: null }, NOW, 24);
    const informHigh = computeAttentionScore({ stage: "inform", priority: "high", confidence: 1, last_notified_at: null }, NOW, 24);
    expect(suggestNormal).toBeGreaterThan(informHigh);
  });
  it("confidence bidrar aldri nok til å hoppe en hel priority-terskel", () => {
    const lowConfidence0 = computeAttentionScore({ stage: "suggest", priority: "low", confidence: 1, last_notified_at: null }, NOW, 24);
    const normalConfidence0 = computeAttentionScore({ stage: "suggest", priority: "normal", confidence: 0, last_notified_at: null }, NOW, 24);
    expect(normalConfidence0).toBeGreaterThan(lowConfidence0);
  });
  it("isInNotificationCooldown: innenfor vinduet -> true, utenfor -> false, null/0-timer -> alltid false", () => {
    expect(isInNotificationCooldown("2026-09-17T11:00:00.000Z", NOW, 24)).toBe(true); // 1t siden, 24t vindu
    expect(isInNotificationCooldown("2026-09-15T00:00:00.000Z", NOW, 24)).toBe(false); // >24t siden
    expect(isInNotificationCooldown(null, NOW, 24)).toBe(false);
    expect(isInNotificationCooldown("2026-09-17T11:59:00.000Z", NOW, 0)).toBe(false);
  });
  it("cooldown-nedvekting er STRENGT mindre enn ett heltalls stage/priority-hakk", () => {
    const notCooling = computeAttentionScore({ stage: "inform", priority: "normal", confidence: null, last_notified_at: null }, NOW, 24);
    const cooling = computeAttentionScore({ stage: "inform", priority: "normal", confidence: null, last_notified_at: "2026-09-17T11:59:00.000Z" }, NOW, 24);
    expect(cooling).toBeLessThan(notCooling);
    // Nedvektingen (1) er strengt mindre enn ETT priority-hakk (100) og ETT stage-hakk (1000) - aldri stor nok til å endre relativ orden mellom to ULIKE stage/priority-par.
    expect(notCooling - cooling).toBeLessThanOrEqual(1);
    expect(notCooling - cooling).toBeLessThan(PRIORITY_WEIGHT.high * 100 || 1);
  });
});

describe("C: recommendNextAction er deterministisk og gjenspeiler autoritetsstatus, aldri modell-generert", () => {
  const noAuth = { domain_paused: false, autonomy_bound: false, autonomy_enabled: false };
  it("pauset domene vinner over stage - anbefalingen sier alltid 'pauset'", () => {
    expect(recommendNextAction("suggest", { ...noAuth, domain_paused: true })).toMatch(/pauset/);
    expect(recommendNextAction("escalate", { ...noAuth, domain_paused: true })).toMatch(/pauset/);
  });
  it("suggest uten bundet policy ber om manuell gjennomgang; med aktivert policy nevner neste sveip", () => {
    expect(recommendNextAction("suggest", noAuth)).toMatch(/manuelt/);
    expect(recommendNextAction("suggest", { ...noAuth, autonomy_bound: true, autonomy_enabled: true })).toMatch(/sveip/);
  });
  it("escalate/act/act_notify/inform gir distinkte, deterministiske tekster", () => {
    const texts = new Set(
      (["escalate", "act", "act_notify", "inform"] as const).map((s) => recommendNextAction(s, noAuth))
    );
    expect(texts.size).toBe(4);
  });
});

describe("D: rankAttentionQueue - deterministisk, tie-break-stabil, replay-stabil, tenant/space-nøytral (filtrering skjer hos kalleren)", () => {
  it("filtrerer ut remember/ignore, behold resten", () => {
    const situations = [mkSituation({ stage: "ignore" }), mkSituation({ stage: "remember" }), mkSituation({ stage: "inform" })];
    const ranked = rankAttentionQueue(situations, { now: NOW, cooldownHours: 24, ...noAuthority });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.stage).toBe("inform");
  });
  it("sorterer etter score DESC, deretter opened_at ASC (eldst/mest-overdue FØRST) ved lik score", () => {
    const older = mkSituation({ stage: "suggest", priority: "high", opened_at: "2026-09-10T00:00:00.000Z" });
    const newer = mkSituation({ stage: "suggest", priority: "high", opened_at: "2026-09-16T00:00:00.000Z" });
    const ranked = rankAttentionQueue([newer, older], { now: NOW, cooldownHours: 24, ...noAuthority });
    expect(ranked.map((r) => r.situation_id)).toEqual([older.situation_id, newer.situation_id]);
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[1]!.rank).toBe(2);
  });
  it("siste tie-break er situation_id ASC ved HELT identisk score+opened_at - total, aldri tvetydig determinisme", () => {
    const a = mkSituation({ stage: "inform", priority: "normal", opened_at: "2026-09-10T00:00:00.000Z", situation_id: "sit-zzz" });
    const b = mkSituation({ stage: "inform", priority: "normal", opened_at: "2026-09-10T00:00:00.000Z", situation_id: "sit-aaa" });
    const ranked = rankAttentionQueue([a, b], { now: NOW, cooldownHours: 24, ...noAuthority });
    expect(ranked.map((r) => r.situation_id)).toEqual(["sit-aaa", "sit-zzz"]);
  });
  it("REPLAY-STABILITET: identisk input gir BOKSTAVELIG samme rangerte array (JSON-lik) ved gjentatt kjøring", () => {
    const situations = [
      mkSituation({ stage: "suggest", priority: "high", confidence: 0.9 }),
      mkSituation({ stage: "escalate", priority: "normal" }),
      mkSituation({ stage: "act_notify", priority: "low", last_notified_at: "2026-09-17T11:00:00.000Z" })
    ];
    const opts = { now: NOW, cooldownHours: 24, ...noAuthority };
    const run1 = rankAttentionQueue(situations, opts);
    const run2 = rankAttentionQueue([...situations].reverse(), opts); // input-rekkefølge skal IKKE påvirke resultatet
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });
  it("authority_status.domain_paused=true når domenet ELLER '*' er i pausedDomains", () => {
    const s = mkSituation({ stage: "suggest", domain: "spend" });
    const rankedByDomain = rankAttentionQueue([s], { now: NOW, cooldownHours: 24, pausedDomains: new Set(["spend"]), autonomyBoundDomains: new Set(), autonomyEnabledDomains: new Set() });
    const rankedByAll = rankAttentionQueue([s], { now: NOW, cooldownHours: 24, pausedDomains: new Set(["*"]), autonomyBoundDomains: new Set(), autonomyEnabledDomains: new Set() });
    const rankedUnpaused = rankAttentionQueue([s], { now: NOW, cooldownHours: 24, ...noAuthority });
    expect(rankedByDomain[0]!.authority_status.domain_paused).toBe(true);
    expect(rankedByAll[0]!.authority_status.domain_paused).toBe(true);
    expect(rankedUnpaused[0]!.authority_status.domain_paused).toBe(false);
  });
  it("authority_status skiller 'bundet men deaktivert' fra 'aldri bundet'", () => {
    const s = mkSituation({ stage: "suggest", domain: "pipeline" });
    const boundDisabled = rankAttentionQueue([s], { now: NOW, cooldownHours: 24, pausedDomains: new Set(), autonomyBoundDomains: new Set(["pipeline"]), autonomyEnabledDomains: new Set() });
    const boundEnabled = rankAttentionQueue([s], { now: NOW, cooldownHours: 24, pausedDomains: new Set(), autonomyBoundDomains: new Set(["pipeline"]), autonomyEnabledDomains: new Set(["pipeline"]) });
    expect(boundDisabled[0]!.authority_status).toEqual({ domain_paused: false, autonomy_bound: true, autonomy_enabled: false });
    expect(boundEnabled[0]!.authority_status).toEqual({ domain_paused: false, autonomy_bound: true, autonomy_enabled: true });
  });
  it("hvert item forklarer minst source/domain, urgency/priority, hvorfor (reason), og en anbefalt neste handling", () => {
    const s = mkSituation({ stage: "suggest", domain: "spend", reason: "Uvanlig utgift oppdaget", priority: "high", confidence: 0.9 });
    const [item] = rankAttentionQueue([s], { now: NOW, cooldownHours: 24, ...noAuthority });
    expect(item!.domain).toBe("spend");
    expect(item!.reason).toBe("Uvanlig utgift oppdaget");
    expect(item!.priority).toBe("high");
    expect(item!.action_kind).toBe("suggest");
    expect(item!.source_open_loop_id).toBe(s.source_open_loop_id);
    expect(item!.detection_key).toBe(s.detection_key);
    expect(item!.explanation.length).toBeGreaterThan(0);
    expect(item!.recommended_next_action.length).toBeGreaterThan(0);
  });
  it("tom liste og en liste av kun ikke-attention-verdige situasjoner gir et gyldig, tomt resultat - kaster ikke", () => {
    expect(rankAttentionQueue([], { now: NOW, cooldownHours: 24, ...noAuthority })).toEqual([]);
    expect(rankAttentionQueue([mkSituation({ stage: "ignore" })], { now: NOW, cooldownHours: 24, ...noAuthority })).toEqual([]);
  });
});
