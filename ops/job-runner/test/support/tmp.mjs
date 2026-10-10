import { mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forceRemoveTree } from "../../lib/fsutil.mjs";

/**
 * WP-C1 (test, A-F9): midlertidige kkkataloger som RYDDES. Testriggen la igjen `/tmp/jr-*`-kataloger etter hver kjøring (reviewer målte ca. 20 000 kataloger / 2,8 GB etter noen suite-kjøringer).
 * Katalogene kan inneholde trær agenten (testen) har gjort uryddelige (modus 000, dypere enn PATH_MAX, ugyldige UTF-8-navn), så rydding bruker runnerens egen `forceRemoveTree`.
 *
 *  - `makeTempDir(prefix)` / `makeTempDirSync(prefix)`: lager katalogen og husker den. Ryddes av `removeTemp(dir)` (f.eks. i `close()`), og ellers av `afterAll` for testfilen.
 *  - Importeres fra en prosess uten vitest-kontekst (f.eks. `serve.mjs`, som egen prosess), feiler `afterAll`-registreringen stille: da ryddes katalogene av `close()`.
 */

/** @type {Set<string>} */
const dirs = new Set();

/** @param {string} prefix */
export async function makeTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.add(dir);
  return dir;
}

/** @param {string} prefix */
export function makeTempDirSync(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.add(dir);
  return dir;
}

/** Fjerner katalogen nå (idempotent; feil svelges - opprydding skal aldri velte en test). @param {string} dir */
export async function removeTemp(dir) {
  dirs.delete(dir);
  await forceRemoveTree(dir).catch(() => undefined);
}

/** Antall kataloger som ikke er ryddet ennå (diagnostikk/tester). */
export const pendingTempDirs = () => dirs.size;

// `vitest` kan IKKE importeres i en vanlig node-prosess (importen kaster) - serve.mjs og token-git-server.mjs kjører som egne barneprosesser og laster også denne filen. Derfor dynamisk import:
// i en vitest-kontekst registreres opprydding ved testfilens slutt (modulen evalueres under innsamlingen), ellers rydder `close()` selv.
try {
  const { afterAll } = await import("vitest");
  afterAll(async () => {
    for (const dir of [...dirs]) await removeTemp(dir);
  });
} catch {
  // ikke i en vitest-kontekst
}
