import type { IdentityContext } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { IncidentFact } from "../types.ts";
import { subjectOf, type IncidentProducer, type ProducerClearing } from "./types.ts";

/**
 * WP-E1 (JARVIS-068): uløste Sentry-feil siste timen blir hendelser. Alt går via `ToolGateway.execute()` (`sentry.list_issues`/`get_issue`, klasse A, `output_trust: "untrusted"`) - aldri en egen
 * HTTP-klient. SENTRY-INNHOLD ER UBETRODD DATA (CLAUDE.md regel 7): issue-TITTEL/melding/stack brukes ALDRI (hverken som hendelsestittel eller i beviset). Tittelen er en fast mal, og beviset
 * består kun av validerte felt (numerisk id, nivå fra et lukket sett, antall som heltall, tidsstempel som dato) og er `UNVERIFIED` - det er Sentrys påstand, ikke en Jarvis-måling.
 *
 * Tak mot oversvømmelse: maks `maxIssues` (standard 10) per kjøring, og `IncidentService` har i tillegg tak på aktive hendelser per produsent. Dormant uten token (`skipped`).
 * Løsning kun når `get_issue` for akkurat dette issuet melder `resolved`/`ignored`; en feilet oppslag løser aldri noe.
 */
const SENTRY_TOKEN_REF = "JARVIS_SENTRY_API_TOKEN";
const LEVELS: ReadonlySet<string> = new Set(["error", "fatal"]);
const slug = (value: unknown): string => (typeof value === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(value) ? value : "ukjent");

interface SentryIssue {
  id: string;
  shortId: string;
  project: string;
  level: "error" | "fatal";
  count: number | null;
  lastSeen: string;
}

function parseIssue(raw: unknown, now: Date, windowMinutes: number): SentryIssue | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["id"] !== "string" || !/^\d{1,20}$/.test(r["id"])) return null;
  if (typeof r["level"] !== "string" || !LEVELS.has(r["level"])) return null;
  if (r["status"] !== undefined && r["status"] !== "unresolved") return null;
  if (typeof r["lastSeen"] !== "string" || Number.isNaN(Date.parse(r["lastSeen"]))) return null;
  if (now.getTime() - Date.parse(r["lastSeen"]) > windowMinutes * 60_000) return null;
  const count = typeof r["count"] === "string" && /^\d{1,12}$/.test(r["count"]) ? Number(r["count"]) : typeof r["count"] === "number" && Number.isSafeInteger(r["count"]) && r["count"] >= 0 ? r["count"] : null;
  const project = typeof r["project"] === "object" && r["project"] !== null ? slug((r["project"] as Record<string, unknown>)["slug"]) : "ukjent";
  return { id: r["id"], shortId: slug(r["shortId"]), project, level: r["level"] as "error" | "fatal", count, lastSeen: new Date(r["lastSeen"]).toISOString() };
}

export interface SentryProducerDeps {
  gateway: Pick<ToolGateway, "execute" | "hasSecret">;
  identity: IdentityContext;
  /** Sentry-spørringen. Fast og streng (ikke fra miljø/modell). Nivå og ferskhet filtreres uansett i koden, så spørringen kan være bred. */
  query?: string;
  maxIssues?: number;
  windowMinutes?: number;
  maxRechecks?: number;
}

export function sentryProducer(deps: SentryProducerDeps): IncidentProducer {
  const query = deps.query ?? "is:unresolved";
  const maxIssues = deps.maxIssues ?? 10;
  const windowMinutes = deps.windowMinutes ?? 60;
  const maxRechecks = deps.maxRechecks ?? 10;
  return {
    name: "sentry",
    async observe(ctx, active) {
      if (!(await deps.gateway.hasSecret(SENTRY_TOKEN_REF))) return { present: [], cleared: [], skipped: "sentry_not_configured" };
      const listed = await deps.gateway.execute({ identity: deps.identity, tool_id: "sentry", action: "list_issues", parameters: { query } });
      if (!listed.ok) throw new Error(`sentry_unavailable:${listed.reason.slice(0, 80)}`);
      if (!Array.isArray(listed.data)) throw new Error("sentry_invalid_response");
      const issues = (listed.data as unknown[]).map((raw) => parseIssue(raw, ctx.now, windowMinutes)).filter((i): i is SentryIssue => i !== null).slice(0, maxIssues);
      const presentSubjects = new Set<string>();
      const present: IncidentFact[] = issues.map((issue) => {
        const subject = `issue-${issue.id}`;
        presentSubjects.add(subject);
        return {
          source_kind: "sentry", subject, title: `Sentry: ${issue.level}-feil i ${issue.project} (${issue.shortId})`, severity: issue.level === "fatal" ? "high" : "normal", observed_at: issue.lastSeen,
          evidence: {
            source_type: "application_error", source_ref: `sentry:${issue.id}`, status: "UNVERIFIED",
            summary: `Sentry-issue ${issue.shortId}: nivå ${issue.level}, ${issue.count ?? "ukjent antall"} hendelser, sist sett ${issue.lastSeen}`
          }
        };
      });
      const cleared: ProducerClearing[] = [];
      let rechecks = 0;
      for (const incident of active) {
        const subject = subjectOf("sentry", incident.dedupe_key);
        const id = subject?.startsWith("issue-") ? subject.slice("issue-".length) : null;
        if (subject === null || id === null || !/^\d{1,20}$/.test(id) || presentSubjects.has(subject) || rechecks >= maxRechecks) continue;
        rechecks += 1;
        const fetched = await deps.gateway.execute({ identity: deps.identity, tool_id: "sentry", action: "get_issue", parameters: { issue_id: id } });
        if (!fetched.ok || typeof fetched.data !== "object" || fetched.data === null) continue; // oppslag feilet: ukjent, aldri «borte»
        const status = (fetched.data as Record<string, unknown>)["status"];
        if (status !== "resolved" && status !== "ignored") continue;
        cleared.push({
          subject,
          check: {
            source_type: "application_error", source_ref: `sentry:${id}`, summary: `Sentry-issue ${id} har status ${status}`, observed_at: ctx.now.toISOString(),
            verified_by: "source_recheck", basis: `sentry get_issue ${id}: status ${status}`
          }
        });
      }
      return { present, cleared };
    }
  };
}
