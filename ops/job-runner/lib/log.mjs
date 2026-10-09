/**
 * WP-C1: strukturert JSON-logging (én linje per hendelse) UTEN hemmeligheter.
 *
 * Tre lag: (1) kallere sender kun navngitte, trygge felt; (2) felt med sensitive navn blir aldri skrevet; (3) alle strengverdier
 * går gjennom `redact()` (registrerte hemmeligheter -> [REDACTED]) og kuttes. Env-verdier, argv-verdier og tokens finnes
 * derfor ikke i loggen selv om en kaller skulle glemme det.
 */

const SENSITIVE_KEY = /(^|_)(token|secret|password|passwd|authorization|credential|env|argv|cmdline|value|stdin|stdout|stderr)(_|$)/i;
const MAX_FIELD_LENGTH = 300;

export class SecretRegistry {
  /** @type {Set<string>} */
  #secrets = new Set();

  /** Registrerer en hemmelighet som skal fjernes fra all utgående tekst (korte verdier ignoreres: for mange falske treff). */
  add(secret) {
    if (typeof secret === "string" && secret.length >= 8) this.#secrets.add(secret);
  }

  remove(secret) {
    this.#secrets.delete(secret);
  }

  /** @param {string} text */
  redact(text) {
    let out = String(text);
    for (const secret of this.#secrets) {
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
