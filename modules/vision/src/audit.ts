import type pg from "pg";
import { writeAudit } from "@jarvis/core";

/**
 * WP-G3 (D-465), review B-L3: revisjon av EIER-handlinger i UA-9 (kamera registrert/endret/fjernet, opptak forespurt). Før dette fantes kun `identity.resolved` per kall (uten rute): en destruktiv fjerning
 * (kaskade av bilder, CLAUDE.md regel 8) etterlot intet spor. Raden skrives i SAMME transaksjon som endringen (`writeAudit` i `audit_events`, append-only): en endring uten revisjonsrad kan ikke committes.
 *
 * Kun eier-rutene (apps/api/src/vision-routes.ts) setter `audit: true`; interne kallere (pipeline, poller, tester) utelater det - da er oppførselen uendret. Payload har kun id-er, enums og tall
 * (aldri etiketter, bilder eller modelltekst).
 */
export interface VisionChangeProvenance {
  task_id?: string | undefined;
  session_id?: string | undefined;
  device_id?: string | undefined;
  /** `true` = skriv en revisjonsrad i samme transaksjon som endringen. */
  audit?: boolean | undefined;
}

export async function writeVisionAudit(
  client: pg.PoolClient,
  tenantId: string,
  personId: string,
  provenance: VisionChangeProvenance,
  entry: { type: string; action: string; payload: Record<string, unknown> }
): Promise<void> {
  if (provenance.audit !== true) return;
  await writeAudit(
    client,
    { tenant_id: tenantId, person_id: personId, ...(provenance.session_id !== undefined ? { session_id: provenance.session_id } : {}), ...(provenance.device_id !== undefined ? { device_id: provenance.device_id } : {}) },
    { type: entry.type, decision: "ALLOW", tool_id: "vision", action: entry.action, ...(provenance.task_id !== undefined ? { task_id: provenance.task_id } : {}), payload: entry.payload }
  );
}
