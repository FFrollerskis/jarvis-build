import type pg from "pg";

/**
 * D-97: sentralisert rate-limit-kontroller for GitHub-provideren. ALL GitHub-
 * trafikk gaar allerede gjennom EN funksjon (`githubFetch` i live-transports.ts,
 * kalt fra samtlige 23 `github.*`-handlinger) - denne modulen er den ENE
 * beslutningsplassen for om et kall er trygt aa forsoeke NAA, og for aa tolke
 * GitHub sine egne dokumenterte signaler (headers/status) etter hvert forsoek.
 * Offisiell kontrakt (docs.github.com/en/rest/using-the-rest-api, hentet
 * 2026-08-20 via raw.githubusercontent.com/github/docs da docs.github.com var
 * blokkert av utgaaende proxy):
 *  - x-ratelimit-limit/remaining/used/reset(UTC epoch sekunder)/resource er
 *    EXTERNAL_CANONICAL fakta fra GitHub, aldri Jarvis-beregnet.
 *  - Primaer grense overskredet: 403 ELLER 429, ALLTID med x-ratelimit-remaining: 0.
 *  - Sekundaer ("abuse"/"secondary rate limit") throttling: 403 ELLER 429,
 *    x-ratelimit-remaining IKKE 0, ofte (ikke alltid) med `retry-after`
 *    (sekunder). Offisiell veiledning: "make requests serially instead of
 *    concurrently", "wait at least one second between each [mutating]
 *    request", "wait for at least one minute before retrying" naar
 *    retry-after mangler, "exponentially increasing amount of time between
 *    retries", og "obey retry-after exactly naar den finnes".
 * Se D-97 i docs/DECISIONS_AND_ASSUMPTIONS.md for full kontrakt/begrunnelse.
 */

export type GithubRateLimitState = "NORMAL" | "MUTATIONS_THROTTLED" | "PROVIDER_THROTTLED";
export type GithubRetryAfterSource = "provider" | "jarvis_fallback";

export interface GithubPrimaryQuota {
  limit: number | null;
  remaining: number | null;
  used: number | null;
  reset: Date | null;
  resource: string | null;
}

export interface GithubRateLimitRow {
  credentialRef: string;
  state: GithubRateLimitState;
  cooldownUntil: Date | null;
  retryAfterSource: GithubRetryAfterSource | null;
  consecutiveViolations: number;
  primary: GithubPrimaryQuota;
}

/** Minimal delmengde av fetch sin Headers - lar oss teste uten en ekte Response. */
export interface GithubHeaderReader {
  get(name: string): string | null;
}

const EMPTY_QUOTA: GithubPrimaryQuota = { limit: null, remaining: null, used: null, reset: null, resource: null };

export interface GithubRateLimitStore {
  get(credentialRef: string): Promise<GithubRateLimitRow | null>;
  /** mutation=false skal ALDRI rydde en MUTATIONS_THROTTLED-tilstand - en vellykket LES sier ingenting om mutasjons-kvote. */
  recordSuccess(credentialRef: string, mutation: boolean, quota: GithubPrimaryQuota | null): Promise<void>;
  recordViolation(
    credentialRef: string,
    state: GithubRateLimitState,
    cooldownUntil: Date,
    source: GithubRetryAfterSource,
    quota: GithubPrimaryQuota | null
  ): Promise<void>;
}

function defaultRow(credentialRef: string): GithubRateLimitRow {
  return { credentialRef, state: "NORMAL", cooldownUntil: null, retryAfterSource: null, consecutiveViolations: 0, primary: EMPTY_QUOTA };
}

function mergeQuota(prior: GithubPrimaryQuota, next: GithubPrimaryQuota | null): GithubPrimaryQuota {
  if (!next) return prior;
  return {
    limit: next.limit ?? prior.limit,
    remaining: next.remaining ?? prior.remaining,
    used: next.used ?? prior.used,
    reset: next.reset ?? prior.reset,
    resource: next.resource ?? prior.resource
  };
}

