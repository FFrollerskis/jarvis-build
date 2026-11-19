import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import { isStorableObjectLabel, normalizeObjectLabel } from "../src/labels.ts";
import { startVisionDb, seedTenant, type VisionDb } from "./support/harness.ts";

// Usynlige tegn bygges av kodepunkter (ingen tegnescape i kilden).
const ZWSP = String.fromCodePoint(0x200b);
const SOFT_HYPHEN = String.fromCodePoint(0x00ad);

/**
 * WP-G3 (D-465), migrasjon 133-137: skjema-/RLS-/trigger-bevis mot EKTE Postgres (som runtime-rolle uten superbruker/BYPASSRLS der det gjelder).
 * Det som bevises: sone-regelen (kun hjem lagrer bilder) er en DB-CHECK, rutingpolicyen har ingen sky-verdi, alle nye tabeller har tenant- og space-isolasjon,
 * sletting av bilder er endelig konsistent (gravsteiner via trigger på ALLE sletteveier), vektorer og bilder følger hendelsen ut, og hendelsestabellen er fortsatt append-only.
 */
let db: VisionDb;
let T1: Awaited<ReturnType<typeof seedTenant>>;
let T2: Awaited<ReturnType<typeof seedTenant>>;
let room1 = "";
let room2 = "";

