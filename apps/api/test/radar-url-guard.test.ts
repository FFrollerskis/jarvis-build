import { describe, expect, it } from "vitest";
import { RadarHostBlockedError, assertPublicHost, isPublicAddress, normalizeRadarHost, radarHostRejection, type LookupImpl } from "../src/radar-url-guard.ts";

/**
 * L1 (gjennomgang av PR #313): SSRF-vakten for radarkildene var bare syntaktisk. Her testes de tre delene hver for seg - adresseklassifiseringen (hvilke oppløste adresser som aldri er en radarkilde), vertsnormaliseringen/-reglene
 * (punktum-suffiks, fullbredde-punktum, interne suffikser, jokertegn-DNS) og oppløsningen rett før hver henting. Ingen test kaller nettet: `lookupImpl` er alltid falsk.
 */
describe("isPublicAddress: kun offentlig rutbare adresser slipper gjennom", () => {
  const PUBLIC = [
    "8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888",
    // Grensene rett utenfor de private områdene
    "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.0.1", "11.0.0.1", "192.169.0.1", "126.255.255.255", "128.0.0.1",
    // Innebygd offentlig IPv4 er offentlig (NAT64-oversettelse av 8.8.8.8, IPv4-mappet, 6to4)
    "64:ff9b::808:808", "::ffff:8.8.8.8", "::ffff:808:808", "2002:808:808::"
  ];
  const PRIVATE = [
    // IPv4: «dette nettverket», RFC1918, CGNAT/Tailscale, loopback, link-local + skymetadata, dokumentasjon, benchmark, multicast, reservert, broadcast
    "0.0.0.0", "0.1.2.3", "10.0.0.5", "10.255.255.255", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.255.255.254", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    // IPv6: uspesifisert, loopback, unik-lokal, link-local (også med sone-id), site-local, multicast, dokumentasjon, Teredo, discard
    "::", "::1", "fc00::1", "fd12:3456:789a::1", "fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1", "2001:db8::1", "2001::1", "100::1", "3fff::1", "64:ff9b:1::1",
    // IPv4 innebygd i IPv6 skal vurderes som IPv4 - ellers er `::ffff:127.0.0.1` en vei rett forbi loopback-sperren
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:5", "::ffff:169.254.169.254", "::ffff:c0a8:101", "::ffff:100.64.0.1", "::127.0.0.1", "::10.0.0.5",
    "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.5", "2002:7f00:1::", "2002:a9fe:a9fe::1", "2002:a00:5::", "::ffff:0:7f00:1"
  ];
  const UNPARSEABLE = ["", " ", "not-an-ip", "example.com", "1.2.3", "999.1.1.1", "1.2.3.4.5", "::g", "127.0.0.1/8", " 8.8.8.8", "8.8.8.8 ", "0x7f.0.0.1", "2130706433", "[::1]", "1:2:3:4:5:6:7:8:9"];

  it("offentlige adresser (også offentlig IPv4 innebygd i IPv6) godtas", () => {
    for (const ip of PUBLIC) expect(isPublicAddress(ip), ip).toBe(true);
  });
  it("private/loopback/link-local/CGNAT/metadata/unik-lokal/multicast/dokumentasjon og alt IPv4-innebygd i IPv6 avvises", () => {
    for (const ip of PRIVATE) expect(isPublicAddress(ip), ip).toBe(false);
  });
  it("alt som ikke lar seg tolke som en IP-adresse avvises (fail-closed)", () => {
    for (const ip of UNPARSEABLE) expect(isPublicAddress(ip), JSON.stringify(ip)).toBe(false);
  });
});

describe("normalizeRadarHost: samme vert uansett skrivemåte", () => {
  it("små bokstaver, ingen avsluttende punktum (også flere), fullbredde/ideografiske punktum, NFKC og IPv6-klammer", () => {
    expect(normalizeRadarHost("Example.COM")).toBe("example.com");
    expect(normalizeRadarHost("localhost.")).toBe("localhost");
    expect(normalizeRadarHost("localhost...")).toBe("localhost");
    expect(normalizeRadarHost("localhost。")).toBe("localhost");
    expect(normalizeRadarHost("localhost．")).toBe("localhost");
    expect(normalizeRadarHost("localhost｡")).toBe("localhost");
    expect(normalizeRadarHost("foo。localhost。")).toBe("foo.localhost");
    expect(normalizeRadarHost("ＬＯＣＡＬＨＯＳＴ")).toBe("localhost");
    expect(normalizeRadarHost("[::1]")).toBe("::1");
  });
});