/**
 * Prosess-lokal store - KUN for tester/engangs-skript uten Postgres. Ingen
 * tverr-prosess-koordinering (RATE_LIMIT_STATE_SCOPE=PROCESS naar denne brukes).
 */
export class InMemoryGithubRateLimitStore implements GithubRateLimitStore {
  private readonly rows = new Map<string, GithubRateLimitRow>();

  async get(credentialRef: string): Promise<GithubRateLimitRow | null> {
    return this.rows.get(credentialRef) ?? null;
  }

  async recordSuccess(credentialRef: string, mutation: boolean, quota: GithubPrimaryQuota | null): Promise<void> {
    const prior = this.rows.get(credentialRef) ?? defaultRow(credentialRef);
    this.rows.set(credentialRef, mutation
      ? { ...prior, state: "NORMAL", cooldownUntil: null, retryAfterSource: null, consecutiveViolations: 0, primary: mergeQuota(prior.primary, quota) }
      : { ...prior, primary: mergeQuota(prior.primary, quota) });
  }

  async recordViolation(credentialRef: string, state: GithubRateLimitState, cooldownUntil: Date, source: GithubRetryAfterSource, quota: GithubPrimaryQuota | null): Promise<void> {
    const prior = this.rows.get(credentialRef) ?? defaultRow(credentialRef);
    // §19 (D-97 pre-merge audit): MONOTON cooldown - en kortere, senere-ankommet
    // brudd (f.eks. Jarvis-fallback) skal ALDRI forkorte en allerede lengre,
    // provider-oppgitt cooldown fra et konkurrerende forsøk. Den lengste
    // cooldown_until "vinner", og state/kilde følger DEN vinnende verdien.
    const priorWins = prior.cooldownUntil !== null && prior.cooldownUntil > cooldownUntil;
    this.rows.set(credentialRef, {
      ...prior,
      state: priorWins ? prior.state : state,
      cooldownUntil: priorWins ? prior.cooldownUntil : cooldownUntil,
      retryAfterSource: priorWins ? prior.retryAfterSource : source,
      consecutiveViolations: prior.consecutiveViolations + 1,
      primary: mergeQuota(prior.primary, quota)
    });
  }
}

/**
 * Postgres-baaret delt tilstand (RATE_LIMIT_STATE_SCOPE=SHARED_RUNTIME) -
 * overlever restart, deles av apps/api og worker-main uten Redis (ingen
 * Redis finnes i repoet - jf. D-97-research). Global infrastruktur-tilstand
 * naar KUN GitHub sin egen `credential_ref`-streng (ALDRI raatt token),
 * IKKE tenant-forretningsdata - speiler bevisst samme moenster som
 * `scheduler_state` (013_scheduler_state.sql: ingen tenant_id, ingen RLS,
 * INSERT...ON CONFLICT som atomisk claim/oppdatering).
 */
