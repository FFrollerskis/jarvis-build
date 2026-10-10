import type { JsonValue } from "@jarvis/contracts";
import { FilesystemKnowledgeSource, type WalkLimits } from "./filesystem-source.ts";
import type { KnowledgeListResult, KnowledgeRecord, KnowledgeSource } from "./source.ts";

const OBSIDIAN_INTERNAL_PREFIX = ".obsidian/";
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([".md"]);
const WIKI_LINK_PATTERN = /\[\[([^[\]]+)\]\]/g;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Best-effort, FLAT frontmatter-parsing - `key: value`, `key: [a, b, c]`,
 * tall/boolean/streng. Bevisst IKKE en generell YAML-parser (ingen ny
 * avhengighet, ingen risiko for å mistolke nøstede strukturer/ankere) - en
 * linje som ikke matcher det enkle mønsteret hoppes stille over. Verdiene
 * ender KUN som inert JSON-metadata; ALDRI tolket som instruksjoner/config
 * noe sted i pipelinen.
 */
function parseFrontmatter(raw: string): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key) continue;
    const value = (rawValue ?? "").trim();
    if (value === "") {
      result[key] = "";
    } else if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter((v) => v.length > 0);
    } else if (value === "true" || value === "false") {
      result[key] = value === "true";
    } else if (!Number.isNaN(Number(value)) && value !== "") {
      result[key] = Number(value);
    } else {
      result[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

/** `[[Notat]]`, `[[Notat|Visningstekst]]`, `[[Notat#Overskrift]]` -> `["Notat", ...]`. Deduplisert, rekkefølge bevart. */
function extractWikiLinks(body: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(WIKI_LINK_PATTERN)) {
    const target = (match[1] ?? "").split("|")[0]?.split("#")[0]?.trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      links.push(target);
    }
  }
  return links;
}

/**
 * UA-2 P1A §19/§26: Obsidian/lokal vault som kunnskapskilde. KOMPONERER
 * (ikke arver) rundt `FilesystemKnowledgeSource` - samme sikkerhetsgrunnmur
 * som UA-2 P0 (allowlistet rot, `..`-traversal og symlink-escape behandlet
 * identisk, se `assertWithinRoot()`), utvidet med vault-bevissthet:
 *
 * - KUN `.md`-filer (Obsidian-notater), ikke P0-defaultens brede filtypeliste.
 * - `.obsidian/` (Obsidian sin interne plugin-/tema-konfigurasjon) er
 *   EKSKLUDERT fra ingestion som default - dette er verktøykonfig, ikke
 *   notat-innhold, og skal ALDRI havne i kunnskapsbasen.
 * - `external_id` = relativ vault-sti (SAMME presedens som
 *   `FilesystemKnowledgeSource` - IKKE en stabil note-id). En omdøpning i
 *   Obsidian behandles derfor som slett+ny, IKKE en oppdatering - dokumentert
 *   bevisst valg (Obsidian har ingen stabil fil-id slik Drive har).
 * - Frontmatter (YAML-blokk øverst i filen) parses best-effort til
 *   `metadata.frontmatter` (flate nøkkel/verdi-par - IKKE generell YAML).
 *   Selve `content`-feltet beholder HELE filen uendret (frontmatter + body)
 *   - markdown-strukturen bevares, ingenting strippes bort.
 * - Wiki-lenker (`[[Notat]]`) trekkes ut til `metadata.wiki_links` som en
 *   FLAT liste navn på DENNE filen - IKKE en graf, IKKE GraphRAG. Dette er
 *   bevisst utenfor P1A-scope (se byggeordren).
 */
export class ObsidianVaultKnowledgeSource implements KnowledgeSource {
  readonly source_type = "obsidian";
  readonly source_instance_id: string;
  private readonly inner: FilesystemKnowledgeSource;

  constructor(vaultRoot: string, sourceInstanceId?: string, limits?: Partial<WalkLimits>) {
    const instanceId = sourceInstanceId ?? `obsidian:${vaultRoot}`;
    this.source_instance_id = instanceId;
    this.inner = new FilesystemKnowledgeSource(vaultRoot, instanceId, { allowedExtensions: MARKDOWN_EXTENSIONS, ...(limits ? { limits } : {}) });
  }

  async list(): Promise<KnowledgeListResult> {
    const { records, skipped, listing, protected_prefixes } = await this.inner.list();
    const filtered: KnowledgeRecord[] = [];
    for (const record of records) {
      if (record.external_id === ".obsidian" || record.external_id.startsWith(OBSIDIAN_INTERNAL_PREFIX)) {
        continue; // intern verktøykonfig - aldri notat-innhold, aldri en del av kunnskapsbasen
      }
      const frontmatterMatch = FRONTMATTER_PATTERN.exec(record.content);
      const frontmatter = frontmatterMatch?.[1] ? parseFrontmatter(frontmatterMatch[1]) : {};
      const body = frontmatterMatch ? record.content.slice(frontmatterMatch[0].length) : record.content;
      filtered.push({
        ...record,
        source_type: this.source_type,
        source_instance_id: this.source_instance_id,
        metadata: {
          ...record.metadata,
          frontmatter: frontmatter as unknown as JsonValue,
          wiki_links: extractWikiLinks(body)
        }
      });
    }
    return { records: filtered, skipped, ...(listing ? { listing } : {}), ...(protected_prefixes ? { protected_prefixes } : {}) };
  }
}
