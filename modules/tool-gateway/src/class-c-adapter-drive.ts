/**
 * WP-AUTH2a (K3): klasse C-adaptere for Google Drive. Bruker KUN `drive.get_metadata` (den eksisterende lesehandlingen som allerede er `preflight_action` for fire av dem) og feltene den returnerer:
 * `id`, `name`, `mimeType`, `trashed`, `parents`, `headRevisionId`, `modifiedTime` (`GoogleDriveTransport.getMetadata`).
 *
 *   - `drive.create_file`: forelder (om oppgitt) finnes og er en mappe; etterpå finnes filen med riktig navn, ikke i papirkurven og (om forelder er oppgitt) kun i den mappen. Rollback: legg den opprettede filen i papirkurven.
 *   - `drive.update_content`: fil finnes; `expected_head_revision_id` (om oppgitt) stemmer; etterpå er `headRevisionId` endret (og lik den transporten returnerte), og navn/papirkurv/foreldre er uendret.
 *     Har filen ingen `headRevisionId` (Google-egne dokumenttyper), KAN innholdsendringen ikke observeres: verdiktet er da `unverified`, aldri `verified`. Rollback: gjenopprett forrige revisjon fra Drive-historikken (manuelt).
 *   - `drive.rename`: etterpå er navnet det ønskede, mens papirkurv og foreldre er uendret. Rollback: gi tilbake forrige navn.
 *   - `drive.move`: målmappen finnes og er en mappe; etterpå er `parents` nøyaktig målmappen (transporten fjerner alle gamle foreldre), navn og papirkurv uendret. Rollback: flytt tilbake (kun når det var én forelder).
 *   - `drive.trash`: etterpå er `trashed` sann, navn og foreldre uendret. Rollback: gjenopprett fra papirkurven (ingen registrert Jarvis-handling for det; manuell prosedyre).
 * `modifiedTime` og `headRevisionId` ligger i `context` (bevis) og sammenlignes ikke, bortsett fra revisjonen i `update_content`. Innhold (selve bytene) leses aldri tilbake: det står i `unobservable`.
 */
import type { JsonValue } from "@jarvis/contracts";
import type { ClassCAdapter, ClassCExpectation, ClassCReads, ClassCSnapshot } from "./class-c-pipeline.ts";
import { encodePathSegment } from "./url-safety.ts";

type Obj = Record<string, JsonValue>;

/** `application/vnd.google-apps.folder` - Drives egen MIME-type for mapper (også brukt av `GoogleDriveTransport`). */
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";

interface DriveMeta {
  id: string;
  name: string;
  mime_type: string;
  trashed: boolean;
  parents: string[];
  head_revision_id: string | null;
  modified_time: string | null;
}

/** Tolker `get_metadata`-svaret strengt; alt som ikke har formen transporten returnerer er `null` (ulesbart). */
function metaOf(reads: ClassCReads, id: string): DriveMeta | null {
  const result = reads[id];
  if (result === undefined || !result.ok) return null;
  const d = result.data;
  if (d === null || typeof d !== "object" || Array.isArray(d)) return null;
  const o = d as Obj;
  if (typeof o["id"] !== "string" || typeof o["name"] !== "string" || typeof o["trashed"] !== "boolean" || !Array.isArray(o["parents"])) return null;
  if (!o["parents"].every((p) => typeof p === "string")) return null;
  return {
    id: o["id"], name: o["name"], mime_type: typeof o["mimeType"] === "string" ? o["mimeType"] : "", trashed: o["trashed"], parents: o["parents"] as string[],
    head_revision_id: typeof o["headRevisionId"] === "string" ? o["headRevisionId"] : null, modified_time: typeof o["modifiedTime"] === "string" ? o["modifiedTime"] : null
  };
}

const safeId = (value: unknown): boolean => {
  try {
    encodePathSegment(value, "id");
    return true;
  } catch {
    return false;
  }
};

const contextOf = (m: DriveMeta): Obj => ({ id: m.id, mime_type: m.mime_type, head_revision_id: m.head_revision_id, modified_time: m.modified_time });
const metaRead = (id: string, fileId: JsonValue | undefined) => ({ id, action: "get_metadata", parameters: { file_id: fileId ?? null } });

/** `expected_head_revision_id` er en eksplisitt forutsetning (samme som transportens `assertNotStale`): stemmer den ikke, blokkeres kallet FØR noe reserveres. */
function staleRevision(p: Record<string, JsonValue>, meta: DriveMeta): boolean {
  return p["expected_head_revision_id"] !== undefined && meta.head_revision_id !== String(p["expected_head_revision_id"]);
}

