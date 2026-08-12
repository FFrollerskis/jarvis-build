import { rmsEnergy } from "./audio.ts";

export type VadEvent = "speech_start" | "speech" | "silence" | "end_of_turn";

export interface VadAdapter {
  /** Mater én ramme; returnerer hendelsen rammen utløser. */
  push(frame: Buffer, atMs: number): VadEvent;
  reset(): void;
}

/**
 * Deterministisk energi-VAD (lokal, ingen nettverk - VOICE_ARCHITECTURE §3).
 * end_of_turn utløses etter `hangoverMs` sammenhengende stillhet etter tale.
 * Byttes mot Silero-klasse modell bak samme grensesnitt når det trengs.
 */
export class EnergyVad implements VadAdapter {
  private speaking = false;
  private lastSpeechAt = 0;

  constructor(
    private readonly threshold = 0.05,
    private readonly hangoverMs = 300
  ) {}

  push(frame: Buffer, atMs: number): VadEvent {
    const energy = rmsEnergy(frame);
    if (energy >= this.threshold) {
      const wasSpeaking = this.speaking;
      this.speaking = true;
      this.lastSpeechAt = atMs;
      return wasSpeaking ? "speech" : "speech_start";
    }
    if (this.speaking && atMs - this.lastSpeechAt >= this.hangoverMs) {
      this.speaking = false;
      return "end_of_turn";
    }
    return "silence";
  }

  reset(): void {
    this.speaking = false;
    this.lastSpeechAt = 0;
  }
}
