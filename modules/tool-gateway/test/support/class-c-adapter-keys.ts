import type { ClassCAdapter } from "@jarvis/tool-gateway";

/**
 * WP-AUTH2a: de to domene-eide adapterne (vekst, forretning) bor i sine egne moduler, som tool-gateway ikke kan importere. Differensialtesten trenger kun at pipelinen er ENGASJERT for de samme handlingsnøklene
 * (for kontrolltesten «modus på avviker fra main»), ikke selve domenelogikken (den er testet i modulene). Dette er derfor minimale stand-ins med samme nøkkel: leser handlingens eksisterende lesehandling og forventer ingenting.
 */
function standIn(key: string, readAction: string): ClassCAdapter {
  return {
    key,
    validate: () => null,
    before: { reads: () => [{ id: "state", action: readAction, parameters: {}, optional: true }], judge: () => ({ block: null }), snapshot: () => ({ state: {}, context: {} }) },
    after: { reads: () => [{ id: "state", action: readAction, parameters: {}, optional: true }], snapshot: () => ({ state: {}, context: {} }) },
    expect: () => [],
    rollback: () => ({ kind: "none", steps: [], note: "stand-in" })
  };
}

export const businessClassCAdaptersForTest = (): ClassCAdapter[] => [standIn("business.update_lead_status", "inspect_lead"), standIn("growth.set_campaign_status", "get_campaign")];
