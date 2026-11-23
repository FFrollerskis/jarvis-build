import { createHash } from "node:crypto";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { parseCallParams, parseDeleteParams, parseEditParams, parseReactParams, parseSendParams, type FunnelContext, type OutboundFunnel, type ParseResult } from "./funnel.ts";

/**
 * WP-G1 (D-463): eierens HTTP-flate for kommunikasjon (`POST /comms/action`, `POST /comms/preview`) - logikken bor HER (testbar uten HTTP), ruten i `apps/api` gjør kun autentisering (grant -> KUN eieren) og kaller hit.
 * Alt går via `ToolGateway.execute()` (policy, eier-binding, klasse D-kjeden, idempotens, varsling) - ruten har ingen egen sendevei og ingen egen sjekk å omgå.
 *
 * Forespørsels-id: for send/rediger/slett/reager ER den SKOPEDE idempotensnøkkelen (`scopedIdempotencyKey`) journalens `request_id` (ruten setter den; en innsendt `request_id` som avviker fra brukerens nøkkel avvises). Dermed kan
 * ikke ledgeren og journalen komme ut av takt, og en ny nøkkel er ALLTID et nytt forsøk (en brent/feilet forespørsel kan ikke gjenbrukes).
 */
export const COMMS_OUTBOUND_ACTIONS: readonly string[] = ["send", "edit_message", "delete_message", "add_reaction"];
export const COMMS_ADMIN_ACTIONS: readonly string[] = ["authorize_account", "revoke_account", "record_opt_out"];
export const COMMS_READ_ACTIONS: readonly string[] = ["list_inbound", "list_outbound", "list_opt_outs", "list_accounts"];
export const COMMS_OWNER_ACTIONS: readonly string[] = [...COMMS_OUTBOUND_ACTIONS, ...COMMS_ADMIN_ACTIONS, ...COMMS_READ_ACTIONS];
/** Handlinger som finnes KUN med sitt eget flagg: `start_call` (JARVIS_COMMS_CALLS, klasse D - idempotensnøkkel + step-up som sending) og leverandør-lesing (JARVIS_COMMS_VENDOR_READS, klasse A). Ruten kjenner navnene, men en handling uten registrert verktøy avvises som ukjent. */
export const COMMS_CALL_ACTIONS: readonly string[] = ["start_call"];
/**
 * De FEM JOURNALFØRTE utgående handlingene (`comms_outbound_log`): journalen binder idempotensnøkkelen til forespørselens fingeravtrykk (A-M5), så en gjenbrukt nøkkel til en ANNEN forespørsel avvises (`idempotency_key_collision`) FØR gatewayen er nådd.
 * ALT annet er ikke-journalført: der binder ingenting nøkkelen til nyttelasten, og nyttelast-avtrykket i den skopede nøkkelen (WP-G1b, JARVIS-112 a) er det som hindrer at en gjenbrukt nøkkel gir en stille ikke-handling.
 */
export const COMMS_JOURNALLED_ACTIONS: readonly string[] = [...COMMS_OUTBOUND_ACTIONS, ...COMMS_CALL_ACTIONS];
export const COMMS_VENDOR_READ_ACTIONS: readonly string[] = ["read_thread", "list_users", "get_message", "list_templates", "read_message"];
/** Google Contacts (JARVIS_COMMS_CONTACTS): lesing (klasse A, uten step-up) og skriving (create/update C, delete D, sync C - step-up; create/update/delete krever idempotensnøkkel). */
export const COMMS_CONTACT_READ_ACTIONS: readonly string[] = ["contacts_list", "contacts_search", "contacts_get"];
export const COMMS_CONTACT_WRITE_ACTIONS: readonly string[] = ["contacts_create", "contacts_update", "contacts_delete", "contacts_sync", "contacts_unlink"];
/** Møtetranskripsjon (JARVIS_COMMS_MEETINGS): lesing uten step-up; skriving med step-up; kun `meeting_delete` (klasse D) krever idempotensnøkkel (ingest er idempotent på innholds-hash). */
export const COMMS_MEETING_READ_ACTIONS: readonly string[] = ["meeting_list", "meeting_commitments", "meeting_get"];
export const COMMS_MEETING_WRITE_ACTIONS: readonly string[] = ["meeting_ingest_text", "meeting_decide_commitment", "meeting_confirm_participant", "meeting_delete"];
const COMMS_KEYED_CONTACT_ACTIONS: readonly string[] = ["contacts_create", "contacts_update", "contacts_delete", "meeting_delete"];
export const COMMS_KNOWN_ACTIONS: readonly string[] = [...COMMS_OWNER_ACTIONS, ...COMMS_CALL_ACTIONS, ...COMMS_VENDOR_READ_ACTIONS, ...COMMS_CONTACT_READ_ACTIONS, ...COMMS_CONTACT_WRITE_ACTIONS, ...COMMS_MEETING_READ_ACTIONS, ...COMMS_MEETING_WRITE_ACTIONS];

