/**
 * Kill switch (SECURITY_MODEL §8) - fase 1-skjelett.
 * Når aktiv skal ALLE autorisasjoner nektes, uansett capability-klasse.
 * Deterministisk tilstand; ingen LLM involvert.
 */
export class KillSwitch {
  private active = false;
  private reason: string | undefined;

  activate(reason: string): void {
    this.active = true;
    this.reason = reason;
  }

  deactivate(): void {
    this.active = false;
    this.reason = undefined;
  }

  isActive(): boolean {
    return this.active;
  }

  activeReason(): string | undefined {
    return this.reason;
  }
}
