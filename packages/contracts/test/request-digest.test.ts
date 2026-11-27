import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REQUEST_DIGEST_EXCLUDED_PARAMETERS,
  REQUEST_DIGEST_MAX_DEPTH,
  REQUEST_DIGEST_TEST_VECTORS,
  REQUEST_DIGEST_VERSION,
  RequestDigestError,
  canonicalRequest,
  canonicalStringify,
  canonicalizeStrict,
  hashApprovalParameters,
  parametersDigest,
  requestDigest,
  requestDigestBody,
  toStrictJson,
  type JsonValue,
  type RequestDigestErrorCode
} from "../src/index.ts";

/**
 * WP-T1 K1 (JARVIS-102, Q-65 pkt 1): ÉN kanonisering og ÉN digest. Testen låser (1) de publiserte testvektorene mot en uavhengig sha256 over en HÅNDSKREVET kanonisk streng (aldri samme funksjon som
 * produserer verdien), (2) stabiliteten (nøkkelrekkefølge, tall, JSON-tekstform), (3) avvisningene (NaN/Infinity/sykler/ikke-JSON), (4) at digesten bruker NØYAKTIG samme serialisering som godkjenningenes
 * `parameters_hash` (ingen andre kanonisering), og (5) Unicode: INGEN normalisering (NFC og NFD er ulike forespørsler - bevisst, se runbook).
 */
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const base = { tool_id: "calendar", action: "create_event", tenant_id: "tenant-a", person_id: "person-1" } as const;

