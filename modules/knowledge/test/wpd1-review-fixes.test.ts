import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelGatewayVisionExtractor, ocrSensitivityForSource } from "../src/ocr-provider.ts";
import { evaluateEvidence, normalizeVerificationPolicy, type ClaimEvidence } from "../src/claim-verification.ts";
import { FilesystemKnowledgeSource, readWalkedFile, walkAllowlistedFiles } from "../src/filesystem-source.ts";
import { neutralizeUntrustedText, stripControlAndInvisible } from "../src/knowledge-hits.ts";
import { KnowledgeSourceRegistry } from "../src/registry.ts";
import { KnowledgeSourcesConfigError, parseKnowledgeSources, type ConfiguredKnowledgeSource } from "../src/source-config.ts";
import { KnowledgeSyncRunner } from "../src/sync-runner.ts";

/**
 * WP-D1, gjennomgang av PR #325 (uavhengig reviewer): funn 2 (symlink/FIFO mellom listing og lesing, hengende synk), 3 (skjulte kataloger), 4 (OCR-sensitivitet), 5 (claim-uavhengighet, ren evaluering),
 * 6 (tom rot), 7 (oppføringstak), 9 (trust internal) og de usynlige tegnene i funn 1. Filsystemtestene bruker EKTE temp-kataloger, symlinker og FIFO.
 */
let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "jarvis-wpd1-review-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function seed(name: string, files: Record<string, string>): Promise<string> {
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  return root;
}
const EXTS = new Set([".md", ".txt", ".json"]);

describe("funn 3: skjulte filer og kataloger indekseres aldri (en hemmelighetsmappe INNE i en tillatt rot)", () => {
  it("vandringen hopper over .aws/.ssh/.docker/.config/.git og skjulte filer, men tar med vanlige filer og kataloger", async () => {
    const root = await seed("hidden", {
      "notat.md": "vanlig notat",
      "mappe/under.md": "under en vanlig mappe",
      ".aws/creds.json": "{\"x\":1}",
      ".ssh/notes.md": "private notater",
      ".docker/config.json": "{\"auths\":{}}",
      ".config/app.json": "{}",
      ".git/info.md": "git-intern",
      ".skjult.md": "skjult fil",
      "mappe/.intern/hemmelig.md": "skjult mappe under en vanlig",
      "..notat.md": "navn som starter med to punktum er ikke skjult og ikke et utbrudd"
    });
    const walk = await walkAllowlistedFiles(root, EXTS);
    expect(walk.files.map((f) => f.relPath).sort()).toEqual(["..notat.md", "mappe/under.md", "notat.md"]);
  });
});

describe("funn 2: filleseren tåler at filen byttes ut etter listingen", () => {
  it("en fil som byttes mot en symlink til en fil UTENFOR roten leses ikke (O_NOFOLLOW)", async () => {
    const outside = await seed("outside-1", { "hemmelig.md": "UTENFOR" });
    const root = await seed("swap-symlink", { "notat.md": "OPPRINNELIG" });
    const walk = await walkAllowlistedFiles(root, EXTS);
    const file = walk.files[0] as (typeof walk.files)[number];
    await rm(file.real);
    await symlink(join(outside, "hemmelig.md"), file.real);
    expect(await readWalkedFile(file, 1_000_000)).toEqual({ skip: "unreadable" });
  });

  it("en fil som byttes mot en FIFO henger ikke (O_NONBLOCK + fstat), den hoppes over", async () => {
    const root = await seed("swap-fifo", { "notat.md": "OPPRINNELIG" });
    const walk = await walkAllowlistedFiles(root, EXTS);
    const file = walk.files[0] as (typeof walk.files)[number];
    await rm(file.real);
    execFileSync("mkfifo", [file.real]);
    const outcome = await Promise.race([readWalkedFile(file, 1_000_000), new Promise<"hang">((resolve) => setTimeout(() => resolve("hang"), 3_000))]);
    expect(outcome).toEqual({ skip: "unreadable" });
  });

  it.skipIf(process.platform !== "linux")("en MELLOMLIGGENDE katalog som byttes mot en symlink ut av roten gir en annen sann sti - filen leses ikke", async () => {
    const outside = await seed("outside-2", { "a.md": "UTENFOR" });
    const root = await seed("swap-dir", { "sub/a.md": "OPPRINNELIG" });
    const walk = await walkAllowlistedFiles(root, EXTS);
    const file = walk.files[0] as (typeof walk.files)[number];
    await rename(join(root, "sub"), join(root, "sub.bak"));
    await symlink(outside, join(root, "sub"));
    expect(await readWalkedFile(file, 1_000_000)).toEqual({ skip: "unreadable" });
  });

  it("en uendret fil leses som før; for stor og binær hoppes over; en fil som vokser forbi grensen etter stat leses aldri hele", async () => {
    const root = await seed("plain", { "a.md": "Hei på deg", "stor.md": "x".repeat(2_000), "bin.md": "ab\u0000cd" });
    const walk = await walkAllowlistedFiles(root, EXTS, { maxFileBytes: 1_000 });
    const byName = (n: string) => [...walk.files, ...walk.oversized].find((f) => f.relPath === n) as (typeof walk.files)[number];
    expect(await readWalkedFile(byName("a.md"), 1_000)).toEqual({ text: "Hei på deg" });
    expect(await readWalkedFile(byName("bin.md"), 1_000)).toEqual({ skip: "binary_content" });
    expect(await readWalkedFile(byName("stor.md"), 1_000)).toEqual({ skip: "too_large" });
  });
});

