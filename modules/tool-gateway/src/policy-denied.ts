/**
 * WP-G1c (D-481, JARVIS-112 g4): et POLICY-AVSLAG kastet fra en transport er Jarvis' EGEN beslutning (f.eks. «mottakeren er avmeldt», «taket er nådd», «kontoen er ikke autorisert») - ikke en leverandørfeil. Tidligere ble alle transportfeil
 * klassifisert i connector-helse ut fra teksten (`/401|403|auth/` -> `auth_failed`, `/429|rate/` -> `rate_limited`, ellers `unavailable`), så et vanlig policy-avslag kunne få en frisk connector til å se syk ut (og utløse «Tilkobling svikter»).
 * `PolicyDeniedError` gir avslaget en EGEN klasse: ToolGateway lar connector-helsen være uberørt. Alt annet (resultat til kalleren, ledger, audit, feilmeldingen) er uendret - meldingen er nøyaktig den samme som før.
 *
 * Kun den TYPEDE feilen er unntatt: en vanlig `Error` med en policy-lignende tekst klassifiseres som før (ingen omklassifisering på tekst). Merket er et globalt symbol, så kontrollen virker også om to kopier av pakken skulle lastes.
 */
export const POLICY_DENIED_BRAND = Symbol.for("jarvis.tool-gateway.policy-denied");

export class PolicyDeniedError extends Error {
  readonly [POLICY_DENIED_BRAND] = true as const;

  /** `message` er den FULLE meldingen kalleren og ledgeren ser (f.eks. `comms_policy_denied:recipient_opted_out`): uendret fra før, kun typen er ny. */
  constructor(message: string) {
    super(message);
    this.name = "PolicyDeniedError";
  }
}

/** Er feilen et typet policy-avslag? Aldri sann for en vanlig feil eller en verdi som ikke er en feil. */
export function isPolicyDenied(err: unknown): err is PolicyDeniedError {
  return typeof err === "object" && err !== null && (err as Record<symbol, unknown>)[POLICY_DENIED_BRAND] === true;
}
