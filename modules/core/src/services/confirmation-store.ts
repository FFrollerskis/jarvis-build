import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { canonicalStringify, type IdentityContext, type JsonValue } from "@jarvis/contracts";
import { withTenantTransaction } from "../db/pool.ts";
import { scanForSecrets } from "./secret-scan.ts";
import { writeAudit } from "./audit-writer.ts";

/**
 * Del 3 (JARVIS-002/014): bundne bekreftelsesobjekter (se migrasjon 066). All logikk for hashing, binding, utløp og engangsforbruk bor HER,
 * i deterministisk kode - aldri i en prompt. Modellen får bare vite «bekreftelse kreves» (og id-en), aldri hvordan den gis.
 */
export const CONFIRMATION_TTL_MS = 5 * 60_000;

/** Parametre som uttrykker MOTTAKER/MÅL/BELØP trekkes ut deterministisk (kun for visning + eksplisitt binding; hele parameter-settet hashes uansett). */
/** Eksportert (M4) slik at avsendere som viser handlingen for eieren bruker NØYAKTIG de samme nøklene som kortet og bindingen. */
export const CARD_RECIPIENT_KEYS: readonly string[] = ["to", "recipient", "recipients", "channel", "channel_id", "chat_id", "phone", "number"];
export const CARD_TARGET_KEYS: readonly string[] = ["repo", "spreadsheet_id", "document_id", "file_id", "folder_id", "url", "base_url", "workflow_id", "scenario_id", "container", "instance", "card_id", "payment_id", "issue_number", "pr_number"];
export const CARD_AMOUNT_KEYS: readonly string[] = ["amount", "amount_ore", "amount_minor", "value", "limit_ore"];

function pick(parameters: Record<string, JsonValue>, keys: readonly string[]): JsonValue | null {
  for (const key of keys) if (key in parameters) return parameters[key] as JsonValue;
  return null;
}

export interface CanonicalCall {
  tool_id: string;
  action: string;
  parameters: Record<string, JsonValue>;
}

export interface ConfirmationSubject {
  tenant_id: string;
  person_id: string;
  device_id?: string | null;
  session_id?: string | null;
}

/** SHA-256 over den kanoniske handlingen + bruker/enhet (uten nonce/utløp): finner raden igjen ved retry av SAMME kall. */
export function callFingerprint(call: CanonicalCall, who: ConfirmationSubject): string {
  const body: JsonValue = {
    v: 1,
    tool_id: call.tool_id,
    action: call.action,
    parameters: call.parameters,
    target: pick(call.parameters, CARD_TARGET_KEYS),
    recipient: pick(call.parameters, CARD_RECIPIENT_KEYS),
    amount: pick(call.parameters, CARD_AMOUNT_KEYS),
    tenant_id: who.tenant_id,
    person_id: who.person_id,
    device_id: who.device_id ?? null
  };
  return createHash("sha256").update(canonicalStringify(body)).digest("hex");
}

/** Full binding: fingeravtrykket + utløp + nonce. Dette er hva eieren faktisk godkjenner. */
export function bindingHash(fingerprint: string, expiresAtIso: string, nonce: string): string {
  return createHash("sha256").update(canonicalStringify({ v: 1, call: fingerprint, expires_at: expiresAtIso, nonce })).digest("hex");
}

/**
 * Lengden på parameterforhåndsvisningen i kortet. Lengre parametere KUTTES (kortet viser da bare begynnelsen), så avsendere som må vise hele handlingen til eieren (AI-rådets forslagsvei, M4) avviser parametere som er
 * lengre enn dette i stedet for å legge frem en avkortet versjon.
 */
export const CARD_PREVIEW_MAX_CHARS = 1000;

export function summarizeCall(call: CanonicalCall, taintReasons: string[], display?: string): JsonValue {
  // Forhåndsvisning for eieren: hemmeligheter fjernet, kuttet. Selve godkjenningen er hashen, ikke denne teksten.
  const preview = scanForSecrets(JSON.stringify(call.parameters)).text.slice(0, CARD_PREVIEW_MAX_CHARS);
  return {
    tool: `${call.tool_id}.${call.action}`,
    recipient: pick(call.parameters, CARD_RECIPIENT_KEYS),
    target: pick(call.parameters, CARD_TARGET_KEYS),
    amount: pick(call.parameters, CARD_AMOUNT_KEYS),
    parameter_keys: Object.keys(call.parameters).sort(),
    parameters_preview: preview,
    taint_reasons: taintReasons,
    // WP-F1: eierens lesbare, REDIGERTE sammendrag av hva handlingen gjelder (beløp/leverandørtype) - aldri en del av bindingen, kun visning.
    ...(display !== undefined ? { display: scanForSecrets(display).text.slice(0, 400) } : {})
  };
}

