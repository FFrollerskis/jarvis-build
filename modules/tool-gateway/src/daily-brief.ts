import { readFile } from "node:fs/promises";
import type pg from "pg";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import type { ToolGateway } from "./gateway.ts";
import { configuredGithubRepo } from "./github-repo-lock.ts";

/**
 * Daily Executive Brief (v4.0 første Daily Value Loop).
 * Arkitektur: connectors (via Tool Gateway) → normaliserte BriefItems m/
 * provenance → deterministisk prioritering → artifact. Nye kilder kobles til
 * ved å legge til én BriefSource - brief-motoren skrives ikke om.
 * LLM finner ALDRI opp hendelser: alle punkter er source-backed; dedupe på
 * (source, ref); feil i én kilde degraderer pent uten å velte briefen.
 */
export interface BriefItem {
  source: string;
  ref: string;
  title: string;
  detail?: string;
  at?: string;
  /** Deterministisk prioritet 0-100 (høyere = viktigere). */
  score: number;
  why: string;
  action?: string;
}

export interface BriefSource {
  name: string;
  collect(identity: IdentityContext): Promise<BriefItem[]>;
}

export interface BriefArtifact {
  generated_at: string;
  tenant_id: string;
  top_priorities: BriefItem[];
  today: BriefItem[];
  needs_attention: BriefItem[];
  follow_ups: BriefItem[];
  build_status: BriefItem[];
  fyi: BriefItem[];
  source_errors: Array<{ source: string; error: string }>;
}

/** Jarvis-oppgaver: overdue/due/åpne/blocked - direkte fra tasks under RLS. */
export function tasksSource(pool: pg.Pool): BriefSource {
  return {
    name: "jarvis-tasks",
    async collect(identity) {
      const rows = await withTenantTransaction(pool, identity.tenant_id, (c) =>
        c.query(`SELECT task_id, goal, status, last_error, created_at,
                        (contract->>'deadline') AS deadline
                 FROM tasks WHERE status IN ('created','running','failed') ORDER BY created_at DESC LIMIT 50`)
      );
      return (rows.rows as Array<{ task_id: string; goal: string; status: string; last_error: string | null; deadline: string | null; created_at: Date }>).map((t) => {
        const overdue = t.deadline !== null && new Date(t.deadline).getTime() < Date.now();
        return {
          source: "jarvis-tasks", ref: t.task_id,
          title: `${t.status === "failed" ? "FEILET" : overdue ? "OVERDUE" : t.status}: ${t.goal}`,
          ...(t.last_error ? { detail: t.last_error } : {}),
          at: String(t.created_at),
          score: t.status === "failed" ? 85 : overdue ? 90 : t.status === "running" ? 40 : 55,
          why: t.status === "failed" ? "jobb feilet og trenger oppfølging" : overdue ? "fristen er passert" : "åpen jobb",
          action: t.status === "failed" ? `undersøk jobbstatus ${t.task_id}` : `jobbstatus ${t.task_id}`
        };
      });
    }
  };
}

/** E-post via Tool Gateway (email.read_inbox); untrusted → kun som DATA, aldri instruksjoner. */
export function emailSource(gateway: ToolGateway): BriefSource {
  return {
    name: "gmail",
    async collect(identity) {
      const result = await gateway.execute({
        identity, tool_id: "email", action: "read_inbox", parameters: { max: 25 }
      });
      if (!result.ok) throw new Error(result.reason);
      const messages = ((result.data as { messages?: JsonValue[] } | undefined)?.messages ?? []) as Array<Record<string, string>>;
      return messages.map((m) => ({
        source: "gmail", ref: m["id"] ?? m["subject"] ?? "ukjent",
        title: `${m["unanswered"] === "true" ? "UBESVART: " : ""}${m["from"]}: ${m["subject"]}`,
        at: m["at"] ?? new Date().toISOString(),
        score: m["important"] === "true" ? 80 : m["unanswered"] === "true" ? 65 : 30,
        why: m["important"] === "true" ? "markert viktig" : m["unanswered"] === "true" ? "venter på svar fra deg" : "ny e-post",
        action: `svar ${m["from"]}`
      }));
    }
  };
}

