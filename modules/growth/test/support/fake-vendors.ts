/* eslint-disable @typescript-eslint/no-explicit-any -- testfalske leverandører og assertions leser dypt i ikke-typet JSON (forespørselskropper/leverandørsvar); typing av hver form ville bare duplisere leverandørenes skjema. */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * WP-D3: lokale, tilstandsfulle FALSKE leverandører (ingen ekte nettkall) for skrivetransportene. Hver serverer HTTP på 127.0.0.1 og registrerer ALLE forespørsler, slik at testene kan bevise
 * hva som faktisk ble sendt (metode, sti, spørring, topptekster, kropp) - og at INGENTING ble sendt når en port stoppet kallet FØR transporten.
 */
export interface Recorded { method: string; path: string; query: URLSearchParams; headers: IncomingMessage["headers"]; body: Record<string, any>; raw: string }
export interface Reply {
  status?: number; json?: unknown; text?: string; headers?: Record<string, string>;
  /** Etter at handleren har kjørt (tilstanden er endret): riv socketen UTEN å svare - leverandøren behandlet forespørselen, klienten ser en nullstilt forbindelse (WP-D3 review H1). */
  destroySocket?: boolean;
  /** Send statuslinje og topptekster + en DEL av kroppen, og riv så socketen (svaret ble avbrutt midt i kroppen). */
  truncateBody?: string;
}

export class FakeVendor {
  readonly requests: Recorded[] = [];
  private server: Server | undefined;
  baseUrl = "";
  /** Settes av tester for å styre svar; standard 404. */
  handler: (r: Recorded) => Reply | Promise<Reply> = () => ({ status: 404, json: { error: { message: "no route" } } });

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void (async () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          let body: Record<string, any> = {};
          try { body = raw.length > 0 ? JSON.parse(raw) : {}; } catch { body = {}; }
          const rec: Recorded = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body, raw };
          this.requests.push(rec);
          const reply = await this.handler(rec);
          if (reply.destroySocket === true) { req.socket.destroy(); return; }
          res.statusCode = reply.status ?? 200;
          res.setHeader("content-type", "application/json");
          for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
          if (reply.truncateBody !== undefined) {
            // Lover mer enn vi sender (content-length), skriv en del og riv socketen: klienten får en avbrutt kropp.
            res.setHeader("content-length", String(reply.truncateBody.length + 100));
            res.write(reply.truncateBody, () => { setTimeout(() => req.socket.destroy(), 20); });
            return;
          }
          res.end(reply.text !== undefined ? reply.text : reply.json === undefined ? "" : JSON.stringify(reply.json));
        })();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  reset(): void { this.requests.length = 0; }
  mutations(isMutation: (r: Recorded) => boolean): Recorded[] { return this.requests.filter(isMutation); }
}

export const CID = "1234567890";

/** Tilstandsfull Google Ads-falsk: GAQL-søk og `:mutate` mot kampanjer, budsjetter, annonsegrupper, nøkkelord og RSA-er. */
export class FakeGoogleAds extends FakeVendor {
  budgets = new Map<string, { id: string; micros: number; shared: boolean }>();
  campaigns = new Map<string, { id: string; name: string; status: string; budgetId: string }>();
  adGroups = new Map<string, { id: string; name: string; status: string; cpcBidMicros: number; campaignId: string }>();
  criteria = new Map<string, { adGroupId: string; id: string; text: string; matchType: string; status: string; negative: boolean }>();
  ads = new Map<string, { adGroupId: string; id: string; status: string; finalUrls: string[]; headlines: string[]; descriptions: string[] }>();
  /** Aksepter skrivingen (200) men ikke gjør noe - leverandøren «lyver». */
  ignoreWrites = false;
  /** Svar på alle `:mutate` med denne statusen (f.eks. 503 = bivirkningen kan ha skjedd). */
  mutateStatus: number | undefined;
  /** Svar 200 med uleselig kropp på `:mutate`. */
  mutateGarbage = false;
  /** WP-D3 review H1: leverandøren BEHANDLER mutasjonen (tilstanden endres) og river så socketen uten å svare. */
  mutateDestroyAfterApply = false;
  /** WP-D3 review H1/L4: leverandøren behandler mutasjonen og svarer en redirect (303/307) - «POST utført, resultatet ligger her». */
  mutateRedirectAfterApply: number | undefined;
  private nextId = 9000;

