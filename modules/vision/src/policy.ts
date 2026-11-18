import type { VisionEventType } from "./types.ts";

/**
 * WP-G3 (D-465), P2e: DETERMINISTISK strømruting etter datapolicy (UA-9 akseptansekriterium 3: «sensitive camera streams are routed
 * according to data policy»).
 *
 * Dette er en ren funksjon (ingen I/O, ingen modell, ingen klokke): gitt kameraets sone, kameraets policy, hendelsestypen og de
 * globale bryterne gir den ÉN avgjørelse - hva som skjer med bildet - og en stabil årsakskode. Pipelinen (pipeline.ts) handler
 * KUN etter denne avgjørelsen og kan ikke velge noe den ikke tillater.
 *
 * Strukturelle garantier (låst av `modules/vision/test/g3-policy.test.ts`, som kjører ALLE kombinasjoner):
 *   1. `egress` er bokstavelig `"none"`: det finnes ingen rute der et kamerabilde forlater maskinen. Det er ingen sky-variant å
 *      velge (heller ikke `route_policy` i databasen har en), så «feil konfigurasjon» kan ikke sende bildet ut.
 *   2. En KONTINUERLIG strøm (`source_kind: "continuous_stream"`) forkastes alltid - Jarvis henter kun ETT øyeblikksbilde per
 *      hendelse og har ingen kode som abonnerer på en videostrøm.
 *   3. Bilde LAGRES kun når sonen er `home`, kameraets policy er `store_snapshot` OG lagring er slått på globalt med en lagringsadapter.
 *      Arbeidsplass og delte soner lagrer aldri (også en inkonsistent rad som omgår DB-CHECK-en nedgraderes til `local_only`).
 *   4. Enhver svikt i forutsetningene gjør avgjørelsen STRENGERE (aldri løsere): lagring av -> kun klassifisering; klassifisering av
 *      -> kun hendelsen; global av/kamera av -> forkast.
 */
export type VisionZoneKind = "home" | "workplace" | "shared";
export type VisionRoutePolicy = "discard" | "local_only" | "store_snapshot";
export type VisionSourceKind = "event_snapshot" | "continuous_stream";

export interface VisionRouteInput {
  source_kind: VisionSourceKind;
  zone_kind: VisionZoneKind;
  route_policy: VisionRoutePolicy;
  camera_enabled: boolean;
  /** Hendelsestypen utledet deterministisk fra utløseren (aldri fra en modell). Tas med for revisjon/fremtidige soneregler. */
  event_type: VisionEventType;
  global: {
    /** `JARVIS_VISION_ENABLED` (hovedbryter). */
    enabled: boolean;
    /** En lokal visjonsmodell er konfigurert og påslått (`JARVIS_VISION_CLASSIFIER`). */
    classification_enabled: boolean;
    /** `JARVIS_VISION_STORE_SNAPSHOTS` og en lagringsadapter finnes. */
    snapshot_storage_enabled: boolean;
  };
}

export type VisionRouteReason =
  | "global_disabled"
  | "camera_disabled"
  | "continuous_stream_forbidden"
  | "policy_discard"
  | "zone_forbids_storage"
  | "storage_disabled"
  | "classification_disabled"
  | "ok_local_only"
  | "ok_store_snapshot";

export interface VisionRouteDecision {
  /** Hentes det et bilde fra kilden? */
  fetch_image: boolean;
  /** Sendes bildet til den LOKALE visjonsmodellen? */
  classify: boolean;
  /** Lagres bildet (lokalt, med oppbevaring)? */
  store_image: boolean;
  /** Skrives selve hendelsen (strukturert, uten bilde)? `false` = hendelsen forkastes helt. */
  record_event: boolean;
  /** Bildet forlater ALDRI maskinen. Bokstavelig `"none"` - ingen rute har noe annet. */
  egress: "none";
  reason: VisionRouteReason;
}

const DISCARD = (reason: VisionRouteReason): VisionRouteDecision => ({
  fetch_image: false, classify: false, store_image: false, record_event: false, egress: "none", reason
});

export function routeVisionEvent(input: VisionRouteInput): VisionRouteDecision {
  if (input.source_kind === "continuous_stream") return DISCARD("continuous_stream_forbidden");
  if (!input.global.enabled) return DISCARD("global_disabled");
  if (!input.camera_enabled) return DISCARD("camera_disabled");
  if (input.route_policy === "discard") return DISCARD("policy_discard");

  // Lagring: kun hjemmesonen + eksplisitt policy + global på. Alt annet nedgraderes til kun klassifisering (aldri løsere).
  let wantsStore = input.route_policy === "store_snapshot";
  let reason: VisionRouteReason = wantsStore ? "ok_store_snapshot" : "ok_local_only";
  if (wantsStore && input.zone_kind !== "home") {
    wantsStore = false;
    reason = "zone_forbids_storage";
  } else if (wantsStore && !input.global.snapshot_storage_enabled) {
    wantsStore = false;
    reason = "storage_disabled";
  }

  const classify = input.global.classification_enabled;
  if (!classify && !wantsStore) {
    // Ingenting å gjøre med et bilde: hendelsen skrives uten at bildet hentes (aldri hentet «for sikkerhets skyld»).
    return { fetch_image: false, classify: false, store_image: false, record_event: true, egress: "none", reason: "classification_disabled" };
  }
  return { fetch_image: true, classify, store_image: wantsStore, record_event: true, egress: "none", reason };
}
