import { readBodyLimited } from "./image.ts";
import type { CapturedImage, VisionSource, VisionSourceCamera, VisionSourceEvent } from "./source.ts";
import type { VisionEventType } from "./types.ts";

/**
 * WP-G3 (D-465), P1a: `HomeAssistantVisionSource` - Home Assistant som KILDE for kamera-/dørklokke-/sikkerhetshendelser (CLAUDE.md regel 5: HA er enhetsbuss, aldri samtalemotor).
 *
 * D-41-revisjon (HA REST API; verifisert via WebSearch mot developers.home-assistant.io 2026-11-18 - direkte WebFetch mot docs-domenet er blokkert i økten, så alt under er
 * `verified-via-search-snippet`, ikke lest i sin helhet; det som ikke fant støtte i kilden er merket `unverified`):
 *   - `GET /api/states/<entity_id>`: tilstandsobjekt (404 hvis ukjent). Bruker `Authorization: Bearer <langlivet token>` (dokumentert). `last_changed` (ISO 8601) er brukt som hendelsesidentitet;
 *     `last_updated` er IKKE brukt (ikke funnet i kildene - `unverified`).
 *   - `GET /api/camera_proxy/<camera entity_id>`: «returns the data (image) from the specified camera entity_id» (dokumentert). `?time=`-parameteren er KUN vist i eksempler og er
 *     IKKE brukt (`unverified`); uten den leveres det nåværende bildet. Det betyr at et øyeblikksbilde alltid er «nå», ikke «ved hendelsen» - se `maxSnapshotAgeMs` i pipeline.ts.
 *   - IKKE brukt (bevisst): `camera_proxy_stream` (MJPEG-strøm: kontinuerlig video er utenfor UA-9), `camera.record`/`camera.snapshot`-tjenestene (skriver FILER på HA-verten),
 *     `camera.turn_on/off` (styring, ikke bygget: DEFERRED), WebSocket `subscribe_events`/`subscribe_trigger` (push; DEFERRED - denne kilden poller).
 *   - Event-entiteters tilstand (`event.*`: tilstanden er tidspunktet for siste hendelse) og `device_class` (`doorbell`/`motion`) er fra HA sin event-entitetsdokumentasjon via søk; selve
 *     tilstandsformatet er `unverified` mot en ekte instans.
 *
 * Sikkerhet: alle HTTP-kall går gjennom den INNSATTE `fetch` (apps/api gir `guardedFetch`: kun http(s) mot ren vert[:port], ingen redirects, tidsavbrudd) - denne klassen kaller aldri
 * global `fetch`. Entity-id-er valideres mot et lukket tegnsett FØR de settes inn i en URL-sti. Tokenet settes kun i headeren og står aldri i feil/logger (kun `home_assistant_error_<status>`).
 * Utløserens attributter brukes kun som lukkede nøkler (`device_class`, `event_type` i en allowlist-form) - friendly_name og annen fritekst leses ALDRI.
 */
export type VisionHttpFetch = (url: string, init: { method: "GET"; headers: Record<string, string>; redirect: "reject"; signal?: AbortSignal }) => Promise<Response>;

export interface HaVisionSourceOptions {
  fetch: VisionHttpFetch;
  baseUrl: () => Promise<string | null>;
  token: () => Promise<string | null>;
  timeoutMs?: number;
  /** Utløsere eldre enn dette rapporteres ikke (en sensor som står «på» i timevis er ikke en fersk hendelse). Standard 10 min. */
  maxEventAgeMs?: number;
}

const CAMERA_ENTITY = /^camera\.[a-z0-9_]{1,100}$/;
const TRIGGER_ENTITY = /^(binary_sensor|event|alarm_control_panel)\.[a-z0-9_]{1,100}$/;
const MAX_STATE_BYTES = 256 * 1024;

/**
 * Alle feil ut av kilden er en STABIL, fast-ordforråds kode - aldri en frie feiltekst (som kan bære verts-/adresse-/URL-detaljer fra nettverkslaget) og aldri tokenet.
 * Kjente koder slippes gjennom; avbrudd/tidsavbrudd og alt annet i transportlaget mappes til to faste koder.
 */
function haErrorCode(err: unknown): string {
  const message = (err as Error | null)?.message;
  if (typeof message === "string" && /^(home_assistant_[a-z0-9_]{1,60}|unsafe_vendor_url:[a-z0-9_]{1,60}|vision_image_invalid:[a-z_]{1,30})$/.test(message)) return message;
  const name = (err as Error | null)?.name;
  return name === "AbortError" || name === "TimeoutError" ? "home_assistant_timeout" : "home_assistant_unreachable";
}

const BINARY_SENSOR_CLASSES: Readonly<Record<string, VisionEventType>> = {
  motion: "motion_detected",
  moving: "motion_detected",
  occupancy: "person_present",
  presence: "person_present",
  door: "opening_detected",
  garage_door: "opening_detected",
  window: "opening_detected",
  opening: "opening_detected",
  tamper: "security_alert"
};
const EVENT_ENTITY_CLASSES: Readonly<Record<string, VisionEventType>> = { doorbell: "doorbell_event", motion: "motion_detected" };

export class HomeAssistantVisionSource implements VisionSource {
  readonly source_type = "home_assistant";
  private readonly timeoutMs: number;
  private readonly maxEventAgeMs: number;

  constructor(private readonly options: HaVisionSourceOptions) {
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxEventAgeMs = options.maxEventAgeMs ?? 10 * 60_000;
  }

