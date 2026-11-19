import { randomUUID } from "node:crypto";
import type pg from "pg";
import { writeAudit } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { resolveRuleThreshold, ruleByKey, RULES, type RuleDefinition } from "./signal-types.ts";
import type { RuleThresholdSource } from "./signal-bus.ts";

/**
 * WP-G4 (D-466), UA-10 P2d: TILBAKEMELDINGSLÆRING - eierens «nyttig»/«støy» justerer terskelen til ÉN regel innenfor HARDE grenser. Det er hele «læringen»:
 *
 *  - Det som endres er ETT TALL per (tenant, space, regel) i `situation_rule_tuning`. Ingen regel, ingen kode, ingen prompt og ingen modellvekt endres (selvmodifikasjon er FROSSET, D-397): reglene, grensene og stegene ligger i `RULES`
 *    (kode) og kan ikke flyttes av data. Verdien klemmes ALLTID mot kodens [min, max] ved bruk (`resolveRuleThreshold`), uansett hva en rad måtte inneholde.
 *  - Kun SIKKERHETEN slakkes aldri: regler uten `tunable` (lekkasje, utløst alarm, sikkerhetsvarsel, hendelser) flyttes ikke av tilbakemelding. «Støy» gjør en tunbar regel mindre følsom ett steg (flere minutter, høyere z, lengre
 *    sammenslåingsvindu) - aldri mer følsom enn standarden: «nyttig» flytter den bare tilbake mot standarden.
 *  - Konservativt: minst tre siste, ubrukte stemmer i 30 dager må være ENIGE, og høyst én endring per døgn per regel (dempe svingninger). Stemmene som utløste et steg (eller ble nullstilt av en tilbakestilling) er «brukt» og teller aldri igjen:
 *    hvert steg krever tre NYE, enige stemmer. Hver endring revideres i `audit_events` (`situation.rule_tuned`, kun regel/fra/til/utløser) i SAMME transaksjon som endringen.
 *  - Eieren kan alltid tilbakestille en regel til standard (`resetTuning`, revidert) og slå hele funksjonen av (`JARVIS_SITUATION_FEEDBACK` AV: terskelkilden er da tom og alle regler bruker standard).
 *  - Autoritet: kun den sovereign eieren (samme `recoveryAuthority` som autonomi-bindinger), fail-closed uten konfigurert autoritet.
 */