describe("request_digest: konstanter og form", () => {
  it("versjon 1; `idempotency_key` er det eneste utelatte parameterfeltet", () => {
    expect(REQUEST_DIGEST_VERSION).toBe(1);
    expect([...REQUEST_DIGEST_EXCLUDED_PARAMETERS]).toEqual(["idempotency_key"]);
    expect(REQUEST_DIGEST_MAX_DEPTH).toBe(64);
  });

  it("digesten er 64 hex-tegn og kroppen har nøyaktig feltene v, tool_id, action, parameters, tenant_id, person_id", () => {
    const body = requestDigestBody({ ...base, parameters: { a: 1 } }) as Record<string, JsonValue>;
    expect(Object.keys(body).sort()).toEqual(["action", "parameters", "person_id", "tenant_id", "tool_id", "v"]);
    expect(body["v"]).toBe(1);
    expect(requestDigest({ ...base, parameters: { a: 1 } })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("publiserte testvektorer (håndskrevet kanonisk streng -> sha256, uavhengig av implementasjonen)", () => {
  it("minst 12 vektorer, unike navn og unike digest", () => {
    expect(REQUEST_DIGEST_TEST_VECTORS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(REQUEST_DIGEST_TEST_VECTORS.map((v) => v.name)).size).toBe(REQUEST_DIGEST_TEST_VECTORS.length);
  });

  for (const vector of REQUEST_DIGEST_TEST_VECTORS) {
    it(`vektor ${vector.name}: kanonisk streng og digest er som publisert`, () => {
      expect(canonicalRequest(vector.input)).toBe(vector.canonical);
      expect(sha(vector.canonical)).toBe(vector.digest);
      expect(requestDigest(vector.input)).toBe(vector.digest);
    });
  }

  it("vektor `simple`: den kanoniske strengen er nøyaktig det spesifikasjonen sier (sorterte nøkler, ingen mellomrom)", () => {
    const v = REQUEST_DIGEST_TEST_VECTORS.find((x) => x.name === "simple")!;
    expect(v.canonical).toBe('{"action":"create_event","parameters":{"start":"2026-11-26T10:00:00Z","title":"Møte"},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}');
  });
});

describe("stabilitet", () => {
  const params = { title: "Møte", start: "2026-11-26T10:00:00Z", attendees: [{ name: "A", id: 1 }, { id: 2, name: "B" }], nested: { z: 1, a: { y: null, x: true } } };

  it("nøkkelrekkefølge (også nøstet) endrer ikke digesten", () => {
    const reordered = { nested: { a: { x: true, y: null }, z: 1 }, attendees: [{ id: 1, name: "A" }, { name: "B", id: 2 }], start: "2026-11-26T10:00:00Z", title: "Møte" };
    expect(requestDigest({ ...base, parameters: reordered })).toBe(requestDigest({ ...base, parameters: params }));
  });

  it("rekkefølgen i en LISTE er en del av forespørselen (annen rekkefølge = annen digest)", () => {
    const swapped = { ...params, attendees: [params.attendees[1]!, params.attendees[0]!] };
    expect(requestDigest({ ...base, parameters: swapped })).not.toBe(requestDigest({ ...base, parameters: params }));
  });

  it("tall: 1, 1.0 og 1e0 er samme tall; -0 er 0; ECMAScript-formatet (1e21, 1e-7) er kanonisk", () => {
    const a = JSON.parse('{"n":1.0,"m":1e0,"z":-0,"big":1e21,"small":1e-7}') as Record<string, JsonValue>;
    const b = { n: 1, m: 1, z: 0, big: 1000000000000000000000, small: 0.0000001 };
    expect(requestDigest({ ...base, parameters: a })).toBe(requestDigest({ ...base, parameters: b }));
    expect(canonicalizeStrict(a)).toBe('{"big":1e+21,"m":1,"n":1,"small":1e-7,"z":0}');
    expect(canonicalizeStrict({ x: 0.1 + 0.2 })).toBe('{"x":0.30000000000000004}');
    expect(canonicalizeStrict({ x: 5e-324 })).toBe('{"x":5e-324}');
    expect(canonicalizeStrict({ x: Number.MAX_VALUE })).toBe('{"x":1.7976931348623157e+308}');
  });

  it("JSON-tekstform er irrelevant: mellomrom, linjeskift og \\u-escapes gir samme digest som de dekodede tegnene", () => {
    const text = '{\n  "title" : "M\\u00f8te",\n  "tags": [ "a" ,"b" ]\n}';
    const compact = { title: "Møte", tags: ["a", "b"] };
    expect(requestDigest({ ...base, parameters: JSON.parse(text) as Record<string, JsonValue> })).toBe(requestDigest({ ...base, parameters: compact }));
  });

  it("`idempotency_key` i parametrene teller ikke med (retry-korrelasjon er ikke nyttelast), men andre felt gjør det", () => {
    const withKey = { ...params, idempotency_key: "k-0001-aaaa" };
    expect(requestDigest({ ...base, parameters: withKey })).toBe(requestDigest({ ...base, parameters: params }));
    expect(requestDigest({ ...base, parameters: { ...params, idempotency_key_2: "x" } })).not.toBe(requestDigest({ ...base, parameters: params }));
    // KUN toppnivå: et nøstet felt med samme navn er nyttelast.
    expect(requestDigest({ ...base, parameters: { inner: { idempotency_key: "a" } } })).not.toBe(requestDigest({ ...base, parameters: { inner: {} } }));
  });

  it("per-definisjon-utelatelse (`exclude_parameters`): kun toppnivåfelt, kun de navngitte, og i tillegg til idempotency_key", () => {
    const a = requestDigest({ ...base, parameters: { value: "s1", ref: "R", idempotency_key: "k" }, exclude_parameters: ["value"] });
    const b = requestDigest({ ...base, parameters: { value: "ANNEN", ref: "R" }, exclude_parameters: ["value"] });
    expect(a).toBe(b);
    expect(requestDigest({ ...base, parameters: { value: "s1", ref: "R2" }, exclude_parameters: ["value"] })).not.toBe(a);
    expect(requestDigest({ ...base, parameters: { value: "s1", ref: "R" } })).not.toBe(requestDigest({ ...base, parameters: { value: "s2", ref: "R" } }));
  });

  it("`undefined`-egenskaper utelates (som JSON.stringify), men `undefined` i en liste avvises", () => {
    expect(requestDigest({ ...base, parameters: { a: 1, b: undefined } })).toBe(requestDigest({ ...base, parameters: { a: 1 } }));
    expect(() => requestDigest({ ...base, parameters: { a: [1, undefined] } })).toThrow(RequestDigestError);
  });

  it("hvert av feltene tool_id, action, tenant_id, person_id og parameters påvirker digesten", () => {
    const ref = requestDigest({ ...base, parameters: { a: 1 } });
    expect(requestDigest({ ...base, tool_id: "calendar2", parameters: { a: 1 } })).not.toBe(ref);
    expect(requestDigest({ ...base, action: "create_event2", parameters: { a: 1 } })).not.toBe(ref);
    expect(requestDigest({ ...base, tenant_id: "tenant-b", parameters: { a: 1 } })).not.toBe(ref);
    expect(requestDigest({ ...base, person_id: "person-2", parameters: { a: 1 } })).not.toBe(ref);
    expect(requestDigest({ ...base, parameters: { a: 2 } })).not.toBe(ref);
    expect(requestDigest({ ...base, parameters: { a: 1, b: null } })).not.toBe(ref);
    expect(requestDigest({ ...base, parameters: { a: "1" } })).not.toBe(ref);
  });

  it("feltgrensene er entydige: tool_id og action kan ikke flyttes mellom feltene (a.b + c != a + b.c)", () => {
    expect(requestDigest({ ...base, tool_id: "a.b", action: "c", parameters: {} })).not.toBe(requestDigest({ ...base, tool_id: "a", action: "b.c", parameters: {} }));
    expect(requestDigest({ ...base, tenant_id: "t", person_id: "p-x", parameters: {} })).not.toBe(requestDigest({ ...base, tenant_id: "t-p", person_id: "x", parameters: {} }));
  });
});

describe("Unicode: ingen normalisering, nøkler sorteres på UTF-16-kodeenheter", () => {
  // Bygget av kodepunkter (aldri literal): et redigeringsverktøy kan ellers normalisere tegnene uten at noen merker det.
  const nfc = String.fromCodePoint(0x63, 0x61, 0x66, 0xe9);
  const nfd = String.fromCodePoint(0x63, 0x61, 0x66, 0x65, 0x301);
  it("NFC og NFD av samme tekst er ULIKE forespørsler (bevisst: digesten skal ikke avhenge av plattformens Unicode-tabeller, og det som utføres er det som er bundet)", () => {
    expect(nfc).not.toBe(nfd);
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));
    expect(requestDigest({ ...base, parameters: { name: nfc } })).not.toBe(requestDigest({ ...base, parameters: { name: nfd } }));
    expect(requestDigest({ ...base, parameters: { [nfc]: 1 } })).not.toBe(requestDigest({ ...base, parameters: { [nfd]: 1 } }));
  });

  it("gjentatt beregning gir samme svar (ingen avhengighet av locale: sortering er kodeenhetsrekkefølge, ikke localeCompare)", () => {
    const keys = ["b", "B", "a", "_", String.fromCodePoint(0xe9), "z", String.fromCodePoint(0xc5)];
    const obj = Object.fromEntries(keys.map((k, i) => [k, i])) as Record<string, JsonValue>;
    expect(canonicalizeStrict(obj)).toBe(`{${[...keys].sort().map((k) => `${JSON.stringify(k)}:${String(keys.indexOf(k))}`).join(",")}}`);
    expect(Object.keys(JSON.parse(canonicalizeStrict(obj)) as object)).toEqual(["B", "_", "a", "b", "z", String.fromCodePoint(0xc5), String.fromCodePoint(0xe9)]);
  });

  it("UTF-16-rekkefølge, ikke kodepunkt-rekkefølge: en astral nøkkel (surrogatpar 0xD83D...) sorterer FØR U+FF5E (som i RFC 8785)", () => {
    const astral = String.fromCodePoint(0x1f600);
    const fullwidthTilde = String.fromCodePoint(0xff5e);
    const out = canonicalizeStrict({ [fullwidthTilde]: 1, [astral]: 2 });
    expect(out).toBe(`{"${astral}":2,"${fullwidthTilde}":1}`);
  });

  it("emoji og skilletegn (U+2028) serialiseres som JSON.stringify gjør (kun nødvendig escaping)", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const lineSep = String.fromCodePoint(0x2028);
    const raw = `a${emoji}${lineSep}b"\\\n`;
    expect(canonicalizeStrict({ t: raw })).toBe(`{"t":${JSON.stringify(raw)}}`);
    // JSON.stringify skriver U+2028 som det er (ikke som en escape): kontrollert mot den håndskrevne formen.
    expect(canonicalizeStrict({ t: raw })).toBe(`{"t":"a${emoji}${lineSep}b\\"\\\\\\n"}`);
  });
});

describe("avvisning (fail-closed): ingenting som ikke er ren JSON får en digest", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic["self"] = cyclic;
  const cyclicArray: unknown[] = [1];
  cyclicArray.push(cyclicArray);
  class Foo { x = 1; }
  const accessor = Object.defineProperty({}, "a", { enumerable: true, get: () => 1 });
  const withSymbolKey = { [Symbol("s")]: 1 } as Record<string, unknown>;
  const lone = String.fromCharCode(0xd800);
  const deep = (n: number): Record<string, unknown> => { let o: Record<string, unknown> = { leaf: 1 }; for (let i = 0; i < n; i += 1) o = { k: o }; return o; };
  const cases: Array<[string, Record<string, unknown>, RequestDigestErrorCode]> = [
    ["NaN", { a: Number.NaN }, "non_finite_number"],
    ["Infinity", { a: Number.POSITIVE_INFINITY }, "non_finite_number"],
    ["-Infinity", { a: [1, Number.NEGATIVE_INFINITY] }, "non_finite_number"],
    ["syklisk objekt", cyclic, "cycle"],
    ["syklisk liste", { a: cyclicArray }, "cycle"],
    ["bigint", { a: 1n }, "unsupported_type"],
    ["symbol", { a: Symbol("x") }, "unsupported_type"],
    ["funksjon", { a: () => 1 }, "unsupported_type"],
    ["Date", { a: new Date(0) }, "unsupported_type"],
    ["Map", { a: new Map() }, "unsupported_type"],
    ["Set", { a: new Set() }, "unsupported_type"],
    ["klasseinstans", { a: new Foo() }, "unsupported_type"],
    ["accessor-egenskap (getter)", { a: accessor }, "unsupported_type"],
    ["symbolnøkkel", { a: withSymbolKey }, "unsupported_type"],
    ["undefined i liste", { a: [undefined] }, "undefined_in_array"],
    ["hull i liste", { a: [1, , 3] }, "undefined_in_array"], // eslint-disable-line no-sparse-arrays
    ["ensomt surrogat i verdi", { a: `x${lone}y` }, "lone_surrogate"],
    ["ensomt surrogat i nøkkel", { [`k${lone}`]: 1 }, "lone_surrogate"],
    [`dybde over ${REQUEST_DIGEST_MAX_DEPTH}`, deep(REQUEST_DIGEST_MAX_DEPTH + 1), "too_deep"]
  ];
  for (const [name, parameters, code] of cases) {
    it(`${name} -> RequestDigestError(${code})`, () => {
      let thrown: unknown;
      try { requestDigest({ ...base, parameters: parameters as Record<string, JsonValue> }); } catch (err) { thrown = err; }
      expect(thrown).toBeInstanceOf(RequestDigestError);
      expect((thrown as RequestDigestError).code).toBe(code);
      expect((thrown as RequestDigestError).message).toContain(code);
    });
  }

  it("dybde nøyaktig ved grensen er akseptert; feilen bærer en sti til det ugyldige feltet (aldri verdien)", () => {
    expect(() => requestDigest({ ...base, parameters: deep(REQUEST_DIGEST_MAX_DEPTH - 2) as Record<string, JsonValue> })).not.toThrow();
    try { requestDigest({ ...base, parameters: { a: [{ b: Number.NaN }] } as Record<string, JsonValue> }); throw new Error("skulle kastet"); } catch (err) {
      expect((err as RequestDigestError).path).toBe("$.parameters.a[0].b");
      expect((err as RequestDigestError).message).not.toContain("NaN");
    }
  });

  it("parameters må være et rent objekt (ikke liste, null, tekst, tall, Map, Date, klasseinstans): kode `not_plain_object` med sti `$.parameters` (nøstede ikke-rene verdier har `unsupported_type`)", () => {
    class Holder { a = 1; }
    for (const bad of [[1], null, "x", 5, new Map(), new Date(0), new Holder(), undefined]) {
      let thrown: unknown;
      try { requestDigest({ ...base, parameters: bad as never }); } catch (err) { thrown = err; }
      expect(thrown, String(bad)).toBeInstanceOf(RequestDigestError);
      expect((thrown as RequestDigestError).code, String(bad)).toBe("not_plain_object");
      expect((thrown as RequestDigestError).path, String(bad)).toBe("$.parameters");
    }
    expect(() => requestDigest({ ...base, parameters: Object.create(null) as Record<string, JsonValue> })).not.toThrow();
  });

  it("en nøkkel som heter `__proto__` er en vanlig egenskap (aldri prototypen): den inngår i kanoniseringen, også nøstet, og endrer digesten", () => {
    const withObject = JSON.parse('{"__proto__":{"role":"owner"},"a":1}') as Record<string, JsonValue>;
    const withPrimitive = JSON.parse('{"__proto__":1,"a":1}') as Record<string, JsonValue>;
    expect(canonicalRequest({ ...base, parameters: withObject })).toContain('"parameters":{"__proto__":{"role":"owner"},"a":1}');
    expect(canonicalRequest({ ...base, parameters: withPrimitive })).toContain('"parameters":{"__proto__":1,"a":1}');
    expect(canonicalRequest({ ...base, parameters: { n: JSON.parse('{"__proto__":{"x":2}}') as JsonValue } })).toContain('"n":{"__proto__":{"x":2}}');
    const digests = new Set([withObject, withPrimitive, { a: 1 }].map((parameters) => requestDigest({ ...base, parameters })));
    expect(digests.size).toBe(3);
    // Kopien har fortsatt Object.prototype (en `__proto__`-nøkkel i kilden satte aldri prototypen), og nøkkelen er en egen, tellbar egenskap.
    const copy = toStrictJson(withObject) as Record<string, JsonValue>;
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.keys(copy).sort()).toEqual(["__proto__", "a"]);
  });

  it("tool_id, action, tenant_id og person_id må være ikke-tomme, velformede tekster", () => {
    for (const field of ["tool_id", "action", "tenant_id", "person_id"] as const) {
      for (const bad of ["", 5, null, undefined, `a${lone}`]) {
        let thrown: unknown;
        try { requestDigest({ ...base, [field]: bad as never, parameters: {} }); } catch (err) { thrown = err; }
        expect(thrown, `${field}=${String(bad)}`).toBeInstanceOf(RequestDigestError);
        // Et ensomt surrogat har sin egen, presise kode; alt annet (tom, ikke-tekst) er `invalid_input`.
        expect((thrown as RequestDigestError).code).toBe(typeof bad === "string" && bad.length > 0 ? "lone_surrogate" : "invalid_input");
        expect((thrown as RequestDigestError).path).toBe(`$.${field}`);
      }
    }
  });

  it("`toStrictJson` gir en dyp kopi (en senere endring av kilden endrer ikke den validerte kopien)", () => {
    const source = { a: { b: [1, 2] } };
    const copy = toStrictJson(source) as { a: { b: number[] } };
    source.a.b.push(3);
    expect(copy.a.b).toEqual([1, 2]);
  });
});