export class PgGithubRateLimitStore implements GithubRateLimitStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(credentialRef: string): Promise<GithubRateLimitRow | null> {
    const result = await this.pool.query(
      `SELECT state, cooldown_until, retry_after_source, consecutive_violations,
              primary_limit, primary_remaining, primary_used, primary_reset, primary_resource
       FROM github_rate_limit_state WHERE credential_ref = $1`,
      [credentialRef]
    );
    const row = result.rows[0] as {
      state: GithubRateLimitState; cooldown_until: Date | null; retry_after_source: GithubRetryAfterSource | null;
      consecutive_violations: number; primary_limit: number | null; primary_remaining: number | null;
      primary_used: number | null; primary_reset: Date | null; primary_resource: string | null;
    } | undefined;
    if (!row) return null;
    return {
      credentialRef, state: row.state, cooldownUntil: row.cooldown_until, retryAfterSource: row.retry_after_source,
      consecutiveViolations: row.consecutive_violations,
      primary: { limit: row.primary_limit, remaining: row.primary_remaining, used: row.primary_used, reset: row.primary_reset, resource: row.primary_resource }
    };
  }

  async recordSuccess(credentialRef: string, mutation: boolean, quota: GithubPrimaryQuota | null): Promise<void> {
    if (mutation) {
      await this.pool.query(
        `INSERT INTO github_rate_limit_state (credential_ref, state, cooldown_until, retry_after_source, consecutive_violations, primary_limit, primary_remaining, primary_used, primary_reset, primary_resource, updated_at)
         VALUES ($1, 'NORMAL', NULL, NULL, 0, $2, $3, $4, $5, $6, now())
         ON CONFLICT (credential_ref) DO UPDATE SET
           state = 'NORMAL', cooldown_until = NULL, retry_after_source = NULL, consecutive_violations = 0,
           primary_limit = COALESCE(EXCLUDED.primary_limit, github_rate_limit_state.primary_limit),
           primary_remaining = COALESCE(EXCLUDED.primary_remaining, github_rate_limit_state.primary_remaining),
           primary_used = COALESCE(EXCLUDED.primary_used, github_rate_limit_state.primary_used),
           primary_reset = COALESCE(EXCLUDED.primary_reset, github_rate_limit_state.primary_reset),
           primary_resource = COALESCE(EXCLUDED.primary_resource, github_rate_limit_state.primary_resource),
           updated_at = now()`,
        [credentialRef, quota?.limit ?? null, quota?.remaining ?? null, quota?.used ?? null, quota?.reset ?? null, quota?.resource ?? null]
      );
      return;
    }
    // Vellykket LES: oppdater KUN kvote-fakta, roer ALDRI en MUTATIONS_THROTTLED-tilstand.
    await this.pool.query(
      `INSERT INTO github_rate_limit_state (credential_ref, primary_limit, primary_remaining, primary_used, primary_reset, primary_resource, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (credential_ref) DO UPDATE SET
         primary_limit = COALESCE(EXCLUDED.primary_limit, github_rate_limit_state.primary_limit),
         primary_remaining = COALESCE(EXCLUDED.primary_remaining, github_rate_limit_state.primary_remaining),
         primary_used = COALESCE(EXCLUDED.primary_used, github_rate_limit_state.primary_used),
         primary_reset = COALESCE(EXCLUDED.primary_reset, github_rate_limit_state.primary_reset),
         primary_resource = COALESCE(EXCLUDED.primary_resource, github_rate_limit_state.primary_resource),
         updated_at = now()`,
      [credentialRef, quota?.limit ?? null, quota?.remaining ?? null, quota?.used ?? null, quota?.reset ?? null, quota?.resource ?? null]
    );
  }

  async recordViolation(credentialRef: string, state: GithubRateLimitState, cooldownUntil: Date, source: GithubRetryAfterSource, quota: GithubPrimaryQuota | null): Promise<void> {
    // §19 (D-97 pre-merge audit, KRITISK): to samtidige throttlede svar (t.d.
    // prosess A faar provider-Retry-After=10min, prosess B faar en kortere
    // jarvis-fallback=1min) skal ALDRI la den korteste "vinne" uansett
    // skrive-rekkefolge - cooldown_until er derfor MONOTON (GREATEST), og
    // state/retry_after_source følger UANSETT hvilken av (eksisterende rad,
    // ny verdi) som faktisk har den lengste cooldown_until - ALDRI bare
    // "siste skriver vinner". consecutive_violations telles UAVHENGIG av
    // hvem som "vinner" (bruddet skjedde faktisk, uansett).
    await this.pool.query(
      `INSERT INTO github_rate_limit_state (credential_ref, state, cooldown_until, retry_after_source, consecutive_violations, primary_limit, primary_remaining, primary_used, primary_reset, primary_resource, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, now())
       ON CONFLICT (credential_ref) DO UPDATE SET
         state = CASE WHEN COALESCE(github_rate_limit_state.cooldown_until, EXCLUDED.cooldown_until) > EXCLUDED.cooldown_until
                       THEN github_rate_limit_state.state ELSE EXCLUDED.state END,
         cooldown_until = GREATEST(COALESCE(github_rate_limit_state.cooldown_until, EXCLUDED.cooldown_until), EXCLUDED.cooldown_until),
         retry_after_source = CASE WHEN COALESCE(github_rate_limit_state.cooldown_until, EXCLUDED.cooldown_until) > EXCLUDED.cooldown_until
                                    THEN github_rate_limit_state.retry_after_source ELSE EXCLUDED.retry_after_source END,
         consecutive_violations = github_rate_limit_state.consecutive_violations + 1,
         primary_limit = COALESCE(EXCLUDED.primary_limit, github_rate_limit_state.primary_limit),
         primary_remaining = COALESCE(EXCLUDED.primary_remaining, github_rate_limit_state.primary_remaining),
         primary_used = COALESCE(EXCLUDED.primary_used, github_rate_limit_state.primary_used),
         primary_reset = COALESCE(EXCLUDED.primary_reset, github_rate_limit_state.primary_reset),
         primary_resource = COALESCE(EXCLUDED.primary_resource, github_rate_limit_state.primary_resource),
         updated_at = now()`,
      [credentialRef, state, cooldownUntil, source, quota?.limit ?? null, quota?.remaining ?? null, quota?.used ?? null, quota?.reset ?? null, quota?.resource ?? null]
    );
  }
}

