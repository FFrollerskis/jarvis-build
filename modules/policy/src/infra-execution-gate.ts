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
 * Rent internt state-objekt (ingen ekstern sideeffekt) - reversibelt,
 * deterministisk, ingen LLM. Eier-kontrollert via samme mønster som
 * `OwnerControls.pauseAll()`/`freezeConnector()` (v4.0 §Owner Override).
 */
export type InfraExecutionMode = "NORMAL" | "DEGRADED" | "PAUSED";

/**
 * D-438 (JARVIS-025): valgfri, delt lagring så api- og worker-prosessen ser SAMME modus. `read()` gir `null` = NORMAL (ingen rad). Gaten holder
 * fortsatt en lokal kopi (`check()` er synkron og kalles for hvert verktøykall); kopien oppdateres fra lagringen ved `refresh()`/`startSync()`.
 */
export interface InfraModeStore {
  read(): Promise<InfraExecutionModeState | null>;
  write(state: InfraExecutionModeState, actorPersonId?: string): Promise<void>;
  clear(): Promise<void>;
}

export interface InfraExecutionModeState {
  mode: InfraExecutionMode;
  reason?: string;
  at: string;
}

export class InfraExecutionGate {
  private state: InfraExecutionModeState;
  /** Siste synk-feil (null = siste synk lyktes eller ingen lagring). Eksponert for /status; aldri en stille «alt ok». */
  lastSyncError: string | null = null;

  constructor(private readonly clock: () => Date = () => new Date(), private readonly store?: InfraModeStore) {
    this.state = { mode: "NORMAL", at: this.clock().toISOString() };
  }

  /**
   * Varig overgang (D-438). Rekkefølge er fail-SAFE: å stramme inn (pause/degrade) settes lokalt FØRST og så lagres (feiler lagringen, er denne
   * prosessen likevel stanset og kalleren får feilen); å løsne (resume) lagres FØRST og settes lokalt bare hvis lagringen lyktes (feiler den, forblir
   * modusen innstrammet). Andre prosesser ser endringen ved neste synk (maks `startSync`-intervallet).
   */
  async pauseDurable(reason: string, actorPersonId?: string): Promise<void> {
    this.pause(reason);
    await this.store?.write(this.state, actorPersonId);
  }

  async degradeDurable(reason: string, actorPersonId?: string): Promise<void> {
    this.degrade(reason);
    await this.store?.write(this.state, actorPersonId);
  }

  async resumeDurable(): Promise<void> {
    await this.store?.clear();
    this.resume();
  }

  /** Leser delt tilstand og overtar den. Ved lesefeil beholdes siste kjente modus (en pause løses aldri av en lesefeil), og feilen registreres. */
  async refresh(): Promise<void> {
    if (!this.store) return;
    try {
      const shared = await this.store.read();
      this.state = shared ?? (this.state.mode === "NORMAL" ? this.state : { mode: "NORMAL", at: this.clock().toISOString() });
      this.lastSyncError = null;
    } catch (err) {
      this.lastSyncError = (err as Error).message;
    }
  }

  /** Periodisk synk (default 2 s). Returnerer en stopp-funksjon; timeren holder ikke prosessen i live. */
  startSync(intervalMs = 2_000): () => void {
    const timer = setInterval(() => void this.refresh(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
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

  current(): InfraExecutionModeState {
    return this.state;
  }

  /** Returnerer en maskinlesbar deny-årsak, eller `null` hvis denne gaten ikke blokkerer. */
  check(capabilityClass: "A" | "B" | "C" | "D"): string | null {
    if (capabilityClass === "A") {
      return null; // diagnostikk/lesing er ALDRI stanset av infra-modus
    }
    if (this.state.mode === "PAUSED") {
      return "infra_paused";
    }
    if (this.state.mode === "DEGRADED" && capabilityClass === "D") {
      return "infra_degraded_blocks_class_d";
    }
    return null;
  }
}
