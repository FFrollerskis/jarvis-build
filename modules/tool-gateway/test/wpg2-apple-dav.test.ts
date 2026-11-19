import { describe, expect, it, vi } from "vitest";
import {
  AppleDavClient, DavError, FetchDavTransport, cleanText, escapeText, findComponent, foldLine, fromIcsDate, itemFromResource, normalizeCollectionUrl, parseDavCollections, parseMultistatus, parseProp,
  patchComponent, propertyChanges, toIcsDate, uidFromKey, unescapeText, unfold, type DavCollection, type DavFetch
} from "../src/personal/apple-dav.ts";
import { UnsafeVendorUrlError } from "../src/url-safety.ts";
import { FakeDavServer, ics } from "./support/fake-dav-server.ts";

/**
 * WP-G2 (D-464) P2e: CalDAV/CardDAV-adapteren mot en FALSK server (ingen nettverk). Live mot iCloud er `BLOCKED_EXTERNAL` (app-spesifikt passord, D-108); endepunkter og Apples dialekt er `unverified`.
 */
const NOW = new Date("2026-11-18T10:00:00.000Z");
const CAL = "https://caldav.example.com/u1/cal/";
const REM = "https://caldav.example.com/u1/rem/";
const CARD = "https://carddav.example.com/u1/card/";
const { collections: COLLECTIONS } = parseDavCollections(`calendar:privat=${CAL}, reminders:todo=${REM} contacts:folk=${CARD}`);
const mk = (): { server: FakeDavServer; client: AppleDavClient } => {
  const server = new FakeDavServer();
  return { server, client: new AppleDavClient({ transport: server, collections: COLLECTIONS, now: () => NOW }) };
};
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "ok"; } catch (e) { return e instanceof DavError ? e.code : `other:${(e as Error).message}`; } };

describe("A: samlinger er en allowlist (SSRF-vern)", () => {
  it("kun https-URL-er til DNS-navn med standardport uten brukerinfo/spørring/fragment godtas; resten forkastes og telles", () => {
    expect(COLLECTIONS.map((c) => [c.kind, c.name, c.url])).toEqual([["calendar", "privat", CAL], ["reminders", "todo", REM], ["contacts", "folk", CARD]]);
    const bad = [
      "calendar:a=http://x.example.com/c/", "calendar:b=https://127.0.0.1/c/", "calendar:c=https://localhost/c/", "calendar:d=https://x.example.com:8443/c/", "calendar:e=https://u:p@x.example.com/c/",
      "calendar:f=https://x.example.com/c/?q=1", "calendar:g=https://x.example.com/c/#f", "calendar:H=https://x.example.com/c/", "files:i=https://x.example.com/c/", "calendar:j=https://intranet/c/"
    ].join(" ");
    expect(parseDavCollections(bad)).toEqual({ collections: [], rejected: 10 });
    expect(parseDavCollections("calendar:a=https://x.example.com/c, calendar:a=https://y.example.com/c/")).toMatchObject({ rejected: 1, collections: [{ name: "a", url: "https://x.example.com/c/" }] }); // duplikat navn; sluttskråstrek legges til
    expect(parseDavCollections(undefined)).toEqual({ collections: [], rejected: 0 });
    expect(normalizeCollectionUrl("https://X.Example.COM/a/b")).toBe("https://x.example.com/a/b/");
  });
});

