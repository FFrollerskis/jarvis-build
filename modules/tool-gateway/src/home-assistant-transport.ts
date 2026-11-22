import type { JsonValue } from "@jarvis/contracts";
import type { ToolTransport } from "./gateway.ts";
import { guardedFetch } from "./url-safety.ts";

/**
 * D-388 (lukker JARVIS-061 «Home Assistant is a ghost» og D-336 sitt bevisste STOPP): ekte `HomeAssistantTransport`
 * bak de ALLEREDE definerte og testede `homeAssistantTools()` (read_state/light_set/climate_set/lock_set/alarm_set).
 *
 * Home Assistant REST API (verifisert 2026-10-04 mot developers.home-assistant.io/docs/api/rest): alle kall bærer
 * `Authorization: Bearer <langlivet tilgangstoken>`; `GET /api/states` (alle entiteter), `GET /api/states/<entity_id>`
 * (én entitet, 404 når den ikke finnes), `POST /api/services/<domain>/<service>` med JSON-kropp (`entity_id` + data).
 *
 * D-336 sin åpne designavgjørelse («hvordan mapper site_id/room_id til HA sin entity_id/area_id?») løses her EKSPLISITT
 * og uten gjetting: eieren konfigurerer en romkart-JSON (`JARVIS_HA_ROOMS`) som peker hvert `site_id`/`room_id` til
 * entity-id-er per domene (`light`, `climate`, `lock`, `alarm`). Mangler et rom/domene i kartet, feiler kallet lukket
 * (`home_room_not_mapped`) - Jarvis gjetter ALDRI hvilken dør eller alarm et rom betyr (CLAUDE.md regel 2/8).
 * REST-API-et eksponerer ikke area-registeret (kun WebSocket), så et eksplisitt eierkart er også den ærlige løsningen.
 *
 * `read_state` returnerer et normalisert bilde (`on`/`temperature`/`locked`/`armed`) slik at `lock_set`/`alarm_set`
 * sine preflight-/postcondition-predikater (Q-34) fungerer uendret, pluss HA sin rå `state`/`attributes`.
 */
export interface HomeAssistantRoomMap {
  [siteId: string]: {
    [roomId: string]: {
      light?: string | string[];
      climate?: string;
      lock?: string;
      alarm?: string;
    };
  };
}

export type HomeAssistantRoomMapResolver = () => Promise<HomeAssistantRoomMap | string | null>;

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;

export function assertEntityId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ENTITY_ID.test(value)) throw new Error(`home_invalid_entity_id:${label}`);
  return value;
}

/**
 * WP-G3 (D-465), review A-EKSISTERENDE: HA-attributter gikk UENDRET videre til `read_state`-resultatet, og dermed til modellflaten (også sky-modeller) og samtaleloggen. Et `camera.*`-objekt har normalt `access_token`
 * (et token som gir stillbilde via `/api/camera_proxy/...?token=` UTEN det langlevde tokenet) og `entity_picture`/`entity_picture_local` (URL-er som bærer samme token i spørringen) - et kamera-token er adgangen til
 * bildet, og kamerabilder skal aldri nå en sky-modell. Kamerabilder hentes av UA-9 (modules/vision) direkte mot HA, aldri via dette verktøyet.
 *  - `camera`-domenet: `access_token`, `entity_picture` og `entity_picture_local` fjernes ALLTID.
 *  - ALLE domener (samme lekkasjeklasse, én trakt - f.eks. `media_player.entity_picture` har et token i spørringen): attributter med et token-/hemmelighetsnavn (`access_token`, `token`, `api_key`, `password`,
 *    `authorization`, `secret`) og attributter hvis verdi (tekst, eller JSON av en liste/et objekt) bærer et token som spørreparameter (`?token=`, `&access_token=`, `signature=`, `authsig=`) fjernes.
 * Dette gjelder uavhengig av alle `JARVIS_VISION_*`-flagg (en lekkasje skal ikke være flaggstyrt). Øvrige attributter (navn, lysstyrke, temperatur ...) er uendret.
 */
