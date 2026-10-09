import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import {
  DEFAULT_SUPPORT_SLA_HOURS, OpenLoopService, SupportSlaConfigError, classifyAttentionBucket, parseSupportSlaHours, type SupportSlaPolicy
} from "../src/index.ts";

/**
 * WP-D2 (JARVIS-082): «SLA-regel-spøkelset». `support_ticket_overdue` leste `next_response_due_at`/`next_action_due_at`, som INGEN produksjonskode noensinne satte (kun tester) - regelen kunne
 * aldri slå ut. Den er nå KOBLET til faktiske support-data: svarfristen utledes fra siste ubesvarte kundemelding + et vindu per prioritet. (Ikke fjernet - ett av de to, aldri begge.)
 * Mot ekte Postgres som app-rolle (RLS). Vinduene er forslag (NEEDS_TOBIAS) og kan overstyres/slås av.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let loops: OpenLoopService;
let loopsOff: OpenLoopService;
let loopsCustom: OpenLoopService;

const T = "tenant-wpd2-sla";
const T_B = "tenant-wpd2-sla-b";
const SP = "business" as const;
const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd2-sla-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpd2_sla LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_wpd2_sla");
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}', 'Sla', 'business'), ('${T_B}', 'Sla B', 'business')`);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd2_sla", password: "pw2" });
  loops = new OpenLoopService(app);
  loopsOff = new OpenLoopService(app, { supportSla: null });
  loopsCustom = new OpenLoopService(app, { supportSla: { urgent: 1, high: 2, normal: 48, low: 96 } });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

let seq = 0;
/** Oppretter en ticket + hendelser direkte (admin) – nøyaktig det en kundemelding/svar etterlater i support_ticket_events. */
async function ticket(opts: {
  tenant?: string; priority?: "low" | "normal" | "high" | "urgent"; status?: string; messageHoursAgo?: number | null; replyHoursAfterMessage?: number | null;
  noteHoursAfterMessage?: number | null; nextResponseDueHoursAgo?: number | null; subject?: string;
}): Promise<string> {
  const tenant = opts.tenant ?? T;
  const id = `tkt-sla-${(seq += 1)}`;
  await admin.query(
    `INSERT INTO support_tickets (ticket_id, tenant_id, subject, status, priority, next_response_due_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::float8 IS NULL THEN NULL ELSE now() - make_interval(secs => $6::float8 * 3600) END)`,
    [id, tenant, opts.subject ?? `Emne ${id}`, opts.status ?? "open", opts.priority ?? "normal", opts.nextResponseDueHoursAgo ?? null]
  );
  const event = (type: string, hoursAgo: number, n: number) => admin.query(
    `INSERT INTO support_ticket_events (event_id, tenant_id, ticket_id, event_type, summary, occurred_at) VALUES ($1, $2, $3, $4, 'x', $5)`,
    [`evt-${id}-${n}`, tenant, id, type, ago(hoursAgo)]
  );
  if (opts.messageHoursAgo !== undefined && opts.messageHoursAgo !== null) {
    await event("customer_message", opts.messageHoursAgo, 1);
    if (opts.replyHoursAfterMessage != null) await event("agent_reply", opts.messageHoursAgo - opts.replyHoursAfterMessage, 2);
    if (opts.noteHoursAfterMessage != null) await event("internal_note", opts.messageHoursAgo - opts.noteHoursAfterMessage, 3);
  }
  return id;
}
const overdueLoop = async (tenant: string, ticketId: string) =>
  (await loops.listOpenLoops(tenant, SP, "all")).find((l) => l.loop_type === "support_ticket_overdue" && l.ticket_id === ticketId);
const sweep = async (svc: OpenLoopService, tenant = T) => svc.detectOverdueSupportTickets(tenant, SP);

describe("A: parseSupportSlaHours (ren, fail closed)", () => {
  it("tom/ikke satt = forslagene; «off» = av (null); delvis overstyring beholder resten", () => {
    expect(DEFAULT_SUPPORT_SLA_HOURS).toEqual({ urgent: 4, high: 8, normal: 24, low: 72 });
    for (const raw of [undefined, null, "", "   "]) expect(parseSupportSlaHours(raw), String(raw)).toEqual(DEFAULT_SUPPORT_SLA_HOURS);
    for (const raw of ["off", "OFF", " off "]) expect(parseSupportSlaHours(raw), raw).toBeNull();
    expect(parseSupportSlaHours("normal=48")).toEqual({ urgent: 4, high: 8, normal: 48, low: 72 });
    expect(parseSupportSlaHours("urgent=2, high=6, normal=12, low=24")).toEqual({ urgent: 2, high: 6, normal: 12, low: 24 });
  });
  it("ugyldige verdier kaster SupportSlaConfigError (aldri en stille standard)", () => {
    for (const raw of ["normal", "normal=", "normal=abc", "normal=0", "normal=-5", "normal=1.5", "normal=721", "critical=4", "normal=24,normal=48", "urgent=10,high=5", "high=30,normal=24", "normal=24;low=72", "=4", "urgent=4,", "off,normal=24", "urgent = four"]) {
      expect(() => parseSupportSlaHours(raw), raw).toThrowError(SupportSlaConfigError);
    }
  });
  it("rekkefølgen må være monoton (høyere prioritet har aldri lengre frist)", () => {
    expect(() => parseSupportSlaHours("urgent=24,high=8")).toThrowError(/urgent.*high|høyere/);
    const ok: SupportSlaPolicy = parseSupportSlaHours("urgent=8,high=8,normal=8,low=8") as SupportSlaPolicy;
    expect(ok).toEqual({ urgent: 8, high: 8, normal: 8, low: 8 });
  });
});

