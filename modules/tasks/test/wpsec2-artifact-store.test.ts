import { describe, expect, it } from "vitest";
import type pg from "pg";
import { ArtifactStore } from "../src/coding.ts";

/** WP-SEC2 (K7b): `ArtifactStore.save` skanner FØRST og kutter (100 000 tegn) etterpå - et token som krysser kuttgrensen blir ikke et halvt token. */
const token = ["gh", "p_"].join("") + "Zx3Qk9Lm2Vb7Nc4Rt8Wy1Hd5Fs6Jg0Pa8TnX";

function fakePool(): { pool: pg.Pool; contents: string[] } {
  const contents: string[] = [];
  const client = { query: async (sql: string, params?: unknown[]) => { if (String(sql).includes("INSERT INTO artifacts") && params) contents.push(String(params[5])); return { rows: [], rowCount: 0 }; }, release: () => undefined };
  return { pool: { connect: async () => client } as unknown as pg.Pool, contents };
}

describe("ArtifactStore.save", () => {
  it("token over kuttgrensen og skjulte/delte hemmeligheter redigeres før lagring", async () => {
    const { pool, contents } = fakePool();
    const store = new ArtifactStore(pool);
    await store.save("t1", "task-1", "log", "test.log", `${"x".repeat(99_989)} ${token}`);
    await store.save("t1", "task-1", "log", "hidden.log", `a ${token.slice(0, 8)}${String.fromCodePoint(0x200b)}${token.slice(8)} b`);
    await store.save("t1", "task-1", "log", "json.log", '{"password":"enkeltord"}');
    expect(contents[0]).not.toContain("ghp_");
    expect(contents[0]!.length).toBeLessThanOrEqual(100_000);
    expect(contents[1]).toBe("a [REDACTED:github_token] b");
    expect(contents[2]).toBe('{"password":"[REDACTED:named_secret]"}');
  });

  it("vanlig innhold er uendret", async () => {
    const { pool, contents } = fakePool();
    await new ArtifactStore(pool).save("t1", "task-1", "log", "ok.log", "✓ 12 tester bestått\nferdig");
    expect(contents[0]).toBe("✓ 12 tester bestått\nferdig");
  });
});
