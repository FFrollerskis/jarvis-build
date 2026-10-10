import { webcrypto } from "node:crypto";
import vm from "node:vm";

/**
 * WP-H0: minimal «nettleser» for å kjøre de selvstendige sidene i `apps/web/*.html` (ingen byggesteg, ingen DOM-bibliotek i repoet) i en vm-kontekst. Dekker nøyaktig DOM-flaten kontrollsenter-siden bruker
 * (getElementById/createElement/appendChild/setAttribute/textContent/classList/addEventListener/<dialog>) pluss localStorage, WebCrypto (Ed25519), fetch (skriptet) og location/history.
 * Ikke en generell DOM: det er en testhjelper som lar oss bevise sidens LOGIKK (autentisering, rendering, handlingsflyt, hemmelighetsvask) uten en ekte nettleser.
 */
export class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  className = "";
  open = false;
  disabled = false;
  value = "";
  returnValue = "";
  content = "";
  /** Alle verdier `textContent` har fått (nyeste sist) - lar tester se mellomtilstander som overskrives raskt (f.eks. statuslinjen). */
  readonly history: string[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  private ownText = "";

  constructor(readonly tagName: string, private readonly doc: FakeDocument) {}

  get id(): string { return this.attrs.get("id") ?? ""; }
  get textContent(): string { return this.ownText + this.children.map((c) => c.textContent).join(""); }
  set textContent(value: string) { for (const c of this.children) c.detach(); this.children = []; this.ownText = String(value); this.history.push(this.ownText); }
  get classList(): { add(c: string): void; remove(c: string): void; toggle(c: string, force?: boolean): void; contains(c: string): boolean } {
    const set = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const write = (s: Set<string>) => { this.className = [...s].join(" "); };
    return {
      add: (c) => { const s = set(); s.add(c); write(s); },
      remove: (c) => { const s = set(); s.delete(c); write(s); },
      toggle: (c, force) => { const s = set(); if (force === undefined ? !s.has(c) : force) s.add(c); else s.delete(c); write(s); },
      contains: (c) => set().has(c)
    };
  }

  appendChild(child: FakeElement): FakeElement { child.parent = this; this.children.push(child); if (child.id) this.doc.register(child); return child; }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
    if (name === "id") this.doc.register(this);
  }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  addEventListener(type: string, fn: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: (event: unknown) => void): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }
  dispatch(type: string, event: Record<string, unknown> = {}): void { for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault: () => undefined, target: this, ...event }); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.detach(); }
  focus(): void { this.doc.activeElement = this; }
  showModal(): void { this.open = true; }
  close(returnValue = ""): void { this.returnValue = returnValue; this.open = false; this.dispatch("close"); }
  private detach(): void { this.parent = null; if (this.id) this.doc.unregister(this); }

  /** Alle etterkommere (dybde først) som oppfyller predikatet. */
  findAll(predicate: (el: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => { for (const c of el.children) { if (predicate(c)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  visibilityState = "visible";
  private readonly byId = new Map<string, FakeElement>();
  private owner: { content: string } | null = null;

  constructor(html: string) {
    // Kun markup utenfor <script>/<style> (kode og CSS kan inneholde tekst som ligner på tagger).
    const markup = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
    for (const m of markup.matchAll(/<([a-z0-9]+)\b([^>]*)>/g)) {
      const id = /\sid="([^"]+)"/.exec(m[2] as string)?.[1];
      if (id === undefined) continue;
      const el = new FakeElement(m[1] as string, this);
      el.setAttribute("id", id);
      // Starttilstand fra markup: class="..." (f.eks. hidden).
      const cls = /\sclass="([^"]*)"/.exec(m[2] as string)?.[1];
      if (cls) el.className = cls;
    }
    const meta = /<meta name="jarvis-owner" content="([^"]*)">/.exec(html)?.[1];
    if (meta) this.owner = { content: meta.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">") };
  }

  register(el: FakeElement): void { this.byId.set(el.id, el); }
  unregister(el: FakeElement): void { if (this.byId.get(el.id) === el) this.byId.delete(el.id); }
  getElementById(id: string): FakeElement | null { return this.byId.get(id) ?? null; }
  createElement(tag: string): FakeElement { return new FakeElement(tag, this); }
  querySelector(selector: string): { content: string } | null { return selector.includes("jarvis-owner") ? this.owner : null; }
}

export interface FetchCall { path: string; body: Record<string, unknown> }
export type FetchRoute = (call: FetchCall) => { status?: number; body: unknown } | undefined;

export interface PageHarness {
  document: FakeDocument;
  fetchCalls: FetchCall[];
  storage: Map<string, string>;
  confirmations: string[];
  /** Venter til betingelsen er sann (poller på event-løkken). */
  waitFor(condition: () => boolean, message: string, timeoutMs?: number): Promise<void>;
  byId(id: string): FakeElement;
}

/** Kjører scriptet i `html` (det ene inline-scriptet) i en vm-kontekst med den falske nettleseren. `route` svarer på alle fetch-kall. */
export function runPage(html: string, route: FetchRoute, options: { search?: string; confirm?: (text: string) => boolean } = {}): PageHarness {
  const document = new FakeDocument(html);
  const fetchCalls: FetchCall[] = [];
  const storage = new Map<string, string>();
  const confirmations: string[] = [];
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (script === undefined) throw new Error("fant ikke script i siden");
  const fakeFetch = async (path: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const call = { path, body };
    fetchCalls.push(call);
    const answer = route(call) ?? { status: 404, body: { error: "no_route_in_test" } };
    const status = answer.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => answer.body, text: async () => JSON.stringify(answer.body) };
  };
  const context = vm.createContext({
    document, fetch: fakeFetch, crypto: webcrypto, TextEncoder, URLSearchParams, Date, JSON, Promise, Map, Set, Array, Object, String, Number, Error, Math, btoa,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } },
    location: { search: options.search ?? "", pathname: "/control", hash: "" },
    history: { replaceState: () => undefined },
    console,
    window: { confirm: (text: string) => { confirmations.push(text); return options.confirm ? options.confirm(text) : true; } },
    setInterval: () => 0,
    setTimeout
  });
  vm.runInContext(script, context);
  const waitFor = async (condition: () => boolean, message: string, timeoutMs = 4000) => {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${message}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const byId = (id: string): FakeElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`mangler element ${id}`);
    return el;
  };
  return { document, fetchCalls, storage, confirmations, waitFor, byId };
}