export type GithubResponseClassification =
  | { kind: "OK" }
  | { kind: "PRIMARY_RATE_LIMIT"; retryAt: Date }
  | { kind: "SECONDARY_RATE_LIMIT"; retryAfterMs: number | null }
  | { kind: "PERMISSION_403" }
  | { kind: "OTHER" };

const SECONDARY_RATE_LIMIT_BODY_PATTERN = /secondary rate limit|abuse detection mechanism/i;

/**
 * Klassifiserer ETT GitHub-svar mot dokumenterte signaler. Klassifiserer
 * ALDRI hvert 403 som rate-limiting (§9-krav): et 403 uten
 * `x-ratelimit-remaining: 0`, uten `retry-after` og uten kjent
 * sekundaer-fritekst er en EKTE PERMISSION_403, aldri en gjettet throttle.
 * 429 er derimot ALDRI en tilgangsfeil hos GitHub (det statuskodepunktet
 * brukes utelukkende til throttling) - remaining==0 skiller primaer fra
 * sekundaer ogsaa her.
 */
export function classifyGithubResponse(status: number, headers: GithubHeaderReader, rawBody: string): GithubResponseClassification {
  if (status < 400) return { kind: "OK" };
  if (status !== 403 && status !== 429) return { kind: "OTHER" };
  const remaining = headers.get("x-ratelimit-remaining");
  if (remaining === "0") {
    const resetHeader = headers.get("x-ratelimit-reset");
    const resetSeconds = resetHeader ? Number(resetHeader) : Number.NaN;
    const retryAt = Number.isFinite(resetSeconds) ? new Date(resetSeconds * 1000) : new Date(Date.now() + 60_000);
    return { kind: "PRIMARY_RATE_LIMIT", retryAt };
  }
  const retryAfterHeader = headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
  // Negativ/NaN/overflow er malformed - ALDRI stol pa en gjettet "retry i fortiden"-verdi
  // (§6-krav); en negativ verdi faller derfor gjennom til jarvis_fallback under, IKKE en 0-delay-retry.
  const hasRetryAfter = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0;
  if (status === 429 || hasRetryAfter || SECONDARY_RATE_LIMIT_BODY_PATTERN.test(rawBody)) {
    return { kind: "SECONDARY_RATE_LIMIT", retryAfterMs: hasRetryAfter ? retryAfterSeconds * 1000 : null };
  }
  return { kind: "PERMISSION_403" };
}

