import { createFakeConnector, type ContractAdapter, type FakeConnectorSpec } from "../../src/testing.ts";
import { GITHUB_MANIFEST } from "../../src/manifests/github.ts";

/**
 * WP-I (D-472): FAKE-adapter for GitHub-referansemanifestet (ingen nettverk, ingen ekte GitHub). Resten av handlingene bruker harnessens generiske ressursmodell; her er bare det som er GitHub-spesifikt:
 * issues-lesingen siterer tredjepartstekst (tittelen) fra leverandøren, og `merge_pr` er irreversibel (ingen automatisk rollback - en revert-PR er en NY handling).
 */
export function createGithubFake(opts: Partial<Omit<FakeConnectorSpec, "manifest">> = {}): ContractAdapter {
  return createFakeConnector({
    manifest: GITHUB_MANIFEST,
    handlers: {
      "github.read_issues": {
        read: (_params, _state, ctx) => ({ issues: [{ number: 1, title: ctx.providerText === null ? "sample issue" : ctx.redact(ctx.providerText), state: "open" }] }),
        sample: { repo: "owner/sandbox-repo" }
      },
      "github.merge_pr": {
        run: (params, state, n) => {
          state.resources[`pr:${String(params["pr_number"])}`] = { merged: true, merge_commit: `sha-${n}` };
          return { data: { merged: true }, external_id: `merge-${n}` };
        },
        readback: (params, state) => state.resources[`pr:${String(params["pr_number"])}`] ?? { merged: false }
      }
    },
    ...opts
  });
}
