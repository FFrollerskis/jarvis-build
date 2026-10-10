import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { PgApprovalStore, createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding } from "@jarvis/memory";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools, type SecretProvider } from "@jarvis/tool-gateway";
import { GoogleDriveKnowledgeSource, driveReadKind, type GoogleDriveSourceOptions } from "../src/drive-source.ts";
import { KnowledgeRetriever } from "../src/retriever.ts";
import { KnowledgeSourceError } from "../src/source.ts";
import { KnowledgeSyncService } from "../src/sync.ts";

/**
 * WP-D1 (UA-2): Drive-kilden leser Google Docs, Slides og Sheets (ikke bare Docs), med størrelses-/radtak, MIME-allowlist og uten makro/skript.
 *  A. klassifiseringen (positiv allowlist) og Docs/Slides/Sheets-eksport mot en fake gateway,
 *  B. ett dokument PER ARK via Sheets-API-et (`sheets: "all"`), med feilhåndtering som aldri tombstoner,
 *  C. API-pause og nytt forsøk mot begrenseren, opsjonsklemming, tittelrens,
 *  D. mot ekte Postgres + ekte ToolGateway: synk, søketreff og tombstone-beskyttelse for ark.
 */
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-wpd1-drive", memory_space_id: "project",
  session_id: "sess-wpd1-drive", device_id: "dev-wpd1-drive", channel: "api", auth_strength: "active"
};

const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";
const SLIDES = "application/vnd.google-apps.presentation";

interface Call { tool_id: string; action: string; parameters: Record<string, JsonValue>; at: number }
type Reply = { ok: true; data?: JsonValue } | { ok: false; reason: string };
interface FakeFile { id: string; name: string; mime: string; modified?: string }

function fakeGateway(handler: (call: Call) => Reply): { gateway: ToolGateway; calls: Call[] } {
  const calls: Call[] = [];
  const gateway = {
    execute: async (request: { tool_id: string; action: string; parameters: Record<string, JsonValue> }) => {
      const call: Call = { tool_id: request.tool_id, action: request.action, parameters: request.parameters, at: Date.now() };
      calls.push(call);
      return handler(call);
    }
  } as unknown as ToolGateway;
  return { gateway, calls };
}

/** Drive-delen av en fake: `list_files` (rot) og `read_document` fra en innholdstabell. */
function driveReply(call: Call, files: FakeFile[], contents: Record<string, string>): Reply | undefined {
  if (call.tool_id !== "drive") return undefined;
  if (call.action === "list_files") {
    return { ok: true, data: { files: files.map((f) => ({ id: f.id, name: f.name, mime_type: f.mime, modified_at: f.modified ?? "2026-10-01T10:00:00Z", size_bytes: null })), next_page_token: null } };
  }
  if (call.action === "read_document") {
    const id = String(call.parameters["document_id"]);
    const content = contents[id];
    if (content === undefined) return { ok: false, reason: "tool_failed:drive_not_found_" + id };
    return { ok: true, data: { content, content_type: String(call.parameters["mime_type"]) } };
  }
  return { ok: false, reason: "unexpected_action" };
}