describe("ÉN kanonisering: samme serialisering som godkjenningenes `parameters_hash` og `canonicalStringify`", () => {
  /** Deterministisk pseudo-generator (mulberry32): samme tall hver gang, ingen avhengighet av Math.random. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const alphabet = ["a", "b", "key", String.fromCodePoint(0xc5), String.fromCodePoint(0xe9), "0", "_", " ", "tool", String.fromCodePoint(0x1f600), "x y", "\\", "\""];
  function gen(r: () => number, depth: number): JsonValue {
    const pick = Math.floor(r() * (depth > 3 ? 5 : 7));
    switch (pick) {
      case 0: return null;
      case 1: return r() < 0.5;
      case 2: return Math.floor(r() * 2000) - 1000;
      case 3: return (r() - 0.5) * 10 ** Math.floor(r() * 30 - 10);
      case 4: return Array.from({ length: Math.floor(r() * 4) }, () => alphabet[Math.floor(r() * alphabet.length)]!).join("");
      case 5: return Array.from({ length: Math.floor(r() * 4) }, () => gen(r, depth + 1));
      default: {
        const o: Record<string, JsonValue> = {};
        const n = Math.floor(r() * 5);
        for (let i = 0; i < n; i += 1) o[Array.from({ length: 1 + Math.floor(r() * 3) }, () => alphabet[Math.floor(r() * alphabet.length)]!).join("")] = gen(r, depth + 1);
        return o;
      }
    }
  }

  it("1000 tilfeldige (seedede) gyldige verdier: canonicalizeStrict == canonicalStringify og parametersDigest == hashApprovalParameters", () => {
    const r = rng(20261126);
    let objects = 0;
    for (let i = 0; i < 1000; i += 1) {
      const value = gen(r, 0);
      expect(canonicalizeStrict(value)).toBe(canonicalStringify(value));
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        objects += 1;
        expect(parametersDigest(value)).toBe(hashApprovalParameters(value));
      }
    }
    expect(objects).toBeGreaterThan(100);
  });

  it("`parametersDigest` utelater idempotency_key; `hashApprovalParameters` (godkjenningen) gjør det IKKE - derfor er de like kun når feltet ikke finnes", () => {
    const p = { a: 1, idempotency_key: "k-1" };
    expect(parametersDigest(p)).toBe(parametersDigest({ a: 1 }));
    expect(parametersDigest({ a: 1 })).toBe(hashApprovalParameters({ a: 1 }));
    expect(hashApprovalParameters(p)).not.toBe(hashApprovalParameters({ a: 1 }));
  });

  it("requestDigest er sha256 over nøyaktig `canonicalStringify` av kroppen (ingen egen serializer)", () => {
    const input = { ...base, parameters: { b: [1, { d: 2, c: 3 }], a: "x" } };
    expect(canonicalRequest(input)).toBe(canonicalStringify(requestDigestBody(input)));
    expect(requestDigest(input)).toBe(sha(canonicalStringify(requestDigestBody(input))));
  });
});