describe("B: kodek - escaping, folding, datoer og endring uten datatap", () => {
  it("escaping og injeksjonsvern: linjeskift/semikolon/komma/backslash blir tekst, kontrolltegn og ukjente felt avvises", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    expect(unescapeText(escapeText("a,b;c\\d\ne"))).toBe("a,b;c\\d\ne");
    const changes = propertyChanges("calendar", { summary: "x\nEND:VEVENT\nBEGIN:VEVENT\nATTENDEE:mailto:ond@example.com", start: "2026-12-01T08:00:00Z" }, NOW);
    expect(changes["SUMMARY"]).toHaveLength(1);
    expect(changes["SUMMARY"]?.[0]).not.toMatch(/[\r\n]/);
    expect(changes["SUMMARY"]?.[0]).toBe("SUMMARY:x\\nEND:VEVENT\\nBEGIN:VEVENT\\nATTENDEE:mailto:ond@example.com");
    expect(() => cleanText(`a${String.fromCharCode(7)}b`, 10, "f")).toThrow(DavError);
    expect(() => cleanText("x".repeat(11), 10, "f")).toThrow(DavError);
    expect(() => propertyChanges("calendar", { summary: "x", attendee: "mailto:a@b.c" }, NOW)).toThrow(/invalid_input:unknown_field/);
    expect(() => propertyChanges("calendar", { status: "BUSY" }, NOW)).toThrow(DavError);
    expect(() => propertyChanges("contacts", { emails: Array.from({ length: 6 }, () => "a@b.c") }, NOW)).toThrow(DavError);
    expect(() => propertyChanges("reminders", { completed: "ja" }, NOW)).toThrow(DavError);
  });

  it("folding ved 75 oktetter (også flerbyte-tegn) og tilbake; parsing av egenskaper med anførte parametere", () => {
    const line = `SUMMARY:${"æøå".repeat(40)}`;
    const folded = foldLine(line);
    for (const physical of folded.split("\r\n")) expect(Buffer.byteLength(physical)).toBeLessThanOrEqual(75);
    expect(unfold(`${folded}\r\n`)).toEqual([line]);
    expect(parseProp('DTSTART;TZID="Europe/Oslo";X=1:20261201T090000')).toEqual({ name: "DTSTART", params: { TZID: "Europe/Oslo", X: "1" }, value: "20261201T090000" });
    expect(parseProp('ATTENDEE;CN="a:b":mailto:x@y.z')?.value).toBe("mailto:x@y.z");
    expect(parseProp("ingen kolon")).toBeNull();
  });

  it("datoer: heldag og UTC inn, `YYYYMMDD`/UTC/IANA-TZID ut (sommer- og vintertid); ugyldige datoer avvises", () => {
    expect(toIcsDate("2026-12-01", "d")).toEqual({ value: "20261201", allDay: true });
    expect(toIcsDate("2026-12-01T09:00:00+01:00", "d")).toEqual({ value: "20261201T080000Z", allDay: false });
    for (const bad of ["2026-02-30", "i morgen", "20261201", 5, "2026-12-01 09:00"]) expect(() => toIcsDate(bad, "d"), String(bad)).toThrow(DavError);
    const at = (line: string) => fromIcsDate(parseProp(line) ?? undefined);
    expect(at("DTSTART:20261201T080000Z")).toEqual({ iso: "2026-12-01T08:00:00.000Z", allDay: false });
    expect(at("DTSTART;VALUE=DATE:20261201")).toEqual({ iso: "2026-12-01", allDay: true });
    expect(at("DTSTART;TZID=Europe/Oslo:20261201T090000")?.iso).toBe("2026-12-01T08:00:00.000Z");
    expect(at("DTSTART;TZID=Europe/Oslo:20260701T090000")?.iso).toBe("2026-07-01T07:00:00.000Z");
    expect(at("DTSTART;TZID=Ikke/Finnes:20261201T090000")).toBeNull();
    expect(at("DTSTART:morgen")).toBeNull();
  });

  it("endring rører KUN de oppgitte egenskapene på komponentens eget nivå: varsler (VALARM), ukjente felt og underkomponentens DESCRIPTION står urørt", () => {
    const raw = ics("uid-123456", "Gammel", "20261201T080000Z", ["X-CUSTOM:behold", "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Varsel-tekst", "TRIGGER:-PT15M", "END:VALARM"]);
    const patched = patchComponent(raw, "VEVENT", { SUMMARY: ["SUMMARY:Ny"], DESCRIPTION: ["DESCRIPTION:Beskrivelse"], LOCATION: null });
    const lines = unfold(patched);
    expect(lines).toContain("SUMMARY:Ny");
    expect(lines).toContain("X-CUSTOM:behold");
    expect(lines.filter((l) => l === "DESCRIPTION:Varsel-tekst")).toHaveLength(1);
    expect(lines).toContain("DESCRIPTION:Beskrivelse");
    expect(lines.indexOf("DESCRIPTION:Beskrivelse")).toBeGreaterThan(lines.indexOf("END:VALARM")); // nye linjer settes før END:VEVENT, ikke inni VALARM
    expect(lines.filter((l) => l.startsWith("SUMMARY"))).toEqual(["SUMMARY:Ny"]);
    expect(findComponent(lines, "VEVENT")?.props.some((p) => p.prop.name === "TRIGGER")).toBe(false); // TRIGGER hører til VALARM
    expect(() => patchComponent("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", "VEVENT", {})).toThrow(DavError);
  });

  it("ressurs -> element: unescaped tekst, heldag, gjentakelse; innhold kuttes; ugyldig ressurs gir null; multistatus avviser DOCTYPE og avkoder entiteter", () => {
    const raw = ics("uid-123456", "Møte\\, viktig", "20261201T080000Z", ["RRULE:FREQ=WEEKLY", `DESCRIPTION:${"d".repeat(900)}`, "LOCATION:Oslo"]);
    const item = itemFromResource("calendar", raw, `${CAL}uid-123456.ics`, '"e1"');
    expect(item).toMatchObject({ kind: "calendar", uid: "uid-123456", summary: "Møte, viktig", start: "2026-12-01T08:00:00.000Z", end: "2026-12-01T09:00:00.000Z", all_day: false, recurring: true, location: "Oslo", etag: '"e1"' });
    expect(item?.description?.length).toBe(500);
    expect(itemFromResource("calendar", "BEGIN:VCARD\r\nEND:VCARD\r\n", "h", null)).toBeNull();
    expect(itemFromResource("calendar", "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", "h", null)).toBeNull(); // uten UID
    expect(() => parseMultistatus('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><multistatus/>')).toThrow(DavError);
    expect(parseMultistatus('<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a.ics</D:href><D:getetag>&quot;e&amp;1&quot;</D:getetag><C:calendar-data><![CDATA[BEGIN:VCALENDAR]]></C:calendar-data><D:status>HTTP/1.1 200 OK</D:status></D:response></D:multistatus>'))
      .toEqual([{ href: "/a.ics", etag: '"e&1"', data: "BEGIN:VCALENDAR", status: 200 }]);
  });
});