const whole = { kind: "whole_drive" } as const;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("A: MIME-allowlist og eksport av Docs, Slides og Sheets (første ark)", () => {
  it("driveReadKind: positiv allowlist - Docs/Slides/Sheets, tekst og JSON leses; Forms, snarveier, skript, makroer, kjørbart og binært gjør det aldri", () => {
    expect(driveReadKind(DOC)).toBe("doc");
    expect(driveReadKind(SLIDES)).toBe("slides");
    expect(driveReadKind(SHEET)).toBe("sheet");
    expect(driveReadKind("text/plain")).toBe("text");
    expect(driveReadKind("text/csv")).toBe("text");
    expect(driveReadKind("application/json")).toBe("text");
    for (const unsupported of [
      "application/vnd.google-apps.form", "application/vnd.google-apps.drawing", "application/vnd.google-apps.shortcut", "application/vnd.google-apps.site",
      "image/png", "application/pdf", "application/zip", "video/mp4", "application/octet-stream", "", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ]) {
      expect(driveReadKind(unsupported), unsupported).toEqual({ unsupported });
    }
    for (const denied of [
      "application/vnd.google-apps.script", "application/vnd.google-apps.script+json", "application/vnd.ms-excel.sheet.macroEnabled.12", "application/vnd.ms-word.document.macroEnabled.12",
      "application/vnd.ms-powerpoint.presentation.macroEnabled.12", "application/x-msdownload", "application/x-sh", "application/x-shellscript", "application/javascript", "application/x-python-code",
      "text/x-shellscript", "text/javascript", "text/x-python", "text/x-sh", "application/vnd.microsoft.portable-executable", "application/vnd.ms-office.vbaproject"
    ]) {
      expect(driveReadKind(denied), denied).toEqual({ unsupported: "macro_or_script_denied" });
    }
  });

  it("Docs og Slides eksporteres til ren tekst; Sheets (første ark) til CSV med radtak, og det som kuttes meldes i metadata", async () => {
    const files: FakeFile[] = [
      { id: "doc-1", name: "Styrereferat", mime: DOC },
      { id: "slides-1", name: "Strategi 2027", mime: SLIDES },
      { id: "sheet-1", name: "Budsjett", mime: SHEET }
    ];
    const csv = 'Post,Beløp\nLønn,"1 200"\n"Kommentar med\nlinjeskift",5\nHusleie,9000\nStrøm,800\n';
    const contents = { "doc-1": "Vedtak: ny leverandør velges.", "slides-1": "Lysbilde 1\nVisjon og mål", "sheet-1": csv };
    const { gateway, calls } = fakeGateway((call) => driveReply(call, files, contents) ?? { ok: false, reason: "x" });
    const source = new GoogleDriveKnowledgeSource(gateway, identity, whole, "drive-wpd1", { max_sheet_rows: 3 });
    const { records, skipped, protected_prefixes } = await source.list();
    expect(skipped).toEqual([]);
    expect(protected_prefixes).toBeUndefined();
    expect(records.map((r) => r.external_id)).toEqual(["doc-1", "slides-1", "sheet-1"]);

    const [doc, slides, sheet] = records;
    expect(doc).toMatchObject({ content: contents["doc-1"], content_type: "text/plain", title: "Styrereferat", source_type: "google_drive", source_instance_id: "drive-wpd1" });
    expect(doc?.metadata).toMatchObject({ kind: "doc", mime_type: DOC, drive_file_id: "doc-1" });
    expect(slides).toMatchObject({ content: contents["slides-1"], content_type: "text/plain" });
    expect(slides?.metadata).toMatchObject({ kind: "slides" });
    // Radtaket (3 rader): overskrift + Lønn + den sitat-beskyttede raden med linjeskift (teller som ÉN rad).
    expect(sheet?.content).toBe('Post,Beløp\nLønn,"1 200"\n"Kommentar med\nlinjeskift",5');
    expect(sheet).toMatchObject({ content_type: "text/csv", canonical_uri: "https://drive.google.com/file/d/sheet-1/view" });
    expect(sheet?.metadata).toMatchObject({ kind: "sheet", sheet_scope: "first_sheet", rows: 3, truncated: true });
    expect(sheet?.content_hash).toBe(sha(sheet?.content ?? ""));
    expect(sheet?.modified_at).toBe("2026-10-01T10:00:00Z");
    // Eksporten ba om riktig MIME for hver fil.
    expect(calls.filter((c) => c.action === "read_document").map((c) => [c.parameters["document_id"], c.parameters["mime_type"]])).toEqual([
      ["doc-1", DOC], ["slides-1", SLIDES], ["sheet-1", SHEET]
    ]);
    // `first` leser aldri via Sheets-API-et (ingen ekstra credential nødvendig).
    expect(calls.some((c) => c.tool_id === "google_sheets")).toBe(false);
  });

  it("makro-/skript-/kjørbare/binære typer leses ALDRI (ingen read_document-kall), og de rapporteres som UNSUPPORTED_CONTENT", async () => {
    const files: FakeFile[] = [
      { id: "script-1", name: "automasjon", mime: "application/vnd.google-apps.script" },
      { id: "macro-1", name: "regneark.xlsm", mime: "application/vnd.ms-excel.sheet.macroEnabled.12" },
      { id: "sh-1", name: "install.sh", mime: "application/x-sh" },
      { id: "exe-1", name: "setup.exe", mime: "application/x-msdownload" },
      { id: "pdf-1", name: "kontrakt.pdf", mime: "application/pdf" },
      { id: "form-1", name: "Skjema", mime: "application/vnd.google-apps.form" },
      { id: "ok-1", name: "notat.txt", mime: "text/plain" }
    ];
    const { gateway, calls } = fakeGateway((call) => driveReply(call, files, { "ok-1": "vanlig tekst" }) ?? { ok: false, reason: "x" });
    const { records, skipped } = await new GoogleDriveKnowledgeSource(gateway, identity, whole).list();
    expect(records.map((r) => r.external_id)).toEqual(["ok-1"]);
    expect(skipped).toEqual([
      { external_id: "script-1", reason: "UNSUPPORTED_CONTENT", detail: "macro_or_script_denied" },
      { external_id: "macro-1", reason: "UNSUPPORTED_CONTENT", detail: "macro_or_script_denied" },
      { external_id: "sh-1", reason: "UNSUPPORTED_CONTENT", detail: "macro_or_script_denied" },
      { external_id: "exe-1", reason: "UNSUPPORTED_CONTENT", detail: "macro_or_script_denied" },
      { external_id: "pdf-1", reason: "UNSUPPORTED_CONTENT", detail: "application/pdf" },
      { external_id: "form-1", reason: "UNSUPPORTED_CONTENT", detail: "application/vnd.google-apps.form" }
    ]);
    expect(calls.filter((c) => c.action === "read_document").map((c) => c.parameters["document_id"])).toEqual(["ok-1"]);
  });

  it("transportfeil per fil: for stor/ustøttet = skipped (ikke total svikt), forbigående feil = skipped med feilklasse, AUTH = total svikt (uendret kontrakt)", async () => {
    const files: FakeFile[] = [
      { id: "big", name: "stor", mime: DOC }, { id: "unsup", name: "ukjent", mime: SLIDES }, { id: "gone", name: "borte", mime: DOC }, { id: "limited", name: "begrenset", mime: DOC }, { id: "ok", name: "ok", mime: DOC }
    ];
    const reasons: Record<string, string> = {
      big: "tool_failed:drive_content_too_large", unsup: "tool_failed:drive_unsupported_content_x", gone: "tool_failed:drive_not_found_gone", limited: "rate_limited"
    };
    const { gateway } = fakeGateway((call) => {
      if (call.action === "read_document" && reasons[String(call.parameters["document_id"])]) return { ok: false, reason: reasons[String(call.parameters["document_id"])] as string };
      return driveReply(call, files, { ok: "fint" }) ?? { ok: false, reason: "x" };
    });
    const { records, skipped } = await new GoogleDriveKnowledgeSource(gateway, identity, whole).list();
    expect(records.map((r) => r.external_id)).toEqual(["ok"]);
    expect(skipped).toEqual([
      { external_id: "big", reason: "UNSUPPORTED_CONTENT", detail: "too_large" },
      { external_id: "unsup", reason: "UNSUPPORTED_CONTENT", detail: SLIDES },
      { external_id: "gone", reason: "NOT_FOUND", detail: "tool_failed:drive_not_found_gone" },
      { external_id: "limited", reason: "RATE_LIMIT", detail: "rate_limited" }
    ]);

    const auth = fakeGateway((call) => (call.action === "read_document" ? { ok: false, reason: "tool_failed:drive_auth_error_401" } : driveReply(call, files, {}) ?? { ok: false, reason: "x" }));
    await expect(new GoogleDriveKnowledgeSource(auth.gateway, identity, whole).list()).rejects.toThrow(KnowledgeSourceError);
  });

  it("binærinnhold merket som tekst (NUL-byte) hoppes over; et tomt dokument gir ingen record og ingen skip", async () => {
    const files: FakeFile[] = [{ id: "bin", name: "falsk.txt", mime: "text/plain" }, { id: "tom", name: "tomt", mime: DOC }, { id: "blank", name: "blankt", mime: SLIDES }];
    const { gateway } = fakeGateway((call) => driveReply(call, files, { bin: "abc\u0000def", tom: "", blank: " \n\t " }) ?? { ok: false, reason: "x" });
    const { records, skipped } = await new GoogleDriveKnowledgeSource(gateway, identity, whole).list();
    expect(records).toEqual([]);
    expect(skipped).toEqual([{ external_id: "bin", reason: "UNSUPPORTED_CONTENT", detail: "binary_content" }]);
  });

  it("filtittelen renses (kontroll-/toveistegn bort, avkortet) - et filnavn kan ikke skjule tekst eller bli uendelig langt", async () => {
    // Usynlige/toveis-tegn bygges av kodepunkter (ingen usynlige tegn i selve kildekoden).
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    const files: FakeFile[] = [{ id: "t1", name: `Rapport${rlo}FDP.txt${String.fromCharCode(0)}${zwsp}${"x".repeat(400)}`, mime: "text/plain" }];
    const { gateway } = fakeGateway((call) => driveReply(call, files, { t1: "innhold" }) ?? { ok: false, reason: "x" });
    const { records } = await new GoogleDriveKnowledgeSource(gateway, identity, whole).list();
    const title = records[0]?.title ?? "";
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.startsWith("Rapport")).toBe(true);
    expect([...title].some((ch) => [0, 0x202e, 0x200b].includes(ch.codePointAt(0) as number))).toBe(false);
  });
});

