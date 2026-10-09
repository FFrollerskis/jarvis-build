/**
 * WP-C1: strukturert JSON-logging (én linje per hendelse) UTEN hemmeligheter.
 *
 * Tre lag: (1) kallere sender kun navngitte, trygge felt; (2) felt med sensitive navn blir aldri skrevet; (3) alle strengverdier
 * går gjennom `redact()` (registrerte hemmeligheter -> [REDACTED]) og kuttes. Env-verdier, argv-verdier og tokens finnes
 * derfor ikke i loggen selv om en kaller skulle glemme det.
 */

const SENSITIVE_KEY = /(^|_)(token|secret|password|passwd|authorization|credential|env|argv|cmdline|value|stdin|stdout|stderr)(_|$)/i;
const MAX_FIELD_LENGTH = 300;

/**
 * Register over verdier som aldri skal ut i logg, feilmeldinger eller svar. TELLENDE: samme verdi kan registreres av flere samtidige jobber/kall
 * (f.eks. samme `ANTHROPIC_API_KEY` i to jobber, eller samme mellomlagrede installasjonstoken i to publiseringer), og én jobb som avsluttes skal
 * ikke ta bort dekningen for de andre. Hver `add` må derfor ha en `remove` (eller bruk `hold`, som gir en idempotent frigjører).
 */
export class SecretRegistry {
  /** @type {Map<string, number>} */
  #counts = new Map();
  /** Verdiene sortert LENGST FØRST (mellomlagret): en verdi som er en delstreng av en annen skal ikke etterlate halen av den lengste. @type {string[] | null} */
  #ordered = null;

  /** Registrerer en hemmelighet som skal fjernes fra all utgående tekst (korte verdier ignoreres: for mange falske treff). */
  add(secret) {
    if (typeof secret !== "string" || secret.length < 8) return;
    const count = this.#counts.get(secret);
    this.#counts.set(secret, (count ?? 0) + 1);
    if (count === undefined) this.#ordered = null;
  }

  /** Reduserer tellingen; verdien slutter å bli redigert først når ALLE som registrerte den har fjernet den. */
  remove(secret) {
    const count = this.#counts.get(secret);
    if (count === undefined) return;
    if (count <= 1) {
      this.#counts.delete(secret);
      this.#ordered = null;
    } else {
      this.#counts.set(secret, count - 1);
    }
  }

  /**
   * Registrerer en kortlevd hemmelighet (f.eks. et git-token sendt i ÉN forespørsel) og returnerer en frigjører som kan kalles flere ganger
   * uten å telle ned mer enn én gang. Kortlevde tokens skal aldri bli stående i registeret (ubegrenset vekst, og `redact` er O(antall verdier)).
   * @param {string} secret
   * @returns {() => void}
   */
  hold(secret) {
    this.add(secret);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.remove(secret);
    };
  }

  /** Antall ulike registrerte verdier (diagnostikk/tester - aldri verdiene selv). */
  get size() {
    return this.#counts.size;
  }

  /** @param {string} text */
  redact(text) {
    let out = String(text);
    this.#ordered ??= [...this.#counts.keys()].sort((a, b) => b.length - a.length);
    for (const secret of this.#ordered) {
      if (out.includes(secret)) out = out.split(secret).join("[REDACTED]");
    }
    return out;
  }
}

/**
 * @param {{ write?: (line: string) => void, now?: () => Date, registry?: SecretRegistry, component?: string }} [options]
 */
export function createLogger(options = {}) {
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const registry = options.registry ?? new SecretRegistry();
  const component = options.component ?? "job-runner";

  /** @param {"info"|"warn"|"error"} level @param {string} event @param {Record<string, unknown>} [fields] */
  const emit = (level, event, fields = {}) => {
    const line = { ts: now().toISOString(), level, component, event };
    for (const [key, value] of Object.entries(fields)) {
      if (key in line) continue;
      if (SENSITIVE_KEY.test(key)) continue;
      if (typeof value === "string") line[key] = registry.redact(value).slice(0, MAX_FIELD_LENGTH);
      else if (typeof value === "number" || typeof value === "boolean" || value === null) line[key] = value;
      else if (value !== undefined) line[key] = registry.redact(String(value)).slice(0, MAX_FIELD_LENGTH);
    }
    try {
      write(JSON.stringify(line));
    } catch {
      // logging skal aldri velte tjenesten
    }
  };

  return {
    registry,
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields)
  };
}