/** Kalender via Tool Gateway (calendar.read_events). */
export function calendarSource(gateway: ToolGateway): BriefSource {
  return {
    name: "calendar",
    async collect(identity) {
      const now = new Date();
      const result = await gateway.execute({
        identity, tool_id: "calendar", action: "read_events",
        parameters: { from: now.toISOString(), to: new Date(now.getTime() + 86_400_000).toISOString() }
      });
      if (!result.ok) throw new Error(result.reason);
      const events = ((result.data as { events?: JsonValue[] } | undefined)?.events ?? []) as Array<Record<string, string>>;
      return events.map((e) => ({
        source: "calendar", ref: e["id"] ?? e["title"] ?? "ukjent",
        title: `${e["start"]}: ${e["title"]}`,
        at: e["start"] ?? now.toISOString(),
        score: e["needs_prep"] === "true" ? 75 : 60,
        why: e["needs_prep"] === "true" ? "møtet krever forberedelse" : "dagens møte",
        ...(e["needs_prep"] === "true" ? { action: `forbered: ${e["title"]}` } : {})
      }));
    }
  };
}

/** Jarvis build-/runtime-status: PROJECT_STATUS + runtime gates + ev. GitHub issues via gateway. */
export function buildStatusSource(gateway: ToolGateway | null, statusFile = "docs/PROJECT_STATUS.md"): BriefSource {
  return {
    name: "jarvis-build",
    async collect(identity) {
      const items: BriefItem[] = [];
      const status = await readFile(statusFile, "utf8").catch(() => "");
      const gates = [...status.matchAll(/\| \*\*(D-\d+)\*\* \| ([^|]+)\|/g)].map((m) => `${m[1]}: ${(m[2] ?? "").trim().slice(0, 60)}`);
      if (status === "") {
        // D-396 (JARVIS-057): `docs/` ligger i .dockerignore og er ikke i runtime-imaget - «0 åpne runtime-porter» var en løgn (ukjent ≠ ingen).
        items.push({
          source: "jarvis-build", ref: "runtime-gates",
          title: "Byggestatus utilgjengelig", detail: `${statusFile} finnes ikke i dette miljøet (docs er ikke i runtime-imaget) - antall åpne runtime-porter er UKJENT`,
          at: new Date().toISOString(), score: 20,
          why: "statuskilden kan ikke leses her", action: "les docs/PROJECT_STATUS.md i repoet"
        });
      } else {
        items.push({
          source: "jarvis-build", ref: "runtime-gates",
          title: `${gates.length} åpne runtime-porter`, detail: gates.join(" · "),
          at: new Date().toISOString(), score: 45,
          why: "porter må lukkes før produksjonsstatus", action: "kjør runtime-verifikasjon (Docker/credentials-dagen)"
        });
      }
      if (gateway) {
        const repo = configuredGithubRepo();
        const issues = await gateway.execute({
          identity, tool_id: "github", action: "read_issues", parameters: { repo }
        });
        if (!issues.ok) {
          // «Ukjent ≠ ingen» (som D-396 for statusfilen): en GitHub-lesing som feiler (credential mangler, repoet er ikke tilgjengelig, Issues er AV i repoet -> GitHub svarer 410) skal ikke se ut som «ingen åpne issues».
          items.push({
            source: "github", ref: "issues-unavailable",
            title: "GitHub-issues utilgjengelige", detail: `Kunne ikke lese issues i ${repo} (${issues.reason}) - antall åpne issues er UKJENT`,
            at: new Date().toISOString(), score: 20,
            why: "statuskilden kan ikke leses her", action: "sjekk GitHub-connectoren og at Issues er slått på i repoet"
          });
        }
        if (issues.ok) {
          const list = ((issues.data as { issues?: JsonValue[] } | undefined)?.issues ?? []) as Array<Record<string, string>>;
          for (const issue of list) {
            items.push({
              source: "github", ref: issue["id"] ?? issue["title"] ?? "ukjent",
              title: `Issue: ${issue["title"]}`, at: issue["at"] ?? new Date().toISOString(),
              score: issue["ci_failing"] === "true" ? 82 : 50,
              why: issue["ci_failing"] === "true" ? "CI feiler" : "åpent issue",
              action: "vurder i neste byggeøkt"
            });
          }
        }
      }
      return items;
    }
  };
}