/** WP-D4 (JARVIS-078): grenser for forslagsveien (`propose`). Utløpet inngår i bindingen, så en lengre levetid er like bundet som standard; klemmen hindrer at en kaller velger en urimelig verdi. */
export const PROPOSE_MIN_TTL_MS = 60_000;
export const PROPOSE_MAX_TTL_MS = 30 * 60_000;
export const PROPOSE_CONTEXT_MAX_CHARS = 4000;

export interface ProposeOptions {
  /** Levetid i ms (standard `CONFIRMATION_TTL_MS`), klemt til [1 min, 30 min]. */
  ttlMs?: number;
  /** Visningskontekst som legges i `summary.context` (f.eks. AI-rådets forslag). Må være redigert tekst: avvises hvis den er for stor eller inneholder noe `scanForSecrets` gjenkjenner. */
  context?: Record<string, JsonValue>;
}

export type ProposeResult =
  | { ok: true; confirmation_id: string; reused: boolean; expires_at: string }
  | { ok: false; reason: "confirmation_rejected"; confirmation_id: string };

export type ConfirmationCheck =
  | { ok: true; confirmation_id: string }
  | { ok: false; reason: "confirmation_required" | "confirmation_pending" | "confirmation_rejected" | "confirmation_expired" | "confirmation_binding_mismatch"; confirmation_id?: string };

/**
 * Det trusted lag utfører etter eierens godkjenning (`approveAndTake`). `taint_reasons` (WP-N1 F2-A1) er grunnene kortet ble opprettet med (ubetrodd output, handlingsnivå, `restricted_turn` fra en LÅST tur); godkjenningsruten leser dem til å
 * avgjøre om en delegert jobb skal utføres med `restrictedOrigin`. Grunnene er data fra trusted lag (aldri fra modellen) og endrer ikke bindingen.
 */
export interface TakenConfirmation {
  confirmation_id: string;
  tool_id: string;
  action: string;
  parameters: Record<string, JsonValue>;
  taint_reasons: string[];
}

export interface PendingConfirmation {
  confirmation_id: string;
  tool_id: string;
  action: string;
  summary: JsonValue;
  taint_reasons: string[];
  expires_at: string;
  created_at: string;
}

interface Row {
  confirmation_id: string;
  binding_hash: string;
  nonce: string;
  status: string;
  expires_at: Date;
}

export class ConfirmationStore {
  constructor(private readonly pool: pg.Pool, private readonly now: () => Date = () => new Date()) {}

