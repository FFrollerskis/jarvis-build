import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGitHubAuth, type GitHubAuth, type SecretProvider } from "@jarvis/tool-gateway";
import { assessCredential } from "../src/evolution/credentials.ts";

/**
 * WP-C3 (Q-45 b): Evolution EV-17 (`assessCredential`, rene funksjoner) kan vurdere GitHub-credentialen direkte fra `GitHubAuth.credentialFacts()`
 * - «kortlevd repo-scopet identitet: ja/nei» - uten at `evolution/credentials.ts` er endret. HTTP er stubbet (ingen nettkall).
 */

const NOW = new Date("2026-10-09T12:00:00Z");
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const REPO = "tsworkflow/jarvisbuild";
// Fikstur-verdier bygges dynamisk, slik at hemmelighetsskannere ikke tar dem for ekte tokens.
const PAT_VALUE = ["fixture", "pat", "not", "real", "0123456789"].join("-");
const INSTALLATION_TOKEN = ["ghs", "FakeInstallationTokenForTest0123456789"].join("_");

function secrets(values: Record<string, string>): SecretProvider {
  return { name: "map", get: async (ref) => values[ref] ?? null };
}

function appAuth(options: { permissions: Record<string, string>; status?: number; env?: Record<string, string> }): GitHubAuth {
  return createGitHubAuth({
    secrets: secrets({ JARVIS_GITHUB_APP_PRIVATE_KEY: PEM, JARVIS_GITHUB_TOKEN: PAT_VALUE }),
    env: { JARVIS_GITHUB_APP_ID: "123456", JARVIS_GITHUB_APP_INSTALLATION_ID: "42", JARVIS_GITHUB_REPO: REPO, ...options.env },
    now: () => NOW.getTime(), sleep: async () => undefined, maxAttempts: 1, log: () => undefined,
    http: async () => new Response(
      options.status && options.status >= 400
        ? JSON.stringify({ message: "nei" })
        : JSON.stringify({
            token: INSTALLATION_TOKEN, expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
            permissions: options.permissions, repository_selection: "selected", repositories: [{ id: 1, name: "jarvisbuild", full_name: REPO }]
          }),
      { status: options.status ?? 201, headers: { date: NOW.toUTCString() } }
    )
  });
}

const FULL = { metadata: "read", contents: "write", pull_requests: "write", issues: "write", actions: "write" };

describe("WP-C3 x EV-17: assessCredential på GitHub-credentialen", () => {
  it("A: full D-41-kapabilitet + kortlevd token -> ingen scope-mangel, auto-fornyelse innen scope er lov (H1), ingen eier-handling", async () => {
    const auth = appAuth({ permissions: FULL });
    await auth.secretProvider(secrets({ JARVIS_GITHUB_APP_PRIVATE_KEY: PEM })).get("JARVIS_GITHUB_TOKEN");
    const facts = auth.credentialFacts();
    expect(facts).toMatchObject({ kind: "short_lived_token", short_lived: true, repo_scoped: true });
    const verdict = assessCredential(facts, NOW);
    expect(verdict.health).toBe("expiring_soon"); // 1 time < standard 24 t-terskel; fornyes automatisk
    expect(verdict.auto_action).toBe("refresh_in_scope");
    expect(verdict.needs).toBe("none");
    expect(verdict.reasons).toEqual([]);
  });

  it("B: installasjonen mangler Actions: write -> scope_shortfall + menneskelig/ekstern port (D-41: manglende kapabilitet er synlig, ikke en overraskende 403)", async () => {
    const auth = appAuth({ permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write", actions: "read" } });
    await auth.secretProvider(secrets({ JARVIS_GITHUB_APP_PRIVATE_KEY: PEM })).get("JARVIS_GITHUB_TOKEN");
    const verdict = assessCredential(auth.credentialFacts(), NOW);
    expect(verdict.health).toBe("scope_shortfall");
    expect(verdict.needs).toBe("human_external_gate");
    expect(verdict.reasons).toEqual(["missing_scopes:actions:write"]);
  });

  it("C: utstedelse feiler -> refresh_failing med eier-varsel (ikke OAuth, så ikke ekstern port); aldri en stille «ok»", async () => {
    const auth = appAuth({ permissions: FULL, status: 401 });
    await auth.secretProvider(secrets({ JARVIS_GITHUB_APP_PRIVATE_KEY: PEM })).get("JARVIS_GITHUB_TOKEN");
    const facts = auth.credentialFacts();
    expect(facts.last_refresh_ok).toBe(false);
    const verdict = assessCredential(facts, NOW);
    expect(verdict.health).toBe("refresh_failing");
    expect(verdict.needs).toBe("owner_alert");
  });

  it("D: PAT-modus rapporteres ærlig som ikke-kortlevd og ikke-scopet (kind api_key; scopes ukjente -> ingen påstått mangel)", () => {
    const auth = createGitHubAuth({ secrets: secrets({ JARVIS_GITHUB_TOKEN: "pat" }), env: {}, log: () => undefined });
    const facts = auth.credentialFacts();
    expect(facts).toMatchObject({ kind: "api_key", short_lived: false, repo_scoped: false, auth_method: "pat", expires_at: null });
    expect(assessCredential(facts, NOW)).toMatchObject({ health: "ok", needs: "none" });
  });

  it("E: aktiv PAT-fallback i App-modus rapporteres som api_key uten utløp (ikke som kortlevd repo-scopet identitet)", async () => {
    const auth = appAuth({ permissions: FULL, status: 403, env: { JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK: "true" } });
    expect(await auth.secretProvider(secrets({ JARVIS_GITHUB_TOKEN: PAT_VALUE })).get("JARVIS_GITHUB_TOKEN")).toBe(PAT_VALUE);
    const facts = auth.credentialFacts();
    expect(facts).toMatchObject({ kind: "api_key", short_lived: false, repo_scoped: false, expires_at: null });
  });
});
