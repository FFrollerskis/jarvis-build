import { assertOwnerControlAuthorized, type OwnerControlAuthority } from "./owner-control-store.ts";

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

  /**
   * Status for eieren (D-438). `state` = gjeldende modus (strengeste av lokal og delt). Lokal og delt vises ADSKILT, og `in_sync` er sann bare når den delte
   * modusen er lesbar og minst like streng som den lokale: ellers finnes en innstramming som KUN gjelder denne prosessen (for eksempel en pause som ikke fikk
   * lagret) og workeren er ikke stanset - det skal aldri se ut som en vellykket delt pause.
   */
  async statusDurable(): Promise<{
    state: InfraExecutionModeState;
    local: InfraExecutionModeState;
    shared: InfraExecutionModeState | null;
    shared_readable: boolean;
    in_sync: boolean;
  }> {
    const local = this.state;
    if (!this.store) return { state: local, local, shared: null, shared_readable: true, in_sync: true };
    try {
      const shared = await this.store.read();
      const sharedRank = shared ? RANK[shared.mode] : 0;
      return { state: stricter(local, shared), local, shared, shared_readable: true, in_sync: sharedRank >= RANK[local.mode] };
    } catch (err) {
      console.error(JSON.stringify({ msg: "infra_mode_read_failed", error: (err as Error).message }));
      return { state: local, local, shared: null, shared_readable: false, in_sync: false };
    }
  }

  private assertAuthorized(actorPersonId: string | undefined): void {
    // Samme fail-CLOSED-regel som KillSwitch/OwnerControls (én implementasjon): ingen lagring = ingenting varig å beskytte.
    assertOwnerControlAuthorized(this.store, this.authority, actorPersonId);
  }

  /**
   * Varige overganger (D-438), kun for eieren når lagring er aktiv. REGEL: en overgang som STRAMMER INN (til en strengere modus enn både lokal og delt) settes
   * lokalt FØRST og lagres så - feiler lagringen, er DENNE prosessen likevel stanset og kalleren får feilen. En overgang som LØSNER (til en mildere modus enn
   * lokal ELLER delt, eller når den delte modusen ikke kan leses) lagres FØRST og settes lokalt bare hvis lagringen lyktes - feiler den, forblir modusen
   * innstrammet. Dermed kan en feilmelding aldri ledsages av at noe ble løsnet.
   */
  async pauseDurable(reason: string, actorPersonId?: string): Promise<void> {
    this.assertAuthorized(actorPersonId);
    this.pause(reason); // PAUSED er strengest - aldri en løsning
    await this.store?.write(this.state as StoredInfraModeState, actorPersonId);
  }

  async degradeDurable(reason: string, actorPersonId?: string): Promise<void> {
    this.assertAuthorized(actorPersonId);
    let loosens = RANK[this.state.mode] > RANK.DEGRADED;
    if (this.store && !loosens) {
      try {
        const shared = await this.store.read();
        loosens = shared !== null && RANK[shared.mode] > RANK.DEGRADED;
      } catch {
        loosens = true; // kan ikke se den delte modusen: anta det verste og lagre først
      }
    }
    if (loosens) {
      // Løsner fra PAUSED: lagre FØRST; feiler det, kaster vi og lokal modus er uendret (fortsatt innstrammet).
      const next: InfraExecutionModeState = { mode: "DEGRADED", reason, at: this.clock().toISOString() };
      await this.store?.write(next as StoredInfraModeState, actorPersonId);
      this.state = next;
      return;
    }
    this.degrade(reason);
    await this.store?.write(this.state as StoredInfraModeState, actorPersonId);
  }

  async resumeDurable(actorPersonId?: string): Promise<void> {
    this.assertAuthorized(actorPersonId);
    await this.store?.clear();
    this.resume();
  }
}
