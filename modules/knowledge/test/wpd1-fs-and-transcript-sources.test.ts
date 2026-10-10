import { chmod, mkdir, mkdtemp, symlink, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { KnowledgeSourceError } from "../src/source.ts";
import { FilesystemKnowledgeSource, walkAllowlistedFiles } from "../src/filesystem-source.ts";
import { ObsidianVaultKnowledgeSource } from "../src/obsidian-source.ts";
import { MeetingTranscriptKnowledgeSource } from "../src/meeting-transcript-source.ts";

/**
 * WP-D1 (UA-2): den felles, sikre katalogvandringen (filsystem, Obsidian, møtetranskripter) og transkriptkilden.
 * Ingen database her - kun filsystem.
 */
const EMAIL = "ola.nordmann@acme.no";
let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jarvis-wpd1-fs-"));
  outside = await mkdtemp(join(tmpdir(), "jarvis-wpd1-out-"));
});

describe("A: filsystemvandringen er begrenset og løkkesikker", () => {
  it("en symlink-løkke INNENFOR roten (undermappe -> roten) gir ikke uendelig rekursjon, og hver fil listes én gang", async () => {
    await mkdir(join(root, "a"), { recursive: true });
    await writeFile(join(root, "a", "fil.md"), "innhold");
    await writeFile(join(root, "rot.md"), "rot");
    try {
      await symlink(root, join(root, "a", "tilbake"));
      await symlink(join(root, "a"), join(root, "a2"));
    } catch {
      return; // ingen symlink-rettigheter i dette miljøet
    }
    const { records, skipped } = await new FilesystemKnowledgeSource(root).list();
    expect(skipped).toEqual([]);
    expect(records.map((r) => r.external_id).sort()).toEqual(["a/fil.md", "rot.md"]);
  });

  it("symlink UT av roten hoppes fortsatt over, og et filnavn som starter med «..» er ikke et utbrudd", async () => {
    await writeFile(join(outside, "hemmelig.txt"), "utenfor");
    await writeFile(join(root, "..notat.md"), "ekte notat");
    try {
      await symlink(join(outside, "hemmelig.txt"), join(root, "lenke.txt"));
      await symlink(outside, join(root, "mappe-lenke"));
    } catch {
      return;
    }
    const { records } = await new FilesystemKnowledgeSource(root).list();
    expect(records.map((r) => r.external_id)).toEqual(["..notat.md"]);
    expect(records.some((r) => r.content.includes("utenfor"))).toBe(false);
  });

  it("en rot som ikke finnes (eller er en fil) er TOTAL svikt - aldri en tom liste som ville tombstonet alt", async () => {
    const missing = new FilesystemKnowledgeSource(join(root, "finnes-ikke"));
    await expect(missing.list()).rejects.toMatchObject({ name: "KnowledgeSourceError", errorClass: "SOURCE_UNAVAILABLE", retryable: true });
    await writeFile(join(root, "enfil.txt"), "x");
    await expect(new FilesystemKnowledgeSource(join(root, "enfil.txt")).list()).rejects.toBeInstanceOf(KnowledgeSourceError);
  });

  it("filer over størrelsesgrensen og binærfiler hoppes over som UNSUPPORTED_CONTENT (beskyttet mot tombstoning), resten leses", async () => {
    await writeFile(join(root, "liten.md"), "liten");
    await writeFile(join(root, "stor.md"), "x".repeat(2048));
    await writeFile(join(root, "binaer.txt"), Buffer.from([0x68, 0x65, 0x00, 0x69]));
    const { records, skipped } = await new FilesystemKnowledgeSource(root, undefined, { limits: { maxFileBytes: 1024 } }).list();
    expect(records.map((r) => r.external_id)).toEqual(["liten.md"]);
    expect(skipped).toEqual(
      expect.arrayContaining([
        { external_id: "stor.md", reason: "UNSUPPORTED_CONTENT", detail: "too_large" },
        { external_id: "binaer.txt", reason: "UNSUPPORTED_CONTENT", detail: "binary_content" }
      ])
    );
  });

  it("antallsgrensen gir en PARTIELL listing (ingenting tombstones på grunnlag av en ufullstendig oversikt)", async () => {
    for (let i = 0; i < 5; i += 1) await writeFile(join(root, `n${i}.md`), `notat ${i}`);
    const result = await new FilesystemKnowledgeSource(root, undefined, { limits: { maxFiles: 3 } }).list();
    expect(result.listing).toBe("partial");
    expect(result.records.length + result.skipped.length).toBeLessThanOrEqual(3);
    const complete = await new FilesystemKnowledgeSource(root).list();
    expect(complete.listing).toBeUndefined();
    expect(complete.records).toHaveLength(5);
  });

  it("dybdegrensen beskytter prefikset under den (ikke bekreftet borte) uten å avkorte resten", async () => {
    await mkdir(join(root, "a", "b", "c"), { recursive: true });
    await writeFile(join(root, "topp.md"), "topp");
    await writeFile(join(root, "a", "b", "c", "dypt.md"), "dypt");
    const result = await new FilesystemKnowledgeSource(root, undefined, { limits: { maxDepth: 1 } }).list();
    expect(result.records.map((r) => r.external_id)).toEqual(["topp.md"]);
    expect(result.protected_prefixes).toEqual(["a/b/"]);
    expect(result.listing).toBeUndefined();
  });

  it("en uleselig undermappe gir et beskyttet prefiks i stedet for å avkorte hele listingen (hopper over når testen kjører som root)", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    await mkdir(join(root, "lost+found"), { recursive: true });
    await writeFile(join(root, "vanlig.md"), "vanlig");
    await chmod(join(root, "lost+found"), 0o000);
    try {
      const result = await new FilesystemKnowledgeSource(root).list();
      expect(result.records.map((r) => r.external_id)).toEqual(["vanlig.md"]);
      expect(result.protected_prefixes).toEqual(["lost+found/"]);
    } finally {
      await chmod(join(root, "lost+found"), 0o700);
    }
  });

  it("Obsidian-kilden bærer partial/beskyttede prefikser gjennom og kan få egne grenser", async () => {
    await mkdir(join(root, ".obsidian"), { recursive: true });
    await writeFile(join(root, ".obsidian", "app.md"), "intern");
    await writeFile(join(root, "a.md"), "a");
    await writeFile(join(root, "b.md"), "b");
    await writeFile(join(root, "c.md"), "c");
    const result = await new ObsidianVaultKnowledgeSource(root, "obs:test", { maxFiles: 2 }).list();
    expect(result.listing).toBe("partial");
    expect(result.records.every((r) => !r.external_id.startsWith(".obsidian/"))).toBe(true);
  });

  it("walkAllowlistedFiles: ingen filer utenfor allowlisten, og relative stier bruker /", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "x.md"), "x");
    await writeFile(join(root, "sub", "y.exe"), "y");
    const walk = await walkAllowlistedFiles(root, new Set([".md"]));
    expect(walk.files.map((f) => f.relPath)).toEqual(["sub/x.md"]);
    expect(walk.truncated).toBe(false);
  });
});

