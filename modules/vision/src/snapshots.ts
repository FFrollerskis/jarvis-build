import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import type { SnapshotMediaType } from "./image.ts";
import type { StorageAdapter } from "./storage.ts";
import type { VisionService } from "./service.ts";

/**
 * WP-G3 (D-465), P1a: levetids-eid lagring av ØYEBLIKKSBILDER (event snapshots). Jarvis eier metadata og livssyklus (`vision_snapshots`, 134); bildebytes ligger bak
 * `StorageAdapter` (lokal disk). Dette er «transaksjonell/kompenserende sletting av det refererte objektet» som 055_vision.sql krevde FØR `snapshot_ref` kunne åpnes:
 *
 *   SKRIVING (pipeline.ts): `begin()` oppretter en 'pending'-rad (egen transaksjon, oppbevaring fra databasens klokke) -> `writeBytes()` skriver objektet ->
 *   pipelinens EGEN transaksjon kaller `markStoredInTransaction()` og skriver hendelsene med `snapshot_ref` atomisk. Feiler skrivingen, fjernes pending-raden
 *   (`abandon`) og hendelsen skrives uten bilde. Et krasj mellom stegene etterlater en pending-rad som `reapPending` rydder - aldri et bilde uten eier.
 *   SLETTING: ALLE sletteveier (oppbevaring, erasure, kamera fjernet, hendelsen forsvant) fyrer BEFORE DELETE-triggeren som skriver en gravstein; `reapTombstones()` sletter
 *   objektet og fjerner graven FØRST når StorageAdapter har bekreftet. En feil gir en gravstein med `attempts`/`last_error` som står til neste kjøring. Sletting er endelig
 *   konsistent og aldri stille tapt.
 *   LESING: `read()` verifiserer sha256 mot metadataene (et ødelagt objekt serveres aldri).
 */
export interface VisionSnapshotRow {
  snapshot_id: string;
  tenant_id: string;
  memory_space_id: string;
  person_id: string;
  camera_id: string;
  source_type: string;
  source_instance_id: string;
  source_event_id: string;
  storage_backend: string;
  storage_key: string;
  media_type: SnapshotMediaType;
  byte_length: number;
  sha256: string;
  state: "pending" | "stored";
  created_at: string;
  stored_at: string | null;
  retention_expires_at: string;
  task_id: string;
  session_id: string | null;
}

export interface BeginSnapshotInput {
  camera_id: string;
  source_type: string;
  source_instance_id: string;
  source_event_id: string;
  media_type: SnapshotMediaType;
  byte_length: number;
  sha256: string;
  task_id: string;
  session_id?: string | undefined;
}

export class SnapshotInProgressError extends Error {
  constructor() {
    super("vision_snapshot_in_progress");
    this.name = "SnapshotInProgressError";
  }
}

/** Lagringskvoten for (tenant, space) er nådd: bildet lagres ikke (hendelsen skrives uten bilde). Meldingen er en ren kode (pipelinens notat blir `snapshot_quota_exceeded`). */
export class SnapshotQuotaError extends Error {
  constructor() {
    super("quota_exceeded");
    this.name = "SnapshotQuotaError";
  }
}

/** Standard lagringstak per (tenant, space): 2 GiB. En støyende sensor eller en ondsinnet kilde kan ikke fylle eierens disk (`JARVIS_VISION_MAX_STORED_MB` setter den). */
export const DEFAULT_MAX_STORED_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024;

/** Kort, stabil feilkode for gravsteiner (aldri meldingstekst - den kan inneholde stier). */
export function storageErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)) return code.toLowerCase();
  const name = (err as { name?: unknown } | null)?.name;
  if (typeof name === "string" && /^[A-Za-z0-9_]{1,60}$/.test(name) && name !== "Error") return name.toLowerCase();
  return "storage_error";
}

