import { describe, expect, it } from "vitest";
import {
  ChannelSchema,
  DEVICE_KINDS,
  DEVICE_KIND_CHANNELS,
  DeviceKindSchema,
  ENROLLABLE_DEVICE_KINDS,
  OWNER_STEP_UP_CHANNELS,
  allowedChannelsForDeviceKind,
  channelAllowedForDeviceKind,
  deviceKindFromLegacyLabel,
  deviceKindHoldsStepUpChannel,
  type Channel,
  type DeviceKind
} from "../src/index.ts";

/**
 * WP-S1 K5: ALLE kanal x enhetstype-kombinasjoner som en tabelltest mot en EKSPLISITT, uavhengig forventet matrise (skrevet for hånd her, ikke utledet fra implementasjonen). Hvis noen endrer
 * `DEVICE_KIND_CHANNELS` (eller listen over kanaler/typer) uten å tenke seg om, feiler denne testen.
 */
const CHANNELS: readonly Channel[] = ["web", "mobile", "watch", "voice", "api", "system", "telegram", "desktop", "slack", "discord", "twilio"];

/** Forventet: for hver type, nøyaktig hvilke kanaler som er tillatt. */
const EXPECTED: Readonly<Record<DeviceKind, readonly Channel[]>> = {
  iphone: ["mobile"],
  mac: ["desktop"],
  windows: ["desktop"],
  web_browser: ["web", "voice"],
  watch: ["watch"],
  voice_gateway: ["voice"],
  telegram_gateway: ["telegram"],
  api_client: ["api"],
  service: ["system"],
  legacy_unknown: ["watch", "voice", "system", "telegram", "slack", "discord", "twilio"]
};

describe("WP-S1 K5: lukket enhetstype og tabellen type -> tillatte kanaler", () => {
  it("kanallisten og typelisten er nøyaktig de vi har tenkt gjennom (en ny kanal/type MÅ få en bevisst plass i tabellen)", () => {
    expect([...ChannelSchema.options].sort()).toEqual([...CHANNELS].sort());
    expect([...DEVICE_KINDS].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect([...ENROLLABLE_DEVICE_KINDS].sort()).toEqual(Object.keys(EXPECTED).filter((k) => k !== "legacy_unknown").sort());
  });

  for (const kind of DEVICE_KINDS) {
    for (const channel of CHANNELS) {
      const expected = EXPECTED[kind].includes(channel);
      it(`${kind} x ${channel} => ${expected ? "TILLATT" : "NEKTET"}`, () => {
        expect(channelAllowedForDeviceKind(kind, channel)).toBe(expected);
      });
    }
  }

  it("allowedChannelsForDeviceKind returnerer nøyaktig den forventede mengden per type (rekkefølge uten betydning)", () => {
    for (const kind of DEVICE_KINDS) expect([...allowedChannelsForDeviceKind(kind)].sort(), kind).toEqual([...EXPECTED[kind]].sort());
  });

  it("INVARIANT: ingen type med lavtillits-rolle har en step-up-kanal, og legacy_unknown har ingen", () => {
    for (const kind of ["watch", "voice_gateway", "telegram_gateway", "service", "legacy_unknown"] as const) {
      expect(deviceKindHoldsStepUpChannel(kind), kind).toBe(false);
      for (const channel of allowedChannelsForDeviceKind(kind)) expect(OWNER_STEP_UP_CHANNELS.has(channel), `${kind}/${channel}`).toBe(false);
    }
    // ...og motsatt: nøyaktig disse typene kan få en økt som oppfyller step-up.
    expect(DEVICE_KINDS.filter((k) => deviceKindHoldsStepUpChannel(k)).sort()).toEqual(["api_client", "iphone", "mac", "web_browser", "windows"]);
  });

  it("INVARIANT: hver step-up-kanal har minst én type som kan autorisere den (ellers ville step-up aldri kunne oppfylles)", () => {
    for (const channel of OWNER_STEP_UP_CHANNELS) {
      expect(DEVICE_KINDS.some((k) => channelAllowedForDeviceKind(k, channel)), channel).toBe(true);
    }
  });

  it("OWNER_STEP_UP_CHANNELS er uendret: web, desktop, api, mobile (samme mengde som step-up har hatt siden WP-F1)", () => {
    expect([...OWNER_STEP_UP_CHANNELS].sort()).toEqual(["api", "desktop", "mobile", "web"]);
  });

  it("tabellen og lister er frosne (ingen kan mutere dem ved kjøring)", () => {
    expect(Object.isFrozen(DEVICE_KIND_CHANNELS)).toBe(true);
    for (const list of Object.values(DEVICE_KIND_CHANNELS)) expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(allowedChannelsForDeviceKind("legacy_unknown"))).toBe(true);
  });

  it("FAIL-CLOSED: ukjent type eller kanal (fra databasen eller en klient) er aldri tillatt", () => {
    for (const bad of [undefined, null, 0, "", "iPhone", "web", "phone", "legacy", "__proto__", "constructor", {}, [], ["iphone"]]) {
      expect(channelAllowedForDeviceKind(bad, "mobile"), String(bad)).toBe(false);
      expect(channelAllowedForDeviceKind(bad, "web"), String(bad)).toBe(false);
      expect(deviceKindHoldsStepUpChannel(bad), String(bad)).toBe(false);
    }
    for (const badChannel of [undefined, null, 1, "", "WEB", "web ", "toString", {}, ["web"]]) {
      expect(channelAllowedForDeviceKind("web_browser", badChannel), String(badChannel)).toBe(false);
      expect(channelAllowedForDeviceKind("legacy_unknown", badChannel), String(badChannel)).toBe(false);
    }
    expect(DeviceKindSchema.safeParse("legacy_unknown").success).toBe(true);
    expect(DeviceKindSchema.safeParse("Legacy_Unknown").success).toBe(false);
  });
});