/**
 * Høyeste lengde på brukerens egen nøkkel. En lengre nøkkel er en TYDELIG feil (`idempotency_key_too_long`), aldri avkortet og aldri den misvisende `idempotency_key_required` (JARVIS-112 e). Budsjettet:
 *  - JOURNALFØRTE handlinger: den skopede nøkkelen (handling + tenant-merke + nøkkel, høyst 37 tegn ekstra) må få plass i journalens `request_id` (CHECK 8-200 tegn): 160 + 37 = 197.
 *  - IKKE-JOURNALFØRTE handlinger: i tillegg kommer nyttelast-avtrykket (`PAYLOAD_FINGERPRINT_LENGTH` + skilletegn), høyst 230 tegn. Ledgeren (`tool_executions`, PK (tenant_id, idempotency_key)) har INGEN eksplisitt lengdegrense (`text`, og gatewayen
 *    validerer ikke lengden); den faktiske grensen er btree-tuppelen på 2704 byte, målt til ca. 2650 ukomprimerbare tegn (WP-G1b-proben: 2700 tegn ga et ubehandlet `index row size ... exceeds btree version 4 maximum 2704`-unntak).
 */
export const COMMS_IDEMPOTENCY_KEY_MAX_LENGTH = 160;
const KEY = new RegExp(`^[A-Za-z0-9._:-]{8,${COMMS_IDEMPOTENCY_KEY_MAX_LENGTH}}$`);

/** Lengden (hex-tegn) på nyttelast-avtrykket i den skopede nøkkelen for ikke-journalførte handlinger: 128 bit av SHA-256. */
export const PAYLOAD_FINGERPRINT_LENGTH = 32;

/**
 * A-N2 (LEDER-AVGJØRELSE, delta-review A): ToolGateway-ledgeren slår opp på (tenant, idempotensnøkkel) ALENE - `tool_id`/`action` sammenlignes ikke (kjent JARVIS-102; den delte gatewayen endres ikke her). Samme brukervalgte nøkkel til to
 * ULIKE handlinger ga derfor `ok + deduplicated` på den andre uten at noe ble utført: `authorize_account(K)` så `send(K)` = ingen sending, `send(K)` så `record_opt_out(K)` = ingen STOP registrert (og alt som mutates via comms: kontakter, møter).
 * Eier-handlingslaget SKOPER derfor nøkkelen FØR den når gatewayen og journalen: `<handling>:<tenant-merke>:<nøkkel>`. Samme nøkkel + SAMME handling er fortsatt samme forespørsel (ekte gjenspilling, A-M5-fingeravtrykket gjelder uendret);
 * samme nøkkel + ANNEN handling er uavhengige forespørsler. Tenant-merket (8 hex av SHA-256 over tenant-id-en) gjør nøkkelen entydig også utenfor de tenant-skopede tabellene (ledgerens PK og journalens unike indeks er allerede per tenant).
 *
 * WP-G1b (JARVIS-112 a): for IKKE-journalførte handlinger finnes ingen journal som binder nøkkelen til forespørselen, så samme handling + samme nøkkel + ULIK nyttelast ga fortsatt `ok + deduplicated` uten effekt (`record_opt_out(K, A)` så
 * `(K, B)` registrerte ikke B; `authorize_account(K, X)` så `(K, Y)` autoriserte ikke Y). Da settes nyttelast-avtrykket (`ownerPayloadFingerprint`) inn som eget ledd: `<handling>:<tenant-merke>:<avtrykk>:<nøkkel>`. Ulik nyttelast = en
 * uavhengig forespørsel som UTFØRES; lik nyttelast = en ekte gjenspilling. Journalførte handlinger får IKKE avtrykket (formen er uendret): der er et avvik en kollisjon (A-M5), ikke en ny forespørsel.
 */