export class VisionSnapshotService {
  private readonly maxStoredBytes: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly storage: StorageAdapter,
    private readonly vision: VisionService,
    options: { maxStoredBytes?: number } = {}
  ) {
    this.maxStoredBytes = options.maxStoredBytes ?? DEFAULT_MAX_STORED_SNAPSHOT_BYTES;
    if (!Number.isFinite(this.maxStoredBytes) || this.maxStoredBytes <= 0) throw new Error("vision_snapshot_quota_invalid");
  }

  /** Nøkkelen bygges av Jarvis (aldri av en kilde eller modell). Tenant-id hashes: ingen tenant-/personnavn i objektstien. */
  static storageKeyFor(tenantId: string, snapshotId: string): string {
    return `snapshots/${createHash("sha256").update(tenantId).digest("hex").slice(0, 16)}/${snapshotId}`;
  }

  /** Steg 1: 'pending'-rad. Finnes det allerede et bilde for samme kilde-hendelse, gis det tilbake (`existing: true`) - aldri et nytt. */
  async begin(tenantId: string, memorySpace: MemorySpace, personId: string, input: BeginSnapshotInput): Promise<{ row: VisionSnapshotRow; existing: boolean }> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const days = await this.vision.snapshotRetentionDaysInTransaction(client, tenantId, memorySpace);
      // Review B-L7: kvoten (SUM etter INSERT, READ COMMITTED) var «mykt»: samtidige begin() så ikke hverandres uforpliktede rader og slapp alle gjennom. En advisory-lås per (tenant, space) serialiserer innsetting + kvotesjekk
      // (frigjøres ved commit/rollback), slik at hver begin() ser alle tidligere bilder. Låsen tas FØR innsettingen og ETTER oppslaget over (ingen låsholder venter på noe annet enn databasen).
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`vision-quota:${tenantId}:${memorySpace}`]);
      const snapshotId = `vis-snap-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO vision_snapshots
           (snapshot_id, tenant_id, memory_space_id, person_id, camera_id, source_type, source_instance_id, source_event_id,
            storage_backend, storage_key, media_type, byte_length, sha256, state, retention_expires_at, task_id, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending', now() + ($14 || ' days')::interval, $15, $16)
         ON CONFLICT (tenant_id, memory_space_id, person_id, source_type, source_instance_id, source_event_id) DO NOTHING
         RETURNING *`,
        [
          snapshotId, tenantId, memorySpace, personId, input.camera_id, input.source_type, input.source_instance_id, input.source_event_id,
          this.storage.backend, VisionSnapshotService.storageKeyFor(tenantId, snapshotId), input.media_type, input.byte_length, input.sha256, days, input.task_id, input.session_id ?? null
        ]
      );
      if (rows[0]) {
        // Kvote (i samme transaksjon, serialisert av låsen over): summen av ALLE bilderader i (tenant, space) inkludert denne. Over taket rulles raden tilbake - ingen pending-rest, ingen fil.
        const used = await client.query(`SELECT COALESCE(SUM(byte_length), 0)::bigint AS used FROM vision_snapshots WHERE tenant_id = $1 AND memory_space_id = $2`, [tenantId, memorySpace]);
        if (Number((used.rows[0] as { used: string }).used) > this.maxStoredBytes) throw new SnapshotQuotaError();
        return { row: rows[0] as VisionSnapshotRow, existing: false };
      }
      const existing = await client.query(
        `SELECT * FROM vision_snapshots WHERE tenant_id = $1 AND memory_space_id = $2 AND person_id = $3 AND source_type = $4 AND source_instance_id = $5 AND source_event_id = $6`,
        [tenantId, memorySpace, personId, input.source_type, input.source_instance_id, input.source_event_id]
      );
      const row = existing.rows[0] as VisionSnapshotRow;
      // En annen arbeider har raden 'pending' (skriver nå): ikke start en parallell skriving.
      if (row.state !== "stored") throw new SnapshotInProgressError();
      return { row, existing: true };
    });
  }

  /** Steg 2: skriv objektet. Feiler det, fjernes pending-raden (gravstein via trigger) og feilen kastes videre med en stabil kode. */
  async writeBytes(row: VisionSnapshotRow, bytes: Uint8Array): Promise<void> {
    try {
      await this.storage.put(row.storage_key, bytes);
    } catch (err) {
      await this.abandon(row.tenant_id, row.memory_space_id as MemorySpace, row.person_id, row.snapshot_id).catch((abandonErr: unknown) =>
        console.error(JSON.stringify({ msg: "vision_snapshot_abandon_failed", code: storageErrorCode(abandonErr) }))
      );
      throw Object.assign(new Error(`vision_snapshot_write_failed:${storageErrorCode(err)}`), { code: storageErrorCode(err) });
    }
  }

  /** Steg 3 (i pipelinens transaksjon): bildet er skrevet og hendelsene som peker på det committes sammen med denne oppdateringen. */
  async markStoredInTransaction(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, personId: string, snapshotId: string): Promise<void> {
    const { rowCount } = await client.query(
      `UPDATE vision_snapshots SET state = 'stored', stored_at = now()
        WHERE tenant_id = $1 AND memory_space_id = $2 AND person_id = $3 AND snapshot_id = $4 AND state = 'pending'`,
      [tenantId, memorySpace, personId, snapshotId]
    );
    if (rowCount !== 1) throw new Error("vision_snapshot_not_pending");
  }

  /** Fjerner en pending-rad (kompenserende sletting). Gravsteinen skrives av triggeren, så et eventuelt halvskrevet objekt også ryddes. */
  async abandon(tenantId: string, memorySpace: MemorySpace, personId: string, snapshotId: string): Promise<void> {
    await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      await client.query(`DELETE FROM vision_snapshots WHERE tenant_id = $1 AND memory_space_id = $2 AND person_id = $3 AND snapshot_id = $4 AND state = 'pending'`, [tenantId, memorySpace, personId, snapshotId]);
    });
  }

  async getMetadata(tenantId: string, memorySpace: MemorySpace, personId: string, snapshotId: string): Promise<VisionSnapshotRow | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM vision_snapshots WHERE tenant_id = $1 AND person_id = $2 AND snapshot_id = $3`, [tenantId, personId, snapshotId]);
      return (rows[0] as VisionSnapshotRow | undefined) ?? null;
    });
  }

  /** Eierens egen lesing av ETT bilde (RLS + person + id). Ødelagte/manglende objekter gir `null` - aldri feil bytes. */
  async read(tenantId: string, memorySpace: MemorySpace, personId: string, snapshotId: string): Promise<{ bytes: Uint8Array; media_type: SnapshotMediaType; sha256: string } | null> {
    const row = await this.getMetadata(tenantId, memorySpace, personId, snapshotId);
    if (!row || row.state !== "stored" || row.storage_backend !== this.storage.backend) return null;
    let bytes: Uint8Array | null;
    try {
      bytes = await this.storage.get(row.storage_key, row.byte_length + 1);
    } catch (err) {
      // Et objekt STØRRE enn metadataene sier er et integritetsavvik (manipulert/ødelagt) - aldri servert. Andre lese-feil (I/O) kastes videre.
      if ((err as Error).message === "storage_object_too_large") {
        console.error(JSON.stringify({ msg: "vision_snapshot_integrity_mismatch" }));
        return null;
      }
      throw err;
    }
    if (bytes === null) return null;
    if (bytes.length !== row.byte_length || createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
      console.error(JSON.stringify({ msg: "vision_snapshot_integrity_mismatch" }));
      return null;
    }
    return { bytes, media_type: row.media_type, sha256: row.sha256 };
  }

  /** Sletter bilder hvis egen oppbevaring (`retention_expires_at`) er passert. Hendelsene beholder sin peker som `NULL` (FK `SET NULL`). Gravsteiner skrives av triggeren. */
  async purgeExpiredSnapshots(tenantId: string, memorySpace: MemorySpace): Promise<number> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rowCount } = await client.query(`DELETE FROM vision_snapshots WHERE tenant_id = $1 AND memory_space_id = $2 AND retention_expires_at <= now()`, [tenantId, memorySpace]);
      return rowCount ?? 0;
    });
  }

  /** Rydder 'pending'-rader som aldri ble fullført (krasj mellom steg 1 og 3). `olderThanMs` er en sikkerhetsmargin mot en skriving som pågår akkurat nå. */
  async reapPending(tenantId: string, memorySpace: MemorySpace, olderThanMs = 10 * 60_000): Promise<number> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM vision_snapshots WHERE tenant_id = $1 AND memory_space_id = $2 AND state = 'pending' AND created_at <= now() - ($3 || ' milliseconds')::interval`,
        [tenantId, memorySpace, Math.max(0, Math.floor(olderThanMs))]
      );
      return rowCount ?? 0;
    });
  }

  /**
   * Sletter bildeobjektene bak gravsteinene (for denne adapterens backend). Graven fjernes KUN når `StorageAdapter.delete` lyktes (et objekt som allerede er borte er en
   * vellykket sletting). En feil øker `attempts` og lagrer en kort kode; resten av batchen fortsetter. `stuck` = gravsteiner med mange mislykkede forsøk (telles som sveipefeil, se sweep.ts).
   * Review B-L11: kjøringen går i batcher (`limit` per batch, standard 100) til køen er TOM - en erasure av 10 000 bilder tok ellers ca. ett døgn (100 per kjøring). Hver gravstein forsøkes høyst
   * ÉN gang per kall (en markør på `tombstone_id` flytter seg alltid forover, også forbi en feilet gravstein), og `maxBatches` (standard 1000) er en sikkerhetsgrense.
   */
  async reapTombstones(tenantId: string, memorySpace: MemorySpace, options: { limit?: number; stuckAttempts?: number; maxBatches?: number } = {}): Promise<{ deleted: number; failed: number; stuck: number }> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const maxBatches = Math.max(1, Math.floor(options.maxBatches ?? 1000));
    const stuckAttempts = options.stuckAttempts ?? 5;
    let deleted = 0;
    let failed = 0;
    let cursor = "0";
    for (let round = 0; round < maxBatches; round += 1) {
      const batch = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
        const { rows } = await client.query(
          `SELECT tombstone_id::text AS tombstone_id, storage_key FROM vision_snapshot_tombstones
            WHERE tenant_id = $1 AND memory_space_id = $2 AND storage_backend = $3 AND tombstone_id > $5::bigint ORDER BY tombstone_id ASC LIMIT $4`,
          [tenantId, memorySpace, this.storage.backend, limit, cursor]
        );
        return rows as Array<{ tombstone_id: string; storage_key: string }>;
      });
      if (batch.length === 0) break;
      for (const tombstone of batch) {
        try {
          await this.storage.delete(tombstone.storage_key);
          await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
            await client.query(`DELETE FROM vision_snapshot_tombstones WHERE tenant_id = $1 AND tombstone_id = $2`, [tenantId, tombstone.tombstone_id]);
          });
          deleted += 1;
        } catch (err) {
          failed += 1;
          const code = storageErrorCode(err);
          console.error(JSON.stringify({ msg: "vision_tombstone_delete_failed", code }));
          await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
            await client.query(
              `UPDATE vision_snapshot_tombstones SET attempts = attempts + 1, last_attempt_at = now(), last_error = $3 WHERE tenant_id = $1 AND tombstone_id = $2`,
              [tenantId, tombstone.tombstone_id, code]
            );
          }).catch(() => undefined);
        }
      }
      cursor = (batch[batch.length - 1] as { tombstone_id: string }).tombstone_id;
      if (batch.length < limit) break;
    }
    const stuck = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM vision_snapshot_tombstones WHERE tenant_id = $1 AND memory_space_id = $2 AND attempts >= $3`,
        [tenantId, memorySpace, stuckAttempts]
      );
      return (rows[0] as { n: number }).n;
    });
    return { deleted, failed, stuck };
  }
}