describe("C: klienten mot en falsk server - les, opprett, endre, slett med readback", () => {
  it("opprett: UID utledet fra idempotensnøkkelen, `If-None-Match: *`, readback; samme nøkkel igjen = REPLAYED (ingen duplikat), samme nøkkel med annet innhold = MISMATCH", async () => {
    const { server, client } = mk();
    const fields = { summary: "Tannlege", start: "2026-12-01T08:00:00Z", end: "2026-12-01T09:00:00Z", location: "Oslo, Storgata 1" };
    const created = await client.create("privat", "idem-key-0001", fields);
    expect(created).toMatchObject({ outcome: "SUCCESS", uid: uidFromKey("privat", "idem-key-0001") });
    expect(created.uid).toMatch(/^jarvis-[0-9a-f]{32}$/);
    expect(created.item).toMatchObject({ summary: "Tannlege", start: "2026-12-01T08:00:00.000Z", location: "Oslo, Storgata 1" });
    const put = server.requests.find((r) => r.method === "PUT");
    expect(put?.headers["If-None-Match"]).toBe("*");
    expect(put?.url).toBe(`${CAL}${created.uid}.ics`);
    expect(put?.body).toContain("LOCATION:Oslo\\, Storgata 1");
    expect(put?.body).toContain("PRODID:-//Jarvis//WP-G2//EN");
    expect((await client.create("privat", "idem-key-0001", fields)).outcome).toBe("REPLAYED");
    expect(server.store.size).toBe(1);
    const different = await client.create("privat", "idem-key-0001", { ...fields, summary: "Noe helt annet" });
    expect(different).toMatchObject({ outcome: "MISMATCH", reason: "readback_differs" });
    expect(server.store.size).toBe(1);
    expect(uidFromKey("privat", "idem-key-0001")).not.toBe(uidFromKey("todo", "idem-key-0001"));
  });

  it("liste og hent: tidsrom-spørring, kun elementer under samlingen (en ondsinnet href utenfor ignoreres), DOCTYPE i svaret avvises", async () => {
    const { server, client } = mk();
    server.seed(`${CAL}a-uid-001.ics`, ics("a-uid-001", "Desember 1", "20261201T080000Z"));
    server.seed(`${CAL}b-uid-002.ics`, ics("b-uid-002", "Desember 10", "20261210T080000Z"));
    server.foreignHrefs.push({ href: "https://evil.example.net/x.ics", body: ics("evil-uid-1", "Fremmed", "20261201T080000Z") }, { href: `${CAL}../hemmelig/x.ics`, body: ics("evil-uid-2", "Traversering", "20261201T080000Z") });
    const items = await client.list("privat", { from: "2026-12-01", to: "2026-12-02" });
    expect(items.map((i) => i.summary)).toEqual(["Desember 1"]);
    expect(items[0]?.href).toBe(`${CAL}a-uid-001.ics`);
    expect((await client.get("privat", "b-uid-002"))?.summary).toBe("Desember 10");
    expect(await client.get("privat", "finnes-ikke-1")).toBeNull();
    expect(server.requests.every((r) => r.url.startsWith(CAL))).toBe(true);
    // `from`/`to` hører sammen, og `limit` klemmes til 1-200: en negativ verdi gir ikke «alt unntatt de siste», en brøk avrundes ned
    expect(await code(client.list("privat", { from: "2026-12-01" }))).toBe("invalid_input");
    expect(await code(client.list("privat", { to: "2026-12-02" }))).toBe("invalid_input");
    expect(await client.list("privat")).toHaveLength(2);
    expect(await client.list("privat", { limit: -3 })).toHaveLength(1);
    expect(await client.list("privat", { limit: 0 })).toHaveLength(1);
    expect(await client.list("privat", { limit: 1.9 })).toHaveLength(1);
    expect(await client.list("privat", { limit: 5000 })).toHaveLength(2);
    server.extraXml = "<!DOCTYPE x>";
    expect(await code(client.list("privat", { from: "2026-12-01", to: "2026-12-02" }))).toBe("dav_malformed_response");
  });

  it("endre: kun oppgitte egenskaper, SEQUENCE økes, varsler beholdes, ny etag; gammel etag og samtidig endring gir etag_mismatch; gjentakende arrangement kan ikke flyttes", async () => {
    const { server, client } = mk();
    const etag = server.seed(`${CAL}u-uid-0001.ics`, ics("u-uid-0001", "Gammel", "20261201T080000Z", ["BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "END:VALARM"]));
    const res = await client.update("privat", "u-uid-0001", etag, { summary: "Ny tittel", location: "Bergen" });
    expect(res.outcome).toBe("SUCCESS");
    expect(res.etag).not.toBe(etag);
    const body = server.store.get(`${CAL}u-uid-0001.ics`)?.body ?? "";
    expect(body).toContain("SUMMARY:Ny tittel");
    expect(body).toContain("BEGIN:VALARM");
    expect(body).toContain("SEQUENCE:1");
    expect(body).toContain("DTSTART:20261201T080000Z"); // urørt
    expect(await code(client.update("privat", "u-uid-0001", etag, { summary: "Utdatert" }))).toBe("etag_mismatch"); // gammel etag (pre-sjekk)
    const fresh = server.store.get(`${CAL}u-uid-0001.ics`)?.etag as string;
    server.fail("PUT", { status: 412 });
    expect(await code(client.update("privat", "u-uid-0001", fresh, { summary: "Race" }))).toBe("etag_mismatch"); // noen endret den mellom lesing og skriving
    expect(await code(client.update("privat", "u-uid-0001", fresh, {}))).toBe("invalid_input");
    expect(await code(client.update("privat", "finnes-ikke-1", '"e"', { summary: "x" }))).toBe("not_found");
    const rec = server.seed(`${CAL}r-uid-0001.ics`, ics("r-uid-0001", "Ukentlig", "20261201T080000Z", ["RRULE:FREQ=WEEKLY"]));
    expect(await code(client.update("privat", "r-uid-0001", rec, { start: "2026-12-02T08:00:00Z" }))).toBe("unsupported_change");
    expect((await client.update("privat", "r-uid-0001", rec, { summary: "Ukentlig (omdøpt)" })).outcome).toBe("SUCCESS");
  });

  it("slett: If-Match, readback viser at den er borte; feil etag = etag_mismatch; allerede borte = REPLAYED; sletting krever gyldig UID/etag", async () => {
    const { server, client } = mk();
    const etag = server.seed(`${CAL}d-uid-0001.ics`, ics("d-uid-0001", "Slettes", "20261201T080000Z"));
    expect(await code(client.remove("privat", "d-uid-0001", '"feil"'))).toBe("etag_mismatch");
    expect(server.store.size).toBe(1);
    expect(await client.remove("privat", "d-uid-0001", etag)).toMatchObject({ outcome: "SUCCESS", uid: "d-uid-0001" });
    expect(server.store.size).toBe(0);
    expect((await client.remove("privat", "d-uid-0001", etag)).outcome).toBe("REPLAYED");
    expect(await code(client.remove("privat", "../../etc/passwd", etag))).toBe("invalid_uid");
    expect(await code(client.remove("privat", "d-uid-0001", "uten-anførselstegn"))).toBe("invalid_etag");
  });

  it("uavklart utfall: feil etter sending avgjøres av readback (bevist anvendt = SUCCESS), ellers UNKNOWN; 5xx = UNKNOWN; 401 er bevist IKKE anvendt (kastes)", async () => {
    const { server, client } = mk();
    const fields = { summary: "Test", start: "2026-12-01T08:00:00Z" };
    server.fail("PUT", "apply_then_throw");
    expect(await client.create("privat", "idem-key-0002", fields)).toMatchObject({ outcome: "SUCCESS", reason: "confirmed_by_readback_after_transport_error" });
    server.fail("PUT", "throw");
    expect(await client.create("privat", "idem-key-0003", fields)).toMatchObject({ outcome: "UNKNOWN", reason: "transport_error_after_send" });
    server.fail("PUT", { status: 503 });
    expect(await client.create("privat", "idem-key-0004", fields)).toMatchObject({ outcome: "UNKNOWN", reason: "server_503" });
    server.fail("PUT", { status: 401 });
    expect(await code(client.create("privat", "idem-key-0005", fields))).toBe("dav_auth_rejected");
    server.fail("PUT", { status: 400 });
    expect(await code(client.create("privat", "idem-key-0006", fields))).toBe("dav_rejected");
    const etag = server.seed(`${CAL}x-uid-0001.ics`, ics("x-uid-0001", "x", "20261201T080000Z"));
    server.fail("DELETE", "throw");
    expect(await client.remove("privat", "x-uid-0001", etag)).toMatchObject({ outcome: "UNKNOWN" });
    server.fail("PUT", "throw");
    expect(await client.update("privat", "x-uid-0001", etag, { summary: "y" })).toMatchObject({ outcome: "UNKNOWN" });
  });

  it("kontakter: vCard med N utledet fra navnet, e-post/telefon som lister, org/notat escapet; ukjente vCard-felt beholdes ved endring; tekstsøk", async () => {
    const { server, client } = mk();
    const created = await client.create("folk", "idem-card-0001", { full_name: "Kari Nordmann", emails: ["kari@example.com"], phones: ["+4712345678"], org: "ACME, Inc", note: "Møtt;2026" });
    expect(created.outcome).toBe("SUCCESS");
    const url = `${CARD}${created.uid}.vcf`;
    const body = server.store.get(url)?.body ?? "";
    for (const line of ["VERSION:3.0", "FN:Kari Nordmann", "N:Nordmann;Kari;;;", "EMAIL;TYPE=INTERNET:kari@example.com", "TEL;TYPE=VOICE:+4712345678", "ORG:ACME\\, Inc", "NOTE:Møtt\\;2026"]) expect(body, line).toContain(line);
    expect(created.item).toMatchObject({ full_name: "Kari Nordmann", emails: ["kari@example.com"], org: "ACME, Inc", note: "Møtt;2026" });
    const seeded = server.seed(`${CARD}o-uid-0001.vcf`, ["BEGIN:VCARD", "VERSION:3.0", "UID:o-uid-0001", "FN:Ola Hansen", "N:Hansen;Ola;;;", "X-ABUID:behold-meg", "EMAIL;TYPE=INTERNET:ola@example.com", "END:VCARD", ""].join("\r\n"));
    const updated = await client.update("folk", "o-uid-0001", seeded, { emails: ["ola@nytt.example.com", "ola2@example.com"] });
    expect(updated.outcome).toBe("SUCCESS");
    expect(server.store.get(`${CARD}o-uid-0001.vcf`)?.body).toContain("X-ABUID:behold-meg");
    expect(updated.item?.emails).toEqual(["ola@nytt.example.com", "ola2@example.com"]);
    expect((await client.list("folk", { text: "kari" })).map((i) => i.full_name)).toEqual(["Kari Nordmann"]);
    expect(await client.list("folk", { text: "xyz" })).toEqual([]);
    expect(await code(client.create("folk", "idem-card-0002", { emails: ["a@b.c"] }))).toBe("invalid_input"); // navn påkrevd
  });

  it("påminnelser: opprett med forfall (heldag), fullfør (STATUS + COMPLETED-stempel) og gjenåpne (COMPLETED fjernes)", async () => {
    const { server, client } = mk();
    const created = await client.create("todo", "idem-todo-0001", { summary: "Ring tannlegen", due: "2026-12-02" });
    expect(created).toMatchObject({ outcome: "SUCCESS", item: { summary: "Ring tannlegen", due: "2026-12-02", completed: false } });
    const done = await client.update("todo", created.uid, created.etag as string, { completed: true });
    expect(done).toMatchObject({ outcome: "SUCCESS", item: { completed: true } });
    expect(server.store.get(`${REM}${created.uid}.ics`)?.body).toContain("COMPLETED:20261118T100000Z");
    const reopened = await client.update("todo", created.uid, done.etag as string, { completed: false });
    expect(reopened.item?.completed).toBe(false);
    expect(server.store.get(`${REM}${created.uid}.ics`)?.body).not.toContain("COMPLETED:");
    expect(await code(client.create("todo", "idem-todo-0002", { start: "2026-12-01T08:00:00Z" }))).toBe("invalid_input"); // «start» finnes ikke for påminnelser
  });

  it("samling og inndata: ukjent samling/slag nektes; for kort idempotensnøkkel, ugyldig UID og manglende påkrevde felt avvises FØR noe sendes", async () => {
    const { server, client } = mk();
    expect(await code(client.get("finnes-ikke", "abcdef-1"))).toBe("collection_not_allowed");
    expect(await code(client.list(undefined))).toBe("collection_not_allowed");
    expect(await code(client.create("privat", "kort", { summary: "x", start: "2026-12-01T08:00:00Z" }))).toBe("invalid_input");
    expect(await code(client.create("privat", "idem-key-0007", { summary: "uten start" }))).toBe("invalid_input");
    expect(await code(client.get("privat", "../x"))).toBe("invalid_uid");
    expect(server.requests).toHaveLength(0);
    expect(client.listCollections()).toEqual([{ name: "privat", kind: "calendar" }, { name: "todo", kind: "reminders" }, { name: "folk", kind: "contacts" }]);
  });
});

describe("D: HTTP-transporten (kun med injisert fetch; ingen nettkall)", () => {
  const collections: DavCollection[] = [{ name: "privat", kind: "calendar", url: CAL }];
  const creds = async () => ({ user: "eier@example.com", password: "app-passord-fake-123" });
  const make = (fetchFn: unknown, extra: Partial<ConstructorParameters<typeof FetchDavTransport>[0]> = {}) => new FetchDavTransport({ collections, credentials: creds, fetchFn: fetchFn as unknown as DavFetch, ...extra });
  const ok = () => vi.fn(async () => new Response("<ok/>", { status: 207, headers: { ETag: '"e1"' } }));

  it("sender Basic-autentisering fra vault-verdier, aldri redirect, og gir status/hoder/innhold; kun URL-er under en samling", async () => {
    const fetchFn = ok();
    const res = await make(fetchFn).request({ method: "REPORT", url: CAL, headers: { Depth: "1" }, body: "<x/>" });
    expect(res).toEqual({ status: 207, headers: expect.objectContaining({ etag: '"e1"' }), body: "<ok/>" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(CAL);
    expect(init.redirect).toBe("reject"); // guardedFetch gjør «reject» til manual + avvisning av 3xx for ALLE metoder
    expect(init.signal).toBeInstanceOf(AbortSignal); // eget tak, aldri uten signal
    expect(init.headers["Authorization"]).toBe(`Basic ${Buffer.from("eier@example.com:app-passord-fake-123").toString("base64")}`);
    for (const url of ["https://evil.example.net/u1/cal/", "http://caldav.example.com/u1/cal/", "https://caldav.example.com:8443/u1/cal/", "https://caldav.example.com/u1/other/", "ikke en url"]) {
      const f = ok();
      expect(await code(make(f).request({ method: "GET", url, headers: {} })), url).toBe("url_not_allowed");
      expect(f).not.toHaveBeenCalled();
    }
  });

  it("uten credentials sendes ingenting (fail closed); redirect, for stort svar og nettfeil gir kode uten å lekke passord/feiltekst", async () => {
    const f = ok();
    expect(await code(new FetchDavTransport({ collections, credentials: async () => null, fetchFn: f as unknown as DavFetch }).request({ method: "GET", url: `${CAL}a.ics`, headers: {} }))).toBe("dav_credentials_unavailable");
    expect(f).not.toHaveBeenCalled();
    expect(await code(make(vi.fn(async () => new Response("", { status: 302, headers: { Location: "https://evil.example.net/" } }))).request({ method: "GET", url: `${CAL}a.ics`, headers: {} }))).toBe("dav_redirect_refused");
    expect(await code(make(ok(), { maxBytes: 3 }).request({ method: "GET", url: `${CAL}a.ics`, headers: {} }))).toBe("dav_response_too_large");
    const leak = make(vi.fn(async () => { throw new Error("connect ECONNRESET https://caldav.example.com app-passord-fake-123"); }));
    const err = await leak.request({ method: "GET", url: `${CAL}a.ics`, headers: {} }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(DavError);
    expect((err as Error).message).toBe("dav_unreachable");
    expect((err as Error).message).not.toContain("passord");
    const slow = make(vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("avbrutt"))))), { timeoutMs: 20 });
    expect(await code(slow.request({ method: "GET", url: `${CAL}a.ics`, headers: {} }))).toBe("dav_unreachable");
  });

  it("standard-transporten går via guardedFetch (D-436): redirect følges ALDRI (heller ikke for GET), nettfeil gir kode uten feiltekst, og et allerede avbrutt kall sender ingenting", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      spy.mockResolvedValue(new Response("<ok/>", { status: 207, headers: { ETag: '"e1"' } }));
      const transport = new FetchDavTransport({ collections, credentials: creds }); // ingen fetchFn: standarden er guardedFetch
      expect((await transport.request({ method: "GET", url: `${CAL}a.ics`, headers: {} })).status).toBe(207);
      const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
      expect(url).toBe(`${CAL}a.ics`);
      expect(init.redirect).toBe("manual"); // «reject» blir manual + avvisning av 3xx i guardedFetch
      expect(init.headers["Authorization"]).toMatch(/^Basic /);
      for (const method of ["GET", "PUT", "DELETE"] as const) {
        spy.mockResolvedValueOnce(new Response("", { status: 307, headers: { Location: "https://evil.example.net/" } }));
        expect(await code(transport.request({ method, url: `${CAL}a.ics`, headers: {}, ...(method === "PUT" ? { body: "x" } : {}) })), method).toBe("dav_redirect_refused");
      }
      expect(spy).toHaveBeenCalledTimes(4); // ingen oppfølgingsforespørsel til evil.example.net
      spy.mockRejectedValueOnce(new Error("connect ECONNRESET app-passord-fake-123"));
      const err = await transport.request({ method: "GET", url: `${CAL}a.ics`, headers: {} }).catch((e: unknown) => e as Error);
      expect((err as Error).message).toBe("dav_unreachable");
      spy.mockClear();
      expect(await code(transport.request({ method: "GET", url: `${CAL}a.ics`, headers: {}, signal: AbortSignal.abort() }))).toBe("dav_unreachable");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("feil fra guardedFetch oversettes til koder uten å lekke feiltekst: utrygg URL = url_not_allowed, uventet redirect = dav_redirect_refused", async () => {
    const thrower = (reason: string) => vi.fn(async () => { throw new UnsafeVendorUrlError(reason); });
    expect(await code(make(thrower("url_malformed")).request({ method: "GET", url: `${CAL}a.ics`, headers: {} }))).toBe("url_not_allowed");
    expect(await code(make(thrower("dot_segment")).request({ method: "GET", url: `${CAL}a.ics`, headers: {} }))).toBe("url_not_allowed");
    expect(await code(make(thrower("unexpected_redirect_http_308")).request({ method: "PUT", url: `${CAL}a.ics`, headers: {}, body: "x" }))).toBe("dav_redirect_refused");
  });

  it("for stort svar avbrytes strømmet: en for stor Content-Length avvises uten å lese kroppen, og en uendelig kropp avbrytes når taket passeres (ikke lest ferdig)", async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(new TextEncoder().encode("x".repeat(100))); },
      cancel() { cancelled = true; }
    }), { status: 207 });
    expect(await code(make(vi.fn(async () => endless()), { maxBytes: 450 }).request({ method: "GET", url: `${CAL}a.ics`, headers: {} }))).toBe("dav_response_too_large");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
    const declared = vi.fn(async () => new Response("kort", { status: 200, headers: { "Content-Length": "999999" } }));
    expect(await code(make(declared, { maxBytes: 1000 }).request({ method: "GET", url: `${CAL}a.ics`, headers: {} }))).toBe("dav_response_too_large");
    // under taket leses hele svaret som før
    expect((await make(ok(), { maxBytes: 100 }).request({ method: "GET", url: `${CAL}a.ics`, headers: {} })).body).toBe("<ok/>");
  });

  it("klient + transport: en 401 fra serveren er bevist ikke-anvendt (kastes), og alle forespørsler holder seg under samlingen", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => { calls.push(url); return new Response("", { status: 401 }); });
    const client = new AppleDavClient({ transport: make(fetchFn), collections, now: () => NOW });
    expect(await code(client.create("privat", "idem-key-0009", { summary: "x", start: "2026-12-01T08:00:00Z" }))).toBe("dav_auth_rejected");
    expect(calls.every((u) => u.startsWith(CAL))).toBe(true);
  });
});
