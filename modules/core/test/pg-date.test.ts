import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { pgDateToIsoDate } from "../src/db/pg-date.ts";

/**
 * HOST FIX #2 (D-76): UA-4 Growth Core's host acceptance failed on
 * Tobias's real (non-UTC) host because `new Date(pgDateValue)
 * .toISOString().slice(0, 10)` shifts the calendar date backward by one
 * day whenever the local timezone offset is not UTC+0 - pg-types
 * constructs `date` columns via `new Date(year, month, day)` (LOCAL
 * time), so converting that back to UTC via `.toISOString()` is lossy.
 * `pgDateToIsoDate()` must reverse the SAME local construction pg-types
 * used, regardless of the process's timezone.
 */
describe("A: pgDateToIsoDate - roundtrips a pg-types-constructed local Date correctly", () => {
  it("returns the same calendar date pg-types constructed the Date object from", () => {
    expect(pgDateToIsoDate(new Date(2026, 0, 10))).toBe("2026-01-10");
  });
  it("zero-pads single-digit month and day", () => {
    expect(pgDateToIsoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
  it("handles a late-year date (December, potential month-index off-by-one)", () => {
    expect(pgDateToIsoDate(new Date(2025, 11, 31))).toBe("2025-12-31");
  });
});

describe("B: pgDateToIsoDate - string passthrough (defensive)", () => {
  it("slices an already-ISO-prefixed string to just the date part", () => {
    expect(pgDateToIsoDate("2026-01-10")).toBe("2026-01-10");
    expect(pgDateToIsoDate("2026-01-10T00:00:00.000Z")).toBe("2026-01-10");
  });
});

describe("C: reproduces and proves the fix for the real host bug (non-UTC timezone)", () => {
  it("the OLD buggy pattern (toISOString().slice(0,10)) shifts the date backward in a non-UTC timezone", () => {
    const buggyOutput = execFileSync(
      process.execPath,
      ["-e", "console.log(new Date(2026, 0, 10).toISOString().slice(0, 10))"],
      { env: { ...process.env, TZ: "Europe/Oslo" }, encoding: "utf-8" }
    ).trim();
    // This is the exact defect: pg-types constructs 2026-01-10 LOCAL, but
    // .toISOString() converts to UTC first - in UTC+1 that rolls back to
    // 2026-01-09, which is why the real host (non-UTC) failed while the
    // UTC CI/sandbox environment did not.
    expect(buggyOutput).toBe("2026-01-09");
  });
  it("pgDateToIsoDate is immune to the same timezone shift", () => {
    const fixedOutput = execFileSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "-e",
        `import { pgDateToIsoDate } from "${new URL("../src/db/pg-date.ts", import.meta.url).pathname}";
         console.log(pgDateToIsoDate(new Date(2026, 0, 10)));`
      ],
      { env: { ...process.env, TZ: "Europe/Oslo" }, encoding: "utf-8" }
    ).trim();
    expect(fixedOutput).toBe("2026-01-10");
  });
});