describe("B: regelen er koblet til faktiske support-data (ikke lenger et spøkelse)", () => {
  it("ubesvart kundemelding eldre enn vinduet gir en forfalt-loop UTEN noen eksplisitt frist - med utledet frist, SLA-begrunnelse og 'critical'-bøtte", async () => {
    const id = await ticket({ priority: "normal", messageHoursAgo: 30, subject: "Betaling feiler" });
    const r = await sweep(loops);
    expect(r.detected).toBeGreaterThanOrEqual(1);
    const loop = await overdueLoop(T, id);
    expect(loop).toBeDefined();
    expect(loop).toMatchObject({ priority: "high", status: "open", ticket_id: id });
    expect(loop?.reason).toBe('Ticket "Betaling feiler" har ikke fått svar innen svarfristen (24 t for normal prioritet)');
    // frist = siste kundemelding + 24 t (≈ 6 t siden), ikke null
    expect(loop?.due_at).not.toBeNull();
    const dueMs = new Date(loop?.due_at as string).getTime();
    expect(Math.abs(dueMs - (Date.now() - 30 * HOUR + 24 * HOUR))).toBeLessThan(60_000);
    expect(classifyAttentionBucket(loop!.priority, loop!.due_at, Date.now())).toBe("critical");
  });

  it("vinduet følger prioriteten: urgent 4 t, high 8 t, normal 24 t, low 72 t - innenfor vinduet gir ingen loop", async () => {
    const cases: Array<["urgent" | "high" | "normal" | "low", number, boolean]> = [
      ["urgent", 5, true], ["urgent", 3, false], ["high", 9, true], ["high", 7, false], ["normal", 25, true], ["normal", 23, false], ["low", 73, true], ["low", 71, false]
    ];
    for (const [priority, hours, expected] of cases) {
      const id = await ticket({ priority, messageHoursAgo: hours });
      await sweep(loops);
      expect(Boolean(await overdueLoop(T, id)), `${priority}/${hours} t`).toBe(expected);
    }
  });

  it("et svar etter kundemeldingen stopper klokken; et internt notat gjør det IKKE; waiting_customer og terminal status har ingen SLA", async () => {
    const answered = await ticket({ messageHoursAgo: 40, replyHoursAfterMessage: 2 });
    const noteOnly = await ticket({ messageHoursAgo: 40, noteHoursAfterMessage: 1 });
    const waiting = await ticket({ messageHoursAgo: 40, status: "waiting_customer" });
    const resolved = await ticket({ messageHoursAgo: 40, status: "resolved" });
    const closed = await ticket({ messageHoursAgo: 40, status: "closed" });
    const lateReply = await ticket({ messageHoursAgo: 40, replyHoursAfterMessage: 30 }); // svar etter 30 t - kom for sent, men er et svar: klokken stopper nå
    await sweep(loops);
    expect(await overdueLoop(T, answered)).toBeUndefined();
    expect(await overdueLoop(T, noteOnly)).toBeDefined();
    expect(await overdueLoop(T, waiting)).toBeUndefined();
    expect(await overdueLoop(T, resolved)).toBeUndefined();
    expect(await overdueLoop(T, closed)).toBeUndefined();
    expect(await overdueLoop(T, lateReply)).toBeUndefined();
  });

  it("en ny kundemelding ETTER et svar starter klokken på nytt fra den nye meldingen", async () => {
    const id = await ticket({ messageHoursAgo: 60, replyHoursAfterMessage: 1 });
    await admin.query(`INSERT INTO support_ticket_events (event_id, tenant_id, ticket_id, event_type, summary, occurred_at) VALUES ($1, $2, $3, 'customer_message', 'x', $4)`, [`evt-${id}-new`, T, id, ago(2)]);
    await sweep(loops);
    expect(await overdueLoop(T, id)).toBeUndefined(); // 2 t siden ny melding, normal = 24 t
    await admin.query("UPDATE support_ticket_events SET occurred_at = $2 WHERE event_id = $1", [`evt-${id}-new`, ago(26)]);
    await sweep(loops);
    expect((await overdueLoop(T, id))?.status).toBe("open");
  });

  it("manuell ticket uten kundemelding har ingen utledet frist; eksplisitt frist gjelder fortsatt (uendret oppførsel og begrunnelse)", async () => {
    const manual = await ticket({ messageHoursAgo: null });
    const explicit = await ticket({ messageHoursAgo: null, nextResponseDueHoursAgo: 3, subject: "Eksplisitt frist" });
    await sweep(loops);
    expect(await overdueLoop(T, manual)).toBeUndefined();
    const loop = await overdueLoop(T, explicit);
    expect(loop?.reason).toBe('Ticket "Eksplisitt frist" er forfalt');
    expect(loop?.due_at).not.toBeNull();
  });

  it("eksplisitt frist og utledet frist kombineres: den TIDLIGSTE gjelder", async () => {
    const id = await ticket({ priority: "normal", messageHoursAgo: 30, nextResponseDueHoursAgo: 20 }); // utledet: 6 t siden, eksplisitt: 20 t siden
    await sweep(loops);
    const loop = await overdueLoop(T, id);
    expect(loop).toBeDefined();
    expect(Math.abs(new Date(loop?.due_at as string).getTime() - (Date.now() - 20 * HOUR))).toBeLessThan(60_000);
  });

  it("når svaret kommer, lukkes loopen automatisk neste sveip (vilkåret er ikke lenger sant)", async () => {
    const id = await ticket({ priority: "high", messageHoursAgo: 12 });
    await sweep(loops);
    expect((await overdueLoop(T, id))?.status).toBe("open");
    await admin.query(`INSERT INTO support_ticket_events (event_id, tenant_id, ticket_id, event_type, summary, occurred_at) VALUES ($1, $2, $3, 'agent_reply', 'x', now())`, [`evt-${id}-reply`, T, id]);
    const r = await sweep(loops);
    expect(r.auto_resolved).toBeGreaterThanOrEqual(1);
    expect(await overdueLoop(T, id)).toMatchObject({ status: "resolved", resolution_reason: "condition_no_longer_true" });
  });
});

