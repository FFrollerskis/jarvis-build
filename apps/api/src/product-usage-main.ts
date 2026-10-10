// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
//
// WP-D2 (UA-3 «churn/product usage»): EIERENS CLI for produktbruk på NAS-en - CSV/JSONL-import, kontooversikt, kobling konto -> selskap og «glem bruker».
// Logikken ligger i `product-usage-cli.ts`; denne filen er kun prosess-inngangen. Kjører med RUNTIME-rollen (NOSUPERUSER NOBYPASSRLS - RLS og CHECK-ene i 090 gjelder),
// aldri admin: starten feiler lukket hvis rollen omgår RLS. Alt som skriver er en dry-run uten --confirm.
//
// Bruk (på NAS, fra repoets rot - kjører i `migrate`-tjenesten som har runtime-rollens påloggingsopplysninger; filen sendes på stdin, ingen volummontering):
//   ops/nas/product-usage.sh import --tenant tenant-kundeoppfolging --format csv --label 2026-10 < bruk.csv              # dry-run
//   ops/nas/product-usage.sh import --tenant tenant-kundeoppfolging --format csv --label 2026-10 --confirm < bruk.csv
//   ops/nas/product-usage.sh accounts --tenant tenant-kundeoppfolging --unlinked
//   ops/nas/product-usage.sh link --tenant tenant-kundeoppfolging --account <konto-ref> --company <company_id> --confirm
//
// Direkte (utvikling):
//   node --experimental-transform-types src/product-usage-main.ts import --tenant <tenant-id> --format jsonl --label test < bruk.jsonl
import "./normalize-env.ts";
import { assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { USAGE_LIMITS } from "@jarvis/business";
import { ownerConfigOrExit } from "./owner.ts";
import { runProductUsageCli } from "./product-usage-cli.ts";

/** Leser stdin med HARD grense (avbryter så snart grensen er passert - aldri hele filen i minnet først). Kaster `file_too_large`. */
async function readStdin(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new Error("file_too_large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const owner = ownerConfigOrExit();
assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
try {
  await assertRuntimeRoleSafe(pool);
  process.exitCode = await runProductUsageCli(
    process.argv.slice(2),
    { owner_person_id: owner.owner_person_id },
    pool,
    {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      readStdin: (max) => readStdin(Math.min(max, USAGE_LIMITS.import_max_bytes))
    }
  );
} catch (err) {
  console.error(`feil: ${(err as Error).message}`);
  process.exitCode = 3;
} finally {
  await pool.end();
}
