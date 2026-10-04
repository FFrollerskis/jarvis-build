import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { assertLocalEmbedding, type EmbeddingProvider } from "./embedding.ts";
import { estimateTokens, orTsQuery, queryTerms } from "./query-terms.ts";
import { withMemoryTransaction } from "./spaces.ts";
import { hasPgVector, similaritySql, vectorArg } from "./vectors.ts";

export interface RetrievedVersion {
  version: number;
  content: string;
  valid_from: string;
  valid_to: string;
}

export type RetrievedKind = "item" | "episode" | "summary";

export interface RetrievedItem {
  /** For `kind: "item"` er dette memory_item_id; for episoder/sammendrag deres egen id. */
  memory_item_id: string;
  kind: RetrievedKind;
  subject: string;
  content: string;
  type: string;
  space: string;
  score: number;
  valid_from: string;
  valid_to: string | null;
  has_conflict: boolean;
  importance: number;
  observed_at: string;
  keywords: string[];
  /** `normal` | `sensitive` | `special` når laget bærer kolonnen (items/episoder); udefinert for sammendrag. */
  sensitivity?: string;
  source: { kind: string; ref: string; trust_level: string };
  versions?: RetrievedVersion[];
  via?: "search" | "relation" | "link";
}

export interface SearchOptions {
  spaces: MemorySpace[];
  query: string;
  /** Tidsreferanse: «hva var sant da» - filtrerer på valid_from/valid_to og søker versjoner. */
  timeref?: Date;
  limit?: number;
  /** D-386: hvilke lag som søkes. Standard: alle tre. */
  kinds?: RetrievedKind[];
  /** D-386: oppdater `last_accessed_at`/`access_count` på items som returneres (standard: ja). */
  touch?: boolean;
}

export interface ContextOptions {
  /** D-384: laveste score for at strengt minne (helse/special) regnes som direkte treff. */
  restrictedMinScore?: number;
  /** D-386: tokenbudsjett for hele minneblokken (profil + treff). */
  budgetTokens?: number;
}

export interface ContextResult {
  text: string;
  spaces: string[];
  sensitivities: string[];
  withheld_restricted: number;
  profile_included: boolean;
  item_count: number;
}

/** D-384: laveste normaliserte score for at strengt minne (helse/special) regnes som et direkte treff på eierens melding. */
export const RESTRICTED_MEMORY_MIN_SCORE = 0.3;
/** D-386: standard tokenbudsjett for minneblokken i chat. Tale bruker et lavere budsjett (se conversation.ts). */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 1200;
const PROFILE_MAX_TOKENS = 400;
const RRF_K = 60;
const RECENCY_HALF_LIFE_DAYS = 90;
const LEG_LIMIT = 40;

const TYPE_LABEL: Readonly<Record<string, string>> = {
  semantic: "fakta", episodic: "hendelse", preference: "preferanse", procedure: "rutine", relation: "relasjon",
  project: "prosjekt", operational: "praktisk", decision: "beslutning", commitment: "forpliktelse", insight: "innsikt"
};

interface Scored extends RetrievedItem {
  rrf: number;
  last_accessed_at: string | null;
}

function isoDate(value: string | Date): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}

function isoMinute(value: string | Date): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Context Builder v2 / hybrid retrieval (MEMORY_ARCHITECTURE §7, D-386):
 *   fulltekst (ELLER-termer, stemmet norsk + eksakte nøkkelord) + vektor (modellbevisst, lokal) over TRE lag
 *   (faktaminner, verbatim episoder, sammendrag) → reciprocal-rank-fusjon → viktighet × ferskhet → relasjons-/
 *   lenkeutvidelse (1 hopp) → tid → versjoner ved motstrid. Alt under tenant- OG space-RLS; karantene og
 *   invaliderte rader er aldri med. Items som returneres får `last_accessed_at` oppdatert (ting eieren vender
 *   tilbake til holder seg «varme»).
 */
export class MemoryRetriever {
  constructor(
    private readonly pool: pg.Pool,
    private readonly embeddings: EmbeddingProvider
  ) {
    assertLocalEmbedding(embeddings);
  }

