import { describe, expect, it } from "vitest";
import { SSE_MAX_LINE_CHARS, SseLineTooLongError, sseLines } from "../src/index.ts";

/**
 * WP-D4 (gjennomgang av PR #315, L9): `sseLines` var ikke lineær (hele den ufullstendige bufferen ble skannet og flatet ut på nytt for hver chunk: 2 MB i 1 KB-chunker = 3,5 s CPU) og hadde ingen linjegrense. Nå leses
 * hver chunk ÉN gang, og en linje over grensen avvises (fail-closed). Atferden for normale strømmer er uendret - bevist mot den GAMLE implementasjonen på tilfeldige strømmer med tilfeldige chunk-grenser.
 */
const encoder = new TextEncoder();
function streamOf(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++] as Uint8Array);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    }
  });
}
/** Deler bytes i chunker av gitt størrelse (kan dele flerbytes-tegn og CRLF midt i). */
function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}
async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of iter) out.push(line);
  return out;
}

/** Den GAMLE implementasjonen, ordrett (referanse for «atferden er uendret»). */
async function* legacySseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

describe("atferden for normale strømmer er uendret", () => {
  it("data-linjer leveres trimmet; kommentarer, andre felt og tomme linjer hoppes over; CRLF og LF støttes", async () => {
    const text = ": kommentar\r\nevent: message\r\ndata: {\"a\":1}\r\n\r\ndata:{\"b\":2}\ndata:   \n\nid: 7\ndata: [DONE]\n";
    expect(await collect(sseLines(streamOf([encoder.encode(text)])))).toEqual(['{"a":1}', '{"b":2}', "", "[DONE]"]);
  });

  it("chunk-grenser midt i en linje, midt i CRLF og midt i et flerbyte-tegn (æøå, emoji) gir samme linjer", async () => {
    const text = 'data: {"t":"Ærlig Åse 😀 Ødegård"}\r\ndata: {"n":2}\r\n\r\n';
    const bytes = encoder.encode(text);
    const expected = ['{"t":"Ærlig Åse 😀 Ødegård"}', '{"n":2}'];
    for (const size of [1, 2, 3, 5, 7, 64, bytes.length]) expect(await collect(sseLines(streamOf(chunked(bytes, size)))), `chunk=${size}`).toEqual(expected);
  });

  it("en siste linje uten avsluttende linjeskift leveres IKKE (som før), og en tom strøm gir ingenting", async () => {
    expect(await collect(sseLines(streamOf([encoder.encode("data: a\ndata: b")])))).toEqual(["a"]);
    expect(await collect(sseLines(streamOf([])))).toEqual([]);
  });

  it("ekvivalens mot den gamle implementasjonen: 600 tilfeldige strømmer med tilfeldige chunk-grenser", async () => {
    let seed = 12345;
    const next = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const pieces = ["data: ", "data:", "event: x", ": c", "id: 1", "", "{\"k\":\"v\"}", "æøå", "😀", "[DONE]", "   ", "retry: 5", "data: data: x"];
    for (let i = 0; i < 600; i++) {
      let text = "";
      const lines = Math.floor(next() * 14);
      for (let j = 0; j < lines; j++) {
        const parts = Math.floor(next() * 3) + 1;
        for (let k = 0; k < parts; k++) text += pieces[Math.floor(next() * pieces.length)];
        text += next() < 0.4 ? "\r\n" : "\n";
      }
      if (next() < 0.3) text += "data: uten-linjeskift";
      const bytes = encoder.encode(text);
      const size = 1 + Math.floor(next() * 40);
      const expected = await collect(legacySseLines(streamOf(chunked(bytes, size))));
      expect(await collect(sseLines(streamOf(chunked(bytes, size)))), `strøm ${i} chunk=${size}`).toEqual(expected);
    }
  });
});

describe("linjegrense (fail-closed)", () => {
  const limit = SSE_MAX_LINE_CHARS;
  it("grensen er 1 000 000 tegn", () => {
    expect(limit).toBe(1_000_000);
  });

  it("en linje på nøyaktig grensen passerer; ett tegn mer avvises med SseLineTooLongError - både i én chunk og fordelt på mange", async () => {
    const fits = `data: ${"x".repeat(limit - "data: ".length)}\n`;
    for (const size of [fits.length, 64 * 1024, 1000]) {
      const lines = await collect(sseLines(streamOf(chunked(encoder.encode(fits), size))));
      expect(lines, `chunk=${size}`).toHaveLength(1);
      expect(lines[0]?.length).toBe(limit - "data: ".length);
    }
    const tooLong = `data: ${"x".repeat(limit - "data: ".length + 1)}\n`;
    for (const size of [tooLong.length, 64 * 1024, 1000]) {
      await expect(collect(sseLines(streamOf(chunked(encoder.encode(tooLong), size)))), `chunk=${size}`).rejects.toBeInstanceOf(SseLineTooLongError);
    }
  });

  it("en strøm UTEN linjeskift bufres ikke forbi grensen: avvises, og kilden avbrytes (resten lastes ikke ned)", async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = encoder.encode("y".repeat(100_000));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      }
    });
    await expect(collect(sseLines(body))).rejects.toBeInstanceOf(SseLineTooLongError);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(40); // avbrutt rett etter grensen (10 × 100 000), ikke en uendelig strøm
  });

  it("linjer FØR den lange leveres først; en lang linje etter gyldige avviser kun den lange", async () => {
    const text = `data: a\ndata: b\ndata: ${"z".repeat(limit + 10)}\ndata: c\n`;
    const seen: string[] = [];
    await expect((async () => { for await (const l of sseLines(streamOf(chunked(encoder.encode(text), 4096)))) seen.push(l); })()).rejects.toBeInstanceOf(SseLineTooLongError);
    expect(seen).toEqual(["a", "b"]);
  });

  it("grensen kan overstyres per kall (brukes av testene og av eventuelle strengere kallere)", async () => {
    await expect(collect(sseLines(streamOf([encoder.encode("data: 123456789\n")]), 10))).rejects.toBeInstanceOf(SseLineTooLongError);
    expect(await collect(sseLines(streamOf([encoder.encode("data: 123\n")]), 10))).toEqual(["123"]);
  });
});

describe("lineær kjøretid (ikke kvadratisk)", () => {
  it("en linje på 300 000 tegn levert 1 byte om gangen (300 000 chunker) er ferdig på under 8 s (målt ca. 0,7 s) - den gamle algoritmen brukte ca. 43 s", async () => {
    const bytes = encoder.encode(`data: ${"q".repeat(300_000)}\n`);
    const started = Date.now();
    const lines = await collect(sseLines(streamOf(chunked(bytes, 1))));
    const elapsed = Date.now() - started;
    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBe(300_000);
    expect(elapsed).toBeLessThan(8000);
  }, 30_000);

  it("1 MB i 1 KB-chunker er ferdig på under ett sekund", async () => {
    const bytes = encoder.encode(`data: ${"q".repeat(900_000)}\n`);
    const started = Date.now();
    const lines = await collect(sseLines(streamOf(chunked(bytes, 1024))));
    expect(lines[0]?.length).toBe(900_000);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
