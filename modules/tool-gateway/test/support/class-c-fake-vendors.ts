/**
 * WP-AUTH2a (K3): tilstandsfulle falske leverandører (GitHub REST og Google Drive v3) som en erstatning for global `fetch` - slik at de EKTE transportene (`GithubTransport`, `GoogleDriveTransport`) og de EKTE
 * produksjonsdefinisjonene kjøres uendret, uten nettverk. Kun endepunktene transportene faktisk bruker er implementert, og formene er de samme som transportene tolker. Feil kan injiseres per endepunkt.
 */
import { vi } from "vitest";

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface FakePr { number: number; title: string; state: "open" | "closed"; draft: boolean; head: string; base: string; merged: boolean; body: string | null }

export class FakeGithub {
  readonly branches = new Map<string, string>([["main", "sha-main"], ["feature/x", "sha-feature"]]);
  readonly prs: FakePr[] = [];
  readonly requests: string[] = [];
  nextNumber = 1;
  /** Injiserte feil: `"METHOD /path-fragment"` -> HTTP-status. */
  failures = new Map<string, number>();
  /** En «løgnaktig» leverandør: PR-en opprettes med en annen base enn bedt om. */
  forceBase: string | null = null;

  handle(url: URL, init: RequestInit): Response | null {
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (url.host !== "api.github.com" || m === null) return null;
    const method = (init.method ?? "GET").toUpperCase();
    const rest = m[3] ?? "";
    this.requests.push(`${method} ${rest}${url.search}`);
    for (const [key, status] of this.failures) {
      const [fm, ...frag] = key.split(" ");
      if (fm === method && `${rest}${url.search}`.includes(frag.join(" "))) return json(status, { message: "injected_failure" });
    }
    const view = (pr: FakePr) => ({
      number: pr.number, title: pr.title, state: pr.state, draft: pr.draft, head: { ref: pr.head, sha: this.branches.get(pr.head) ?? "sha-unknown" }, base: { ref: pr.base },
      html_url: `https://github.example.invalid/pr/${pr.number}`, merged: pr.merged, mergeable: null, mergeable_state: null
    });
    let b = /^\/branches\/(.+)$/.exec(rest);
    if (b !== null && method === "GET") {
      const name = decodeURIComponent(b[1]!);
      const sha = this.branches.get(name);
      return sha === undefined ? json(404, { message: "Branch not found" }) : json(200, { name, commit: { sha }, protected: false });
    }
    if (rest === "/pulls" && method === "GET") {
      const head = url.searchParams.get("head");
      const base = url.searchParams.get("base");
      const list = this.prs.filter((p) => p.state === (url.searchParams.get("state") ?? "open") && (head === null || `${m[1]}:${p.head}` === head) && (base === null || p.base === base));
      return json(200, list.map(view));
    }
    if (rest === "/pulls" && method === "POST") {
      const body = JSON.parse(String(init.body)) as { title: string; head: string; base: string; body?: string };
      if (this.prs.some((p) => p.state === "open" && p.head === body.head && p.base === body.base)) return json(422, { message: "Validation Failed: A pull request already exists for this head and base" });
      const pr: FakePr = { number: this.nextNumber++, title: body.title, state: "open", draft: false, head: body.head, base: this.forceBase ?? body.base, merged: false, body: body.body ?? null };
      this.prs.push(pr);
      return json(201, { number: pr.number, html_url: `https://github.example.invalid/pr/${pr.number}` });
    }
    b = /^\/pulls\/(\d+)$/.exec(rest);
    if (b !== null) {
      const pr = this.prs.find((p) => p.number === Number(b![1]));
      if (pr === undefined) return json(404, { message: "Not Found" });
      if (method === "GET") return json(200, view(pr));
      if (method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as { state?: "open" | "closed"; title?: string };
        if (patch.state !== undefined) pr.state = patch.state;
        if (patch.title !== undefined) pr.title = patch.title;
        return json(200, view(pr));
      }
    }
    return json(404, { message: `fake_github_unhandled ${method} ${rest}` });
  }
}

export interface FakeFile { id: string; name: string; mimeType: string; trashed: boolean; parents: string[]; headRevisionId: string | null; modifiedTime: string; content: string }

export class FakeDrive {
  readonly files = new Map<string, FakeFile>();
  readonly requests: string[] = [];
  private seq = 1;
  private clock = 0;
  failures = new Map<string, number>();
  /** `rename` svarer OK men endrer ingenting (en leverandør som ikke oppfyller kallet). */
  ignoreRename = false;
  /** Filer får aldri revisjons-ID (Google-egne dokumenttyper). */
  noRevisions = false;