  constructor() {
    super();
    this.handler = (r) => this.route(r);
    this.seed();
  }

  seed(): void {
    this.budgets.clear(); this.campaigns.clear(); this.adGroups.clear(); this.criteria.clear(); this.ads.clear();
    this.budgets.set("11", { id: "11", micros: 500_000_000, shared: false });
    this.budgets.set("12", { id: "12", micros: 100_000_000, shared: true });
    this.campaigns.set("101", { id: "101", name: "Sommerkampanje", status: "ENABLED", budgetId: "11" });
    this.campaigns.set("102", { id: "102", name: "Delt budsjett", status: "PAUSED", budgetId: "12" });
    this.campaigns.set("103", { id: "103", name: "Fjernet", status: "REMOVED", budgetId: "11" });
    this.adGroups.set("201", { id: "201", name: "Gruppe A", status: "ENABLED", cpcBidMicros: 10_000_000, campaignId: "101" });
    this.criteria.set("201~301", { adGroupId: "201", id: "301", text: "sko", matchType: "EXACT", status: "ENABLED", negative: false });
    this.ads.set("201~401", { adGroupId: "201", id: "401", status: "PAUSED", finalUrls: ["https://example.test/a"], headlines: ["En", "To", "Tre"], descriptions: ["Beskrivelse en", "Beskrivelse to"] });
  }

  isMutation = (r: Recorded): boolean => r.method === "POST" && r.path.endsWith(":mutate");

  private route(r: Recorded): Reply {
    if (typeof r.headers["authorization"] !== "string" || !String(r.headers["authorization"]).startsWith("Bearer ")) return { status: 401, json: { error: { status: "UNAUTHENTICATED", message: "missing bearer" } } };
    if (typeof r.headers["developer-token"] !== "string") return { status: 401, json: { error: { status: "UNAUTHENTICATED", message: "missing developer token" } } };
    const m = /^\/(v\d+)\/customers\/(\d+)\/(googleAds:search|[A-Za-z]+:mutate)$/.exec(r.path);
    if (!m) return { status: 404, json: { error: { status: "NOT_FOUND", message: "no route" } } };
    if (m[2] !== CID) return { status: 403, json: { error: { status: "PERMISSION_DENIED", message: "customer not accessible" } } };
    if (m[3] === "googleAds:search") return { json: { results: this.search(String(r.body["query"] ?? "")) } };
    if (this.mutateStatus !== undefined) return { status: this.mutateStatus, json: { error: { status: "UNAVAILABLE", message: "backend error" } } };
    if (this.mutateGarbage) return { status: 200, text: "<html>proxy ok</html>" };
    const applied = this.mutate((m[3] ?? "").replace(":mutate", ""), (r.body["operations"] as Array<Record<string, any>>) ?? []);
    if (this.mutateDestroyAfterApply) return { destroySocket: true };
    if (this.mutateRedirectAfterApply !== undefined) return { status: this.mutateRedirectAfterApply, headers: { location: "/elsewhere" }, json: {} };
    return { json: applied };
  }

  private search(q: string): unknown[] {
    const id = (re: RegExp): string => re.exec(q)?.[1] ?? "";
    if (/FROM campaign WHERE/.test(q)) {
      const c = this.campaigns.get(id(/campaign\.id = (\d+)/));
      if (!c) return [];
      const b = this.budgets.get(c.budgetId)!;
      return [{ campaign: { id: c.id, name: c.name, status: c.status, servingStatus: "SERVING", advertisingChannelType: "SEARCH", biddingStrategyType: "MANUAL_CPC", campaignBudget: `customers/${CID}/campaignBudgets/${b.id}` }, campaignBudget: { id: b.id, amountMicros: String(b.micros), explicitlyShared: b.shared }, customer: { currencyCode: "NOK" } }];
    }
    if (/FROM ad_group WHERE/.test(q)) {
      const g = this.adGroups.get(id(/ad_group\.id = (\d+)/));
      return g ? [{ adGroup: { id: g.id, name: g.name, status: g.status, cpcBidMicros: String(g.cpcBidMicros) }, campaign: { id: g.campaignId, status: this.campaigns.get(g.campaignId)?.status } }] : [];
    }
    if (/FROM ad_group_criterion WHERE/.test(q)) {
      const gid = id(/ad_group\.id = (\d+)/);
      return [...this.criteria.values()].filter((c) => c.adGroupId === gid && c.status !== "REMOVED").map((c) => ({ adGroupCriterion: { criterionId: c.id, keyword: { text: c.text, matchType: c.matchType }, status: c.status, negative: c.negative } }));
    }
    if (/FROM ad_group_ad WHERE/.test(q)) {
      const gid = id(/ad_group\.id = (\d+)/);
      return [...this.ads.values()].filter((a) => a.adGroupId === gid && a.status !== "REMOVED").map((a) => ({
        adGroupAd: { status: a.status, ad: { id: a.id, type: "RESPONSIVE_SEARCH_AD", finalUrls: a.finalUrls, responsiveSearchAd: { headlines: a.headlines.map((text) => ({ text })), descriptions: a.descriptions.map((text) => ({ text })) } }, policySummary: { approvalStatus: "APPROVED" } }
      }));
    }
    return [];
  }

