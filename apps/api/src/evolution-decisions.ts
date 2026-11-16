// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import { withTenantTransaction, writeAudit } from "@jarvis/core";
import {
  EVOLUTION_DECISION_AUDIT_TYPE, EVOLUTION_DECISION_REFUSALS, isEvolutionDecision,
  type EvolutionDecision, type EvolutionDecisionRecorder, type EvolutionDecisionResult
} from "@jarvis/executive";
import { redactAuditPayload } from "./autonomy-audit.ts";
import { safeCategory } from "./control-center/shared.ts";

/**
 * WP-B3 (D-475, EV-23): SKRIVEREN som registrerer eierens avgjørelse (godkjenn / avvis / utsett) om ett endringsforslag. Den er den ENESTE skrivevegen, og den skriver ÉN ting: en rad i det append-only revisjonssporet
 * (`audit_events`, type `evolution.owner_decision`, tenant-skopet). Den skriver ALDRI til endringsregisteret (`evolution_change_ledger`: jarvis_app har kun SELECT her), aktiverer ingenting og utfører ingenting - selvendring
 * er frosset (D-397). En registrert avgjørelse er data som kun Evolusjon-senteret leser (for å vise hva eieren har avgjort); ingen kodevei leser den som en tillatelse.
 *
 * VALGT LAGRING (innsnevret tolkning, ingen migrasjon): revisjonssporet i stedet for endringsregisteret. Endringsregisteret er EV-0-autoritetskjeden (D-408), globalt og hash-lenket; en `approved`-rad der er en uttalelse om at
 * endringen kan gå videre, og første PRODUKSJONSSKRIVER av den er en eier-/arkitektbeslutning - ikke noe en kontrollsenter-knapp skal gjøre stille (se Q-spørsmålet i WPB3-runbooken). Registeret har heller ingen `deferred`-tilstand.
 * Revisjonssporet gir det som kreves uten å røre autoritetskjeden: append-only, tenant-RLS, hvem (person/enhet/økt) og når.
 *
 * Regler (alle håndhevet HER, deterministisk - aldri en promptregel):
 *  - forslaget MÅ finnes og siste rad i endringsregisteret MÅ være `proposed` (ellers `proposal_not_found` / `proposal_not_open`);
 *  - avgjørelsen er BUNDET til versjonen eieren så: `proposal_digest` MÅ være `entry_hash` til forslagets siste rad (ellers `proposal_digest_mismatch` - et omforeslått/endret forslag kan ikke avgjøres på den gamle versjonen);
 *  - en E3-endring (forbudt for Evolution Engine, CHECK i registeret) kan aldri GODKJENNES (`proposal_class_forbidden`); avvis og utsett er tillatt;
 *  - IDEMPOTENT: samme avgjørelse for samme versjon skrives ikke på nytt (`already_recorded`); en annen avgjørelse overstyrer (den nyeste gjelder) og FØR-BILDET (forrige avgjørelse + når) står i den nye raden;
 *  - serialisert per (tenant, forslag) med en advisory-lås i transaksjonen, så to samtidige klikk gir nøyaktig én rad;
 *  - id-en må ha samme trygge form som Evolusjon-senteret viser (`safeCategory`): ingen fri tekst fra data havner i en revisjonsrad, og raden kan alltid kobles til forslagsraden i senteret;
 *  - hele raden går gjennom hemmelighetsskanneren (`redactAuditPayload`); feil fra databasen blir den FASTE koden `decision_record_failed` (aldri feiltekst videre).
 *
 * Avgrensning (NOT VERIFIED mot NAS): ingen egen indeks på avgjørelsene (`audit_events` har kun (tenant_id, at)); oppslagene avgrenses derfor av forslagets tidspunkt (minus en times margin mot klokkeskjevhet), og leses
 * kun når det finnes forslag. En dedikert delvis indeks er en senere migrasjon hvis volumet krever det.
 */
const DIGEST = /^[0-9a-f]{64}$/;

/** Samme trygge id-form som Evolusjon-senteret viser (se `safeRef`): kun slike forslag har en knapp, og kun slike kan avgjøres. */
export function isDecidableChangeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && safeCategory(value) === value;
}

const LATEST_LEDGER_ROW = `SELECT seq::text AS seq, change_class, decision, entry_hash, at::text AS recorded_at
   FROM evolution_change_ledger WHERE change_id = $1 ORDER BY seq DESC LIMIT 1`;

/**
 * Forrige registrerte avgjørelse for NØYAKTIG denne versjonen (id + digest), tenant-skopet. Margin på en time mot klokkeskjevhet mellom forslagsraden og avgjørelsen (`at` er kun en nedre grense for å avgrense lesingen).
 * «Siste» = høyeste `audit_id`, ALDRI `at`: `at` er transaksjonens starttidspunkt (`now()`), og to samtidige klikk kan starte i én rekkefølge og få låsen i en annen - `audit_id` tildeles ved innsettingen, som er serialisert av låsen.
 */
