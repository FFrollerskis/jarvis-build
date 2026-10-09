import { describe, expect, it } from "vitest";
import { OwnerControlsService } from "../src/service.ts";

/**
 * WP-H0, gjennomgang av PR #316 (L-5): `OwnerControlsService.freezeConnector` validerer målet FØR det skrives, når en validator er koblet inn - og skriver ingenting når målet avvises.
 * Å gjenoppta (`unfreezeConnector`) valideres aldri: et gammelt, ugyldig mål skal alltid kunne ryddes bort.
 */
function fixture(validator?: (target: string) => string | null) {
  const writes: string[] = [];
  const ownerControls = {
    freezeConnectorDurable: async (id: string) => { writes.push(`freeze:${id}`); },
    unfreezeConnectorDurable: async (id: string) => { writes.push(`unfreeze:${id}`); }
  };
  const service = new OwnerControlsService({} as never, ownerControls as never, undefined, validator ? { freezeTargetValidator: validator } : {});
  return { service, writes };
}
const onlyKnown = (target: string): string | null => (target.startsWith("model:") && target !== "model:anthropic" ? `unknown_model_provider:${target.slice(6)}` : null);

describe("freezeConnector med validator", () => {
  it("et ugyldig mål kaster med feilkoden og skriver ingenting", async () => {
    const { service, writes } = fixture(onlyKnown);
    await expect(service.freezeConnector("model:Anthropic", "x", "person-owner")).rejects.toThrow("unknown_model_provider:Anthropic");
    expect(writes).toEqual([]);
  });

  it("et gyldig mål og et vanlig verktøy skrives som før", async () => {
    const { service, writes } = fixture(onlyKnown);
    await service.freezeConnector("model:anthropic", "x", "person-owner");
    await service.freezeConnector("github", "x", "person-owner");
    expect(writes).toEqual(["freeze:model:anthropic", "freeze:github"]);
  });

  it("gjenopptak valideres aldri (et gammelt ugyldig mål kan ryddes bort)", async () => {
    const { service, writes } = fixture(onlyKnown);
    await service.unfreezeConnector("model:Anthropic", "person-owner");
    expect(writes).toEqual(["unfreeze:model:Anthropic"]);
  });

  it("uten validator er oppførselen uendret (eksisterende konstruksjoner og skript)", async () => {
    const { service, writes } = fixture();
    await service.freezeConnector("model:Anthropic", "x", "person-owner");
    expect(writes).toEqual(["freeze:model:Anthropic"]);
  });
});