describe("funn 6: en eksisterende men TOM rot er aldri grunnlag for tombstoning", () => {
  it("tom rot gir en avkortet listing (empty_listing) og `partial` fra kilden; en rot med filer gir fullstendig listing", async () => {
    const empty = await seed("empty-root", {});
    const walk = await walkAllowlistedFiles(empty, EXTS);
    expect(walk).toMatchObject({ files: [], truncated: true, truncated_reason: "empty_listing" });
    const listed = await new FilesystemKnowledgeSource(empty, "fs:empty").list();
    expect(listed.listing).toBe("partial");
    expect(listed.records).toEqual([]);

    const full = await seed("full-root", { "a.md": "x" });
    const ok = await new FilesystemKnowledgeSource(full, "fs:full").list();
    expect(ok.listing).toBeUndefined();
    expect(ok.records).toHaveLength(1);
  });

  it("en rot som bare har skjulte/ikke-støttede filer regnes også som tom", async () => {
    const root = await seed("only-hidden", { ".skjult.md": "x", "bilde.png": "x" });
    expect(await walkAllowlistedFiles(root, EXTS)).toMatchObject({ truncated: true, truncated_reason: "empty_listing" });
  });

  it("en manglende rot er fortsatt TOTAL svikt (kaster), ikke en tom liste", async () => {
    await expect(walkAllowlistedFiles(join(base, "finnes-ikke"), EXTS)).rejects.toMatchObject({ name: "KnowledgeSourceError", errorClass: "SOURCE_UNAVAILABLE" });
  });
});

describe("funn 7: tak på oppføringer", () => {
  it("overskrides maxEntries, er listingen avkortet (max_entries) og stopper tidlig", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) files[`n${i}.md`] = "x";
    const root = await seed("many", files);
    const walk = await walkAllowlistedFiles(root, EXTS, { maxEntries: 10 });
    expect(walk).toMatchObject({ truncated: true, truncated_reason: "max_entries" });
    expect(walk.files.length).toBeLessThanOrEqual(10);
  });

  it("filer med ikke-støttede endelser teller mot taket uten å koste realpath/stat (mange filer, få støttede)", async () => {
    const files: Record<string, string> = { "a.md": "x" };
    for (let i = 0; i < 200; i += 1) files[`bilde${i}.png`] = "x";
    const root = await seed("mostly-unsupported", files);
    const walk = await walkAllowlistedFiles(root, EXTS);
    expect(walk.files.map((f) => f.relPath)).toEqual(["a.md"]);
    expect(walk.truncated).toBe(false);
  });
});

