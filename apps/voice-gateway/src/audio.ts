/** PCM16 mono-lydrammer (20 ms rammer i piloten). */
export interface AudioFrame {
  /** PCM16LE-bytes. */
  data: Buffer;
  /** Ankomsttid i gatewayen (ms, monotonic via Date.now for pilotens formål). */
  at: number;
}

/** RMS-energi for VAD (0..1 normalisert mot int16-max). */
export function rmsEnergy(frame: Buffer): number {
  if (frame.length < 2) {
    return 0;
  }
  let sum = 0;
  const samples = Math.floor(frame.length / 2);
  for (let i = 0; i < samples; i++) {
    const s = frame.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

/**
 * AEC/støyreduksjon: pipeline-hooks (VOICE_ARCHITECTURE §3). I piloten er de
 * passthrough - reell AEC/NS skjer på satellitt/klient-maskinvare eller i
 * WebRTC-stacken som velges i stop/go-porten. Grensesnittet sikrer at
 * kjeden er klar uten arkitekturendring.
 */
export interface AudioFilter {
  process(frame: Buffer): Buffer;
}

export class PassthroughAec implements AudioFilter {
  process(frame: Buffer): Buffer {
    return frame;
  }
}

export class PassthroughNoiseSuppressor implements AudioFilter {
  process(frame: Buffer): Buffer {
    return frame;
  }
}
