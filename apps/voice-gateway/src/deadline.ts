/**
 * WP-V2 (K4, JARVIS-080): frister. Ingen leverandørkall og ingen kø-ledd i talekjeden skal kunne henge uten øvre grense -
 * ett hengende ledd blokkerer ellers ALLE senere ledd i den serielle kjeden (turnChain/ttsWorker).
 *
 * Alle feilkoder her er korte, maskinlesbare koder (aldri leverandørtekst) - de havner i logg og /status.
 */

export class DeadlineError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DeadlineError";
  }
}

/** Resolverer/avviser som `promise`, men avviser med `DeadlineError(code)` etter `ms`. `onTimeout` kjøres FØR avvisningen (f.eks. abort). */
export function withDeadline<T>(promise: Promise<T>, ms: number, code: string, onTimeout?: () => void): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // En feil i opprydding skal aldri maskere selve fristbruddet.
      }
      reject(new DeadlineError(code));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export interface DeadlineSignal {
  readonly signal: AbortSignal;
  /** true når signalet ble avfyrt av fristen (ikke av det eksterne signalet). */
  timedOut(): boolean;
  /** Rydder timer og lytter. Skal alltid kalles (finally). */
  dispose(): void;
}

/**
 * Et AbortSignal som avfyres ved `ms` ELLER når `external` aborteres - og som kan fortelle hvilket av de to som skjedde
 * (barge-in er et rent avbrudd, en frist er en feil). Brukes rundt hver `fetch`.
 */
export function deadlineSignal(ms: number, external?: AbortSignal): DeadlineSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timer = Number.isFinite(ms) && ms > 0
    ? setTimeout(() => {
        timedOut = true;
        controller.abort(new DeadlineError("timeout"));
      }, ms)
    : undefined;
  const onExternal = (): void => {
    controller.abort(external?.reason);
  };
  if (external) {
    if (external.aborted) {
      onExternal();
    } else {
      external.addEventListener("abort", onExternal, { once: true });
    }
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener("abort", onExternal);
    }
  };
}

/**
 * Normaliserer en feil til en kort kode for logg/helse: kun `[A-Za-z0-9_.:-]`, maks to kolon-segmenter og 60 tegn. Leverandør-
 * stderr/-tekst (som kan stå etter andre kolon i enkelte feilmeldinger) når aldri loggen.
 */
export function errorCode(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const head = message.split(":").slice(0, 2).join(":").slice(0, 60);
  return /^[A-Za-z0-9_.:-]+$/.test(head) ? head : "error";
}
