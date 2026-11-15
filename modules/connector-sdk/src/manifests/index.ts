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
