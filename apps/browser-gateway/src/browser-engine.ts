/**
 * D-339 (Tobias direkte i chat: "playwrite er viktig for at den skal kunne
 * kontrollere mer" - bekrefter branch (a) fra det tidligere D-326-funnet:
 * lokal/selv-hostet nettleserautomasjon, ALDRI en tredjeparts cloud-browser-
 * leverandør). Denne FØRSTE sliceen bygger KUN read-only nettleser-
 * kapabilitet - `navigate`/`extract_text`/`screenshot`. `click`/`fill_form`/
 * `submit` (mutasjon av tredjeparts nettsider) er BEVISST IKKE bygget denne
 * sliceen - domene-allowlist/denylist-vokterdesign for en handling som kan
 * trigge ekte innsending/kjøp/pålogging er en EGEN, fersk D-41-vurdering,
 * ALDRI gjettet frem sammen med read-only-delen (samme "konservativ FØRSTE
 * slice"-disiplin som D-338 sin MCP-discovery-uten-invokering).
 *
 * `BrowserEngine` er et EGET, testbart grensesnitt (SAMME "fake i test, ekte
 * i drift"-mønster som `ToolTransport`/`FakeTransport` i
 * `modules/tool-gateway`) - `PlaywrightBrowserEngine` er den ENESTE
 * implementasjonen som faktisk starter en nettleser; alle andre tester i
 * denne pakken bruker en fake, slik at CI ALDRI trenger å starte en ekte
 * Chromium-prosess for denne sliceen (host-akseptanse med en EKTE nettleser
 * forblir PENDING, se `BROWSER_GATEWAY_LIVE_GATE` i DECISIONS_AND_ASSUMPTIONS.md).
 */
export interface BrowserEngine {
  navigate(url: string): Promise<{ url: string; title: string }>;
  extractText(): Promise<string>;
  screenshot(): Promise<string>;
  close(): Promise<void>;
}

const VALID_URL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

export function assertNavigableUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw new Error("browser_gateway_missing_url");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("browser_gateway_invalid_url");
  }
  if (!VALID_URL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("browser_gateway_unsupported_url_protocol");
  }
  return parsed.toString();
}

/**
 * Lat, delt Chromium-instans (én per prosess - denne prosessen ER den
 * "egen prosess"-isolasjonen CLAUDE.md regel 5 krever, se D-212/voice-
 * gateway sin presedens). `page` gjenbrukes på tvers av kall (SAMME sesjon -
 * `extract_text`/`screenshot` handler alltid om SISTE `navigate()`-mål,
 * uendret fra hva en ekte nettleser-fane ville gjort).
 */
export class PlaywrightBrowserEngine implements BrowserEngine {
  private browserPromise: Promise<import("playwright").Browser> | undefined;
  private pagePromise: Promise<import("playwright").Page> | undefined;

  private async launch() {
    const { chromium } = await import("playwright");
    return chromium.launch({ headless: true });
  }

  private async page(): Promise<import("playwright").Page> {
    if (!this.browserPromise) {
      this.browserPromise = this.launch();
    }
    if (!this.pagePromise) {
      this.pagePromise = this.browserPromise.then((browser) => browser.newPage());
    }
    return this.pagePromise;
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    const safeUrl = assertNavigableUrl(url);
    const page = await this.page();
    await page.goto(safeUrl, { waitUntil: "load" });
    return { url: page.url(), title: await page.title() };
  }

  async extractText(): Promise<string> {
    const page = await this.page();
    return page.innerText("body");
  }

  async screenshot(): Promise<string> {
    const page = await this.page();
    const buffer = await page.screenshot({ type: "png" });
    return buffer.toString("base64");
  }

  async close(): Promise<void> {
    if (this.browserPromise) {
      const browser = await this.browserPromise;
      await browser.close();
    }
    this.browserPromise = undefined;
    this.pagePromise = undefined;
  }
}
