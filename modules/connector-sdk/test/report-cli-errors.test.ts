import { describe, expect, it, vi } from "vitest";

/**
 * WP-I (D-472), review N4: `scripts/report.ts` viste rå unntakstekst (`UVENTET FEIL: <melding>`) og ekkoet et id-argument som kan være et helt token. Nå vises kun navn/kode (gjennom den sentrale redigeringen),
 * og et id-argument vises via `safeIdentifier`. Eget testfilnavn fordi `vi.mock` gjelder hele filen: kittet erstattes av en variant som kaster en melding med et token (reviewens reprodusjon brukte en kastende fake-fabrikk).
 * Token-formede verdier bygges ved KJØRING (aldri som bokstaver i kilden, så gitleaks aldri ser dem).
 */
const { token } = vi.hoisted(() => ({ token: `ghp_${"a1".repeat(18)}` }));

vi.mock("../src/testing.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/testing.ts")>();
  return { ...actual, runConnectorContract: async () => { throw Object.assign(new TypeError(`fake-fabrikken feilet for ${token} ${"y".repeat(30)}`), { code: "ERR_WPI_TEST" }); } };
});

const { main } = await import("../scripts/report.ts");

const capture = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { log: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("review N4: report.ts viser aldri rå unntakstekst eller et uredigert id-argument", () => {
  it("et uventet unntak (token i meldingen) gir `UVENTET FEIL: <navn> (<kode>)` og kode 1 - ingen del av meldingen, ingen token", async () => {
    const r = await capture(["contract", "github"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe("UVENTET FEIL: TypeError (ERR_WPI_TEST)");
    for (const leak of [token, token.slice(0, 12), "fake-fabrikken", "yyyy"]) expect(`${r.out}\n${r.err}`.includes(leak), leak).toBe(false);
  });

  it("--json gir samme redigerte feil (ingen annen vei ut)", async () => {
    const r = await capture(["contract", "stripe", "--json"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe("UVENTET FEIL: TypeError (ERR_WPI_TEST)");
    expect(r.out).toBe("");
  });

  it("et token-formet id-argument (gyldig snake_case) ekkoes aldri: `<redacted>` i stedet, kode 2", async () => {
    expect(token).toMatch(/^[a-z][a-z0-9_]{1,40}$/);
    const r = await capture(["contract", token]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("<redacted>");
    for (const leak of [token, token.slice(0, 12), token.toUpperCase().slice(0, 12)]) expect(`${r.out}\n${r.err}`.includes(leak), leak).toBe(false);
  });

  it("et vanlig ukjent id vises fortsatt (feilmeldingen er nyttig for en person), og ugyldig bruk er uendret", async () => {
    const r = await capture(["contract", "no_such_connector"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no_such_connector");
    expect((await capture(["contract"])).code).toBe(2);
  });
});
