import type { HealthMetricSource, HealthMetricSourceFetchOptions, HealthObservationInput } from "./types.ts";

/**
 * Test-dobbel for `HealthMetricSource` (samme "Fake*"-mønster som
 * `FakeTransport` i `modules/tool-gateway/src/integrations.ts`). IKKE en
 * ekte Apple Health-adapter - dette miljøet har verken en fysisk iPhone
 * eller en Apple Health-entitlement, og denne klassen later IKKE som den
 * snakker med noen ekte leverandør-kjøretid. Formålet er UTELUKKENDE å
 * bevise at `HealthService.ingestFromSource()` faktisk komponerer mot den
 * provider-nøytrale `HealthMetricSource`-kontrakten ende-til-ende (§
 * byggeordren, akseptansekriterium H) - en fremtidig, EKTE adapter
 * implementerer AKKURAT samme grensesnitt uten å røre `HealthService`.
 */
export class FakeHealthMetricSource implements HealthMetricSource {
  readonly name: string;
  calls: HealthMetricSourceFetchOptions[] = [];

  constructor(
    private readonly observations: HealthObservationInput[] = [],
    name = "fake"
  ) {
    this.name = name;
  }

  async fetchRecent(options: HealthMetricSourceFetchOptions): Promise<HealthObservationInput[]> {
    this.calls.push(options);
    if (options.sinceMs === undefined) {
      return [...this.observations];
    }
    return this.observations.filter((o) => new Date(o.observed_at).getTime() >= (options.sinceMs as number));
  }
}
