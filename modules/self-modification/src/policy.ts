import type { SelfModificationRisk } from "./types.ts";

/** Sentinel for «kan ikke normaliseres trygt». Inneholder NUL, som aldri finnes i en gyldig nøkkel. */
export const INVALID_PATH_KEY = "\0invalid-path";

export function isInvalidPathKey(key: string): boolean {
  return key === INVALID_PATH_KEY;
}

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
 *
 * WP-EV0: alle mønstre matches mot `protectionKey(sti)` (små bokstaver, NFKC, ingen `.`-segmenter/etterfølgende punktum) - se der. Hvert mønster MÅ
 * dekkes av minst én sonde i `REQUIRED_PROTECTED_PROBES` (constitution.ts; testet), så et mønster ikke kan fjernes uten at en test feiler.
 */
export const FORBIDDEN_PATH_PATTERNS: readonly RegExp[] = [
  /^modules\/policy\//i,
  /^modules\/owner-controls\//i,
  /^modules\/self-modification\//i,
  // ToolGateway sin kjerne-pipeline, klasse D-kjeden (D-/penge-/modellflate-definisjonene): kun de NAVNGITTE filene, ikke hele katalogen (C5b).
  /^modules\/tool-gateway\/src\/(gateway|class-d-pipeline|finance-class-d|model-tool-surface)\.ts$/i,
  /^modules\/core\/src\/db\/migrations\//i,
  /^\.github\//i,
  /^infra\//i,
  /(^|\/)package\.json$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)pnpm-workspace\.yaml$/i,
  /^\.env/i,
  /^docs\/security\//i,
  /^docs\/remediation\//i,
  // Styrende dokumenter (sikkerhetsmodell og kanonisk spesifikasjon): motoren kan ikke skrive om reglene den selv styres av.
  /^docs\/(security_model|canonical_spec)\.md$/i,
  /^config\/evolution\//i,
  /^config\/program\//i,
  /^ops\/(security|break-glass|backup|job-runner|claude-worker)\//i,
  /CLAUDE\.md$/i,
  // WP-EV0 (HF2 kap. 5, Authority Plane): step-up for eier-kontroll, revisjonsintegritet, godkjenningslager, identitets-/sesjons-/enhetsautoritet,
  // databasens tenant-kontekst og den metrikk-avledede confidence-gaten. Kun navngitte filer (vanlig kode ellers er E2, ikke E3).
  /^apps\/api\/src\/step-up\.ts$/i,
  /^modules\/core\/src\/services\/(audit-writer|policy-audit-sink|approval-store|identity-service|session-grant-service|device-authority|channel-session-authority|voice-session-authority|telegram-owner-authority|runtime-role)\.ts$/i,
  /^modules\/core\/src\/db\/pool\.ts$/i,
  /^modules\/executive\/src\/self-model\/confidence-gate\.ts$/i
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
  // WP-EV0: en sti som ikke kan normaliseres trygt (`..`, absolutt, kolon, kontrolltegn ...) er FORBUDT (ikke «krever godkjenning»): eieren skal aldri
  // få et godkjenn-valg på en endring som kan skjule en beskyttet fil. Forbudt-mønstrene matches mot den foldede beskyttelsesnøkkelen.
  const keys = changedPaths.map(protectionKey);
  if (keys.some((k) => isInvalidPathKey(k) || FORBIDDEN_PATH_PATTERNS.some((rx) => rx.test(k)))) {
    return "forbidden";
  }
  // Allowlisten er EKSAKT (store/små bokstaver teller): kun nøyaktig den navngitte filen kan nå zero_review.
  const normalized = changedPaths.map(normalizeChangedPath);
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
 * normalisering, eller er absolutt) får sentinelen `INVALID_PATH_KEY`, som
 * aldri er i allowlisten. WP-EV0: `classifySelfModification` behandler en slik
 * sti som `forbidden` (via `protectionKey`) - tidligere falt den bare til
 * `requires_approval`, mens kommentaren hevdet forbudt. Se testene.
 */
export function normalizeChangedPath(rawPath: string): string {
  const collapsed = rawPath.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (collapsed.startsWith("/") || collapsed.includes("..")) {
    return INVALID_PATH_KEY;
  }
  return collapsed.replace(/^\.\//, "");
}

/**
 * WP-EV0: kanonisk nøkkel for BESKYTTELSESSJEKKER (forbudt-mønstre og manifest-regler). Bevisst strengere enn `normalizeChangedPath`: over-treff er
 * den sikre siden (E3), så nøkkelen lar ikke en endring slippe unna ved å se annerledes ut:
 *   - NFKC FØRST (fullbredde `．．`/`／`, Kelvin-tegnet, lang s osv. foldes til det de ligner), deretter små bokstaver (case-insensitivt filsystem på Windows/macOS);
 *   - `\` blir `/`; `.`-segmenter og doble skråstreker forsvinner (`a/./b` = `a/b`); etterfølgende punktum/mellomrom pr. segment strippes (Windows-alias);
 *   - UGYLDIG (`INVALID_PATH_KEY`): `..` hvor som helst, absolutt/`~`, kolon (stasjonsbokstav, NTFS-datastrøm), NUL/kontrolltegn, 8.3-kortnavn (`~1`) og tom sti.
 * Kun for beskyttelse: zero-review-allowlisten bruker fortsatt `normalizeChangedPath` (eksakt, store/små bokstaver teller), så en annen skrivemåte
 * kan aldri gi en LØSERE klasse enn en beskyttet.
 */
export function protectionKey(rawPath: string): string {
  const folded = rawPath.normalize("NFKC");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(folded) || folded.includes(":") || folded.includes("..")) return INVALID_PATH_KEY;
  const slashed = folded.replace(/\\/g, "/");
  if (slashed.startsWith("/") || slashed.startsWith("~")) return INVALID_PATH_KEY;
  const trailingSlash = slashed.endsWith("/");
  const segments: string[] = [];
  for (const raw of slashed.split("/")) {
    const segment = raw.replace(/[. ]+$/, "");
    if (segment === "") continue;
    if (/~\d/.test(segment)) return INVALID_PATH_KEY;
    segments.push(segment);
  }
  if (segments.length === 0) return INVALID_PATH_KEY;
  return `${segments.join("/")}${trailingSlash ? "/" : ""}`.toLowerCase();
}
