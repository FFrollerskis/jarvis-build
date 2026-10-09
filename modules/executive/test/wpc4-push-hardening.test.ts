import { describe, expect, it } from "vitest";
import {
  EMPTY_PUSH_LEDGER, classifyNotifyFailure, parseFollowUpPushPolicy, planFollowUpPush, proposeOpsActions, reduceLedger, runFollowUpPushTick, safeFollowUpTitle, toPushItem,
  type FollowUpLedgerPort, type FollowUpNotifier, type FollowUpPushPolicy, type NotifyOutcome, type PushCandidate, type PushDecision, type PushLedgerRow, type PushLedgerState, type PushSend, type PushSendGuard,
  type SettleOutcome
} from "../src/index.ts";

/**
 * WP-C4, rettelser etter den uavhengige sikkerhetsgjennomgangen av PR #312. H1: «tvetydig utfall beholder reservasjonen» holder mot den ekte gatewayen (positiv tillatelsesliste, tabell reason -> frigi/behold med én test per rad),
 * M1: forsøkstak/backoff/minsteavstand på forsøk og stopp FØR reservasjon (kontrollert klokke), M2: hvitelistevask av titler (reviewerens eksempler + fuzz), L1: prototype-oppslag, og den valgfrie «kun antall»-meldingen.
 * Ren logikk + porter (fakes) - mot den EKTE gatewayen/databasen testes det i `apps/api/test/wpc4-follow-up-push-gateway.test.ts`.
 */