export function parseGithubPrimaryQuota(headers: GithubHeaderReader): GithubPrimaryQuota | null {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const used = headers.get("x-ratelimit-used");
  const reset = headers.get("x-ratelimit-reset");
  const resource = headers.get("x-ratelimit-resource");
  if (limit === null && remaining === null && reset === null) return null;
  const resetSeconds = reset !== null ? Number(reset) : Number.NaN;
  return {
    limit: limit !== null ? Number(limit) : null,
    remaining: remaining !== null ? Number(remaining) : null,
    used: used !== null ? Number(used) : null,
    reset: Number.isFinite(resetSeconds) ? new Date(resetSeconds * 1000) : null,
    resource
  };
}

/** >= 1 min (offisiell "wait at least one minute"), doblet per paafoelgende brudd, ALDRI uendelig - hardt tak. */
export const FALLBACK_BASE_COOLDOWN_MS = 60_000;
export const FALLBACK_MAX_COOLDOWN_MS = 60 * 60_000;
export const FALLBACK_JITTER_RATIO = 0.2;

export function computeFallbackCooldownMs(consecutiveViolations: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, consecutiveViolations - 1);
  const raw = Math.min(FALLBACK_BASE_COOLDOWN_MS * 2 ** exponent, FALLBACK_MAX_COOLDOWN_MS);
  const jitter = 1 + (random() * 2 - 1) * FALLBACK_JITTER_RATIO;
  return Math.round(Math.min(raw * jitter, FALLBACK_MAX_COOLDOWN_MS));
}

export interface GithubEligibilityDenied {
  eligible: false;
  reason: Exclude<GithubRateLimitState, "NORMAL">;
  retryAt: Date;
  retryAfterSource: GithubRetryAfterSource;
}
export type GithubEligibility = { eligible: true } | GithubEligibilityDenied;

/** §24 - skiller alltid leverandoerens egen timing fra Jarvis sin fallback-policy, aldri det ene fremstilt som det andre. */
export function describeGithubEligibility(denied: GithubEligibilityDenied): string {
  const source = denied.retryAfterSource === "provider" ? "GitHub Retry-After" : "Jarvis fallback-cooldown";
  const scope = denied.reason === "PROVIDER_THROTTLED" ? "GitHub-kall (lesing og mutasjon)" : "GitHub-mutasjoner";
  const label = denied.reason === "PROVIDER_THROTTLED" ? "GitHub primaer rate limit" : "GitHub sekundaer throttling";
  return `${label} oppdaget. ${scope} utsatt til ${denied.retryAt.toISOString()} (${source}).`;
}

/** MUTATION_MIN_INTERVAL_MS=1000 - "wait at least one second between each [mutating] request" (offisiell veiledning). Prosess-lokal serialisering (§14), ikke tverr-prosess. */
const MUTATION_MIN_INTERVAL_MS = 1_000;

class ProcessMutationGate {
  private queue: Promise<unknown> = Promise.resolve();
  private lastMutationAt = 0;

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const wait = MUTATION_MIN_INTERVAL_MS - (Date.now() - this.lastMutationAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        return await fn();
      } finally {
        this.lastMutationAt = Date.now();
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}

export type GithubRateLimitTransition = "entered" | "extended" | "cleared";

/**
 * Sentral beslutningsplass. `checkEligible` avgjoer FOeR nettverkskall om et
 * forsoek er trygt NAA (aldri sleep/busy-wait - synkron DB-lesning +
 * umiddelbart svar, jf. §12). `recordOutcome` klassifiserer og lagrer
 * ETTER hvert forsoek. `runMutation` haandhever prosess-lokal
 * serialisering+avstand for mutasjoner (§14/§7 offisiell veiledning).
 */
export class GithubRateLimitController {
  private readonly mutationGate = new ProcessMutationGate();
  private lastKnownState: GithubRateLimitState = "NORMAL";

