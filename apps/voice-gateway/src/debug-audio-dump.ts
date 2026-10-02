import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * D-279 (Tobias sitt EKSPLISITTE samtykke i chat, 2026-09-26, som direkte
 * svar på et spørsmål jeg stilte ham FØR denne filen ble skrevet - se D-279 i
 * DECISIONS_AND_ASSUMPTIONS.md for hele begrunnelsen/samtalen): en
 * kontrollert, ENESTE, eksplisitt autorisert UNNTAK fra §22-invarianten
 * (`test/d30-foundation.test.ts` "Personvern: rå lyd persisteres aldri" -
 * `session.ts`/`stt.ts`/`tts.ts`/`chunker.ts`/`vad.ts`/`audio.ts`/
 * `server.ts`/`health.ts` forbys STATISK å inneholde noen disk-skrive-API).
 * Etter at D-262→D-278 (17 poster) individuelt utelukket HVER ENESTE
 * kildekode-testbar hypotese for hvorfor talegjenkjenning konsekvent
 * returnerer tomt resultat, er FAKTISK Å INSPISERE en fanget lydfil den
 * eneste gjenværende diagnostikk-metoden - noe som krever at rå lyd
 * MIDLERTIDIG treffer disk, ETT klipp om gangen, KUN når Tobias selv
 * eksplisitt slår det på.
 *
 * DISIPLIN (hvorfor dette IKKE svekker §22 sitt formål):
 *   - Denne filen er BEVISST atskilt fra HELE resten av talekjeden (ikke i
 *     §22-testens filliste) - `stt.ts` selv inneholder FORTSATT ingen
 *     disk-skrive-API, kaller kun denne funksjonen eksplisitt.
 *   - AV SOM STANDARD: `JARVIS_VOICE_DEBUG_DUMP_DIR` er usatt i produksjon -
 *     usatt = denne funksjonen er en ren no-op, GARANTERT null disk-aktivitet
 *     (verifisert i `test/debug-audio-dump.test.ts`).
 *   - Krever et EKSPLISITT, ikke-standard miljøvariabel-navn Tobias selv må
 *     sette på sin egen NAS - kan ALDRI aktiveres ved et uhell fra kode alene.
 *   - Skriver KUN når STT-resultatet faktisk er TOMT (samme betingelse som
 *     den eksisterende `voice_stt_empty_result_diagnostic`-loggingen i
 *     `stt.ts`) - dumper aldri vellykkede transkripsjoner, kun akkurat den
 *     kategorien klipp Tobias selv ba om å få inspisere.
 *   - Filen forblir LOKAL på Tobias sin egen NAS - denne koden sender den
 *     ALDRI videre noe sted (ingen nettverkskall her i det hele tatt).
 *   - Ment som et MIDLERTIDIG diagnostikk-verktøy for DENNE spesifikke
 *     undersøkelsen - fjernes igjen når rotårsaken er funnet (se D-279).
 */
/**
 * REMEDIERING DEL 1 (JARVIS-080): dumpen er AV som standard også når en gammel
 * `.env` fortsatt har `JARVIS_VOICE_DEBUG_DUMP_DIR` satt (den lå i produksjons-
 * `.env` etter D-279/D-280, og `/status` sa likevel `audio_persistence: "none"`).
 * Rå lyd kan nå KUN lagres når BÅDE mappen OG dette eksplisitte samtykket er
 * satt - og `/status` rapporterer det ærlig (se `debugDumpEnabled()`).
 */
export const DEBUG_DUMP_CONSENT_VALUE = "I_ACCEPT_RAW_AUDIO_ON_DISK";

export function debugDumpEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const dir = env["JARVIS_VOICE_DEBUG_DUMP_DIR"];
  return Boolean(dir) && env["JARVIS_VOICE_DEBUG_DUMP_CONSENT"] === DEBUG_DUMP_CONSENT_VALUE;
}

export async function maybeDumpAudioForDebug(wav: Buffer): Promise<string | undefined> {
  const dir = process.env["JARVIS_VOICE_DEBUG_DUMP_DIR"];
  if (!dir || !debugDumpEnabled()) {
    return undefined;
  }
  await mkdir(dir, { recursive: true });
  const path = join(dir, `voice-debug-${Date.now()}.wav`);
  await writeFile(path, wav);
  return path;
}
