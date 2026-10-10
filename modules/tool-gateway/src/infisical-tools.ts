import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolTransport } from "./gateway.ts";
import { isRotationId } from "./infisical-transport.ts";

/**
 * WP-E1 (UA-5, D-41, regel 11): `ToolDefinition`-ene for Infisical som kontrollert mål. Lesing (helse, secret-METADATA, rotasjonsstatus) = klasse A: ALDRI verdier.
 * `rotate_secrets` = klasse D («DNS/IAM/WAF/secrets er klasse D», masterplan UA-5) med hele kjeden: fersk lesing + målvalidering (rotasjonen må finnes), snapshot av
 * rotasjonens status/tidspunkt (aldri verdier), idempotens-nøkkel PÅKREVD, readback (ny listing: ikke feilet og rotert minst én gang), umiddelbar varsling, og en
 * ærlig «ingen teknisk reversering». Mål-autorisasjon: rotasjons-id-en MÅ stå i `JARVIS_INFISICAL_ROTATION_IDS` (eier-konfigurert, kun på verten; tom = ingen rotasjon).
 * Credential = `INFISICAL_CLIENT_SECRET` (maskin-identiteten som allerede er i api/worker); uten verdi er alt `credential_unavailable`. Verktøy-id `infisical` er et
 * eier-eksklusivt navnerom (aldri på en modellflate) og står i `INFRA_GATED_TOOL_IDS`.
 *
 * STEP-UP (gjennomgang av PR #324, M2): `rotate_secrets` har `step_up_required: true` - gatewayen SELV nekter uten enhetssignert økt fra en eier-kanal (web/desktop/api/mobile; aldri tale/Telegram/
 * meldingsplattform/system). En stjålet eller svak eier-grant skal ikke kunne rotere produksjonshemmeligheter. Standard = strengest; kan lempes av Tobias med en navngitt D-beslutning.
 */
export const INFISICAL_CREDENTIAL_REF = "INFISICAL_CLIENT_SECRET";

const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;
const rotationId = z.string().uuid();
const secretPath = z.string().min(1).max(200);
const secretName = z.string().min(1).max(200);
const ROTATION_FRESH_MS = 10 * 60_000;

type Params = Record<string, JsonValue>;
interface RotationState { rotation_status?: string | null; last_rotated_at?: string | null }

export function infisicalToolDefinitions(transport: ToolTransport, config: { rotationIds?: ReadonlySet<string> } = {}): ToolDefinition[] {
  const allowed = config.rotationIds ?? new Set<string>();
  const read = (action: string, description: string, shape: z.ZodRawShape = {}): ToolDefinition => ({
    tool_id: "infisical", action, description, input_schema: record(shape), capability_class: "A", scopes: ["infisical:read"],
    reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true, timeout_ms: 25_000, rate_limit_per_minute: 30,
    credential_ref: INFISICAL_CREDENTIAL_REF, output_trust: "untrusted", transport
  });
  return [
    read("get_health", "Helse for Infisical (GET /api/status): svarer instansen, og er e-post/redis konfigurert"),
    read("list_secret_metadata", "List secret-METADATA (navn, versjon, alder, tagger, rotasjonsflagg) i prosjektets miljø - ALDRI verdier. Markerer secrets eldre enn max_age_days som stale",
      { path: secretPath.optional(), max_age_days: z.number().int().min(1).max(3650).optional() }),
    read("get_secret_metadata", "Les metadata (alder/versjon/tagger/rotasjonsflagg) for ÉN secret, null hvis den ikke finnes - ALDRI verdien", { key: secretName, path: secretPath.optional() }),
    read("list_secret_rotations", "List secret-rotasjoner (V2): type, status, sist/neste rotasjon. available:false hvis funksjonen ikke er tilgjengelig i instansen"),
    read("get_rotation", "Les én rotasjon (null hvis den ikke finnes) - preflight/readback for rotate_secrets", { rotation_id: rotationId }),
    {
      tool_id: "infisical", action: "rotate_secrets",
      description: "Rotér hemmelighetene til en Infisical V2-rotasjon NÅ (type-spesifikt endepunkt; typen leses fra rotasjonslisten). Kun rotasjons-id-er i JARVIS_INFISICAL_ROTATION_IDS. Verdier returneres aldri",
      input_schema: record({ rotation_id: rotationId }), capability_class: "D", scopes: ["infisical:write"], reversible: false,
      rollback_procedure: "ingen teknisk reversering - den forrige verdien ligger i Infisicals egen versjonshistorikk og må gjenopprettes manuelt der; avhengige tjenester må hente ny verdi. Før-tilstand (rotasjonsstatus/tidspunkt) er journalført, aldri verdier.",
      idempotent_external: false, timeout_ms: 90_000, rate_limit_per_minute: 3, credential_ref: INFISICAL_CREDENTIAL_REF, output_trust: "internal", transport,
      step_up_required: true,
      parameterAuthorizer: (p: Params) => {
        const id = p["rotation_id"];
        if (!isRotationId(id)) return { allowed: false, reason: "missing_or_invalid_rotation_id" };
        return allowed.has(id.toLowerCase()) ? { allowed: true, reason: "owner_configured_rotation" } : { allowed: false, reason: "infisical_rotation_not_authorized" };
      },
      preflight_action: "get_rotation", preflight_requires_target: true,
      postcondition_predicate: (after) => {
        const s = after as RotationState | null;
        if (s === null || typeof s.last_rotated_at !== "string" || /fail|error/i.test(s.rotation_status ?? "")) return false;
        // «Rotert» må bety NYLIG rotert: en gammel `lastRotatedAt` betyr at kallet ikke endret noe. (Ti minutter tåler klokkeavvik mellom verten og Infisical.)
        const at = Date.parse(s.last_rotated_at);
        return !Number.isNaN(at) && Math.abs(Date.now() - at) < ROTATION_FRESH_MS;
      }
    }
  ];
}
