import { OUTCOME_UNKNOWN_PREFIX, isOutcomeUnknownMessage } from "./gateway.ts";

/**
 * WP-K (D-471, JARVIS-018, uavhengig review M-1): ETT delt hjelpestykke for flertrinns-transporter som kaster ETTER at leverandøren har AKSEPTERT en ikke-idempotent mutasjon.
 *
 * Mønsteret (funnet i `infisical.rotate_secrets`: POST akseptert -> readback-GET som feiler; samme form i GCE `reset_instance` og Docker `redeploy_container`): transporten har sendt mutasjonen og fått ja,
 * men et senere steg (readback, polling, ekstra kall, tolking av svaret) kaster. Gatewayen ser da en vanlig kastet feil -> ledger `failed` -> et samme-nøkkel-replay passerer preflight og sender mutasjonen en
 * gang til. Her gjøres hver feil i et slikt steg om til `outcome_unknown:<kode>` (samme familie som `tool_timeout`/`outcome_unknown:transport_*`): raden blir `unverified`, replay blokkeres og klasse D-eieren
 * varsles om at utfallet er ukjent (avstemming før noe forsøkes på nytt).
 *
 * Reglene (bevisst smale):
 *  - KODEN er en fast streng valgt av kalleren, aldri feilteksten fra leverandøren/steget (den kan sitere en tilkoblingsstreng, et token eller klientdata og havner i audit/ledger/modell-svar). `cause` settes
 *    heller ikke: gatewayen leser kun `message`.
 *  - En feil som ALLEREDE er ukjent utfall (`tool_timeout`, `outcome_unknown:...`) går uendret videre (første årsak vinner).
 *  - `keep` lar kalleren holde igjen en feil som er et ENTYDIG leverandørsvar «mislyktes» (f.eks. en GCE-operasjon som er ferdig med feil): den er ikke «ukjent» og forblir en vanlig feil.
 *  - Skal KUN brukes for steg etter akseptert mutasjon. Feil FØR sending (validering, preflight, innlogging) skal fortsatt være vanlige feil (retry tillatt). Bruk det heller ikke for idempotente handlinger:
 *    gatewayen gjør enhver `outcome_unknown:` om til `unverified` uavhengig av `idempotent_external`.
 */
export interface AfterAcceptedOptions {
  /** `true` = feilen er et entydig «mislyktes» fra leverandøren og skal IKKE gjøres om til ukjent utfall (kastes uendret). */
  keep?: (err: unknown) => boolean;
}

const CODE_CHARS = /[^A-Za-z0-9_.:-]/g;

function messageOf(err: unknown): string {
  try {
    const message = (err as { message?: unknown } | null | undefined)?.message;
    return typeof message === "string" ? message : "";
  } catch {
    return ""; // en kastende getter er aldri «allerede ukjent»
  }
}

function keeps(options: AfterAcceptedOptions, err: unknown): boolean {
  try {
    return options.keep?.(err) === true;
  } catch {
    return false; // et kastende `keep` skal aldri la en feil slippe forbi som en vanlig (retry-bar) feil: da er den ukjent, ikke «mislyktes»
  }
}

export async function afterAcceptedMutation<T>(code: string, step: () => Promise<T> | T, options: AfterAcceptedOptions = {}): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (keeps(options, err)) throw err;
    if (isOutcomeUnknownMessage(messageOf(err))) throw err;
    throw new Error(`${OUTCOME_UNKNOWN_PREFIX}:${code.replace(CODE_CHARS, "_").slice(0, 60)}`);
  }
}