  constructor(
    private readonly store: GithubRateLimitStore,
    private readonly credentialRef: string,
    private readonly onTransition?: (event: { transition: GithubRateLimitTransition; state: GithubRateLimitState; retryAt: Date | null; source: GithubRetryAfterSource | null }) => void,
    private readonly clock: () => Date = () => new Date(),
    private readonly random: () => number = Math.random
  ) {}

  async checkEligible(mutation: boolean): Promise<GithubEligibility> {
    const row = await this.store.get(this.credentialRef);
    if (!row) return { eligible: true };
    const now = this.clock();
    if (row.state === "PROVIDER_THROTTLED" && row.cooldownUntil && row.cooldownUntil > now) {
      return { eligible: false, reason: "PROVIDER_THROTTLED", retryAt: row.cooldownUntil, retryAfterSource: row.retryAfterSource ?? "jarvis_fallback" };
    }
    if (mutation && row.state === "MUTATIONS_THROTTLED" && row.cooldownUntil && row.cooldownUntil > now) {
      return { eligible: false, reason: "MUTATIONS_THROTTLED", retryAt: row.cooldownUntil, retryAfterSource: row.retryAfterSource ?? "jarvis_fallback" };
    }
    return { eligible: true };
  }

  async recordOutcome(mutation: boolean, status: number, headers: GithubHeaderReader, rawBody: string): Promise<GithubResponseClassification> {
    const classification = classifyGithubResponse(status, headers, rawBody);
    const quota = parseGithubPrimaryQuota(headers);
    if (classification.kind === "OK") {
      await this.store.recordSuccess(this.credentialRef, mutation, quota);
      if (mutation) this.emitTransition("cleared", "NORMAL", null, null);
      return classification;
    }
    if (classification.kind === "PRIMARY_RATE_LIMIT") {
      await this.store.recordViolation(this.credentialRef, "PROVIDER_THROTTLED", classification.retryAt, "provider", quota);
      this.emitTransition(this.lastKnownState === "PROVIDER_THROTTLED" ? "extended" : "entered", "PROVIDER_THROTTLED", classification.retryAt, "provider");
      return classification;
    }
    if (classification.kind === "SECONDARY_RATE_LIMIT") {
      const priorRow = await this.store.get(this.credentialRef);
      const violations = (priorRow?.consecutiveViolations ?? 0) + 1;
      const source: GithubRetryAfterSource = classification.retryAfterMs !== null ? "provider" : "jarvis_fallback";
      const retryAt = classification.retryAfterMs !== null
        ? new Date(this.clock().getTime() + classification.retryAfterMs)
        : new Date(this.clock().getTime() + computeFallbackCooldownMs(violations, this.random));
      await this.store.recordViolation(this.credentialRef, "MUTATIONS_THROTTLED", retryAt, source, quota);
      this.emitTransition(this.lastKnownState === "MUTATIONS_THROTTLED" ? "extended" : "entered", "MUTATIONS_THROTTLED", retryAt, source);
      return classification;
    }
    // PERMISSION_403 / OTHER: aldri et rate-limit-signal - tilstand uroert.
    return classification;
  }

  runMutation<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutationGate.run(fn);
  }

  private emitTransition(transition: GithubRateLimitTransition, state: GithubRateLimitState, retryAt: Date | null, source: GithubRetryAfterSource | null): void {
    if (transition === "cleared" && this.lastKnownState === "NORMAL") return; // ingen spam - kun ekte overganger
    this.lastKnownState = state;
    this.onTransition?.({ transition, state, retryAt, source });
  }
}

/** Kaster foer noe nettverkskall gjoeres - Jarvis sin egen pre-flight-avvisning, aldri et ekte GitHub-svar. */
export class GithubRateLimitedError extends Error {
  constructor(
    readonly scope: Exclude<GithubRateLimitState, "NORMAL">,
    readonly retryAt: Date,
    readonly retryAfterSource: GithubRetryAfterSource
  ) {
    super(`github_rate_limited:${scope}:retry_at=${retryAt.toISOString()}:source=${retryAfterSource}`);
    this.name = "GithubRateLimitedError";
  }
}
