import type { GitCredentialSource, JsonValue } from "@jarvis/contracts";
import type { ConnectorAuthInfo } from "./connector-registry.ts";
import type { SecretProvider } from "./gateway.ts";
import {
  GithubRateLimitController, type GithubHeaderReader, type GithubResponseClassification
} from "./github-rate-limit-controller.ts";
import {
  DEFAULT_GITHUB_API_BASE, GITHUB_APP_PRIVATE_KEY_REF, GitHubAppAuth, GitHubAppAuthError, asGitHubAppAuthError, defaultGitHubAuthLog,
  isValidGitHubAppId, isValidGitHubInstallationId, normalizeGitHubApiBase,
  type GitHubAppAuthOptions, type GitHubAuthLogEvent, type GitHubInstallationInfo, type GitHubTokenInfo
} from "./github-app-auth.ts";
import { assertGithubRepoSlug } from "./url-safety.ts";

/**
 * WP-C3 (Q-45 b / D-35 / D-450): token-uthenting for GitHub-connectoren bak en liten `GitHubTokenProvider`-abstraksjon med to
 * implementasjoner - `PatTokenProvider` (som i dag: `JARVIS_GITHUB_TOKEN` fra `SecretProvider`) og `AppTokenProvider` (kortlevd, repo-scopet
 * installasjonstoken fra `GitHubAppAuth`). Selve GitHub-ADAPTEREN (`GithubTransport`, risikoklasser, preflight, rate limit) er uendret: den
 * får fortsatt en `credential: string` fra `ToolGateway`, som leser `JARVIS_GITHUB_TOKEN` via `SecretProvider`. Dekoratøren
 * `GitHubTokenSecretProvider` bytter KUN ut verdien bak den refen - derfor virker kill switch, tilbakekalling, credentialBinding,
 * dashbordets «konfigurert»-visning og helse-sveipen uendret (alle jobber på ref-navnet, ikke på verdien).
 *
 * Valg av metode (miljøet er eneste kilde, ingen skjult tilstand):
 *  - Verken `JARVIS_GITHUB_APP_ID` eller `JARVIS_GITHUB_APP_INSTALLATION_ID` satt -> `pat`. `secretProvider(inner)` returnerer da `inner`
 *    UENDRET (ingen dekoratør i veien): oppførselen er identisk med før WP-C3.
 *  - Minst én satt -> `app`. Delvis/ugyldig konfig (manglende installasjons-id, ugyldig API-base, ingen repo-scope ...) er IKKE «PAT»:
 *    eieren har signalisert App-bruk, så det feiler lukket og høylytt (logg + status), aldri en stille nedgradering.
 *  - PAT brukes i App-modus KUN når eieren eksplisitt har satt `JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK=true`; hver bruk logges og vises i statusen
 *    (`pat_fallback.active`). Aldri fallback ved `GITHUB_APP_SCOPE_MISMATCH` (leverandøren ga noe annet enn forespurt).
 */

export const GITHUB_TOKEN_REF = "JARVIS_GITHUB_TOKEN";
export type GitHubAuthMethod = "pat" | "app";

export interface GitHubAuthStatus {
  readonly method: GitHubAuthMethod;
  /** `pat`; `app_pending` = konfigurert, ingen utstedelse ennå; `app_ok`; `app_error` = ugyldig konfig, siste utstedelse feilet, eller PAT-fallback i bruk. */
  readonly state: "pat" | "app_pending" | "app_ok" | "app_error";
  /** Credentialen som faktisk brukes utløper av seg selv (installasjonstoken). PAT og aktiv PAT-fallback: false. */
  readonly short_lived: boolean;
  /** Credentialen er begrenset til utvalgte repoer. PAT kan i praksis være fine-grained, men Jarvis kan ikke bevise det -> false. */
  readonly scoped: boolean;
  /** `short_lived && scoped` - «kortlevd repo-scopet identitet: ja/nei». */
  readonly hardened: boolean;
  readonly app: null | {
    readonly app_id: string | null;
    readonly installation_id: string | null;
    readonly api_base: string | null;
    readonly configured_repositories: readonly string[];
    readonly token: GitHubTokenInfo | null;
    readonly installation: GitHubInstallationInfo | null;
    readonly last_error: { readonly code: string; readonly at: string; readonly http_status: number | null } | null;
    readonly consecutive_failures: number;
    readonly clock_skew_ms: number;
  };
  readonly pat_fallback: { readonly allowed: boolean; readonly active: boolean };
}