  private async root(): Promise<string> {
    const url = (await this.options.baseUrl())?.trim();
    if (!url) throw new Error("home_assistant_base_url_not_configured");
    return url.replace(/\/+$/, "");
  }

  private async get(path: string): Promise<Response> {
    const token = await this.options.token();
    if (!token) throw new Error("home_assistant_token_not_configured");
    const root = await this.root();
    try {
      return await this.options.fetch(`${root}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json, image/jpeg, image/png, image/webp" },
        redirect: "reject",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      throw new Error(haErrorCode(err)); // aldri den rå transportfeilen (kan bære vert/adresse) videre
    }
  }

  private async readState(entity: string): Promise<{ state: string; attributes: Record<string, unknown>; last_changed: string } | null> {
    const response = await this.get(`/api/states/${encodeURIComponent(entity)}`);
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`home_assistant_error_${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(await readBodyLimited(response, MAX_STATE_BYTES)));
    } catch {
      throw new Error("home_assistant_invalid_state_response");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("home_assistant_invalid_state_response");
    const record = parsed as Record<string, unknown>;
    const attributes = typeof record["attributes"] === "object" && record["attributes"] !== null && !Array.isArray(record["attributes"]) ? (record["attributes"] as Record<string, unknown>) : {};
    return { state: typeof record["state"] === "string" ? record["state"] : "", attributes, last_changed: typeof record["last_changed"] === "string" ? record["last_changed"] : "" };
  }

  async pollEvents(cameras: readonly VisionSourceCamera[], now: Date): Promise<VisionSourceEvent[]> {
    const events: VisionSourceEvent[] = [];
    let attempted = 0;
    let firstFailure: string | null = null;
    let failures = 0;
    for (const camera of cameras) {
      for (const entity of camera.trigger_entities) {
        if (!TRIGGER_ENTITY.test(entity)) continue; // ugyldig konfigurasjon: aldri interpolert i en URL
        attempted += 1;
        let state: Awaited<ReturnType<HomeAssistantVisionSource["readState"]>>;
        try {
          state = await this.readState(entity);
        } catch (err) {
          // Én sensor som feiler skal ikke stoppe de andre; den stabile feilkoden (aldri tokenet, aldri rå transportfeil) logges.
          const code = haErrorCode(err);
          failures += 1;
          firstFailure ??= code;
          console.error(JSON.stringify({ msg: "vision_ha_poll_failed", camera_id: camera.camera_id, entity, code }));
          continue;
        }
        if (state === null) continue;
        const mapped = this.mapState(entity, state);
        if (mapped === null) continue;
        const observedMs = Date.parse(mapped.observed_at_raw);
        if (!Number.isFinite(observedMs)) continue;
        // Fremtidsdatert (klokkeavvik/ondsinnet kilde): klemmes til «nå» - aldri en fersk hendelse i fremtiden.
        const clampedMs = Math.min(observedMs, now.getTime());
        const ageMs = now.getTime() - clampedMs;
        if (ageMs > this.maxEventAgeMs) continue;
        const observed_at = new Date(clampedMs).toISOString();
        events.push({
          source_type: this.source_type,
          source_instance_id: camera.camera_id,
          source_event_id: `${entity}@${new Date(observedMs).toISOString()}`,
          event_type: mapped.event_type,
          observed_at,
          age_ms: ageMs,
          trigger: entity
        });
      }
    }
    // Feilet ALLE lesinger (HA nede, feil token/URL, tidsavbrudd) er det en kildefeil - pipelinen rapporterer den som `source_error` i stedet for en stille «ingen hendelser».
    if (attempted > 0 && failures === attempted && firstFailure !== null) throw new Error(firstFailure);
    return events;
  }

  private mapState(entity: string, state: { state: string; attributes: Record<string, unknown>; last_changed: string }): { event_type: VisionEventType; observed_at_raw: string } | null {
    const domain = entity.split(".")[0];
    const deviceClass = typeof state.attributes["device_class"] === "string" ? state.attributes["device_class"] : "";
    if (domain === "binary_sensor") {
      const eventType = BINARY_SENSOR_CLASSES[deviceClass];
      if (state.state !== "on" || eventType === undefined || state.last_changed === "") return null;
      return { event_type: eventType, observed_at_raw: state.last_changed };
    }
    if (domain === "event") {
      // Tilstanden til en event-entitet er tidspunktet for siste hendelse (`unverified` mot en ekte instans); en entitet uten gyldig tidspunkt eller klasse gir ingen hendelse.
      const eventType = EVENT_ENTITY_CLASSES[deviceClass];
      if (eventType === undefined || Number.isNaN(Date.parse(state.state))) return null;
      return { event_type: eventType, observed_at_raw: state.state };
    }
    if (domain === "alarm_control_panel") {
      if (state.state !== "triggered" || state.last_changed === "") return null;
      return { event_type: "security_alert", observed_at_raw: state.last_changed };
    }
    return null;
  }

  async fetchSnapshot(camera: VisionSourceCamera, maxBytes: number): Promise<CapturedImage> {
    if (!CAMERA_ENTITY.test(camera.source_ref)) throw new Error("home_assistant_invalid_camera_entity");
    const response = await this.get(`/api/camera_proxy/${encodeURIComponent(camera.source_ref)}`);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`home_assistant_error_${response.status}`);
    }
    const declared = response.headers.get("content-type") ?? undefined;
    if (declared === undefined || !declared.toLowerCase().startsWith("image/")) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("home_assistant_snapshot_not_an_image");
    }
    return { bytes: await readBodyLimited(response, maxBytes), declared_type: declared };
  }
}
