import { readFile } from "node:fs/promises";
import type pg from "pg";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import type { ToolGateway } from "./gateway.ts";

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
      items.push({
        source: "jarvis-build", ref: "runtime-gates",
        title: `${gates.length} åpne runtime-porter`, detail: gates.join(" · "),
        at: new Date().toISOString(), score: 45,
        why: "porter må lukkes før produksjonsstatus", action: "kjør runtime-verifikasjon (Docker/credentials-dagen)"
      });
      if (gateway) {
        const issues = await gateway.execute({
          identity, tool_id: "github", action: "read_issues", parameters: { repo: "tsworkflow/jarvisbuild" }
        });
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

export class DailyBrief {
  constructor(private readonly sources: BriefSource[]) {}

  async generate(identity: IdentityContext): Promise<BriefArtifact> {
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
    const unique = items.filter((i) => {
      const key = `${i.source}:${i.ref}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));

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