/**
 * D-198 (V4-revisjon): DEN ene chunket-idempotent-Telegram-leveringsmekanismen
 * - eksplisitt EKSTRAHERT fra `DailyBrief.deliverViaTelegram()` slik at enhver
 * FREMTIDIG scheduler-drevet levering (V4 sin ukentlige business-brief er den
 * FØRSTE) bruker NØYAKTIG samme kode, aldri en kopiert-og-driftet variant.
 * Samme leksjon som D-196 fastslo (to identiske mekanismer som stille
 * divergerer er en reell feilklasse) - her strukturelt umulig fra starten av,
 * siden det kun finnes ÉN implementasjon å kalle. `idempotencyPrefix` MÅ være
 * unik per leveranse-KILDE (aldri gjenbrukt på tvers av to ulike
 * brief-typer/tenants) - selve chunk-indeksen legges til her, ALDRI av kalleren.
 */
export async function deliverChunkedTextViaTelegram(
  gateway: ToolGateway,
  identity: IdentityContext,
  text: string,
  idempotencyPrefix: string
): Promise<boolean> {
  return (await deliverChunkedTextViaTelegramDetailed(gateway, identity, text, idempotencyPrefix)).ok;
}

/**
 * D-442: samme levering, men med antall sendte deler. En flerdelt tekst kan feile på del 2+ etter at del 1 er sendt; en kaller som vil prøve på nytt må vite at
 * noe allerede er levert (et nytt forsøk får en ny `generated_at` = nye nøkler, så del 1 ville kommet to ganger).
 */
export interface ChunkedDeliveryResult {
  ok: boolean;
  /** Antall deler som faktisk ble sendt før eventuell feil. */
  chunks_sent: number;
}

export async function deliverChunkedTextViaTelegramDetailed(
  gateway: ToolGateway,
  identity: IdentityContext,
  text: string,
  idempotencyPrefix: string
): Promise<ChunkedDeliveryResult> {
  let chunksSent = 0;
  for (let i = 0; i < text.length; i += 3900) {
    const result = await gateway.execute({
      identity, tool_id: "telegram", action: "notify",
      parameters: { message: text.slice(i, i + 3900) },
      idempotency_key: `${idempotencyPrefix}-${i}`
    });
    if (!result.ok) return { ok: false, chunks_sent: chunksSent };
    chunksSent += 1;
  }
  return { ok: true, chunks_sent: chunksSent };
}

export class DailyBrief {
  constructor(
    private readonly sources: BriefSource[],
    /** Med pool aktiveres persistent seen/stale-suppression + run-rate-rad per brief. */
    private readonly pool?: pg.Pool
  ) {}

