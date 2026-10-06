import { join } from "node:path";
import type pg from "pg";
import { ChangeLedger, loadConstitution } from "@jarvis/self-modification";

/**
 * EV-0 (D-411): oppstartssjekk av Safety Constitution og endringsregisteret. KUN OBSERVASJON - sjekken kaster aldri, blokkerer ikke oppstart og
 * endrer ingenting (selvendring er fortsatt frosset, D-397: `SelfModificationService` konstrueres ikke). Den gjør tilstanden synlig i loggen:
 *   - konstitusjonen: verifisert (signatur + festet nøkkel + ikke svekket), eller hvorfor ikke (`constitution_unsigned` ... `constitution_rollback`)
 *   - endringsregisteret: hash-kjeden verifisert (databasen OG uavhengig i TypeScript), ødelagt (første ødelagte seq), eller utilgjengelig
 */
export type ConstitutionBootStatus =
  | { status: "verified"; version: number; digest: string }
  | { status: "not_verified"; code: string };

export type LedgerBootStatus =
  | { status: "ok"; count: number; head_hash: string }
  | { status: "broken"; broken_seq: string | null; count: number }
  | { status: "unavailable"; error: string };

export interface Ev0BootStatus {
  constitution: ConstitutionBootStatus;
  ledger: LedgerBootStatus;
}

export interface Ev0BootInput {
  /** Strukturelt `pg.Pool` - kun `query` brukes. */
  pool: Pick<pg.Pool, "query">;
  /** `JARVIS_CONSTITUTION_PUBKEY_SHA256` - eierens festede nøkkelfingeravtrykk, ALDRI fra repoet. */
  pinnedPublicKeySha256: string | null;
  /** Katalogen med `constitution.v1.json`, `.sig` og `constitution.pub.pem`. */
  configDir: string;
}

let lastBootStatus: Ev0BootStatus | null = null;

/** EV-1 (D-412): siste oppstartsresultat (null før første sjekk) - leses av selvdiagnosen (`constitution`/`ledger`). Kun lesing, aldri en autoritet. */
export function getLastEv0BootStatus(): Ev0BootStatus | null {
  return lastBootStatus;
}

export async function checkEv0Boot(input: Ev0BootInput): Promise<Ev0BootStatus> {
  let constitution: ConstitutionBootStatus;
  try {
    const c = await loadConstitution({
      manifestPath: join(input.configDir, "constitution.v1.json"),
      signaturePath: join(input.configDir, "constitution.v1.sig"),
      publicKeyPath: join(input.configDir, "constitution.pub.pem"),
      pinnedPublicKeySha256: input.pinnedPublicKeySha256
    });
    constitution = { status: "verified", version: c.version, digest: c.digest };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    constitution = { status: "not_verified", code: typeof code === "string" ? code : "constitution_load_failed" };
  }

  let ledger: LedgerBootStatus;
  try {
    const result = await new ChangeLedger(input.pool as pg.Pool).verify();
    ledger = result.ok
      ? { status: "ok", count: result.count, head_hash: result.head_hash }
      : { status: "broken", broken_seq: result.broken_seq, count: result.count };
  } catch (err) {
    ledger = { status: "unavailable", error: (err as Error).message.slice(0, 200) };
  }
  lastBootStatus = { constitution, ledger };
  return lastBootStatus;
}

/** Én JSON-linje pr. del; en ødelagt hash-kjede logges som error (høyt), resten som info/warn. */
export function logEv0Boot(status: Ev0BootStatus, out: Pick<Console, "log" | "warn" | "error"> = console): void {
  out[status.constitution.status === "verified" ? "log" : "warn"](JSON.stringify({ msg: "ev0_constitution_boot", ...status.constitution }));
  out[status.ledger.status === "ok" ? "log" : status.ledger.status === "broken" ? "error" : "warn"](
    JSON.stringify({ msg: "ev0_change_ledger_boot", ...status.ledger })
  );
}
