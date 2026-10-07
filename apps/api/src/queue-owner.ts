/**
 * D-433 (JARVIS-025, valg B): hvem eier bakgrunnsjobb-køen (`executive`)? Standard er WORKER-containeren: den har egen prosess (chatten holdes
 * ansvarlig mens agenter kjører) og ÉN verktøyflate/identitet. `JARVIS_API_DRAINS_EXECUTIVE=true` er en nød-/utviklingsbryter for oppsett UTEN
 * worker-container. Kun den eksakte strengen `true` slår det på - alt annet (tom, `1`, `yes`) er worker, så køen aldri får to eiere ved en skrivefeil.
 */
export type ExecutiveQueueOwner = "worker" | "api";

export function executiveQueueOwner(env: Record<string, string | undefined>): ExecutiveQueueOwner {
  return env["JARVIS_API_DRAINS_EXECUTIVE"] === "true" ? "api" : "worker";
}
