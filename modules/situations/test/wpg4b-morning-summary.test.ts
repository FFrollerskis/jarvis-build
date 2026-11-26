import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolTransport } from "@jarvis/tool-gateway";
import { MORNING_SUMMARY_CATCH_UP_MS, MORNING_SUMMARY_MESSAGE, MorningSummaryService, latestQuietNight, morningSummaryKey } from "../src/morning-summary.ts";
import { SituationSignalBus } from "../src/signal-bus.ts";
import { SituationSignalRunner, type SignalRunnerDeps } from "../src/signal-runner.ts";
import { identity, OWNER, actorOwner, record, startG4Db, TENANT_A, TENANT_B, type G4Db } from "./support/wpg4-db.ts";

/**
 * WP-G4b K5 (D-484, Q-75 pkt 8, JARVIS-115 f): MORGENOPPSUMMERING av nattlige kamerahendelser.
 *  A (rent): `latestQuietNight` (vindu over midnatt/innenfor døgnet, deaktivert, grensene) og nøkkelen.
 *  B (ekte Postgres, ekte gateway): ÉN nøytral melding per natt og rom ved stille-timers slutt; idempotent (også etter «omstart»); ingenting å melde = ingen melding; pause/kill switch;
 *     etterfyllingsvindu; rom-/tenant-isolasjon; meldingen er en KONSTANT uten etiketter/kategorier/tidspunkter/antall; kun en telling leses; det går kun via telegram.notify (ingen ny vei).
 *  C (løperen): tjenesten kjøres av tikket etter levering, kun for rom med et kameraabonnement, feil er synlige (`summary:<kode>`) uten å stoppe noe, og uten tjenesten er tikkresultatet uendret (ingen nytt felt).
 */
const H = 3_600_000;
const at = (iso: string): number => Date.parse(iso);

describe("A: latestQuietNight (rent)", () => {
  it("vindu over midnatt (22 -> 6): natten som nettopp sluttet, målt fra `end:00:00Z`", () => {
    expect(latestQuietNight(at("2026-11-20T06:00:00.000Z"), 22, 6)).toEqual({ startMs: at("2026-11-19T22:00:00.000Z"), endMs: at("2026-11-20T06:00:00.000Z") });
    expect(latestQuietNight(at("2026-11-20T09:30:00.000Z"), 22, 6)).toEqual({ startMs: at("2026-11-19T22:00:00.000Z"), endMs: at("2026-11-20T06:00:00.000Z") });
    // midt i natten: den SISTE FULLFØRTE natten er i går
    expect(latestQuietNight(at("2026-11-20T03:00:00.000Z"), 22, 6)).toEqual({ startMs: at("2026-11-18T22:00:00.000Z"), endMs: at("2026-11-19T06:00:00.000Z") });
    expect(latestQuietNight(at("2026-11-20T05:59:59.999Z"), 22, 6)?.endMs).toBe(at("2026-11-19T06:00:00.000Z"));
  });

  it("vindu innenfor samme døgn (1 -> 5) og med slutt 0; deaktivert/ugyldig gir ingen natt", () => {
    expect(latestQuietNight(at("2026-11-20T12:00:00.000Z"), 1, 5)).toEqual({ startMs: at("2026-11-20T01:00:00.000Z"), endMs: at("2026-11-20T05:00:00.000Z") });
    expect(latestQuietNight(at("2026-11-20T00:00:00.000Z"), 20, 0)).toEqual({ startMs: at("2026-11-19T20:00:00.000Z"), endMs: at("2026-11-20T00:00:00.000Z") });
    for (const [s, e] of [[22, 22], [null, 6], [22, null], [null, null], [-1, 6], [22, 24], [1.5, 6]] as const) expect(latestQuietNight(at("2026-11-20T12:00:00.000Z"), s, e), `${s},${e}`).toBeNull();
  });

  it("nøkkelen er stabil per natt og ulik mellom netter, rom og tenanter", () => {
    const end = at("2026-11-20T06:00:00.000Z");
    expect(morningSummaryKey("t", "home", end)).toBe("situation-morning-summary:t:home:2026-11-20T06:00:00.000Z");
    expect(morningSummaryKey("t", "home", end)).toBe(morningSummaryKey("t", "home", end));
    expect(new Set([morningSummaryKey("t", "home", end), morningSummaryKey("t", "home", end + 24 * H), morningSummaryKey("t", "business", end), morningSummaryKey("u", "home", end)]).size).toBe(4);
  });

  it("meldingen er en KONSTANT: nøytral, uten tall, tidspunkt, etikett, kategori eller navn", () => {
    expect(MORNING_SUMMARY_MESSAGE).toBe("Det ble registrert kamerahendelser mens stille timer gjaldt - åpne Jarvis for detaljer.");
    expect(MORNING_SUMMARY_MESSAGE).not.toMatch(/\d/);
    for (const forbidden of ["person", "pakke", "bevegelse", "dørklokke", "sikkerhet", "inngang", "bilde", "navn"]) expect(MORNING_SUMMARY_MESSAGE.toLowerCase()).not.toContain(forbidden);
  });
});