const asApp = <T>(tenant: string, spaces: Array<"personal" | "home" | "business">, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => withMemoryTransaction(db.app, tenant, spaces, fn);

beforeAll(async () => {
  db = await startVisionDb("g3mig");
  T1 = await seedTenant(db, "g3m-t1");
  T2 = await seedTenant(db, "g3m-t2");
  room1 = (await asApp(T1.tenant, ["home"], (c) => c.query(`INSERT INTO vision_rooms (room_id, tenant_id, memory_space_id, person_id, name) VALUES ('rm-1', $1, 'home', $2, 'Stua') RETURNING room_id`, [T1.tenant, T1.owner]))).rows[0].room_id;
  room2 = (await asApp(T2.tenant, ["home"], (c) => c.query(`INSERT INTO vision_rooms (room_id, tenant_id, memory_space_id, person_id, name) VALUES ('rm-2', $1, 'home', $2, 'Kjøkken') RETURNING room_id`, [T2.tenant, T2.owner]))).rows[0].room_id;
}, 240_000);

afterAll(async () => {
  await db?.stop();
}, 120_000);

async function addCamera(id: string, over: Partial<{ tenant: string; space: "home" | "personal"; person: string; zone: string; policy: string; room: string | null; sourceType: string; sourceRef: string }> = {}): Promise<void> {
  const tenant = over.tenant ?? T1.tenant;
  await asApp(tenant, [over.space ?? "home"], (c) =>
    c.query(
      `INSERT INTO vision_cameras (camera_id, tenant_id, memory_space_id, person_id, label, source_type, source_ref, room_id, zone_kind, route_policy)
       VALUES ($1, $2, $3, $4, 'Kamera', $5, $6, $7, $8, $9)`,
      [id, tenant, over.space ?? "home", over.person ?? T1.owner, over.sourceType ?? "home_assistant", over.sourceRef ?? `camera.${id.replace(/-/g, "_")}`, over.room === undefined ? room1 : over.room, over.zone ?? "home", over.policy ?? "store_snapshot"]
    )
  );
}

async function addSnapshot(id: string, camera: string, key: string, over: { tenant?: string; person?: string; event?: string } = {}): Promise<void> {
  const tenant = over.tenant ?? T1.tenant;
  await asApp(tenant, ["home"], (c) =>
    c.query(
      `INSERT INTO vision_snapshots (snapshot_id, tenant_id, memory_space_id, person_id, camera_id, source_type, source_instance_id, source_event_id, storage_backend, storage_key, media_type, byte_length, sha256, state, stored_at, retention_expires_at, task_id)
       VALUES ($1, $2, 'home', $3, $4, 'home_assistant', $4, $5, 'local_fs', $6, 'image/jpeg', 100, $7, 'stored', now(), now() + interval '7 days', 'task-test')`,
      [id, tenant, over.person ?? T1.owner, camera, over.event ?? `evt-${id}`, key, "a".repeat(64)]
    )
  );
}

async function addObservation(id: string, over: { snapshot?: string | null; person?: string; tenant?: string; event_type?: string; label?: string } = {}): Promise<void> {
  const tenant = over.tenant ?? T1.tenant;
  await asApp(tenant, ["home"], (c) =>
    c.query(
      `INSERT INTO vision_event_observations (observation_id, tenant_id, memory_space_id, person_id, event_type, object_label, snapshot_ref, source_type, source_instance_id, source_event_id, payload_fingerprint, observed_at)
       VALUES ($1, $2, 'home', $3, $4, $5, $6, 'home_assistant', 'cam', $7, 'fp', now())`,
      [id, tenant, over.person ?? T1.owner, over.event_type ?? "object_detected", over.label ?? "nøkler", over.snapshot ?? null, `src-${id}`]
    )
  );
}

describe("133: kameraregister", () => {
  it("sone-regelen er en DB-CHECK: workplace/shared + store_snapshot avvises, home + store_snapshot og workplace + local_only godtas", async () => {
    await addCamera("cam-home-store");
    await addCamera("cam-work-local", { zone: "workplace", policy: "local_only" });
    for (const zone of ["workplace", "shared"]) {
      await expect(addCamera(`cam-bad-${zone}`, { zone, policy: "store_snapshot" })).rejects.toThrow(/vision_cameras_zone_storage_rule/);
    }
  });

  it("rutingpolicyen har INGEN sky-verdi og kildetypen er lukket (kun home_assistant/iphone)", async () => {
    for (const policy of ["cloud", "cloud_vision", "upload", ""]) {
      await expect(addCamera(`cam-pol-${policy || "empty"}`, { policy })).rejects.toThrow(/route_policy|check/i);
    }
    await expect(addCamera("cam-src-rtsp", { sourceType: "rtsp", sourceRef: "rtsp-1" })).rejects.toThrow(/source_type|check/i);
  });

  it("samme fysiske kilde kan bare registreres én gang per (tenant, space)", async () => {
    await addCamera("cam-dup-1", { sourceRef: "camera.dup" });
    await expect(addCamera("cam-dup-2", { sourceRef: "camera.dup" })).rejects.toThrow(/vision_cameras_source_key/);
  });

  it("rom må høre til samme (tenant, space, person): rom fra en annen tenant avvises av den sammensatte FK-en", async () => {
    await expect(addCamera("cam-xroom", { room: room2 })).rejects.toThrow(/vision_cameras_room_fkey/);
  });

  it("RLS: tenant B ser ikke tenant A sine kameraer, og et annet space i samme tenant er skjult", async () => {
    const own = await asApp(T1.tenant, ["home"], (c) => c.query(`SELECT count(*)::int AS n FROM vision_cameras`));
    expect(own.rows[0].n).toBeGreaterThan(0);
    expect((await asApp(T2.tenant, ["home"], (c) => c.query(`SELECT count(*)::int AS n FROM vision_cameras`))).rows[0].n).toBe(0);
    expect((await asApp(T1.tenant, ["personal"], (c) => c.query(`SELECT count(*)::int AS n FROM vision_cameras`))).rows[0].n).toBe(0);
    await expect(asApp(T2.tenant, ["home"], (c) => c.query(`INSERT INTO vision_cameras (camera_id, tenant_id, memory_space_id, person_id, label, source_type, source_ref, zone_kind, route_policy) VALUES ('x', $1, 'home', $2, 'K', 'home_assistant', 'camera.x', 'home', 'local_only')`, [T1.tenant, T1.owner]))).rejects.toThrow(/row-level security/i);
  });

  it("hendelsestabellen er FORTSATT append-only for runtime-rollen (ingen UPDATE) og de nye kolonnene har gyldige standarder", async () => {
    await addObservation("obs-append-1");
    await expect(asApp(T1.tenant, ["home"], (c) => c.query(`UPDATE vision_event_observations SET object_label = 'x' WHERE observation_id = 'obs-append-1'`))).rejects.toThrow(/permission denied/i);
    const row = (await asApp(T1.tenant, ["home"], (c) => c.query(`SELECT task_id, session_id, classification_status, classifier, snapshot_ref FROM vision_event_observations WHERE observation_id = 'obs-append-1'`))).rows[0];
    expect(row).toEqual({ task_id: null, session_id: null, classification_status: "not_applicable", classifier: null, snapshot_ref: null });
    await expect(asApp(T1.tenant, ["home"], (c) => c.query(`INSERT INTO vision_event_observations (observation_id, tenant_id, memory_space_id, person_id, event_type, source_type, source_instance_id, source_event_id, payload_fingerprint, observed_at, classification_status) VALUES ('obs-bad-cls', $1, 'home', $2, 'motion_detected', 's', 'i', 'e-bad', 'fp', now(), 'cloud_classified')`, [T1.tenant, T1.owner]))).rejects.toThrow(/classification_status|check/i);
  });
});

/**
 * Review A-M1: «ALLE personnavn/-identiteter avvises» var en usann påstand, og databasen hadde ingen CHECK på object_label. Nå har begge tabeller en CHECK på FORMEN (lengde, tegnklasse, ordtall) -
 * IKKE på innholdet (åpent ordforråd er ubetrodd data, se labels.ts). Testene under kjører mot selve constraint-uttrykket i databasen (pg_get_constraintdef), slik at en endring i migrasjonen
 * som svekker regelen felles, og JS-regelen (`isStorableObjectLabel`) og SQL-regelen kan ikke gli fra hverandre.
 */
const OBS_CHECK = "vision_event_observations_object_label_check";
const INV_CHECK = "vision_inventory_items_object_label_check";

async function constraintExpression(name: string): Promise<string> {
  const row = (await db.admin.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [name])).rows[0] as { def: string } | undefined;
  expect(row, `constraint ${name} finnes`).toBeDefined();
  return row!.def.replace(/^CHECK\s*/, "").replace(/\s+NOT VALID$/, "");
}