  constructor() {
    this.put({ id: "root", name: "Min disk", mimeType: "application/vnd.google-apps.folder", parents: [] });
    this.put({ id: "folder-a", name: "Mappe A", mimeType: "application/vnd.google-apps.folder", parents: ["root"] });
    this.put({ id: "folder-b", name: "Mappe B", mimeType: "application/vnd.google-apps.folder", parents: ["root"] });
    this.put({ id: "file-1", name: "rapport.txt", mimeType: "text/plain", parents: ["folder-a"], content: "gammelt innhold" });
    this.put({ id: "note-1", name: "notat.txt", mimeType: "text/plain", parents: ["folder-a"], content: "x" });
  }

  put(file: Partial<FakeFile> & Pick<FakeFile, "id" | "name" | "mimeType" | "parents">): FakeFile {
    const full: FakeFile = { trashed: false, headRevisionId: this.noRevisions ? null : `rev-${(this.seq += 1)}`, modifiedTime: this.stamp(), content: "", ...file };
    this.files.set(full.id, full);
    return full;
  }

  private stamp(): string {
    return new Date(Date.UTC(2026, 0, 1, 0, 0, (this.clock += 1))).toISOString();
  }

  private touch(file: FakeFile, newRevision: boolean): void {
    file.modifiedTime = this.stamp();
    if (newRevision && !this.noRevisions) file.headRevisionId = `rev-${(this.seq += 1)}`;
  }

  handle(url: URL, init: RequestInit): Response | null {
    const method = (init.method ?? "GET").toUpperCase();
    if (url.host === "oauth2.googleapis.com") return json(200, { access_token: "fake-access-token", expires_in: 3600 });
    if (url.host !== "www.googleapis.com") return null;
    this.requests.push(`${method} ${url.pathname}${url.search}`);
    for (const [key, status] of this.failures) {
      const [fm, ...frag] = key.split(" ");
      if (fm === method && `${url.pathname}${url.search}`.includes(frag.join(" "))) return json(status, { error: "injected_failure" });
    }
    const view = (f: FakeFile) => ({ id: f.id, name: f.name, mimeType: f.mimeType, trashed: f.trashed, parents: f.parents, headRevisionId: f.headRevisionId, modifiedTime: f.modifiedTime });
    let m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (m !== null) {
      const file = this.files.get(decodeURIComponent(m[1]!));
      if (file === undefined) return json(404, { error: "not_found" });
      if (method === "GET") return json(200, view(file));
      if (method === "PATCH") {
        const body = init.body !== undefined && init.body !== null && init.body !== "" ? (JSON.parse(String(init.body)) as { name?: string; trashed?: boolean }) : {};
        if (body.name !== undefined && !this.ignoreRename) file.name = body.name;
        if (body.trashed !== undefined) file.trashed = body.trashed;
        const add = url.searchParams.get("addParents");
        if (add !== null) {
          const remove = (url.searchParams.get("removeParents") ?? "").split(",").filter((x) => x !== "");
          file.parents = [...file.parents.filter((p) => !remove.includes(p)), add];
        }
        this.touch(file, false);
        return json(200, { id: file.id, name: file.name, parents: file.parents, trashed: file.trashed });
      }
    }
    m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (m !== null && method === "PATCH") {
      const file = this.files.get(decodeURIComponent(m[1]!));
      if (file === undefined) return json(404, { error: "not_found" });
      file.content = String(init.body ?? "");
      this.touch(file, true);
      return json(200, { id: file.id, name: file.name, headRevisionId: file.headRevisionId });
    }
    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const text = String(init.body ?? "");
      const metaJson = /content-type: application\/json[^\r\n]*\r\n\r\n(\{[^\r\n]*\})\r\n/i.exec(text)?.[1] ?? "{}";
      const meta = JSON.parse(metaJson) as { name?: string; mimeType?: string; parents?: string[] };
      const file = this.put({ id: `new-${this.seq += 1}`, name: meta.name ?? "uten navn", mimeType: meta.mimeType ?? "text/plain", parents: meta.parents ?? ["root"] });
      return json(200, { id: file.id, name: file.name, mimeType: file.mimeType, headRevisionId: file.headRevisionId });
    }
    return json(404, { error: `fake_drive_unhandled ${method} ${url.pathname}` });
  }
}

/** Installerer en global `fetch` som ruter til de falske leverandørene; alt annet er en testfeil (aldri ekte nettverk). Returnerer en funksjon som fjerner stubben. */
export function installFakeVendors(vendors: { github?: FakeGithub; drive?: FakeDrive }): () => void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const response = vendors.github?.handle(url, init) ?? vendors.drive?.handle(url, init) ?? null;
    if (response === null) throw new Error(`uventet_nettverkskall_i_test:${url.host}`);
    return response;
  }));
  return () => vi.unstubAllGlobals();
}
