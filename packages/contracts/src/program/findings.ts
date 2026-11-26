/**
 * WP-PGA: felles funnform for skanningen (`scan.ts`), port-/ORL-skanningen (`gates.ts`) og lasteren (`fs-loader.ts`).
 * `id` = `<regel>:<subjekt>` er nøkkelen i baselinen og stabil på tvers av kjøringer.
 */
export interface Finding {
  rule: string;
  /** Komponenten funnet gjelder, der det er entydig; ellers null. */
  component_id: string | null;
  subject: string;
  id: string;
  message: string;
}

export const compareFindings = (a: Finding, b: Finding): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