const CAMERA_TOKEN_ATTRIBUTES = new Set(["access_token", "entity_picture", "entity_picture_local"]);
/**
 * Review delta A INFO-D6 + delta2 A LOW-E2: navnebasert gjenkjenning av hemmelige attributter, BEST EFFORT (HA har ingen standard for hva en integrasjon kaller et token: det er ikke en garanti, og er ikke et sikkerhetsvern alene -
 * kamerabildet er vernet av at HA-tokenet aldri er i modellflaten, og kamera-attributtene over fjernes uansett navn).
 * Nøkkelen NORMALISERES (camelCase, kebab, punktum og mellomrom -> ord, små bokstaver: `authToken`, `access-token`, `API.Key`, `ACCESSTOKEN` -> `auth`+`token`, `access`+`token`, `api`+`key`, `accesstoken`), og er hemmelig når
 * en SAMMENHENGENDE RUNDE AV ORD, skrevet sammen uten skilletegn, er et navn på en EKSPLISITT liste (`SECRET_NAMES`: `accesstoken`, `authtoken`, `secretkey`, `accesskey`, `apikey`, `jwt`, `bearer`, `credentials`, `passwd`, `pin` ...).
 * Det finnes ingen delstrengregel: `auth_failed`, `token_count`, `max_tokens` (flertall er et annet navn), `password_required`, `pin_length` og `authenticated` er ikke på listen og beholdes. `auth` ALENE er et hemmelighetsnavn (en bar
 * `auth`-nøkkel med tekst er typisk et innloggingsfelt), men `auth_*` er det ikke med mindre runden er et eget navn (`auth_token`, `auth_key`). Et siste ord som beskriver en EGENSKAP ved hemmeligheten (antall, grense, utløp, påkrevd,
 * feilet ...) gjør nøkkelen uskyldig selv når en runde før det er et hemmelighetsnavn (`token_expires_at`, `password_required`, `token_failed`).
 * En boolsk verdi eller `null` kan aldri bære en hemmelighet og beholdes alltid (`auth: true`). Tidligere regel (c6488c10: `(^|_)(access_?token|token|secret|password|api_?key|authorization)($|_)`) strippet alt dette unntatt den tilsiktede
 * egenskapsklassen og boolske verdier - en test sammenligner mot den regelen (ingen regresjon: `accesstoken`/`ACCESSTOKEN` ble strippet av den og skal fortsatt strippes).
 */
const SECRET_NAMES: ReadonlySet<string> = new Set([
  // token-familien
  "token", "accesstoken", "authtoken", "refreshtoken", "idtoken", "bearertoken", "apitoken", "sessiontoken", "csrftoken",
  // hemmeligheter og nøkler
  "secret", "secretkey", "clientsecret", "sharedsecret", "apikey", "accesskey", "privatekey", "signingkey", "encryptionkey", "authkey",
  // passord og PIN
  "password", "passwd", "pwd", "passphrase", "passcode", "pin", "pincode",
  // øvrige innloggingsbærere
  "jwt", "bearer", "credential", "credentials", "authorization", "cookie"
]);
/** Navn som KUN er hemmelige når de er hele nøkkelen: `auth` (men `auth_failed`, `auth_method`, `auth_required` er det ikke). */
const WHOLE_KEY_SECRET_NAMES: ReadonlySet<string> = new Set(["auth"]);
const MAX_NAME_WORDS = 3;
/** Siste ord som gjør at nøkkelen beskriver en egenskap ved hemmeligheten (antall, grense, utløp, påkrevd, feilet ...), ikke hemmeligheten selv. */
const BENIGN_LAST_WORDS: ReadonlySet<string> = new Set([
  "count", "counts", "limit", "limits", "usage", "used", "total", "max", "min", "length", "len", "size", "type", "kind", "expires", "expiry", "expired", "expiration", "ttl", "timeout", "time", "ts", "at", "age",
  "required", "enabled", "disabled", "configured", "set", "present", "valid", "status", "state", "format", "mode", "policy", "version", "attempts", "rate",
  "failed", "failure", "failures", "error", "errors", "invalid", "denied"
]);

function canonicalKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .split("_")
    .filter((word) => word.length > 0);
}

function isSecretAttributeName(key: string): boolean {
  const words = canonicalKeyWords(key);
  if (words.length === 0) return false;
  if (words.length === 1) return SECRET_NAMES.has(words[0] as string) || WHOLE_KEY_SECRET_NAMES.has(words[0] as string);
  if (BENIGN_LAST_WORDS.has(words[words.length - 1] as string)) return false;
  for (let start = 0; start < words.length; start += 1) {
    let run = "";
    for (let end = start; end < words.length && end < start + MAX_NAME_WORDS; end += 1) {
      run += words[end];
      if (SECRET_NAMES.has(run)) return true;
    }
  }
  return false;
}

/** Spørreparametere som bærer adgang i en URL (`?token=`, `&auth=`, `&key=`, `&apikey=`, `&signature=` ...). */
const TOKEN_IN_QUERY = /[?&](?:access_?token|token|authsig|signature|sig|auth|key|api_?key|access_?key|secret|password|jwt|bearer|credential)=/i;

export function stripSecretHomeAttributes(domain: string, attributes: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (domain === "camera" && CAMERA_TOKEN_ATTRIBUTES.has(key)) continue;
    if (typeof value !== "boolean" && value !== null && isSecretAttributeName(key)) continue;
    const text = typeof value === "string" ? value : typeof value === "object" && value !== null ? JSON.stringify(value) : "";
    if (text !== "" && TOKEN_IN_QUERY.test(text)) continue;
    out[key] = value;
  }
  return out;
}

/** Normaliserer én HA-tilstand til det `homeAssistantTools()` sine predikater forventer. */
export function normalizeHomeState(entity: { entity_id: string; state: string; attributes?: Record<string, unknown> }): Record<string, JsonValue> {
  const domain = entity.entity_id.split(".")[0] ?? "";
  const attributes = stripSecretHomeAttributes(domain, (entity.attributes ?? {}) as Record<string, JsonValue>);
  const out: Record<string, JsonValue> = { entity_id: entity.entity_id, domain, state: entity.state, attributes };
  if (domain === "lock") out["locked"] = entity.state === "locked";
  if (domain === "alarm_control_panel") out["armed"] = entity.state !== "disarmed" && entity.state !== "unknown" && entity.state !== "unavailable";
  if (domain === "light" || domain === "switch") out["on"] = entity.state === "on";
  if (domain === "climate") {
    const t = attributes["temperature"];
    out["temperature"] = typeof t === "number" ? t : null;
    out["current_temperature"] = typeof attributes["current_temperature"] === "number" ? (attributes["current_temperature"] as number) : null;
  }
  return out;
}

export class HomeAssistantTransport implements ToolTransport {
  constructor(
    private readonly baseUrl: () => Promise<string | null>,
    private readonly rooms: HomeAssistantRoomMapResolver
  ) {}

  private async root(): Promise<string> {
    const url = (await this.baseUrl())?.trim();
    if (!url) throw new Error("home_assistant_base_url_not_configured");
    return url.replace(/\/+$/, "");
  }

