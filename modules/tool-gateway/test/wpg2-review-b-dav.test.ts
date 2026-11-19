import { describe, expect, it } from "vitest";
import { AppleDavClient, DavError, itemFromResource, normalizeCollectionUrl, parseDavCollections, parseMultistatus, patchComponent, propertyChanges, toIcsDate, unfold } from "../src/personal/apple-dav.ts";
import { FakeDavServer, ics } from "./support/fake-dav-server.ts";

/**
 * WP-G2 fiks-runde (review B, LOW-1/2/3/7/8): adapteren mot iCloud-lignende data. Hver test feller den gamle koden (se mutasjonsbeviset i rapporten).
 *  - LOW-1: Apple-grupperte vCard-egenskaper (`item1.EMAIL` + `item1.X-ABLabel`) er synlige og erstattes sammen med sin etikett.
 *  - LOW-2: datoer valideres strengt (ingen stille skift, ingen offset-løse tidspunkt), `create` krever tittel, `end` kan ikke være før `start`, ingen blandet dato/tidspunkt, DURATION+DTEND blir aldri begge.
 *  - LOW-3: `parseMultistatus` er lineær (1 MiB uten lukking blokkerte event-loopen i 12,8 s), numeriske tegnreferanser dekodes, og tekst i en hendelse kan ikke sette statuskoden.
 *  - LOW-7: endring/sletting av en hendelse MED deltakere kan sende e-post til andre (iTIP, uverifisert mot iCloud): krever eksplisitt eier-bekreftelse.
 *  - LOW-8: samlings-URL-vernet avviser `localhost.`, `*.localhost`, `*.internal` og jokertegn-DNS som bærer en IP.
 */
const NOW = new Date("2026-11-19T10:00:00.000Z");
const CAL = "https://caldav.example.com/u1/cal/";
const CARD = "https://carddav.example.com/u1/card/";
const TODO = "https://caldav.example.com/u1/todo/";
const { collections } = parseDavCollections(`calendar:privat=${CAL} contacts:folk=${CARD} reminders:todo=${TODO}`);
const mk = () => { const server = new FakeDavServer(); return { server, client: new AppleDavClient({ transport: server, collections, now: () => NOW }) }; };
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "ok"; } catch (e) { return e instanceof DavError ? e.code : `other:${(e as Error).message}`; } };

describe("A: Apple-grupperte vCard-egenskaper (LOW-1)", () => {
  const vcf = ["BEGIN:VCARD", "VERSION:3.0", "UID:card-0001", "FN:Ola Nordmann", "N:Nordmann;Ola;;;", "item1.EMAIL;type=INTERNET;type=pref:ola@example.com", "item1.X-ABLabel:Jobb", "EMAIL;type=INTERNET;type=HOME:ola@home.example",
    "TEL;type=CELL:+4712345678", "item2.TEL:+4787654321", "item2.X-ABLabel:Hytta", "X-CUSTOM:behold", "END:VCARD", ""].join("\r\n");

  it("gruppert primær-e-post/telefon vises i list/get (ikke bare de uten gruppe)", () => {
    const item = itemFromResource("contacts", vcf, "h", null);
    expect(item?.emails).toEqual(["ola@example.com", "ola@home.example"]);
    expect(item?.phones).toEqual(["+4712345678", "+4787654321"]);
  });

  it("endring av e-post erstatter ALLE e-postegenskaper (også gruppert) og fjerner gruppens etikett; telefon og ukjente felt står urørt", () => {
    const patched = unfold(patchComponent(vcf, "VCARD", propertyChanges("contacts", { emails: ["ny@example.com"] }, NOW)));
    expect(patched.filter((l) => /(^|\.)EMAIL[;:]/i.test(l))).toEqual(["EMAIL;TYPE=INTERNET:ny@example.com"]);
    expect(patched.some((l) => l.startsWith("item1."))).toBe(false); // gruppen (e-post + etikett) er borte samlet
    expect(patched).toContain("item2.TEL:+4787654321");
    expect(patched).toContain("item2.X-ABLabel:Hytta"); // en ANNEN gruppe (telefon) står urørt
    expect(patched).toContain("X-CUSTOM:behold");
    expect(patched).toContain("TEL;type=CELL:+4712345678");
  });

  it("end-to-end: oppdatering gjennom klienten gir readback SUCCESS og det gamle gruppeinnholdet er borte (ikke lagt til ved siden av)", async () => {
    const { server, client } = mk();
    const url = `${CARD}card-0001.vcf`;
    const etag = server.seed(url, vcf);
    const res = await client.update("folk", "card-0001", etag, { emails: ["ny@example.com"] });
    expect(res.outcome).toBe("SUCCESS");
    expect(res.item?.emails).toEqual(["ny@example.com"]);
    expect(server.store.get(url)?.body).not.toContain("ola@example.com");
  });
});

