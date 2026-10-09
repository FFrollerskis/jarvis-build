import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  KnowledgeSourcesConfigError,
  SOURCES_CONFIG_LIMITS,
  isPathInside,
  parseFilesystemRoots,
  parseKnowledgeSources,
  verifyFilesystemRoot,
  type KnowledgeSourcesParseContext
} from "../src/source-config.ts";
import { DRIVE_PRODUCTION_PACING } from "../src/drive-source.ts";

/**
 * WP-D1 (UA-2, JARVIS-032): den deklarative kildekonfigurasjonen (`JARVIS_KNOWLEDGE_SOURCES`). Ren parser: ingen database, ingen miljøvariabler. Låser at dvalemodus er standard, at ALL feil
 * gir en lukket, høylytt avvisning av HELE listen (aldri en delvis liste), og at stier, GitHub-låsen, Drive-scope og sensitivitetsgrensene holder.
 */
const context = (overrides: Partial<KnowledgeSourcesParseContext> = {}): KnowledgeSourcesParseContext => ({
  tenant_id: "tenant-cfg", fs_roots: ["/knowledge"], google_account: "post@tsworkflow.com", github_repo: "tsworkflow/jarvisbuild", github_unlocked: false, ...overrides
});
const parse = (value: unknown, ctx = context()) => parseKnowledgeSources(JSON.stringify(value), ctx);
const problemsOf = (value: unknown, ctx = context()): readonly string[] => {
  try {
    parse(value, ctx);
  } catch (err) {
    if (err instanceof KnowledgeSourcesConfigError) return err.problems;
    throw err;
  }
  throw new Error("forventet at konfigurasjonen skulle avvises");
};
const drive = (extra: Record<string, unknown> = {}) => ({ id: "drive-docs", kind: "drive", memory_space: "personal", folder_id: "1AbCdEfGhIjKlMnOp", ...extra });
const vault = (extra: Record<string, unknown> = {}) => ({ id: "vault", kind: "obsidian", memory_space: "personal", path: "/knowledge/obsidian", ...extra });

describe("A: dvale er standard", () => {
  it("utelatt, tom eller blank konfigurasjon gir ingen kilder (ikke en feil), og en tom liste er gyldig", () => {
    for (const raw of [undefined, "", "   ", "\n"]) expect(parseKnowledgeSources(raw, context())).toEqual([]);
    expect(parse([])).toEqual([]);
  });
});