export function scopedIdempotencyKey(tenantId: string, action: string, key: string, payloadFingerprint?: string): string {
  const tenantTag = createHash("sha256").update(tenantId, "utf8").digest("hex").slice(0, 8);
  return payloadFingerprint === undefined ? `${action}:${tenantTag}:${key}` : `${action}:${tenantTag}:${payloadFingerprint}:${key}`;
}

/** Høyeste nesting `canonicalPayloadJson` godtar (gyldige nyttelaster er høyst 4 dype). Bunnen mot sykliske eller bevisst dype strukturer: en tydelig feil, aldri stakkoverflyt. */
const CANONICAL_MAX_DEPTH = 16;

/**
 * K3 (WP-G1b): deterministisk, nøkkel-rekkefølge-uavhengig serialisering av en JSON-verdi. Objektnøkler sorteres (UTF-16-kodeenheter, som RFC 8785), arrayer beholder rekkefølgen, og hver verdi skrives slik at ulike typer aldri gir samme tekst:
 * `1` er ikke `"1"`, `null` er ikke en fraværende nøkkel, `[]` er ikke `{}`, `true` er ikke `"true"`. `undefined` som objektverdi regnes som fraværende (som i JSON). Alt som IKKE er JSON KASTER i stedet for å skrives om til `null`
 * (NaN/Infinity, `undefined` i array, funksjon, symbol, bigint, ikke-rene objekter, for dyp nesting): to ulike nyttelaster skal aldri kunne dele avtrykk fordi en verdi ble stille omskrevet.
 */
export function canonicalPayloadJson(value: unknown): string {
  return canonicalize(value, 0);
}

function canonicalize(value: unknown, depth: number): string {
  if (depth > CANONICAL_MAX_DEPTH) throw new RangeError("canonical_payload_too_deep");
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical_payload_non_finite_number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${Array.from(value as unknown[], (item) => canonicalize(item, depth + 1)).join(",")}]`;
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("canonical_payload_not_plain_object");
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v, depth + 1)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonical_payload_unsupported_type:${typeof value}`);
  }
}

/** Feltnavn som er forespørselens IDENTITET (journalens `request_id`, nøkkelfeltet selv), aldri nyttelast: de teller ikke med i avtrykket. Ingen ikke-journalført handlings skjema godtar dem (låst av testen `payload-fingerprint`). */
const REQUEST_IDENTITY_FIELDS: readonly string[] = ["request_id", "idempotency_key"];

/**
 * Nyttelast-avtrykket (hex, `PAYLOAD_FINGERPRINT_LENGTH` tegn) for en ikke-journalført handling: SHA-256 over memory space og den kanoniske nyttelasten. Memory space er med fordi virkningen er per rom (en konto autoriseres per rom, møter og
 * kontaktlenker ligger per rom), mens ledgeren er tenant-bred: samme nøkkel og nyttelast fra to rom er to forespørsler. Kun handlingens parametre teller (ikke person, sesjon, enhet eller kanal: en gjenspilling etter ny innlogging er samme forespørsel).
 * Avtrykket er en usaltet hash (samme klasse som de øvrige pseudonymene i modulen; JARVIS-112 b), så det er ikke en hemmelighet - kun et skille mellom nyttelaster.
 */
export function ownerPayloadFingerprint(memorySpace: string, parameters: Record<string, JsonValue>): string {
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) throw new TypeError("canonical_payload_parameters_not_an_object");
  const payload = Object.fromEntries(Object.entries(parameters).filter(([name]) => !REQUEST_IDENTITY_FIELDS.includes(name)));
  const hashed = JSON.stringify(["comms-owner-payload-v1", memorySpace, canonicalPayloadJson(payload)]);
  return createHash("sha256").update(hashed, "utf8").digest("hex").slice(0, PAYLOAD_FINGERPRINT_LENGTH);
}

export interface OwnerActionDeps {
  readonly gateway: Pick<ToolGateway, "execute" | "get">;
  readonly funnel: OutboundFunnel;
  /**
   * Eier-porten (SAMME predikat som kontrollsentrene og Policy Gateway: suveren eier-person i eier-tenant, ingen delegasjon). FAIL-CLOSED: uten den (eller når den kaster) nektes ALT her - FØR policyen kjøres, FØR noe journalføres og FØR gatewayen er
   * nådd. Gatewayen håndhever i tillegg `owner_only` på hvert verktøy (dyp forsvarslinje); denne porten sørger for at en ikke-eier heller aldri kan skrive en avslagsrad i journalen.
   */
  readonly ownerGate: ((identity: IdentityContext) => boolean) | undefined;
}

