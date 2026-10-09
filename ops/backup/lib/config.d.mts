export interface ScheduleConfig {
  readonly out: string;
  readonly stateDir: string;
  readonly statusFile: string;
  readonly lockFile: string;
  readonly exportDir: string | null;
  readonly roles: ReadonlySet<string>;
  readonly mode: "docker" | "direct";
  readonly intervalMs: number;
  /** Tak for ETT tikk (vaktbikkja): summen av de påslåtte stegenes frister + slark. */
  readonly tickBudgetMs: number;
}
export declare const ROLES: readonly string[];
export declare const DUE_TOLERANCE_MS: number;
/** true hvis a og b er samme mappe, eller den ene ligger inni den andre (symlenker løses opp så langt stien finnes). */
export declare function samePathOrNested(a: string, b: string): boolean;
export declare function parseRoles(raw: string | undefined): Set<string>;
export declare function loadScheduleConfig(flags: Record<string, string | boolean | undefined>, env?: NodeJS.ProcessEnv): ScheduleConfig;
export declare function assertRunnable(config: ScheduleConfig, env?: NodeJS.ProcessEnv): void;
