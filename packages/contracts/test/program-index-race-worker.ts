import { createInterface } from "node:readline";
import { recordGate } from "../src/program/gate-recorder.ts";

/**
 * WP-PGA fiks 1 (M1): barneprosess for løpstesten i `program-index-fix1-lock.test.ts`. Ikke en testfil selv. Starter, melder READY, og venter på `GO <epoke-ms>` fra forelderen; spinner til det
 * felles tidspunktet og kaller så `recordGate` (write) én gang. Skriver ÉN JSON-linje med utfallet. To slike prosesser mot samme port er den samtidige registreringen som tapte en oppdatering før låsen.
 *
 * Bruk: node --experimental-transform-types program-index-race-worker.ts <rot> <PASS|FAIL> <evidenssti>
 */
const [root, status, evidencePath] = process.argv.slice(2) as [string, "PASS" | "FAIL", string];

process.stdout.write("READY\n");
const rl = createInterface({ input: process.stdin });
rl.once("line", (line) => {
  const t0 = Number(line.split(" ")[1]);
  while (Date.now() < t0) {
    // spinner til det felles starttidspunktet
  }
  const result = recordGate({
    root,
    gate_id: "G01",
    status,
    evidence_path: evidencePath,
    reason: `løpstest ${status}`,
    by: "owner",
    now: "2026-11-26T14:00:00.000Z",
    git_sha: "b".repeat(40),
    write: true
  });
  process.stdout.write(`${JSON.stringify(result.ok ? { ok: true } : { ok: false, problem: result.problem })}\n`);
  rl.close();
});
