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
 *
 * D-275 (Tobias direkte live-test, ETTER at D-274 kildekode-verifiserte HVER
 * lag nedstrøms for VAD-en som korrekt - WAV-header/stdin/modell/NAS-miljø):
 * bedt om å si ÉN sammenhengende, 4-5 sekunders norsk setning ga en logg som
 * viste RASK, GJENTATT `speech_start`/`end_of_turn`-VEKSLING flere ganger i
 * sekundet gjennom HELE ytringen, i stedet for ÉN sammenhengende tur - kun
 * korte 0,5-2,3 sekunders fragmenter ble noensinne fanget, ALDRI hele
 * setningen. Rotårsak: klienten sender ~256ms lydrammer
 * (`ScriptProcessorNode(4096, ...)` @ 16kHz i `voice.html`), mens den
 * FORRIGE `hangoverMs`-verdien (300) var kun ~1,17 rammer - enhver naturlig,
 * kortvarig energidipp MELLOM ord (en stille konsonant, en pause for pust,
 * en stavelsesgrense) er nok til å utløse `end_of_turn` FØR setningen
 * faktisk er ferdig, og splitter én sammenhengende ytring i mange spredte
 * fragmenter som individuelt mangler nok sammenhengende fonetisk innhold for
 * whisper.cpp å feste seg på - PRESIST samme symptomklasse (ekte
 * dekodingsarbeid, konsekvent tomt resultat) som HELE D-262→D-274-serien
 * observerte, nå funnet i et lag FØR selve STT-en i stedet for i den.
 * **Fiks:** `hangoverMs` økt fra 300 til 700 - trygt over typisk
 * mellomords-pause (vanligvis 50-250ms) og godt over flere rammers
 * energidipp, uten merkbar ekstra ventetid før et FAKTISK avsluttet svar
 * sendes til STT-en. `threshold` UENDRET (0,05 - ingen bevis i loggen for at
 * selve terskelnivået, i motsetning til hangover-varigheten, var problemet).
 * Se D-275 i DECISIONS_AND_ASSUMPTIONS.md.
 */
export class EnergyVad implements VadAdapter {
  private speaking = false;
  private lastSpeechAt = 0;

  constructor(
    private readonly threshold = 0.05,
    private readonly hangoverMs = 700
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
