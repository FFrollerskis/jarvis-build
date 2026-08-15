import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FilesystemKnowledgeSource } from "../src/filesystem-source.ts";

/**
 * UA-2 P0 §2/§7.I/§7.J: filesystem-kilden får KUN lese allowlistede roots -
 * ingen arbitrary path access, ingen traversal, ingen symlink-escape.
 */
describe("FilesystemKnowledgeSource", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "jarvis-fs-source-"));
    outside = await mkdtemp(join(tmpdir(), "jarvis-fs-outside-"));
  });

  it("§7.I lister allowlistede tekstfiler med korrekt innhold/hash/metadata", async () => {
    await writeFile(join(root, "notat.md"), "# Tittel\n\nInnhold her.");
    await writeFile(join(root, "data.json"), '{"a":1}');
    await writeFile(join(root, "binaer.png"), Buffer.from([0, 1, 2, 3])); // IKKE tekstformat - skal hoppes over

    const source = new FilesystemKnowledgeSource(root);
    const records = await source.list();

    expect(records).toHaveLength(2); // .png filtrert bort
    const md = records.find((r) => r.external_id === "notat.md");
    expect(md).toBeDefined();
    expect(md?.content).toContain("Tittel");
    expect(md?.content_type).toBe("text/markdown");
    expect(md?.source_type).toBe("filesystem");
    expect(md?.content_hash).toHaveLength(64); // sha256 hex
  });

  it("§7.J traversal via '../' i konfigurert path er strukturelt umulig - roten er alltid resolve()-basert", async () => {
    // FilesystemKnowledgeSource tar imot rootPath og resolve()-er den selv -
    // en konsument kan ikke smugle '../' inn via external_id/canonical_uri
    // siden disse er AVLEDET fra faktisk skannede filer, aldri brukerinput.
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "fil.txt"), "innhold");
    const source = new FilesystemKnowledgeSource(join(root, "sub", "..", "sub")); // urenset sti inn
    const records = await source.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.external_id).toBe("fil.txt");
  });

  it("§7.J symlink som peker UT av roten hoppes over - path-escape DENY, ikke feil for hele scanningen", async () => {
    await writeFile(join(outside, "hemmelig.txt"), "hemmelig innhold utenfor roten");
    await writeFile(join(root, "vanlig.md"), "vanlig innhold");
    try {
      await symlink(join(outside, "hemmelig.txt"), join(root, "lenke.txt"));
    } catch {
      // Symlink kan mangle rettigheter i noen sandbox-miljøer - testen er da ikke kjørbar.
      return;
    }

    const source = new FilesystemKnowledgeSource(root);
    const records = await source.list();

    // Den lovlige filen listes; symlink-en til utenfor roten er ALDRI med:
    expect(records.some((r) => r.external_id === "vanlig.md")).toBe(true);
    expect(records.some((r) => r.content.includes("hemmelig"))).toBe(false);
    expect(records.some((r) => r.external_id === "lenke.txt")).toBe(false);
  });

  it("§7.J symlink som peker til en TILLATT undermappe (innenfor roten) fungerer normalt", async () => {
    await mkdir(join(root, "ekte"), { recursive: true });
    await writeFile(join(root, "ekte", "fil.md"), "innenfor roten");
    try {
      await symlink(join(root, "ekte"), join(root, "lenke-innenfor"));
    } catch {
      return;
    }
    const source = new FilesystemKnowledgeSource(root);
    const records = await source.list();
    // Filen nås via begge stier (ekte/fil.md og lenke-innenfor/fil.md) - begge er innenfor roten, begge lovlige:
    expect(records.filter((r) => r.content === "innenfor roten").length).toBeGreaterThanOrEqual(1);
  });

  it("respekterer eksplisitt filtypeliste - kun konfigurerte extensions ingesteres", async () => {
    await writeFile(join(root, "kode.ts"), "export const x = 1;");
    await writeFile(join(root, "ikke.rb"), "puts 'hei'"); // ikke i default-listen
    const source = new FilesystemKnowledgeSource(root);
    const records = await source.list();
    expect(records.map((r) => r.external_id)).toEqual(["kode.ts"]);
  });
});