const PREVIOUS_DECISION = `SELECT payload->>'decision' AS decision, at::text AS decided_at
   FROM audit_events
  WHERE tenant_id = $1 AND type = $2 AND at >= $3::timestamptz - interval '1 hour'
    AND payload->>'change_id' = $4 AND payload->>'proposal_digest' = $5
  ORDER BY audit_id DESC LIMIT 1`;

interface LedgerRow { seq: string; change_class: string; decision: string; entry_hash: string; recorded_at: string }
interface PreviousRow { decision: unknown; decided_at: unknown }

const NOTE_NO = "Registrering av eierens avgjørelse. INGEN virkning: ingenting utføres, godkjennes i endringsregisteret eller aktiveres (selvendring er frosset, D-397).";

export interface EvolutionDecisionRecorderOptions {
  /** Hvor lenge skriveren venter på låsen for ett forslag før den gir opp (fast kode `decision_record_failed`, ingenting skrevet). Standard 5 s - under gatewayens 10 s verktøy-tidsavbrudd, så et fastlåst forsøk ikke holder en forbindelse. */
  lockTimeoutMs?: number;
  /** Øvre grense for hver setning i transaksjonen. Standard 8 s. */
  statementTimeoutMs?: number;
}
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 8_000;

export function createEvolutionDecisionRecorder(pool: pg.Pool, options: EvolutionDecisionRecorderOptions = {}): EvolutionDecisionRecorder {
  const lockTimeoutMs = Math.max(50, Math.min(10_000, Math.trunc(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)));
  const statementTimeoutMs = Math.max(100, Math.min(20_000, Math.trunc(options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS)));
  return {
    async record(identity, input): Promise<EvolutionDecisionResult> {
      if (typeof input !== "object" || input === null || !isDecidableChangeId(input.change_id) || typeof input.proposal_digest !== "string" || !DIGEST.test(input.proposal_digest) || !isEvolutionDecision(input.decision)) {
        throw new Error("invalid_evolution_decision_input");
      }
      const changeId = input.change_id;
      const digest = input.proposal_digest;
      const decision: EvolutionDecision = input.decision;
      try {
        return await withTenantTransaction<EvolutionDecisionResult>(pool, identity.tenant_id, async (client) => {
          // Tidsgrenser (kun denne transaksjonen): en låst eller treg setning gir en fast feilkode i stedet for å holde en forbindelse.
          await client.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)", [`${lockTimeoutMs}ms`, `${statementTimeoutMs}ms`]);
          // Serialiser per (tenant, forslag): to samtidige klikk gir nøyaktig én rad (den andre ser den første og svarer `already_recorded`).
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`jarvis_evolution_decision:${identity.tenant_id}:${changeId}`]);
          const latest = (await client.query(LATEST_LEDGER_ROW, [changeId])).rows[0] as LedgerRow | undefined;
          if (latest === undefined) throw new Error("proposal_not_found");
          if (latest.decision !== "proposed") throw new Error("proposal_not_open");
          if (latest.entry_hash !== digest) throw new Error("proposal_digest_mismatch");
          if (latest.change_class === "E3" && decision === "approve") throw new Error("proposal_class_forbidden");

          const prior = (await client.query(PREVIOUS_DECISION, [identity.tenant_id, EVOLUTION_DECISION_AUDIT_TYPE, latest.recorded_at, changeId, digest])).rows[0] as PreviousRow | undefined;
          const previous: EvolutionDecision | null = prior !== undefined && isEvolutionDecision(prior.decision) ? prior.decision : null;
          const result = (outcome: EvolutionDecisionResult["outcome"]): EvolutionDecisionResult => ({
            outcome, decision, change_id: changeId, proposal_digest: digest, previous_decision: previous, effect: "none", activation_decision: false
          });
          if (previous === decision) return result("already_recorded");

          await writeAudit(client, identity, {
            type: EVOLUTION_DECISION_AUDIT_TYPE, decision: "ALLOW", tool_id: "executive", action: "record_evolution_decision", capability_class: "C",
            payload: redactAuditPayload({
              change_id: changeId, proposal_digest: digest, change_class: latest.change_class, decision,
              // FØR-BILDET: eierens forrige avgjørelse om samme versjon (null = ingen) - den nye overstyrer, den gamle står i sin egen rad.
              before: { decision: previous, decided_at: prior !== undefined && previous !== null && typeof prior.decided_at === "string" ? prior.decided_at : null },
              ledger: { seq: latest.seq, state: "proposed", recorded_at: latest.recorded_at },
              effect: "none", activation_decision: false,
              channel: identity.channel, auth_strength: identity.auth_strength, memory_space: identity.memory_space_id,
              note: NOTE_NO
            })
          });
          return result("recorded");
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        if ((EVOLUTION_DECISION_REFUSALS as readonly string[]).includes(message)) throw err;
        throw new Error("decision_record_failed");
      }
    }
  };
}