  private async roomMap(): Promise<HomeAssistantRoomMap> {
    const raw = await this.rooms();
    if (!raw) throw new Error("home_rooms_not_configured");
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not_object");
        return parsed as HomeAssistantRoomMap;
      } catch {
        throw new Error("home_rooms_invalid_json");
      }
    }
    return raw;
  }

  private async entityFor(siteId: string, roomId: string, domain: "light" | "climate" | "lock" | "alarm"): Promise<string[]> {
    const map = await this.roomMap();
    const room = map[siteId]?.[roomId];
    if (!room) throw new Error(`home_room_not_mapped:${siteId}/${roomId}`);
    const value = room[domain];
    if (!value || (Array.isArray(value) && value.length === 0)) throw new Error(`home_room_domain_not_mapped:${siteId}/${roomId}/${domain}`);
    const list = Array.isArray(value) ? value : [value];
    return list.map((e) => assertEntityId(e, domain));
  }

  private async call(method: "GET" | "POST", path: string, credential: string, body?: Record<string, JsonValue>): Promise<{ status: number; json: unknown }> {
    const response = await guardedFetch(`${await this.root()}${path}`, {
      method,
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (response.status === 404) return { status: 404, json: null };
    if (!response.ok) throw new Error(`home_assistant_error_${response.status}`);
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as unknown) : null };
  }

  private async readEntity(entityId: string, credential: string): Promise<Record<string, JsonValue> | null> {
    const { status, json } = await this.call("GET", `/api/states/${encodeURIComponent(entityId)}`, credential);
    if (status === 404 || !json) return null;
    return normalizeHomeState(json as { entity_id: string; state: string; attributes?: Record<string, unknown> });
  }

  /** Minimert tilstandsdetalj (`state`, `last_changed`, `unit`) for ÉN entitet; ukjent entitet = `null`. `unit` (måleenhet, f.eks. W/kW) tas kun med for å kunne sjekke enheten på en effektsensor. */
  private async readDetail(entityId: string, credential: string): Promise<Record<string, JsonValue> | null> {
    const { status, json } = await this.call("GET", `/api/states/${encodeURIComponent(entityId)}`, credential);
    if (status === 404 || !json || typeof json !== "object") return null;
    const raw = json as { state?: unknown; last_changed?: unknown; attributes?: { unit_of_measurement?: unknown } };
    const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
    return { entity_id: entityId, state: text(raw.state, 100), last_changed: text(raw.last_changed, 40), unit: text(raw.attributes?.unit_of_measurement, 16) };
  }

  private async service(domain: string, service: string, data: Record<string, JsonValue>, credential: string): Promise<JsonValue> {
    const { json } = await this.call("POST", `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, credential, data);
    return (json as JsonValue) ?? null;
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    const siteId = String(parameters["site_id"] ?? "");
    const roomId = String(parameters["room_id"] ?? "");
    switch (action) {
      case "list_states": {
        const { json } = await this.call("GET", "/api/states", credential);
        const all = Array.isArray(json) ? (json as Array<{ entity_id: string; state: string; attributes?: Record<string, unknown> }>) : [];
        const domain = typeof parameters["domain"] === "string" ? parameters["domain"] : null;
        const filtered = domain ? all.filter((e) => e.entity_id.startsWith(domain + ".")) : all;
        return { data: filtered.slice(0, 200).map((e) => ({ entity_id: e.entity_id, state: e.state, name: (e.attributes?.["friendly_name"] as JsonValue) ?? null })) };
      }
      case "read_state_detail": {
        // WP-G4 (D-466): MINIMERT tilstandsdetalj for situasjonsmotorens hjem-bro: kun `state`, `last_changed` og `unit` (måleenheten, kun for effekt: W/kW; lukkede nøkler, kuttet lengde) - aldri andre attributter, navn eller historikk.
        // `last_changed` er når tilstanden sist endret seg (HA-dokumentasjonen), som gir «hvor lenge har døren stått åpen» uten at Jarvis lagrer en egen tilstandshistorikk. Ukjent entitet gir `data: null`.
        return { data: await this.readDetail(assertEntityId(parameters["entity"], "entity"), credential) };
      }
      case "read_states_detail": {
        // WP-G4 fiks-runde (B-MEDIUM-4): samme minimerte lesing for opptil 50 entiteter i ETT kall (én revisjonsrad i gatewayen). Rekkefølgen er bevart; ukjent entitet = `null`; en enkeltfeil = `{ entity_id, error }`.
        // Feiler ALLE (HA nede, tilbakekalt credential) kastes den første feilen, så det er en synlig kildefeil og ikke en tom liste.
        const list = parameters["entities"];
        if (!Array.isArray(list) || list.length === 0 || list.length > 50) throw new Error("home_invalid_entity_id:entities");
        const ids = list.map((value) => assertEntityId(value, "entities"));
        const states: JsonValue[] = [];
        let failures = 0;
        let firstError: unknown;
        for (const id of ids) {
          try {
            states.push(await this.readDetail(id, credential));
          } catch (err) {
            failures += 1;
            firstError ??= err;
            states.push({ entity_id: id, error: err instanceof Error && /^[a-z0-9_]{3,60}$/.test(err.message) ? err.message : "home_read_failed" });
          }
        }
        if (failures === ids.length) throw firstError;
        return { data: { states } };
      }
      case "read_state": {
        // Q-34: et ukjent mål gir `data: null` → `preflight_requires_target` avviser lock/alarm lukket.
        if (typeof parameters["entity"] === "string") {
          return { data: await this.readEntity(assertEntityId(parameters["entity"], "entity"), credential) };
        }
        const map = await this.roomMap();
        const room = map[siteId]?.[roomId];
        if (!room) throw new Error(`home_room_not_mapped:${siteId}/${roomId}`);
        const out: Record<string, JsonValue> = {};
        for (const domain of ["light", "climate", "lock", "alarm"] as const) {
          const value = room[domain];
          if (!value) continue;
          const first = Array.isArray(value) ? value[0] : value;
          if (!first) continue;
          const state = await this.readEntity(assertEntityId(first, domain), credential);
          out[domain] = state;
          if (state) {
            if (domain === "lock") out["locked"] = state["locked"] ?? null;
            if (domain === "alarm") out["armed"] = state["armed"] ?? null;
            if (domain === "light") out["on"] = state["on"] ?? null;
            if (domain === "climate") out["temperature"] = state["temperature"] ?? null;
          }
        }
        return { data: out };
      }
      case "light_set": {
        const entities = await this.entityFor(siteId, roomId, "light");
        const on = parameters["on"] === true;
        await this.service("light", on ? "turn_on" : "turn_off", { entity_id: entities.length === 1 ? entities[0]! : entities }, credential);
        return { external_id: `${on ? "on" : "off"}:${entities.join(",")}` };
      }
      case "climate_set": {
        const [entity] = await this.entityFor(siteId, roomId, "climate");
        const temperature = Number(parameters["temperature"]);
        if (!Number.isFinite(temperature)) throw new Error("home_invalid_temperature");
        await this.service("climate", "set_temperature", { entity_id: entity!, temperature }, credential);
        return { external_id: `temp:${entity}:${temperature}` };
      }
      case "lock_set": {
        const entity = assertEntityId(parameters["entity"], "entity");
        if (!entity.startsWith("lock.")) throw new Error("home_invalid_entity_id:entity_not_lock");
        const locked = parameters["locked"] === true;
        await this.service("lock", locked ? "lock" : "unlock", { entity_id: entity }, credential);
        return { external_id: `${locked ? "lock" : "unlock"}:${entity}` };
      }
      case "alarm_set": {
        const [entity] = await this.entityFor(siteId, roomId, "alarm");
        const armed = parameters["armed"] === true;
        await this.service("alarm_control_panel", armed ? "alarm_arm_away" : "alarm_disarm", { entity_id: entity! }, credential);
        return { external_id: `${armed ? "arm" : "disarm"}:${entity}` };
      }
      default:
        throw new Error(`home_assistant_unsupported_action_${action}`);
    }
  }
}