  private mutate(service: string, ops: Array<Record<string, any>>): unknown {
    const results: unknown[] = [];
    for (const op of ops) {
      if (service === "campaignBudgets" && op["update"]) {
        const b = this.budgets.get(String(op["update"].resourceName).split("/").pop()!);
        if (b && !this.ignoreWrites) b.micros = Number(op["update"].amountMicros);
        results.push({ resourceName: op["update"].resourceName });
      } else if (service === "campaigns") {
        const resource = String(op["update"]?.resourceName ?? op["remove"]);
        const c = this.campaigns.get(resource.split("/").pop()!);
        if (c && !this.ignoreWrites) c.status = op["remove"] ? "REMOVED" : String(op["update"].status);
        results.push({ resourceName: resource });
      } else if (service === "adGroups") {
        const g = this.adGroups.get(String(op["update"].resourceName).split("/").pop()!);
        if (g && !this.ignoreWrites) { if (op["update"].status) g.status = String(op["update"].status); if (op["update"].cpcBidMicros) g.cpcBidMicros = Number(op["update"].cpcBidMicros); }
        results.push({ resourceName: op["update"].resourceName });
      } else if (service === "adGroupCriteria") {
        if (op["create"]) {
          const id = String(this.nextId++);
          const gid = String(op["create"].adGroup).split("/").pop()!;
          if (!this.ignoreWrites) this.criteria.set(`${gid}~${id}`, { adGroupId: gid, id, text: op["create"].keyword.text, matchType: op["create"].keyword.matchType, status: op["create"].status, negative: op["create"].negative === true });
          results.push({ resourceName: `customers/${CID}/adGroupCriteria/${gid}~${id}` });
        } else {
          const resource = String(op["update"]?.resourceName ?? op["remove"]);
          const c = this.criteria.get(resource.split("/").pop()!);
          if (c && !this.ignoreWrites) c.status = op["remove"] ? "REMOVED" : String(op["update"].status);
          results.push({ resourceName: resource });
        }
      } else if (service === "adGroupAds") {
        if (op["create"]) {
          const id = String(this.nextId++);
          const gid = String(op["create"].adGroup).split("/").pop()!;
          const rsa = op["create"].ad.responsiveSearchAd;
          if (!this.ignoreWrites) this.ads.set(`${gid}~${id}`, { adGroupId: gid, id, status: op["create"].status, finalUrls: op["create"].ad.finalUrls, headlines: rsa.headlines.map((h: any) => h.text), descriptions: rsa.descriptions.map((d: any) => d.text) });
          results.push({ resourceName: `customers/${CID}/adGroupAds/${gid}~${id}` });
        } else {
          const a = this.ads.get(String(op["update"].resourceName).split("/").pop()!);
          if (a && !this.ignoreWrites) a.status = String(op["update"].status);
          results.push({ resourceName: op["update"].resourceName });
        }
      }
    }
    return { results };
  }
}

export const ACCT = "1234567890123";