const NOON = new Date("2026-10-09T10:00:00.000Z"); // 12:00 lokal tid (sommertid, UTC+2)
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ON: FollowUpPushPolicy = { ...parseFollowUpPushPolicy({ JARVIS_V2_PUSH_ENABLED: "true" }) };
const day = (offsetDays: number, from = NOON): string => new Date(from.getTime() + offsetDays * DAY).toISOString();
const cand = (over: Partial<PushCandidate> = {}): PushCandidate => ({ source_kind: "business_followup", source_id: "fu-1", due_at: day(-2), bucket: "overdue", priority: "normal", provenance: "explicit", title: "Ring Ola om tilbudet", ...over });
const sendOf = (d: PushDecision): PushSend => {
  if (!d.send) throw new Error(`forventet send, fikk ${d.reason}`);
  return d;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// H1: reason -> frigi/behold
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
/**
 * Tabellen er hentet fra den FAKTISKE koden: `ToolGateway.execute()` (modules/tool-gateway/src/gateway.ts: `deny()`-årsaker, `tool_failed:<melding>`, `postcondition_unverified:*`, `execution_in_flight_or_outcome_unknown`),
 * `PolicyGateway.authorize()` (kill_switch_active, connector_frozen, class_b_requires_active_auth ...) og `TelegramTransport.invoke()` (live-transports.ts: `telegram_chat_id_not_configured`, `telegram_error_<status>`).
 * `apps/api/test/wpc4-follow-up-push-gateway.test.ts` driver de nåbare radene gjennom den EKTE gatewayen og viser at tabellen stemmer.
 */
const RELEASE: ReadonlyArray<readonly [string, string]> = [
  ["kill_switch_active", "policy: kill switch (før transport)"],
  ["connector_frozen", "policy/gateway: connector `telegram` frosset (før transport)"],
  ["credential_revoked", "gateway: tilbakekalt credential (før transport)"],
  ["credential_unavailable", "gateway: credential mangler i hvelvet (før transport)"],
  ["credential_not_bound_to_identity", "gateway: ikke eierens identitet (før transport)"],
  ["class_b_requires_active_auth", "policy: svak autentisering for klasse B (før transport)"],
  ["invalid_identity_context", "policy: ugyldig identitet"],
  ["invalid_tool_call", "policy: ugyldig verktøykall"],
  ["unknown_tool", "gateway: verktøyet er ikke registrert"],
  ["invalid_parameters", "gateway: parametre avvist av skjemaet"],
  ["rate_limited", "gateway: per-minutt-grensen (før transport)"],
  ["infra_paused", "policy: infra-modus PAUSED"],
  ["infra_degraded_blocks_class_d", "policy: infra-modus DEGRADED"],
  ["infra_mode_unavailable", "policy: infra-modus uleselig (fail-closed)"],
  ["scope_mismatch:tenant_id", "gateway: tenant i parametre ≠ identitet"],
  ["scope_mismatch:person_id", "gateway: person i parametre ≠ identitet"],
  ["tool_failed:telegram_chat_id_not_configured", "transport: mangler chat-id (kastes før noen forespørsel)"],
  ["tool_failed:unsafe_vendor_url:url_not_plain_http_url", "guardedFetch: URL avvist før fetch (f.eks. ugyldig token)"],
  ["tool_failed:unsafe_vendor_url:url_malformed", "guardedFetch: URL avvist før fetch"],
  ["tool_failed:telegram_error_400", "Telegram: ugyldig forespørsel (avvist av Telegram)"],
  ["tool_failed:telegram_error_401", "Telegram: ugyldig token"],
  ["tool_failed:telegram_error_403", "Telegram: boten er blokkert"],
  ["tool_failed:telegram_error_404", "Telegram: ukjent bot/token"],
  ["tool_failed:telegram_error_429", "Telegram: for mange forespørsler (avvist før behandling)"]
];
const KEEP: ReadonlyArray<readonly [unknown, string]> = [
  ["tool_failed:tool_timeout", "gateway-frist (10 s): fetch kan levere etter fristen (reviewerens S10)"],
  ["postcondition_unverified:tool_timeout_outcome_unknown", "gateway: gjentatt kall etter tidsavbrudd"],
  ["tool_failed:telegram_error_500", "Telegram 5xx: kan ha levert (reviewerens S1)"],
  ["tool_failed:telegram_error_502", "Telegram 5xx: kan ha levert (reviewerens S1)"],
  ["tool_failed:telegram_error_503", "Telegram 5xx"],
  ["tool_failed:telegram_error_504", "Telegram 5xx"],
  ["tool_failed:telegram_error_520", "mellomledd 5xx"],
  ["tool_failed:telegram_error_599", "5xx"],
  ["tool_failed:telegram_error_408", "andre 4xx kan komme fra mellomledd: ikke bevis"],
  ["tool_failed:telegram_error_409", "andre 4xx: ikke bevis"],
  ["tool_failed:telegram_error_499", "andre 4xx: ikke bevis"],
  ["tool_failed:telegram_error_418", "andre 4xx: ikke bevis"],
  ["tool_failed:telegram_error_4000", "ikke en HTTP-status"],
  ["tool_failed:telegram_error_", "tom status"],
  ["tool_failed:telegram_error_400 ", "ikke eksakt streng"],
  ["tool_failed:fetch failed", "nettverksbrudd kan skje etter sending (reviewerens S2)"],
  ["tool_failed:The operation was aborted due to timeout", "fetch-frist (45 s)"],
  ["tool_failed:Unexpected token < in JSON at position 0", "svar-parsing feilet ETTER at Telegram svarte"],
  ["tool_failed:telegram_unsupported_action_x", "ikke en kjent avvisning"],
  ["tool_failed:unsafe_vendor_url:", "tom hale"],
  ["tool_failed:", "tom melding"],
  ["tool_failed:noe helt ukjent", "ukjent transportfeil"],
  ["postcondition_unverified:ledger_finalize_failed", "gateway: ledger-bokføring feilet etter kallet"],
  ["postcondition_unverified:replayed", "gateway: gjentatt kall"],
  ["postcondition_unverified:no_provider_id", "gateway: ingen leverandør-id"],
  ["postcondition_unverified:exception:fetch failed", "avsenderens kastede unntak"],
  ["postcondition_mismatch", "gateway: etterbetingelse brutt"],
  ["execution_in_flight_or_outcome_unknown", "gateway: rad står som reservert / utfall ukjent"],
  ["execution_in_flight", "prefiks av den over"],
  ["class_d_missing_approval", "ikke på listen: ukjent = behold (kan ikke skje for klasse B)"],
  ["preflight_failed:x", "ikke på listen"],
  ["KILL_SWITCH_ACTIVE", "store bokstaver er ikke eksakt"],
  ["kill_switch_active ", "avsluttende mellomrom er ikke eksakt"],
  ["kill_switch_active: ekstra tekst", "ekstra tekst er ikke eksakt"],
  ["scope_mismatch:", "tom hale"],
  ["", "tom streng"],
  [" ", "bare mellomrom"],
  ["ukjent", "ukjent streng"],
  [undefined, "ikke en streng"],
  [null, "ikke en streng"],
  [42, "ikke en streng"],
  [{}, "ikke en streng"]
];

describe("H1: positiv tillatelsesliste - kun bevist «ikke sendt» frigir reservasjonen", () => {
  it.each(RELEASE)("%s frigir (%s)", (reason) => {
    expect(classifyNotifyFailure(reason)).toBe("not_sent");
  });

  it.each(KEEP)("%j beholder reservasjonen (%s)", (reason) => {
    expect(classifyNotifyFailure(reason)).toBe("unknown");
  });

  it("tabellen har ingen duplikater og ingen rad står på begge sider", () => {
    const release = RELEASE.map(([r]) => r);
    expect(new Set(release).size).toBe(release.length);
    for (const [r] of KEEP) expect(release).not.toContain(r);
  });

  it("alle 5xx-statuser og alle 4xx utenfor 400/401/403/404/429 beholder reservasjonen (uttømmende over 100-599)", () => {
    const released: number[] = [];
    for (let status = 100; status <= 599; status += 1) if (classifyNotifyFailure(`tool_failed:telegram_error_${status}`) === "not_sent") released.push(status);
    expect(released).toEqual([400, 401, 403, 404, 429]);
  });

  it("tikket: 5xx/timeout/nettverksbrudd gir send_unknown og reservasjonen beholdes; kun bevist avslag gir send_failed", async () => {
    for (const [reason, expected] of [["tool_failed:telegram_error_502", "send_unknown"], ["tool_failed:tool_timeout", "send_unknown"], ["tool_failed:fetch failed", "send_unknown"], ["kill_switch_active", "send_failed"], ["tool_failed:telegram_error_400", "send_failed"]] as const) {
      const rows: PushLedgerRow[] = [];
      let seq = 0;
      const ledger: FollowUpLedgerPort = {
        async claim(build) { const d = build(reduceLedger(rows, NOON)); if (d.send) rows.push({ seq: ++seq, type: "followup.push_reserved", at: NOON.toISOString(), message_key: d.message_key, item_keys: d.item_keys }); return d; },
        async settle(d, outcome) { rows.push({ seq: ++seq, type: outcome === "sent" ? "followup.push_sent" : outcome === "failed" ? "followup.push_failed" : "followup.push_unknown", at: NOON.toISOString(), message_key: d.message_key, item_keys: [] }); }
      };
      const notifier: FollowUpNotifier = { channel: "telegram", async notify() { return { ok: false, reason }; } };
      const r = await runFollowUpPushTick({ candidates: async () => [cand()], ledger, notifier, guard: { blocked: async () => null } }, ON, () => NOON);
      expect(r, reason).toMatchObject({ sent: false, reason: expected });
      expect(reduceLedger(rows, NOON).consumed_keys.size, reason).toBe(expected === "send_unknown" ? 1 : 0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// M1: forsøkstak, backoff, minsteavstand på forsøk, stopp før reservasjon
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
class Ledger implements FollowUpLedgerPort {
  rows: PushLedgerRow[] = [];
  private seq = 0;
  constructor(private readonly now: () => Date) {}
  async claim(build: (state: PushLedgerState) => PushDecision): Promise<PushDecision> {
    const decision = build(reduceLedger(this.rows, this.now()));
    if (decision.send) this.rows.push({ seq: ++this.seq, type: "followup.push_reserved", at: this.now().toISOString(), message_key: decision.message_key, item_keys: decision.item_keys });
    return decision;
  }
  async settle(decision: PushSend, outcome: SettleOutcome): Promise<void> {
    const type = outcome === "sent" ? "followup.push_sent" : outcome === "failed" ? "followup.push_failed" : "followup.push_unknown";
    this.rows.push({ seq: ++this.seq, type, at: this.now().toISOString(), message_key: decision.message_key, item_keys: [] });
  }
}

function harness(opts: { candidates: () => PushCandidate[]; reason?: () => NotifyOutcome; policy?: Partial<FollowUpPushPolicy>; guard?: PushSendGuard; start?: Date }) {
  let t = (opts.start ?? NOON).getTime();
  const now = () => new Date(t);
  const ledger = new Ledger(now);
  const calls: string[] = [];
  let candidateReads = 0;
  const notifier: FollowUpNotifier = { channel: "telegram", async notify(_text, o) { calls.push(o.idempotency_key); return (opts.reason ?? (() => ({ ok: true })))(); } };
  const guard = opts.guard ?? { blocked: async () => null };
  // Rolig tid flyttes til 03-04 lokal tid så testene kan gå gjennom dagen uten å treffe vinduet.
  const policy: FollowUpPushPolicy = { ...ON, quiet_start_hour: 3, quiet_end_hour: 4, ...opts.policy };
  const ports = { candidates: async () => { candidateReads += 1; return opts.candidates(); }, ledger, notifier, guard };
  return {
    ledger, calls, get reads() { return candidateReads; },
    at: (offsetMs: number) => { t = (opts.start ?? NOON).getTime() + offsetMs; },
    tick: () => runFollowUpPushTick(ports, policy, now)
  };
}
const label = (r: Awaited<ReturnType<ReturnType<typeof harness>["tick"]>>): string => (r.sent ? "sent" : r.reason);

describe("M1: forsøkstak og backoff (kontrollert klokke)", () => {
  const permanent = (): NotifyOutcome => ({ ok: false, reason: "tool_failed:telegram_error_400" });

  it("permanent feil (HTTP 400): backoff 15 min og 1 t, så høyst 3 forsøk per døgn - deretter stille (attempts_exhausted) til døgnet er rundt", async () => {
    const h = harness({ candidates: () => [cand()], reason: permanent, policy: { min_gap_minutes: 0 } });
    const seen: Array<[string, string]> = [];
    const step = async (offsetMin: number) => { h.at(offsetMin * MIN); seen.push([`+${offsetMin}m`, label(await h.tick())]); };
    await step(0); // forsøk 1 (feiler)
    await step(14); // 15 min backoff
    await step(15); // forsøk 2 (feiler) -> 60 min backoff
    await step(74);
    await step(75); // forsøk 3 (feiler) -> tak nådd
    await step(76);
    await step(5 * 60);
    await step(11 * 60);
    await step(23 * 60 + 59);
    expect(seen).toEqual([
      ["+0m", "send_failed"], ["+14m", "backoff"], ["+15m", "send_failed"], ["+74m", "backoff"], ["+75m", "send_failed"],
      ["+76m", "attempts_exhausted"], ["+300m", "attempts_exhausted"], ["+660m", "attempts_exhausted"], ["+1439m", "attempts_exhausted"]
    ]);
    expect(h.calls).toHaveLength(3);
    expect(new Set(h.calls).size).toBe(1); // alle tre forsøk bruker SAMME idempotensnøkkel
  });

  it("neste døgn: taket slipper når det eldste forsøket er 24 t gammelt, og da gjelder 4 t backoff (tre feil bak seg) - aldri mer enn 3 forsøk i noe rullerende døgn", async () => {
    const h = harness({ candidates: () => [cand({ due_at: day(-1) })], reason: permanent, policy: { min_gap_minutes: 0, stale_overdue_days: 30 } });
    const attempts: number[] = [];
    for (let minute = 0; minute <= 3 * 24 * 60; minute += 5) {
      const local = (12 * 60 + minute) % (24 * 60);
      if (local >= 3 * 60 && local < 4 * 60) continue; // rolig tid
      h.at(minute * MIN);
      const r = await h.tick();
      if (!r.sent && r.reason === "send_failed") attempts.push(minute);
    }
    // forsøk 1 (+0), 2 (+15), 3 (+75), så 4 først når forsøk 1 er 24 t gammelt (+1440) og 4 t har gått siden forsøk 3
    expect(attempts.slice(0, 4)).toEqual([0, 15, 75, 1440]);
    for (let i = 0; i < attempts.length; i += 1) {
      const inWindow = attempts.filter((a) => a > attempts[i]! - 24 * 60 && a <= attempts[i]!);
      expect(inWindow.length).toBeLessThanOrEqual(3);
    }
    // 4 t plateau når det har vært ≥ 3 feil: ingen to forsøk nærmere enn 4 t etter det tredje
    for (let i = 3; i < attempts.length; i += 1) expect(attempts[i]! - attempts[i - 1]!).toBeGreaterThanOrEqual(240);
  });

  it("uten kontroll av klokka er standardene dokumenterte: tak 3 per melding per døgn og backoff 15 min / 1 t / 4 t", () => {
    expect(ON.max_attempts_per_message).toBe(3);
    expect([...ON.retry_backoff_minutes]).toEqual([15, 60, 240]);
  });

  it("forsøk teller mot minsteavstanden: en frigitt feil starter de 60 minuttene (før: bare aktive reservasjoner telte)", async () => {
    let n = 0;
    const h = harness({ candidates: () => [cand({ source_id: `fu-${++n > 1 ? 2 : 1}` })], reason: permanent });
    expect(label(await h.tick())).toBe("send_failed"); // forsøk på fu-1 (frigitt)
    h.at(30 * MIN);
    expect(label(await h.tick())).toBe("min_gap"); // en NY melding (fu-2) innen 60 min etter forsøket
    h.at(61 * MIN);
    expect(label(await h.tick())).toBe("send_failed"); // etter 60 min tillates neste forsøk
    expect(h.calls).toHaveLength(2);
  });

  it("frigitte forsøk teller IKKE mot døgngrensen for meldinger (de ble bevist ikke sendt), men sendte og usikre gjør", () => {
    const row = (seq: number, type: PushLedgerRow["type"], min: number, key: string, items: string[] = []): PushLedgerRow => ({ seq, type, at: new Date(NOON.getTime() + min * MIN).toISOString(), message_key: key, item_keys: items });
    const state = reduceLedger([
      row(1, "followup.push_reserved", -300, "a", ["x"]), row(2, "followup.push_failed", -299, "a"),
      row(3, "followup.push_reserved", -200, "a", ["x"]), row(4, "followup.push_failed", -199, "a"),
      row(5, "followup.push_reserved", -100, "b", ["y"]), row(6, "followup.push_unknown", -99, "b")
    ], NOON);
    expect(state.messages_last_24h).toBe(1);
    expect(state.attempts.get("a")).toEqual({ attempts_24h: 2, failures: 2, last_attempt_at: new Date(NOON.getTime() - 200 * MIN).toISOString() });
    expect(state.attempts.get("b")).toEqual({ attempts_24h: 1, failures: 0, last_attempt_at: new Date(NOON.getTime() - 100 * MIN).toISOString() });
    expect(state.last_reserved_at).toBe(new Date(NOON.getTime() - 100 * MIN).toISOString());
  });

  it("forsøk eldre enn 24 t teller ikke mot taket, men feilene (og dermed backoff-trinnet) og siste forsøk huskes", () => {
    const old = (seq: number, type: PushLedgerRow["type"], hoursAgo: number): PushLedgerRow => ({ seq, type, at: new Date(NOON.getTime() - hoursAgo * HOUR).toISOString(), message_key: "m", item_keys: ["x"] });
    const state = reduceLedger([old(1, "followup.push_reserved", 30), old(2, "followup.push_failed", 30), old(3, "followup.push_reserved", 25), old(4, "followup.push_failed", 25), old(5, "followup.push_reserved", 23)], NOON);
    expect(state.attempts.get("m")).toMatchObject({ attempts_24h: 1, failures: 2 });
  });

  it("taket gjelder PER MELDING: en annen melding (annet sett løkker) har egen teller, og planleggeren rapporterer nøkkelen (hash, aldri innhold)", () => {
    const a = sendOf(planFollowUpPush({ candidates: [cand({ source_id: "fu-a" })], policy: ON, state: EMPTY_PUSH_LEDGER, now: NOON }));
    const exhausted: PushLedgerState = {
      ...EMPTY_PUSH_LEDGER,
      attempts: new Map([[a.message_key, { attempts_24h: 3, failures: 3, last_attempt_at: new Date(NOON.getTime() - 5 * HOUR).toISOString() }]])
    };
    const blocked = planFollowUpPush({ candidates: [cand({ source_id: "fu-a" })], policy: ON, state: exhausted, now: NOON });
    expect(blocked).toEqual({ send: false, reason: "attempts_exhausted", message_key: a.message_key });
    expect(a.message_key).toMatch(/^v2-push:[0-9a-f]{40}$/);
    expect(planFollowUpPush({ candidates: [cand({ source_id: "fu-b" })], policy: ON, state: exhausted, now: NOON }).send).toBe(true);
  });

  it("backoff-trinnene følger antall feil: 1 feil = 15 min, 2 = 60 min, 3 eller flere = 240 min", () => {
    const a = sendOf(planFollowUpPush({ candidates: [cand()], policy: ON, state: EMPTY_PUSH_LEDGER, now: NOON }));
    const at = (failures: number, minutesAgo: number) => planFollowUpPush({
      candidates: [cand()], policy: { ...ON, min_gap_minutes: 0 }, now: NOON,
      state: { ...EMPTY_PUSH_LEDGER, attempts: new Map([[a.message_key, { attempts_24h: 1, failures, last_attempt_at: new Date(NOON.getTime() - minutesAgo * MIN).toISOString() }]]) }
    });
    expect(at(1, 14)).toMatchObject({ send: false, reason: "backoff" });
    expect(at(1, 15).send).toBe(true);
    expect(at(2, 59)).toMatchObject({ send: false, reason: "backoff" });
    expect(at(2, 60).send).toBe(true);
    for (const failures of [3, 4, 9]) {
      expect(at(failures, 239), String(failures)).toMatchObject({ send: false, reason: "backoff" });
      expect(at(failures, 240).send, String(failures)).toBe(true);
    }
  });

  it("rekkefølgen er bindende: ... -> minsteavstand -> ingenting nytt -> forsøkstak -> backoff", () => {
    const a = sendOf(planFollowUpPush({ candidates: [cand()], policy: ON, state: EMPTY_PUSH_LEDGER, now: NOON }));
    const long = new Date(NOON.getTime() - 5 * HOUR).toISOString();
    const state: PushLedgerState = { ...EMPTY_PUSH_LEDGER, attempts: new Map([[a.message_key, { attempts_24h: 3, failures: 3, last_attempt_at: long }]]), last_reserved_at: new Date(NOON.getTime() - 10 * MIN).toISOString() };
    expect(planFollowUpPush({ candidates: [cand()], policy: ON, state, now: NOON })).toEqual({ send: false, reason: "min_gap" });
    expect(planFollowUpPush({ candidates: [], policy: ON, state: { ...state, last_reserved_at: long }, now: NOON })).toEqual({ send: false, reason: "nothing_new" });
    expect(planFollowUpPush({ candidates: [cand()], policy: ON, state: { ...state, last_reserved_at: long }, now: NOON })).toMatchObject({ send: false, reason: "attempts_exhausted" });
  });
});

describe("M1(a): stopp FØR reservasjon (kill switch, frys, tilbakekalt credential, infra-pause)", () => {
  it("stanset system: ingen kandidatlesing, ingen reservasjon, ingen audit-rad, ingen sending - seks tikk på rad", async () => {
    const h = harness({ candidates: () => [cand()], guard: { blocked: async () => "kill_switch_active" } });
    for (let i = 0; i < 6; i += 1) {
      h.at(i * 20 * MIN);
      expect(await h.tick()).toEqual({ sent: false, reason: "send_blocked", blocked_by: "kill_switch_active" });
    }
    expect(h.reads).toBe(0);
    expect(h.ledger.rows).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("når stoppen oppheves sendes meldingen straks, og kun én gang", async () => {
    let blocked: string | null = "connector_frozen";
    const h = harness({ candidates: () => [cand()], guard: { blocked: async () => blocked } });
    expect(label(await h.tick())).toBe("send_blocked");
    blocked = null;
    expect(label(await h.tick())).toBe("sent");
    h.at(2 * HOUR);
    expect(label(await h.tick())).toBe("nothing_new");
    expect(h.calls).toHaveLength(1);
    expect(h.ledger.rows.map((r) => r.type)).toEqual(["followup.push_reserved", "followup.push_sent"]);
  });

  it("stoppsjekken feiler (kaster) -> tolkes som stanset (fail-closed), og ugyldig svar fra porten likeså", async () => {
    const throwing = harness({ candidates: () => [cand()], guard: { blocked: async () => { throw new Error("db nede"); } } });
    expect(await throwing.tick()).toEqual({ sent: false, reason: "send_blocked", blocked_by: "guard_unavailable" });
    const weird = harness({ candidates: () => [cand()], guard: { blocked: async () => "" } });
    expect(await weird.tick()).toEqual({ sent: false, reason: "send_blocked", blocked_by: "guard_invalid" });
    expect(throwing.calls.length + weird.calls.length).toBe(0);
  });

  it("er push slått av, sjekkes verken stopp eller kilde", async () => {
    let guardCalls = 0;
    const h = harness({ candidates: () => [cand()], guard: { blocked: async () => { guardCalls += 1; return null; } }, policy: { enabled: false } });
    expect(await h.tick()).toEqual({ sent: false, reason: "disabled" });
    expect(guardCalls).toBe(0);
    expect(h.reads).toBe(0);
  });

  it("blocked_by kuttes og vaskes (porten er injisert kode, men aldri en linjeskift- eller kontrolltegn-vei inn i logg)", async () => {
    const h = harness({ candidates: () => [cand()], guard: { blocked: async () => `kill\nswitch ${"x".repeat(200)}` } });
    const r = await h.tick();
    expect(r.sent).toBe(false);
    const blockedBy = (r as { blocked_by: string }).blocked_by;
    expect(blockedBy).not.toMatch(/\n/);
    expect(blockedBy.length).toBeLessThanOrEqual(60);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// M2: hvitelistevask (reviewerens eksempler + fuzz)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const ALLOWED_OUTPUT = /^[\p{L}\p{Nd} .,:;!?()\-–'’%]*$/u;
const DOMAIN_ASCII = /\w\.[a-z]{2,24}\b/i;
const DOMAIN_UNICODE = /[\p{L}\p{N}]\.\p{L}{2,24}(?![\p{L}\p{N}_])/iu;
const PHONE_LIKE = /\d(?:[ ().-]{0,2}\d){6,}/;
const isInvisible = (cp: number): boolean =>
  cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) || cp === 0xfeff || cp === 0xad || (cp >= 0xe0000 && cp <= 0xe01ef);

/** Invarianter som GJELDER ALL utdata, uansett inndata: ingenting klikkbart, ingenting utenfor hvitelisten. */
function assertSafe(input: string, out: string): void {
  const ctx = JSON.stringify(input.length > 80 ? `${input.slice(0, 80)}…` : input);
  expect(Array.from(out).length, ctx).toBeLessThanOrEqual(60);
  expect(out.length, ctx).toBeGreaterThan(0);
  const body = out.replaceAll("[lenke]", "").replace(/…$/u, "");
  expect(body, ctx).toMatch(ALLOWED_OUTPUT);
  for (const forbidden of ["/", "\\", "@", "#", "*", "_", "<", ">", "`", "$", "&", "=", "|", "~", "^", "+", "«", "»", '"']) expect(out, ctx).not.toContain(forbidden);
  expect(out.replaceAll("[lenke]", ""), ctx).not.toMatch(/[[\]]/);
  expect(out, ctx).not.toMatch(/http/i);
  expect(out, ctx).not.toMatch(/www\./i);
  expect(out, ctx).not.toMatch(DOMAIN_ASCII);
  expect(out, ctx).not.toMatch(DOMAIN_UNICODE);
  expect(out, ctx).not.toMatch(PHONE_LIKE);
  for (const ch of Array.from(out)) expect(isInvisible(ch.codePointAt(0) ?? 0), ctx).toBe(false);
}

describe("M2: safeFollowUpTitle er en hvitelistevask", () => {
  it("reviewerens eksempler: nakne domener med toppdomene utenfor den korte listen", () => {
    for (const host of ["evil.pro", "evil.work", "evil.live", "evil.nl", "evil.fr", "evil.tech", "evil.today", "evil.ca", "evil.pl", "evil.at", "evil.xn--p1ai", "EVIL.PRO", "sub.evil.work/sti?x=1", "evil.work:8080/x"]) {
      for (const title of [host, `Se ${host} nå`, `(${host})`]) {
        const out = safeFollowUpTitle(title);
        expect(out, title).toContain("[lenke]");
        expect(out, title).not.toMatch(/evil|xn--|p1ai/i);
        assertSafe(title, out);
      }
    }
  });

  it("reviewerens eksempler: e-post blir en lenke (ikke «perfirma.pro»), og skråstrek fjernes uansett posisjon", () => {
    expect(safeFollowUpTitle("per@firma.pro")).toBe("[lenke]");
    expect(safeFollowUpTitle("Send til per@firma.pro i dag")).toBe("Send til [lenke] i dag");
    expect(safeFollowUpTitle("Ring (/stopp) nå")).toBe("Ring (stopp) nå");
    expect(safeFollowUpTitle("Se:/godkjenn_alle nå")).toBe("Se:godkjennalle nå");
    for (const t of ["Ring (/stopp) nå", "Se:/godkjenn_alle nå", "a/b\\c", "x/y/z"]) expect(safeFollowUpTitle(t), t).not.toMatch(/[/\\]/);
  });

  it("telefon-, kort- og IBAN-lignende sifferrekker (≥ 7 sifre) blir en lenke - også med skilletegn og landskode", () => {
    for (const t of ["ring +4712345678", "ring 12345678", "ring +47 912 34 567", "ring (+47) 91 23 45 67", "kort 4111111111111111", "kort 4111 1111 1111 1111", "NO9386011117947", "NO93 8601 1117 947", "GB82 WEST 1234 5698 7654 32", "ring 91.23.45.67", "ring 91-23-45-67"]) {
      const out = safeFollowUpTitle(t);
      expect(out, t).toContain("[lenke]");
      expect(out, t).not.toMatch(/\d{4}/);
      assertSafe(t, out);
    }
    for (const fine of ["Frist om 3 dager", "kr 12 500", "tilbud 125 000", "side 12 av 40", "Q4 2026", "v2.1"]) expect(safeFollowUpTitle(fine), fine).toBe(fine);
  });

  it("fullbredde, ideografisk punktum, myk bindestrek og skjøting etter fjerning fanges (skrevet slik at fjerning av tegn ville skjøtet et domene)", () => {
    for (const t of ["ｅｖｉｌ．ｃｏｍ", "evil。com", "evil­.com", "evil/.com", "e/v/i/l/./c/o/m", "evil_.com", "ev<>il.c`om", "evil.@com", "h/ttps://x", "w/ww.evil", "hhttp ps"]) {
      const out = safeFollowUpTitle(t);
      assertSafe(t, out);
      expect(out, t).not.toMatch(/evil/i);
    }
  });

  it("vanlig norsk tekst går uendret gjennom (bokstaver, sifre, mellomrom og .,:;!?()-–'’%)", () => {
    for (const t of ["Ring Ola om tilbudet", "Æ, Ø og Å – rapport", "Frist: fredag! Husk (viktig) 50 % rabatt; ring tilbake?", "O'Brien’s avtale - del 2"]) expect(safeFollowUpTitle(t), t).toBe(t);
  });

  it("kutter til høyst 60 tegn (markører teller som «[lenke]»), også når kuttet ville laget et NYTT mønster av et langt toppdomene", () => {
    const longTld = `${"a".repeat(54)} x.${"b".repeat(30)}`; // toppdomene på 30 tegn er ikke en lenke - men et kutt til 2-24 tegn ville blitt det
    const out = safeFollowUpTitle(longTld);
    assertSafe(longTld, out);
    const manyLinks = safeFollowUpTitle(Array.from({ length: 30 }, (_, i) => `evil${i}.com`).join(" "));
    assertSafe("mange lenker", manyLinks);
    expect(manyLinks).toBe("[lenke]");
  });

  it("fuzz (deterministisk): 6000 tilfeldige strenger fra et fiendtlig alfabet gir aldri `/`, `@`, `http`, `www.`, domene- eller telefonmønster", () => {
    const fragments = [
      "evil", "com", "no", "pro", "xn--p1ai", "http", "https", "HTTP", "www", "WWW", ".", ".", ".", "/", "//", "\\", "@", "#", "$", "*", "_", "[", "]", "<", ">", "`", ":", ";", ",", "!", "?", "(", ")", "-", "–", "'", "’", "%", "+", "=", "&", "|", "~", "^", '"', "«", "»",
      " ", "  ", "\n", "\t", "1", "23", "4567", "89012345", "NO93", "8601", "per", "firma", "ring", "nå", "æøå", "ß", "İ", "ǆ", "Ａ", "ｅ", "．", "。", "／", "＠", "​", "‮", "­", "́", "\u0000", "\u{e0041}", "😀", "𝒜", "\u{20000}",
      "е", "ο", "tel:", "mailto:", "javascript:", "tg://", "data:", "lenke", "[lenke]", "…", "xn--", "ab", "a", "b.c", "m.fl", "f.eks"
    ];
    let seed = 0x9e3779b9;
    const rnd = (): number => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    for (let i = 0; i < 6000; i += 1) {
      const n = 1 + Math.floor(rnd() * 14);
      let input = "";
      for (let j = 0; j < n; j += 1) input += fragments[Math.floor(rnd() * fragments.length)];
      assertSafe(input, safeFollowUpTitle(input));
    }
  });

  it("fuzz (struktur): domener, e-post og skjema satt sammen av fjernbare tegn gir aldri et domene i utdata", () => {
    const junk = ["/", "\\", "_", "<", ">", "`", "@", "#", "*", "­", "[", "]", "$"];
    const tlds = ["com", "pro", "work", "no", "xn--p1ai", "co", "fr"];
    let seed = 12345;
    const rnd = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 3000; i += 1) {
      const sprinkle = (): string => (rnd() < 0.5 ? junk[Math.floor(rnd() * junk.length)]! : "");
      const host = `${[...`evil${i}`].map((c) => c + sprinkle()).join("")}${sprinkle()}.${sprinkle()}${[...tlds[Math.floor(rnd() * tlds.length)]!].map((c) => c + sprinkle()).join("")}`;
      const input = rnd() < 0.3 ? `${host} nå` : rnd() < 0.5 ? `Se ${host}/sti` : host;
      assertSafe(input, safeFollowUpTitle(input));
    }
  });

  it("ingen katastrofal backtracking: fiendtlige 400-tegns strenger vaskes raskt", () => {
    const hostile = ["a.".repeat(200), "1".repeat(400), "a".repeat(400), ". ".repeat(200), "@".repeat(400), "a@".repeat(200), `xn--${"a".repeat(390)}`, "http".repeat(100), "1 ".repeat(200), "a-".repeat(200), `${"a".repeat(200)}.${"b".repeat(25)}`, "\u{fdfa}".repeat(400)];
    const started = performance.now();
    for (const h of hostile) assertSafe(h, safeFollowUpTitle(h));
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("kaster aldri på rare inndata og tom/bare-lenke gir faste svar", () => {
    for (const v of [null, undefined, 42, {}, [], "", "   ", "​‮"]) expect(() => safeFollowUpTitle(v as never)).not.toThrow();
    expect(safeFollowUpTitle("")).toBe("uten tittel");
    expect(safeFollowUpTitle("https://evil.example")).toBe("[lenke]");
    expect(safeFollowUpTitle("evil.pro evil.work")).toBe("[lenke]");
  });
});

describe("M2 (valgfri): JARVIS_V2_PUSH_TITLES=false sender kun antall og «åpne dashbordet»", () => {
  it("er PÅ som standard; kun tom/usatt/`true` gir titler - alt annet (også skrivefeil) strammer inn til kun antall", () => {
    for (const v of [undefined, "", "  ", "true", " true "]) expect(parseFollowUpPushPolicy({ JARVIS_V2_PUSH_TITLES: v }).include_titles, String(v)).toBe(true);
    for (const v of ["false", "FALSE", "False", "0", "no", "nei", "off", "tru e", "yes", "1"]) expect(parseFollowUpPushPolicy({ JARVIS_V2_PUSH_TITLES: v }).include_titles, v).toBe(false);
    expect(parseFollowUpPushPolicy({}).include_titles).toBe(true);
  });

  it("meldingen har kun antall per gruppe og den faste oppfordringen - ingen tittel, etikett, dato eller id", () => {
    const off: FollowUpPushPolicy = { ...ON, include_titles: false };
    const d = sendOf(planFollowUpPush({
      candidates: [cand({ title: "Ring Kari om tilbudet", source_id: "fu-1" }), cand({ title: "Send faktura", source_id: "fu-2" }), cand({ source_id: "fu-3", bucket: "due_soon", due_at: day(1), title: "Book møte" }), cand({ source_kind: "business_open_loop", source_id: "ol-1", provenance: "deterministic", title: "support_ticket_overdue" })],
      policy: off, state: EMPTY_PUSH_LEDGER, now: NOON
    }));
    expect(d.text).toBe([
      "Oppfølging fra Jarvis: 4 saker trenger deg (3 forfalt, 1 snart forfall).",
      "Dette er en påminnelse fra dine egne lister. Åpne dashbordet eller spør meg om oppfølginger."
    ].join("\n"));
    for (const forbidden of ["Kari", "faktura", "møte", "Supportsak", "fu-1", "«", "-"]) expect(d.text).not.toContain(forbidden);
    expect(d.items).toHaveLength(4); // ledgeren bruker fortsatt løkkenøklene
    expect(d.item_keys).toHaveLength(4);
  });

  it("entall og bare én gruppe", () => {
    const off: FollowUpPushPolicy = { ...ON, include_titles: false };
    expect(sendOf(planFollowUpPush({ candidates: [cand()], policy: off, state: EMPTY_PUSH_LEDGER, now: NOON })).text).toContain("1 sak trenger deg (1 forfalt).");
    expect(sendOf(planFollowUpPush({ candidates: [cand({ bucket: "due_soon", due_at: day(1) })], policy: off, state: EMPTY_PUSH_LEDGER, now: NOON })).text).toContain("1 sak trenger deg (1 snart forfall).");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// L1: prototype-oppslag
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("L1: ubetrodd nøkkel i ordbok-oppslag gir aldri en prototype-funksjon", () => {
  const PROTO_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "__defineGetter__", "isPrototypeOf"];

  it("løkketype fra databasen: `constructor`/`toString`/`__proto__` gir den generiske etiketten, aldri «function Object() …»", () => {
    for (const title of PROTO_KEYS) {
      const item = toPushItem(cand({ source_kind: "business_open_loop", source_id: "ol-1", provenance: "deterministic", title }), NOON, 14);
      expect(item?.label, title).toBe("Åpen sak");
      const d = sendOf(planFollowUpPush({ candidates: [cand({ source_kind: "business_open_loop", source_id: "ol-1", provenance: "deterministic", title })], policy: ON, state: EMPTY_PUSH_LEDGER, now: NOON }));
      expect(d.text, title).not.toMatch(/function|native code|\[object/i);
    }
    expect(toPushItem(cand({ source_kind: "business_open_loop", source_id: "ol-2", provenance: "deterministic", title: "stalled_opportunity" }), NOON, 14)?.label).toBe("Salgsmulighet står stille");
  });

  it("prioritet fra databasen: `constructor` ødelegger ikke sorteringen (deterministisk rekkefølge)", () => {
    const cands = [cand({ source_id: "b", priority: "constructor" as never }), cand({ source_id: "a", priority: "high" }), cand({ source_id: "c", priority: "__proto__" as never })];
    const first = sendOf(planFollowUpPush({ candidates: cands, policy: ON, state: EMPTY_PUSH_LEDGER, now: NOON }));
    const second = sendOf(planFollowUpPush({ candidates: [...cands].reverse(), policy: ON, state: EMPTY_PUSH_LEDGER, now: NOON }));
    expect(first.items.map((i) => i.source_id)).toEqual(second.items.map((i) => i.source_id));
  });

  it("SLO-id fra rapporten: `constructor` er ikke en tjeneste og gir ingen omstartsforslag (V5)", () => {
    for (const id of PROTO_KEYS) {
      const report = proposeOpsActions({ enabled: true, slo: [{ id, status: "BREACH" }], observations: null, connectors: null, tasks_waiting_over_15m: null });
      expect(report.proposals.filter((p) => p.action_id === "restart_service"), id).toEqual([]);
      expect(report.skipped_no.join(" "), id).toContain("ukjent tjeneste");
    }
    expect(proposeOpsActions({ enabled: true, slo: [{ id: "chat_success", status: "BREACH" }], observations: null, connectors: null, tasks_waiting_over_15m: null }).proposals.map((p) => p.id)).toContain("restart_service:api");
  });
});
