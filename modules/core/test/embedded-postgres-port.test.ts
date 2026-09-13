import { describe, expect, it } from "vitest";
import { allocateEmbeddedPostgresPort } from "../src/testing/embedded-postgres-port.ts";

/**
 * D-137: portvalget for embedded Postgres i tester MAA ligge strengt under
 * operativsystemets efemere portintervall. Det gamle valget
 * (`30000 + random(20000)`) laa midt i Linux sitt standardintervall
 * (32768-60999), og en utgaaende forbindelse fra en vilkaarlig prosess kunne
 * derfor holde porten paa IPv4. Postgres binder da bare IPv6 + unix-socket,
 * melder likevel "ready", og testen faar ECONNREFUSED mot 127.0.0.1.
 */
describe("D-137: trygt portvalg for embedded Postgres", () => {
  it("returnerer alltid en port under det efemere intervallet, og over well-known-omraadet", () => {
    for (let i = 0; i < 2000; i++) {
      const port = allocateEmbeddedPostgresPort();
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThanOrEqual(10000);
      // 32768 er den konservative nedre grensen for efemere porter paa Linux,
      // og ligger godt under Windows/macOS sitt dynamiske intervall (49152).
      expect(port).toBeLessThan(32768);
    }
  });

  it("treffer aldri det gamle, kolliderende intervallet over 32768", () => {
    const ports = Array.from({ length: 2000 }, () => allocateEmbeddedPostgresPort());
    expect(ports.some((p) => p >= 32768)).toBe(false);
  });

  it("varierer - er ikke en fast port som ville serialisert alle testfiler mot samme adresse", () => {
    const ports = new Set(Array.from({ length: 200 }, () => allocateEmbeddedPostgresPort()));
    expect(ports.size).toBeGreaterThan(50);
  });
});