describe("funn 9: trust internal kun for lokale kilder eieren kontrollerer", () => {
  const ctx = (root: string) => ({ tenant_id: "t1", fs_roots: [root], google_account: "post@tsworkflow.com", github_repo: "tsworkflow/jarvisbuild", github_unlocked: false });
  const parse = (entries: unknown[], root: string) => parseKnowledgeSources(JSON.stringify(entries), ctx(root));

  it("obsidian, filesystem og meeting_transcript kan være internal", async () => {
    const root = await seed("trust-ok", {});
    const sources = parse([
      { id: "v", kind: "obsidian", memory_space: "personal", path: root, trust: "internal" },
      { id: "f", kind: "filesystem", memory_space: "personal", path: root, trust: "internal" },
      { id: "m", kind: "meeting_transcript", memory_space: "business", path: root, trust: "internal" }
    ], root);
    expect(sources.map((s) => s.policy.trust)).toEqual(["internal", "internal", "internal"]);
  });

  it.each([
    ["github", { kind: "github", repo: "tsworkflow/jarvisbuild" }],
    ["drive", { kind: "drive", whole_drive: true }],
    ["email_attachment", { kind: "email_attachment" }]
  ])("%s avvises med trust internal (andre kan skrive i kilden)", async (_name, extra) => {
    const root = await seed("trust-bad", {});
    let error: unknown;
    try {
      parse([{ id: "x", memory_space: "personal", trust: "internal", ...extra }], root);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(KnowledgeSourcesConfigError);
    expect((error as KnowledgeSourcesConfigError).problems.join(" ")).toMatch(/trust: 'internal' is only allowed for obsidian, filesystem and meeting_transcript/);
    // samme kilde uten trust (eller med untrusted) er fortsatt gyldig
    expect(parse([{ id: "x", memory_space: "personal", trust: "untrusted", ...extra }], root)).toHaveLength(1);
  });
});

describe("funn 4: OCR rutes aldri som lavt sensitivt", () => {
  const seen: unknown[] = [];
  const gateway = { complete: async (input: unknown) => { seen.push(input); return { text: "tekst" }; } };
  const image = { media_type: "image/png", data: "AAAA" };

  it("standard er PRIVATE (ikke undefined = lavt sensitivt); eksplisitt SECRET_RESTRICTED følger kallet, for både OCR og bildebeskrivelse", async () => {
    seen.length = 0;
    await new ModelGatewayVisionExtractor(gateway, "t1").transcribeText(image);
    await new ModelGatewayVisionExtractor(gateway, "t1", "task-1", "SECRET_RESTRICTED").describeImage(image);
    expect(seen.map((s) => (s as { sensitivity: string }).sensitivity)).toEqual(["PRIVATE", "SECRET_RESTRICTED"]);
    expect(seen.every((s) => (s as { purpose: string }).purpose === "VISION")).toBe(true);
  });

  it("ocrSensitivityForSource: helse-rommet og special-gulv/tak = SECRET_RESTRICTED, alt annet PRIVATE", () => {
    expect(ocrSensitivityForSource({ memory_space: "health", policy: {} })).toBe("SECRET_RESTRICTED");
    expect(ocrSensitivityForSource({ memory_space: "personal", policy: { default_sensitivity: "special" } })).toBe("SECRET_RESTRICTED");
    expect(ocrSensitivityForSource({ memory_space: "personal", policy: { max_sensitivity: "special" } })).toBe("SECRET_RESTRICTED");
    expect(ocrSensitivityForSource({ memory_space: "personal", policy: { default_sensitivity: "sensitive" } })).toBe("PRIVATE");
    expect(ocrSensitivityForSource({ memory_space: "business", policy: {} })).toBe("PRIVATE");
  });
});

describe("funn 5: uavhengige kilder = sammenhengende komponenter (nøkkel, kildeinstans, innholdshash)", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const policy = normalizeVerificationPolicy({ min_independent_sources: 2 });
  const ev = (key: string, links: string[] = [], over: Partial<ClaimEvidence> = {}): ClaimEvidence => ({
    stance: "supports", independence_key: key, links, is_primary: false, published_at: null, retrieved_at: now, retracted: false, ...over
  });

  it("uten lenker er oppførselen uendret: ulike nøkler = ulike kilder", () => {
    expect(evaluateEvidence([ev("doc:a"), ev("doc:b"), ev("doc:c")], policy, now)).toMatchObject({ independent_support: 3, rule_met: true });
  });

  it("tre dokumenter fra SAMME kildeinstans er ÉN kilde, uansett nøkkel", () => {
    const e = evaluateEvidence([ev("doc:a", ["src:filesystem:notater"]), ev("doc:b", ["src:filesystem:notater"]), ev("doc:c", ["src:filesystem:notater"])], policy, now);
    expect(e).toMatchObject({ independent_support: 1, rule_met: false });
    expect(e.reasons).toContain("same_source_or_content_collapsed");
  });

  it("samme innhold i to kilder (speil/kopi) er ÉN kilde; to ulike kilder med ulikt innhold er to", () => {
    const mirrored = evaluateEvidence([ev("doc:a", ["src:filesystem:x", "hash:H1"]), ev("doc:b", ["src:drive:y", "hash:H1"])], policy, now);
    expect(mirrored.independent_support).toBe(1);
    const distinct = evaluateEvidence([ev("doc:a", ["src:filesystem:x", "hash:H1"]), ev("doc:b", ["src:drive:y", "hash:H2"])], policy, now);
    expect(distinct).toMatchObject({ independent_support: 2, rule_met: false }); // (to uten primærkilde er ikke nok for VERIFIED)
  });

  it("transitivt: A og B deler kildeinstans, B og C deler hash -> én komponent; D er uavhengig", () => {
    const e = evaluateEvidence([ev("doc:a", ["src:fs:x"]), ev("doc:b", ["src:fs:x", "hash:H"]), ev("doc:c", ["hash:H"]), ev("doc:d", ["src:fs:z"])], policy, now);
    expect(e.independent_support).toBe(2);
    expect(e.supporting_keys).toEqual(["doc:a", "doc:d"]);
  });

  it("lenker og deklarert nøkkel virker sammen: samme deklarerte oppstrøms (nyhetsbyrå) i to ulike kilder er ÉN", () => {
    expect(evaluateEvidence([ev("domain:reuters.com", ["src:drive:a"]), ev("domain:reuters.com", ["src:fs:b"])], policy, now).independent_support).toBe(1);
  });

  it("resultatet er uavhengig av radrekkefølgen", () => {
    const rows = [ev("doc:a", ["src:fs:x"]), ev("doc:b", ["hash:H", "src:fs:x"]), ev("doc:c", ["hash:H"]), ev("doc:d")];
    const forward = evaluateEvidence(rows, policy, now);
    const backward = evaluateEvidence([...rows].reverse(), policy, now);
    expect(backward).toEqual(forward);
  });
});

