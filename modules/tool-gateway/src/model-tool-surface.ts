import { curatedReadOnlyMeshTools, type MeshToolMapping } from "./mesh-bridge.ts";
import type { ToolGateway } from "./gateway.ts";

/**
 * Remediering del 1 / JARVIS-002 (containment): modellens verktøyflate.
 *
 * D-289 ga språkmodellen HELE verktøymeshen (~430 handlinger, 21 klasse D) i
 * hver chat-/tale-/Telegram-tur med sovereign auto-ALLOW og uten deterministisk
 * bekreftelse, mens ubetrodd verktøyoutput (e-post, web, Notion, Slack) mates
 * tilbake i samme løkke umerket. Inntil en ekte autoritetsmodell finnes
 * (taint-gate, per-flate verktøysett, bekreftelse - senere remedieringsfaser)
 * er flaten derfor et EKSPLISITT, LESENDE minimumssett.
 *
 * Dette er den ENESTE kilden til "hva modellen kan kalle" for chat, tale,
 * Telegram og executive-jobber (api OG worker). `allMeshTools()` (full
 * generator) er bevisst IKKE lenger koblet til noen aktiv flate.
 *
 * Utvidelse av listen er en sikkerhetsendring: den krever en ny beslutning
 * og at `assertReadOnlyModelSurface()` fortsatt består (klasse A, ren
 * lese-handling, ingen forbudt verktøy-id).
 */
export const MODEL_SURFACE_ALLOWLIST: ReadonlyArray<{ readonly tool_id: string; readonly action: string }> = [
  { tool_id: "email", action: "read_inbox" },
  { tool_id: "calendar", action: "read_events" },
  { tool_id: "github", action: "read_issues" },
  { tool_id: "executive", action: "get_capability_status" },
  { tool_id: "memory", action: "search" }
];

/** Verktøy-id-er som ALDRI kan stå på modellflaten (eier-kontroll, selvmodifikasjon, infra, penger, deploy, automasjon). */
export const FORBIDDEN_MODEL_TOOL_IDS: ReadonlyArray<string> = [
  "owner_controls",
  "self_modification",
  "docker",
  "gce",
  "finance",
  "mcp_zapier",
  "browser",
  "incidents",
  "governance",
  "situations"
];

/** Handlingsnavn som indikerer skriving/sletting/sending/betaling/merge/kontroll. */
const WRITE_ACTION_PATTERN =
  /(^|_)(send|write|delete|remove|create|update|patch|put|post|pay|refund|capture|cancel|merge|set|revoke|activate|deactivate|freeze|unfreeze|pause|resume|propose|submit|notify|reply|forward|share|upload|invoke|execute|call|reset|restart|start|stop|kill|grant|approve|reject|publish|generate|transfer|charge|order|book|lock|unlock|trigger|run|deploy|comment|label|assign|close|reopen|archive|trash)(_|$)/;

export class ModelSurfaceViolationError extends Error {
  constructor(readonly violations: string[]) {
    super(`modellflaten er ikke ren lese-flate: ${violations.join("; ")}`);
    this.name = "ModelSurfaceViolationError";
  }
}

function key(tool_id: string, action: string): string {
  return `${tool_id}:${action}`;
}

/**
 * Deterministisk boot-/testsjekk: hvert allowlistet par må (1) finnes i en
 * eksplisitt mesh-mapping, (2) være registrert i gatewayen som klasse A,
 * (3) ikke ha forbudt verktøy-id, (4) ikke ha et skrive-/kontroll-handlingsnavn.
 * Feiler lukket (kaster) - aldri en stille utvidelse.
 */
export function assertReadOnlyModelSurface(
  gateway: Pick<ToolGateway, "list">,
  mappings: ReadonlyArray<MeshToolMapping> = curatedReadOnlyMeshTools(),
  options: { allowUnregistered?: boolean } = {}
): void {
  const violations: string[] = [];
  const registered = new Map(gateway.list().map((d) => [key(d.tool_id, d.action), d]));
  const mappedKeys = new Set(mappings.map((m) => key(m.tool_id, m.action)));
  const allowKeys = new Set(MODEL_SURFACE_ALLOWLIST.map((a) => key(a.tool_id, a.action)));

  for (const a of MODEL_SURFACE_ALLOWLIST) {
    const k = key(a.tool_id, a.action);
    if (FORBIDDEN_MODEL_TOOL_IDS.includes(a.tool_id)) violations.push(`${k}: forbudt verktøy-id`);
    if (WRITE_ACTION_PATTERN.test(a.action)) violations.push(`${k}: handlingsnavnet ser ut som skriving/kontroll`);
    const def = registered.get(k);
    // Worker-skjæring: et par som ikke er registrert kan lovlig mangle mapping.
    const skippedAsUnregistered = options.allowUnregistered === true && !def;
    if (!mappedKeys.has(k) && !skippedAsUnregistered) violations.push(`${k}: mangler eksplisitt mesh-mapping`);
    if (!def) {
      if (!options.allowUnregistered) violations.push(`${k}: ikke registrert i ToolGateway`);
    } else if (def.capability_class !== "A") {
      violations.push(`${k}: klasse ${def.capability_class}, kun klasse A (lesing) er tillatt`);
    }
  }
  for (const m of mappings) {
    if (!allowKeys.has(key(m.tool_id, m.action))) {
      violations.push(`${key(m.tool_id, m.action)}: mapping utenfor allowlist`);
    }
  }
  if (violations.length > 0) {
    throw new ModelSurfaceViolationError(violations);
  }
}

/**
 * Den aktive modellflaten for chat, tale, Telegram og executive-jobber.
 * Kaster `ModelSurfaceViolationError` ved oppstart hvis noe i flaten ikke er
 * ren lesing - oppstarten feiler lukket.
 */
export function resolveModelToolSurface(
  gateway: Pick<ToolGateway, "list">,
  options: { onlyRegistered?: boolean } = {}
): MeshToolMapping[] {
  let mappings = curatedReadOnlyMeshTools();
  if (options.onlyRegistered) {
    // Worker-prosessen registrerer en delmengde (ingen executive/memory-transport) -
    // flaten er da skjæringen mellom allowlisten og det som faktisk er registrert,
    // ALDRI en utvidelse utover allowlisten.
    const registered = new Set(gateway.list().map((d) => key(d.tool_id, d.action)));
    mappings = mappings.filter((m) => registered.has(key(m.tool_id, m.action)));
  }
  assertReadOnlyModelSurface(gateway, mappings, { allowUnregistered: options.onlyRegistered === true });
  return mappings;
}
