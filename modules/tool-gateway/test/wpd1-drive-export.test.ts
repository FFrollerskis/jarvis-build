import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRIVE_READ_MAX_BYTES, GoogleDriveTransport, isDriveMacroOrScriptMime, readResponseTextCapped } from "@jarvis/tool-gateway";

/**
 * WP-D1 (UA-2): Drive-transportens `read_document` eksporterer Google Docs/Slides til ren tekst og Sheets til CSV (Drive-eksporten gir kun FØRSTE ark), avviser makro-/skript-/kjørbare typer og alt
 * utenfor allowlisten, og leser aldri mer enn `DRIVE_READ_MAX_BYTES` (hard byte-grense, også uten content-length). fetch er mocket (ingen nettverk).
 */
const originalFetch = global.fetch;
const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";
const SLIDES = "application/vnd.google-apps.presentation";

describe("GoogleDriveTransport.read_document (fetch mocket)", () => {
  let calls: string[];
  let nextBody: () => Response;

  beforeEach(() => {
    calls = [];
    nextBody = () => new Response("", { status: 200 });
    global.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "fake-access-token" }), { status: 200, headers: { "content-type": "application/json" } });
      calls.push(url);
      return nextBody();
    }) as unknown as typeof fetch;
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "test-client-id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "test-client-secret";
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("Docs -> text/plain, Slides -> text/plain, Sheets -> text/csv via files.export (riktig MIME i URL-en)", async () => {
    const transport = new GoogleDriveTransport();
    nextBody = () => new Response("dokumenttekst");
    expect((await transport.invoke("read_document", { document_id: "d1", mime_type: DOC }, "rt")).data).toEqual({ content: "dokumenttekst", content_type: "text/plain" });
    nextBody = () => new Response("lysbildetekst");
    expect((await transport.invoke("read_document", { document_id: "s1", mime_type: SLIDES }, "rt")).data).toEqual({ content: "lysbildetekst", content_type: "text/plain" });
    nextBody = () => new Response("a,b\n1,2");
    expect((await transport.invoke("read_document", { document_id: "x1", mime_type: SHEET }, "rt")).data).toEqual({ content: "a,b\n1,2", content_type: "text/csv" });
    expect(calls).toEqual([
      "https://www.googleapis.com/drive/v3/files/d1/export?mimeType=text%2Fplain",
      "https://www.googleapis.com/drive/v3/files/s1/export?mimeType=text%2Fplain",
      "https://www.googleapis.com/drive/v3/files/x1/export?mimeType=text%2Fcsv"
    ]);
  });

  it("tekstfiler og JSON leses rått (alt=media) med MIME uendret", async () => {
    const transport = new GoogleDriveTransport();
    nextBody = () => new Response("# notat");
    const result = await transport.invoke("read_document", { document_id: "t1", mime_type: "text/markdown" }, "rt");
    expect(result.data).toEqual({ content: "# notat", content_type: "text/markdown" });
    expect(calls).toEqual(["https://www.googleapis.com/drive/v3/files/t1?alt=media"]);
  });

  it("makro-/skript-/kjørbare typer avvises FØR noe hentes (ingen fetch av innholdet), og alt utenfor allowlisten er ustøttet", async () => {
    const transport = new GoogleDriveTransport();
    for (const mime of ["application/vnd.google-apps.script", "application/vnd.ms-excel.sheet.macroEnabled.12", "application/x-sh", "application/x-msdownload", "text/x-shellscript", "application/javascript"]) {
      await expect(transport.invoke("read_document", { document_id: "f", mime_type: mime }, "rt"), mime).rejects.toThrow(`drive_macro_or_script_denied_${mime}`);
    }
    for (const mime of ["application/vnd.google-apps.form", "application/vnd.google-apps.drawing", "application/pdf", "image/png", "application/zip", "application/octet-stream", ""]) {
      await expect(transport.invoke("read_document", { document_id: "f", mime_type: mime }, "rt"), mime).rejects.toThrow(/drive_unsupported_content_/);
    }
    expect(calls).toEqual([]); // ingenting ble hentet for noen av dem
  });

  it("hard byte-grense: content-length over taket avvises uten å lese kroppen", async () => {
    const transport = new GoogleDriveTransport();
    let cancelled = false;
    let pulled = 0;
    nextBody = () => new Response(new ReadableStream({ pull() { pulled += 1; }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), {
      status: 200, headers: { "content-length": String(DRIVE_READ_MAX_BYTES + 1) }
    });
    await expect(transport.invoke("read_document", { document_id: "d1", mime_type: DOC }, "rt")).rejects.toThrow("drive_content_too_large");
    expect(cancelled).toBe(true);
    expect(pulled).toBe(0); // kroppen ble aldri lest
  });

  it("hard byte-grense uten content-length: strømmen avbrytes så snart taket er passert (ikke hele filen i minnet)", async () => {
    const transport = new GoogleDriveTransport();
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    nextBody = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 50) throw new Error("strømmen ble ikke avbrutt");
        controller.enqueue(chunk);
      },
      cancel() { cancelled = true; }
    }), { status: 200 });
    await expect(transport.invoke("read_document", { document_id: "t1", mime_type: "text/plain" }, "rt")).rejects.toThrow("drive_content_too_large");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(8); // 5 MiB-taket + litt forhåndslesing, ikke 50
  });

  it("feil-HTTP-status klassifiseres som før (404 -> drive_not_found, 401 -> drive_auth_error)", async () => {
    const transport = new GoogleDriveTransport();
    nextBody = () => new Response("", { status: 404 });
    await expect(transport.invoke("read_document", { document_id: "gone", mime_type: DOC }, "rt")).rejects.toThrow("drive_not_found_gone");
    nextBody = () => new Response("", { status: 401 });
    await expect(transport.invoke("read_document", { document_id: "f", mime_type: SHEET }, "rt")).rejects.toThrow("drive_auth_error_401");
  });
});