describe("B: datoer og felt valideres strengt (LOW-2)", () => {
  it("toIcsDate: ugyldig dato (feb 30, kl 25), tidspunkt UTEN sone og tekst rundt avvises - ingen stille skift til 2. mars; offset og brøkdel godtas", () => {
    for (const bad of ["2026-02-30T10:00:00Z", "2026-11-20T25:00:00Z", "2026-13-01T10:00:00Z", "2026-11-20T10:00:00", "2026-11-20T10:00", "2026-11-20T10:00:00Z; DESCRIPTION:evil", "2026-11-20T"]) {
      expect(() => toIcsDate(bad, "f"), bad).toThrow(DavError);
    }
    expect(toIcsDate("2026-11-20T10:00:00+01:00", "f")).toEqual({ value: "20261120T090000Z", allDay: false });
    expect(toIcsDate("2026-11-20T10:00:00.123Z", "f")).toEqual({ value: "20261120T100000Z", allDay: false });
    expect(toIcsDate("2026-11-20T10:00Z", "f")).toEqual({ value: "20261120T100000Z", allDay: false });
  });

  it("create: tom/null/manglende tittel omgår ikke «tittel kreves», og `end` før `start` eller blandet heldag/tidspunkt avvises (kun serveren avgjorde før)", async () => {
    const { client } = mk();
    const start = "2026-12-01T08:00:00Z";
    for (const summary of [undefined, "", null]) expect(await code(client.create("privat", "idem-key-1001", { ...(summary === undefined ? {} : { summary }), start } as never)), String(summary)).toBe("invalid_input");
    expect(await code(client.create("privat", "idem-key-1002", { summary: "x", start, end: "2026-12-01T07:00:00Z" }))).toBe("invalid_input"); // end < start
    expect(await code(client.create("privat", "idem-key-1003", { summary: "x", start: "2026-12-01", end: "2026-12-01T09:00:00Z" }))).toBe("invalid_input"); // heldag + tidspunkt
    expect(await code(client.create("privat", "idem-key-1004", { summary: "x", start, end: "2026-12-01T09:00:00Z" }))).toBe("ok");
    expect(await code(client.create("privat", "idem-key-1005", { summary: "heldag", start: "2026-12-02", end: "2026-12-03" }))).toBe("ok");
  });

  it("update: ny `start` som tidspunkt på en heldagshendelse (eller omvendt) gir ikke blandet VALUE=DATE/DATE-TIME, og `end` før eksisterende `start` avvises", async () => {
    const { server, client } = mk();
    const allDay = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:allday-0001", "DTSTAMP:20260101T000000Z", "SUMMARY:Heldag", "DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261121", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    const etag = server.seed(`${CAL}allday-0001.ics`, allDay);
    expect(await code(client.update("privat", "allday-0001", etag, { start: "2026-11-20T10:00:00Z" }))).toBe("invalid_input");
    expect(await code(client.update("privat", "allday-0001", etag, { end: "2026-11-19" }))).toBe("invalid_input"); // end før eksisterende start
    expect(await code(client.update("privat", "allday-0001", etag, { end: "2026-11-22" }))).toBe("ok");
  });

  it("DTSTART + DURATION og ny `end`: DURATION fjernes (en VEVENT med både DTEND og DURATION er ugyldig iCalendar)", () => {
    const raw = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:abcdef2", "SUMMARY:D", "DTSTART:20261120T100000Z", "DURATION:PT1H", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    const lines = unfold(patchComponent(raw, "VEVENT", propertyChanges("calendar", { end: "2026-11-20T12:00:00Z" }, NOW)));
    expect(lines).toContain("DTEND:20261120T120000Z");
    expect(lines.some((l) => l.startsWith("DURATION"))).toBe(false);
  });
});

