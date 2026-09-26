import { readdir, readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maybeDumpAudioForDebug } from "../src/debug-audio-dump.ts";

/**
 * D-279: `maybeDumpAudioForDebug()` er den ENESTE, eksplisitt Tobias-
 * autoriserte veien rå lyd noensinne kan treffe disk i denne kodebasen -
 * denne suiten beviser BEGGE halvdelene av den kontrakten: (1) AV som
 * standard (usatt miljøvariabel = garantert null disk-aktivitet), og
 * (2) når PÅ, skrives EKSAKT de bytene som ble gitt inn, ingen andre steder.
 */
describe("D-279: maybeDumpAudioForDebug() - opt-in-only, av som standard", () => {
  const envKey = "JARVIS_VOICE_DEBUG_DUMP_DIR";
  const originalValue = process.env[envKey];
  let dir: string;

  beforeEach(async () => {
    delete process.env[envKey];
    dir = await mkdtemp(join(tmpdir(), "jarvis-voice-debug-dump-test-"));
  });

  afterEach(async () => {
    if (originalValue === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalValue;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("er en ren no-op når JARVIS_VOICE_DEBUG_DUMP_DIR er usatt (produksjons-default)", async () => {
    const result = await maybeDumpAudioForDebug(Buffer.from("fake-wav-bytes"));
    expect(result).toBeUndefined();
    // Ingen fil skal ha dukket opp noe sted i den tomme testmappen.
    expect(await readdir(dir)).toEqual([]);
  });

  it("skriver de EKSAKTE bytene til JARVIS_VOICE_DEBUG_DUMP_DIR når satt, og returnerer stien", async () => {
    process.env[envKey] = dir;
    const wav = Buffer.from("fake-wav-bytes-for-real-write-test");
    const path = await maybeDumpAudioForDebug(wav);
    expect(path).toBeDefined();
    expect(path).toContain(dir);
    expect(path).toMatch(/voice-debug-\d+\.wav$/);
    const written = await readFile(path!);
    expect(written.equals(wav)).toBe(true);
  });

  it("oppretter målmappen hvis den ikke finnes ennå (recursive mkdir)", async () => {
    process.env[envKey] = join(dir, "nested", "does-not-exist-yet");
    const path = await maybeDumpAudioForDebug(Buffer.from("x"));
    expect(path).toBeDefined();
    const written = await readFile(path!);
    expect(written.toString()).toBe("x");
  });
});