describe("readResponseTextCapped / isDriveMacroOrScriptMime", () => {
  it("nøyaktig på taket er OK, én byte over avvises; flerbyte-tegn telles i bytes (ikke tegn); tomt svar er tom tekst", async () => {
    expect(await readResponseTextCapped(new Response("a".repeat(100)), 100)).toBe("a".repeat(100));
    await expect(readResponseTextCapped(new Response("a".repeat(101)), 100)).rejects.toThrow("drive_content_too_large");
    // «ø» er 2 bytes: 60 tegn = 120 bytes > 100.
    await expect(readResponseTextCapped(new Response("ø".repeat(60)), 100)).rejects.toThrow("drive_content_too_large");
    expect(await readResponseTextCapped(new Response(""), 100)).toBe("");
  });

  it("responser uten strømmet kropp (stub med bare text()) kappes også", async () => {
    const stub = { headers: new Headers(), body: null, text: async () => "x".repeat(50) } as unknown as Response;
    expect(await readResponseTextCapped(stub, 50)).toBe("x".repeat(50));
    await expect(readResponseTextCapped(stub, 49)).rejects.toThrow("drive_content_too_large");
  });

  it("isDriveMacroOrScriptMime: kjente farlige typer, men ikke vanlige dokumenter", () => {
    for (const denied of ["application/vnd.google-apps.script", "application/vnd.ms-excel.sheet.macroenabled.12", "application/vnd.ms-office.vbaProject", "application/x-msdos-program", "text/x-python", "text/javascript"]) {
      expect(isDriveMacroOrScriptMime(denied), denied).toBe(true);
    }
    for (const fine of ["text/plain", "text/markdown", "text/csv", "application/json", DOC, SHEET, SLIDES, "application/pdf", "image/png", ""]) {
      expect(isDriveMacroOrScriptMime(fine), fine).toBe(false);
    }
  });
});
