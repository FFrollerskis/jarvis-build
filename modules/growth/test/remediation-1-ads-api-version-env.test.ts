import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleAdsTransport } from "../src/google-ads-transport.ts";
import { MetaAdsTransport } from "../src/meta-ads-transport.ts";
import type { GrowthService } from "../src/service.ts";

/**
 * Remediering del 1 (JARVIS-083/092): `.env.example` leverer `JARVIS_*_ADS_API_VERSION=` (blank).
 * `?? DEFAULT` falt aldri tilbake på en tom streng, så URL-en ble `/v/...` (404).
 */
const growth = {} as GrowthService;
const versionOf = (t: unknown) => (t as { apiVersion: string }).apiVersion;

afterEach(() => vi.unstubAllEnvs());

describe("blank API-versjon i .env gir default, ikke en tom versjon", () => {
  it.each([
    ["JARVIS_GOOGLE_ADS_API_VERSION", () => versionOf(new GoogleAdsTransport(growth)), "v25"],
    ["JARVIS_META_ADS_API_VERSION", () => versionOf(new MetaAdsTransport(growth)), "v26.0"]
  ])("%s", (name, build, defaultVersion) => {
    vi.stubEnv(name, "");
    expect(build()).toBe(defaultVersion);
    vi.stubEnv(name, "   ");
    expect(build()).toBe(defaultVersion);
    vi.stubEnv(name, "v99");
    expect(build()).toBe("v99");
    vi.unstubAllEnvs();
    expect(build()).toBe(defaultVersion);
  });
});
