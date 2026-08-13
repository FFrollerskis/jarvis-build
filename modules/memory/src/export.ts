import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import { withMemoryTransaction } from "./spaces.ts";

const EXPORT_SPACES: MemorySpace[] = ["personal", "business", "project", "home", "guest", "shared"];

/**
 * Menneskelesbar eksport (MEMORY_ARCHITECTURE §8): generert visning fra
 * databasen (enveis - aldri skrivekilde). Inngår i backupplanen.
 * health eksporteres i egen isolert kjøring (space-regelen).
 */
export class MemoryExporter {
  constructor(private readonly pool: pg.Pool) {}

  /** Eksporterer alt for en person/tenant. Returnerer liste over skrevne filer. */
  async exportAll(identity: IdentityContext, targetDir: string): Promise<string[]> {
    const written: string[] = [];
    const personDir = join(targetDir, "memory", "people", identity.person_id);

    for (const space of EXPORT_SPACES) {
      written.push(...(await this.exportSpace(identity, space, personDir)));
    }
    // health isolert (kan aldri kombineres med andre spaces):
    written.push(...(await this.exportSpace(identity, "health", personDir)));

    // Beslutninger og forpliktelser
    await withMemoryTransaction(this.pool, identity.tenant_id, [...EXPORT_SPACES], async (client) => {
      const decisions = await client.query("SELECT content, decided_at FROM decisions ORDER BY decided_at");
      const commitments = await client.query("SELECT content, due_at, status FROM commitments ORDER BY due_at NULLS LAST");
      written.push(await this.writeMd(join(personDir, "decisions"), "decisions.md", "Beslutninger",
        decisions.rows.map((r) => `- ${(r as { content: string }).content} (${String((r as { decided_at: unknown }).decided_at)})`)));
      written.push(await this.writeMd(join(personDir, "commitments"), "commitments.md", "Forpliktelser",
        commitments.rows.map((r) => `- [${(r as { status: string }).status}] ${(r as { content: string }).content}`)));
    });

    // Samtaler per år/måned
    await withTenantTransaction(this.pool, identity.tenant_id, async (client) => {
      const messages = await client.query(
        `SELECT session_id, role, content, created_at, to_char(created_at, 'YYYY') AS y,
                to_char(created_at, 'MM') AS m
         FROM messages ORDER BY created_at`
      );
      const byMonth = new Map<string, string[]>();
      for (const row of messages.rows as Array<{ session_id: string; role: string; content: string; y: string; m: string }>) {
        const key = `${row.y}/${row.m}`;
        const list = byMonth.get(key) ?? [];
        list.push(`- [${row.session_id}] ${row.role}: ${row.content}`);
        byMonth.set(key, list);
      }
      for (const [key, lines] of byMonth) {
        written.push(await this.writeMd(join(targetDir, "memory", "conversations", key), "conversations.md", `Samtaler ${key}`, lines));
      }
    });

    // Arkiv: historiske versjoner og invaliderte minner
    await withMemoryTransaction(this.pool, identity.tenant_id, [...EXPORT_SPACES], async (client) => {
      const versions = await client.query(
        `SELECT memory_item_id, version, content, change_kind, changed_at FROM memory_versions ORDER BY changed_at`
      );
      written.push(await this.writeMd(join(targetDir, "memory", "archive"), "versions.md", "Arkiv (versjonshistorikk)",
        versions.rows.map((r) => {
          const row = r as { memory_item_id: string; version: number; content: string; change_kind: string };
          return `- ${row.memory_item_id} v${row.version} (${row.change_kind}): ${row.content}`;
        })));
    });

    return written;
  }

  private async exportSpace(identity: IdentityContext, space: MemorySpace, personDir: string): Promise<string[]> {
    return withMemoryTransaction(this.pool, identity.tenant_id, [space], async (client) => {
      const items = await client.query(
        `SELECT m.subject, m.content, m.type, m.status, m.valid_from, m.valid_to, m.version,
                s.kind AS source_kind, s.ref AS source_ref
         FROM memory_items m JOIN memory_sources s ON s.source_id = m.source_id
         WHERE m.status IN ('active','quarantined') ORDER BY m.subject`
      );
      if (items.rows.length === 0) {
        return [];
      }
      const lines = items.rows.map((r) => {
        const row = r as {
          subject: string; content: string; type: string; status: string; version: number;
          source_kind: string; source_ref: string;
        };
        const quarantine = row.status === "quarantined" ? " ⚠KARANTENE" : "";
        return `- **${row.subject}** (${row.type}, v${row.version}${quarantine}): ${row.content} _[kilde: ${row.source_kind}:${row.source_ref}]_`;
      });
      const file = await this.writeMd(join(personDir, space), "items.md", `Minne: ${space}`, lines);
      return [file];
    });
  }

  private async writeMd(dir: string, name: string, title: string, lines: string[]): Promise<string> {
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, `# ${title}\n\nGenerert fra databasen (enveis eksport).\n\n${lines.join("\n")}\n`, "utf8");
    return path;
  }
}
