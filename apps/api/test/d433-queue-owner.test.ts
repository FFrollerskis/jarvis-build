import { describe, expect, it } from "vitest";
import { executiveQueueOwner } from "../src/queue-owner.ts";

/** D-433 (JARVIS-025, valg B): worker-containeren eier `executive`-køen; kun den eksakte strengen `true` flytter eierskapet til API-et. */
describe("D-433: eier av executive-køen", () => {
  it("standard er worker; kun nøyaktig «true» gir api (ingen to eiere ved skrivefeil)", () => {
    expect(executiveQueueOwner({})).toBe("worker");
    expect(executiveQueueOwner({ JARVIS_API_DRAINS_EXECUTIVE: "" })).toBe("worker");
    expect(executiveQueueOwner({ JARVIS_API_DRAINS_EXECUTIVE: "false" })).toBe("worker");
    for (const v of ["1", "yes", "True", "TRUE", " true", "true "]) expect(executiveQueueOwner({ JARVIS_API_DRAINS_EXECUTIVE: v }), v).toBe("worker");
    expect(executiveQueueOwner({ JARVIS_API_DRAINS_EXECUTIVE: "true" })).toBe("api");
  });
});
