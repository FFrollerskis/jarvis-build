import { describe, expect, it } from "vitest";
import { computeStateDiff } from "../src/diff.ts";

describe("D-105 §I: computeStateDiff (deterministisk, grunn nøkkel-for-nøkkel)", () => {
  it("A: identiske objekter gir tomme added/removed/changed", () => {
    const diff = computeStateDiff({ a: 1, b: "x" }, { a: 1, b: "x" });
    expect(diff).toEqual({ added: {}, removed: {}, changed: {} });
  });

  it("B: nye nøkler i after registreres som added", () => {
    const diff = computeStateDiff({ a: 1 }, { a: 1, b: 2 });
    expect(diff).toEqual({ added: { b: 2 }, removed: {}, changed: {} });
  });

  it("C: fjernede nøkler fra before registreres som removed", () => {
    const diff = computeStateDiff({ a: 1, b: 2 }, { a: 1 });
    expect(diff).toEqual({ added: {}, removed: { b: 2 }, changed: {} });
  });

  it("D: endrede verdier registreres som changed med FAKTISK before/after-par", () => {
    const diff = computeStateDiff({ image: "alpine:3.19" }, { image: "alpine:3.20" });
    expect(diff).toEqual({ added: {}, removed: {}, changed: { image: { before: "alpine:3.19", after: "alpine:3.20" } } });
  });

  it("E: null before -> null (ALDRI et fabrikkert diff)", () => {
    expect(computeStateDiff(null, { a: 1 })).toBeNull();
  });

  it("F: null after -> null", () => {
    expect(computeStateDiff({ a: 1 }, null)).toBeNull();
  });

  it("G: array-verdier (ikke et objekt) -> null (ikke sammenlignbart under denne grunne modellen)", () => {
    expect(computeStateDiff([1, 2], [1, 2, 3])).toBeNull();
  });

  it("H: begge null -> null", () => {
    expect(computeStateDiff(null, null)).toBeNull();
  });
});
