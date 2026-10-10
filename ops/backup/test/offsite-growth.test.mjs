import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, tempDir } from "./helpers.mjs";

/**
 * WP-C2 review runde 2 (L2): en kilde i et UBETRODDT fjernmål kan VOKSE mens den leses (en angriper med skrivetilgang legger stadig til data). Uten en øvre grense under lesingen ville kopien
 * fortsatt til disken var full, og først etter EOF ble lengden sammenlignet. Et ekte, voksende filsystem kan ikke lages deterministisk i en test, så `open` fanges for én sti og gir et
 * håndtak som sier «64 byte» (oppslaget) men leverer data uten stopp - med en sikkerhetsventil (5000 lesinger) så en mutant uten grensen avsluttes i stedet for å fylle disken.
 */
const fake = vi.hoisted(() => ({ src: null, reads: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    open: async (path, flags, mode) => {
      if (fake.src !== null && path === fake.src) {
        return {
          stat: async () => ({ isFile: () => true, size: 64 }),
          read: async (buf) => {
            fake.reads += 1;
            if (fake.reads > 5000) return { bytesRead: 0 }; // sikkerhetsventil
            buf.fill(0x41, 0, buf.length);
            if (fake.reads === 1) buf.write("age-encryption.org/v1", 0);
            return { bytesRead: buf.length };
          },
          close: async () => undefined
        };
      }
      return actual.open(path, flags, mode);
    }
  };
});
const { copyRegularNoFollow } = await import("../lib/offsite.mjs");

afterAll(cleanupTempDirs);

describe("WP-C2 off-site (review runde 2, L2): en voksende kilde avbrytes ved taket", () => {
  it("kilden gir 64 byte per lesing uten stopp: kopien avbrytes straks `maxBytes` er passert, og dest fjernes", async () => {
    const src = join(tempDir("wpc2-grow-"), "vokser.age");
    writeFileSync(src, "x");
    fake.src = src;
    fake.reads = 0;
    const dest = join(tempDir("wpc2-grow-dest-"), "kopi.age");
    await expect(copyRegularNoFollow(src, dest, { ageHeader: true, maxBytes: 1000 })).rejects.toMatchObject({ code: "offsite_ineligible", message: expect.stringContaining("vokste forbi grensen") });
    expect(fake.reads).toBeLessThan(40); // 1000 / 64 = 16 lesinger, ikke 5000
    expect(existsSync(dest)).toBe(false);
  });

  it("et tak under størrelsen oppslaget oppga avvises FØR noe leses eller opprettes (ikke først etter første blokk)", async () => {
    const src = join(tempDir("wpc2-grow-"), "stor.age");
    writeFileSync(src, "x");
    fake.src = src;
    fake.reads = 0;
    const dest = join(tempDir("wpc2-grow-dest-"), "kopi.age");
    await expect(copyRegularNoFollow(src, dest, { ageHeader: true, maxBytes: 10 })).rejects.toMatchObject({ code: "offsite_ineligible", message: expect.stringContaining("større enn grensen") });
    expect(fake.reads).toBe(0);
    expect(existsSync(dest)).toBe(false);
    fake.src = null;
  });

  it("kontroll: uten tak leser den samme kilden til sikkerhetsventilen slår inn (beviser at testoppsettet faktisk er en uendelig kilde)", async () => {
    const src = join(tempDir("wpc2-grow-"), "vokser.age");
    writeFileSync(src, "x");
    fake.src = src;
    fake.reads = 0;
    const dest = join(tempDir("wpc2-grow-dest-"), "kopi.age");
    await copyRegularNoFollow(src, dest, { ageHeader: true });
    expect(fake.reads).toBeGreaterThan(4000);
    fake.src = null;
  });
});