describe("B: en gyldig konfigurasjon gir registerets form (tenant fra konteksten, aldri fra konfigurasjonen)", () => {
  it("alle seks kildetyper: kind -> source_type, tenant/rom/id på plass, standarder utfylt", () => {
    const sources = parse([
      drive(),
      vault({ trust: "internal" }),
      { id: "docs-root", kind: "filesystem", memory_space: "project", path: "/knowledge/docs", extensions: [".md", ".txt"], max_files: 500 },
      { id: "repo-docs", kind: "github", memory_space: "project", repo: "TSWorkflow/JarvisBuild" },
      { id: "inbox", kind: "email_attachment", memory_space: "personal", max: 10, query: "has:attachment newer_than:7d" },
      { id: "meetings", kind: "meeting_transcript", memory_space: "business", path: "/knowledge/meetings/", formats: ["vtt", "txt"], retention_days: 180, sync_interval_minutes: 60 }
    ]);
    expect(sources.map((s) => `${s.kind}:${s.config.source_type}:${s.memory_space}:${s.id}`)).toEqual([
      "drive:google_drive:personal:drive-docs", "obsidian:obsidian:personal:vault", "filesystem:filesystem:project:docs-root", "github:github:project:repo-docs",
      "email_attachment:email_attachment:personal:inbox", "meeting_transcript:meeting_transcript:business:meetings"
    ]);
    for (const source of sources) {
      expect(source.config.tenant_id).toBe("tenant-cfg");
      expect(source.config.source_instance_id).toBe(source.id);
      expect(source.config.memory_space_id).toBe(source.memory_space);
    }
    expect(sources[0]!.config).toMatchObject({ scope: { kind: "folder", folder_id: "1AbCdEfGhIjKlMnOp" }, account: "post@tsworkflow.com", options: { ...DRIVE_PRODUCTION_PACING } });
    expect(sources[1]!.config).toMatchObject({ vault_root: "/knowledge/obsidian" });
    expect(sources[1]!.policy).toEqual({ trust: "internal" });
    expect(sources[2]!.config).toMatchObject({ root_path: "/knowledge/docs", limits: { maxFiles: 500 } });
    expect([...((sources[2]!.config as { allowed_extensions: ReadonlySet<string> }).allowed_extensions)].sort()).toEqual([".md", ".txt"]);
    expect(sources[3]!.config).toMatchObject({ repo: "TSWorkflow/JarvisBuild" });
    expect(sources[4]!.config).toMatchObject({ account: "post@tsworkflow.com", max: 10, query: "has:attachment newer_than:7d" });
    expect(sources[5]!.config).toMatchObject({ root_path: "/knowledge/meetings", formats: ["vtt", "txt"] });
    expect(sources[5]).toMatchObject({ retention_days: 180, sync_interval_minutes: 60 });
    expect(sources[0]).toMatchObject({ retention_days: undefined, sync_interval_minutes: SOURCES_CONFIG_LIMITS.defaultIntervalMinutes, policy: {} });
  });

  it("Drive: hele disken må velges BEVISST (whole_drive: true); ark-valg og tak videresendes", () => {
    const [whole] = parse([{ id: "hele", kind: "drive", memory_space: "personal", whole_drive: true, sheets: "all", max_sheet_rows: 100, max_sheet_columns: 10, max_sheets_per_file: 3 }]);
    expect(whole!.config).toMatchObject({ scope: { kind: "whole_drive" }, options: { sheets: "all", max_sheet_rows: 100, max_sheet_columns: 10, max_sheets_per_file: 3, pace_ms: DRIVE_PRODUCTION_PACING.pace_ms } });
  });

  it("avslåtte kilder (enabled: false) valideres, men tas ikke med; helse-rommet er et gyldig rom", () => {
    const sources = parse([vault({ enabled: false }), { id: "helse", kind: "meeting_transcript", memory_space: "health", path: "/knowledge/helse" }]);
    expect(sources.map((s) => s.id)).toEqual(["helse"]);
    expect(problemsOf([vault({ enabled: false, path: "relativ/sti" })])).toEqual(["sources[0].path: must be absolute"]);
  });

  it("sensitivitet: gulv, tak og tillit videresendes som kildens policy", () => {
    const [source] = parse([vault({ default_sensitivity: "normal", max_sensitivity: "sensitive", trust: "untrusted" })]);
    expect(source!.policy).toEqual({ default_sensitivity: "normal", max_sensitivity: "sensitive", trust: "untrusted" });
  });
});