describe("WP-S1 K1: avbildningen fra eldre fritekst-kind til lukket type (samme som migrasjon 149)", () => {
  const CASES: Array<[string, DeviceKind, boolean]> = [
    // verdiene førstepartsklientene faktisk skriver
    ["web", "web_browser", true], ["iphone", "iphone", true], ["watch", "watch", true], ["service", "service", true], ["voice", "voice_gateway", true],
    // lukkede navn selv, og vanlige variasjoner i store/små bokstaver og mellomrom i endene
    ["mac", "mac", true], ["windows", "windows", true], ["web_browser", "web_browser", true], ["voice_gateway", "voice_gateway", true], ["telegram_gateway", "telegram_gateway", true],
    ["api_client", "api_client", true], ["Web", "web_browser", true], ["  iPhone  ", "iphone", true], ["WATCH", "watch", true],
    // tvetydig eller ukjent -> legacy_unknown
    ["phone", "legacy_unknown", false], ["pc", "legacy_unknown", false], ["mobile", "legacy_unknown", false], ["desktop-agent", "legacy_unknown", false], ["api", "legacy_unknown", false],
    ["legacy_unknown", "legacy_unknown", false], ["", "legacy_unknown", false], ["   ", "legacy_unknown", false], ["web browser", "legacy_unknown", false], ["web\n", "legacy_unknown", false],
    ["web\t", "legacy_unknown", false], ["we" + String.fromCodePoint(0x200b) + "b", "legacy_unknown", false], ["__proto__", "legacy_unknown", false], ["constructor", "legacy_unknown", false], ["toString", "legacy_unknown", false],
    ["a".repeat(500), "legacy_unknown", false]
  ];
  it.each(CASES)("%j -> %s (mapped=%s)", (label, kind, mapped) => {
    expect(deviceKindFromLegacyLabel(label)).toEqual({ device_kind: kind, mapped });
  });
  it("ikke-streng gir legacy_unknown", () => {
    for (const bad of [undefined, null, 1, {}, ["web"]]) expect(deviceKindFromLegacyLabel(bad)).toEqual({ device_kind: "legacy_unknown", mapped: false });
  });
});
