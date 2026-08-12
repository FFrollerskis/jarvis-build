import type { KeyObject } from "node:crypto";

/**
 * Register over godkjenningsenheter og deres offentlige nøkler.
 * Fase 1: in-memory med testnøkler. Persistent register kommer i fase 2;
 * enhetsnøkler genereres da på enheten (Secure Enclave i fase 8).
 */
export interface DeviceRegistry {
  publicKeyFor(deviceId: string): KeyObject | undefined;
}

export class InMemoryDeviceRegistry implements DeviceRegistry {
  private readonly keys = new Map<string, KeyObject>();

  register(deviceId: string, publicKey: KeyObject): void {
    this.keys.set(deviceId, publicKey);
  }

  publicKeyFor(deviceId: string): KeyObject | undefined {
    return this.keys.get(deviceId);
  }
}