export const FEEDBACK_VERDICTS = ["useful", "noise"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export const TUNING_MIN_VOTES = 3;
export const TUNING_WINDOW_DAYS = 30;
export const TUNING_COOLDOWN_HOURS = 24;
const DAY_MS = 86_400_000;

export interface FeedbackVote {
  verdict: FeedbackVerdict;
  /** ISO-tid (eller Date fra databasen). */
  created_at: string | Date;
}

export type TuningDecision =
  | { action: "none"; reason: "not_tunable" | "cooldown" | "too_few_votes" | "mixed_votes" | "at_hard_limit" | "at_default" }
  | { action: "relax" | "tighten"; from: number; to: number; reason: "three_noise_votes" | "three_useful_votes" };

/** Avrunder til steg-oppløsningen (unngår flyttallsstøy som 2.2500000000000004). */
const roundTo = (value: number, step: number): number => Math.round((Math.round(value / step) * step) * 1_000_000) / 1_000_000;

/**
 * REN beslutning: skal terskelen flyttes nå? Ingen I/O, ingen klokke (`nowMs` injiseres). `stored` er den lagrede verdien (eller `null`); `lastChangedMs` når regelen sist ble justert (eller `null`).
 * De siste tre stemmene (nyeste først) i vinduet må være ENIGE. «Støy» slakker ett steg (aldri forbi `max`); «nyttig» strammer ett steg tilbake mot standarden (aldri under standarden).
 */
export function decideTuning(rule: RuleDefinition, stored: number | null, votes: readonly FeedbackVote[], nowMs: number, lastChangedMs: number | null): TuningDecision {
  const t = rule.tunable;
  if (t === null) return { action: "none", reason: "not_tunable" };
  if (lastChangedMs !== null && nowMs - lastChangedMs < TUNING_COOLDOWN_HOURS * 3_600_000) return { action: "none", reason: "cooldown" };
  const recent = votes
    .map((v) => ({ verdict: v.verdict, at: v.created_at instanceof Date ? v.created_at.getTime() : Date.parse(v.created_at) }))
    .filter((v) => Number.isFinite(v.at) && nowMs - v.at <= TUNING_WINDOW_DAYS * DAY_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, TUNING_MIN_VOTES);
  if (recent.length < TUNING_MIN_VOTES) return { action: "none", reason: "too_few_votes" };
  const effective = resolveRuleThreshold(rule, stored) as number;
  if (recent.every((v) => v.verdict === "noise")) {
    // Avrundingen kan aldri føre forbi grensen: den harde øvre grensen anvendes ETTER avrunding (også når grensen ikke ligger på stegrutenettet).
    const to = Math.min(t.max, roundTo(effective + t.step, t.step));
    return to > effective ? { action: "relax", from: effective, to, reason: "three_noise_votes" } : { action: "none", reason: "at_hard_limit" };
  }
  if (recent.every((v) => v.verdict === "useful")) {
    // …og standarden er gulvet for «nyttig»-steg, også etter avrunding.
    const to = Math.max(t.default, roundTo(effective - t.step, t.step));
    return to < effective ? { action: "tighten", from: effective, to, reason: "three_useful_votes" } : { action: "none", reason: "at_default" };
  }
  return { action: "none", reason: "mixed_votes" };
}

export class FeedbackUnauthorizedError extends Error {
  constructor(public readonly personId: string | undefined) {
    super(`feedback_unauthorized:${personId ?? "none"}`);
    this.name = "FeedbackUnauthorizedError";
  }
}

export class FeedbackValidationError extends Error {
  constructor(public readonly code: string) {
    super(`feedback_invalid:${code}`);
    this.name = "FeedbackValidationError";
  }
}

export interface FeedbackActor {
  person_id: string | undefined;
  task_id?: string | undefined;
  session_id?: string | undefined;
}

export interface RuleTuningRow {
  rule_key: string;
  tunable: boolean;
  unit: string | null;
  name: string | null;
  default_value: number | null;
  min: number | null;
  max: number | null;
  /** Gjeldende EFFEKTIVE terskel (klemt), eller `null` for en ikke-tunbar regel. */
  effective: number | null;
  tuned: boolean;
  last_changed_at: string | null;
  reason: string | null;
}

export interface SubmitFeedbackResult {
  feedback_id: string;
  rule_key: string;
  tuning: TuningDecision;
}

export class FeedbackService implements RuleThresholdSource {
  constructor(
    private readonly pool: pg.Pool,
    /** Sovereign eier (samme form som `SituationRecoveryAuthority`). `undefined` = alle mutasjoner nektes (fail-closed). */
    private readonly authority?: { owner_person_id: string },
    /** Er læringen på (`JARVIS_SITUATION_FEEDBACK`)? Av = tilbakemeldingen REGISTRERES, men terskler flyttes aldri. */
    private readonly tuningEnabled: boolean = true,
    private readonly now: () => number = Date.now
  ) {}

  private assertOwner(actor: FeedbackActor): string {
    if (!actor.person_id || !this.authority || actor.person_id !== this.authority.owner_person_id) throw new FeedbackUnauthorizedError(actor.person_id);
    return actor.person_id;
  }

  /** Terskelkilden bussen leser (tunede verdier per regel). Tom når læringen er AV (alle regler bruker da standard). */
  async thresholds(tenantId: string, memorySpace: MemorySpace): Promise<ReadonlyMap<string, number>> {
    if (!this.tuningEnabled) return new Map();
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT rule_key, threshold FROM situation_rule_tuning WHERE tenant_id = $1 AND memory_space_id = $2`, [tenantId, memorySpace]);
      const out = new Map<string, number>();
      for (const row of rows as Array<{ rule_key: string; threshold: string | number }>) {
        const n = Number(row.threshold);
        if (Number.isFinite(n)) out.set(row.rule_key, n);
      }
      return out;
    });
  }

  /** Alle regler med gjeldende (effektive) terskel, standard og harde grenser - det eieren ser og kan tilbakestille. */
  async listTuning(tenantId: string, memorySpace: MemorySpace): Promise<RuleTuningRow[]> {
    const stored = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT rule_key, threshold, reason, updated_at FROM situation_rule_tuning WHERE tenant_id = $1 AND memory_space_id = $2`,
        [tenantId, memorySpace]
      );
      return new Map((rows as Array<{ rule_key: string; threshold: string | number; reason: string; updated_at: string | Date }>).map((r) => [r.rule_key, r]));
    });
    return RULES.map((rule) => {
      const row = stored.get(rule.rule_key);
      const t = rule.tunable;
      return {
        rule_key: rule.rule_key, tunable: t !== null, unit: t?.unit ?? null, name: t?.name ?? null, default_value: t?.default ?? null, min: t?.min ?? null, max: t?.max ?? null,
        effective: this.tuningEnabled ? resolveRuleThreshold(rule, row === undefined ? null : Number(row.threshold)) : resolveRuleThreshold(rule, null),
        tuned: this.tuningEnabled && row !== undefined, last_changed_at: row === undefined ? null : new Date(row.updated_at).toISOString(), reason: row?.reason ?? null
      };
    });
  }

  /**
   * Registrerer eierens vurdering av ÉN situasjon («nyttig»/«støy») og - når læringen er på - lar den påvirke regelens terskel via `decideTuning()`. Regelnøkkelen utledes fra signalloggen for situasjonen
   * (kilde + hendelsestype); en situasjon uten loggført signal (f.eks. fra det daglige open-loop-sveipet) får `<domene>:untracked` (registreres, men tuner ingenting).
   */
  async submit(tenantId: string, memorySpace: MemorySpace, situationId: string, verdict: string, actor: FeedbackActor): Promise<SubmitFeedbackResult> {
    const personId = this.assertOwner(actor);
    if (!(FEEDBACK_VERDICTS as readonly string[]).includes(verdict)) throw new FeedbackValidationError("verdict_unknown");
    const nowMs = this.now();
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: sitRows } = await client.query(`SELECT domain FROM situations WHERE tenant_id = $1 AND memory_space_id = $2 AND situation_id = $3`, [tenantId, memorySpace, situationId]);
      const sit = sitRows[0] as { domain: string } | undefined;
      if (sit === undefined) throw new FeedbackValidationError("situation_not_found");
      const { rows: logRows } = await client.query(
        `SELECT source, event_type FROM situation_signal_log WHERE tenant_id = $1 AND memory_space_id = $2 AND situation_id = $3 ORDER BY occurred_at DESC, recorded_at DESC LIMIT 1`,
        [tenantId, memorySpace, situationId]
      );
      const log = logRows[0] as { source: string; event_type: string } | undefined;
      const ruleKey = log === undefined ? `${sit.domain.replace(/[^a-z_]/g, "_").slice(0, 30).padEnd(3, "_")}:untracked` : `${log.source}:${log.event_type}`;
      const feedbackId = `fb-${randomUUID()}`;
      // `created_at` følger den injiserte klokken (i drift = nå), slik at stemmenes tid og regelens siste endring er sammenlignbare.
      await client.query(
        `INSERT INTO situation_feedback (feedback_id, tenant_id, memory_space_id, situation_id, rule_key, verdict, actor_person_id, task_id, session_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10::double precision / 1000.0))`,
        [feedbackId, tenantId, memorySpace, situationId, ruleKey, verdict, personId, actor.task_id ?? null, actor.session_id ?? null, nowMs]
      );
      const rule = ruleByKey(ruleKey);
      if (!this.tuningEnabled || rule === undefined) return { feedback_id: feedbackId, rule_key: ruleKey, tuning: { action: "none", reason: "not_tunable" } as TuningDecision };

      // A-LOW-10 (fiks-runde): `FOR UPDATE` under låser kun en rad som FINNES - ved første tuning av en regel finnes ingen, så samtidige kall leste de samme tre stemmene og skrev hvert sitt steg og sin egen
      // `situation.rule_tuned`-rad (30 samtidige ga 10 duplikater). En transaksjons-advisory-lås per (tenant, rom, regel) tas FØR stemmene leses: neste kall venter, ser stemmene som brukt og gjør ingenting.
      await this.lockRule(client, tenantId, memorySpace, ruleKey);
      // Regelens gjeldende tuning og de siste stemmene (siste 3 holder; vi henter litt flere for vinduet). Raden låses for å hindre to samtidige endringer.
      const { rows: tuneRows } = await client.query(
        `SELECT threshold, updated_at FROM situation_rule_tuning WHERE tenant_id = $1 AND memory_space_id = $2 AND rule_key = $3 FOR UPDATE`,
        [tenantId, memorySpace, ruleKey]
      );
      const cur = tuneRows[0] as { threshold: string | number; updated_at: string | Date } | undefined;
      // Kun BRUKTE-frie stemmer teller: en stemme som alt har utløst et steg (eller blitt nullstilt av en tilbakestilling) teller aldri igjen.
      const { rows: voteRows } = await client.query(
        `SELECT verdict, created_at FROM situation_feedback WHERE tenant_id = $1 AND memory_space_id = $2 AND rule_key = $3 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 10`,
        [tenantId, memorySpace, ruleKey]
      );
      const votes = (voteRows as Array<{ verdict: FeedbackVerdict; created_at: string | Date }>).map((v) => ({ verdict: v.verdict, created_at: v.created_at }));
      const decision = decideTuning(rule, cur === undefined ? null : Number(cur.threshold), votes, nowMs, cur === undefined ? null : new Date(cur.updated_at).getTime());
      if (decision.action !== "none") {
        await this.consumeVotes(client, tenantId, memorySpace, ruleKey, nowMs);
        const reason = decision.reason === "three_noise_votes" ? "tre siste tilbakemeldinger: støy" : "tre siste tilbakemeldinger: nyttig";
        await client.query(
          `INSERT INTO situation_rule_tuning (tenant_id, memory_space_id, rule_key, threshold, reason, updated_by_person_id, task_id, session_id, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $8, $9, to_timestamp($7::double precision / 1000.0))
           ON CONFLICT (tenant_id, memory_space_id, rule_key) DO UPDATE SET threshold = EXCLUDED.threshold, reason = EXCLUDED.reason, updated_by_person_id = EXCLUDED.updated_by_person_id,
             task_id = EXCLUDED.task_id, session_id = EXCLUDED.session_id, updated_at = EXCLUDED.updated_at`,
          [tenantId, memorySpace, ruleKey, decision.to, reason, personId, nowMs, actor.task_id ?? null, actor.session_id ?? null]
        );
        await writeAudit(client, { tenant_id: tenantId, person_id: personId, ...(actor.session_id !== undefined ? { session_id: actor.session_id } : {}) }, {
          type: "situation.rule_tuned", decision: decision.action, reason: decision.reason, tool_id: "situations", action: "record_feedback", capability_class: "B",
          payload: { rule_key: ruleKey, from: decision.from, to: decision.to, memory_space: memorySpace }, ...(actor.task_id !== undefined ? { task_id: actor.task_id } : {})
        });
      }
      return { feedback_id: feedbackId, rule_key: ruleKey, tuning: decision };
    });
  }

  /**
   * Transaksjons-advisory-lås per (tenant, rom, regel): serialiserer `submit` og `resetTuning` for SAMME regel (andre regler og andre tenants påvirkes ikke). Egen 64-bit nøkkel med eget frø (7340466 = D-466), så den
   * aldri kolliderer med domenelåsene (`hashtext(domene)`, session-nivå) i `advisory-lock.ts`. Frigjøres automatisk ved commit/rollback.
   */
  private async lockRule(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, ruleKey: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7340466))", [`situation-tuning|${tenantId}|${memorySpace}|${ruleKey}`]);
  }

  /** Markerer alle ubrukte stemmer for regelen som brukt (kun kolonnen `consumed_at` kan endres; selve stemmen består som historikk). */
  private async consumeVotes(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, ruleKey: string, nowMs: number): Promise<void> {
    await client.query(
      `UPDATE situation_feedback SET consumed_at = to_timestamp($4::double precision / 1000.0)
       WHERE tenant_id = $1 AND memory_space_id = $2 AND rule_key = $3 AND consumed_at IS NULL`,
      [tenantId, memorySpace, ruleKey, nowMs]
    );
  }

  /**
   * Tilbakestiller ÉN regel til standard (revidert) og nullstiller de ventende stemmene (en tilbakestilling kan ikke omgås av gamle stemmer som utløser en ny endring ved neste tilbakemelding).
   * Returnerer om en tuning-rad ble fjernet.
   */
  async resetTuning(tenantId: string, memorySpace: MemorySpace, ruleKey: string, actor: FeedbackActor): Promise<boolean> {
    const personId = this.assertOwner(actor);
    if (ruleByKey(ruleKey) === undefined) throw new FeedbackValidationError("rule_unknown");
    const nowMs = this.now();
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      await this.lockRule(client, tenantId, memorySpace, ruleKey); // samme lås som `submit`: en tilbakestilling og en stemme for samme regel kan ikke flettes
      const { rows } = await client.query(
        `DELETE FROM situation_rule_tuning WHERE tenant_id = $1 AND memory_space_id = $2 AND rule_key = $3 RETURNING threshold`,
        [tenantId, memorySpace, ruleKey]
      );
      await this.consumeVotes(client, tenantId, memorySpace, ruleKey, nowMs);
      const removed = rows[0] as { threshold: string | number } | undefined;
      if (removed !== undefined) {
        await writeAudit(client, { tenant_id: tenantId, person_id: personId, ...(actor.session_id !== undefined ? { session_id: actor.session_id } : {}) }, {
          type: "situation.rule_tuning_reset", decision: "reset", tool_id: "situations", action: "reset_rule_tuning", capability_class: "C",
          payload: { rule_key: ruleKey, from: Number(removed.threshold), memory_space: memorySpace }, ...(actor.task_id !== undefined ? { task_id: actor.task_id } : {})
        });
      }
      return removed !== undefined;
    });
  }
}