/** Tilstandsfull Meta Graph-falsk: kampanjer, annonsesett og annonser. Tokenet MÅ komme som Authorization: Bearer (aldri i URL). */
export class FakeMeta extends FakeVendor {
  campaigns = new Map<string, { id: string; name: string; status: string; account_id: string }>();
  adSets = new Map<string, { id: string; name: string; status: string; daily_budget: number; bid_amount: number; bid_strategy: string; campaign_id: string; account_id: string }>();
  ads = new Map<string, { id: string; name: string; status: string; adset_id: string; account_id: string }>();
  currency = "NOK";
  ignoreWrites = false;
  mutateStatus: number | undefined;
  private nextId = 700000;

  constructor() {
    super();
    this.handler = (r) => this.route(r);
    this.seed();
  }

  seed(): void {
    this.campaigns.clear(); this.adSets.clear(); this.ads.clear();
    this.campaigns.set("50010", { id: "50010", name: "Meta kampanje", status: "ACTIVE", account_id: ACCT });
    this.campaigns.set("50020", { id: "50020", name: "Annen konto", status: "ACTIVE", account_id: "9999999999999" });
    this.adSets.set("60010", { id: "60010", name: "Sett A", status: "ACTIVE", daily_budget: 50_000, bid_amount: 1_500, bid_strategy: "LOWEST_COST_WITH_BID_CAP", campaign_id: "50010", account_id: ACCT });
    this.adSets.set("60020", { id: "60020", name: "Sett lavest kost", status: "PAUSED", daily_budget: 20_000, bid_amount: 0, bid_strategy: "LOWEST_COST_WITHOUT_CAP", campaign_id: "50010", account_id: ACCT });
    this.ads.set("70010", { id: "70010", name: "Annonse 1", status: "PAUSED", adset_id: "60010", account_id: ACCT });
  }

  isMutation = (r: Recorded): boolean => r.method === "POST";

  private route(r: Recorded): Reply {
    if (r.query.has("access_token")) return { status: 400, json: { error: { type: "OAuthException", code: 190, message: "token in URL not accepted by this fake" } } };
    if (!String(r.headers["authorization"] ?? "").startsWith("Bearer ")) return { status: 401, json: { error: { type: "OAuthException", code: 190, message: "no token" } } };
    const parts = r.path.split("/").filter(Boolean); // [version, id, ...]
    const id = parts[1] ?? "";
    if (r.method === "GET") {
      if (id === `act_${ACCT}`) return { json: { id, currency: this.currency } };
      if (parts[2] === "ads") return { json: { data: [...this.ads.values()].filter((a) => a.adset_id === id).map((a) => ({ id: a.id, name: a.name, status: a.status })) } };
      const obj = this.campaigns.get(id) ?? this.adSets.get(id) ?? this.ads.get(id);
      if (!obj) return { status: 400, json: { error: { type: "GraphMethodException", code: 100, message: `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions` } } };
      const anyObj = obj as Record<string, any>;
      return { json: { ...obj, effective_status: obj.status, daily_budget: "daily_budget" in anyObj ? String(anyObj["daily_budget"]) : undefined, bid_amount: "bid_amount" in anyObj && Number(anyObj["bid_amount"]) > 0 ? String(anyObj["bid_amount"]) : undefined } };
    }
    if (this.mutateStatus !== undefined) return { status: this.mutateStatus, json: { error: { type: "OAuthException", code: 2, message: "Service temporarily unavailable" } } };
    if (id === `act_${ACCT}` && parts[2] === "ads") {
      const adId = String(this.nextId++);
      if (!this.ignoreWrites) this.ads.set(adId, { id: adId, name: String(r.body["name"]), status: String(r.body["status"]), adset_id: String(r.body["adset_id"]), account_id: ACCT });
      return { json: { id: adId } };
    }
    const target = this.campaigns.get(id) ?? this.adSets.get(id) ?? this.ads.get(id);
    if (!target) return { status: 400, json: { error: { type: "GraphMethodException", code: 100, message: "does not exist" } } };
    if (!this.ignoreWrites) {
      if (typeof r.body["status"] === "string") target.status = r.body["status"];
      if ("daily_budget" in target && r.body["daily_budget"] !== undefined) target.daily_budget = Number(r.body["daily_budget"]);
      if ("bid_amount" in target && r.body["bid_amount"] !== undefined) target.bid_amount = Number(r.body["bid_amount"]);
    }
    return { json: { success: true } };
  }
}
