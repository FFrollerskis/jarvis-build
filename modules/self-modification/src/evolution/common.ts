import type { EvChangeClass } from "../constitution.ts";
import { isInvalidPathKey, protectionKey } from "../policy.ts";

/**
 * Evolution (EV-3..EV-10, D-418): felles, RENE byggeklosser. Ingen I/O, ingen LLM, ingen nettverk - kun deterministiske beslutningsregler
 * som Authority Plane / Policy Gateway kan kalle og teste. Ingenting her utfører en endring; det avgjør om en endring FÅR gå videre.
 */
const ORDER: Record<EvChangeClass, number> = { E0: 0, E1: 1, E2: 2, E3: 3 };

/** Strengeste av to klasser (E3 > E2 > E1 > E0). En klasse kan aldri svekkes av en annen vurdering. */
export function maxClass(a: EvChangeClass, b: EvChangeClass): EvChangeClass {
  return ORDER[a] >= ORDER[b] ? a : b;
}

export function atLeast(cls: EvChangeClass, min: EvChangeClass): EvChangeClass {
  return maxClass(cls, min);
}

export function classRank(cls: EvChangeClass): number {
  return ORDER[cls];
}

/** Stier som berører avhengigheter, credentials, nettverk eller Docker/CI - alltid minst E2 uansett hva en modell anbefaler (plan kap. 10/14). */
const DEPENDENCY_PATH = /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|yarn\.lock|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$/i;
const CREDENTIAL_PATH = /(^|\/)(\.env[^/]*|[^/]*secret[^/]*|[^/]*credential[^/]*|[^/]*\.(pem|key|p12))$/i;
const NETWORK_PATH = /(^|\/)(infra\/|nginx|caddy|traefik|tailscale|firewall|cloudflared)/i;
const WORKFLOW_PATH = /^\.github\//;

export interface SensitiveTouch {
  dependencies: boolean;
  credentials: boolean;
  network: boolean;
  ci: boolean;
  migrations: boolean;
  /** WP-EV0: minst én sti kan ikke normaliseres trygt (`..`, absolutt, kolon, kontrolltegn ...). Aldri «ufarlig». */
  invalid: boolean;
  any: boolean;
}

/** Sjekkes mot den foldede beskyttelsesnøkkelen (`protectionKey`): store/små bokstaver, `./`, etterfølgende punktum og Unicode-forkledning slipper ikke unna. */
export function sensitiveTouches(paths: readonly string[]): SensitiveTouch {
  const keys = paths.map(protectionKey);
  const norm = keys.filter((k) => !isInvalidPathKey(k));
  const t = {
    dependencies: norm.some((p) => DEPENDENCY_PATH.test(p)),
    credentials: norm.some((p) => CREDENTIAL_PATH.test(p)),
    network: norm.some((p) => NETWORK_PATH.test(p)),
    ci: norm.some((p) => WORKFLOW_PATH.test(p)),
    migrations: norm.some((p) => /\/migrations\/[^/]+\.sql$/.test(p)),
    invalid: keys.some(isInvalidPathKey)
  };
  return { ...t, any: Object.values(t).some(Boolean) };
}

export type SourceTrust = "trusted" | "untrusted" | "quarantined";

/** Kjente selvtillits-/magefølelsesproxyer som aldri er et gyldig «confidence basis» (plan kap. 8/12). */
export const FORBIDDEN_CONFIDENCE_BASES: ReadonlySet<string> = new Set(["model_self_confidence", "self_critique", "llm_judgement_only", "model_says_safe"]);
