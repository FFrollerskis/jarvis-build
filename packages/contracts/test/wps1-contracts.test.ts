import { describe, expect, it } from "vitest";
import {
  DeviceEnrollmentDenialReasonSchema,
  DeviceEnrollmentRequestSchema,
  SessionGrantDenialReasonSchema,
  VoiceAuthorizationDenialReasonSchema,
  VoiceAuthorizationResultSchema
} from "../src/index.ts";

/**
 * WP-S1: de nye avslagsårsakene MÅ stå i kontraktene som klienter parser strengt. Talegatewayen parser `/voice/session/authorize`-svaret med `VoiceAuthorizationResultSchema`; en ukjent årsak ville blitt til «autoriteten
 * utilgjengelig» i stedet for et klart avslag. Innrullingsforespørselen er `.strict()`: etiketten er valgfri, og typen kan ikke smugles inn.
 */
describe("WP-S1: kontrakter for kanalbinding", () => {
  it("talegatewayens strenge parsing godtar avslaget channel_not_allowed_for_device_kind (og avviser fortsatt ukjente årsaker)", () => {
    expect(VoiceAuthorizationResultSchema.safeParse({ ok: false, reason: "channel_not_allowed_for_device_kind" }).success).toBe(true);
    expect(VoiceAuthorizationDenialReasonSchema.options).toContain("channel_not_allowed_for_device_kind");
    expect(VoiceAuthorizationResultSchema.safeParse({ ok: false, reason: "noe_annet" }).success).toBe(false);
  });

  it("grant-avslag og innrullingsavslag har de nye årsakene", () => {
    expect(SessionGrantDenialReasonSchema.options).toContain("channel_not_allowed_for_device_kind");
    expect(DeviceEnrollmentDenialReasonSchema.options).toContain("authorizing_device_kind_not_allowed");
  });

  it("innrullingsforespørselen: etiketten (`device.kind`) er VALGFRI men aldri autoritet; typen kan ikke smugles inn (strict)", () => {
    const base = { tenant_id: "t", person_id: "p", enrollment: { kind: "enrollment_ticket", ticket: "x" } };
    expect(DeviceEnrollmentRequestSchema.safeParse({ ...base, device: { device_id: "d", public_key_pem: "k" } }).success).toBe(true);
    expect(DeviceEnrollmentRequestSchema.safeParse({ ...base, device: { device_id: "d", kind: "iphone", public_key_pem: "k" } }).success).toBe(true); // eldre klienter
    expect(DeviceEnrollmentRequestSchema.safeParse({ ...base, device: { device_id: "d", kind: "", public_key_pem: "k" } }).success).toBe(false);
    expect(DeviceEnrollmentRequestSchema.safeParse({ ...base, device: { device_id: "d", device_kind: "iphone", public_key_pem: "k" } }).success).toBe(false);
    expect(DeviceEnrollmentRequestSchema.safeParse({ ...base, device_kind: "iphone", device: { device_id: "d", public_key_pem: "k" } }).success).toBe(false);
    expect(DeviceEnrollmentRequestSchema.safeParse({ ...base, enrollment: { kind: "enrollment_ticket", ticket: "x", device_kind: "iphone" }, device: { device_id: "d", public_key_pem: "k" } }).success).toBe(false);
  });
});
