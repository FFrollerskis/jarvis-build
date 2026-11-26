import { REQUIRED_PROTECTED_PROBES, type EvChangeClass } from "../constitution.ts";
import { isInvalidPathKey, protectionKey } from "../policy.ts";
import { maxClass, sensitiveTouches } from "./common.ts";

/**
 * WP-EV0 (HF2 kap. 7, H2-0.2): hva slags endring et forslag er. Typen gir et GULV for E-klassen som kode (ikke modellen) håndhever:
 *   - prompt, personlighet og ruting er atferdsendringer: minst E1 (canary) - aldri E0 auto-production;
 *   - skjema, avhengighet, credential, nettverk og beskyttet-nær: minst E2 (eier signerer);
 *   - kode og konfig har ingen typebasert heving: klassen følger stiene (en kode-diff er aldri E0, se `Constitution.classify`).
 * Gulvet kan aldri senkes av stiene eller den hevdede klassen, og typer som stiene avslører heves uansett hva forslaget hevder (`derivedKindsFromPaths`).
 * Utrullingsporten (`decideRelease`) bruker SAMME tabell, så forslag og utrulling aldri er uenige om hva en type krever.
 */
export const CHANGE_KINDS = ["prompt", "personality", "routing", "config", "code", "schema", "dependency", "credential", "network", "protected-adjacent"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const KIND_MINIMUM_CLASS: Readonly<Record<ChangeKind, EvChangeClass>> = Object.freeze({
  prompt: "E1",
  personality: "E1",
  routing: "E1",
  config: "E0",
  code: "E0",
  schema: "E2",
  dependency: "E2",
  credential: "E2",
  network: "E2",
  "protected-adjacent": "E2"
});

export function isChangeKind(value: unknown): value is ChangeKind {
  return typeof value === "string" && Object.hasOwn(KIND_MINIMUM_CLASS, value);
}

/** Gulvet for en type. En UKJENT type er E3 (fail-closed): den kan aldri slippe gjennom som en lavere klasse. */
export function minimumClassForKind(kind: unknown): EvChangeClass {
  return isChangeKind(kind) ? KIND_MINIMUM_CLASS[kind] : "E3";
}

export function minimumClassForKinds(kinds: readonly unknown[]): EvChangeClass {
  return kinds.reduce<EvChangeClass>((acc, kind) => maxClass(acc, minimumClassForKind(kind)), "E0");
}

const parentDir = (key: string): string => {
  const i = key.lastIndexOf("/");
  return i === -1 ? "" : key.slice(0, i);
};

/** Katalogene som inneholder en påkrevd sonde: en fil som ligger SIDE OM SIDE med en beskyttet fil er «beskyttet-nær». */
const PROBE_DIRS: ReadonlySet<string> = new Set(
  REQUIRED_PROTECTED_PROBES.map(protectionKey).filter((k) => !isInvalidPathKey(k)).map(parentDir)
);

/**
 * Typene stiene avslører (i typerekkefølgen): skjema (SQL/migrasjoner), avhengighet, credential, nettverk og beskyttet-nær (samme katalog som en sonde).
 * En sti som ikke kan normaliseres trygt regnes som beskyttet-nær. Brukes til å heve klassen når forslaget hevder en svakere type, aldri til å senke den.
 */
export function derivedKindsFromPaths(paths: readonly string[]): ChangeKind[] {
  const found = new Set<ChangeKind>();
  const touches = sensitiveTouches(paths);
  if (touches.dependencies) found.add("dependency");
  if (touches.credentials) found.add("credential");
  if (touches.network) found.add("network");
  if (touches.migrations) found.add("schema");
  for (const key of paths.map(protectionKey)) {
    if (isInvalidPathKey(key)) {
      found.add("protected-adjacent");
      continue;
    }
    if (/\.sql$/.test(key) || /(^|\/)migrations\//.test(key)) found.add("schema");
    if (PROBE_DIRS.has(parentDir(key))) found.add("protected-adjacent");
  }
  return CHANGE_KINDS.filter((k) => found.has(k));
}
