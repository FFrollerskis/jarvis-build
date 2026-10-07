import { OwnerControlUnauthorizedError, type OwnerControlAuthority } from "./owner-control-store.ts";

/**
 * UA-5 Production Operations Control Plane v1 (D-104): global infra-
 * eksekusjonsmodus - EN NY, SNEVRERE bryter enn `KillSwitch` (som forblir
 * strengest/uendret - blokkerer ALT, ALLE capability_class-er, ALLE
 * tool_id-er). Denne gaten gjelder KUN registrerte "infra"-tool_id-er
 * (se `PolicyGatewayOptions.infraToolIds`) og skiller eksplisitt mellom
 * lesing/diagnostikk (klasse A, ALDRI blokkert her) og mutasjon (B/C/D).
 *
 * NORMAL: ingen ekstra restriksjon fra denne gaten (vanlig policy gjelder).
 * DEGRADED: blokkerer KUN klasse D (høyest risiko - betaling/kontrakt/
 *   sletting/publisering/lås/alarm/tilgangsendring, jf. CapabilityClass-
 *   doc-kommentaren) - B/C fortsetter, diagnostikk (A) uendret.
 * PAUSED: blokkerer ALL mutasjon (B/C/D) for infra-tool_id-er - diagnostikk
 *   (A) forblir ALLTID tilgjengelig, aldri stanset av denne gaten.
 *
 * Reversibelt, deterministisk, ingen LLM. Eier-kontrollert via samme mønster som `OwnerControls.pauseAll()`/`freezeConnector()` (v4.0 §Owner Override).
 *
 * D-438 (JARVIS-025): uten `store` er tilstanden prosess-lokal (tester, enkeltprosess). MED `store` deles modusen mellom api og worker via
 * `owner_control_state`, og `PolicyGateway` leser den LIVE for hvert infra-kall (`checkDurable`) - samme begrunnelse som `KillSwitch.isActiveDurable()`
 * (D-164): en per-prosess cache kan divergere mellom prosessene, og ett indeksert enrads-oppslag per infra-kall er billig. Ingen timer, ingen cache,
 * ingen synk å glemme. Gjeldende modus = den STRENGESTE av lokal og delt tilstand: en pause som ikke fikk lagret (databasefeil) er likevel i kraft
 * i den prosessen som mottok den, og en lesefeil blokkerer mutasjon (fail-closed) i stedet for å anta NORMAL.
 */
export type InfraExecutionMode = "NORMAL" | "DEGRADED" | "PAUSED";

export interface InfraExecutionModeState {
  mode: InfraExecutionMode;
  reason?: string;
  at: string;
}

/** Lagret (varig) modus: NORMAL lagres aldri - «ingen rad» ER NORMAL (`clear()`). */
export type StoredInfraModeState = InfraExecutionModeState & { mode: "DEGRADED" | "PAUSED" };

export interface InfraModeStore {
  /** `null` = NORMAL (ingen rad). Kaster ved lesefeil. Uleselig/ukjent lagret innhold gir PAUSED (fail-closed). */
  read(): Promise<InfraExecutionModeState | null>;
  write(state: StoredInfraModeState, actorPersonId?: string): Promise<void>;
  clear(): Promise<void>;
}

const RANK: Record<InfraExecutionMode, number> = { NORMAL: 0, DEGRADED: 1, PAUSED: 2 };

function stricter(a: InfraExecutionModeState, b: InfraExecutionModeState | null): InfraExecutionModeState {
  return b && RANK[b.mode] > RANK[a.mode] ? b : a;
}

/** Maskinlesbar deny-årsak for en gitt modus og klasse, eller `null`. Klasse A (diagnostikk/lesing) blokkeres ALDRI. */
function denyFor(state: InfraExecutionModeState, capabilityClass: "A" | "B" | "C" | "D"): string | null {
  if (capabilityClass === "A") return null;
  if (state.mode === "PAUSED") return "infra_paused";
  if (state.mode === "DEGRADED" && capabilityClass === "D") return "infra_degraded_blocks_class_d";
  return null;
}

export class InfraExecutionGate {
  private state: InfraExecutionModeState;

