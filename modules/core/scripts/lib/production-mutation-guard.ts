/**
 * Remediation part 1 / JARVIS-086: the host acceptance scripts run against the REAL compose
 * stack - they rebuild images, force-recreate api/worker, and (d174/K1) toggle the real global and
 * finance kill switches. That is a production mutation, not a test. Every such entry point now
 * refuses to run unless the operator states that intent explicitly, so a copy-pasted command or an
 * automated agent cannot trigger it by accident.
 *
 *   JARVIS_HOST_ACCEPTANCE_CONSENT=I_UNDERSTAND_THIS_MUTATES_THE_LIVE_STACK node --env-file=.env ...
 *
 * (Test/acceptance RUNS are limited to sandbox/test resources by policy - D-41; this guard is the
 * mechanical stop for the scripts that cannot yet target a sandbox compose project.)
 */
export const HOST_ACCEPTANCE_CONSENT_ENV = "JARVIS_HOST_ACCEPTANCE_CONSENT";
export const HOST_ACCEPTANCE_CONSENT_VALUE = "I_UNDERSTAND_THIS_MUTATES_THE_LIVE_STACK";

export class ProductionMutationConsentError extends Error {
  constructor(script: string) {
    super(
      `${script}: refuses to run - this script rebuilds/recreates containers and/or toggles real controls on the LIVE stack. ` +
        `If that is intended, set ${HOST_ACCEPTANCE_CONSENT_ENV}=${HOST_ACCEPTANCE_CONSENT_VALUE} for this one command.`
    );
    this.name = "ProductionMutationConsentError";
  }
}

export function requireProductionMutationConsent(script: string, env: Record<string, string | undefined> = process.env): void {
  if (env[HOST_ACCEPTANCE_CONSENT_ENV] !== HOST_ACCEPTANCE_CONSENT_VALUE) {
    throw new ProductionMutationConsentError(script);
  }
}