  /** Spørringsvektor - en feil i embedding-tjenesten (f.eks. Ollama nede) skal aldri velte søket; da brukes kun fulltekst. */
  private async queryVector(text: string): Promise<number[] | undefined> {
    try {
      return await this.embeddings.embed(text);
    } catch (err) {
      console.error(JSON.stringify({ msg: "memory_query_embedding_failed", model: this.embeddings.model, error: (err as Error).message.slice(0, 200) }));
      return undefined;
    }
  }

  async search(identity: IdentityContext, options: SearchOptions): Promise<RetrievedItem[]> {
    const limit = options.limit ?? 8;
    const kinds = new Set<RetrievedKind>(options.kinds ?? ["item", "episode", "summary"]);
    const terms = queryTerms(options.query);
    const tsq = orTsQuery(terms);
    const queryVector = await this.queryVector(options.query);
    return withMemoryTransaction(this.pool, identity.tenant_id, options.spaces, async (client) => {
      const timeref = options.timeref ?? null;
      const pgv = await hasPgVector(client, this.pool);
      const byId = new Map<string, Scored>();
      const legs: string[][] = [];

      const upsert = (row: Record<string, unknown>, kind: RetrievedKind): string => {
        const id = String(row["id"]);
        if (!byId.has(id)) {
          byId.set(id, {
            memory_item_id: id,
            kind,
            subject: String(row["subject"] ?? ""),
            content: String(row["content"]),
            type: String(row["type"] ?? kind),
            space: String(row["space"]),
            valid_from: String(row["valid_from"] ?? row["observed_at"]),
            valid_to: row["valid_to"] ? String(row["valid_to"]) : null,
            has_conflict: Boolean(row["has_conflict"] ?? false),
            importance: Number(row["importance"] ?? (kind === "item" ? 5 : kind === "summary" ? 4 : 3)),
            observed_at: String(row["observed_at"]),
            keywords: Array.isArray(row["keywords"]) ? (row["keywords"] as string[]) : [],
            ...(row["sensitivity"] ? { sensitivity: String(row["sensitivity"]) } : {}),
            last_accessed_at: row["last_accessed_at"] ? String(row["last_accessed_at"]) : null,
            source: {
              kind: String(row["source_kind"] ?? kind),
              ref: String(row["source_ref"] ?? ""),
              trust_level: String(row["trust_level"] ?? "internal")
            },
            score: 0,
            rrf: 0,
            via: "search"
          });
        }
        return id;
      };

      // ---- Lag 1: faktaminner (memory_items) ----
      if (kinds.has("item")) {
        if (tsq) {
          const fts = await client.query(
            `SELECT m.memory_item_id AS id, m.subject, m.content, m.type, m.space, m.valid_from, m.valid_to, m.has_conflict,
                    m.observed_at, m.importance, m.keywords, m.last_accessed_at, m.trust_level, m.sensitivity,
                    s.kind AS source_kind, s.ref AS source_ref,
                    ts_rank_cd(m.fts, to_tsquery('norwegian', $1)) + 0.5 * ts_rank(m.keywords_fts, to_tsquery('simple', $1)) AS rank
               FROM memory_items m JOIN memory_sources s ON s.source_id = m.source_id
              WHERE m.status = 'active'
                AND ($2::timestamptz IS NULL OR (m.valid_from <= $2 AND (m.valid_to IS NULL OR m.valid_to > $2)))
                AND (m.fts @@ to_tsquery('norwegian', $1) OR m.keywords_fts @@ to_tsquery('simple', $1))
              ORDER BY rank DESC LIMIT ${LEG_LIMIT}`,
            [tsq, timeref]
          );
          legs.push(fts.rows.map((r) => upsert(r as Record<string, unknown>, "item")));
        }
        if (queryVector) {
          const sim = similaritySql(this.embeddings, pgv, "$1");
          const vec = await client.query(
            `SELECT m.memory_item_id AS id, m.subject, m.content, m.type, m.space, m.valid_from, m.valid_to, m.has_conflict,
                    m.observed_at, m.importance, m.keywords, m.last_accessed_at, m.trust_level, m.sensitivity,
                    s.kind AS source_kind, s.ref AS source_ref, ${sim} AS sim
               FROM memory_vectors v
               JOIN memory_items m ON m.memory_item_id = v.ref_id
               JOIN memory_sources s ON s.source_id = m.source_id
              WHERE v.ref_kind = 'item' AND v.model = $2 AND v.dim = $3 AND m.status = 'active'
                AND ($4::timestamptz IS NULL OR (m.valid_from <= $4 AND (m.valid_to IS NULL OR m.valid_to > $4)))
                AND ${sim} >= $5
              ORDER BY sim DESC LIMIT ${LEG_LIMIT}`,
            [vectorArg(pgv, queryVector), this.embeddings.model, this.embeddings.dim, timeref, this.embeddings.minSimilarity]
          );
          legs.push(vec.rows.map((r) => upsert(r as Record<string, unknown>, "item")));
        }
      }

      // ---- Lag 2: verbatim episoder (memory_episodes) ----
      if (kinds.has("episode")) {
        if (tsq) {
          const fts = await client.query(
            `SELECT e.episode_id AS id, '' AS subject, e.content, 'episode' AS type, e.space, e.observed_at AS valid_from,
                    NULL::timestamptz AS valid_to, false AS has_conflict, e.observed_at, e.trust_level, e.sensitivity,
                    'conversation' AS source_kind, e.session_id AS source_ref,
                    ts_rank_cd(e.fts, to_tsquery('norwegian', $1)) AS rank
               FROM memory_episodes e
              WHERE e.status = 'active' AND e.fts @@ to_tsquery('norwegian', $1)
                AND ($2::timestamptz IS NULL OR e.observed_at <= $2)
              ORDER BY rank DESC LIMIT ${LEG_LIMIT}`,
            [tsq, timeref]
          );
          legs.push(fts.rows.map((r) => upsert(r as Record<string, unknown>, "episode")));
        }
        if (queryVector) {
          const sim = similaritySql(this.embeddings, pgv, "$1");
          const vec = await client.query(
            `SELECT e.episode_id AS id, '' AS subject, e.content, 'episode' AS type, e.space, e.observed_at AS valid_from,
                    NULL::timestamptz AS valid_to, false AS has_conflict, e.observed_at, e.trust_level, e.sensitivity,
                    'conversation' AS source_kind, e.session_id AS source_ref, ${sim} AS sim
               FROM memory_vectors v JOIN memory_episodes e ON e.episode_id = v.ref_id
              WHERE v.ref_kind = 'episode' AND v.model = $2 AND v.dim = $3 AND e.status = 'active'
                AND ($4::timestamptz IS NULL OR e.observed_at <= $4)
                AND ${sim} >= $5
              ORDER BY sim DESC LIMIT ${LEG_LIMIT}`,
            [vectorArg(pgv, queryVector), this.embeddings.model, this.embeddings.dim, timeref, this.embeddings.minSimilarity]
          );
          legs.push(vec.rows.map((r) => upsert(r as Record<string, unknown>, "episode")));
        }
      }

      // ---- Lag 6: sammendrag (summaries) - endelig lesbare (D-386) ----
      if (kinds.has("summary")) {
        if (tsq) {
          const fts = await client.query(
            `SELECT s.summary_id AS id, s.scope || ':' || s.scope_key AS subject, s.content, 'summary' AS type, s.space,
                    s.created_at AS valid_from, NULL::timestamptz AS valid_to, false AS has_conflict, s.created_at AS observed_at,
                    'internal' AS trust_level, 'summary' AS source_kind, s.scope_key AS source_ref,
                    ts_rank_cd(s.fts, to_tsquery('norwegian', $1)) AS rank
               FROM summaries s
              WHERE s.fts @@ to_tsquery('norwegian', $1)
              ORDER BY rank DESC LIMIT 10`,
            [tsq]
          );
          legs.push(fts.rows.map((r) => upsert(r as Record<string, unknown>, "summary")));
        }
        if (queryVector) {
          const sim = similaritySql(this.embeddings, pgv, "$1");
          const vec = await client.query(
            `SELECT s.summary_id AS id, s.scope || ':' || s.scope_key AS subject, s.content, 'summary' AS type, s.space,
                    s.created_at AS valid_from, NULL::timestamptz AS valid_to, false AS has_conflict, s.created_at AS observed_at,
                    'internal' AS trust_level, 'summary' AS source_kind, s.scope_key AS source_ref, ${sim} AS sim
               FROM memory_vectors v JOIN summaries s ON s.summary_id = v.ref_id
              WHERE v.ref_kind = 'summary' AND v.model = $2 AND v.dim = $3 AND ${sim} >= $4
              ORDER BY sim DESC LIMIT 10`,
            [vectorArg(pgv, queryVector), this.embeddings.model, this.embeddings.dim, this.embeddings.minSimilarity]
          );
          legs.push(vec.rows.map((r) => upsert(r as Record<string, unknown>, "summary")));
        }
      }

      // ---- Fusjon: reciprocal rank fusion (robust mot ulike skalaer i ts_rank/cosinus) ----
      for (const leg of legs) {
        leg.forEach((id, index) => {
          const entry = byId.get(id);
          if (entry) entry.rrf += 1 / (RRF_K + index + 1);
        });
      }
      const maxRrf = Math.max(1e-9, ...[...byId.values()].map((e) => e.rrf));
      const now = Date.now();
      for (const entry of byId.values()) {
        const relevance = entry.rrf / maxRrf;
        const anchor = new Date(entry.last_accessed_at ?? entry.observed_at).getTime();
        const ageDays = Math.max(0, (now - anchor) / 86_400_000);
        const recency = Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
        const trustBonus = entry.source.trust_level === "trusted" ? 0.05 : 0;
        entry.score = 0.6 * relevance + 0.2 * recency + 0.2 * (entry.importance / 10) + trustBonus;
      }
      let ranked: Scored[] = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);

      // ---- Relasjons- og lenkeutvidelse (1 hopp): items som deler entiteter eller er lenket til topptreffene ----
      const topItemIds = ranked.filter((r) => r.kind === "item").slice(0, 3).map((r) => r.memory_item_id);
      if (topItemIds.length > 0 && kinds.has("item")) {
        const related = await client.query(
          `SELECT DISTINCT m.memory_item_id AS id, m.subject, m.content, m.type, m.space, m.valid_from, m.valid_to,
                  m.has_conflict, m.observed_at, m.importance, m.keywords, m.last_accessed_at, m.trust_level,
                  s.kind AS source_kind, s.ref AS source_ref, x.via
             FROM (
               SELECT me2.memory_item_id, 'relation'::text AS via
                 FROM memory_item_entities me1
                 JOIN relations r ON (r.from_entity = me1.entity_id OR r.to_entity = me1.entity_id)
                 JOIN memory_item_entities me2
                   ON me2.entity_id IN (r.from_entity, r.to_entity) AND me2.memory_item_id <> me1.memory_item_id
                WHERE me1.memory_item_id = ANY($1)
               UNION
               SELECT me2.memory_item_id, 'relation'::text
                 FROM memory_item_entities me1
                 JOIN memory_item_entities me2 ON me2.entity_id = me1.entity_id AND me2.memory_item_id <> me1.memory_item_id
                WHERE me1.memory_item_id = ANY($1)
               UNION
               SELECT l.to_item_id, 'link'::text FROM memory_links l WHERE l.from_item_id = ANY($1)
               UNION
               SELECT l.from_item_id, 'link'::text FROM memory_links l WHERE l.to_item_id = ANY($1)
             ) x
             JOIN memory_items m ON m.memory_item_id = x.memory_item_id AND m.status = 'active'
             JOIN memory_sources s ON s.source_id = m.source_id
            LIMIT 6`,
          [topItemIds]
        );
        for (const row of related.rows as Array<Record<string, unknown>>) {
          const id = String(row["id"]);
          if (!byId.has(id) && ranked.length < limit + 3) {
            upsert(row, "item");
            const entry = byId.get(id) as Scored;
            entry.score = 0.15;
            entry.via = row["via"] === "link" ? "link" : "relation";
            ranked.push(entry);
          }
        }
      }

      // ---- Tidssøk: historiske versjoner som var gyldige på tidspunktet, med EKTE proveniens fra item/kilde (JARVIS-077) ----
      if (options.timeref && tsq && kinds.has("item")) {
        const versions = await client.query(
          `SELECT v.memory_item_id, v.version, v.subject, v.content, v.valid_from, v.valid_to,
                  m.type, m.space, m.importance, m.observed_at, m.trust_level, s.kind AS source_kind, s.ref AS source_ref
             FROM memory_versions v
             JOIN memory_items m ON m.memory_item_id = v.memory_item_id
             JOIN memory_sources s ON s.source_id = m.source_id
            WHERE v.valid_from <= $1 AND v.valid_to > $1
              AND to_tsvector('norwegian', v.subject || ' ' || v.content) @@ to_tsquery('norwegian', $2)
            LIMIT 10`,
          [options.timeref, tsq]
        );
        for (const row of versions.rows as Array<Record<string, unknown>>) {
          ranked.push({
            memory_item_id: String(row["memory_item_id"]),
            kind: "item",
            subject: String(row["subject"]),
            content: String(row["content"]),
            type: String(row["type"]),
            space: String(row["space"]),
            valid_from: String(row["valid_from"]),
            valid_to: String(row["valid_to"]),
            has_conflict: true,
            importance: Number(row["importance"] ?? 5),
            observed_at: String(row["observed_at"]),
            keywords: [],
            last_accessed_at: null,
            source: { kind: String(row["source_kind"]), ref: `${String(row["source_ref"])} (v${String(row["version"])})`, trust_level: String(row["trust_level"]) },
            score: 0.5,
            rrf: 0,
            via: "search"
          });
        }
        ranked = ranked.sort((a, b) => b.score - a.score);
      }

      // ---- Motstrid: legg ved alle versjoner slik at begge sider er synlige (én spørring, ikke N+1) ----
      const conflictIds = ranked.filter((r) => r.kind === "item" && r.has_conflict && r.via !== undefined).map((r) => r.memory_item_id);
      if (conflictIds.length > 0) {
        const versions = await client.query(
          `SELECT memory_item_id, version, content, valid_from, valid_to FROM memory_versions
            WHERE memory_item_id = ANY($1) ORDER BY memory_item_id, version`,
          [conflictIds]
        );
        const grouped = new Map<string, RetrievedVersion[]>();
        for (const row of versions.rows as Array<RetrievedVersion & { memory_item_id: string }>) {
          const list = grouped.get(row.memory_item_id) ?? [];
          list.push({ version: row.version, content: row.content, valid_from: String(row.valid_from), valid_to: String(row.valid_to) });
          grouped.set(row.memory_item_id, list);
        }
        for (const item of ranked) {
          const list = grouped.get(item.memory_item_id);
          if (list && list.length > 0) item.versions = list;
        }
      }

      // ---- Sist brukt: ting eieren vender tilbake til holder seg varme (Generative Agents-mønsteret) ----
      const touched = ranked.filter((r) => r.kind === "item").map((r) => r.memory_item_id);
      if (options.touch !== false && touched.length > 0) {
        await client.query(
          "UPDATE memory_items SET last_accessed_at = now(), access_count = access_count + 1 WHERE memory_item_id = ANY($1)",
          [touched]
        );
      }

      return ranked.map((entry) => {
        const { rrf: _rrf, last_accessed_at: _la, ...item } = entry;
        void _rrf; void _la;
        return item;
      });
    });
  }

  /** Kompakt kontekstblokk med kildeangivelse for Conversation Engine. */
  async contextFor(identity: IdentityContext, userText: string): Promise<string> {
    return (await this.contextWithMeta(identity, userText)).text;
  }

  /**
   * Del 3 (JARVIS-016/035) + D-384 + D-386: kontekstblokken modellen får, med metadata om HVA som ble hentet (rom og
   * `sensitivity`) slik at ruteren kan utlede sensitivitet fra innholdet. Blokken fylles etter TOKENBUDSJETT, ikke et
   * fast antall: først den kompilerte eierprofilen (alltid, når den finnes), så kommende forpliktelser, så treffene i
   * rangert rekkefølge. Strengt minne (helse/special) tas KUN med ved et direkte treff (via=search, score ≥ terskel) -
   * svake treff og utvidelser holdes helt utenfor (sendes til ingen modell) i stedet for å låse turen til lokal modell.
   */
  async contextWithMeta(identity: IdentityContext, userText: string, options: ContextOptions = {}): Promise<ContextResult> {
    const budget = options.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
    const minScore = options.restrictedMinScore ?? RESTRICTED_MEMORY_MIN_SCORE;
    const space = identity.memory_space_id;
    const items = await this.search(identity, { spaces: [space], query: userText, limit: 12 });

    const { profile, upcoming, sensitivityById } = await withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) => {
      const prof = await client.query("SELECT content FROM memory_profiles WHERE tenant_id = $1 AND space = $2", [identity.tenant_id, space]);
      const up = await client.query(
        `SELECT memory_item_id, content, valid_from, type FROM memory_items
          WHERE tenant_id = $1 AND space = $2 AND status = 'active' AND type IN ('commitment', 'decision')
            AND valid_from > now() AND valid_from < now() + interval '14 days'
          ORDER BY valid_from ASC LIMIT 5`,
        [identity.tenant_id, space]
      );
      const ids = items.filter((i) => i.kind === "item").map((i) => i.memory_item_id);
      const sens = ids.length === 0
        ? { rows: [] as Array<{ memory_item_id: string; sensitivity: string }> }
        : await client.query("SELECT memory_item_id, sensitivity FROM memory_items WHERE memory_item_id = ANY($1)", [ids]);
      return {
        profile: (prof.rows[0] as { content: string } | undefined)?.content ?? "",
        upcoming: up.rows as Array<{ memory_item_id: string; content: string; valid_from: Date; type: string }>,
        sensitivityById: new Map((sens.rows as Array<{ memory_item_id: string; sensitivity: string }>).map((r) => [r.memory_item_id, r.sensitivity]))
      };
    });

    // D-384-regelen, uendret i ånd: helse-rom eller special KUN ved direkte treff. Episoder i helse-rommet følger samme regel.
    const isRestricted = (item: RetrievedItem): boolean =>
      item.space === "health" || (sensitivityById.get(item.memory_item_id) ?? item.sensitivity) === "special";
    const kept = items.filter((item) => !isRestricted(item) || (item.via === "search" && item.score >= minScore));
    const withheld = items.length - kept.length;

    const lines: string[] = [];
    let used = 0;
    const push = (line: string): boolean => {
      const cost = estimateTokens(line);
      if (used + cost > budget) return false;
      lines.push(line);
      used += cost;
      return true;
    };

    let profileIncluded = false;
    if (profile) {
      const trimmed = estimateTokens(profile) > PROFILE_MAX_TOKENS ? `${profile.slice(0, Math.floor(PROFILE_MAX_TOKENS * 3.5))}…` : profile;
      profileIncluded = push(`Profil (det Jarvis vet om eieren, kompilert fra bekreftede minner):\n${trimmed}`);
    }
    for (const u of upcoming) {
      if (!kept.some((k) => k.memory_item_id === u.memory_item_id)) {
        push(`- [kommende ${TYPE_LABEL[u.type] ?? u.type} · ${isoDate(u.valid_from)}] ${u.content}`);
      }
    }
    const hitLines: string[] = [];
    for (const item of kept) {
      const line = this.renderLine(item);
      const cost = estimateTokens(line);
      if (used + cost > budget) break;
      hitLines.push(line);
      used += cost;
    }
    const spaces = [...new Set(kept.map((i) => i.space))];
    const sensitivities = [...new Set(kept.filter((i) => i.kind !== "summary").map((i) => sensitivityById.get(i.memory_item_id) ?? i.sensitivity ?? "normal"))];
    if (lines.length === 0 && hitLines.length === 0) {
      return { text: "", spaces: [], sensitivities: [], withheld_restricted: withheld, profile_included: false, item_count: 0 };
    }
    const header = hitLines.length > 0 ? `Relevant minne (med kilde):\n${hitLines.join("\n")}` : "";
    const text = [lines.join("\n"), header].filter((s) => s.length > 0).join("\n\n");
    return {
      text,
      spaces: profileIncluded && spaces.length === 0 ? [space] : spaces,
      sensitivities,
      withheld_restricted: withheld,
      profile_included: profileIncluded,
      item_count: hitLines.length
    };
  }

  private renderLine(item: RetrievedItem): string {
    if (item.kind === "episode") {
      return `- [du sa · ${isoMinute(item.observed_at)}] «${item.content.slice(0, 240)}» [kilde: conversation:${item.source.ref}]`;
    }
    if (item.kind === "summary") {
      return `- [sammendrag · ${item.subject}] ${item.content.slice(0, 320)} [kilde: summary:${item.source.ref}]`;
    }
    const label = TYPE_LABEL[item.type] ?? item.type;
    const previous = item.versions && item.versions.length > 0 ? item.versions[item.versions.length - 1] : undefined;
    const conflict = previous && previous.content !== item.content ? ` (tidligere: «${previous.content.slice(0, 120)}»)` : "";
    return `- [${label} · ${isoDate(item.observed_at)}] ${item.content}${conflict} [kilde: ${item.source.kind}:${item.source.ref}]`;
  }
}
