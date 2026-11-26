import { SEMVER } from "./ids.ts";

/**
 * WP-PGA / PG1: minimal semver (MAJOR.MINOR.PATCH) uten ny avhengighet. Brukes av dependency-intervallene i programindeksen (`min`/`max`).
 * Bevisst smalt: ingen prerelease/build, ingen operatorer (^ ~ >=): intervallet er alltid `min` (inklusiv) til `max` (inklusiv, eller en hel familie `M.x` / `M.m.x`).
 */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(value: string): Semver | null {
  if (typeof value !== "string" || !SEMVER.test(value)) return null;
  const [major, minor, patch] = value.split(".").map(Number) as [number, number, number];
  return { major, minor, patch };
}

export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export type MaxBound = { kind: "exact"; major: number; minor: number; patch: number } | { kind: "major"; major: number } | { kind: "minor"; major: number; minor: number };

const NUM = "(0|[1-9]\\d{0,5})";
const MAJOR_X = new RegExp(`^${NUM}\\.x$`);
const MINOR_X = new RegExp(`^${NUM}\\.${NUM}\\.x$`);

/** `1.2.3` (eksakt, inklusiv), `1.x` (alle 1.*) eller `1.2.x` (alle 1.2.*). Alt annet er null. */
export function parseMax(value: string): MaxBound | null {
  if (typeof value !== "string") return null;
  const exact = parseSemver(value);
  if (exact !== null) return { kind: "exact", ...exact };
  const major = MAJOR_X.exec(value);
  if (major !== null) return { kind: "major", major: Number(major[1]) };
  const minor = MINOR_X.exec(value);
  if (minor !== null) return { kind: "minor", major: Number(minor[1]), minor: Number(minor[2]) };
  return null;
}

function withinMax(v: Semver, max: MaxBound): boolean {
  switch (max.kind) {
    case "exact":
      return compareSemver(v, max) <= 0;
    case "major":
      return v.major <= max.major;
    case "minor":
      return v.major < max.major || (v.major === max.major && v.minor <= max.minor);
  }
}

export interface VersionRange {
  min: string;
  max: string;
}

/** Ligger `version` i [min, max]? False (aldri kast) for enhver ugyldig verdi. */
export function satisfiesRange(version: string, range: VersionRange): boolean {
  const v = parseSemver(version);
  const min = parseSemver(range.min);
  const max = parseMax(range.max);
  if (v === null || min === null || max === null) return false;
  return compareSemver(v, min) >= 0 && withinMax(v, max);
}

/** Er intervallet selv gyldig (begge deler parser, og `min` ligger ikke over øvre grense)? */
export function rangeIsValid(range: VersionRange): boolean {
  const min = parseSemver(range.min);
  const max = parseMax(range.max);
  if (min === null || max === null) return false;
  return withinMax(min, max);
}
