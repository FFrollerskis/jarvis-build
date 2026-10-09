import { randomUUID } from "node:crypto";
import type { IdentityContext } from "./identity.ts";

/**
 * Remediering del 2 (JARVIS-065): ÉN eier-identitet, utledet fra validert konfigurasjon.
 *
 * Før: tre konkurrerende kilder per prosess (hardkodet `person-tobias`, `process.env[...] ?? "person-tobias"`, seed-default)
 * og falske faste sesjons-id-er (`sess-brief`, `sess-worker`, `sess-coding`). Nå leses `JARVIS_TENANT_ID`,
 * `JARVIS_OWNER_PERSON_ID` og `JARVIS_OWNER_NAME` ÉN gang, valideres, og prosessen FEILER LUKKET ved oppstart hvis de
 * mangler/er ugyldige - ingen stille default som lar en ukonfigurert installasjon opptre som en bestemt person.
 */
export interface OwnerConfig {
  readonly tenant_id: string;
  readonly owner_person_id: string;
  readonly owner_display_name: string;
}

export class OwnerConfigError extends Error {
  constructor(readonly code: "owner_config_missing" | "owner_config_invalid", readonly variable: string) {
    super(`${code}:${variable}`);
    this.name = "OwnerConfigError";
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function requiredId(env: Record<string, string | undefined>, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") throw new OwnerConfigError("owner_config_missing", name);
  const value = raw.trim();
  if (!ID_PATTERN.test(value)) throw new OwnerConfigError("owner_config_invalid", name);
  return value;
}

/** Leser og validerer eier-konfigurasjonen. Kaster `OwnerConfigError` (aldri en default). Kun variabelnavn i feilen - aldri verdier. */
export function loadOwnerConfig(env: Record<string, string | undefined> = process.env): OwnerConfig {
  const tenant_id = requiredId(env, "JARVIS_TENANT_ID");
  const owner_person_id = requiredId(env, "JARVIS_OWNER_PERSON_ID");
  const rawName = env["JARVIS_OWNER_NAME"];
  if (rawName === undefined || rawName.trim() === "") throw new OwnerConfigError("owner_config_missing", "JARVIS_OWNER_NAME");
  const owner_display_name = rawName.trim();
  // eslint-disable-next-line no-control-regex
  if (owner_display_name.length > 80 || /[\u0000-\u001f\u007f<>]/.test(owner_display_name)) {
    throw new OwnerConfigError("owner_config_invalid", "JARVIS_OWNER_NAME");
  }
  return { tenant_id, owner_person_id, owner_display_name };
}

/** Øvre grense: eieren har et fåtall bedrifts-tenants, ikke hundrevis. Flere enn dette er nesten sikkert en feil (og en større sikkerhetsflate). */
export const MAX_OWNER_EXTRA_TENANTS = 10;

/**
 * WP-D2 (Q-44/Q-48 C, JARVIS-044): tenantene der eieren er SUVEREN (`PolicyGateway.authority.owner_tenants`) og kan bruke eier-tilkoblede
 * connector-credentials (`ToolGateway.credentialBinding.owner_tenants`). Standard er NØYAKTIG `[JARVIS_TENANT_ID]` - uendret fra før.
 *
 * `JARVIS_OWNER_EXTRA_TENANTS` (kommaseparert) er en DORMANT, eier-satt utvidelse: den utvider KUN hvor den autentiserte eieren (samme person,
 * ingen delegat) er suveren, og gir ingenting til andre personer, til `person_id: "system"` eller til noen bakgrunnsjobb (planlagte jobber er et eget
 * valg - Q-48 A/B). Den provisjonerer ingenting og gir ingen tilgang uten at tenanten allerede finnes og eieren har en innrullert enhet der.
 * Feil verdi stopper oppstarten (samme fail-closed-regel som resten av eier-konfigurasjonen) - aldri en stille delvis liste.
 */
export function ownerTenantsFromEnv(owner: OwnerConfig, env: Record<string, string | undefined> = process.env): readonly string[] {
  const raw = env["JARVIS_OWNER_EXTRA_TENANTS"];
  if (raw === undefined || raw.trim() === "") return [owner.tenant_id];
  const extras = raw.split(/[,\s]+/).map((t) => t.trim()).filter((t) => t.length > 0);
  if (extras.length > MAX_OWNER_EXTRA_TENANTS) throw new OwnerConfigError("owner_config_invalid", "JARVIS_OWNER_EXTRA_TENANTS");
  for (const tenant of extras) {
    if (!ID_PATTERN.test(tenant)) throw new OwnerConfigError("owner_config_invalid", "JARVIS_OWNER_EXTRA_TENANTS");
  }
  return [...new Set([owner.tenant_id, ...extras])];
}

/** Maskinlesbar oppstartsmelding uten verdier. */
export function describeOwnerConfigError(err: unknown): string {
  return err instanceof OwnerConfigError
    ? `${err.code}: sett ${err.variable} i .env (se .env.example)`
    : "owner_config_error";
}

/**
 * Systemidentitet for bakgrunnsjobber (brief, worker, kodejobber, sweeps) - IKKE en brukersesjon og IKKE en grant.
 * `session_id` er unik PER OPPSTART OG FORMÅL (`sess-sys-<formål>-<tilfeldig>`), slik at audit aldri viser en fast
 * "falsk" sesjon som kan forveksles med en ekte enhetsautorisert sesjon, og `channel` er `system`.
 */
export function systemIdentity(owner: OwnerConfig, purpose: string, overrides: Partial<IdentityContext> = {}): IdentityContext {
  if (!/^[a-z0-9-]{1,32}$/.test(purpose)) throw new Error("system_identity_purpose_invalid");
  return {
    person_id: owner.owner_person_id,
    tenant_id: owner.tenant_id,
    memory_space_id: "personal",
    session_id: `sess-sys-${purpose}-${randomUUID().slice(0, 8)}`,
    device_id: "jarvis-core",
    channel: "system",
    auth_strength: "active",
    ...overrides
  };
}
