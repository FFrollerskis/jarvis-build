import type { MemorySpaceAuthority } from "@jarvis/contracts";

/**
 * WP-V2 (K4): sesjonens rutingkontekst, gitt til STT/TTS-adaptere som VALGFRITT siste argument.
 *
 * Sesjonen avgjør rutingporten (`evaluateSpeechRouting`) ÉN gang for adapterens egen `processor` (D-122). En failover-adapter
 * (`failover.ts`) har i tillegg en RESERVE-behandler som sesjonen ikke kjenner til - den må dømmes mot den samme sesjonens
 * memory space og tillitsnivå FØR reserven noen gang får tekst/lyd. Derfor sendes konteksten med hvert kall i stedet for å
 * lagres i adapteren (adapterne er delt mellom sesjoner og skal forbli tilstandsløse med hensyn til hvem som ringer).
 *
 * Enkle adaptere ignorerer argumentet. Mangler konteksten (kall utenfor en sesjon), tillater failover-adapteren KUN en lokal
 * reserve (fail-closed).
 */
export interface SpeechCallContext {
  readonly memorySpace: string;
  readonly authority: MemorySpaceAuthority;
}