describe("C: parseMultistatus er lineær og robust (LOW-3)", () => {
  it("1 MiB `<D:response ` uten lukking blokkerer ikke event-loopen (var 12,8 s kvadratisk): ferdig på under 1 s og gir ingen elementer", () => {
    const hostile = "<D:multistatus xmlns:D=\"DAV:\">" + "<D:response ".repeat(Math.floor(1_048_576 / 12));
    const started = Date.now();
    expect(parseMultistatus(hostile)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("numeriske tegnreferanser (`&#xD;`, `&#13;`, `&#x41;`) dekodes - linjene får ikke en `&#xD;`-hale som skjuler DTSTART", () => {
    const body = "BEGIN:VCALENDAR&#xD;&#10;BEGIN:VEVENT&#xD;&#10;UID:abc-12345&#xD;&#10;SUMMARY:&#x41;pple&#xD;&#10;DTSTART:20261201T080000Z&#xD;&#10;END:VEVENT&#xD;&#10;END:VCALENDAR";
    const [entry] = parseMultistatus(`<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a.ics</D:href><D:propstat><D:prop><C:calendar-data>${body}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`);
    const item = itemFromResource("calendar", entry?.data ?? "", "h", null);
    expect(item).toMatchObject({ uid: "abc-12345", summary: "Apple", start: "2026-12-01T08:00:00.000Z" });
  });

  it("tekst i en hendelse som ser ut som en statuslinje (`HTTP/1.1 404`) setter ikke elementets status - kun selve status-elementet teller", () => {
    const xml = "<D:multistatus xmlns:D=\"DAV:\"><D:response><D:href>/a.ics</D:href><D:propstat><D:prop><C:calendar-data>BEGIN:VCALENDAR&#10;SUMMARY:HTTP/1.1 404 foo&#10;END:VCALENDAR</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>";
    expect(parseMultistatus(xml)[0]?.status).toBe(200);
    const notFound = "<D:multistatus xmlns:D=\"DAV:\"><D:response><D:href>/b.ics</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response></D:multistatus>";
    expect(parseMultistatus(notFound)[0]?.status).toBe(404);
  });
});

describe("D: deltakere - endring/sletting kan sende e-post til andre (LOW-7)", () => {
  const withAttendees = (uid: string): string => ics(uid, "Møte", "20261201T080000Z", ["ORGANIZER:mailto:meg@example.com", "ATTENDEE;CN=Ola:mailto:ola@example.com"]);

  it("elementet viser `has_attendees`; endring og sletting krever eksplisitt eier-bekreftelse, uten den skjer INGENTING (ingen PUT/DELETE sendt)", async () => {
    const { server, client } = mk();
    const url = `${CAL}att-uid-0001.ics`;
    const etag = server.seed(url, withAttendees("att-uid-0001"));
    expect((await client.get("privat", "att-uid-0001"))?.has_attendees).toBe(true);
    expect(await code(client.update("privat", "att-uid-0001", etag, { summary: "Ny" }))).toBe("attendees_confirmation_required");
    expect(await code(client.remove("privat", "att-uid-0001", etag))).toBe("attendees_confirmation_required");
    expect(server.requests.filter((r) => r.method === "PUT" || r.method === "DELETE")).toHaveLength(0);
    expect(server.store.get(url)?.body).toContain("SUMMARY:Møte");
  });

  it("med bekreftelsen går endringen og slettingen gjennom (ATTENDEE-linjene bevares ved endring); hendelser UTEN deltakere trenger den ikke", async () => {
    const { server, client } = mk();
    const etag = server.seed(`${CAL}att-uid-0002.ics`, withAttendees("att-uid-0002"));
    const res = await client.update("privat", "att-uid-0002", etag, { summary: "Ny" }, { allowAttendeeNotification: true });
    expect(res.outcome).toBe("SUCCESS");
    expect(server.store.get(`${CAL}att-uid-0002.ics`)?.body).toContain("ATTENDEE;CN=Ola:mailto:ola@example.com");
    expect((await client.remove("privat", "att-uid-0002", res.etag as string, { allowAttendeeNotification: true })).outcome).toBe("SUCCESS");

    const plainEtag = server.seed(`${CAL}plain-uid-0003.ics`, ics("plain-uid-0003", "Alene", "20261201T080000Z"));
    expect((await client.get("privat", "plain-uid-0003"))?.has_attendees).toBe(false);
    expect((await client.update("privat", "plain-uid-0003", plainEtag, { summary: "Ny" })).outcome).toBe("SUCCESS");
  });

  it("oppgaver (VTODO) med deltakere følger samme regel; kontakter har ikke konseptet og får ingen forhåndslesing før sletting", async () => {
    const { server, client } = mk();
    const todo = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO", "UID:todo-att-0001", "DTSTAMP:20260101T000000Z", "SUMMARY:Delt", "ATTENDEE;CN=Kari:mailto:kari@example.com", "END:VTODO", "END:VCALENDAR", ""].join("\r\n");
    const etag = server.seed(`${TODO}todo-att-0001.ics`, todo);
    expect((await client.get("todo", "todo-att-0001"))?.has_attendees).toBe(true);
    expect(await code(client.update("todo", "todo-att-0001", etag, { completed: true }))).toBe("attendees_confirmation_required");
    expect(await code(client.remove("todo", "todo-att-0001", etag))).toBe("attendees_confirmation_required");
    expect((await client.update("todo", "todo-att-0001", etag, { completed: true }, { allowAttendeeNotification: true })).outcome).toBe("SUCCESS");
    const card = server.seed(`${CARD}card-0009.vcf`, ["BEGIN:VCARD", "VERSION:3.0", "UID:card-0009", "FN:Ola", "N:;Ola;;;", "END:VCARD", ""].join("\r\n"));
    server.requests.length = 0;
    expect((await client.remove("folk", "card-0009", card)).outcome).toBe("SUCCESS");
    expect(server.requests.map((r) => r.method)).toEqual(["DELETE", "GET"]); // DELETE + readback; ingen forhåndslesing for kontakter
  });
});

describe("E: samlings-URL-vernet (LOW-8) - et tastefeil-vern for eierens egen konfig, ikke en SSRF-garanti", () => {
  it("`localhost.`, `*.localhost`, `*.internal` og jokertegn-DNS som bærer en IP (nip.io/sslip.io) avvises; vanlige og LAN-navn (selv-hostet NAS) godtas", () => {
    for (const bad of [
      "https://localhost./dav/", "https://foo.localhost/dav/", "https://a.b.localhost./dav/", "https://metadata.google.internal/dav/", "https://127.0.0.1.nip.io/dav/", "https://169.254.169.254.nip.io/x/",
      "https://169-254-169-254.sslip.io/dav/", "https://10.0.0.5.xip.io/dav/", "https://127.0.0.1/dav/", "https://localhost/dav/"
    ]) expect(normalizeCollectionUrl(bad), bad).toBeNull();
    expect(normalizeCollectionUrl("https://caldav.icloud.com/12345/calendars/home/")).toBe("https://caldav.icloud.com/12345/calendars/home/");
    expect(normalizeCollectionUrl("https://nas.local/dav/")).toBe("https://nas.local/dav/");
    expect(normalizeCollectionUrl("https://dav.example.com./a/")).toBe("https://dav.example.com/a/"); // sluttpunktum på et vanlig navn normaliseres bort
  });
});
