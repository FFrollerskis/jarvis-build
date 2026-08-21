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

export interface InfraExecutionModeState {
  mode: InfraExecutionMode;
  reason?: string;
  at: string;
}

export class InfraExecutionGate {
  private state: InfraExecutionModeState;

  constructor(private readonly clock: () => Date = () => new Date()) {
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
