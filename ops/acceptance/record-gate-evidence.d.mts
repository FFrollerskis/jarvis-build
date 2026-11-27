// Typer for `record-gate-evidence.mjs` (ren .mjs). Kommandolinjen `packages/contracts/scripts/program-index.ts` importerer `reasonProblemOf` så `gate` direkte screener begrunnelsen likt inngangen.
export function gateArgs(argv: readonly string[]): string[] | null;
/** `null` = begrunnelsen er ok; ellers en norsk melding (kun regelnavn, aldri verdien). */
export function reasonProblemOf(raw: string): string | null;
export function reasonProblem(args: readonly string[]): string | null;
export function run(argv: readonly string[]): number;
