import type pg from "pg";

/**
 * Arkitekt-review runde 3 (PR #85) Funn 1+2: den "autoritative transaksjonelle"
 * domene-pause-sjekken fra runde 2 var FORTSATT racy - en SELECT mot
 * `situation_domain_pauses` LÅSER IKKE fraværet av en rad, og selve
 * `gateway.execute()`-kallet skjer UTENFOR claim-transaksjonen (etter at
 * den allerede har committet) - en `pauseDurable()` kunne derfor committe
 * MELLOM sjekken og selve det eksterne kallet, uten noen effekt på et
 * ALLEREDE claimet `actOn()`-forsøk.
 *
 * Denne modulen gir EKTE, tvers-av-prosess GJENSIDIG UTELUKKELSE via
 * Postgres sine session-nivå advisory locks (`pg_advisory_lock`/
 * `pg_advisory_unlock`, nøkkel = `hashtext(domenenavn)`) - IKKE en
 * applikasjons-nivå "sjekk-så-skriv" som alltid kan race. `SituationEngine.
 * actOn()`/`releaseStuckActClaim()` HOLDER låsen for domenet (+ `ALL_DOMAINS`)
 * gjennom HELE sin kritiske seksjon (pause-sjekk -> claim -> selve det
 * eksterne kallet -> persistering), OG `DomainPauseRegistry.pauseDurable()`/
 * `unpauseDurable()` tar SAMME lås FØR de skriver - de to kan derfor ALDRI
 * kjøre samtidig for samme domene: enten er en pause-mutasjon FERDIG (og
 * synlig) FØR en `actOn()` i det hele tatt får lov til å fortsette forbi
 * sin egen pause-sjekk, ELLER en pause-mutasjon MÅ vente til et allerede
 * PÅBEGYNT `actOn()`-forsøk er helt ferdig (uansett utfall) FØR den selv
 * kan committes.
 *
 * Låser TAS ALLTID i SAMME rekkefølge på tvers av ALLE kallesteder (det
 * spesifikke domenet FØRST, deretter `ALL_DOMAINS` - se service.ts/
 * domain-pause.ts) for å gjøre en deadlock STRUKTURELT umulig: ingen kaller
 * venter noensinne på en lås en ANNEN kaller selv holder mens den ØNSKER en
 * lås DENNE kalleren allerede holder.
 *
 * WP-G4 fiks-runde (A-MEDIUM-5, ARVET dødlås): hver kaller holdt ÉN pool-forbindelse for sesjonslåsene - også mens den VENTET på dem. Pool max 10 uten connectionTimeout: noen få samtidige ventere (to
 * `pause_domain` mot én pågående `actOn`) tømte poolen, og `actOn` fikk aldri en forbindelse til sine egne spørringer (reviewer-probe R4: pool på 3 = dødlås). Den delte poolen røres IKKE. I stedet begrenser en
 * PROSESS-LOKAL semafor (per pool) hvor mange kallere som har en forbindelse samtidig til `max(1, floor(poolMax/2) - 1)`; resten venter i en FIFO-kø UTEN forbindelse (begrenset ventetid og køstørrelse: raskt
 * `DomainLockBusyError`, «ikke utført, prøv igjen»). Selve låsene er uendret blokkerende gjensidig utelukkelse mellom `actOn` og pause/binding. Begrensning (ærlig): semaforen gjelder innen ÉN prosess.
 */
export class DomainLockBusyError extends Error {
  constructor(public readonly reason: "wait_timeout" | "queue_full") {
    super(`domain_lock_busy:${reason}`);
    this.name = "DomainLockBusyError";
  }
}

/** Standard ventetid på en plass før `DomainLockBusyError("wait_timeout")`. */
export const DEFAULT_LOCK_WAIT_MS = 30_000;
/** Maks ventere i køen; kall nummer MAX+1 avvises umiddelbart (`queue_full`). */
export const MAX_LOCK_WAITERS = 100;

interface LockGate {
  cap: number;
  active: number;
  waiters: Array<{ grant: () => void; timer: NodeJS.Timeout }>;
}
const gates = new WeakMap<pg.Pool, LockGate>();

/** Kapasiteten for en pool: `max(1, floor(max/2) - 1)` (ukjent størrelse = pg-standard 10). Eksportert for test/diagnostikk. */
export function domainLockCapacity(pool: pg.Pool): number {
  return gateFor(pool).cap;
}

function gateFor(pool: pg.Pool): LockGate {
  let gate = gates.get(pool);
  if (gate === undefined) {
    const max = Number((pool as unknown as { options?: { max?: unknown } }).options?.max);
    const poolMax = Number.isFinite(max) && max > 0 ? max : 10;
    gate = { cap: Math.max(1, Math.floor(poolMax / 2) - 1), active: 0, waiters: [] };
    gates.set(pool, gate);
  }
  return gate;
}

/** Tar en plass (venter UTEN forbindelse hvis full) og gir tilbake frigjøringen. En plass overdras direkte til første ventende (aktiv teller uendret), ellers telles den ned. */
async function acquireSlot(pool: pg.Pool, waitMs: number): Promise<() => void> {
  const gate = gateFor(pool);
  const release = (): void => {
    const next = gate.waiters.shift();
    if (next !== undefined) {
      clearTimeout(next.timer);
      next.grant();
    } else {
      gate.active -= 1;
    }
  };
  if (gate.active < gate.cap) {
    gate.active += 1;
    return release;
  }
  if (gate.waiters.length >= MAX_LOCK_WAITERS) throw new DomainLockBusyError("queue_full");
  await new Promise<void>((resolve, reject) => {
    const waiter = {
      grant: resolve,
      timer: setTimeout(() => {
        const index = gate.waiters.indexOf(waiter);
        if (index >= 0) gate.waiters.splice(index, 1);
        reject(new DomainLockBusyError("wait_timeout"));
      }, Math.max(1, waitMs))
    };
    waiter.timer.unref();
    gate.waiters.push(waiter);
  });
  return release;
}

export async function withDomainAdvisoryLocks<T>(pool: pg.Pool, domains: readonly string[], fn: () => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
  const releaseSlot = await acquireSlot(pool, options.waitMs ?? DEFAULT_LOCK_WAIT_MS);
  try {
    return await withConnectionLocks(pool, domains, fn);
  } finally {
    releaseSlot();
  }
}

async function withConnectionLocks<T>(pool: pg.Pool, domains: readonly string[], fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    for (const domain of domains) {
      await client.query("SELECT pg_advisory_lock(hashtext($1)::bigint)", [domain]);
    }
    return await fn();
  } finally {
    for (const domain of domains) {
      // D-222: tidligere `.catch(() => undefined)` - en unlock-feil (f.eks. en
      // droppet tilkobling midt i sekvensen) forsvant sporløst, OG klienten ble
      // likevel returnert til poolen med låsen fortsatt holdt av den
      // underliggende session-tilkoblingen - et fremtidig gjenbruk av SAMME
      // pooled tilkobling kunne da se en lås som aldri slippes, uten at NOEN
      // logglinje noensinne pekte mot hvorfor. Samme "isolasjon uendret, kun
      // stillheten fikset"-mønster som D-218/D-221.
      await client.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [domain]).catch((err) => {
        console.error(JSON.stringify({
          msg: "domain_advisory_unlock_failed",
          domain,
          error: err instanceof Error ? err.message : String(err)
        }));
      });
    }
    client.release();
  }
}