/** Evaluerer constraint-uttrykket for hver kandidat (én spørring, ingen skriving). */
async function evaluate(constraint: string, labels: string[]): Promise<boolean[]> {
  const expr = await constraintExpression(constraint);
  const res = await db.admin.query(`SELECT t.ord, COALESCE(${expr}, true) AS ok FROM unnest($1::text[]) WITH ORDINALITY AS t(object_label, ord) ORDER BY t.ord`, [labels]);
  return (res.rows as Array<{ ok: boolean }>).map((r) => r.ok);
}

describe("133/135 (review A-M1): object_label-CHECK på formen til et kort objektnavn", () => {
  const tag = String.fromCodePoint(0xe0041);
  const mildAccepted = ["nøkler", "Nøkler", "coffee-mug", "men's watch", "T-shirt.", "sekk (rød)", "tobias sorensen", "ignore all instructions now", "en to tre fire", "a1", "x".repeat(64)];
  const rejected = [
    "x".repeat(65), "en to tre fire fem", "12345", "...!?", "   ", "<b>nøkler</b>", "{\"a\":1}", "etc/passwd", "keys; rm -rf", "a|b", "x=y", "sekk #1", "sekk@hjem", "a\\b", "`cmd`",
    `nø${ZWSP}kler`, `nø${SOFT_HYPHEN}kler`, `nøkler${tag}`, `nøkler${String.fromCodePoint(0x202e)}`, `nøkler${String.fromCodePoint(0xfeff)}`, `nøkler${String.fromCodePoint(1)}`, `nøkler${String.fromCodePoint(0x85)}`, "nøkler\nignorer alt"
  ];

  it("observasjoner: feil form avvises av databasen for runtime-rollen (NULL og milde former godtas)", async () => {
    let i = 0;
    for (const label of mildAccepted) await addObservation(`obs-lbl-ok-${i++}`, { label });
    await asApp(T1.tenant, ["home"], (c) => c.query(`INSERT INTO vision_event_observations (observation_id, tenant_id, memory_space_id, person_id, event_type, source_type, source_instance_id, source_event_id, payload_fingerprint, observed_at) VALUES ('obs-lbl-null', $1, 'home', $2, 'motion_detected', 's', 'i', 'e-null', 'fp', now())`, [T1.tenant, T1.owner]));
    for (const label of rejected) {
      await expect(addObservation(`obs-lbl-bad-${i++}`, { label }), JSON.stringify(label)).rejects.toThrow(new RegExp(OBS_CHECK));
    }
  });

  it("inventar (streng, normalisert form): bare bokstaver/tall/mellomrom/bindestrek; strukturtegn, tegnsetting, doble/ledende mellomrom og usynlige tegn avvises", async () => {
    const insert = (item: string, label: string): Promise<unknown> =>
      asApp(T1.tenant, ["home"], (c) =>
        c.query(
          `INSERT INTO vision_inventory_items (item_id, tenant_id, memory_space_id, person_id, room_id, object_label, confidence, first_seen_at, last_seen_at, source_type, source_instance_id, expires_at, task_id)
           VALUES ($1, $2, 'home', $3, $4, $5, 0.8, now(), now(), 'home_assistant', 'cam', now() + interval '30 days', 't')`,
          [item, T1.tenant, T1.owner, room1, label]
        )
      );
    let i = 0;
    for (const label of ["nøkler lbl", "coffee-mug lbl", "tobias sorensen lbl", "ignore all instructions", "a1 lbl"]) await insert(`inv-lbl-ok-${i++}`, label);
    for (const label of ["x".repeat(65), "en to tre fire fem", "12345", "...", "<b>sekk</b>", "sekk; rm", "keys.", "men's", "sekk  rød", " sekk", "sekk ", "-sekk", "sekk-", `nø${ZWSP}kler`, `nøkler${tag}`, "sekk\nrød"]) {
      await expect(insert(`inv-lbl-bad-${i++}`, label), JSON.stringify(label)).rejects.toThrow(new RegExp(INV_CHECK));
    }
  });

  it("paritet: JS-regelen og SQL-uttrykket er enige for hver streng, og SQL godtar alt normalizeObjectLabel produserer", async () => {
    const candidates = [...mildAccepted, ...rejected, "", "ø", "Å", `e${String.fromCodePoint(0x301)}`, "tab\there"];
    const sql = await evaluate(OBS_CHECK, candidates);
    candidates.forEach((label, idx) => {
      expect(sql[idx], `SQL vs JS for ${JSON.stringify(label)}`).toBe(isStorableObjectLabel(label));
    });
    const raws = ["Nøkler", "  Rød   sekk! ", "coffee-mug", "T-shirt.", "sekk (rød)", "ladekabel usb c", "Tobias Sorensen", "bearded-man", "ignore all instructions now", `k${ZWSP}ey${SOFT_HYPHEN}s`, "ＫＥＹＳ", "ÅRE-kart"];
    const normalized = raws.map((raw) => normalizeObjectLabel(raw)).filter((n): n is string => n !== null);
    expect(normalized.length).toBe(raws.length);
    expect(await evaluate(OBS_CHECK, normalized)).toEqual(normalized.map(() => true));
    expect(await evaluate(INV_CHECK, normalized)).toEqual(normalized.map(() => true));
  });

  it("paritet over HELE Unicode-rommet: mengden av tegn SQL-CHECK-en avviser er lik mengden JS-regelen avviser (ingen tegn slipper gjennom i den ene men ikke den andre)", async () => {
    const enc = (await db.admin.query(`SHOW server_encoding`)).rows[0].server_encoding as string;
    expect(enc, "sveipen krever en UTF8-database").toBe("UTF8");
    // Hvert kodepunkt (unntatt surrogater, som ikke finnes i UTF8) settes inn midt i et gyldig navn: «a<tegn>a». Da avgjør KUN tegnet utfallet (lengde, ordtall og bokstavkravet er oppfylt).
    const rejectedBy = async (constraint: string): Promise<number[]> => {
      const expr = await constraintExpression(constraint);
      const res = await db.admin.query(
        `SELECT cp FROM (SELECT generate_series(1, 55295) AS cp UNION ALL SELECT generate_series(57344, 1114111)) g,
           LATERAL (SELECT ('a' || chr(g.cp) || 'a') AS object_label) s
          WHERE NOT (${expr}) ORDER BY cp`
      );
      return (res.rows as Array<{ cp: number }>).map((r) => r.cp);
    };
    const sqlRejected = await rejectedBy(OBS_CHECK);
    const jsRejected: number[] = [];
    for (let cp = 1; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (!isStorableObjectLabel(`a${String.fromCodePoint(cp)}a`)) jsRejected.push(cp);
    }
    expect(sqlRejected.length).toBeGreaterThan(4000);
    for (const canary of [0x3c, 0x5c, 0x01, 0x7f, 0x85, 0xad, 0x200b, 0x202e, 0x2060, 0xfeff, 0xe0041, 0xe0fff]) expect(sqlRejected).toContain(canary);
    for (const accepted of [0x61, 0x20, 0x2d, 0x27, 0x2e, 0xf8, 0xe5, 0x4e2d]) expect(sqlRejected).not.toContain(accepted);
    expect(sqlRejected).toEqual(jsRejected);
    // Den strenge inventar-CHECK-en avviser MINST det samme (den avviser i tillegg all tegnsetting og ledende/doble mellomrom), men godtar bokstaver, tall og bindestrek.
    const strictRejected = new Set(await rejectedBy(INV_CHECK));
    for (const cp of sqlRejected) expect(strictRejected.has(cp), `inventar godtar U+${cp.toString(16)}`).toBe(true);
    for (const accepted of [0x2d, 0x30, 0x39, 0x41, 0x61, 0x7a, 0xc5, 0xf8, 0x4e2d]) expect(strictRejected.has(accepted), `inventar avviser U+${accepted.toString(16)}`).toBe(false);
    for (const rejectedPunct of [0x27, 0x2e, 0x2c, 0x21, 0x28]) expect(strictRejected.has(rejectedPunct), `inventar godtar U+${rejectedPunct.toString(16)}`).toBe(true);
  }, 180_000);
});

