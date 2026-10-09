import { redactSecrets } from "../redact.ts";
import type { IncidentFact } from "../types.ts";
import { subjectOf, type IncidentProducer, type ProducerClearing } from "./types.ts";

/**
 * WP-E1 (JARVIS-068): en KONFIGURERT tilkobling (connector/modellleverandør) som svikter - `unavailable` eller `auth_failed` i `ToolGateway.health` (BO-03, oppdatert av ekte kall og den
 * daglige helsesveipen D-242) - blir en hendelse. `degraded`/`rate_limited` er forbigående og gir aldri en hendelse. Ikke-konfigurerte tilkoblinger ignoreres (ingen credential = ikke en svikt).
 * Løses kun når helsen er målt `healthy` ETTER at svikten sist ble sett.
 */
export interface ProviderStatusLike {
  id: string;
  display_name: string;
  configured: boolean;
  health: { state: string; at: string; detail?: string } | null;
}

export function providerProducer(deps: { readStatus: () => Promise<ProviderStatusLike[]> }): IncidentProducer {
  return {
    name: "provider",
    async observe(ctx, active) {
      const statuses = await deps.readStatus();
      const byId = new Map(statuses.map((s) => [s.id, s]));
      const present: IncidentFact[] = [];
      const presentIds = new Set<string>();
      for (const s of statuses) {
        if (!s.configured || s.health === null) continue;
        if (s.health.state !== "unavailable" && s.health.state !== "auth_failed") continue;
        presentIds.add(s.id);
        const detail = s.health.detail ? ` - ${redactSecrets(s.health.detail).slice(0, 120)}` : "";
        present.push({
          source_kind: "provider", subject: s.id,
          title: s.health.state === "auth_failed" ? `Tilkobling avvist (credential): ${s.display_name}` : `Tilkobling svikter: ${s.display_name}`,
          severity: s.health.state === "auth_failed" ? "high" : "normal",
          observed_at: Number.isNaN(Date.parse(s.health.at)) ? ctx.now.toISOString() : s.health.at,
          evidence: { source_type: "health_check", source_ref: s.id, summary: `${s.display_name}: helsestatus ${s.health.state} ved ${s.health.at}${detail}` }
        });
      }
      const cleared: ProducerClearing[] = [];
      for (const incident of active) {
        const subject = subjectOf("provider", incident.dedupe_key);
        if (subject === null || presentIds.has(subject)) continue;
        const status = byId.get(subject);
        const health = status?.health;
        if (!status || !health || health.state !== "healthy") continue;
        const seenAt = incident.last_seen_at ? new Date(incident.last_seen_at).getTime() : 0;
        if (!(new Date(health.at).getTime() > seenAt)) continue; // helsemålingen må være NYERE enn siste observerte svikt
        cleared.push({
          subject,
          check: {
            source_type: "health_check", source_ref: subject, summary: `${status.display_name}: helsestatus healthy ved ${health.at}`, observed_at: health.at,
            verified_by: "source_recheck", basis: `ToolGateway.health: ${subject} healthy ved ${health.at}, etter siste observerte svikt`
          }
        });
      }
      return { present, cleared };
    }
  };
}