/** Narrow-by-design abstraksjon over «hvor kommer GitHub-tokenet fra». `getToken` kaster ALDRI (SecretProvider-kontrakten): null = utilgjengelig. */
export interface GitHubTokenProvider {
  readonly method: GitHubAuthMethod;
  getToken(): Promise<string | null>;
  describe(): GitHubAuthStatus;
}

/**
 * D-41 full kapabilitet for dagens github.*-handlinger + git (Contents/PR/Issues/Actions skriv, Metadata les). Brukes som «påkrevde scopes» i
 * EV-17-faktaene: mangler installasjonen noe av dette, rapporteres `scope_shortfall` i stedet for at en handling feiler overraskende.
 */
export const GITHUB_FULL_CAPABILITY_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
  metadata: "read", contents: "write", pull_requests: "write", issues: "write", actions: "write"
};

const PAT_STATUS: GitHubAuthStatus = {
  method: "pat", state: "pat", short_lived: false, scoped: false, hardened: false, app: null, pat_fallback: { allowed: false, active: false }
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Konfig fra miljø
// ---------------------------------------------------------------------------------------------------------------------------------

export type GitHubAuthSettings =
  | { readonly kind: "pat" }
  | {
      readonly kind: "app"; readonly appId: string; readonly installationId: string; readonly apiBase: string;
      /** `owner/repo`-slugs: `JARVIS_GIT_ALLOWED_REPOS`, ellers `JARVIS_GITHUB_REPO`. */
      readonly repositories: readonly string[]; readonly allowPatFallback: boolean;
    }
  | { readonly kind: "invalid"; readonly error: GitHubAppAuthError; readonly allowPatFallback: boolean; readonly appId: string | null; readonly installationId: string | null };

const readEnv = (env: Readonly<Record<string, string | undefined>>, name: string): string | undefined => {
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

function repositoriesFromEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  const list = (raw: string | undefined): string[] => (raw ?? "").split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  const explicit = list(env["JARVIS_GIT_ALLOWED_REPOS"]);
  const slugs = explicit.length > 0 ? explicit : list(env["JARVIS_GITHUB_REPO"]);
  for (const slug of slugs) {
    try {
      assertGithubRepoSlug(slug);
    } catch {
      throw new GitHubAppAuthError("GITHUB_APP_CONFIG_INVALID", "allowed_repos_invalid");
    }
  }
  return slugs;
}

/**
 * Leser App-konfigen fra miljøet. `JARVIS_GITHUB_API_BASE` kan KUN være https://api.github.com (tomt = standard; review F5 - JWT-en sendes aldri til en
 * annen vert) - `GithubTransport` og git bruker uansett api.github.com/github.com (GitHub Enterprise Server er ikke støttet, DEFERRED). Loopback-http for
 * tester kan KUN slås på via `options.allowLoopbackHttpForTests` i koden, aldri fra miljøet.
 */
export function resolveGitHubAuthSettings(env: Readonly<Record<string, string | undefined>>, options: { allowLoopbackHttpForTests?: boolean } = {}): GitHubAuthSettings {
  const appId = readEnv(env, "JARVIS_GITHUB_APP_ID");
  const installationId = readEnv(env, "JARVIS_GITHUB_APP_INSTALLATION_ID");
  if (appId === undefined && installationId === undefined) return { kind: "pat" };
  const allowPatFallback = readEnv(env, "JARVIS_GITHUB_APP_ALLOW_PAT_FALLBACK")?.toLowerCase() === "true";
  const invalid = (error: GitHubAppAuthError): GitHubAuthSettings => ({ kind: "invalid", error, allowPatFallback, appId: appId ?? null, installationId: installationId ?? null });
  const config = (reason: string): GitHubAppAuthError => new GitHubAppAuthError("GITHUB_APP_CONFIG_INVALID", reason);
  if (appId === undefined) return invalid(config("JARVIS_GITHUB_APP_ID_missing"));
  if (installationId === undefined) return invalid(config("JARVIS_GITHUB_APP_INSTALLATION_ID_missing"));
  if (!isValidGitHubAppId(appId)) return invalid(config("app_id_invalid"));
  if (!isValidGitHubInstallationId(installationId)) return invalid(config("installation_id_invalid"));
  let apiBase: string;
  let repositories: string[];
  try {
    apiBase = normalizeGitHubApiBase(readEnv(env, "JARVIS_GITHUB_API_BASE"), options.allowLoopbackHttpForTests === true);
    repositories = repositoriesFromEnv(env);
  } catch (err) {
    return invalid(asGitHubAppAuthError(err));
  }
  if (repositories.length === 0) {
    return invalid(new GitHubAppAuthError("GITHUB_APP_SCOPE_UNDEFINED", "set_JARVIS_GITHUB_REPO_or_JARVIS_GIT_ALLOWED_REPOS"));
  }
  return { kind: "app", appId, installationId, apiBase, repositories, allowPatFallback };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Token-leverandører
// ---------------------------------------------------------------------------------------------------------------------------------

/** PAT slik det alltid har fungert: `JARVIS_GITHUB_TOKEN` fra `SecretProvider`. */
export class PatTokenProvider implements GitHubTokenProvider {
  readonly method = "pat" as const;

  constructor(private readonly secrets: SecretProvider, private readonly ref: string = GITHUB_TOKEN_REF) {}

  getToken(): Promise<string | null> {
    return this.secrets.get(this.ref);
  }

  describe(): GitHubAuthStatus {
    return PAT_STATUS;
  }
}

type LogFn = (event: GitHubAuthLogEvent) => void;

/** Det `AppTokenProvider` trenger av den delte App-logikken (egen eksportert type slik at klassene under kan eksporteres uten private navn). */
export interface GitHubAppCredentialSource {
  defaultToken(pat: GitHubTokenProvider): Promise<string | null>;
}

/** Delt App-logikk (én instans per `GitHubAuth`): utstedelse, PAT-fallback-policy og logging. Ikke eksportert. */
class AppCredentialCore implements GitHubAppCredentialSource {
  fallbackActive = false;
  readonly #lastLogAt = new Map<string, number>();

  constructor(
    readonly settings: Exclude<GitHubAuthSettings, { kind: "pat" }>,
    readonly app: GitHubAppAuth | undefined,
    private readonly log: LogFn,
    private readonly now: () => number
  ) {}

  private configError(): GitHubAppAuthError {
    return this.settings.kind === "invalid" ? this.settings.error : new GitHubAppAuthError("GITHUB_APP_NOT_CONFIGURED", "no_app");
  }

  async defaultToken(pat: GitHubTokenProvider): Promise<string | null> {
    try {
      if (!this.app) {
        const error = this.configError();
        this.emit({ level: "error", msg: "github_app_unusable", code: error.code }, `unusable:${error.code}`, 60_000);
        throw error;
      }
      const token = await this.app.token();
      this.fallbackActive = false;
      return token;
    } catch (err) {
      return this.recover(asGitHubAppAuthError(err), pat);
    }
  }

  async repositoryToken(slug: string, pat: GitHubTokenProvider): Promise<string> {
    let error: GitHubAppAuthError;
    try {
      if (!this.app) throw this.configError();
      if (!this.isConfiguredRepository(slug, this.app)) {
        // Policy, ikke tilgjengelighet: et repo utenfor den konfigurerte listen får aldri et token (og aldri PAT-fallback).
        throw new GitHubAppAuthError("GITHUB_APP_SCOPE_MISMATCH", "repository_not_in_configured_scope");
      }
      const token = await this.app.token({ repositories: [slug] });
      this.fallbackActive = false;
      return token;
    } catch (err) {
      error = asGitHubAppAuthError(err);
    }
    const recovered = await this.recover(error, pat);
    if (recovered === null) throw error;
    return recovered;
  }

  private isConfiguredRepository(slug: string, app: GitHubAppAuth): boolean {
    const wanted = slug.toLowerCase();
    return app.defaultRepositories.some((entry) => {
      const value = entry.toLowerCase();
      return value === wanted || (!value.includes("/") && value === wanted.split("/")[1]);
    });
  }

  /** Eneste sted PAT kan komme inn i App-modus: eksplisitt flagg, aldri ved scope-avvik, og alltid loggført. */
  private async recover(error: GitHubAppAuthError, pat: GitHubTokenProvider): Promise<string | null> {
    if (this.settings.allowPatFallback && error.code !== "GITHUB_APP_SCOPE_MISMATCH") {
      const token = await pat.getToken();
      if (token) {
        this.fallbackActive = true;
        this.emit({ level: "warn", msg: "github_app_pat_fallback_used", code: error.code, http_status: error.httpStatus }, "fallback", 60_000);
        return token;
      }
    }
    this.fallbackActive = false;
    return null;
  }

  private emit(event: GitHubAuthLogEvent, rateKey: string, minIntervalMs: number): void {
    const now = this.now();
    const last = this.#lastLogAt.get(rateKey);
    if (last !== undefined && now - last < minIntervalMs) return;
    this.#lastLogAt.set(rateKey, now);
    try {
      this.log(event);
    } catch {
      // Logging skal aldri påvirke autentiseringen.
    }
  }
}

/** Kortlevd, repo-scopet installasjonstoken (standard-scope = konfigurert repo/tillatt-liste). */
export class AppTokenProvider implements GitHubTokenProvider {
  readonly method = "app" as const;

  constructor(private readonly core: GitHubAppCredentialSource, private readonly pat: GitHubTokenProvider, private readonly status: () => GitHubAuthStatus) {}

  getToken(): Promise<string | null> {
    return this.core.defaultToken(this.pat);
  }

  describe(): GitHubAuthStatus {
    return this.status();
  }
}

/**
 * `SecretProvider`-dekoratør: `JARVIS_GITHUB_TOKEN` -> `GitHubTokenProvider.getToken()`; alle andre refer går uendret til `inner`.
 * `get` kaster aldri (kontrakten): en feilet utstedelse gir `null`, som `ToolGateway` avviser som `credential_unavailable` - kategorien står i
 * loggen og i connector-statusen.
 */
export class GitHubTokenSecretProvider implements SecretProvider {
  readonly name: string;

  constructor(private readonly inner: SecretProvider, private readonly tokens: GitHubTokenProvider, private readonly ref: string = GITHUB_TOKEN_REF) {
    this.name = `${inner.name}+github-${tokens.method}`;
  }

  async get(ref: string): Promise<string | null> {
    if (ref !== this.ref) return this.inner.get(ref);
    try {
      return await this.tokens.getToken();
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Fasade
// ---------------------------------------------------------------------------------------------------------------------------------

export interface CreateGitHubAuthOptions {
  /** Kilde for PAT (standard) OG for App-ens privatnøkkel (`JARVIS_GITHUB_APP_PRIVATE_KEY`). Typisk Infisical -> env. */
  readonly secrets: SecretProvider;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log?: ((event: GitHubAuthLogEvent) => void) | undefined;
  /** Injeksjonspunkter (tester) videreført til `GitHubAppAuth`. */
  readonly http?: GitHubAppAuthOptions["http"];
  readonly now?: GitHubAppAuthOptions["now"];
  readonly sleep?: GitHubAppAuthOptions["sleep"];
  readonly random?: GitHubAppAuthOptions["random"];
  readonly maxAttempts?: GitHubAppAuthOptions["maxAttempts"];
  readonly requestTimeoutMs?: GitHubAppAuthOptions["requestTimeoutMs"];
  /** KUN TEST: tillat `http://127.0.0.1:<port>` som API-base. Kan ikke settes fra miljøet. */
  readonly allowLoopbackHttpForTests?: boolean | undefined;
}

/** Faktaobjekt for Evolution EV-17 (`assessCredential`) - strukturelt kompatibelt med `CredentialState`, pluss de to ja/nei-svarene. */
export interface GitHubCredentialFacts {
  readonly ref: string;
  readonly kind: "short_lived_token" | "api_key";
  readonly expires_at: string | null;
  readonly last_refresh_ok: boolean | null;
  readonly scopes_granted: readonly string[];
  readonly scopes_required: readonly string[];
  readonly revoked: boolean;
  readonly short_lived: boolean;
  readonly repo_scoped: boolean;
  readonly auth_method: GitHubAuthMethod;
}

function expandScopes(permissions: Readonly<Record<string, string>>): string[] {
  const out = new Set<string>();
  for (const [name, level] of Object.entries(permissions)) {
    out.add(`${name}:${level}`);
    if (level === "write" || level === "admin") out.add(`${name}:read`);
    if (level === "admin") out.add(`${name}:write`);
  }
  return [...out].sort();
}

/**
 * Rate-limit-kontrolleren (uendret) pluss ÉN ting: et 401 på et token vi selv utstedte får cachen til å slippe tokens eldre enn 15 s, så neste
 * kall utsteder et nytt (revokert/ugyldiggjort installasjonstoken) i stedet for å gjenbruke det døde i opptil en time.
 */
class GitHubAuthRateLimitController extends GithubRateLimitController {
  readonly #onUnauthorized: () => void;

  constructor(store: ConstructorParameters<typeof GithubRateLimitController>[0], ref: string, onUnauthorized: () => void, onTransition?: ConstructorParameters<typeof GithubRateLimitController>[2]) {
    super(store, ref, onTransition);
    this.#onUnauthorized = onUnauthorized;
  }

  override async recordOutcome(mutation: boolean, status: number, headers: GithubHeaderReader, rawBody: string): Promise<GithubResponseClassification> {
    if (status === 401) this.#onUnauthorized();
    return super.recordOutcome(mutation, status, headers, rawBody);
  }
}

export class GitHubAuth {
  readonly settings: GitHubAuthSettings;
  /** Satt når App-konfigen er gyldig (kind `app`). */
  readonly app: GitHubAppAuth | undefined;
  readonly #secrets: SecretProvider;
  readonly #log: LogFn;
  readonly #core: AppCredentialCore | undefined;
  readonly #startedAt: string;

  constructor(options: CreateGitHubAuthOptions) {
    this.#secrets = options.secrets;
    this.#log = options.log ?? defaultGitHubAuthLog;
    this.#startedAt = new Date((options.now ?? Date.now)()).toISOString();
    let settings = resolveGitHubAuthSettings(options.env, { allowLoopbackHttpForTests: options.allowLoopbackHttpForTests === true });
    let app: GitHubAppAuth | undefined;
    if (settings.kind === "app") {
      try {
        app = new GitHubAppAuth({
          appId: settings.appId, installationId: settings.installationId, apiBase: settings.apiBase, repositories: settings.repositories,
          // Nøkkelen leses fra vaulten ved HVER signering (ingen langlevd kopi i prosessen).
          privateKey: () => options.secrets.get(GITHUB_APP_PRIVATE_KEY_REF),
          http: options.http, now: options.now, sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts,
          requestTimeoutMs: options.requestTimeoutMs, log: this.#log, allowLoopbackHttpForTests: options.allowLoopbackHttpForTests
        });
      } catch (err) {
        settings = { kind: "invalid", error: asGitHubAppAuthError(err), allowPatFallback: settings.allowPatFallback, appId: settings.appId, installationId: settings.installationId };
      }
    }
    this.settings = settings;
    this.app = app;
    if (settings.kind !== "pat") this.#core = new AppCredentialCore(settings, app, this.#log, options.now ?? Date.now);
    this.#announce();
  }

  get method(): GitHubAuthMethod {
    return this.settings.kind === "pat" ? "pat" : "app";
  }

  /** Én linje ved oppstart (aldri i PAT-modus: uendret stillhet). Ugyldig App-konfig er en høylytt feil, ikke en stille PAT-nedgradering. */
  #announce(): void {
    const s = this.settings;
    if (s.kind === "pat") return;
    const emit = (event: GitHubAuthLogEvent): void => { try { this.#log(event); } catch { /* logging skal ikke feile oppstart */ } };
    if (s.kind === "invalid") {
      emit({ level: "error", msg: "github_app_config_invalid", code: s.error.code, detail: s.error.message, pat_fallback_allowed: s.allowPatFallback });
      return;
    }
    emit({
      level: "info", msg: "github_auth_mode", method: "app", app_id: s.appId, installation_id: s.installationId,
      repositories: s.repositories.join(","), api_base: s.apiBase, pat_fallback_allowed: s.allowPatFallback
    });
    if (s.apiBase !== DEFAULT_GITHUB_API_BASE) {
      emit({ level: "warn", msg: "github_api_base_non_default", api_base: s.apiBase, note: "GithubTransport og git bruker fortsatt api.github.com/github.com (GHES ikke støttet)" });
    }
  }

  /** Token-leverandør for en gitt PAT-kilde (standard: `secrets`). I PAT-modus er den ren PAT; i App-modus installasjonstoken (+ evt. eksplisitt PAT-fallback). */
  tokenProvider(patSecrets?: SecretProvider): GitHubTokenProvider {
    const pat = new PatTokenProvider(patSecrets ?? this.#secrets);
    if (!this.#core) return pat;
    return new AppTokenProvider(this.#core, pat, () => this.status());
  }

  /**
   * `SecretProvider` som leverer riktig GitHub-credential under `JARVIS_GITHUB_TOKEN`. I PAT-modus returneres `inner` UENDRET (ingen dekoratør,
   * identisk oppførsel som før WP-C3). `inner` er også PAT-kilden i App-modus (fallback) og kilden for alle andre refer.
   */
  secretProvider(inner: SecretProvider): SecretProvider {
    if (!this.#core) return inner;
    return new GitHubTokenSecretProvider(inner, this.tokenProvider(inner));
  }

  /** `tokenFor(repoSlug)`: repo-scopert installasjonstoken for git clone/push (WP-C1 sin vertsside job-runner). I PAT-modus: PAT-en (som i dag). */
  gitCredentialSource(patSecrets?: SecretProvider): GitCredentialSource {
    const pat = new PatTokenProvider(patSecrets ?? this.#secrets);
    const core = this.#core;
    return {
      tokenFor: async (repoSlug: string): Promise<string> => {
        let slug: string;
        try {
          slug = assertGithubRepoSlug(repoSlug);
        } catch {
          throw new GitHubAppAuthError("GITHUB_APP_CONFIG_INVALID", "repo_slug_invalid");
        }
        if (!core) {
          const token = await pat.getToken();
          if (!token) throw new GitHubAppAuthError("GITHUB_TOKEN_UNAVAILABLE", "no_pat_configured");
          return token;
        }
        return core.repositoryToken(slug, pat);
      }
    };
  }

  /** `JARVIS_GITHUB_TOKEN` i PAT-modus (uendret), ellers en egen nøkkel per installasjon - installasjonstokenet har egen kvote og skal ikke arve PAT-ens cooldown. */
  rateLimitScopeRef(): string {
    return this.settings.kind === "app" ? `JARVIS_GITHUB_APP_INSTALLATION_${this.settings.installationId}` : GITHUB_TOKEN_REF;
  }

  /** Rate-limit-kontrolleren som `GithubTransport` allerede bruker. I App-modus forkastes tokens ved 401; ellers er den identisk med før. */
  rateLimitController(store: ConstructorParameters<typeof GithubRateLimitController>[0], onTransition?: ConstructorParameters<typeof GithubRateLimitController>[2]): GithubRateLimitController {
    const app = this.app;
    if (!app) return new GithubRateLimitController(store, this.rateLimitScopeRef(), onTransition);
    return new GitHubAuthRateLimitController(store, this.rateLimitScopeRef(), () => app.noteUnauthorized(), onTransition);
  }

  /** Nylig utstedte tokens - KUN til redaksjon av feilmeldinger (`withSecretRedaction`), aldri til logg/modell. */
  knownTokens(): string[] {
    return this.app?.knownTokens() ?? [];
  }

  status(): GitHubAuthStatus {
    const s = this.settings;
    if (s.kind === "pat") return PAT_STATUS;
    const appState = this.app?.state() ?? null;
    const configError = s.kind === "invalid" ? s.error : null;
    const lastError = appState?.last_error ?? (configError ? { code: configError.code, at: this.#startedAt, http_status: null } : null);
    const token = appState?.token ?? null;
    const fallbackActive = this.#core?.fallbackActive === true;
    const state: GitHubAuthStatus["state"] = configError !== null || fallbackActive
      ? "app_error"
      : token !== null ? "app_ok" : lastError !== null ? "app_error" : "app_pending";
    const inUse = state === "app_ok" || state === "app_pending";
    return {
      method: "app",
      state,
      short_lived: inUse,
      scoped: inUse,
      hardened: inUse,
      app: {
        app_id: s.appId,
        installation_id: s.installationId,
        api_base: s.kind === "app" ? s.apiBase : null,
        configured_repositories: s.kind === "app" ? s.repositories : [],
        token,
        installation: appState?.installation ?? null,
        last_error: lastError,
        consecutive_failures: appState?.consecutive_failures ?? (configError ? 1 : 0),
        clock_skew_ms: appState?.clock_skew_ms ?? 0
      },
      pat_fallback: { allowed: s.allowPatFallback, active: fallbackActive }
    };
  }

  /** Metadata til `listConnectorStatus({ authInfo })` / `executive.get_connector_status`. Aldri tokenverdier. */
  connectorAuthInfo(): ConnectorAuthInfo {
    const s = this.status();
    const detail: { [key: string]: JsonValue } = {
      state: s.state,
      hardened: s.hardened,
      pat_fallback_allowed: s.pat_fallback.allowed,
      pat_fallback_active: s.pat_fallback.active
    };
    if (s.app) {
      detail["app_id"] = s.app.app_id;
      detail["installation_id"] = s.app.installation_id;
      detail["api_base"] = s.app.api_base;
      detail["configured_repositories"] = [...s.app.configured_repositories];
      detail["repositories"] = s.app.token ? [...s.app.token.repositories] : [];
      detail["repository_selection"] = s.app.token?.repository_selection ?? null;
      detail["token_expires_at"] = s.app.token?.expires_at ?? null;
      detail["permissions"] = { ...(s.app.token?.permissions ?? {}) };
      detail["installation_repository_selection"] = s.app.installation?.repository_selection ?? null;
      detail["consecutive_failures"] = s.app.consecutive_failures;
      detail["clock_skew_ms"] = s.app.clock_skew_ms;
      detail["last_error"] = s.app.last_error ? { code: s.app.last_error.code, at: s.app.last_error.at, http_status: s.app.last_error.http_status } : null;
    }
    return { method: s.method, short_lived: s.short_lived, scoped: s.scoped, detail };
  }

  /** EV-17-fakta for `assessCredential` (koordinatoren kobler dem til EV-17 senere). PAT: scopes kan ikke leses av -> tomme lister (ærlig «ukjent»). */
  credentialFacts(): GitHubCredentialFacts {
    const s = this.status();
    if (s.method === "pat" || !s.app) {
      return { ref: GITHUB_TOKEN_REF, kind: "api_key", expires_at: null, last_refresh_ok: null, scopes_granted: [], scopes_required: [], revoked: false, short_lived: false, repo_scoped: false, auth_method: "pat" };
    }
    const fallback = s.pat_fallback.active;
    // Kjente tildelte rettigheter kommer fra siste utstedte token, ellers fra en eksplisitt inspisert installasjon. Er ingen av dem kjent,
    // påstås heller ingen scope-mangel (tom «påkrevd»-liste = ukjent): en feilet utstedelse er `refresh_failing`, ikke `scope_shortfall`.
    const granted = s.app.token?.permissions ?? s.app.installation?.permissions ?? null;
    return {
      ref: GITHUB_TOKEN_REF,
      kind: fallback ? "api_key" : "short_lived_token",
      expires_at: fallback ? null : s.app.token?.expires_at ?? null,
      last_refresh_ok: s.app.last_error ? false : s.app.token ? true : null,
      scopes_granted: granted ? expandScopes(granted) : [],
      scopes_required: granted ? expandScopes(GITHUB_FULL_CAPABILITY_PERMISSIONS) : [],
      revoked: false,
      short_lived: s.short_lived,
      repo_scoped: s.scoped,
      auth_method: "app"
    };
  }
}

export function createGitHubAuth(options: CreateGitHubAuthOptions): GitHubAuth {
  return new GitHubAuth(options);
}
