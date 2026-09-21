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
 */
export async function withDomainAdvisoryLocks<T>(pool: pg.Pool, domains: readonly string[], fn: () => Promise<T>): Promise<T> {
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
