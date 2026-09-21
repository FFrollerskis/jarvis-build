import type { SelfModificationRisk } from "./types.ts";

/**
 * Task #121 (D-214): den ENESTE veien til `zero_review` - et navngitt,
 * skjemavalidert (PersonalityConfigSchema) konfig-lag, ALDRI kildekode.
 * Utvidelse av denne listen er BEVISST en egen, fremtidig, gjennomgått
 * kodeendring - ALDRI noe en kjørende Jarvis-prosess selv kan legge til.
 */
export const ZERO_REVIEW_ALLOWLIST: ReadonlySet<string> = new Set(["config/charlie-personality.json"]);

/**
 * Task #121 (D-214): ALDRI tilgjengelig for selvendring, uansett
 * godkjenning - dekker nøyaktig den koden CLAUDE.md regel #2 krever skal
 * håndheve kritiske handlinger deterministisk (Policy Gateway/owner-controls/
 * ToolGateway sin kjerne-pipeline), pluss CI/migrasjoner/avhengigheter/
 * hemmeligheter/git-historikk-sensitive filer - EN endring her, selv en
 * "liten", er nøyaktig den scope-utvidelsen D-208 eksplisitt avslo å bygge
 * uten eier-gjennomgang. `forbidden` VINNER ALLTID over `zero_review`/
 * `requires_approval` når en diff blander filer (se classifySelfModification).
 */
export const FORBIDDEN_PATH_PATTERNS: readonly RegExp[] = [
  /^modules\/policy\//,
  /^modules\/owner-controls\//,
  /^modules\/self-modification\//,
  /^modules\/tool-gateway\/src\/gateway\.ts$/,
  /^modules\/core\/src\/db\/migrations\//,
  /^\.github\//,
  /^infra\//,
  /(^|\/)package\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)pnpm-workspace\.yaml$/,
  /^\.env/,
  /^docs\/security\//,
  /CLAUDE\.md$/
];

/**
 * Rene, side-effektfrie klassifisering - INGEN I/O, INGEN LLM-vurdering.
 * Dette er selve håndhevingsmekanismen CLAUDE.md regel #2 krever for en
 * kritisk handling (her: hva som overhodet får LOV til å nå
 * zero-review-sporet) - en modell "vurderer" ALDRI dette, koden avgjør det
 * deterministisk hver gang.
 *
 * Rekkefølge, med hensikt:
 *   1. Tom diff -> `forbidden` (ingenting å klassifisere som trygt).
 *   2. ETHVERT forbudt mønster tilstede -> `forbidden`, UANSETT hva andre
 *      filer i SAMME diff er - forbud vinner alltid over tillatelse
 *      (fail-closed, aldri "blandet er OK fordi én fil var trygg").
 *   3. ALLE endrede stier er EKSAKT i zero-review-allowlisten -> `zero_review`.
 *   4. Alt annet (ingen forbudte stier, men minst én sti utenfor
 *      allowlisten) -> `requires_approval`.
 */
export function classifySelfModification(changedPaths: readonly string[]): SelfModificationRisk {
  if (changedPaths.length === 0) {
    return "forbidden";
  }
  const normalized = changedPaths.map(normalizePath);
  if (normalized.some((p) => FORBIDDEN_PATH_PATTERNS.some((rx) => rx.test(p)))) {
    return "forbidden";
  }
  if (normalized.every((p) => ZERO_REVIEW_ALLOWLIST.has(p))) {
    return "zero_review";
  }
  return "requires_approval";
}

/**
 * Fail-closed sti-normalisering: en `../`-utbryting, en ledende `/`, eller en
 * absolutt sti skal ALDRI kunne late som den er en ufarlig relativ repo-sti -
 * `FORBIDDEN_PATH_PATTERNS`/`ZERO_REVIEW_ALLOWLIST` sammenlignes alltid mot
 * denne normaliserte formen, aldri den rå, potensielt villedende inndataen.
 * En sti som IKKE kan normaliseres trygt (fortsatt inneholder `..` etter
 * normalisering, eller er absolutt) klassifiseres BEVISST som om den
 * matchet et forbudt mønster (tom streng matcher ingen `ZERO_REVIEW_
 * ALLOWLIST`-oppføring og faller derfor til `requires_approval` med mindre
 * en forbudt sti også er tilstede) - se testene for det eksplisitte beviset.
 */
function normalizePath(rawPath: string): string {
  const collapsed = rawPath.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (collapsed.startsWith("/") || collapsed.includes("..")) {
    return "\0invalid-path";
  }
  return collapsed.replace(/^\.\//, "");
}
