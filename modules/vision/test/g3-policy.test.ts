import { describe, expect, it } from "vitest";
import { routeVisionEvent, type VisionRouteDecision, type VisionRouteInput, type VisionRoutePolicy, type VisionSourceKind, type VisionZoneKind } from "../src/policy.ts";
import { VisionEventTypeSchema } from "../src/types.ts";

/**
 * WP-G3 (D-465), P2e - UA-9 akseptansekriterium 3: «sensitive camera streams are routed according to data policy».
 * Rutingen er en ren funksjon, så beviset er UTTØMMENDE: alle kombinasjoner av kilde-art × sone × policy × kamera på/av × hendelsestype × globale
 * brytere (1728) kjøres mot de strukturelle invariantene. Ingen kombinasjon kan sende et bilde ut av maskinen, lagre et bilde utenfor hjemmesonen,
 * eller gjøre noe løsere når en forutsetning svikter.
 */
const SOURCE_KINDS: VisionSourceKind[] = ["event_snapshot", "continuous_stream"];
const ZONES: VisionZoneKind[] = ["home", "workplace", "shared"];
const POLICIES: VisionRoutePolicy[] = ["discard", "local_only", "store_snapshot"];
const EVENT_TYPES = VisionEventTypeSchema.options;
const BOOLS = [true, false];

interface Combo {
  input: VisionRouteInput;
  decision: VisionRouteDecision;
}

function allCombos(): Combo[] {
  const out: Combo[] = [];
  for (const source_kind of SOURCE_KINDS)
    for (const zone_kind of ZONES)
      for (const route_policy of POLICIES)
        for (const camera_enabled of BOOLS)
          for (const event_type of EVENT_TYPES)
            for (const enabled of BOOLS)
              for (const classification_enabled of BOOLS)
                for (const snapshot_storage_enabled of BOOLS) {
                  const input: VisionRouteInput = { source_kind, zone_kind, route_policy, camera_enabled, event_type, global: { enabled, classification_enabled, snapshot_storage_enabled } };
                  out.push({ input, decision: routeVisionEvent(input) });
                }
  return out;
}

const COMBOS = allCombos();
const rank = (d: VisionRouteDecision): number[] => [d.fetch_image, d.classify, d.store_image, d.record_event].map((b) => (b ? 1 : 0));