describe("137: lukket hendelsestype-sett", () => {
  it("opening_detected er godtatt; ansikts-/identitetstyper og ukjente typer avvises", async () => {
    await addObservation("obs-opening", { event_type: "opening_detected", label: undefined as unknown as string });
    for (const bad of ["face_recognized", "person_identified", "identity_match", "video_stream", "unknown"]) {
      await expect(addObservation(`obs-bad-${bad}`, { event_type: bad })).rejects.toThrow(/event_type|check/i);
    }
  });
});

describe("134: øyeblikksbilder, gravsteiner og peker", () => {
  it("storage_key-CHECK avviser stitraversering, tomme segmenter og absolutte stier; media_type er kun jpeg/png/webp (ingen video)", async () => {
    await addCamera("cam-snap");
    for (const [i, key] of ["../etc/passwd", "a/../b", "a//b", "/abs/path", "has space"].entries()) {
      await expect(addSnapshot(`snap-badkey-${i}`, "cam-snap", key)).rejects.toThrow(/storage_key|check/i);
    }
    await expect(
      asApp(T1.tenant, ["home"], (c) => c.query(`INSERT INTO vision_snapshots (snapshot_id, tenant_id, memory_space_id, person_id, camera_id, source_type, source_instance_id, source_event_id, storage_backend, storage_key, media_type, byte_length, sha256, retention_expires_at, task_id) VALUES ('snap-video', $1, 'home', $2, 'cam-snap', 'ha', 'cam-snap', 'e-v', 'local_fs', 'k/video', 'video/mp4', 10, $3, now(), 't')`, [T1.tenant, T1.owner, "b".repeat(64)]))
    ).rejects.toThrow(/media_type|check/i);
  });

  it("ett bilde per kilde-hendelse (unik nøkkel), og kameraet må tilhøre samme (tenant, space, person)", async () => {
    await addSnapshot("snap-a", "cam-snap", "snapshots/x/snap-a", { event: "evt-same" });
    await expect(addSnapshot("snap-b", "cam-snap", "snapshots/x/snap-b", { event: "evt-same" })).rejects.toThrow(/vision_snapshots_source_event_key/);
    await expect(addSnapshot("snap-c", "cam-snap", "snapshots/x/snap-c", { person: T1.other })).rejects.toThrow(/vision_snapshots_camera_fkey/);
  });

  it("snapshot_ref er en sammensatt FK: en hendelse kan ikke peke på en annen persons bilde, men eierens eget fungerer", async () => {
    await addSnapshot("snap-ref", "cam-snap", "snapshots/x/snap-ref");
    await expect(addObservation("obs-xperson", { snapshot: "snap-ref", person: T1.other })).rejects.toThrow(/vision_event_observations_snapshot_fkey/);
    await addObservation("obs-ref-ok", { snapshot: "snap-ref" });
    const row = (await asApp(T1.tenant, ["home"], (c) => c.query(`SELECT snapshot_ref FROM vision_event_observations WHERE observation_id = 'obs-ref-ok'`))).rows[0];
    expect(row.snapshot_ref).toBe("snap-ref");
  });

  it("BEFORE DELETE-triggeren skriver en gravstein for hver slettet rad - også når bildet slettes av runtime-rollen direkte, og hendelsen beholdes med snapshot_ref = NULL", async () => {
    await addSnapshot("snap-del", "cam-snap", "snapshots/x/snap-del");
    await addObservation("obs-del", { snapshot: "snap-del" });
    await asApp(T1.tenant, ["home"], (c) => c.query(`DELETE FROM vision_snapshots WHERE snapshot_id = 'snap-del'`));
    const tomb = await asApp(T1.tenant, ["home"], (c) => c.query(`SELECT storage_key, attempts, last_error FROM vision_snapshot_tombstones WHERE storage_key = 'snapshots/x/snap-del'`));
    expect(tomb.rows).toEqual([{ storage_key: "snapshots/x/snap-del", attempts: 0, last_error: null }]);
    const obs = (await asApp(T1.tenant, ["home"], (c) => c.query(`SELECT snapshot_ref FROM vision_event_observations WHERE observation_id = 'obs-del'`))).rows;
    expect(obs).toEqual([{ snapshot_ref: null }]);
  });

  it("når SISTE hendelse som peker på et bilde slettes, slettes bildet (med gravstein) - ikke før (flere hendelser deler ett bilde)", async () => {
    await addSnapshot("snap-shared", "cam-snap", "snapshots/x/snap-shared");
    await addObservation("obs-s1", { snapshot: "snap-shared" });
    await addObservation("obs-s2", { snapshot: "snap-shared", label: "sekk" });
    await asApp(T1.tenant, ["home"], (c) => c.query(`DELETE FROM vision_event_observations WHERE observation_id = 'obs-s1'`));
    expect((await asApp(T1.tenant, ["home"], (c) => c.query(`SELECT count(*)::int AS n FROM vision_snapshots WHERE snapshot_id = 'snap-shared'`))).rows[0].n).toBe(1);
    await asApp(T1.tenant, ["home"], (c) => c.query(`DELETE FROM vision_event_observations WHERE observation_id = 'obs-s2'`));
    expect((await asApp(T1.tenant, ["home"], (c) => c.query(`SELECT count(*)::int AS n FROM vision_snapshots WHERE snapshot_id = 'snap-shared'`))).rows[0].n).toBe(0);
    expect((await asApp(T1.tenant, ["home"], (c) => c.query(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones WHERE storage_key = 'snapshots/x/snap-shared'`))).rows[0].n).toBe(1);
  });

  it("å fjerne et kamera sletter bildene (kaskade) og gir gravsteiner", async () => {
    await addCamera("cam-gone", { sourceRef: "camera.gone" });
    await addSnapshot("snap-gone", "cam-gone", "snapshots/x/snap-gone");
    await asApp(T1.tenant, ["home"], (c) => c.query(`DELETE FROM vision_cameras WHERE camera_id = 'cam-gone'`));
    expect((await asApp(T1.tenant, ["home"], (c) => c.query(`SELECT count(*)::int AS n FROM vision_snapshots WHERE snapshot_id = 'snap-gone'`))).rows[0].n).toBe(0);
    expect((await asApp(T1.tenant, ["home"], (c) => c.query(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones WHERE storage_key = 'snapshots/x/snap-gone'`))).rows[0].n).toBe(1);
  });

  it("RLS: gravsteiner og bilder er isolert per tenant og space; en annen tenant kan ikke se eller slette dem", async () => {
    expect((await asApp(T2.tenant, ["home"], (c) => c.query(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones`))).rows[0].n).toBe(0);
    expect((await asApp(T1.tenant, ["personal"], (c) => c.query(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones`))).rows[0].n).toBe(0);
    const deleted = await asApp(T2.tenant, ["home"], (c) => c.query(`DELETE FROM vision_snapshot_tombstones`));
    expect(deleted.rowCount).toBe(0);
  });
});

