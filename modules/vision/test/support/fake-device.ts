import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { captureSigningBytes, type CaptureDeviceRegistry, type SignedCaptureUpload } from "../../src/capture.ts";

/**
 * WP-G3 (D-465), P2d: en FAKE iPhone for testene - følger nøyaktig protokollen den ekte appen vil (Ed25519 over `captureSigningBytes`). Ligger under test/, ikke src/
 * (d396: ingen Fake*-klasser i produksjonsflaten).
 */
export class FakeDevice {
  readonly publicKey: KeyObject;
  private readonly privateKey: KeyObject;

  constructor(
    readonly deviceId: string,
    readonly tenantId: string,
    readonly personId: string
  ) {
    const pair = generateKeyPairSync("ed25519");
    this.publicKey = pair.publicKey;
    this.privateKey = pair.privateKey;
  }

  /** Signerer en opplasting for en gitt forespørsel. `overrides` lar tester lage ugyldige varianter (annen request_id, tid, hash ...). */
  upload(
    request: { request_id: string },
    bytes: Uint8Array,
    options: { media_type?: string; issued_at?: string; sha256?: string; byte_length?: number; signAs?: FakeDevice } = {}
  ): SignedCaptureUpload {
    const sha256 = options.sha256 ?? createHash("sha256").update(bytes).digest("hex");
    const byte_length = options.byte_length ?? bytes.length;
    const media_type = options.media_type ?? "image/jpeg";
    const issued_at = options.issued_at ?? new Date().toISOString();
    const signer = options.signAs ?? this;
    const signature = sign(null, captureSigningBytes({ request_id: request.request_id, tenant_id: this.tenantId, person_id: this.personId, device_id: this.deviceId, sha256, byte_length, media_type, issued_at }), signer.privateKey);
    return { request_id: request.request_id, device_id: this.deviceId, media_type, byte_length, sha256, issued_at, signature: signature.toString("base64") };
  }
}

/** Enhetsregister for testene (samme form som `DeviceRegistry.approverFor`: revokert/ukjent enhet = undefined). */
export class TestDeviceRegistry implements CaptureDeviceRegistry {
  private readonly devices = new Map<string, FakeDevice>();
  register(device: FakeDevice): void {
    this.devices.set(`${device.tenantId}|${device.deviceId}`, device);
  }
  revoke(device: FakeDevice): void {
    this.devices.delete(`${device.tenantId}|${device.deviceId}`);
  }
  async approverFor(deviceId: string, tenantId: string): Promise<{ key: KeyObject; tenant_id: string; person_id: string } | undefined> {
    const device = this.devices.get(`${tenantId}|${deviceId}`);
    return device ? { key: device.publicKey, tenant_id: device.tenantId, person_id: device.personId } : undefined;
  }
}