function existingTargetAdapter(
  key: string,
  parts: {
    validate(p: Record<string, JsonValue>): string | null;
    extraReads?(p: Record<string, JsonValue>): Array<{ id: string; action: string; parameters: Record<string, JsonValue> }>;
    judge?(p: Record<string, JsonValue>, reads: ClassCReads, target: DriveMeta): { block: string | null; warnings?: string[] };
    state(meta: DriveMeta): Obj;
    expect(p: Record<string, JsonValue>, before: ClassCSnapshot, mutation: { external_id: string | null; data: JsonValue | null }): ClassCExpectation[];
    rollback: ClassCAdapter["rollback"];
    unobservable?: readonly string[];
  }
): ClassCAdapter {
  const snapshot = (reads: ClassCReads): ClassCSnapshot => {
    const meta = metaOf(reads, "file");
    if (meta === null) throw new Error("class_c_drive_metadata_unreadable");
    return { state: parts.state(meta), context: contextOf(meta) };
  };
  return {
    key,
    ...(parts.unobservable !== undefined ? { unobservable: parts.unobservable } : {}),
    validate: parts.validate,
    before: {
      reads: (p) => [metaRead("file", p["file_id"]), ...(parts.extraReads?.(p) ?? [])],
      judge(p, reads) {
        const meta = metaOf(reads, "file");
        if (meta === null) return { block: "metadata_unreadable" };
        if (staleRevision(p, meta)) return { block: "stale_revision" };
        const warnings = meta.trashed ? ["target_trashed"] : [];
        const extra = parts.judge?.(p, reads, meta) ?? { block: null };
        return { block: extra.block, warnings: [...warnings, ...(extra.warnings ?? [])] };
      },
      snapshot: (_p, reads) => snapshot(reads)
    },
    after: {
      reads: (p) => [metaRead("file", p["file_id"])],
      snapshot: (_p, _m, reads) => snapshot(reads)
    },
    expect: (p, mutation, before) => parts.expect(p, before, mutation),
    rollback: parts.rollback
  };
}

export const driveRenameAdapter: ClassCAdapter = existingTargetAdapter("drive.rename", {
  validate: (p) => (!safeId(p["file_id"]) ? "file_id_invalid" : typeof p["new_name"] !== "string" || p["new_name"].trim() === "" ? "new_name_missing" : null),
  judge: (p, _reads, target) => ({ block: null, warnings: target.name === p["new_name"] ? ["name_unchanged"] : [] }),
  state: (m) => ({ name: m.name, trashed: m.trashed, parents: m.parents }),
  expect: (p) => [{ path: "name", op: "equals", value: String(p["new_name"]) }, { path: "trashed", op: "unchanged" }, { path: "parents", op: "unchanged" }],
  rollback(p, _m, before) {
    if (before.state["name"] === p["new_name"]) return { kind: "none", steps: [], note: "Navnet var allerede det ønskede; ingenting ble endret." };
    return {
      kind: "compensating_action",
      steps: [{ tool_id: "drive", action: "rename", parameters: { file_id: p["file_id"] ?? null, new_name: before.state["name"] ?? null } }],
      note: "Gi filen tilbake det forrige navnet."
    };
  }
});

export const driveMoveAdapter: ClassCAdapter = existingTargetAdapter("drive.move", {
  validate: (p) => (!safeId(p["file_id"]) ? "file_id_invalid" : !safeId(p["new_parent_folder_id"]) ? "new_parent_folder_id_invalid" : p["file_id"] === p["new_parent_folder_id"] ? "destination_is_self" : null),
  extraReads: (p) => [metaRead("destination", p["new_parent_folder_id"])],
  judge(_p, reads) {
    const destination = metaOf(reads, "destination");
    if (destination === null) return { block: "destination_unreadable" };
    if (destination.mime_type !== GOOGLE_FOLDER_MIME) return { block: "destination_not_folder" };
    return { block: null, warnings: destination.trashed ? ["destination_trashed"] : [] };
  },
  state: (m) => ({ parents: m.parents, name: m.name, trashed: m.trashed }),
  expect: (p) => [{ path: "parents", op: "equals", value: [String(p["new_parent_folder_id"])] }, { path: "name", op: "unchanged" }, { path: "trashed", op: "unchanged" }],
  rollback(p, _m, before) {
    const parents = before.state["parents"];
    if (Array.isArray(parents) && parents.length === 1 && parents[0] === p["new_parent_folder_id"]) return { kind: "none", steps: [], note: "Filen lå allerede i målmappen; ingenting ble endret." };
    if (!Array.isArray(parents) || parents.length !== 1) return { kind: "manual", steps: [], note: "Filen hadde ikke nøyaktig én forelder før flyttingen; gjenopprett foreldrene manuelt i Drive (de er lagret i før-snapshotet)." };
    return {
      kind: "compensating_action",
      steps: [{ tool_id: "drive", action: "move", parameters: { file_id: p["file_id"] ?? null, new_parent_folder_id: parents[0] ?? null } }],
      note: "Flytt filen tilbake til den forrige mappen."
    };
  }
});

