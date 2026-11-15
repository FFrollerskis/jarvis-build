import type { ConnectorManifest } from "../manifest.ts";
import { CLOUDFLARE_MANIFEST } from "./cloudflare.ts";
import { GITHUB_MANIFEST } from "./github.ts";
import { STRIPE_MANIFEST } from "./stripe.ts";

export { CLOUDFLARE_MANIFEST, GITHUB_MANIFEST, STRIPE_MANIFEST };

/**
 * WP-I (D-472): de håndskrevne (`full`) manifestene. De tre REFERANSECONNECTORENE (GitHub, Cloudflare fra WP-E1, Stripe fra WP-F1) viser mønsteret; alle andre registeroppføringer har et avledet `skeleton`
 * (`deriveSkeletonManifests`). En ny connector legger sitt fulle manifest til HER (CI-vakten feiler om en manifestfil i denne mappen mangler i listen) og i `modules/tool-gateway/src/connector-registry.ts`.
 */
export const FULL_MANIFESTS: readonly ConnectorManifest[] = [GITHUB_MANIFEST, CLOUDFLARE_MANIFEST, STRIPE_MANIFEST];

/**
 * SKELETON-BASELINEN (review M5): de BYGDE registeroppføringene (kategori ikke backlog) som i dag bare har et avledet `skeleton` og ikke et fullt manifest. Et skeleton avledes automatisk for hver registeroppføring,
 * så «ingen manifest» kan aldri oppstå - derfor kunne vakten ikke fange at en NY connector ble lagt til uten et gjennomgått manifest. Baselinen gjør det til en bevisst handling (samme idé som baselinen i D-396-vakten):
 *  - en NY bygd registeroppføring må enten få et FULLT manifest (anbefalt; legg det til i `FULL_MANIFESTS`), eller legges til HER med begrunnelse i PR-en;
 *  - baselinen er ment å krympe (KONVENSJON, ikke håndhevet): når en connector får et fullt manifest, SKAL den fjernes herfra (ellers feiler vakten), og en oppføring som ikke lenger finnes i registeret eller er backlog feiler også.
 *    Vakten sjekker derimot IKKE at listen aldri vokser: å legge en id til gjør `built_connector_unreviewed` grønn, og det er nettopp den synlige utveien (en linje i PR-diffen, begrunnet i PR-en). En frosset legacy-liste
 *    (en committet kopi av id-ene under som bare kan fjernes fra) er DEFERRED - se runbook §11.
 * Backlog-oppføringer (ikke bygget) trenger ingen oppføring; i det øyeblikket de bygges (kategori endres) må de få manifest eller en bevisst baseline-oppføring.
 * Arbeidslisten for å tømme baselinen er `unknown_fields_by_connector` i vaktens rapport.
 */
export const SKELETON_BASELINE: readonly string[] = [
  "anthropic", "brave_search", "discord", "dropbox", "exa", "fiken", "gemini", "gmail", "google_calendar", "google_drive", "google_maps", "google_places", "google_routes", "google_sheets", "google_veo", "grafana",
  "higgsfield", "home_assistant", "hubspot", "jira", "kling", "linear", "make", "microsoft_outlook", "n8n", "neonomics", "notion", "onedrive", "openai", "openai_images", "pipedrive", "playwright", "prometheus",
  "runway", "sentry", "slack", "spotify", "tavily", "telegram", "telnyx", "todoist", "trello", "twilio", "vercel", "vipps", "wallester", "whatsapp", "zapier"
];
