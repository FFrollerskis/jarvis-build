/**
 * WP-G4b K1 (Q-75 pkt 11, JARVIS-115 m, D-484): BINDBARHET til autonom ACT er en EGENSKAP PER VERKTØYDEFINISJON, ikke en navnerom-vakt.
 *
 * Bakgrunn: vakten i `modules/situations/src/autonomy-guard.ts` stenger kun de fysiske navnerommene (`home-assistant`, `car`). Alle andre verktøy kunne bindes til et situasjonsdomene og utføres av den autonome
 * sveipe-identiteten - også klasse C uten step-up (`make.run_scenario`, `n8n.activate_workflow`) som kan utløse fysiske effekter via et scenario/en arbeidsflyt. Modellen er nå snudd (DEFAULT-DENY):
 * en handling kan KUN bindes til autonom ACT (og utføres autonomt) hvis DEFINISJONEN selv sier det eksplisitt og med en begrunnelse. Utelatt = ikke bindbar. Det finnes ingen liste i situasjonsmodulen å «huske å oppdatere».
 *
 * Begrunnelsen (`reason`) er obligatorisk og leses av eieren/revieweren: den skal si HVORFOR akkurat denne handlingen trygt kan utføres uten et menneske i løkka (ingen fysisk effekt, ingen mottaker utenfor
 * eieren, Jarvis' egen bokføring ...). `assertManifestInvariants` feller en definisjon som erklærer bindbarhet uten gyldig begrunnelse, i et fysisk navnerom, med effekt pay/control/delete eller med step-up
 * (en autonom identitet har aldri en enhetssignert økt, så bindingen kunne aldri lykkes).
 *
 * Dette er ORTOGONALT til risikoklassene A-D (de styrer HVORDAN en handling utføres: preflight/readback/audit/godkjenning, aldri OM eieren har kapabiliteten, D-41) og til D-160 (eierens valg om klasse D uten
 * step-up utenfor de fysiske navnerommene er IKKE endret her: å åpne en slik handling for binding igjen er én eksplisitt linje på definisjonen, med begrunnelse og en beslutning).
 */
export interface AutonomyBindability {
  /** Hvorfor handlingen trygt kan utføres autonomt (norsk, minst `AUTONOMY_REASON_MIN_CHARS` tegn). */
  readonly reason: string;
}

export const AUTONOMY_REASON_MIN_CHARS = 20;

/**
 * Fail-closed lesing: KUN et objekt med en reell begrunnelse teller. Utelatt, `true`, tom/kort tekst, feil form og alt annet er IKKE bindbar. Tar `unknown` slik at en kaller som leser en
 * ubetrodd/ufullstendig definisjon aldri kan gi «bindbar» ved en feiltolkning.
 */
export function autonomyBindabilityOf(definition: { readonly autonomy_bindable?: unknown } | null | undefined): AutonomyBindability | null {
  const declared = definition?.autonomy_bindable;
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) return null;
  const reason = (declared as { reason?: unknown }).reason;
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.length >= AUTONOMY_REASON_MIN_CHARS ? { reason: trimmed } : null;
}
