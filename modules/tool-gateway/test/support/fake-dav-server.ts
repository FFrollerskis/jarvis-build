import { findComponent, fromIcsDate, unfold, type DavRequest, type DavResponse, type DavTransport } from "../../src/personal/apple-dav.ts";

/**
 * WP-G2 P2e: FALSK CalDAV/CardDAV-server i minnet for tester (ingen nettverk). Implementerer det klienten bruker: GET, PUT (`If-None-Match: *` / `If-Match`), DELETE (`If-Match`), REPORT (calendar-query med tidsrom / addressbook-query) og etager.
 * Feilmoduser: `next` kø per metode (`status` = svar uten å utføre, `throw` = feil FØR utføring, `apply_then_throw` = utfør og kast så klienten ikke ser svaret).
 */
export type FakeDavFault = { status: number } | "throw" | "apply_then_throw";

export class FakeDavServer implements DavTransport {
  readonly requests: DavRequest[] = [];
  readonly store = new Map<string, { body: string; etag: string }>();
  private counter = 0;
  private readonly faults: Array<{ method: DavRequest["method"]; fault: FakeDavFault }> = [];
  /** Hrefs serveren (ondsinnet) legger til i REPORT-svar uten at ressursen ligger under samlingen. */
  readonly foreignHrefs: Array<{ href: string; body: string }> = [];
  extraXml = "";

  fail(method: DavRequest["method"], fault: FakeDavFault): void { this.faults.push({ method, fault }); }
  seed(url: string, body: string): string { const etag = this.nextEtag(); this.store.set(url, { body, etag }); return etag; }
  private nextEtag(): string { this.counter += 1; return `"etag-${this.counter}"`; }

  async request(req: DavRequest): Promise<DavResponse> {
    this.requests.push(req);
    const index = this.faults.findIndex((f) => f.method === req.method);
    const fault = index >= 0 ? this.faults.splice(index, 1)[0]?.fault : undefined;
    if (fault === "throw") throw new Error("fake: connection reset");
    if (fault !== undefined && fault !== "apply_then_throw") return { status: fault.status, headers: {}, body: "" };
    const response = this.handle(req);
    if (fault === "apply_then_throw") throw new Error("fake: connection reset after apply");
    return response;
  }

  private handle(req: DavRequest): DavResponse {
    const existing = this.store.get(req.url);
    if (req.method === "GET") return existing ? { status: 200, headers: { etag: existing.etag }, body: existing.body } : { status: 404, headers: {}, body: "" };
    if (req.method === "PUT") {
      if (req.headers["If-None-Match"] === "*" && existing) return { status: 412, headers: {}, body: "" };
      if (req.headers["If-Match"] !== undefined && (!existing || existing.etag !== req.headers["If-Match"])) return { status: 412, headers: {}, body: "" };
      const etag = this.nextEtag();
      this.store.set(req.url, { body: req.body ?? "", etag });
      return { status: existing ? 204 : 201, headers: { etag }, body: "" };
    }
    if (req.method === "DELETE") {
      if (!existing) return { status: 404, headers: {}, body: "" };
      if (req.headers["If-Match"] !== undefined && existing.etag !== req.headers["If-Match"]) return { status: 412, headers: {}, body: "" };
      this.store.delete(req.url);
      return { status: 204, headers: {}, body: "" };
    }
    if (req.method === "REPORT") return this.report(req);
    return { status: 405, headers: {}, body: "" };
  }

  private report(req: DavRequest): DavResponse {
    const body = req.body ?? "";
    const comp = body.includes("addressbook-query") ? "VCARD" : /comp-filter name="(VEVENT|VTODO)"/.exec(body)?.[1] ?? "VEVENT";
    const range = /time-range start="([^"]+)" end="([^"]+)"/.exec(body);
    const iso = (v: string): number => Date.parse(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}Z`);
    const match = /<C:text-match[^>]*>([^<]*)</.exec(body)?.[1];
    const entries: string[] = [];
    for (const [url, { body: raw, etag }] of this.store) {
      if (!url.startsWith(req.url)) continue;
      const found = findComponent(unfold(raw), comp);
      if (!found) continue;
      if (range && comp === "VEVENT") {
        const start = fromIcsDate(found.props.find((p) => p.prop.name === "DTSTART")?.prop);
        const t = start ? Date.parse(start.iso.length === 10 ? `${start.iso}T00:00:00Z` : start.iso) : Number.NaN;
        if (!(t >= iso(range[1] as string) && t < iso(range[2] as string))) continue;
      }
      if (match !== undefined && comp === "VCARD" && !(found.props.find((p) => p.prop.name === "FN")?.prop.value ?? "").toLowerCase().includes(match.toLowerCase())) continue;
      entries.push(this.entry(url, etag, raw, comp === "VCARD"));
    }
    for (const f of this.foreignHrefs) entries.push(this.entry(f.href, "\"x\"", f.body, comp === "VCARD"));
    return { status: 207, headers: {}, body: `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${entries.join("")}${this.extraXml}</D:multistatus>` };
  }

  private entry(href: string, etag: string, raw: string, card: boolean): string {
    const escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const tag = card ? "C:address-data" : "C:calendar-data";
    return `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:getetag>${etag}</D:getetag><${tag}>${escaped}</${tag}></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  }
}

export const ics = (uid: string, summary: string, start: string, extra: string[] = []): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z", `SUMMARY:${summary}`, `DTSTART:${start}`, "DTEND:" + start.replace(/T(\d{2})/, (_m, h: string) => `T${String(Number(h) + 1).padStart(2, "0")}`), ...extra, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
