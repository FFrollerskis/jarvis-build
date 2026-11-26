#!/usr/bin/env node
// WP-PGA / PG3 (D-PROG-08): registrerer en porteovergang (programport G01-G17 eller ORL0-ORL5) mot en evidensfil som `ops/acceptance/record-evidence.mjs` har skrevet. Samme mønster som
// evidens-opptakeren: én kommando, ingen skall, tydelige exit-koder. Selve logikken ligger i `packages/contracts/src/program/gate-recorder.ts`; dette er kun inngangen (den slipper ikke gjennom
// andre kommandoer enn `gate`).
//
//   node ops/acceptance/record-gate-evidence.mjs <G01..G17|ORL0..ORL5> <PASS|FAIL|OPEN> --reason "tekst" --by <owner|platform_operator>
//        [--evidence docs/evidence/<fil>.md] [--verified-at <ISO>] [--write] [--root <mappe>]
//
// Uten --write er det en tørrkjøring. PASS/FAIL krever en evidensfil; OPEN (gjenåpning) tillater ingen. En PASS som er blitt foreldet gjenåpnes først, og får så ny evidens (to overganger).
// Registreringen nekter evidens som er eldre enn en bundet komponents siste kontraktendring. Exit: 0 = ok (evt. tørrkjøring), 1 = nektet, 2 = bruksfeil.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const CLI = join(ROOT, "packages", "contracts", "scripts", "program-index.ts");
const GATE_ID = /^(?:G(?:0[1-9]|1[0-7])|ORL[0-5])$/;
const USAGE = [
  "bruk: node ops/acceptance/record-gate-evidence.mjs <G01..G17|ORL0..ORL5> <PASS|FAIL|OPEN> --reason \"tekst\" --by <owner|platform_operator>",
  "        [--evidence docs/evidence/<fil>.md] [--verified-at <ISO>] [--write] [--root <mappe>]"
].join("\n");

/** Valider de to første argumentene her (så inngangen aldri kjører noe annet enn `gate`); resten validerer kommandolinjen selv. Returnerer argumentlisten eller null. */
export function gateArgs(argv) {
  const [gate, status, ...rest] = argv;
  if (typeof gate !== "string" || !GATE_ID.test(gate)) return null;
  if (status !== "PASS" && status !== "FAIL" && status !== "OPEN") return null;
  return ["gate", gate, status, ...rest];
}

export function run(argv) {
  const args = gateArgs(argv);
  if (args === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  // Ingen skall: argumentene sendes som en liste, så anførselstegn/semikolon i begrunnelsen blir bokstavelig tekst.
  const result = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", CLI, ...args], { stdio: "inherit", shell: false });
  if (result.error !== undefined) {
    process.stderr.write(`kunne ikke starte kommandolinjen: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
