import { PDFParse } from "pdf-parse";
import type { ImageInput } from "./ocr-provider.ts";

/**
 * UA-2 P1B-A (D-44): tynn wrapper rundt `pdf-parse` v2 sin `PDFParse`-klasse
 * (wrapper rundt `pdfjs-dist` + `@napi-rs/canvas` - prebygd native binær,
 * INGEN systemavhengighet). Native tekst-lag (`nativeTextByPage`) OG side-
 * rasterisering til bilde (`renderPageToImage`, for OCR/vision-fallback) i
 * ÉN avhengighet - se D-44 for hvorfor dette OPPGRADERTE den opprinnelige,
 * mer forsiktige D-43-antakelsen. En instans er bundet til ÉN PDF - kalleren
 * MÅ kalle `destroy()` (typisk i en `finally`) for å frigjøre PDF.js sine
 * interne ressurser.
 */
export class PdfExtractor {
  private readonly parser: PDFParse;

  constructor(bytes: Buffer) {
    this.parser = new PDFParse({ data: new Uint8Array(bytes) });
  }

  async pageCount(): Promise<number> {
    const info = await this.parser.getInfo();
    return info.total;
  }

  /** Per-side RÅ native tekst-lag (tom streng for en side uten tekst-lag, f.eks. en skannet side). */
  async nativeTextByPage(): Promise<Map<number, string>> {
    const result = await this.parser.getText();
    return new Map(result.pages.map((p) => [p.num, p.text]));
  }

  /** Rasterer ÉN side til et PNG-bilde - kun kalt for sider under `decideExtractionTier()`-terskelen (bevisst ikke gjort for HELE dokumentet på forhånd - unødvendig kostnad for sider som allerede har native tekst). */
  async renderPageToImage(pageNumber: number): Promise<ImageInput> {
    const result = await this.parser.getScreenshot({ partial: [pageNumber], imageBuffer: true, imageDataUrl: false });
    const page = result.pages[0];
    if (!page?.data) throw new Error(`pdf_page_render_failed_${pageNumber}`);
    return { media_type: "image/png", data: Buffer.from(page.data).toString("base64") };
  }

  async destroy(): Promise<void> {
    await this.parser.destroy();
  }
}
