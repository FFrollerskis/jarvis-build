import { describe, expect, it } from "vitest";
import { ChannelSchema, DEVICE_KINDS, OWNER_STEP_UP_CHANNELS as CONTRACT_STEP_UP_CHANNELS, channelAllowedForDeviceKind, type AuthStrength } from "@jarvis/contracts";
import { OWNER_STEP_UP_CHANNELS, ownerStepUpDenial } from "../src/index.ts";

/**
 * WP-S1 K5: kanal -> step-up er POLICY (`ownerStepUpDenial`, her), enhetstype -> kanal er AUTORISASJON (`@jarvis/core`, tabellen i `@jarvis/contracts`), og de to komponerer. Denne testen låser (1) at det bare finnes
 * ÉN liste over step-up-kanaler, og (2) hvilke (type, kanal)-par som i det hele tatt kan gi en økt som oppfyller step-up når bindingen håndheves: nøyaktig fem.
 */
describe("WP-S1: step-up-kanalene har én kilde, og bare fem (type, kanal)-par kan oppfylle step-up", () => {
  it("OWNER_STEP_UP_CHANNELS i tool-gateway er SAMME objekt som i contracts (ingen kopi som kan drive)", () => {
    expect(OWNER_STEP_UP_CHANNELS).toBe(CONTRACT_STEP_UP_CHANNELS);
    expect([...OWNER_STEP_UP_CHANNELS].sort()).toEqual(["api", "desktop", "mobile", "web"]);
  });

  it("ownerStepUpDenial: tabell over alle styrker x alle kanaler (kun signed fra en eier-kanal oppfyller)", () => {
    const strengths: AuthStrength[] = ["passive", "active", "signed"];
    for (const strength of strengths) {
      for (const channel of ChannelSchema.options) {
        const expected = strength !== "signed" ? "step_up_required:signed_device_session"
          : ["web", "desktop", "api", "mobile"].includes(channel) ? undefined : `step_up_required:channel_${channel}_not_allowed`;
        expect(ownerStepUpDenial({ auth_strength: strength, channel }), `${strength}/${channel}`).toBe(expected);
      }
    }
  });

  it("KOMPOSISJON: med bindingen håndhevet kan kun disse (type, kanal)-parene gi en økt som oppfyller step-up", () => {
    const reachable: string[] = [];
    for (const kind of DEVICE_KINDS) {
      for (const channel of ChannelSchema.options) {
        if (channelAllowedForDeviceKind(kind, channel) && ownerStepUpDenial({ auth_strength: "signed", channel }) === undefined) reachable.push(`${kind}:${channel}`);
      }
    }
    expect(reachable.sort()).toEqual(["api_client:api", "iphone:mobile", "mac:desktop", "web_browser:web", "windows:desktop"]);
  });

  it("de lavtillits-rollene (watch, tale, Telegram, tjeneste) og legacy_unknown kan ALDRI nå step-up, uansett hvilken kanal de påstår", () => {
    for (const kind of ["watch", "voice_gateway", "telegram_gateway", "service", "legacy_unknown"] as const) {
      for (const channel of ChannelSchema.options) {
        const authorized = channelAllowedForDeviceKind(kind, channel);
        if (authorized) expect(ownerStepUpDenial({ auth_strength: "signed", channel }), `${kind}/${channel}`).not.toBeUndefined();
      }
    }
  });
});
