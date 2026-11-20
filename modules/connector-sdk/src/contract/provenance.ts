import type { AdapterKind } from "./types.ts";

/**
 * WP-I (D-472), review N3: PROVENIENS-BRANDEN for `adapter_kind`. Et felt på adapteren (`adapter_kind: "real_transport"`) er bare en PÅSTAND, og en påstand kan kopieres: `{ ...fake, adapter_kind: "real_transport" }`
 * ga før `proven` for en fake bygget fra manifestet. Derfor teller `real_transport` kun for et objekt som er MERKET (identitet i et `WeakSet` som bare denne modulen eier): en kopi (spread, `Object.create`, `Proxy`,
 * `Object.assign`) er et NYTT objekt og er aldri merket, og det er ikke noe felt eller symbol å kopiere.
 *
 * Denne modulen er BEVISST IKKE eksportert fra noen inngang (verken `src/index.ts`, `src/testing.ts` eller `src/contract/index.ts`; `exports`-kartet i package.json stenger dypimport utenfra, og `test/testing-split.test.ts` låser det):
 * `brandRealTransportAdapter` er ment å kalles av nøyaktig én ting - broen fra en ekte `ToolTransport` til `ContractAdapter` bak en fake leverandørserver (`DEFERRED`, runbook §5/§11) - når den bygges INNE i denne pakken.
 * Ingenting kaller den i dag, så ingen adapter kan i dag gi `proven`: det er meningen. Ukjent/manglende/ikke-merket proveniens regnes som den svakere påstanden (`fake_from_manifest`).
 */
const REAL_TRANSPORT_ADAPTERS = new WeakSet<object>();

/** INTERN: merk en adapter som en ekte transport-bro. Kun for den utsatte broen (og provenienstesten); aldri re-eksportert. */
export function brandRealTransportAdapter<T extends object>(adapter: T): T {
  REAL_TRANSPORT_ADAPTERS.add(adapter);
  return adapter;
}

/** Hva slags adapter beviset ble laget mot. `real_transport` krever BÅDE feltet og merket; alt annet (også en `null`/ikke-objekt) er `fake_from_manifest`. */
export function adapterKindOf(adapter: unknown): AdapterKind {
  if (typeof adapter !== "object" || adapter === null) return "fake_from_manifest";
  return (adapter as { adapter_kind?: unknown }).adapter_kind === "real_transport" && REAL_TRANSPORT_ADAPTERS.has(adapter) ? "real_transport" : "fake_from_manifest";
}