describe("B: tjenesten mot ekte Postgres og ekte ToolGateway", () => {
  let db: G4Db;
  let bus: SituationSignalBus;
  // klokken: natten 2026-11-19 22:00 -> 2026-11-20 06:00 UTC. Hendelsene skjer under natten; «nå» settes per test.
  const NIGHT_MOMENT = at("2026-11-20T02:00:00.000Z");
  const MORNING = at("2026-11-20T06:05:00.000Z");
  let clock = NIGHT_MOMENT;

  beforeAll(async () => {
    db = await startG4Db("wpg4b_morning");
    bus = new SituationSignalBus({ pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses, subscriptions: (t, s) => db.registry.listEnabled(t, s), now: () => clock });
  }, 240_000);
  afterAll(async () => { await db?.stop(); }, 120_000);
  beforeEach(async () => {
    await db.reset();
    clock = NIGHT_MOMENT;
  });

  const svc = () => new MorningSummaryService(db.appPool);
  const setQuiet = (space: "home" | "business" = "home", tenant = TENANT_A, start: number | null = 22, end: number | null = 6) =>
    db.engine.setNotificationPolicy(tenant, space, { quiet_hours_start_utc: start, quiet_hours_end_utc: end, actor_person_id: OWNER });
  /** En nattlig kamerahendelse (bevegelse i eierens nattvindu = `normal`): holdes av stille timer (`remember`, ikke varslet). */
  async function nightMotion(observation = "obs-1", source = "camera.inngang", minutesBefore = 1, tenant = TENANT_A): Promise<void> {
    await db.registry.subscribe(tenant, "home", { source: "vision", event_type: "motion_detected", filter: { night_hours_utc: { start: 22, end: 6 } } }, tenant === TENANT_A ? actorOwner : { person_id: OWNER, session_id: "s" });
    const out = await bus.publishBatch(tenant, "home", [{
      source: "vision", observation_id: observation, event_type: "motion_detected", source_instance_id: source, source_event_id: `binary_sensor.b@${new Date(clock).toISOString()}`,
      observed_at: new Date(clock - minutesBefore * 60_000).toISOString(), object_label: "SKAL-ALDRI-LEKKE", classification_status: "classified"
    }]);
    expect(out.evaluated).toBe(1);
    // `opened_at` er databaseklokken (virkelig tid); testen styrer «natten» med en simulert klokke, så åpningstidspunktet settes til hendelsens tid (i drift er de like).
    await db.adminPool.query(`UPDATE situations SET opened_at = $2 WHERE tenant_id = $1 AND domain = 'vision' AND detection_key LIKE $3`, [tenant, new Date(clock - minutesBefore * 60_000).toISOString(), `vision:motion_detected:${source}%`]);
  }
  const heldCount = async (): Promise<number> => Number((await db.adminPool.query(`SELECT count(*)::int AS n FROM situations WHERE tenant_id = $1 AND domain = 'vision' AND stage = 'remember' AND last_notified_at IS NULL`, [TENANT_A])).rows[0].n);

  it("nattlige hendelser holdes av stille timer (grunnlaget: `remember`, ikke varslet)", async () => {
    await setQuiet();
    const { telegram } = db.newGateway();
    await nightMotion();
    expect(await heldCount()).toBe(1);
    expect(telegram.messages).toEqual([]);
  });

  it("ved stille-timers slutt sendes ÉN nøytral melding via telegram.notify; samme natt sendes den aldri på nytt (heller ikke fra en NY tjenesteinstans = omstart)", async () => {
    await setQuiet();
    const { gateway, telegram } = db.newGateway();
    await nightMotion();
    await nightMotion("obs-2", "camera.hage", 3);
    expect(await heldCount()).toBe(2);
    // under natten: ingenting
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), at("2026-11-20T04:00:00.000Z"))).status).toBe("outside_window");
    expect(telegram.messages).toEqual([]);
    const first = await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING);
    expect(first).toEqual({ status: "sent", night_end: "2026-11-20T06:00:00.000Z" });
    expect(telegram.messages).toEqual([MORNING_SUMMARY_MESSAGE]);
    for (let i = 0; i < 3; i += 1) expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING + (i + 1) * 60_000)).status).toBe("already_sent");
    // «omstart»: en helt ny gateway og tjeneste mot samme database (ledgeren er varig)
    const restarted = db.newGateway();
    expect((await new MorningSummaryService(db.appPool).deliver(TENANT_A, "home", restarted.gateway, identity(TENANT_A, "home"), MORNING + 10 * 60_000)).status).toBe("already_sent");
    expect(restarted.telegram.messages).toEqual([]);
    expect(telegram.messages).toHaveLength(1);
    // ett varsel i ledgeren, under den deterministiske nøkkelen
    const rows = (await db.adminPool.query(`SELECT idempotency_key, tool_id, action, status FROM tool_executions WHERE tenant_id = $1 AND idempotency_key LIKE 'situation-morning-summary:%'`, [TENANT_A])).rows;
    expect(rows).toEqual([{ idempotency_key: morningSummaryKey(TENANT_A, "home", at("2026-11-20T06:00:00.000Z")), tool_id: "telegram", action: "notify", status: "succeeded" }]);
  });

  it("meldingen er NØYTRAL og innholdsfri: ingen etikett, ingen kategori, ingen tall - uansett hvor mange hendelser og hva etiketten var", async () => {
    await setQuiet();
    const { gateway, telegram } = db.newGateway();
    for (let i = 0; i < 6; i += 1) await nightMotion(`obs-${i}`, `camera.k${i}`, 1 + i);
    await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING);
    expect(telegram.calls).toHaveLength(1);
    expect(telegram.calls[0]!.parameters).toEqual({ message: MORNING_SUMMARY_MESSAGE });
    expect(JSON.stringify(telegram.calls)).not.toMatch(/SKAL-ALDRI-LEKKE|camera\.|motion|\d/);
  });

  it("ingenting å melde = ingen melding: uten hendelser, med kun `low` (dagtid), og når hendelsene allerede ble varslet individuelt", async () => {
    await setQuiet();
    const { gateway, telegram } = db.newGateway();
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING)).status).toBe("nothing_to_report");
    // en hendelse som ble varslet (sluttet stille timer mens den var i oppslagsvinduet) teller ikke
    await nightMotion();
    await db.adminPool.query(`UPDATE situations SET last_notified_at = now(), stage = 'inform' WHERE tenant_id = $1 AND domain = 'vision'`, [TENANT_A]);
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING)).status).toBe("nothing_to_report");
    // en situasjon som står på `remember` men HAR vært varslet (`last_notified_at` satt) teller heller ikke: kun det som aldri ble varslet (uavhengig av stadiet)
    await db.adminPool.query(`UPDATE situations SET last_notified_at = now(), stage = 'remember', priority = 'normal' WHERE tenant_id = $1 AND domain = 'vision'`, [TENANT_A]);
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING)).status).toBe("nothing_to_report");
    // lav prioritet (remember uten at stille timer holdt den) teller ikke
    await db.adminPool.query(`UPDATE situations SET last_notified_at = NULL, stage = 'remember', priority = 'low' WHERE tenant_id = $1 AND domain = 'vision'`, [TENANT_A]);
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING)).status).toBe("nothing_to_report");
    expect(telegram.messages).toEqual([]);
  });

  it("uten stille timer (ikke satt / deaktivert) finnes ingen natt: ingen melding", async () => {
    const { gateway, telegram } = db.newGateway();
    await nightMotion();
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING)).status).toBe("no_quiet_hours");
    await setQuiet("home", TENANT_A, 22, 22);
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING)).status).toBe("no_quiet_hours");
    expect(telegram.messages).toEqual([]);
  });

  it("pause (`vision` eller hele motoren) stopper sendingen; den sendes når pausen er opphevet, så lenge det er innenfor etterfyllingsvinduet - og ikke senere", async () => {
    await setQuiet();
    const { gateway, telegram } = db.newGateway();
    await nightMotion();
    await db.domainPauses.pauseDurable("vision", "test", OWNER);
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING)).status).toBe("paused");
    await db.domainPauses.unpauseDurable("vision", OWNER);
    await db.domainPauses.pauseAllDurable("test", OWNER);
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING)).status).toBe("paused");
    await db.domainPauses.unpauseAllDurable(OWNER);
    expect(telegram.messages).toEqual([]);
    // etterfylling: en tikk 11 t etter slutten sender fortsatt; 13 t etter gjør det ikke
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), at("2026-11-20T06:00:00.000Z") + MORNING_SUMMARY_CATCH_UP_MS + 60_000)).status).toBe("outside_window");
    expect(telegram.messages).toEqual([]);
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), at("2026-11-20T06:00:00.000Z") + MORNING_SUMMARY_CATCH_UP_MS - 60_000)).status).toBe("sent");
    expect(telegram.messages).toEqual([MORNING_SUMMARY_MESSAGE]);
  });

  it("en feilet sending (transport avviser) gir `failed` og prøves igjen under SAMME nøkkel; deretter nøyaktig én melding", async () => {
    await setQuiet();
    const { gateway, telegram } = db.newGateway();
    await nightMotion();
    const original = gateway.get("telegram", "notify") as ToolDefinition;
    let fail = true;
    const flaky: ToolTransport = { async invoke(action, parameters): Promise<{ external_id?: string; data?: JsonValue }> { if (fail) throw new Error("telegram_nede"); return telegram.invoke(action, parameters); } };
    gateway.register({ ...original, transport: flaky });
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING)).status).toBe("failed");
    fail = false;
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING + 60_000)).status).toBe("sent");
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING + 120_000)).status).toBe("already_sent");
    expect(telegram.messages).toEqual([MORNING_SUMMARY_MESSAGE]);
  });

  it("to netter = to meldinger (ulike nøkler); tenant- og rom-isolasjon: andres hendelser telles ikke og gir ingen melding", async () => {
    await setQuiet();
    const { gateway, telegram } = db.newGateway();
    await nightMotion();
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), MORNING)).status).toBe("sent");
    // neste natt
    clock = at("2026-11-21T02:00:00.000Z");
    await nightMotion("obs-neste", "camera.inngang", 1);
    expect((await svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "home"), at("2026-11-21T06:05:00.000Z"))).status).toBe("sent");
    expect(telegram.messages).toEqual([MORNING_SUMMARY_MESSAGE, MORNING_SUMMARY_MESSAGE]);
    // tenant B har egne stille timer men ingen hendelser: ingen melding, og As hendelser påvirker ikke B
    await db.engine.setNotificationPolicy(TENANT_B, "home", { quiet_hours_start_utc: 22, quiet_hours_end_utc: 6, actor_person_id: OWNER });
    expect((await svc().deliver(TENANT_B, "home", gateway, identity(TENANT_B, "home"), at("2026-11-21T06:05:00.000Z"))).status).toBe("nothing_to_report");
    // et annet rom i A uten kamerahendelser
    await setQuiet("business");
    expect((await svc().deliver(TENANT_A, "business", gateway, identity(TENANT_A, "business"), at("2026-11-21T06:05:00.000Z"))).status).toBe("nothing_to_report");
    expect(telegram.messages).toHaveLength(2);
  });

  it("tjenesten leser kun en TELLING (aldri begrunnelse/fakta/nøkler) og avviser en identitet fra et annet rom/tenant", async () => {
    await setQuiet();
    const { gateway } = db.newGateway();
    await nightMotion();
    await expect(svc().deliver(TENANT_A, "home", gateway, identity(TENANT_B, "home"), MORNING)).rejects.toThrow(/scope_mismatch/);
    await expect(svc().deliver(TENANT_A, "home", gateway, identity(TENANT_A, "business"), MORNING)).rejects.toThrow(/scope_mismatch/);
    const source = (await import("node:fs")).readFileSync(new URL("../src/morning-summary.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(source).not.toMatch(/\breason\b|\bdetection_key\b|\bfacts\b|\bsituation_id\b|object_label|SELECT \*/);
    expect(source.match(/gateway\.execute\(/g)).toHaveLength(1);
    expect(source).toMatch(/tool_id: "telegram", action: "notify"/);
    void z; void record;
  });

  // ---- C: løperen ----
  const runnerWith = (gateway: ReturnType<G4Db["newGateway"]>["gateway"], over: Partial<SignalRunnerDeps> = {}) =>
    new SituationSignalRunner({
      pool: db.appPool, bus, engine: db.engine, gateway, readers: { vision: async () => [] }, subscriptions: (t, s) => db.registry.listEnabled(t, s),
      targets: [{ tenant_id: TENANT_A, memory_space: "home" }], identityFor: (t, s) => identity(t, s), guard: { blocked: async () => null }, intervalMs: 60_000, now: () => clock, ...over
    });

  it("C1: tikket kjører tjenesten ETTER levering: ÉN nøytral melding om morgenen (observasjonen er falt ut av oppslagsvinduet), aldri to; tikkresultatet teller den", async () => {
    await setQuiet();
    const { gateway, telegram } = db.newGateway();
    await nightMotion();
    clock = MORNING;
    const runner = runnerWith(gateway, { morningSummary: new MorningSummaryService(db.appPool) });
    const first = await runner.tick();
    expect(first).toMatchObject({ status: "ok", morning_summaries: 1, errors: [] });
    expect(telegram.messages).toEqual([MORNING_SUMMARY_MESSAGE]);
    clock = MORNING + 60_000;
    const second = await runner.tick();
    expect(second.morning_summaries).toBe(0);
    expect(telegram.messages).toHaveLength(1);
  });

  it("C2: uten tjenesten (kamerakilden av) er tikkresultatet uendret: ingen `morning_summaries`, ingen melding, ingen ekstra spørring mot ledgeren", async () => {
    await setQuiet();
    const { gateway, telegram } = db.newGateway();
    await nightMotion();
    clock = MORNING;
    const result = await runnerWith(gateway).tick();
    expect(result.status).toBe("ok");
    expect("morning_summaries" in result).toBe(false);
    expect(telegram.messages).toEqual([]);
  });

  it("C3: kun for rom med et aktivt KAMERAabonnement (fjernet abonnement = slått av), og kun når kill switch ikke stanser tikket", async () => {
    await setQuiet();
    const { gateway } = db.newGateway();
    const calls: Array<{ tenant: string; space: string; at: number }> = [];
    const spy = { deliver: async (tenant: string, space: string, _g: unknown, _i: unknown, at: number) => { calls.push({ tenant, space, at }); return { status: "nothing_to_report" as const }; } };
    // et HA-abonnement alene gir ingen kall
    await db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "water_leak", filter: { entities: [{ entity_id: "binary_sensor.kjeller", role: "leak" }] } }, actorOwner);
    clock = MORNING;
    await runnerWith(gateway, { morningSummary: spy as never, readers: {} }).tick();
    expect(calls).toEqual([]);
    // med et kameraabonnement: ett kall per tikk med (tenant, rom, nåtid)
    await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "motion_detected", filter: {} }, actorOwner);
    await runnerWith(gateway, { morningSummary: spy as never }).tick();
    expect(calls).toEqual([{ tenant: TENANT_A, space: "home", at: MORNING }]);
    // kill switch: ingenting kjøres
    calls.length = 0;
    const blocked = await runnerWith(gateway, { morningSummary: spy as never, guard: { blocked: async () => "kill_switch_active" } }).tick();
    expect(blocked).toMatchObject({ status: "blocked", reason: "kill_switch_active" });
    expect(calls).toEqual([]);
  });

  it("C4: en feil i steget er synlig (`summary:<kode>`, aldri innhold) og stopper verken tikket eller oppryddingen; en mislykket sending likeså", async () => {
    await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "motion_detected", filter: {} }, actorOwner);
    const { gateway } = db.newGateway();
    clock = MORNING;
    const boom = await runnerWith(gateway, { morningSummary: { deliver: async () => { throw new Error("summary_db_down"); } } }).tick();
    expect(boom.status).toBe("ok");
    expect(boom.errors).toEqual(["summary:summary_db_down"]);
    const failed = await runnerWith(gateway, { morningSummary: { deliver: async () => ({ status: "failed" as const }) } }).tick();
    expect(failed.status).toBe("ok");
    expect(failed.errors).toEqual(["summary:send_failed"]);
    expect(failed.morning_summaries).toBe(0);
  });
});