function isOwner(deps: OwnerActionDeps, identity: IdentityContext): boolean {
  try {
    return deps.ownerGate !== undefined && deps.ownerGate(identity) === true;
  } catch {
    return false;
  }
}

/** Rommene kommunikasjon kan skje i. En identitet i `health`/`home`/`guest` avvises HER (L2) - FØR policyen, FØR noe journalføres og FØR gatewayen: ellers skrev et avslag/en tørrkjøring rader i det isolerte helse-rommet. */
const COMMS_ALLOWED_SPACES: readonly string[] = ["personal", "business", "project", "shared"];

export type OwnerActionResult =
  | { readonly ok: true; readonly external_id?: string; readonly data: JsonValue; readonly output_trust: string; readonly deduplicated: boolean }
  | { readonly ok: false; readonly status: "denied"; readonly denial_codes: readonly string[]; readonly rules: JsonValue; readonly journal_id: string }
  | { readonly ok: false; readonly status: "rejected" | "failed"; readonly reason: string };

/** Parser en utgående handling med funnelens egne parsere (samme form som transporten). `undefined` = ikke en journalført utgående handling. */
function parseOutbound(action: string, parameters: Record<string, JsonValue>): ParseResult | undefined {
  switch (action) {
    case "send": return parseSendParams(parameters);
    case "start_call": return parseCallParams(parameters);
    case "edit_message": return parseEditParams(parameters);
    case "delete_message": return parseDeleteParams(parameters);
    case "add_reaction": return parseReactParams(parameters);
    default: return undefined;
  }
}

function funnelContext(identity: IdentityContext): FunnelContext {
  return { tenantId: identity.tenant_id, space: identity.memory_space_id as MemorySpace, actor: { person_id: identity.person_id, session_id: identity.session_id }, source: "owner_route" };
}

/** Tørrkjøring: hva ville policyen sagt? Ingen sending, ingen journal. Svaret bærer regelutfall og mottakerbevis - aldri meldingsteksten. */
export async function previewCommsSend(deps: OwnerActionDeps, identity: IdentityContext, parameters: Record<string, JsonValue>): Promise<OwnerActionResult> {
  if (!isOwner(deps, identity)) return { ok: false, status: "rejected", reason: "owner_required" };
  if (!COMMS_ALLOWED_SPACES.includes(identity.memory_space_id)) return { ok: false, status: "rejected", reason: "comms_space_not_allowed" };
  const parsed = parseSendParams({ request_id: "preview-00000000", ...parameters });
  if (!parsed.ok) return { ok: false, status: "rejected", reason: parsed.code };
  const ev = await deps.funnel.evaluate(funnelContext(identity), parsed.value);
  return { ok: true, data: deps.funnel.summarize(ev), output_trust: "internal", deduplicated: false };
}