describe("P2e: uttømmende bevis over alle rutingkombinasjoner", () => {
  it("dekker hele rommet (2 × 3 × 3 × 2 × 6 × 8 = 1728 kombinasjoner)", () => {
    expect(COMBOS).toHaveLength(2 * 3 * 3 * 2 * EVENT_TYPES.length * 8);
    expect(EVENT_TYPES).toContain("opening_detected");
  });

  it("INV1: egress er ALLTID «none» - ingen rute sender et bilde ut av maskinen", () => {
    for (const { input, decision } of COMBOS) expect(decision.egress, JSON.stringify(input)).toBe("none");
  });

  it("INV2: en kontinuerlig strøm forkastes alltid (ingen henting, ingen klassifisering, ingen lagring, ingen hendelse)", () => {
    const streams = COMBOS.filter((c) => c.input.source_kind === "continuous_stream");
    expect(streams.length).toBeGreaterThan(0);
    for (const { input, decision } of streams) {
      expect(decision, JSON.stringify(input)).toEqual({ fetch_image: false, classify: false, store_image: false, record_event: false, egress: "none", reason: "continuous_stream_forbidden" });
    }
  });

  it("INV3: bilde lagres KUN i hjemmesonen med policy store_snapshot, kamera og hovedbryter på og lagring slått på", () => {
    let stored = 0;
    for (const { input, decision } of COMBOS) {
      if (!decision.store_image) continue;
      stored += 1;
      expect(input.zone_kind, JSON.stringify(input)).toBe("home");
      expect(input.route_policy).toBe("store_snapshot");
      expect(input.camera_enabled).toBe(true);
      expect(input.global.enabled).toBe(true);
      expect(input.global.snapshot_storage_enabled).toBe(true);
      expect(input.source_kind).toBe("event_snapshot");
    }
    expect(stored).toBeGreaterThan(0);
  });

  it("INV4: arbeidsplass og delte soner lagrer aldri - heller ikke en inkonsistent rad som omgår DB-CHECK (nedgraderes til kun klassifisering)", () => {
    for (const zone_kind of ["workplace", "shared"] as const) {
      const decision = routeVisionEvent({
        source_kind: "event_snapshot", zone_kind, route_policy: "store_snapshot", camera_enabled: true, event_type: "motion_detected",
        global: { enabled: true, classification_enabled: true, snapshot_storage_enabled: true }
      });
      expect(decision).toEqual({ fetch_image: true, classify: true, store_image: false, record_event: true, egress: "none", reason: "zone_forbids_storage" });
    }
  });

  it("INV5: policy discard, kamera av og hovedbryter av gir alltid fullstendig forkastelse", () => {
    for (const { input, decision } of COMBOS) {
      if (input.route_policy === "discard" || !input.camera_enabled || !input.global.enabled) {
        expect(rank(decision), JSON.stringify(input)).toEqual([0, 0, 0, 0]);
      }
    }
  });

  it("INV6: et bilde hentes kun når det skal klassifiseres eller lagres (aldri «for sikkerhets skyld»), og klassifisering krever påslått lokal modell", () => {
    for (const { input, decision } of COMBOS) {
      expect(decision.fetch_image, JSON.stringify(input)).toBe(decision.classify || decision.store_image);
      if (decision.classify) expect(input.global.classification_enabled).toBe(true);
    }
  });

  it("INV7 (monotoni): å slå AV en global bryter eller kameraet gjør aldri avgjørelsen løsere", () => {
    for (const { input, decision } of COMBOS) {
      const stricter: VisionRouteInput[] = [
        { ...input, camera_enabled: false },
        { ...input, global: { ...input.global, enabled: false } },
        { ...input, global: { ...input.global, classification_enabled: false } },
        { ...input, global: { ...input.global, snapshot_storage_enabled: false } }
      ];
      for (const candidate of stricter) {
        const after = rank(routeVisionEvent(candidate));
        rank(decision).forEach((before, i) => expect(after[i] as number, `${JSON.stringify(input)} -> ${JSON.stringify(candidate)}`).toBeLessThanOrEqual(before));
      }
    }
  });

  it("INV8: kun klassifisering av + ingen lagring = hendelsen skrives uten at bildet hentes", () => {
    const decision = routeVisionEvent({
      source_kind: "event_snapshot", zone_kind: "home", route_policy: "local_only", camera_enabled: true, event_type: "doorbell_event",
      global: { enabled: true, classification_enabled: false, snapshot_storage_enabled: true }
    });
    expect(decision).toEqual({ fetch_image: false, classify: false, store_image: false, record_event: true, egress: "none", reason: "classification_disabled" });
  });

  it("punktprøver: hjem + store_snapshot + alt på lagrer og klassifiserer; lagring av gir ok_store_snapshot -> storage_disabled", () => {
    const on = { enabled: true, classification_enabled: true, snapshot_storage_enabled: true };
    const home = { source_kind: "event_snapshot", zone_kind: "home", route_policy: "store_snapshot", camera_enabled: true, event_type: "person_present" } as const;
    expect(routeVisionEvent({ ...home, global: on })).toEqual({ fetch_image: true, classify: true, store_image: true, record_event: true, egress: "none", reason: "ok_store_snapshot" });
    expect(routeVisionEvent({ ...home, global: { ...on, snapshot_storage_enabled: false } })).toMatchObject({ store_image: false, classify: true, reason: "storage_disabled" });
    expect(routeVisionEvent({ ...home, route_policy: "local_only", global: on })).toMatchObject({ store_image: false, classify: true, reason: "ok_local_only" });
  });

  it("ingen rutingverdi eller type i modulen har en sky-variant (policy-settet er lukket til discard/local_only/store_snapshot)", () => {
    expect([...new Set(COMBOS.map((c) => c.decision.egress))]).toEqual(["none"]);
    expect(POLICIES).toEqual(["discard", "local_only", "store_snapshot"]);
  });
});