describe("C: all feil avviser HELE listen med ALLE problemene (aldri en delvis liste)", () => {
  it("én gyldig og to ugyldige kilder: ingenting tas i bruk, begge problemene rapporteres, og ingen verdier ekkoes", () => {
    const problems = problemsOf([vault(), { id: "A B", kind: "obsidian", memory_space: "personal", path: "/knowledge/x" }, { id: "x", kind: "web", memory_space: "personal" }]);
    expect(problems.some((p) => p.startsWith("sources[1].id"))).toBe(true);
    expect(problems.some((p) => p.startsWith("sources[2].kind"))).toBe(true);
    expect(problems.every((p) => !p.startsWith("sources[0]"))).toBe(true);
    const secretish = problemsOf([{ id: "ok", kind: "github", memory_space: "personal", repo: "tsworkflow/jarvisbuild", "hemmelig-nokkel-123": "x" }]);
    expect(secretish.join(" ")).toContain("unknown key");
  });

  it("ugyldig JSON, ikke en liste, for stor, for mange kilder og ikke-objekter avvises", () => {
    for (const raw of ["{ikke json", "{\"id\":\"a\"}", "\"tekst\"", "5", "null", "true"]) {
      expect(() => parseKnowledgeSources(raw, context()), raw).toThrow(KnowledgeSourcesConfigError);
    }
    expect(() => parseKnowledgeSources(`[${"1,".repeat(SOURCES_CONFIG_LIMITS.maxJsonChars)}1]`, context())).toThrow(/rejected/);
    expect(problemsOf(Array.from({ length: SOURCES_CONFIG_LIMITS.maxSources + 1 }, (_, i) => vault({ id: `v${i}` })))).toEqual([`config: more than ${SOURCES_CONFIG_LIMITS.maxSources} sources`]);
    expect(problemsOf([null, 5, "x", [1], []])).toEqual(["sources[0]: must be an object", "sources[1]: must be an object", "sources[2]: must be an object", "sources[3]: must be an object", "sources[4]: must be an object"]);
  });

  it("ukjente felt avvises - også tenant_id, memory_space-lister, __proto__ og felt som hører til en annen kildetype", () => {
    for (const extra of [{ tenant_id: "annen-tenant" }, { tenantId: "x" }, { spaces: ["health"] }, { credential: "hemmelig" }, { repo: "a/b" }, { folder_id: "1AbCdEfGhIjKlMnOp" }, { formats: ["txt"] }]) {
      const problems = problemsOf([vault(extra)]);
      expect(problems.some((p) => p.includes("unknown key")), JSON.stringify(extra)).toBe(true);
    }
    const proto = JSON.parse(`[{"id":"v","kind":"obsidian","memory_space":"personal","path":"/knowledge/o","__proto__":{"polluted":true}}]`) as unknown;
    expect(problemsOf(proto).some((p) => p.includes("unknown key"))).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("påkrevde felt: kind, id, memory_space (kjent rom), og kildetypens eget påkrevde felt", () => {
    expect(problemsOf([{ id: "a", memory_space: "personal" }])).toContain("sources[0].kind: required");
    expect(problemsOf([{ kind: "obsidian", memory_space: "personal", path: "/knowledge/o" }])).toEqual(["sources[0].id: must match ^[a-z0-9][a-z0-9._:-]{0,62}$"]);
    for (const space of [undefined, "", "privat", "PERSONAL", 5, null, ["personal"]]) {
      expect(problemsOf([vault({ memory_space: space })]).some((p) => p.startsWith("sources[0].memory_space")), String(space)).toBe(true);
    }
    expect(problemsOf([{ id: "g", kind: "github", memory_space: "project" }])).toEqual(["sources[0].repo: required, must be owner/name"]);
    expect(problemsOf([{ id: "o", kind: "obsidian", memory_space: "project" }])[0]).toBe("sources[0].path: must be a non-empty string");
  });

  it("ugyldige tall (frist, intervall, grenser) og enum-verdier avvises", () => {
    for (const retention_days of [0, -1, 1.5, 3651, "30", null, Number.NaN]) {
      expect(problemsOf([vault({ retention_days })]).some((p) => p.startsWith("sources[0].retention_days")), String(retention_days)).toBe(true);
    }
    for (const sync_interval_minutes of [0, 14, 10_081, 60.5, "60"]) {
      expect(problemsOf([vault({ sync_interval_minutes })]).some((p) => p.startsWith("sources[0].sync_interval_minutes")), String(sync_interval_minutes)).toBe(true);
    }
    for (const bad of [{ max_files: 0 }, { max_files: 100_001 }, { max_file_bytes: 10 }, { max_depth: 65 }, { max_depth: 0 }]) {
      expect(problemsOf([vault(bad)]).length, JSON.stringify(bad)).toBe(1);
    }
    expect(parse([vault({ retention_days: 3650, sync_interval_minutes: 15 })])).toHaveLength(1);
  });
});

describe("D: sensitivitet - gulvet kan ikke ligge over taket, og ukjente verdier avvises", () => {
  it("default_sensitivity over max_sensitivity, ukjente nivåer og tillitsnivået trusted (finnes ikke) avvises", () => {
    expect(problemsOf([vault({ default_sensitivity: "special", max_sensitivity: "sensitive" })])).toEqual(["sources[0]: default_sensitivity_above_max_sensitivity"]);
    for (const bad of [{ default_sensitivity: "hemmelig" }, { max_sensitivity: "SPECIAL" }, { trust: "trusted" }, { trust: "" }, { default_sensitivity: 1 }]) {
      expect(problemsOf([vault(bad)]).length, JSON.stringify(bad)).toBe(1);
    }
    expect(parse([vault({ default_sensitivity: "sensitive", max_sensitivity: "sensitive" })])).toHaveLength(1);
  });
});

describe("E: id-er - unike per rom, ikke gjenbruk av det koden allerede eier", () => {
  it("duplikat-id i samme rom og reservert id avvises; samme id i et annet rom er lov", () => {
    expect(problemsOf([vault(), vault()])).toEqual(["sources[1].id: duplicate or reserved id in this memory space"]);
    expect(problemsOf([{ id: "email:inbox", kind: "email_attachment", memory_space: "personal" }], context({ reserved: [{ memory_space: "personal", id: "email:inbox" }] })))
      .toEqual(["sources[0].id: duplicate or reserved id in this memory space"]);
    expect(parse([vault(), vault({ memory_space: "business", path: "/knowledge/b" })])).toHaveLength(2);
    expect(parse([{ id: "email:inbox", kind: "email_attachment", memory_space: "business" }], context({ reserved: [{ memory_space: "personal", id: "email:inbox" }] }))).toHaveLength(1);
  });

  it("id-formatet: små bokstaver/sifre/._:-, 1-63 tegn; ingen skråstrek, blanke, store bokstaver eller sti-tegn", () => {
    for (const id of ["Vault", "a b", "a/b", "../x", "", "-start", "æøå", "x".repeat(64), 5, null]) {
      expect(problemsOf([vault({ id })]).some((p) => p.startsWith("sources[0].id")), String(id)).toBe(true);
    }
    for (const id of ["a", "vault.2", "docs:root", "x".repeat(63), "0notat"]) expect(parse([vault({ id })])).toHaveLength(1);
  });
});

describe("F: stier - absolutte, normaliserte, innenfor en allowlistet basemappe, aldri systemkataloger", () => {
  it("relative, ..-stier, ikke-normaliserte, NUL, hemmelighetskataloger og systemkataloger avvises", () => {
    const cases: Array<[unknown, string]> = [
      ["notater", "must be absolute"], ["./notater", "must be absolute"], ["/knowledge/../etc", "must not contain '..'"], ["/knowledge/a/../../etc", "must not contain '..'"],
      ["/knowledge//docs", "must be normalized"], ["/knowledge/./docs", "must be normalized"], ["/knowledge/doc\u0000s", "contains NUL"], ["", "must be a non-empty string"], [5, "must be a non-empty string"],
      [undefined, "must be a non-empty string"], [["/knowledge"], "must be a non-empty string"], ["/knowledge/.ssh/notater", "points into a secrets directory"], ["/knowledge/.aws", "points into a secrets directory"],
      ["/etc/passwd.d", "points into a system directory"], ["/proc/1", "points into a system directory"], ["/var/lib/docker/volumes", "points into a system directory"]
    ];
    for (const [path, problem] of cases) {
      expect(problemsOf([vault({ path })], context({ fs_roots: ["/knowledge", "/etc", "/proc"] })), JSON.stringify(path)).toEqual([`sources[0].path: ${problem}`]);
    }
  });

  it("utenfor allowlisten avvises - også en søskenmappe med samme tekstprefiks - og uten noen allowlist avvises alle filsystemkilder", () => {
    for (const path of ["/data/notater", "/knowledge-evil", "/knowledgeX/docs", "/", "/home/tobias"]) {
      expect(problemsOf([vault({ path })]).some((p) => p.includes("outside every allowlisted base directory") || p.includes("system directory") || p.includes("normalized")), path).toBe(true);
    }
    for (const kind of ["obsidian", "filesystem", "meeting_transcript"]) {
      expect(problemsOf([{ id: "x", kind, memory_space: "personal", path: "/knowledge/x" }], context({ fs_roots: [] }))).toEqual(["sources[0].path: no allowlisted base directory is configured (JARVIS_KNOWLEDGE_FS_ROOTS)"]);
    }
    // Selve basemappen og alt under den er lov; avsluttende skråstrek fjernes.
    expect(parse([vault({ path: "/knowledge" }), vault({ id: "v2", path: "/knowledge/a/b/" })]).map((s) => (s.config as { vault_root: string }).vault_root)).toEqual(["/knowledge", "/knowledge/a/b"]);
  });

  it("filsystem-extensions må være en delmengde av tekstendelsene; formater må være kjente transkriptformater", () => {
    for (const extensions of [[], [".exe"], [".env"], ["md"], "md", [".md", 5], Array.from({ length: 21 }, () => ".md")]) {
      expect(problemsOf([{ id: "f", kind: "filesystem", memory_space: "project", path: "/knowledge/f", extensions }]).some((p) => p.includes("extensions")), JSON.stringify(extensions)).toBe(true);
    }
    for (const formats of [[], ["docx"], "vtt", ["vtt", 1]]) {
      expect(problemsOf([{ id: "m", kind: "meeting_transcript", memory_space: "business", path: "/knowledge/m", formats }]).some((p) => p.includes("formats")), JSON.stringify(formats)).toBe(true);
    }
  });
});

describe("G: GitHub er låst til JARVIS_GITHUB_REPO", () => {
  it("samme repo (uavhengig av store/små bokstaver) er lov; et annet repo og ugyldige slugs avvises; åpnet lås tillater andre repo", () => {
    expect(parse([{ id: "g", kind: "github", memory_space: "project", repo: "tsworkflow/jarvisbuild" }])).toHaveLength(1);
    expect(problemsOf([{ id: "g", kind: "github", memory_space: "project", repo: "angriper/ondsinnet" }])).toEqual([
      "sources[0].repo: is locked to JARVIS_GITHUB_REPO (open other repos with JARVIS_GITHUB_ALLOW_OTHER_REPOS=true)"
    ]);
    for (const repo of ["jarvisbuild", "a/b/c", "https://github.com/a/b", "a/b c", "../x", "", 5, null]) {
      expect(problemsOf([{ id: "g", kind: "github", memory_space: "project", repo }]).length, String(repo)).toBe(1);
    }
    expect(parse([{ id: "g", kind: "github", memory_space: "project", repo: "annen/repo" }], context({ github_unlocked: true }))).toHaveLength(1);
    expect(problemsOf([{ id: "g", kind: "github", memory_space: "project", repo: "a/b c" }], context({ github_unlocked: true })).length).toBe(1);
  });
});

describe("H: Drive krever en eksplisitt mappe eller et bevisst valg av hele disken", () => {
  it("ingen scope, begge scope, whole_drive: false og ugyldig mappe-id avvises", () => {
    expect(problemsOf([{ id: "d", kind: "drive", memory_space: "personal" }])).toEqual(["sources[0].folder_id: required (or whole_drive: true), must be a Drive folder id"]);
    expect(problemsOf([drive({ whole_drive: true })])).toEqual(["sources[0]: folder_id and whole_drive are mutually exclusive"]);
    expect(problemsOf([{ id: "d", kind: "drive", memory_space: "personal", whole_drive: false }]).some((p) => p.includes("whole_drive: may only be true"))).toBe(true);
    for (const folder_id of ["kort", "1AbC/../x", "1AbCdEfGhIjKl MnOp", "x".repeat(101), 5, null]) {
      expect(problemsOf([drive({ folder_id })]).some((p) => p.includes("folder_id")), String(folder_id)).toBe(true);
    }
    expect(problemsOf([drive({ sheets: "alle" })]).length).toBe(1);
    expect(problemsOf([drive({ max_sheet_rows: 20_001 })]).length).toBe(1);
  });
});

describe("I: e-postvedlegg", () => {
  it("søkespørringen må være kort og på én linje; max har grenser", () => {
    for (const query of ["", "a".repeat(201), "to\nlinjer", "kontroll\u0001tegn", 5]) {
      expect(problemsOf([{ id: "e", kind: "email_attachment", memory_space: "personal", query }]).length, JSON.stringify(query)).toBe(1);
    }
    for (const max of [0, 101, 1.5, "10"]) expect(problemsOf([{ id: "e", kind: "email_attachment", memory_space: "personal", max }]).length, String(max)).toBe(1);
  });
});

describe("J: parseFilesystemRoots (JARVIS_KNOWLEDGE_FS_ROOTS)", () => {
  it("utelatt/tom gir ingen basemapper; gyldige trimmes og dedupes; ugyldig liste avvises HELT", () => {
    expect(parseFilesystemRoots(undefined)).toEqual([]);
    expect(parseFilesystemRoots("  ")).toEqual([]);
    expect(parseFilesystemRoots("/knowledge, /mnt/nas/notater/ ,/knowledge")).toEqual(["/knowledge", "/mnt/nas/notater"]);
    for (const raw of ["/", "/etc", "/var", "/usr/local", "/proc/1", "relativ", "/knowledge/../etc", "/knowledge,/", "/knowledge,,/mnt/a", "/knowledge//a", "/root", "/home/tobias/.ssh"]) {
      expect(() => parseFilesystemRoots(raw), raw).toThrow(KnowledgeSourcesConfigError);
    }
    // /home og /tmp er ikke systemkataloger (en NAS-/bruker-montering kan ligge der).
    expect(parseFilesystemRoots("/home/tobias/notater,/tmp/kunnskap")).toEqual(["/home/tobias/notater", "/tmp/kunnskap"]);
  });

  it("isPathInside sammenligner stiledd, ikke tekstprefiks", () => {
    expect(isPathInside("/knowledge", "/knowledge")).toBe(true);
    expect(isPathInside("/knowledge", "/knowledge/a/b")).toBe(true);
    expect(isPathInside("/knowledge", "/knowledge-evil")).toBe(false);
    expect(isPathInside("/knowledge", "/knowledgeX")).toBe(false);
    expect(isPathInside("/knowledge", "/")).toBe(false);
    expect(isPathInside("/knowledge", "/knowledge/..notat")).toBe(true);
    expect(isPathInside("/knowledge/a", "/knowledge")).toBe(false);
  });
});

describe("K: verifyFilesystemRoot - den SANNE roten må ligge innenfor en SANN basemappe (symlinker følges)", () => {
  let base: string;
  let outside: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "jarvis-wpd1-cfg-base-"));
    outside = await mkdtemp(join(tmpdir(), "jarvis-wpd1-cfg-out-"));
    await mkdir(join(base, "notater"), { recursive: true });
    await writeFile(join(outside, "hemmelig.md"), "utenfor");
  });

  it("en vanlig mappe under basen er OK; selve basen er OK", async () => {
    expect(await verifyFilesystemRoot(join(base, "notater"), [base])).toBeNull();
    expect(await verifyFilesystemRoot(base, [base])).toBeNull();
  });

  it("en rot som er (blitt) en symlink UT av allowlisten avvises, selv om stien ser ut til å ligge innenfor", async () => {
    try {
      await symlink(outside, join(base, "lenke"));
    } catch {
      return; // ingen symlink-rettigheter i dette miljøet
    }
    expect(await verifyFilesystemRoot(join(base, "lenke"), [base])).toBe("root_outside_allowlist");
  });

  it("manglende rot, manglende basemappe, tom allowlist og en annen basemappe gir en kort årsakskode (ingen synk)", async () => {
    expect(await verifyFilesystemRoot(join(base, "finnes-ikke"), [base])).toBe("root_unreadable");
    expect(await verifyFilesystemRoot(join(base, "notater"), [join(base, "finnes-ikke")])).toBe("root_outside_allowlist");
    expect(await verifyFilesystemRoot(join(base, "notater"), [])).toBe("no_allowlisted_roots");
    expect(await verifyFilesystemRoot(join(base, "notater"), [outside])).toBe("root_outside_allowlist");
  });
});
