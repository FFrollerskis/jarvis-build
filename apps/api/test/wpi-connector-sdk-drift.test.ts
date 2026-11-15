import { describe, expect, it } from "vitest";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import { CONNECTOR_REGISTRY } from "@jarvis/tool-gateway";
import { CONNECTOR_API_FACTS, CONNECTOR_SYNC_JOBS, connectorViews } from "../src/control-center/integration.ts";
// Connector SDK (WP-I, D-472) er bevisst IKKE en avhengighet i apps/api (ingen kjøretidskobling); testen leser den via relativ sti.
import {
  DEFAULT_INTERNAL_CREDENTIAL_REFS, FULL_MANIFESTS, buildManifestCatalogue, claimedDefinitions, deriveSkeletonManifests, productionConnectorDefinitions, validateConnectorManifest
} from "../../../modules/connector-sdk/src/index.ts";

/**
 * WP-I (D-472): DRIFT-vakt mellom Connector SDK-ets avledning og Integrasjonssenteret (WP-H0). Begge leser samme registeret og kobler handlinger til connectorer; denne testen låser at de to
 * implementasjonene gir NØYAKTIG samme handlingsmengde for hele registeret, og at Integrasjonssenterets egne fakta (API-versjon, synk-jobber) kan mates inn i avledningen uten drift mot
 * de håndskrevne manifestene. Ingen produksjonskode er endret av WP-I; dette er en ren test.
 */
const definitions = productionConnectorDefinitions();

describe("SDK-avledningen og Integrasjonssenteret ser samme handlinger per connector", () => {
  it("claimedDefinitions() gir nøyaktig samme handlingsnøkler som connectorViews() for hver registeroppføring", () => {
    const presence = new Map<string, boolean | null>();
    for (const c of CONNECTOR_REGISTRY) for (const r of c.credential_refs) presence.set(r, true);
    const views = connectorViews(CONNECTOR_REGISTRY, definitions, presence);
    const claimed = claimedDefinitions(CONNECTOR_REGISTRY, definitions);
    expect(views.length).toBe(CONNECTOR_REGISTRY.length);
    for (const v of views) {
      const mine = (claimed.get(v.def.id) ?? []).map((d) => `${d.tool_id}.${d.action}`).sort();
      expect(mine, v.def.id).toEqual(v.action_keys);
    }
  });

  it("de interne credential-referansene i SDK-et er nøyaktig forretningskjernens (@jarvis/business)", () => {
    expect([...DEFAULT_INTERNAL_CREDENTIAL_REFS]).toEqual([BUSINESS_INTERNAL_CREDENTIAL_REF]);
  });
});

describe("Integrasjonssenterets fakta kan mates inn i avledningen", () => {
  it("API-versjonen og synk-jobbene fra senteret havner i skeletonene, og alle skeletons er fortsatt gyldige", () => {
    const skeletons = deriveSkeletonManifests({ definitions, apiFacts: CONNECTOR_API_FACTS, syncJobs: CONNECTOR_SYNC_JOBS });
    for (const m of skeletons) {
      expect(validateConnectorManifest(m).issues, m.identity.id).toEqual([]);
      const fact = CONNECTOR_API_FACTS[m.identity.id];
      if (fact !== undefined) expect(m.identity.version.provider_api, m.identity.id).toBe(fact.api_version);
      const jobs = CONNECTOR_SYNC_JOBS[m.identity.id];
      const sync = m.capabilities.sync;
      if (jobs !== undefined && !("unknown" in sync)) expect(sync.items, m.identity.id).toEqual([...jobs]);
    }
  });

  it("de håndskrevne referansemanifestene har ingen drift mot registeret OG Integrasjonssenterets fakta", () => {
    const cat = buildManifestCatalogue({ definitions, authored: FULL_MANIFESTS, apiFacts: CONNECTOR_API_FACTS, syncJobs: CONNECTOR_SYNC_JOBS });
    expect(cat.orphans).toEqual([]);
    for (const e of cat.entries) expect(e.drift, e.connector_id).toEqual([]);
  });
});
