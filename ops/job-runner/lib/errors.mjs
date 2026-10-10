/**
 * WP-C1: feil som kan vises til klienten (worker) - stabil kode + HTTP-status + en KORT, renset detalj.
 * Alt annet (uventede unntak) blir `internal_error` uten detaljer; interne feilmeldinger lekker aldri ut av API-et.
 */
export class RunnerError extends Error {
  /**
   * @param {string} code stabil, maskinlesbar feilkode (snake_case)
   * @param {number} [status] HTTP-status
   * @param {string} [detail] kort, renset detalj (aldri hemmeligheter, aldri stier utenfor jobben)
   */
  constructor(code, status = 400, detail = undefined) {
    super(code);
    this.name = "RunnerError";
    /** @type {string} */
    this.code = code;
    /** @type {number} */
    this.status = status;
    /** @type {string | undefined} */
    this.detail = detail;
  }
}

/** Konfigurasjonsfeil ved oppstart: tjenesten nekter å starte (fail-closed), aldri en stille nedgradering. */
export class ConfigError extends Error {
  /** @param {string} code @param {string} [detail] */
  constructor(code, detail = undefined) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "ConfigError";
    /** @type {string} */
    this.code = code;
  }
}

/**
 * Kooperativt avbruddstegn (ikke `AbortController`: det er ikke en deklarert global i ops/-eslint-konfigen, og vi trenger kun
 * «er avbrutt?» + «kjør dette når avbrutt»).
 */
export class CancelToken {
  /** @type {boolean} */
  #cancelled = false;
  /** @type {Set<() => void>} */
  #listeners = new Set();

  get cancelled() {
    return this.#cancelled;
  }

  cancel() {
    if (this.#cancelled) return;
    this.#cancelled = true;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // en lytter skal aldri kunne hindre at øvrige lyttere kjøres
      }
    }
    this.#listeners.clear();
  }

  /**
   * @param {() => void} listener
   * @returns {() => void} avmelding
   */
  onCancel(listener) {
    if (this.#cancelled) {
      listener();
      return () => undefined;
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