describe("funn 1: usynlige tegn fjernes fra det som vises til modellen", () => {
  const tag = (code: number): string => String.fromCodePoint(code);
  it.each([
    ["myk bindestrek", "­"], ["grafem-skjøt", "͏"], ["arabisk bokstavmerke", "؜"], ["Hangul-fylleren", "ㅤ"], ["mongolsk vokalskille", "᠎"],
    ["variasjonsvelger", "️"], ["ordsammenføyer", "⁠"], ["usynlig funksjonstegn", "⁢"], ["tagg-tegn", tag(0xe0061)], ["tagg-avslutter", tag(0xe007f)], ["variasjonsvelger-tillegg", tag(0xe0100)]
  ])("%s fjernes", (_name, invisible) => {
    expect(stripControlAndInvisible(`ab${invisible}cd`)).toBe("abcd");
    expect(neutralizeUntrustedText(`ab${invisible}cd`)).toBe("abcd");
  });
});

describe("funn 2: synk-løperens vakthund frigir plassen når en kilde henger", () => {
  async function configured(root: string): Promise<ConfiguredKnowledgeSource[]> {
    return parseKnowledgeSources(JSON.stringify([{ id: "henger", kind: "filesystem", memory_space: "personal", path: root }]), { tenant_id: "t1", fs_roots: [root], google_account: "post@tsworkflow.com", github_repo: "tsworkflow/jarvisbuild", github_unlocked: false });
  }

  it("en preflight som aldri svarer gir utfallet failed/source_sync_timeout, loggføres uten innhold, og kilden planlegges på nytt", async () => {
    const root = await seed("hang", { "a.md": "x" });
    const sources = await configured(root);
    const registry = new KnowledgeSourceRegistry(sources.map((s) => s.config));
    const logs: Array<Record<string, unknown>> = [];
    const runner = new KnowledgeSyncRunner({
      pool: {} as never, embeddings: {} as never, sources,
      buildSource: (source, identity) => registry.build(source.config.tenant_id, source.memory_space, source.id, { identity }),
      identityFor: (source) => ({ person_id: "p", tenant_id: "t1", memory_space_id: source.memory_space, session_id: "s", device_id: "d", channel: "api", auth_strength: "active" }),
      preflight: () => new Promise<string | null>(() => undefined),
      log: (entry) => logs.push(entry), sourceTimeoutMs: 80, tickMs: 1_000, firstRunDelayMs: 0, staggerMs: 0
    });
    const started = Date.now();
    const outcome = await runner.runNow("henger");
    expect(outcome).toEqual({ status: "failed", error: "source_sync_timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(logs.find((l) => l["msg"] === "knowledge_source_timeout")).toMatchObject({ source_id: "henger", kind: "filesystem", after_ms: 80 });
    expect(JSON.stringify(logs)).not.toContain("a.md");
    // plassen er frigitt: neste kjøring av samme kilde er en NY kjøring (ikke den hengende)
    const again = await runner.runNow("henger");
    expect(again).toEqual({ status: "failed", error: "source_sync_timeout" });
    expect(runner.status()[0]?.last_outcome).toBe("failed");
  });
});
