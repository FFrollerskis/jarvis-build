import { describe, expect, it } from "vitest";
import { DeviceEnrollmentRequestSchema, deviceKindFromLegacyLabel } from "../src/index.ts";

/**
 * WP-S1 fiks-runde 1, A-M1 (DoS): `deviceKindFromLegacyLabel` trimmet etiketten med `label.replace(/^ +| +$/g, "")`, som er KVADRATISK for en etikett som `x` + 80 000 mellomrom + `y` (hver startposisjon skanner resten av
 * mellomrommene for `$` og backtracker). `device.kind` i innrullingsforespørselen var uten lengdegrense (kun JSON-kroppens 64 KiB), og kallet skjedde inne i innrullingstransaksjonen mens radlåsene var holdt: én gyldig
 * enhetsnøkkel kunne dermed blokkere event-loopen i flere sekunder per forespørsel. Lukket tre ganger: lineær trim (aldri en regex over rå klienttekst), `.max(256)` i kontrakten, og beregningen flyttet etter regel R-B.
 *
 * Måletidene er bevisst romslige (50 ms mot ca. 2 600 ms for den kvadratiske regex-en på 80 000 tegn, og under 1 ms for den lineære løkken), så testen er stabil på en belastet maskin og likevel feller regresjonen.
 */
const N = 80_000;
const BUDGET_MS = 50;

function elapsedMs(run: () => void): number {
  const started = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

const HOSTILE: ReadonlyArray<[string, string]> = [
  ["x + mellomrom + y (kvadratisk i regex-en)", "x" + " ".repeat(N) + "y"],
  ["mellomrom + x + mellomrom + y", " ".repeat(N / 2) + "x" + " ".repeat(N / 2) + "y"],
  ["web + mellomrom + x (kjent navn, men ikke i endene)", "web" + " ".repeat(N) + "x"],
  ["x + mellomrom (kun etterfølgende)", "x" + " ".repeat(N)],
  ["kun mellomrom", " ".repeat(N)],
  ["mellomrom + web + mellomrom (kjent navn, trimmes)", " ".repeat(N) + "web" + " ".repeat(N)],
  ["gjentatt mønster x + 2 mellomrom", "x  ".repeat(N / 3) + "y"]
];

describe("A-M1: deviceKindFromLegacyLabel er LINEÆR (ingen kvadratisk regex over klienttekst)", () => {
  for (const [name, label] of HOSTILE) {
    it(`${name}: under ${BUDGET_MS} ms for ${label.length} tegn`, () => {
      deviceKindFromLegacyLabel("warmup"); // første kall kompilerer funksjonen; det er ikke det vi måler
      expect(elapsedMs(() => deviceKindFromLegacyLabel(label))).toBeLessThan(BUDGET_MS);
    });
  }

  it("dobbel lengde (160 000 tegn) er fortsatt under taket: en kvadratisk regex bruker her ca. 10 sekunder, en lineær løkke mikrosekunder", () => {
    // ett kall (ikke best-av-flere): den kvadratiske varianten skal ikke få gjentatte forsøk som koster minutter før testen feiler
    expect(elapsedMs(() => deviceKindFromLegacyLabel("x" + " ".repeat(160_000) + "y"))).toBeLessThan(BUDGET_MS);
  });

  it("trimmingen er uendret i betydning: kun vanlige mellomrom i endene fjernes, resultatet er det samme som før", () => {
    expect(deviceKindFromLegacyLabel("web" + " ".repeat(N))).toEqual({ device_kind: "web_browser", mapped: true });
    expect(deviceKindFromLegacyLabel(" ".repeat(N) + "WATCH" + " ".repeat(N))).toEqual({ device_kind: "watch", mapped: true });
    expect(deviceKindFromLegacyLabel(" ".repeat(N))).toEqual({ device_kind: "legacy_unknown", mapped: false });
    expect(deviceKindFromLegacyLabel("web" + " ".repeat(N) + "x")).toEqual({ device_kind: "legacy_unknown", mapped: false });
    // tabulator, linjeskift og ikke-brytende mellomrom trimmes IKKE (samme som `btrim` i migrasjon 149)
    for (const edge of ["\t", "\n", "\r", String.fromCodePoint(0xa0), String.fromCodePoint(0x3000), String.fromCodePoint(0x200b)]) {
      expect(deviceKindFromLegacyLabel(`${edge}web`), JSON.stringify(edge)).toEqual({ device_kind: "legacy_unknown", mapped: false });
      expect(deviceKindFromLegacyLabel(`web${edge}`), JSON.stringify(edge)).toEqual({ device_kind: "legacy_unknown", mapped: false });
      expect(deviceKindFromLegacyLabel(` ${edge} web`), JSON.stringify(edge)).toEqual({ device_kind: "legacy_unknown", mapped: false });
    }
    // grensen på 32 tegn etter trimming
    expect(deviceKindFromLegacyLabel("a".repeat(32)).mapped).toBe(false);
    expect(deviceKindFromLegacyLabel(` ${"a".repeat(33)} `)).toEqual({ device_kind: "legacy_unknown", mapped: false });
  });
});

describe("A-M1: `device.kind` i innrullingsforespørselen har en øvre grense (256), og en avvist verdi koster ingenting", () => {
  const request = (kind: string): unknown => ({
    tenant_id: "t", person_id: "p", device: { device_id: "d", kind, public_key_pem: "k" }, enrollment: { kind: "enrollment_ticket", ticket: "x" }
  });

  it("256 tegn er tillatt, 257 er avvist; 80 000 mellomrom er avvist av kontrakten (ingen videre behandling)", () => {
    expect(DeviceEnrollmentRequestSchema.safeParse(request("x".repeat(256))).success).toBe(true);
    expect(DeviceEnrollmentRequestSchema.safeParse(request("x".repeat(257))).success).toBe(false);
    expect(DeviceEnrollmentRequestSchema.safeParse(request(" ".repeat(256))).success).toBe(true);
    const hostile = request("x" + " ".repeat(N) + "y");
    let success = true;
    expect(elapsedMs(() => { success = DeviceEnrollmentRequestSchema.safeParse(hostile).success; })).toBeLessThan(BUDGET_MS);
    expect(success).toBe(false);
  });

  it("den eksisterende grensen er uendret: tom etikett er fortsatt avvist, utelatt etikett er fortsatt tillatt, vanlige verdier er tillatt", () => {
    expect(DeviceEnrollmentRequestSchema.safeParse(request("")).success).toBe(false);
    expect(DeviceEnrollmentRequestSchema.safeParse({ ...(request("web") as object), device: { device_id: "d", public_key_pem: "k" } }).success).toBe(true);
    for (const ok of ["web", "iphone", "watch", "service", "voice", "phone", "desktop-agent"]) expect(DeviceEnrollmentRequestSchema.safeParse(request(ok)).success, ok).toBe(true);
  });
});
