import { chatReadTierMeshTools, curatedReadOnlyMeshTools, type MeshToolMapping } from "./mesh-bridge.ts";
import { CHAT_READ_TIER } from "./chat-read-tier.ts";
import { CHAT_ACT_TIER } from "./chat-act-tier.ts";
import { CHAT_DELEGATE_TIER, DELEGATE_WRITE_KEYS } from "./chat-delegate-tier.ts";
import { inferEffect } from "./tool-manifest.ts";
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

/**
 * D-367: de ENESTE skrivehandlingene modellen har, og de er bevisst smale: skriver KUN til karantene
 * (`memory.propose`), aldri autoritativt, aldri ekstern effekt. Eier-handlingene (`approve_proposal`/
 * `reject_proposal`/`list_proposals`) står IKKE her - de nås kun via grant-ruten `/memory/proposals`.
 * Utvidelse krever en ny beslutning og at `assertReadOnlyModelSurface()` fortsatt består.
 */
export const MODEL_SURFACE_QUARANTINE_WRITES: ReadonlyArray<{ readonly tool_id: string; readonly action: string; readonly scope: string }> = [
  { tool_id: "memory", action: "propose", scope: "memory.propose" }
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
  const allowKeys = new Set([...MODEL_SURFACE_ALLOWLIST, ...MODEL_SURFACE_QUARANTINE_WRITES].map((a) => key(a.tool_id, a.action)));

  for (const a of MODEL_SURFACE_QUARANTINE_WRITES) {
    const k = key(a.tool_id, a.action);
    if (FORBIDDEN_MODEL_TOOL_IDS.includes(a.tool_id)) violations.push(`${k}: forbudt verktøy-id`);
    const def = registered.get(k);
    const skippedAsUnregistered = options.allowUnregistered === true && !def;
    if (!mappedKeys.has(k) && !skippedAsUnregistered) violations.push(`${k}: mangler eksplisitt mesh-mapping`);
    if (!def) {
      if (!options.allowUnregistered) violations.push(`${k}: ikke registrert i ToolGateway`);
    } else {
      if (def.capability_class !== "B") violations.push(`${k}: karantene-skriving må være klasse B (var ${def.capability_class})`);
      if (def.scopes.length !== 1 || def.scopes[0] !== a.scope) violations.push(`${k}: scopes må være nøyaktig [${a.scope}]`);
    }
  }
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
 * D-381: hvert par i chattens lese-nivå må være registrert som klasse A, ren lesing (effekt «read»), uten forbudt verktøy-id og uten
 * skrive-/kontroll-handlingsnavn. Feiler lukket - en handling som senere endres til skriving stopper oppstarten.
 */
export function assertChatReadTier(
  gateway: Pick<ToolGateway, "list">,
  options: { allowUnregistered?: boolean } = {}
): void {
  const violations: string[] = [];
  const registered = new Map(gateway.list().map((d) => [key(d.tool_id, d.action), d]));
  const seen = new Set<string>();
  for (const a of CHAT_READ_TIER) {
    const k = key(a.tool_id, a.action);
    if (seen.has(k)) violations.push(`${k}: duplisert i lese-nivået`);
    seen.add(k);
    if (FORBIDDEN_MODEL_TOOL_IDS.includes(a.tool_id)) violations.push(`${k}: forbudt verktøy-id`);
    if (WRITE_ACTION_PATTERN.test(a.action)) violations.push(`${k}: handlingsnavnet ser ut som skriving/kontroll`);
    if (MODEL_SURFACE_ALLOWLIST.some((b) => b.tool_id === a.tool_id && b.action === a.action)) violations.push(`${k}: allerede i minimumssettet`);
    const def = registered.get(k);
    if (!def) {
      if (!options.allowUnregistered) violations.push(`${k}: ikke registrert i ToolGateway`);
      continue;
    }
    if (def.capability_class !== "A") violations.push(`${k}: klasse ${def.capability_class}, kun klasse A (lesing) er tillatt`);
    if (inferEffect(def.tool_id, def.action) !== "read") violations.push(`${k}: effekt er ikke «read»`);
  }
  if (violations.length > 0) throw new ModelSurfaceViolationError(violations);
}

/**
 * D-382: hvert par i handlingsnivået må være registrert som klasse B eller C med effekt write/send/delete, uten forbudt verktøy-id og
 * uten eier-/minne-navnerom. Feiler lukket. (Selve bekreftelseskravet håndheves i `MeshToolExecutor`, låst av egen test.)
 */
export function assertChatActTier(
  gateway: Pick<ToolGateway, "list">,
  options: { allowUnregistered?: boolean } = {}
): void {
  const violations: string[] = [];
  const registered = new Map(gateway.list().map((d) => [key(d.tool_id, d.action), d]));
  const seen = new Set<string>();
  for (const a of CHAT_ACT_TIER) {
    const k = key(a.tool_id, a.action);
    if (seen.has(k)) violations.push(`${k}: duplisert i handlingsnivået`);
    seen.add(k);
    if (FORBIDDEN_MODEL_TOOL_IDS.includes(a.tool_id)) violations.push(`${k}: forbudt verktøy-id`);
    if (a.tool_id === "memory" || a.tool_id === "consent") violations.push(`${k}: eier-/minne-navnerom kan ikke stå i handlingsnivået`);
    if (CHAT_READ_TIER.some((b) => b.tool_id === a.tool_id && b.action === a.action)) violations.push(`${k}: står allerede i lese-nivået`);
    const def = registered.get(k);
    if (!def) {
      if (!options.allowUnregistered) violations.push(`${k}: ikke registrert i ToolGateway`);
      continue;
    }
    if (def.capability_class !== "B" && def.capability_class !== "C") violations.push(`${k}: klasse ${def.capability_class}, kun B/C er tillatt i handlingsnivået`);
    const effect = inferEffect(def.tool_id, def.action);
    if (effect !== "write" && effect !== "send" && effect !== "delete") violations.push(`${k}: effekt «${effect}» er ikke tillatt i handlingsnivået`);
  }
  if (violations.length > 0) throw new ModelSurfaceViolationError(violations);
}

/**
 * D-416: delegeringsnivået må være registrert: `delegate_background_task` som klasse B/write, `get_task_status` som klasse A/read.
 * Ingen forbudt verktøy-id, ingen duplikater. Feiler lukket. (Bekreftelse i tainted tur håndheves i `MeshToolExecutor`.)
 */
export function assertChatDelegateTier(
  gateway: Pick<ToolGateway, "list">,
  options: { allowUnregistered?: boolean } = {}
): void {
  const violations: string[] = [];
  const registered = new Map(gateway.list().map((d) => [key(d.tool_id, d.action), d]));
  const seen = new Set<string>();
  for (const a of CHAT_DELEGATE_TIER) {
    const k = key(a.tool_id, a.action);
    if (seen.has(k)) violations.push(`${k}: duplisert i delegeringsnivået`);
    seen.add(k);
    if (FORBIDDEN_MODEL_TOOL_IDS.includes(a.tool_id)) violations.push(`${k}: forbudt verktøy-id`);
    if (CHAT_READ_TIER.some((b) => b.tool_id === a.tool_id && b.action === a.action) || CHAT_ACT_TIER.some((b) => b.tool_id === a.tool_id && b.action === a.action)) {
      violations.push(`${k}: står allerede i et annet nivå`);
    }
    const def = registered.get(k);
    if (!def) {
      if (!options.allowUnregistered) violations.push(`${k}: ikke registrert i ToolGateway`);
      continue;
    }
    const write = DELEGATE_WRITE_KEYS.has(`${a.tool_id}.${a.action}`);
    if (write && def.capability_class !== "B") violations.push(`${k}: klasse ${def.capability_class}, delegering er klasse B`);
    if (!write && def.capability_class !== "A") violations.push(`${k}: klasse ${def.capability_class}, statusoppslag er klasse A`);
    const effect = inferEffect(def.tool_id, def.action);
    if (effect !== (write ? "write" : "read")) violations.push(`${k}: effekt «${effect}» er ikke tillatt i delegeringsnivået`);
  }
  if (violations.length > 0) throw new ModelSurfaceViolationError(violations);
}

/**
 * Den aktive modellflaten for chat, tale, Telegram og executive-jobber.
 * Kaster `ModelSurfaceViolationError` ved oppstart hvis noe i flaten ikke er
 * ren lesing - oppstarten feiler lukket.
 */
export function resolveModelToolSurface(
  gateway: Pick<ToolGateway, "list">,
  options: { onlyRegistered?: boolean; includeChatReadTier?: boolean; includeChatActTier?: boolean; includeChatDelegateTier?: boolean } = {}
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
  let out = mappings;
  if (options.includeChatReadTier === true) {
    // D-381: kun api-prosessen (eierens chat) får lese-nivået; worker-jobber beholder minimumssettet.
    assertChatReadTier(gateway, { allowUnregistered: options.onlyRegistered === true });
    out = [...out, ...chatReadTierMeshTools(gateway.list(), CHAT_READ_TIER, "read")];
  }
  if (options.includeChatActTier === true) {
    // D-382: handlingsnivået - skjemaet merkes tydelig for modellen; utførelse krever alltid eierens bekreftelse (executor).
    assertChatActTier(gateway, { allowUnregistered: options.onlyRegistered === true });
    out = [...out, ...chatReadTierMeshTools(gateway.list(), CHAT_ACT_TIER, "act")];
  }
  if (options.includeChatDelegateTier === true) {
    // D-416: kun api-prosessen (eierens chat). Skjemaet merkes som bakgrunnsjobb; ingen bekreftelse i en ren eier-tur (se chat-delegate-tier.ts).
    assertChatDelegateTier(gateway, { allowUnregistered: options.onlyRegistered === true });
    out = [...out, ...chatReadTierMeshTools(gateway.list(), CHAT_DELEGATE_TIER, "read", "[BAKGRUNNSJOBB - kjører videre uten at chatten venter]")];
  }
  return out;
}