export const driveTrashAdapter: ClassCAdapter = existingTargetAdapter("drive.trash", {
  validate: (p) => (!safeId(p["file_id"]) ? "file_id_invalid" : null),
  judge: (_p, _reads, target) => ({ block: null, warnings: target.trashed ? ["already_trashed"] : [] }),
  state: (m) => ({ trashed: m.trashed, name: m.name, parents: m.parents }),
  expect: () => [{ path: "trashed", op: "equals", value: true }, { path: "name", op: "unchanged" }, { path: "parents", op: "unchanged" }],
  rollback(_p, _m, before) {
    if (before.state["trashed"] === true) return { kind: "none", steps: [], note: "Filen lå allerede i papirkurven; ingenting ble endret." };
    return { kind: "manual", steps: [], note: "Gjenopprett filen fra papirkurven i Drive (trashed=false). Det finnes ingen registrert Jarvis-handling for å hente en fil ut av papirkurven." };
  }
});

export const driveUpdateContentAdapter: ClassCAdapter = existingTargetAdapter("drive.update_content", {
  validate: (p) => (!safeId(p["file_id"]) ? "file_id_invalid" : typeof p["content"] !== "string" ? "content_missing" : null),
  state: (m) => ({ head_revision_id: m.head_revision_id, name: m.name, trashed: m.trashed, parents: m.parents }),
  unobservable: ["content"],
  expect(_p, before, mutation) {
    const was = before.state["head_revision_id"];
    const returned = (mutation.data !== null && typeof mutation.data === "object" && !Array.isArray(mutation.data) ? (mutation.data as Obj)["head_revision_id"] : null) ?? null;
    const revision: ClassCExpectation[] =
      typeof was !== "string"
        ? [{ path: "head_revision_id", op: "unobservable", reason: "file_has_no_head_revision" }]
        : [{ path: "head_revision_id", op: "changed" }, ...(typeof returned === "string" ? [{ path: "head_revision_id", op: "equals" as const, value: returned }] : [])];
    return [...revision, { path: "name", op: "unchanged" }, { path: "trashed", op: "unchanged" }, { path: "parents", op: "unchanged" }];
  },
  rollback(_p, _m, before) {
    const revision = before.state["head_revision_id"];
    return {
      kind: "manual",
      steps: [],
      note: typeof revision === "string"
        ? `Gjenopprett forrige innhold fra Drive-revisjonshistorikken (revisjon ${revision}); det finnes ingen registrert Jarvis-handling for det.`
        : "Filen har ingen revisjons-ID; gjenopprett forrige innhold fra Drive-historikken manuelt."
    };
  }
});

/** `drive.create_file`: opprettelse (ingen eksisterende mål). Forelder leses kun når den er oppgitt. */
export const driveCreateFileAdapter: ClassCAdapter = {
  key: "drive.create_file",
  unobservable: ["content"],
  validate(p) {
    if (typeof p["name"] !== "string" || p["name"].trim() === "") return "name_missing";
    if (p["parent_folder_id"] !== undefined && !safeId(p["parent_folder_id"])) return "parent_folder_id_invalid";
    return null;
  },
  before: {
    reads: (p) => (p["parent_folder_id"] === undefined ? [] : [metaRead("parent", p["parent_folder_id"])]),
    judge(p, reads) {
      if (p["parent_folder_id"] === undefined) return { block: null };
      const parent = metaOf(reads, "parent");
      if (parent === null) return { block: "parent_unreadable" };
      if (parent.mime_type !== GOOGLE_FOLDER_MIME) return { block: "parent_not_folder" };
      return { block: null, warnings: parent.trashed ? ["parent_trashed"] : [] };
    },
    snapshot(p, reads) {
      const parent = p["parent_folder_id"] === undefined ? null : metaOf(reads, "parent");
      return { state: { file: null }, context: { parent_id: parent?.id ?? null, parent_name_present: parent !== null } };
    }
  },
  after: {
    reads(_p, mutation) {
      return mutation.external_id === null || mutation.external_id === "" || !safeId(mutation.external_id) ? null : [metaRead("file", mutation.external_id)];
    },
    snapshot(_p, _m, reads) {
      const meta = metaOf(reads, "file");
      if (meta === null) throw new Error("class_c_drive_metadata_unreadable");
      return { state: { file: { id: meta.id, name: meta.name, trashed: meta.trashed, parents: meta.parents } }, context: { mime_type: meta.mime_type, head_revision_id: meta.head_revision_id, modified_time: meta.modified_time } };
    }
  },
  expect(p, mutation) {
    return [
      { path: "file", op: "present" },
      { path: "file.id", op: "equals", value: mutation.external_id },
      { path: "file.name", op: "equals", value: String(p["name"]) },
      { path: "file.trashed", op: "equals", value: false },
      ...(p["parent_folder_id"] === undefined ? [] : [{ path: "file.parents", op: "equals" as const, value: [String(p["parent_folder_id"])] }])
    ];
  },
  rollback(_p, mutation) {
    if (mutation.external_id === null) return { kind: "manual", steps: [], note: "Ingen fil-ID ble returnert; undersøk i Drive." };
    return {
      kind: "compensating_action",
      steps: [{ tool_id: "drive", action: "trash", parameters: { file_id: mutation.external_id } }],
      note: "Legg den opprettede filen i papirkurven."
    };
  }
};

export const driveClassCAdapters = (): ClassCAdapter[] => [driveCreateFileAdapter, driveUpdateContentAdapter, driveRenameAdapter, driveMoveAdapter, driveTrashAdapter];