describe("135: vektorer og inventar", () => {
  it("memory_vectors godtar ref_kind vision_event (men fortsatt ikke vilkårlige verdier), og en trigger fjerner vektoren når hendelsen slettes", async () => {
    await addObservation("obs-vec", { label: "kaffekopp" });
    const insert = (kind: string): Promise<unknown> =>
      asApp(T1.tenant, ["home"], (c) => c.query(`INSERT INTO memory_vectors (ref_kind, ref_id, tenant_id, space, model, dim, embedding) VALUES ($1, 'obs-vec', $2, 'home', 'm', 3, '{0.1,0.2,0.3}')`, [kind, T1.tenant]));
    await expect(insert("face_embedding")).rejects.toThrow(/memory_vectors_ref_kind_check|check/i);
    await insert("vision_event");
    expect((await asApp(T1.tenant, ["home"], (c) => c.query(`SELECT count(*)::int AS n FROM memory_vectors WHERE ref_id = 'obs-vec'`))).rows[0].n).toBe(1);
    await asApp(T1.tenant, ["home"], (c) => c.query(`DELETE FROM vision_event_observations WHERE observation_id = 'obs-vec'`));
    expect((await asApp(T1.tenant, ["home"], (c) => c.query(`SELECT count(*)::int AS n FROM memory_vectors WHERE ref_id = 'obs-vec'`))).rows[0].n).toBe(0);
  });

  it("de EKSISTERENDE ref_kind-verdiene (item/episode/summary) virker uendret", async () => {
    for (const kind of ["item", "episode", "summary"]) {
      await asApp(T1.tenant, ["home"], (c) => c.query(`INSERT INTO memory_vectors (ref_kind, ref_id, tenant_id, space, model, dim, embedding) VALUES ($1, $2, $3, 'home', 'm', 3, '{0.1,0.2,0.3}')`, [kind, `ref-${kind}`, T1.tenant]));
    }
    expect((await asApp(T1.tenant, ["home"], (c) => c.query(`SELECT count(*)::int AS n FROM memory_vectors WHERE ref_id LIKE 'ref-%'`))).rows[0].n).toBe(3);
  });

  it("inventar: ett element per (rom, navn), rommet må tilhøre samme person, og et rom som slettes tar inventaret med seg", async () => {
    const insert = (item: string, room: string, label: string, person = T1.owner): Promise<unknown> =>
      asApp(T1.tenant, ["home"], (c) =>
        c.query(
          `INSERT INTO vision_inventory_items (item_id, tenant_id, memory_space_id, person_id, room_id, object_label, confidence, first_seen_at, last_seen_at, source_type, source_instance_id, expires_at, task_id)
           VALUES ($1, $2, 'home', $3, $4, $5, 0.8, now(), now(), 'home_assistant', 'cam', now() + interval '30 days', 't')`,
          [item, T1.tenant, person, room, label]
        )
      );
    await insert("inv-1", room1, "nøkler");
    await expect(insert("inv-2", room1, "nøkler")).rejects.toThrow(/vision_inventory_item_key/);
    await expect(insert("inv-3", room1, "sekk", T1.other)).rejects.toThrow(/vision_inventory_room_fkey/);
    await asApp(T1.tenant, ["home"], (c) => c.query(`INSERT INTO vision_rooms (room_id, tenant_id, memory_space_id, person_id, name) VALUES ('rm-tmp', $1, 'home', $2, 'Tmp')`, [T1.tenant, T1.owner]));
    await insert("inv-tmp", "rm-tmp", "lampe");
    await asApp(T1.tenant, ["home"], (c) => c.query(`DELETE FROM vision_rooms WHERE room_id = 'rm-tmp'`));
    expect((await asApp(T1.tenant, ["home"], (c) => c.query(`SELECT count(*)::int AS n FROM vision_inventory_items WHERE item_id = 'inv-tmp'`))).rows[0].n).toBe(0);
    expect((await asApp(T2.tenant, ["home"], (c) => c.query(`SELECT count(*)::int AS n FROM vision_inventory_items`))).rows[0].n).toBe(0);
  });
});