  async generate(identity: IdentityContext): Promise<BriefArtifact> {
    const started = performance.now();
    const items: BriefItem[] = [];
    const errors: Array<{ source: string; error: string }> = [];
    for (const source of this.sources) {
      try {
        items.push(...(await source.collect(identity)));
      } catch (err) {
        // Én manglende connector velter aldri briefen - degrader pent.
        errors.push({ source: source.name, error: (err as Error).message.slice(0, 80) });
      }
    }
    // Dedupe på (source, ref) - samme hendelse presenteres aldri dobbelt.
    const seen = new Set<string>();
    let unique = items.filter((i) => {
      const key = `${i.source}:${i.ref}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));

    // Persistent stale-suppression: lavverdipunkter (score<60) som allerede er
    // presentert en tidligere dag, gjentas ikke som nye. Høyverdi/overdue består.
    if (this.pool) {
      unique = await withTenantTransaction(this.pool, identity.tenant_id, async (client) => {
        const kept: BriefItem[] = [];
        for (const item of unique) {
          const key = `${item.source}:${item.ref}`;
          const prior = await client.query(
            `INSERT INTO brief_seen (tenant_id, item_key) VALUES ($1, $2)
             ON CONFLICT (tenant_id, item_key) DO UPDATE SET last_seen = now()
             RETURNING dismissed, (last_presented IS NOT NULL AND last_presented < date_trunc('day', now())) AS stale`,
            [identity.tenant_id, key]
          );
          const row = prior.rows[0] as { dismissed: boolean; stale: boolean };
          if (row.dismissed || (row.stale && item.score < 60)) continue;
          kept.push(item);
        }
        await client.query(
          `UPDATE brief_seen SET last_presented = now() WHERE tenant_id = $1 AND item_key = ANY($2)`,
          [identity.tenant_id, kept.map((i) => `${i.source}:${i.ref}`)]
        );
        // Run-rate: én rad per generert brief → cost_per_daily_brief kan beregnes reelt.
        await client.query(
          `INSERT INTO cost_events (tenant_id, session_id, kind, amount_ore, provider, model)
           VALUES ($1, $2, 'brief:generation', 0, 'jarvis', 'daily-brief')`,
          [identity.tenant_id, identity.session_id]
        );
        return kept;
      });
    }
    void started;

    return {
      generated_at: new Date().toISOString(),
      tenant_id: identity.tenant_id,
      top_priorities: unique.slice(0, 3),
      today: unique.filter((i) => i.source === "calendar" || i.title.startsWith("OVERDUE")),
      needs_attention: unique.filter((i) => i.score >= 70).concat(
        errors.map((e) => ({
          source: "jarvis-build", ref: `connector:${e.source}`, title: `Connector utilgjengelig: ${e.source}`,
          detail: e.error, score: 70, why: "datakilde nede/uten credentials", action: "sjekk credentials/runtime"
        }))
      ),
      follow_ups: unique.filter((i) => i.why.includes("venter på svar") || i.title.startsWith("UBESVART")),
      build_status: unique.filter((i) => i.source === "jarvis-build" || i.source === "github"),
      fyi: unique.filter((i) => i.score < 40),
      source_errors: errors
    };
  }

  /** Telegram-levering: kompakt mobilformat, chunket ≤3900 tegn, via Tool Gateway (policy/audit). */
  static async deliverViaTelegram(gateway: ToolGateway, identity: IdentityContext, brief: BriefArtifact): Promise<boolean> {
    return deliverChunkedTextViaTelegram(gateway, identity, DailyBrief.render(brief), `brief-${brief.generated_at}`);
  }

  static render(brief: BriefArtifact): string {
    const line = (i: BriefItem) => `- ${i.title} [${i.source}:${i.ref}${i.at ? ` · ${i.at}` : ""}] – ${i.why}${i.action ? ` → ${i.action}` : ""}`;
    const section = (name: string, items: BriefItem[]) => (items.length ? `\n${name}\n${items.map(line).join("\n")}\n` : "");
    return (
      `JARVIS DAILY BRIEF (${brief.generated_at})\n` +
      `\nTOP PRIORITIES\n${brief.top_priorities.map((i, n) => `${n + 1}. ${i.title} – ${i.why}${i.action ? ` → ${i.action}` : ""}`).join("\n")}\n` +
      section("TODAY", brief.today) +
      section("NEEDS ATTENTION", brief.needs_attention) +
      section("FOLLOW-UPS", brief.follow_ups) +
      section("JARVIS BUILD STATUS", brief.build_status) +
      section("FYI", brief.fyi)
    );
  }
}