const TXT = ["Tittel: Ukesmøte", "Dato: 2026-03-02", "Deltakere: Ola Nordmann, Kari Hansen", "[00:00:05] Ola Nordmann: Velkommen. Kontakt meg på " + EMAIL, "[00:00:12] Kari Hansen: Takk."].join("\n");
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Kari Hansen>Hei alle sammen</v>\n";
const SRT = "1\n00:00:01,000 --> 00:00:03,000\nOla: God morgen\n";
const JSON_T = JSON.stringify({ title: "Styremøte", participants: [{ name: "Ola Nordmann", id: "user-17" }], segments: [{ speaker: "Ola Nordmann", start: 1, text: "Velkommen" }] });

describe("B: MeetingTranscriptKnowledgeSource", () => {
  it("leser txt/vtt/srt/json, ignorerer andre filtyper, og gir nøytrale records uten e-post, sti eller filnavn i uri", async () => {
    await mkdir(join(root, "q1"), { recursive: true });
    await writeFile(join(root, "q1", `mote-med-${EMAIL}.txt`), TXT);
    await writeFile(join(root, "mote.vtt"), VTT);
    await writeFile(join(root, "mote2.srt"), SRT);
    await writeFile(join(root, "styre.json"), JSON_T);
    await writeFile(join(root, "bilde.png"), Buffer.from([1, 2, 3]));
    await writeFile(join(root, "notater.docx"), "ikke et transkript");
    const source = new MeetingTranscriptKnowledgeSource(root, "mt:test");
    expect(source.source_type).toBe("meeting_transcript");
    const { records, skipped } = await source.list();
    expect(skipped).toEqual([]);
    expect(records).toHaveLength(4);
    for (const r of records) {
      expect(r.source_type).toBe("meeting_transcript");
      expect(r.source_instance_id).toBe("mt:test");
      expect(r.content_type).toBe("text/plain");
      expect(r.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(r)).not.toContain("@"); // ingen e-postadresse noe sted i recorden (tittel, innhold, uri, metadata)
      expect(r.canonical_uri).toMatch(/^transcript:\/\/mt:test\/[0-9a-f]{16}$/);
      expect(r.canonical_uri).not.toContain(root);
      expect(r.modified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    const txt = records.find((r) => r.metadata["format"] === "txt")!;
    expect(txt.external_id).toMatch(/^q1\/\[e-postadresse\]~[0-9a-f]{12}$/); // stabil id uten adressen i klartekst (regexen tar hele «lokaldel@domene.endelse»)
    expect(txt.title).toBe("Ukesmøte");
    expect(txt.content).toContain("[e-postadresse]");
    expect(txt.metadata["participants"]).toEqual([{ name: "Ola Nordmann", ref: "p1" }, { name: "Kari Hansen", ref: "p2" }]);
    expect(txt.metadata["emails_redacted"]).toBe(1);
    const json = records.find((r) => r.metadata["format"] === "json")!;
    expect(json.metadata["participants"]).toEqual([{ name: "Ola Nordmann", ref: "user-17" }]);
  });

  it("filnavn som tittel-reserve redigeres for e-post; mtime er modified_at (innholdet kan ikke styre oppbevaringsfristen)", async () => {
    await writeFile(join(root, `${EMAIL}_mote_uten_tittel.vtt`), VTT);
    const old = new Date("2024-01-15T10:00:00Z");
    await utimes(join(root, `${EMAIL}_mote_uten_tittel.vtt`), old, old);
    const { records } = await new MeetingTranscriptKnowledgeSource(root, "mt:t2").list();
    expect(records).toHaveLength(1);
    expect(records[0]!.title).toBe("[e-postadresse] mote uten tittel");
    expect(records[0]!.modified_at).toBe(old.toISOString());
    // En dato i innholdet påvirker ikke modified_at:
    await writeFile(join(root, "fremtid.txt"), "Dato: 2999-01-01\n[00:00:01] A: hei");
    const again = await new MeetingTranscriptKnowledgeSource(root, "mt:t2").list();
    const future = again.records.find((r) => r.external_id === "fremtid.txt")!;
    expect(future.metadata["started_at"]).toBe("2999-01-01T00:00:00.000Z");
    expect(Date.parse(future.modified_at!)).toBeLessThan(Date.parse("2100-01-01T00:00:00Z"));
  });

  it("en fil som ikke lar seg tolke, er for stor eller er binær hoppes over (skipped, beskyttet) - resten leses", async () => {
    await writeFile(join(root, "godt.vtt"), VTT);
    await writeFile(join(root, "ødelagt.json"), "{ikke json");
    await writeFile(join(root, "uten-header.vtt"), "00:00:01.000 --> 00:00:02.000\nhei");
    await writeFile(join(root, "tom.txt"), "   \n");
    await writeFile(join(root, "stor.txt"), "[00:00:01] A: ord\n".repeat(100));
    await writeFile(join(root, "binaer.srt"), Buffer.from([0x31, 0x0a, 0x00, 0x01]));
    const source = new MeetingTranscriptKnowledgeSource(root, "mt:skip", { limits: { maxFileBytes: 500 } });
    const { records, skipped } = await source.list();
    expect(records.map((r) => r.external_id)).toEqual(["godt.vtt"]);
    const byId = Object.fromEntries(skipped.map((s) => [s.external_id, s]));
    expect(byId["ødelagt.json"]).toMatchObject({ reason: "UNSUPPORTED_CONTENT", detail: "json_invalid" });
    expect(byId["uten-header.vtt"]).toMatchObject({ reason: "UNSUPPORTED_CONTENT", detail: "vtt_header_missing" });
    expect(byId["tom.txt"]).toMatchObject({ detail: "empty" });
    expect(byId["stor.txt"]).toMatchObject({ detail: "too_large" });
    expect(byId["binaer.srt"]).toMatchObject({ detail: "binary_content" });
  });

  it("formater kan begrenses, og symlink ut av roten leses aldri", async () => {
    await writeFile(join(root, "a.txt"), TXT);
    await writeFile(join(root, "b.vtt"), VTT);
    const onlyVtt = await new MeetingTranscriptKnowledgeSource(root, "mt:f", { formats: ["vtt"] }).list();
    expect(onlyVtt.records.map((r) => r.external_id)).toEqual(["b.vtt"]);
    await writeFile(join(outside, "hemmelig.vtt"), VTT.replace("Hei alle sammen", "UTENFOR-ROTEN"));
    try {
      await symlink(join(outside, "hemmelig.vtt"), join(root, "lenke.vtt"));
    } catch {
      return;
    }
    const all = await new MeetingTranscriptKnowledgeSource(root, "mt:f").list();
    expect(all.records.some((r) => r.content.includes("UTENFOR-ROTEN"))).toBe(false);
  });

  it("en manglende rot er total svikt (aldri en tom liste)", async () => {
    await expect(new MeetingTranscriptKnowledgeSource(join(root, "borte"), "mt:x").list()).rejects.toMatchObject({ errorClass: "SOURCE_UNAVAILABLE" });
  });
});
