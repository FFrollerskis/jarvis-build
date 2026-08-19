import type { CampaignStatus, ExperimentStatus } from "./types.ts";

/**
 * Deterministisk kampanje-/eksperiment-lifecycle. INGEN LLM avgjør om en
 * overgang er gyldig (samme prinsipp som contracts/support sin
 * state-machine.ts) - rent oppslag i et statisk kart. Ugyldige overganger
 * feiler trygt (kaster de typede feilene under), aldri en stille ignorering
 * eller en tvunget overgang.
 *
 * `ended` er praktisk talt terminal for kampanjer - den ENESTE veien videre
 * er en eksplisitt administrativ korreksjon tilbake til `draft` (ALDRI
 * direkte til `active` - samme "gjennom hele lifecyclen på nytt"-prinsipp
 * som `CONTRACT_TRANSITIONS.terminated`).
 */
export const CAMPAIGN_TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  draft: ["active", "ended"],
  active: ["paused", "ended"],
  paused: ["active", "ended"],
  ended: ["draft"]
} as const;

export class InvalidCampaignTransitionError extends Error {
  constructor(
    public readonly from: CampaignStatus,
    public readonly to: CampaignStatus
  ) {
    super(`invalid_campaign_transition:${from}->${to}`);
    this.name = "InvalidCampaignTransitionError";
  }
}

export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  if (from === to) return true;
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

export function assertValidCampaignTransition(from: CampaignStatus, to: CampaignStatus): void {
  if (!canTransitionCampaign(from, to)) {
    throw new InvalidCampaignTransitionError(from, to);
  }
}

export function isTerminalCampaignStatus(status: CampaignStatus): boolean {
  return status === "ended";
}

/** Eksperiment-lifecycle: samme "terminal korrigerbar kun tilbake til draft"-prinsipp. */
export const EXPERIMENT_TRANSITIONS: Readonly<Record<ExperimentStatus, readonly ExperimentStatus[]>> = {
  draft: ["running", "abandoned"],
  running: ["concluded", "abandoned"],
  concluded: ["draft"],
  abandoned: ["draft"]
} as const;

export class InvalidExperimentTransitionError extends Error {
  constructor(
    public readonly from: ExperimentStatus,
    public readonly to: ExperimentStatus
  ) {
    super(`invalid_experiment_transition:${from}->${to}`);
    this.name = "InvalidExperimentTransitionError";
  }
}

export function canTransitionExperiment(from: ExperimentStatus, to: ExperimentStatus): boolean {
  if (from === to) return true;
  return EXPERIMENT_TRANSITIONS[from].includes(to);
}

export function assertValidExperimentTransition(from: ExperimentStatus, to: ExperimentStatus): void {
  if (!canTransitionExperiment(from, to)) {
    throw new InvalidExperimentTransitionError(from, to);
  }
}

export function isTerminalExperimentStatus(status: ExperimentStatus): boolean {
  return status === "concluded" || status === "abandoned";
}