export async function executeCommsOwnerAction(
  deps: OwnerActionDeps, identity: IdentityContext, input: { action: string; parameters: Record<string, JsonValue>; idempotency_key?: string }
): Promise<OwnerActionResult> {
  const { action } = input;
  if (!isOwner(deps, identity)) return { ok: false, status: "rejected", reason: "owner_required" };
  if (!COMMS_ALLOWED_SPACES.includes(identity.memory_space_id)) return { ok: false, status: "rejected", reason: "comms_space_not_allowed" };
  if (!COMMS_KNOWN_ACTIONS.includes(action) || deps.gateway.get("comms", action) === undefined) return { ok: false, status: "rejected", reason: "comms_unknown_action" };
  const outbound = COMMS_JOURNALLED_ACTIONS.includes(action);
  const userKey = input.idempotency_key;
  let parameters = input.parameters;
  // JARVIS-112 e (K4): en for lang nøkkel (for ALLE handlinger som tar en nøkkel) er en tydelig feil - aldri avkortet, aldri den misvisende `idempotency_key_required`. Sjekken står FØR kravet om nøkkel.
  if (userKey !== undefined && userKey.length > COMMS_IDEMPOTENCY_KEY_MAX_LENGTH) return { ok: false, status: "rejected", reason: "idempotency_key_too_long" };
  if ((outbound || COMMS_KEYED_CONTACT_ACTIONS.includes(action)) && (userKey === undefined || !KEY.test(userKey))) return { ok: false, status: "rejected", reason: "idempotency_key_required" };
  // A-N2: gatewayen og journalen ser kun den SKOPEDE nøkkelen (handling + tenant-merke + brukerens nøkkel).
  // JARVIS-112 a: for IKKE-journalførte handlinger (ingen journal binder nøkkelen til forespørselen) er nyttelast-avtrykket et eget ledd i nøkkelen, så en gjenbrukt nøkkel med ULIK nyttelast aldri gir en stille `ok + deduplicated` uten effekt.
  // Journalførte handlinger får ikke avtrykket: der avvises et avvik som kollisjon (A-M5, under).
  let idempotencyKey: string | undefined;
  if (userKey !== undefined) {
    if (outbound) {
      idempotencyKey = scopedIdempotencyKey(identity.tenant_id, action, userKey);
    } else {
      let fingerprint: string;
      try {
        fingerprint = ownerPayloadFingerprint(identity.memory_space_id, parameters);
      } catch {
        // Nyttelasten er ikke ren JSON (NaN, for dyp nesting, ...): aldri en stille omskriving til et avtrykk som kunne delt nøkkel med en annen nyttelast.
        return { ok: false, status: "rejected", reason: "invalid_parameters" };
      }
      idempotencyKey = scopedIdempotencyKey(identity.tenant_id, action, userKey, fingerprint);
    }
  }
  if (outbound && idempotencyKey !== undefined) {
    if (parameters["request_id"] !== undefined && parameters["request_id"] !== userKey) return { ok: false, status: "rejected", reason: "comms_request_id_mismatch" };
    parameters = { ...parameters, request_id: idempotencyKey };
    // Idempotensnøkkelen er BUNDET til forespørselen (A-M5): ledgeren (PK tenant+nøkkel) ville ellers svart `ok + deduplicated` på en HELT ANNEN forespørsel med samme nøkkel (annen mottaker/tekst, eller `delete_message` med nøkkelen til en
    // tidligere sending - der ingenting ble sendt/slettet). Et forsøk som ER journalført sammenlignes derfor med fingeravtrykket; avvik = `idempotency_key_collision` FØR gatewayen er nådd.
    // Send: tørrkjør FØRST, slik at eieren får ALLE avslagskodene (ikke bare den første) og avslaget journalføres som bevis. ToolGateway kjører policyen på nytt (preflight + rett før kallet).
    // UNNTAK: en GJENSPILLING (id-en har allerede et ikke-avslått forsøk) går rett til gatewayen - ledgeren gir det første resultatet tilbake. Å vurdere policyen mot en tilstand det første forsøket selv har endret
    // (f.eks. ratetelleren) ville avslått en ellers idempotent gjenspilling og skrevet en misvisende avslagsrad.
    const parsed = parseOutbound(action, parameters);
    if (parsed !== undefined && !parsed.ok && (action === "send" || action === "start_call")) return { ok: false, status: "rejected", reason: parsed.code };
    if (parsed !== undefined && parsed.ok) {
      const ctx = funnelContext(identity);
      const state = await deps.funnel.replayState(ctx, parsed.value);
      if (state === "collision") return { ok: false, status: "rejected", reason: "idempotency_key_collision" };
      if ((action === "send" || action === "start_call") && state === "none") {
        const ev = await deps.funnel.evaluate(ctx, parsed.value);
        if (!ev.decision.allowed) {
          const journalId = await deps.funnel.recordDenial(ctx, ev);
          return { ok: false, status: "denied", denial_codes: ev.decision.denial_codes, rules: deps.funnel.summarize(ev)["rules"] as JsonValue, journal_id: journalId };
        }
      }
    }
  }
  const result = await deps.gateway.execute({
    identity, tool_id: "comms", action, parameters, ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {})
  });
  if (!result.ok) return { ok: false, status: "failed", reason: result.reason.slice(0, 120) };
  return { ok: true, ...(result.external_id !== undefined ? { external_id: result.external_id } : {}), data: result.data ?? null, output_trust: result.output_trust, deduplicated: result.deduplicated };
}
