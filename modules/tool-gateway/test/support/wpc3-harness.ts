import { expect } from "vitest";
import { GitHubAppAuth, GitHubAppAuthError, type GitHubAppAuthOptions, type GitHubAuthLogEvent } from "../../src/github-app-auth.ts";
import { FakeGitHubApp, testKeys } from "./fake-github-app.ts";

/**
 * WP-C3 (review nr. 1): felles testoppsett for rettelsene etter den uavhengige sikkerhetsreviewen. Samme mønster som `harness()` i
 * `wpc3-github-app-auth.test.ts` (lokal fake GitHub på 127.0.0.1, injisert klokke og sleep) - delt her fordi flere testfiler trenger det.
 */

export const APP_ID = "123456";
export const INSTALLATION_ID = "9876543";
export const REPO = "tsworkflow/jarvisbuild";
export const OTHER_REPO = "tsworkflow/other-repo";
export const T0 = Date.parse("2026-10-09T12:00:00Z");
export const keys = testKeys();

const servers: FakeGitHubApp[] = [];

export async function stopFakeServers(): Promise<void> {
  while (servers.length > 0) await servers.pop()?.stop();
}

export interface Harness {
  readonly fake: FakeGitHubApp;
  readonly clock: { t: number };
  readonly sleeps: number[];
  readonly logs: GitHubAuthLogEvent[];
  readonly auth: GitHubAppAuth;
}

export interface HarnessOptions {
  readonly serverSkewMs?: number;
  /** Fullt styrt serverklokke (overstyrer `serverSkewMs`), f.eks. en klokke som skifter mellom to avvik. */
  readonly serverNow?: (clockNow: number) => number;
  readonly overrides?: Partial<GitHubAppAuthOptions>;
  readonly installationRepos?: string[];
  readonly installationPermissions?: Record<string, string>;
  readonly owner?: string;
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = { t: T0 };
  const fake = await FakeGitHubApp.start({
    publicKey: keys.publicKey, appId: APP_ID, installationId: INSTALLATION_ID,
    serverNow: () => (options.serverNow ? options.serverNow(clock.t) : clock.t + (options.serverSkewMs ?? 0)),
    ...(options.installationRepos ? { installationRepos: options.installationRepos } : {}),
    ...(options.installationPermissions ? { installationPermissions: options.installationPermissions } : {}),
    ...(options.owner ? { owner: options.owner } : {})
  });
  servers.push(fake);
  const sleeps: number[] = [];
  const logs: GitHubAuthLogEvent[] = [];
  const auth = new GitHubAppAuth({
    appId: APP_ID, installationId: INSTALLATION_ID, privateKey: async () => keys.pkcs1, apiBase: fake.baseUrl,
    repositories: [REPO], allowLoopbackHttpForTests: true,
    now: () => clock.t, sleep: async (ms) => { sleeps.push(ms); clock.t += ms; }, random: () => 0.5, log: (event) => { logs.push(event); },
    ...options.overrides
  });
  return { fake, clock, sleeps, logs, auth };
}

/** Forventer at løftet avvises med en `GitHubAppAuthError` og returnerer den. */
export async function failure(promise: Promise<unknown>): Promise<GitHubAppAuthError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(GitHubAppAuthError);
    return err as GitHubAppAuthError;
  }
  throw new Error("forventet at kallet skulle feile");
}