describe("B: Sheets - ett dokument per ark (sheets: all)", () => {
  const files: FakeFile[] = [{ id: "sheet-1", name: "Regneark", mime: SHEET }, { id: "doc-1", name: "Notat", mime: DOC }];
  const sheetList = [{ title: "Budsjett", sheet_id: 0 }, { title: "Per's ark", sheet_id: 7 }, { title: "Tomt", sheet_id: 9 }];
  const allMode: GoogleDriveSourceOptions = { sheets: "all", max_sheet_rows: 3, max_sheet_columns: 3 };

  function handler(overrides: (call: Call) => Reply | undefined = () => undefined, list: JsonValue = sheetList as unknown as JsonValue) {
    return (call: Call): Reply => {
      const override = overrides(call);
      if (override) return override;
      const drive = driveReply(call, files, { "doc-1": "vanlig dokument" });
      if (drive) return drive;
      if (call.tool_id === "google_sheets" && call.action === "list_sheets") return { ok: true, data: list };
      if (call.tool_id === "google_sheets" && call.action === "read_range") {
        const range = String(call.parameters["range"]);
        if (range.startsWith("'Budsjett'")) return { ok: true, data: [["Post", "Beløp", "Dato", "UTENFOR"], ["Husleie", 9000, "1.10."], ["Strøm", 800], ["Mat", 3000]] };
        if (range.startsWith("'Per''s ark'")) return { ok: true, data: [["Navn"], ["Per"]] };
        return { ok: true, data: [] };
      }
      return { ok: false, reason: "unexpected" };
    };
  }

  it("arklisten og hvert ark leses via Sheets-API-et med radtak+1 og kolonnetak i selve området; tomme ark gir ikke dokument", async () => {
    const { gateway, calls } = fakeGateway(handler());
    const { records, skipped, protected_prefixes } = await new GoogleDriveKnowledgeSource(gateway, identity, whole, "drive-wpd1", allMode).list();
    expect(skipped).toEqual([]);
    expect(protected_prefixes).toBeUndefined();
    expect(records.map((r) => r.external_id)).toEqual(["sheet-1#0", "sheet-1#7", "doc-1"]);
    // Områdene: sitert arknavn (enkle sitater doblet), kolonne C (3 kolonner), rad 4 (radtak 3 + 1).
    expect(calls.filter((c) => c.action === "read_range").map((c) => c.parameters["range"])).toEqual(["'Budsjett'!A1:C4", "'Per''s ark'!A1:C4", "'Tomt'!A1:C4"]);
    expect(calls.filter((c) => c.tool_id === "google_sheets").every((c) => c.parameters["spreadsheet_id"] === "sheet-1")).toBe(true);
    // Regnearket leses IKKE i tillegg som ett samlet dokument.
    expect(calls.filter((c) => c.action === "read_document").map((c) => c.parameters["document_id"])).toEqual(["doc-1"]);

    const [budget, per] = records;
    expect(budget).toMatchObject({
      title: "Regneark - Budsjett", content_type: "text/csv", canonical_uri: "https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=0",
      // Kolonnetaket (3) kutter «UTENFOR»; radtaket (3) kutter «Mat».
      content: "Post,Beløp,Dato\nHusleie,9000,1.10.\nStrøm,800"
    });
    expect(budget?.metadata).toMatchObject({ kind: "sheet", sheet_scope: "sheet", sheet_id: 0, rows: 3, truncated: true, drive_file_id: "sheet-1" });
    expect(per?.title).toBe("Regneark - Per's ark");
    expect(per?.metadata).toMatchObject({ rows: 2, truncated: false, sheet_id: 7 });
    expect(per?.content_hash).toBe(sha(per?.content ?? ""));
  });

  it("arkgrensen: ark utover taket rapporteres med EKSAKT id (sheet_limit) - beskyttet mot tombstoning, ikke lest", async () => {
    const many = [0, 1, 2, 3].map((n) => ({ title: `Ark ${n}`, sheet_id: n }));
    const { gateway, calls } = fakeGateway(handler((call) => (call.action === "read_range" ? { ok: true, data: [["x"]] } : undefined), many as unknown as JsonValue));
    const { records, skipped } = await new GoogleDriveKnowledgeSource(gateway, identity, whole, "i", { ...allMode, max_sheets_per_file: 2 }).list();
    expect(records.filter((r) => r.external_id.startsWith("sheet-1#")).map((r) => r.external_id)).toEqual(["sheet-1#0", "sheet-1#1"]);
    expect(skipped).toEqual([
      { external_id: "sheet-1#2", reason: "UNSUPPORTED_CONTENT", detail: "sheet_limit" },
      { external_id: "sheet-1#3", reason: "UNSUPPORTED_CONTENT", detail: "sheet_limit" }
    ]);
    expect(calls.filter((c) => c.action === "read_range")).toHaveLength(2);
  });

  it("Sheets-feil velger aldri hele listingen: arklisten feiler (AUTH/ukjent) = prefikset beskyttes, Docs leses som vanlig", async () => {
    for (const reason of ["tool_failed:sheets_error_403", "tool_failed:google_auth_failed_401", "credential_unavailable", "tool_failed:sheets_error_500"]) {
      const { gateway } = fakeGateway(handler((call) => (call.action === "list_sheets" ? { ok: false, reason } : undefined)));
      const { records, skipped, protected_prefixes } = await new GoogleDriveKnowledgeSource(gateway, identity, whole, "i", allMode).list();
      expect(records.map((r) => r.external_id), reason).toEqual(["doc-1"]);
      expect(protected_prefixes, reason).toEqual(["sheet-1#"]);
      expect(skipped, reason).toHaveLength(1);
      expect(skipped[0]?.external_id).toBe("sheet-1");
      expect(skipped[0]?.detail?.startsWith("sheets_list_failed:")).toBe(true);
    }
  });

  it("ett ark som ikke lar seg lese hoppes over med eksakt id og feilklasse; de andre arkene leses", async () => {
    const { gateway } = fakeGateway(handler((call) => (call.action === "read_range" && String(call.parameters["range"]).startsWith("'Budsjett'") ? { ok: false, reason: "rate_limited" } : undefined)));
    const { records, skipped, protected_prefixes } = await new GoogleDriveKnowledgeSource(gateway, identity, whole, "i", allMode).list();
    expect(records.map((r) => r.external_id)).toEqual(["sheet-1#7", "doc-1"]);
    expect(skipped).toEqual([{ external_id: "sheet-1#0", reason: "RATE_LIMIT", detail: "sheets_read_failed: rate_limited" }]);
    expect(protected_prefixes).toBeUndefined();
  });

  it("ugyldig arkliste: feil form beskytter prefikset; ugyldige/dupliserte/for lange elementer ignoreres", async () => {
    for (const bad of ["tekst", { sheets: [] }, null, [1, 2], [[]]] as JsonValue[]) {
      const { gateway } = fakeGateway(handler(undefined, bad));
      const { records, skipped, protected_prefixes } = await new GoogleDriveKnowledgeSource(gateway, identity, whole, "i", allMode).list();
      expect(records.map((r) => r.external_id), JSON.stringify(bad)).toEqual(["doc-1"]);
      expect(protected_prefixes, JSON.stringify(bad)).toEqual(["sheet-1#"]);
      expect(skipped[0]).toMatchObject({ external_id: "sheet-1", reason: "SOURCE_UNAVAILABLE", detail: "sheets_list_bad_response" });
    }
    const noisy = [
      { title: "Bra", sheet_id: 1 }, { title: "Bra", sheet_id: 1 }, { title: "", sheet_id: 2 }, { title: "x".repeat(101), sheet_id: 3 },
      { title: "Negativ", sheet_id: -1 }, { title: "Flyttall", sheet_id: 1.5 }, { title: "Tekstid", sheet_id: "4" }, { title: 7, sheet_id: 5 }, { sheet_id: 6 }
    ] as unknown as JsonValue;
    const { gateway, calls } = fakeGateway(handler((call) => (call.action === "read_range" ? { ok: true, data: [["verdi"]] } : undefined), noisy));
    const { records } = await new GoogleDriveKnowledgeSource(gateway, identity, whole, "i", allMode).list();
    expect(records.filter((r) => r.external_id.startsWith("sheet-1#")).map((r) => r.external_id)).toEqual(["sheet-1#1"]);
    expect(calls.filter((c) => c.action === "read_range")).toHaveLength(1);
  });

  it("opsjoner klemmes til harde tak (ingen ubegrenset minne/API-bruk) og ugyldige verdier faller til standard", async () => {
    const rangeFor = async (options: GoogleDriveSourceOptions): Promise<string> => {
      const { gateway, calls } = fakeGateway(handler((call) => (call.action === "list_sheets" ? { ok: true, data: [{ title: "A", sheet_id: 0 }] } : undefined)));
      await new GoogleDriveKnowledgeSource(gateway, identity, whole, "i", { sheets: "all", ...options }).list();
      return String(calls.find((c) => c.action === "read_range")?.parameters["range"]);
    };
    expect(await rangeFor({})).toBe("'A'!A1:AX2001"); // standard: 2000 rader, 50 kolonner
    expect(await rangeFor({ max_sheet_rows: 1_000_000_000, max_sheet_columns: 1_000_000 })).toBe("'A'!A1:GR20001"); // tak: 20 000 rader, 200 kolonner
    expect(await rangeFor({ max_sheet_rows: 0, max_sheet_columns: -4 })).toBe("'A'!A1:A2"); // gulv: 1 rad, 1 kolonne
    expect(await rangeFor({ max_sheet_rows: Number.NaN, max_sheet_columns: Number.POSITIVE_INFINITY })).toBe("'A'!A1:AX2001");
  });
});

