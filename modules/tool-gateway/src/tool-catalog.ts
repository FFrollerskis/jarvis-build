import type { MeshToolMapping } from "./mesh-bridge.ts";
import { SURFACE_TOOL_GRANTS, type Surface } from "./tool-manifest.ts";

/**
 * D-383: kompakt katalog over tjenestene modellen FAKTISK kan bruke på en flate - settes inn i systemprompten på hver tur, slik at
 * Charlie alltid vet hva som finnes (og hva som ikke finnes) selv om bare et lite utvalg verktøyskjema er vedlagt denne runden.
 * Bygges fra de samme mappingene som utførelsen bruker (aldri en egen liste som kan avvike). Norske etiketter er kun kosmetikk.
 */
const LABELS: Readonly<Record<string, string>> = {
  email: "e-post (Gmail)", calendar: "kalender", github: "GitHub", memory: "minne", executive: "egen status/kapabiliteter",
  finance_neonomics: "bank (Neonomics: samtykker, kontoer, saldo, transaksjoner)", finance_stripe: "Stripe", finance_vipps: "Vipps",
  finance_wallester: "Wallester-kort", finance_spend: "utgifter/abonnementer", business: "forretningsregister (selskaper, kontakter, leads, åpne saker)",
  contract: "kontrakter", support: "support/billetter", operations: "drift (leverandører, runbooks, oppgaver)", product: "produkt",
  growth: "kampanjer/vekst", googleads: "Google Ads", metaads: "Meta Ads", notion: "Notion", slack: "Slack", discord: "Discord",
  telegram: "Telegram (varsle Tobias)", drive: "Google Drive", dropbox: "Dropbox", onedrive: "OneDrive", google_sheets: "Google Sheets",
  microsoft_outlook: "Outlook", todoist: "Todoist", trello: "Trello", jira: "Jira", linear: "Linear", hubspot: "HubSpot", pipedrive: "Pipedrive",
  brave_search: "nettsøk (Brave)", tavily: "nettsøk (Tavily)", exa: "nettsøk (Exa)", google_maps: "kart", google_places: "steder",
  google_routes: "ruter/kjøretid", spotify: "Spotify", vercel: "Vercel", sentry: "Sentry", grafana: "Grafana", prometheus: "Prometheus",
  n8n: "n8n", make: "Make", twilio: "Twilio (SMS)", telnyx: "Telnyx", whatsapp: "WhatsApp", conversation_graph: "samtalegraf/identiteter",
  sentry_issues: "Sentry"
};

export interface SurfaceCatalog {
  /** Sortert per tjeneste: antall lese-handlinger og handlinger som endrer noe. */
  services: Array<{ tool_id: string; label: string; reads: number; acts: number }>;
  text: string;
}

export function describeSurfaceCatalog(mappings: ReadonlyArray<MeshToolMapping>, surface: Surface): SurfaceCatalog {
  const granted = new Set(SURFACE_TOOL_GRANTS[surface].map((g) => `${g.tool_id}.${g.action}`));
  const byTool = new Map<string, { reads: number; acts: number }>();
  for (const m of mappings) {
    if (!granted.has(`${m.tool_id}.${m.action}`)) continue;
    const entry = byTool.get(m.tool_id) ?? { reads: 0, acts: 0 };
    if (m.kind === "act") entry.acts += 1;
    else entry.reads += 1;
    byTool.set(m.tool_id, entry);
  }
  const services = [...byTool.entries()]
    .map(([tool_id, c]) => ({ tool_id, label: LABELS[tool_id] ?? tool_id.replace(/_/g, " "), ...c }))
    .sort((a, b) => a.label.localeCompare(b.label, "nb"));
  const line = (s: SurfaceCatalog["services"][number]) =>
    `${s.label}${s.acts > 0 ? " (lese + handle)" : " (kun lese)"}`;
  const text = services.length === 0 ? "" : services.map(line).join("; ");
  return { services, text };
}