  constructor(
    private readonly clock: () => Date = () => new Date(),
    private readonly store?: InfraModeStore,
    /** Påkrevd for varige overganger NÅR `store` er satt (samme fail-CLOSED-regel som `KillSwitch`/`OwnerControls`). */
    private readonly authority?: OwnerControlAuthority
  ) {
    this.state = { mode: "NORMAL", at: this.clock().toISOString() };
  }

  pause(reason: string): void {
    this.state = { mode: "PAUSED", reason, at: this.clock().toISOString() };
  }

  degrade(reason: string): void {
    this.state = { mode: "DEGRADED", reason, at: this.clock().toISOString() };
  }

  resume(): void {
    this.state = { mode: "NORMAL", at: this.clock().toISOString() };
  }

  /** Lokal (prosess-)tilstand. Med `store` er den delte tilstanden autoritativ for policy - se `checkDurable()`/`statusDurable()`. */
  current(): InfraExecutionModeState {
    return this.state;
  }

  /** Synkron sjekk mot LOKAL tilstand (tester/enkeltprosess). `PolicyGateway` bruker `checkDurable()`. Returnerer en maskinlesbar deny-årsak, eller `null`. */
  check(capabilityClass: "A" | "B" | "C" | "D"): string | null {
    return denyFor(this.state, capabilityClass);
  }

  /**
   * Den AUTORITATIVE sjekken (D-438). Klasse A leser ikke databasen i det hele tatt. Ellers: gjeldende modus = strengeste av lokal og delt; en lesefeil
   * gir `infra_mode_unavailable` (mutasjon avslås - fail-closed), aldri en antatt NORMAL.
   */
  async checkDurable(capabilityClass: "A" | "B" | "C" | "D"): Promise<string | null> {
    if (capabilityClass === "A") return null;
    if (!this.store) return denyFor(this.state, capabilityClass);
    let shared: InfraExecutionModeState | null;
    try {
      shared = await this.store.read();
    } catch (err) {
      console.error(JSON.stringify({ msg: "infra_mode_read_failed", error: (err as Error).message }));
      return "infra_mode_unavailable";
    }
    return denyFor(stricter(this.state, shared), capabilityClass);
  }

  /** Gjeldende modus for status: strengeste av lokal og delt. `shared_readable=false` når den delte tilstanden ikke kunne leses (da vises kun lokal). */
  async statusDurable(): Promise<{ state: InfraExecutionModeState; shared_readable: boolean }> {
    if (!this.store) return { state: this.state, shared_readable: true };
    try {
      return { state: stricter(this.state, await this.store.read()), shared_readable: true };
    } catch (err) {
      console.error(JSON.stringify({ msg: "infra_mode_read_failed", error: (err as Error).message }));
      return { state: this.state, shared_readable: false };
    }
  }

  private assertAuthorized(actorPersonId: string | undefined): void {
    if (!this.store) return; // ingen varig tilstand å beskytte (tester/enkeltprosess)
    if (!actorPersonId || !this.authority || actorPersonId !== this.authority.owner_person_id) {
      throw new OwnerControlUnauthorizedError(actorPersonId);
    }
  }

  /**
   * Varige overganger (D-438), kun for eieren når lagring er aktiv. Å stramme inn (pause/degrade) settes lokalt FØRST og lagres så: feiler lagringen, er
   * DENNE prosessen likevel stanset (strengeste-av-regelen overstyres aldri av en senere lesing) og kalleren får feilen - ikke en falsk suksess. Å løsne
   * (resume) tømmer lagringen FØRST og løsner lokalt bare hvis det lyktes.
   */
  async pauseDurable(reason: string, actorPersonId?: string): Promise<void> {
    this.assertAuthorized(actorPersonId);
    this.pause(reason);
    await this.store?.write(this.state as StoredInfraModeState, actorPersonId);
  }

  async degradeDurable(reason: string, actorPersonId?: string): Promise<void> {
    this.assertAuthorized(actorPersonId);
    this.degrade(reason);
    await this.store?.write(this.state as StoredInfraModeState, actorPersonId);
  }

  async resumeDurable(actorPersonId?: string): Promise<void> {
    this.assertAuthorized(actorPersonId);
    await this.store?.clear();
    this.resume();
  }
}