describe("C: konfigurasjon og isolasjon", () => {
  it("policy «off» (null) slår av utledningen, men eksplisitte frister virker fortsatt", async () => {
    const derivedOnly = await ticket({ priority: "normal", messageHoursAgo: 100 });
    const explicit = await ticket({ messageHoursAgo: null, nextResponseDueHoursAgo: 1 });
    await sweep(loopsOff);
    // loopen til derivedOnly finnes fra tidligere sveip i denne filen med standardpolicy ... men er IKKE opprettet av loopsOff: sjekk at off ikke lager nye
    const before = await overdueLoop(T, derivedOnly);
    expect(before === undefined || before.status === "resolved").toBe(true);
    expect((await overdueLoop(T, explicit))?.status).toBe("open");
  });

  it("egen policy overstyrer standardene (normal = 48 t, urgent = 1 t)", async () => {
    const normal30 = await ticket({ priority: "normal", messageHoursAgo: 30 });
    const urgent2 = await ticket({ priority: "urgent", messageHoursAgo: 2 });
    await sweep(loopsCustom);
    expect((await overdueLoop(T, normal30))?.status ?? "none").not.toBe("open");
    expect((await overdueLoop(T, urgent2))?.status).toBe("open");
    expect((await overdueLoop(T, urgent2))?.reason).toContain("(1 t for urgent prioritet)");
  });

  it("en annen tenants tickets påvirker ikke denne, og loopen bor kun i sin egen tenant", async () => {
    const other = await ticket({ tenant: T_B, priority: "urgent", messageHoursAgo: 50 });
    await sweep(loops, T);
    expect(await overdueLoop(T, other)).toBeUndefined();
    await sweep(loops, T_B);
    expect((await overdueLoop(T_B, other))?.status).toBe("open");
    expect(await overdueLoop(T, other)).toBeUndefined();
  });

  it("hele runSweep kjører regelen (ingen separat kø) og er idempotent", async () => {
    const id = await ticket({ priority: "high", messageHoursAgo: 20 });
    await loops.runSweep(T, SP);
    const first = await overdueLoop(T, id);
    await loops.runSweep(T, SP);
    const all = (await loops.listOpenLoops(T, SP, "all")).filter((l) => l.loop_type === "support_ticket_overdue" && l.ticket_id === id);
    expect(all).toHaveLength(1);
    expect(all[0]?.open_loop_id).toBe(first?.open_loop_id);
  });
});