describe("136: opptaksforespørsler", () => {
  it("levetid maks 15 minutter (databasens klokke), unik idempotensnøkkel per person, kun definerte tilstander, og RLS", async () => {
    await addCamera("cam-iphone", { sourceType: "iphone", sourceRef: "device-abc", policy: "local_only" });
    const insert = (id: string, ttl: string, key: string | null, state = "pending"): Promise<unknown> =>
      asApp(T1.tenant, ["home"], (c) =>
        c.query(
          `INSERT INTO vision_capture_requests (request_id, tenant_id, memory_space_id, person_id, camera_id, device_id, state, idempotency_key, requested_at, expires_at, resolved_at, task_id)
           VALUES ($1, $2, 'home', $3, 'cam-iphone', 'device-abc', $6, $5, now(), now() + $4::interval, CASE WHEN $6 = 'pending' THEN NULL ELSE now() END, 't')`,
          [id, T1.tenant, T1.owner, ttl, key, state]
        )
      );
    await insert("cap-1", "5 minutes", "idem-key-0001");
    await expect(insert("cap-2", "16 minutes", null)).rejects.toThrow(/vision_capture_requests_ttl/);
    await expect(insert("cap-3", "5 minutes", "idem-key-0001")).rejects.toThrow(/vision_capture_requests_idempotency_key/);
    await expect(insert("cap-4", "5 minutes", null, "approved")).rejects.toThrow(/state|check/i);
    await insert("cap-5", "5 minutes", null);
    await insert("cap-6", "5 minutes", null);
    expect((await asApp(T2.tenant, ["home"], (c) => c.query(`SELECT count(*)::int AS n FROM vision_capture_requests`))).rows[0].n).toBe(0);
  });
});

describe("ingen biometri i skjemaet (første linje av P3f - selve vakten ligger i g3-guards.test.ts)", () => {
  it("ingen vision_*-kolonne eller -tabell har et biometrisk/identitetsnavn", async () => {
    const cols = await db.admin.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'vision\\_%'`);
    const names = (cols.rows as Array<{ table_name: string; column_name: string }>).flatMap((r) => [r.table_name, r.column_name]);
    expect(names.length).toBeGreaterThan(60);
    expect(names.filter((n) => /face|facial|biometr|faceprint|gait|iris|identity|recogni[sz]/i.test(n))).toEqual([]);
  });
});