describe("C: API-pause og nytt forsøk mot begrenseren", () => {
  const files: FakeFile[] = [{ id: "a", name: "a", mime: DOC }, { id: "b", name: "b", mime: DOC }, { id: "c", name: "c", mime: DOC }];

  it("pace_ms legger en minste pause mellom API-kallene (ellers ville alt etter de ~20 første filene bli hoppet over ved HVER synk)", async () => {
    const { gateway, calls } = fakeGateway((call) => driveReply(call, files, { a: "1", b: "2", c: "3" }) ?? { ok: false, reason: "x" });
    await new GoogleDriveKnowledgeSource(gateway, identity, whole, "i", { pace_ms: 60 }).list();
    expect(calls).toHaveLength(4); // list_files + 3 lesinger
    for (let i = 1; i < calls.length; i += 1) {
      expect((calls[i] as Call).at - (calls[i - 1] as Call).at, `mellom kall ${i - 1} og ${i}`).toBeGreaterThanOrEqual(50);
    }
  });

  it("uten pause (standard) kjører alt umiddelbart", async () => {
    const { gateway, calls } = fakeGateway((call) => driveReply(call, files, { a: "1", b: "2", c: "3" }) ?? { ok: false, reason: "x" });
    const start = Date.now();
    await new GoogleDriveKnowledgeSource(gateway, identity, whole).list();
    expect(calls).toHaveLength(4);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("avvist av begrenseren: ÉTT nytt forsøk etter ventetiden; fortsatt avvist = skipped RATE_LIMIT (ingen evig løkke); uten ventetid ingen nytt forsøk", async () => {
    let reads = 0;
    const flaky = fakeGateway((call) => {
      if (call.action === "read_document" && call.parameters["document_id"] === "a") {
        reads += 1;
        if (reads === 1) return { ok: false, reason: "rate_limited" };
      }
      return driveReply(call, files, { a: "1", b: "2", c: "3" }) ?? { ok: false, reason: "x" };
    });
    const retried = await new GoogleDriveKnowledgeSource(flaky.gateway, identity, whole, "i", { rate_limit_backoff_ms: 20 }).list();
    expect(retried.records.map((r) => r.external_id)).toEqual(["a", "b", "c"]);
    expect(reads).toBe(2);

    let stuck = 0;
    const always = fakeGateway((call) => {
      if (call.action === "read_document" && call.parameters["document_id"] === "a") {
        stuck += 1;
        return { ok: false, reason: "rate_limited" };
      }
      return driveReply(call, files, { a: "1", b: "2", c: "3" }) ?? { ok: false, reason: "x" };
    });
    const limited = await new GoogleDriveKnowledgeSource(always.gateway, identity, whole, "i", { rate_limit_backoff_ms: 10 }).list();
    expect(stuck).toBe(2);
    expect(limited.skipped).toEqual([{ external_id: "a", reason: "RATE_LIMIT", detail: "rate_limited" }]);
    expect(limited.records.map((r) => r.external_id)).toEqual(["b", "c"]);

    stuck = 0;
    const none = await new GoogleDriveKnowledgeSource(always.gateway, identity, whole).list();
    expect(stuck).toBe(1);
    expect(none.skipped).toHaveLength(1);
  });
});

describe("D: mot ekte Postgres og ekte ToolGateway - synk, treff og tombstone-beskyttelse for ark", () => {
  let stop: (() => Promise<void>) | undefined;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd1-drive-"));
    const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
    stop = leased.stop;
    await leased.postgres.createDatabase("jarvis_test");
    adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
    adminPool.on("error", () => undefined);
    await runMigrations(adminPool);
    await adminPool.query("CREATE ROLE jarvis_wpd1_drive LOGIN PASSWORD 'pw2'");
    await adminPool.query("GRANT jarvis_app TO jarvis_wpd1_drive");
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-wpd1-drive','Drive WPD1','person');
      INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
      INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-wpd1-drive');
    `);
    appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd1_drive", password: "pw2" });
  }, 240_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
    await stop?.();
  }, 120_000);

  /** Ekte ToolGateway (policy, zod-skjema, revisjon) over to FakeTransport: Drive og Sheets. */
  function realGateway(state: { sheets: Array<{ title: string; sheet_id: number }>; sheetsFail: string | undefined; rows: Record<string, JsonValue>; files: FakeFile[] }) {
    const drive = new FakeTransport((action, parameters) => {
      if (action === "list_files") {
        return { data: { files: state.files.map((f) => ({ id: f.id, name: f.name, mime_type: f.mime, modified_at: null, size_bytes: null })), next_page_token: null } };
      }
      if (action === "read_document") return { data: { content: `eksport av ${String(parameters?.["document_id"])}`, content_type: String(parameters?.["mime_type"]) } };
      throw new Error(`uventet drive-action ${action}`);
    });
    const sheets = new FakeTransport((action, parameters) => {
      if (state.sheetsFail) throw new Error(state.sheetsFail);
      if (action === "list_sheets") return { data: state.sheets as unknown as JsonValue };
      if (action === "read_range") {
        const range = String(parameters?.["range"]);
        const title = range.slice(1, range.indexOf("'!")).replace(/''/g, "'");
        return { data: state.rows[title] ?? [] };
      }
      throw new Error(`uventet sheets-action ${action}`);
    });
    const devices = new InMemoryDeviceRegistry();
    const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
    const secrets: SecretProvider = { name: "test", async get() { return "fake-token"; } };
    const toolGateway = new ToolGateway(appPool, policy, secrets);
    for (const tool of firstWaveTools({ drive, google_sheets: sheets })) toolGateway.register(tool);
    return toolGateway;
  }

  async function docs(instance: string): Promise<Array<{ external_id: string; deleted: boolean; title: string; content: string }>> {
    const { rows } = await adminPool.query(
      "SELECT external_id, deleted, title, content FROM knowledge_documents WHERE tenant_id = $1 AND source_instance_id = $2 ORDER BY external_id",
      [identity.tenant_id, instance]
    );
    return rows as Array<{ external_id: string; deleted: boolean; title: string; content: string }>;
  }

  it("synk: ett dokument per ark (ekte zod-skjema godtar områdene), treff med source_kind drive; arklisten feiler = ingenting tombstones; fjernet ark tombstones; ekstremt arknavn hoppes over uten krasj", async () => {
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const retriever = new KnowledgeRetriever(appPool, embedding);
    const state = {
      files: [{ id: "ss-1", name: "Husholdning", mime: SHEET }, { id: "doc-9", name: "Notat", mime: DOC }] as FakeFile[],
      sheets: [{ title: "Matbudsjett", sheet_id: 11 }, { title: "Reiser", sheet_id: 12 }, { title: "'".repeat(100), sheet_id: 13 }],
      sheetsFail: undefined as string | undefined,
      rows: {
        Matbudsjett: [["Vare", "Pris"], ["Kaffe", 89], ["Mjølk", 24]] as JsonValue,
        Reiser: [["Destinasjon"], ["Lofoten"]] as JsonValue,
        ["'".repeat(100)]: [["skal aldri leses"]] as JsonValue
      }
    };
    const gateway = realGateway(state);
    const make = () => new GoogleDriveKnowledgeSource(gateway, identity, whole, "drive-sheets-db", { sheets: "all" });

    const first = await sync.sync(identity, "project", make());
    // 2 ark + dokument. Arknavnet av 100 apostrofer gir et område > 200 tegn: den ekte zod-grensen avviser kallet -> hoppes over (ikke en krasj, ikke total svikt).
    expect(first).toMatchObject({ created: 3, tombstoned: 0, failed: 0, skipped: 1 });
    expect((await docs("drive-sheets-db")).map((d) => d.external_id)).toEqual(["doc-9", "ss-1#11", "ss-1#12"]);

    const hits = await retriever.searchHits(identity, { query: "kaffe pris", spaces: ["project"], limit: 5 });
    const sheetHit = hits.find((h) => h.title === "Husholdning - Matbudsjett");
    expect(sheetHit).toBeDefined();
    expect(sheetHit).toMatchObject({ source_kind: "drive", memory_space: "project", trust_level: "untrusted" });
    expect(sheetHit?.uri).toContain("gid=11");

    // Sheets-API-et feiler (utløpt token): arkene er IKKE bekreftet borte -> ingenting tombstones, dokumentet synkes som vanlig.
    state.sheetsFail = "sheets_error_403";
    const failing = await sync.sync(identity, "project", make());
    expect(failing).toMatchObject({ tombstoned: 0, failed: 0 });
    expect((await docs("drive-sheets-db")).filter((d) => d.deleted)).toEqual([]);

    // Arkene kommer tilbake, men «Reiser» er fjernet i regnearket: kun det arket tombstones.
    state.sheetsFail = undefined;
    state.sheets = [{ title: "Matbudsjett", sheet_id: 11 }];
    const removed = await sync.sync(identity, "project", make());
    expect(removed.tombstoned).toBe(1);
    expect((await docs("drive-sheets-db")).filter((d) => d.deleted).map((d) => d.external_id)).toEqual(["ss-1#12"]);
    expect((await retriever.searchHits(identity, { query: "Lofoten destinasjon", spaces: ["project"] })).some((h) => h.title.includes("Reiser"))).toBe(false);
  }, 120_000);

  it("bytte fra første ark til alle ark: det samlede dokumentet tombstones og arkene opprettes (id-ene er forskjellige), uten dobbelt innhold i søk", async () => {
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const state = {
      files: [{ id: "ss-2", name: "Lager", mime: SHEET }] as FakeFile[],
      sheets: [{ title: "Varer", sheet_id: 0 }],
      sheetsFail: undefined as string | undefined,
      rows: { Varer: [["Skrue", 100]] as JsonValue }
    };
    const gateway = realGateway(state);
    const first = await sync.sync(identity, "project", new GoogleDriveKnowledgeSource(gateway, identity, whole, "drive-mode-switch", { sheets: "first" }));
    expect(first).toMatchObject({ created: 1 });
    const second = await sync.sync(identity, "project", new GoogleDriveKnowledgeSource(gateway, identity, whole, "drive-mode-switch", { sheets: "all" }));
    expect(second).toMatchObject({ created: 1, tombstoned: 1 });
    const rows = await docs("drive-mode-switch");
    expect(rows.filter((d) => !d.deleted).map((d) => d.external_id)).toEqual(["ss-2#0"]);
    expect(rows.filter((d) => d.deleted).map((d) => d.external_id)).toEqual(["ss-2"]);
  }, 120_000);
});