describe("radarHostRejection: syntaktiske vertsregler (etter normalisering)", () => {
  it("vanlige offentlige vertsnavn godtas", () => {
    for (const ok of ["example.com", "security.example.com", "github.com", "a.b.example.org", "xn--bcher-kva.example", "registry.npmjs.org", "feeds.example.co.uk", "my-site.example.com", "example.com."]) {
      expect(radarHostRejection(ok), ok).toBeNull();
    }
  });

  it("reviewerens omgåelser avvises: punktum-suffiks, fullbredde-punktum og ukjente interne suffikser", () => {
    const bad: Array<[string, string]> = [
      ["localhost", "single_label_host"], ["localhost.", "single_label_host"], ["foo.localhost.", "reserved_suffix"], ["foo.localhost", "reserved_suffix"], ["metadata.google.internal.", "reserved_suffix"],
      ["printer.local.", "reserved_suffix"], ["x.lan.", "reserved_suffix"], ["localhost。", "single_label_host"], ["foo.local。", "reserved_suffix"],
      ["host.localdomain", "reserved_suffix"], ["router.home.arpa", "reserved_suffix"], ["box.intra", "reserved_suffix"], ["fritz.box", "reserved_suffix"], ["machine.tail1234.ts.net", "reserved_suffix"],
      ["api.default.svc", "reserved_suffix"], ["api.default.svc.cluster.local", "reserved_suffix"], ["nas.home", "reserved_suffix"], ["wiki.corp", "reserved_suffix"], ["wiki.intranet", "reserved_suffix"],
      ["myservice.docker", "reserved_suffix"], ["1.0.0.127.in-addr.arpa", "reserved_suffix"], ["abc.onion", "reserved_suffix"], ["x.test", "reserved_suffix"], ["x.invalid", "reserved_suffix"]
    ];
    for (const [host, reason] of bad) expect(radarHostRejection(host), host).toBe(reason);
  });

  it("jokertegn-DNS med innebygd IP og IP-innebygde navn avvises", () => {
    for (const host of ["127.0.0.1.nip.io", "169.254.169.254.nip.io", "nip.io", "a.sslip.io", "10.0.0.5.sslip.io", "x.xip.io", "localtest.me", "sub.localtest.me", "app.lvh.me", "lvh.me"]) {
      expect(radarHostRejection(host), host).toBe("wildcard_ip_dns");
    }
    for (const host of ["10.0.0.5.example.com", "10-0-0-5.example.com", "127.0.0.1.attacker.example", "192-168-1-1.attacker.example"]) {
      expect(radarHostRejection(host), host).toBe("ip_embedded_name");
    }
  });

  it("IP-litteraler (alle skrivemåter), enkeltlabel og ugyldige tegn avvises", () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "[::1]", "::1", "2130706433", "0x7f000001", "8.8.8.8", "2001:db8::1", "[2001:db8::1]"]) expect(radarHostRejection(host), host).toBe("ip_literal");
    for (const host of ["intranet", "postgres", "api", "infisical"]) expect(radarHostRejection(host), host).toBe("single_label_host");
    for (const host of ["a..b.com", "ex ample.com", "exa_mple.com", "ex%61mple.com", "-.", "a.b/c.com", ""]) expect(radarHostRejection(host), JSON.stringify(host)).not.toBeNull();
  });
});

describe("assertPublicHost: vertsnavnet løses, og ALLE svar må være offentlige", () => {
  const answer = (...addresses: string[]): LookupImpl => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  const reasonOf = async (lookup: LookupImpl, host = "feeds.example.com", timeoutMs = 1_000): Promise<string> => {
    try {
      await assertPublicHost(host, lookup, timeoutMs);
      return "ok";
    } catch (err) {
      return err instanceof RadarHostBlockedError ? err.reason : `uventet: ${String(err)}`;
    }
  };

  it("offentlige svar (A og AAAA) slipper gjennom", async () => {
    expect(await reasonOf(answer("93.184.216.34"))).toBe("ok");
    expect(await reasonOf(answer("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"))).toBe("ok");
  });

  it("ETT privat svar avviser hele kilden - også i en blanding (DNS-rebinding/blandede svar)", async () => {
    for (const bad of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "100.64.0.1", "192.168.0.10", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1"]) {
      expect(await reasonOf(answer(bad)), bad).toBe("blocked_address");
      expect(await reasonOf(answer("93.184.216.34", bad)), `blandet ${bad}`).toBe("blocked_address");
      expect(await reasonOf(answer(bad, "93.184.216.34")), `blandet (rekkefølge) ${bad}`).toBe("blocked_address");
    }
  });

  it("tomt svar, oppslagsfeil, ugyldig svar og tidsavbrudd er egne kategorier og slipper aldri gjennom", async () => {
    expect(await reasonOf(answer())).toBe("dns_empty");
    expect(await reasonOf(async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); })).toBe("dns_failure");
    expect(await reasonOf((() => { throw new Error("synkron feil"); }) as unknown as LookupImpl)).toBe("dns_failure");
    expect(await reasonOf((async () => undefined) as unknown as LookupImpl)).toBe("dns_empty");
    expect(await reasonOf((async () => [{ address: 12345 }]) as unknown as LookupImpl)).toBe("blocked_address");
    expect(await reasonOf((async () => [{}]) as unknown as LookupImpl)).toBe("blocked_address");
    expect(await reasonOf(() => new Promise(() => undefined), "feeds.example.com", 20)).toBe("dns_failure");
  });

  it("oppslaget gjøres på det NORMALISERTE vertsnavnet (ikke `Example.COM.`)", async () => {
    const seen: string[] = [];
    await assertPublicHost("Feeds.Example.COM.", async (host) => { seen.push(host); return [{ address: "93.184.216.34" }]; }, 1_000);
    expect(seen).toEqual(["feeds.example.com"]);
  });

  it("feilen bærer kun en kort kode - aldri vertsnavn, adresse eller feiltekst fra resolveren", async () => {
    try {
      await assertPublicHost("feeds.example.com", async () => { throw new Error("secret-resolver-detail 10.0.0.53"); }, 1_000);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RadarHostBlockedError);
      expect((err as Error).message).toBe("radar_host_blocked:dns_failure");
    }
  });
});
