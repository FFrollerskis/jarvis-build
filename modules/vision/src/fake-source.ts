import type { VisionEventSource, VisionEventSourceFetchOptions, VisionObservationInput } from "./types.ts";

/**
 * Test-dobbel for `VisionEventSource` (samme "Fake*"-mønster som
 * `FakeHealthMetricSource`/`FakeTransport`). IKKE en ekte iPhone-kamera-
 * eller Home Assistant-kamera-adapter - dette miljøet har verken fysisk
 * kameramaskinvare eller en objektklassifiseringsmodell koblet til, og
 * denne klassen later IKKE som den snakker med noen ekte leverandør-
 * kjøretid. Formålet er UTELUKKENDE å bevise at `VisionService.
 * ingestFromSource()` faktisk komponerer mot den provider-nøytrale
 * `VisionEventSource`-kontrakten ende-til-ende - en fremtidig, EKTE adapter
 * implementerer AKKURAT samme grensesnitt uten å røre `VisionService`.
 */
export class FakeVisionEventSource implements VisionEventSource {
  readonly name: string;
  calls: VisionEventSourceFetchOptions[] = [];

  constructor(
    private readonly observations: VisionObservationInput[] = [],
    name = "fake"
  ) {
    this.name = name;
  }

  async fetchRecent(options: VisionEventSourceFetchOptions): Promise<VisionObservationInput[]> {
    this.calls.push(options);
    if (options.sinceMs === undefined) {
      return [...this.observations];
    }
    return this.observations.filter((o) => new Date(o.observed_at).getTime() >= (options.sinceMs as number));
  }
}
