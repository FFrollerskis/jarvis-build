import { googleAccessToken } from "@jarvis/tool-gateway";
import { GrowthWriteTransportBase, type Auth, type OpSpec, type ProviderToolSpec, type WriteTransportDeps } from "./tool-factory.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): felles basis for de Google-OAuth-baserte skrivetransportene (GA4, Search Console, Business Profile, YouTube). Refresh-tokenet (credential) byttes mot et kortlivet
 * access token via den DELTE `googleAccessToken` (samme klient-id/-secret og cache som Gmail/Drive/Google Ads); access token og refresh token vaskes bort fra all feiltekst.
 * Hver leverandørtjeneste har SITT EGET refresh-token (separat samtykke/scope) - aldri ett token med alle scopes.
 */
export interface GoogleRestOptions extends WriteTransportDeps {
  spec: ProviderToolSpec;
  /** Refresh-token -> access-token (standard: den delte `googleAccessToken`; injiseres i tester). */
  accessToken?: (refreshToken: string) => Promise<string>;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}

export abstract class GoogleOAuthTransport extends GrowthWriteTransportBase {
  protected readonly ops: ReadonlyMap<string, OpSpec>;

  protected constructor(protected readonly options: GoogleRestOptions) {
    super(options);
    this.ops = new Map(options.spec.ops.map((o) => [o.action, o]));
  }

  protected async authenticate(credential: string): Promise<Auth> {
    const token = await (this.options.accessToken ?? googleAccessToken)(credential);
    return { headers: { authorization: `Bearer ${token}` }, secrets: [token, credential] };
  }
}

export type { ProviderToolSpec };