  /**
   * Kalles av executoren FØR en tainted handling. Ingen godkjent bekreftelse -> opprett/gjenbruk en PENDING og avvis. En godkjent og
   * IKKE utløpt bekreftelse som matcher full binding forbrukes atomisk (engangs) og slipper handlingen gjennom.
   */
  async checkAndConsume(call: CanonicalCall, who: ConfirmationSubject, taintReasons: string[]): Promise<ConfirmationCheck> {
    const fingerprint = callFingerprint(call, who);
    const now = this.now();
    return withTenantTransaction(this.pool, who.tenant_id, async (client) => {
      const found = await client.query(
        `SELECT confirmation_id, binding_hash, nonce, status, expires_at
           FROM action_confirmations
          WHERE tenant_id = $1 AND person_id = $2 AND call_fingerprint = $3 AND status IN ('pending', 'approved', 'rejected')
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [who.tenant_id, who.person_id, fingerprint]
      );
      const row = found.rows[0] as Row | undefined;
      if (row) {
        if (row.expires_at.getTime() <= now.getTime()) {
          await client.query("UPDATE action_confirmations SET status = 'expired' WHERE confirmation_id = $1 AND status <> 'consumed'", [row.confirmation_id]);
        } else if (row.status === "rejected") {
          return { ok: false, reason: "confirmation_rejected", confirmation_id: row.confirmation_id } as const;
        } else if (row.status === "pending") {
          return { ok: false, reason: "confirmation_pending", confirmation_id: row.confirmation_id } as const;
        } else if (row.status === "approved") {
          // Full binding verifiseres på nytt fra det som FAKTISK kalles nå (ikke fra det som ble lagret som tekst).
          const recomputed = bindingHash(fingerprint, row.expires_at.toISOString(), row.nonce);
          if (recomputed !== row.binding_hash) return { ok: false, reason: "confirmation_binding_mismatch", confirmation_id: row.confirmation_id } as const;
          const consumed = await client.query(
            `UPDATE action_confirmations SET status = 'consumed', consumed_at = now()
              WHERE confirmation_id = $1 AND status = 'approved' AND binding_hash = $2 AND expires_at > now()`,
            [row.confirmation_id, recomputed]
          );
          if ((consumed.rowCount ?? 0) === 1) {
            await writeAudit(client, { tenant_id: who.tenant_id, person_id: who.person_id, ...(who.session_id ? { session_id: who.session_id } : {}), ...(who.device_id ? { device_id: who.device_id } : {}) }, {
              type: "confirmation.consumed",
              tool_id: call.tool_id,
              action: call.action,
              payload: { confirmation_id: row.confirmation_id, binding_hash: recomputed }
            });
            return { ok: true, confirmation_id: row.confirmation_id } as const;
          }
          return { ok: false, reason: "confirmation_expired", confirmation_id: row.confirmation_id } as const;
        }
      }
      // Ingen gyldig bekreftelse: opprett en ny PENDING bundet til dette kallet.
      const id = `conf-${randomUUID()}`;
      const nonce = randomBytes(16).toString("hex");
      const expires = new Date(now.getTime() + CONFIRMATION_TTL_MS);
      // D-382: selve kallet (scope-bundne parametre fra trusted lag) lagres slik at eierens godkjenning kan UTFØRE det i
      // deterministisk kode (`approveAndTake`). Bindingen over kanonisk kall + utløp + nonce verifiseres på nytt før utførelse.
      await client.query(
        `INSERT INTO action_confirmations
           (confirmation_id, tenant_id, person_id, device_id, session_id, tool_id, action, call_fingerprint, binding_hash, nonce, summary, taint_reasons, expires_at, parameters)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, who.tenant_id, who.person_id, who.device_id ?? null, who.session_id ?? null, call.tool_id, call.action, fingerprint,
          bindingHash(fingerprint, expires.toISOString(), nonce), nonce, JSON.stringify(summarizeCall(call, taintReasons)), taintReasons, expires,
          JSON.stringify(call.parameters)]
      );
      await writeAudit(client, { tenant_id: who.tenant_id, person_id: who.person_id, ...(who.session_id ? { session_id: who.session_id } : {}), ...(who.device_id ? { device_id: who.device_id } : {}) }, {
        type: "confirmation.requested",
        tool_id: call.tool_id,
        action: call.action,
        payload: { confirmation_id: id, taint_reasons: taintReasons }
      });
      return { ok: false, reason: "confirmation_required", confirmation_id: id } as const;
    });
  }

  /**
   * WP-D4 (JARVIS-078): FORSLAGSVEI for en avsender som aldri selv skal utføre noe (AI-rådet, §30). Oppretter - eller gjenbruker, idempotent - en PENDING bekreftelse bundet til det kanoniske kallet, og gjør ingenting annet:
   *  - den FORBRUKER aldri en godkjent bekreftelse (`checkAndConsume` gjør det på en eksekutors retry; her finnes ingen retry og ingenting å utføre),
   *  - en nylig AVVIST identisk handling gir `confirmation_rejected` (rådet maser ikke på samme forslag), en utløpt rad merkes utløpt og erstattes,
   *  - utførelsen skjer kun når eieren godkjenner kortet via grant-ruten (`approveAndTake`), gjennom samme ToolGateway som enhver bekreftet handling - bindingen (kanonisk kall + utløp + nonce) er identisk.
   * `context` (redigert visningstekst) lagres i `summary.context`; `taintReasons` merker opprinnelsen (f.eks. `council_proposal`) i kortet og i revisjonssporet.
   */
  async propose(call: CanonicalCall, who: ConfirmationSubject, taintReasons: string[], options: ProposeOptions = {}): Promise<ProposeResult> {
    const ttl = Math.max(PROPOSE_MIN_TTL_MS, Math.min(options.ttlMs ?? CONFIRMATION_TTL_MS, PROPOSE_MAX_TTL_MS));
    let contextJson: string | undefined;
    if (options.context !== undefined) {
      contextJson = JSON.stringify(options.context);
      if (contextJson.length > PROPOSE_CONTEXT_MAX_CHARS) throw new Error("confirmation_context_too_large");
      if (scanForSecrets(contextJson).findings.length > 0) throw new Error("confirmation_context_contains_secret");
    }
    const fingerprint = callFingerprint(call, who);
    const now = this.now();
    return withTenantTransaction(this.pool, who.tenant_id, async (client) => {
      const found = await client.query(
        `SELECT confirmation_id, status, expires_at
           FROM action_confirmations
          WHERE tenant_id = $1 AND person_id = $2 AND call_fingerprint = $3 AND status IN ('pending', 'rejected')
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [who.tenant_id, who.person_id, fingerprint]
      );
      const row = found.rows[0] as { confirmation_id: string; status: string; expires_at: Date } | undefined;
      if (row) {
        if (row.expires_at.getTime() <= now.getTime()) {
          await client.query("UPDATE action_confirmations SET status = 'expired' WHERE confirmation_id = $1 AND status IN ('pending', 'rejected')", [row.confirmation_id]);
        } else if (row.status === "rejected") {
          return { ok: false, reason: "confirmation_rejected", confirmation_id: row.confirmation_id } as const;
        } else {
          return { ok: true, confirmation_id: row.confirmation_id, reused: true, expires_at: row.expires_at.toISOString() } as const;
        }
      }
      const id = `conf-${randomUUID()}`;
      const nonce = randomBytes(16).toString("hex");
      const expires = new Date(now.getTime() + ttl);
      const summary = { ...(summarizeCall(call, taintReasons) as Record<string, JsonValue>), ...(options.context !== undefined ? { context: options.context } : {}) };
      await client.query(
        `INSERT INTO action_confirmations
           (confirmation_id, tenant_id, person_id, device_id, session_id, tool_id, action, call_fingerprint, binding_hash, nonce, summary, taint_reasons, expires_at, parameters)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, who.tenant_id, who.person_id, who.device_id ?? null, who.session_id ?? null, call.tool_id, call.action, fingerprint,
          bindingHash(fingerprint, expires.toISOString(), nonce), nonce, JSON.stringify(summary), taintReasons, expires, JSON.stringify(call.parameters)]
      );
      const origin = options.context?.["source"];
      const councilId = options.context?.["council_id"];
      await writeAudit(client, { tenant_id: who.tenant_id, person_id: who.person_id, ...(who.session_id ? { session_id: who.session_id } : {}), ...(who.device_id ? { device_id: who.device_id } : {}) }, {
        type: "confirmation.requested",
        tool_id: call.tool_id,
        action: call.action,
        payload: { confirmation_id: id, taint_reasons: taintReasons, proposed: true, ...(typeof origin === "string" ? { source: origin } : {}), ...(typeof councilId === "string" ? { council_id: councilId } : {}) }
      });
      return { ok: true, confirmation_id: id, reused: false, expires_at: expires.toISOString() } as const;
    });
  }

  /**
   * WP-F1 (D-462): eierens EGEN forespørsel om en konsekvensiell handling (pengehandling). I motsetning til `checkAndConsume` (som utføreren kaller FØR en tainted
   * handling og som kan FORBRUKE en godkjent bekreftelse og slippe handlingen gjennom) oppretter denne KUN en PENDING bekreftelse bundet til det kanoniske kallet
   * (eller returnerer den allerede ventende for samme kall) - den forbruker aldri noe og gir aldri tillatelse til å utføre. Utføringen skjer først når eieren
   * godkjenner via grant-ruten (`approveAndTake`). Kalles utelukkende fra en step-up-beskyttet, grant-autentisert rute - aldri fra modell/verktøy.
   */
  async requestPending(
    call: CanonicalCall, who: ConfirmationSubject, reasons: string[], display?: string
  ): Promise<{ confirmation_id: string; expires_at: string; created: boolean }> {
    const fingerprint = callFingerprint(call, who);
    const now = this.now();
    return withTenantTransaction(this.pool, who.tenant_id, async (client) => {
      const found = await client.query(
        `SELECT confirmation_id, expires_at FROM action_confirmations
          WHERE tenant_id = $1 AND person_id = $2 AND call_fingerprint = $3 AND status = 'pending' AND expires_at > $4
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [who.tenant_id, who.person_id, fingerprint, now]
      );
      const existing = found.rows[0] as { confirmation_id: string; expires_at: Date } | undefined;
      if (existing) return { confirmation_id: existing.confirmation_id, expires_at: existing.expires_at.toISOString(), created: false };
      const id = `conf-${randomUUID()}`;
      const nonce = randomBytes(16).toString("hex");
      const expires = new Date(now.getTime() + CONFIRMATION_TTL_MS);
      await client.query(
        `INSERT INTO action_confirmations
           (confirmation_id, tenant_id, person_id, device_id, session_id, tool_id, action, call_fingerprint, binding_hash, nonce, summary, taint_reasons, expires_at, parameters)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, who.tenant_id, who.person_id, who.device_id ?? null, who.session_id ?? null, call.tool_id, call.action, fingerprint,
          bindingHash(fingerprint, expires.toISOString(), nonce), nonce, JSON.stringify(summarizeCall(call, reasons, display)), reasons, expires,
          JSON.stringify(call.parameters)]
      );
      await writeAudit(client, { tenant_id: who.tenant_id, person_id: who.person_id, ...(who.session_id ? { session_id: who.session_id } : {}), ...(who.device_id ? { device_id: who.device_id } : {}) }, {
        type: "confirmation.requested",
        tool_id: call.tool_id,
        action: call.action,
        payload: { confirmation_id: id, taint_reasons: reasons, requested_by: "owner" }
      });
      return { confirmation_id: id, expires_at: expires.toISOString(), created: true };
    });
  }

  /**
   * WP-F1: hvilken handling en VENTENDE bekreftelse gjelder (kun for samme person, ikke utløpt) - uten å røre den. Brukes av grant-ruten for å kreve step-up FØR en
   * pengehandling godkjennes (bekreftelsen forbrukes først når step-up er oppfylt). `null` = ingen slik ventende bekreftelse.
   */
  async peekPending(identity: Pick<IdentityContext, "tenant_id" | "person_id">, confirmationId: string): Promise<{ tool_id: string; action: string } | null> {
    return withTenantTransaction(this.pool, identity.tenant_id, async (client) => {
      const res = await client.query(
        `SELECT tool_id, action FROM action_confirmations
          WHERE confirmation_id = $1 AND tenant_id = $2 AND person_id = $3 AND status = 'pending' AND expires_at > now()`,
        [confirmationId, identity.tenant_id, identity.person_id]
      );
      return (res.rows[0] as { tool_id: string; action: string } | undefined) ?? null;
    });
  }

  async listPending(identity: Pick<IdentityContext, "tenant_id" | "person_id">): Promise<PendingConfirmation[]> {
    return withTenantTransaction(this.pool, identity.tenant_id, async (client) => {
      const res = await client.query(
        `SELECT confirmation_id, tool_id, action, summary, taint_reasons, expires_at, created_at
           FROM action_confirmations
          WHERE tenant_id = $1 AND person_id = $2 AND status = 'pending' AND expires_at > now()
          ORDER BY created_at DESC LIMIT 50`,
        [identity.tenant_id, identity.person_id]
      );
      return res.rows.map((r: { confirmation_id: string; tool_id: string; action: string; summary: JsonValue; taint_reasons: string[]; expires_at: Date; created_at: Date }) => ({
        confirmation_id: r.confirmation_id,
        tool_id: r.tool_id,
        action: r.action,
        summary: r.summary,
        taint_reasons: r.taint_reasons,
        expires_at: r.expires_at.toISOString(),
        created_at: r.created_at.toISOString()
      }));
    });
  }

  /**
   * D-382: eierens godkjenning som UTFØRER kallet. Atomisk: pending → consumed (godkjent og forbrukt i samme steg), KUN samme person,
   * kun mens den er pending og ikke utløpt, og KUN hvis bindingen (kanonisk kall + utløp + nonce) fortsatt matcher det lagrede kallet.
   * Returnerer kallet trusted lag skal kjøre (med `confirmation_id` som idempotensnøkkel), eller `null` når ingenting kan utføres.
   * Kalles utelukkende fra grant-autentisert rute - aldri fra modell/verktøy.
   */
  async approveAndTake(
    decider: Pick<IdentityContext, "tenant_id" | "person_id" | "device_id">,
    confirmationId: string
  ): Promise<TakenConfirmation | null> {
    return withTenantTransaction(this.pool, decider.tenant_id, async (client) => {
      const found = await client.query(
        `SELECT confirmation_id, tool_id, action, parameters, call_fingerprint, binding_hash, nonce, expires_at, device_id, taint_reasons
           FROM action_confirmations
          WHERE confirmation_id = $1 AND tenant_id = $2 AND person_id = $3 AND status = 'pending' AND expires_at > now()
          FOR UPDATE`,
        [confirmationId, decider.tenant_id, decider.person_id]
      );
      const row = found.rows[0] as
        | { confirmation_id: string; tool_id: string; action: string; parameters: Record<string, JsonValue> | null; call_fingerprint: string; binding_hash: string; nonce: string; expires_at: Date; device_id: string | null; taint_reasons: string[] | null }
        | undefined;
      if (!row || row.parameters === null) return null;
      // Bindingen beregnes på nytt fra det som FAKTISK ble lagret (inkl. enheten kallet kom fra - godkjenningen kan skje fra en annen
      // enhet, og den registreres i decided_via_device_id) - et endret kall ville ikke matche.
      const recomputedFingerprint = callFingerprint(
        { tool_id: row.tool_id, action: row.action, parameters: row.parameters },
        { tenant_id: decider.tenant_id, person_id: decider.person_id, device_id: row.device_id }
      );
      if (recomputedFingerprint !== row.call_fingerprint) return null;
      if (bindingHash(row.call_fingerprint, row.expires_at.toISOString(), row.nonce) !== row.binding_hash) return null;
      const updated = await client.query(
        `UPDATE action_confirmations
            SET status = 'consumed', decided_at = now(), decided_by_person_id = $2, decided_via_device_id = $3, consumed_at = now()
          WHERE confirmation_id = $1 AND status = 'pending'`,
        [row.confirmation_id, decider.person_id, decider.device_id ?? null]
      );
      if ((updated.rowCount ?? 0) !== 1) return null;
      await writeAudit(client, { tenant_id: decider.tenant_id, person_id: decider.person_id, ...(decider.device_id ? { device_id: decider.device_id } : {}) }, {
        type: "confirmation.approved",
        tool_id: row.tool_id,
        action: row.action,
        payload: { confirmation_id: row.confirmation_id, binding_hash: row.binding_hash, executes: true }
      });
      return { confirmation_id: row.confirmation_id, tool_id: row.tool_id, action: row.action, parameters: row.parameters, taint_reasons: Array.isArray(row.taint_reasons) ? row.taint_reasons : [] };
    });
  }

  /** D-382: resultatet av utførelsen lagres på bekreftelsen (sporbarhet; vises i chat/dashbord). */
  async recordResult(decider: Pick<IdentityContext, "tenant_id">, confirmationId: string, result: JsonValue): Promise<void> {
    await withTenantTransaction(this.pool, decider.tenant_id, async (client) => {
      await client.query(
        `UPDATE action_confirmations SET result = $2, executed_at = now() WHERE confirmation_id = $1 AND tenant_id = $3`,
        [confirmationId, JSON.stringify(result), decider.tenant_id]
      );
    });
  }

  /**
   * Eierens beslutning. KUN samme person som bekreftelsen gjelder (aldri en annen), kun mens den er pending og ikke utløpt.
   * Kalles utelukkende fra grant-autentisert rute - aldri fra modell/verktøy.
   */
  async decide(
    decider: Pick<IdentityContext, "tenant_id" | "person_id" | "device_id">,
    confirmationId: string,
    decision: "approve" | "reject"
  ): Promise<boolean> {
    return withTenantTransaction(this.pool, decider.tenant_id, async (client) => {
      const updated = await client.query(
        `UPDATE action_confirmations
            SET status = $4, decided_at = now(), decided_by_person_id = $2, decided_via_device_id = $5
          WHERE confirmation_id = $1 AND tenant_id = $3 AND person_id = $2 AND status = 'pending' AND expires_at > now()`,
        [confirmationId, decider.person_id, decider.tenant_id, decision === "approve" ? "approved" : "rejected", decider.device_id ?? null]
      );
      const ok = (updated.rowCount ?? 0) === 1;
      if (ok) {
        await writeAudit(client, { tenant_id: decider.tenant_id, person_id: decider.person_id, ...(decider.device_id ? { device_id: decider.device_id } : {}) }, {
          type: `confirmation.${decision === "approve" ? "approved" : "rejected"}`,
          payload: { confirmation_id: confirmationId }
        });
      }
      return ok;
    });
  }
}
