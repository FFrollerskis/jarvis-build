import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlTraceSink, type TraceSpan } from "../src/trace.ts";

/**
 * D-395 (JARVIS-074): JSONL-sporet vokste uten grense. Størrelsesbasert rotasjon: `fil` -> `fil.1` -> ... -> `fil.<maxFiles>`,
 * eldste slettes, og linjer flettes aldri sammen selv med mange samtidige skrivinger.
 */
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const span = (n: number): TraceSpan => ({ trace_id: `t-${n}`, kind: "model_call", name: "x".repeat(40), tenant_id: "tenant", at: "2026-10-04T00:00:00Z", duration_ms: n });
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "jarvis-trace-"));
  dirs.push(d);
  return d;
};
const lines = async (path: string): Promise<TraceSpan[]> =>
  (await readFile(path, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as TraceSpan);

describe("JsonlTraceSink rotasjon", () => {
  it("roterer ved maxBytes, beholder maks maxFiles roterte filer og mister aldri nyeste linjer", async () => {
    const dir = await tmp();
    const file = join(dir, "traces.jsonl");
    const sink = new JsonlTraceSink(file, { maxBytes: 600, maxFiles: 2 });
    for (let i = 0; i < 40; i += 1) await sink.record(span(i));
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(["traces.jsonl", "traces.jsonl.1", "traces.jsonl.2"]); // aldri .3
    for (const n of names) expect((await stat(join(dir, n))).size).toBeLessThanOrEqual(600);
    // Nyeste span ligger i den aktive filen; hver fil har kun hele, gyldige JSON-linjer.
    const active = await lines(file);
    expect(active.at(-1)?.trace_id).toBe("t-39");
    const all = [...(await lines(`${file}.2`)), ...(await lines(`${file}.1`)), ...active].map((s) => s.duration_ms);
    expect(all).toEqual([...all].sort((a, b) => a - b)); // rekkefølgen er bevart på tvers av filene
    expect(all.length).toBeLessThan(40); // eldste er forkastet
  });

  it("serialiserer samtidige skrivinger: ingen sammenflettede/korrupte linjer", async () => {
    const dir = await tmp();
    const file = join(dir, "traces.jsonl");
    const sink = new JsonlTraceSink(file, { maxBytes: 100_000, maxFiles: 1 });
    await Promise.all(Array.from({ length: 200 }, (_, i) => sink.record(span(i))));
    const got = await lines(file);
    expect(got).toHaveLength(200);
    expect(new Set(got.map((s) => s.trace_id)).size).toBe(200);
  });

  it("tar høyde for en eksisterende fil ved oppstart (roterer ved første skriving hvis den allerede er full)", async () => {
    const dir = await tmp();
    const file = join(dir, "traces.jsonl");
    await writeFile(file, `${"y".repeat(900)}\n`, "utf8");
    const sink = new JsonlTraceSink(file, { maxBytes: 500, maxFiles: 1 });
    await sink.record(span(1));
    expect((await readFile(`${file}.1`, "utf8")).startsWith("y")).toBe(true);
    expect((await lines(file)).map((s) => s.trace_id)).toEqual(["t-1"]);
  });

  it("standardverdiene er begrensede (ikke ubegrenset)", async () => {
    const dir = await tmp();
    const sink = new JsonlTraceSink(join(dir, "t.jsonl"));
    await sink.record(span(1));
    expect((await readdir(dir)).sort()).toEqual(["t.jsonl"]);
  });
});
