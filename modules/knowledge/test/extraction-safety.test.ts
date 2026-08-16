import { describe, expect, it } from "vitest";
import {
  AttachmentTooLargeError,
  MAX_ATTACHMENT_BYTES,
  MAX_PAGES_PER_ATTACHMENT,
  TooManyPagesError,
  assertWithinPageLimit,
  assertWithinSizeLimit,
  classifyFileKind,
  decideExtractionTier,
  sanitizeAttachmentFilename
} from "../src/extraction-safety.ts";

describe("classifyFileKind - deterministisk, KUN basert på MIME-type", () => {
  it("A: tekstlige MIME-typer klassifiseres 'text'", () => {
    for (const mime of ["text/plain", "text/markdown", "text/csv", "application/json", "text/x-something-ny"]) {
      expect(classifyFileKind(mime), mime).toBe("text");
    }
  });
  it("B: application/pdf klassifiseres 'pdf'", () => {
    expect(classifyFileKind("application/pdf")).toBe("pdf");
  });
  it("C: bilde-MIME-typer klassifiseres 'image'", () => {
    for (const mime of ["image/png", "image/jpeg", "image/webp", "image/heic"]) {
      expect(classifyFileKind(mime), mime).toBe("image");
    }
  });
  it("D: arkivformater klassifiseres 'unsupported_archive' - ALDRI 'text'/'unsupported' (må eksplisitt avvises, ikke stille droppes som ukjent)", () => {
    for (const mime of ["application/zip", "application/x-rar-compressed", "application/x-7z-compressed", "application/gzip", "application/x-tar"]) {
      expect(classifyFileKind(mime), mime).toBe("unsupported_archive");
    }
  });
  it("E: docx/xlsx/pptx klassifiseres 'unsupported_office' (D-43 §4: eksplisitt utsatt, ikke stille droppet som ukjent)", () => {
    for (const mime of [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/msword"
    ]) {
      expect(classifyFileKind(mime), mime).toBe("unsupported_office");
    }
  });
  it("F: helt ukjent MIME-type klassifiseres 'unsupported'", () => {
    expect(classifyFileKind("application/x-helt-ukjent-binaerformat")).toBe("unsupported");
  });
  it("G: MIME-type med charset-parameter normaliseres FØR klassifisering (case-insensitiv, semikolon-del fjernet)", () => {
    expect(classifyFileKind("Text/Plain; charset=utf-8")).toBe("text");
    expect(classifyFileKind("APPLICATION/PDF")).toBe("pdf");
  });
});

describe("fail-closed størrelses-/side-grenser", () => {
  it("H: innenfor grensen kaster IKKE", () => {
    expect(() => assertWithinSizeLimit(MAX_ATTACHMENT_BYTES, "f.pdf")).not.toThrow();
    expect(() => assertWithinPageLimit(MAX_PAGES_PER_ATTACHMENT, "f.pdf")).not.toThrow();
  });
  it("I: over størrelsesgrensen kaster en typet AttachmentTooLargeError med filnavn/størrelse", () => {
    try {
      assertWithinSizeLimit(MAX_ATTACHMENT_BYTES + 1, "stor.pdf");
      expect.fail("skulle kastet");
    } catch (err) {
      expect(err).toBeInstanceOf(AttachmentTooLargeError);
      expect((err as AttachmentTooLargeError).filename).toBe("stor.pdf");
      expect((err as AttachmentTooLargeError).sizeBytes).toBe(MAX_ATTACHMENT_BYTES + 1);
    }
  });
  it("J: over sidegrensen kaster en typet TooManyPagesError", () => {
    expect(() => assertWithinPageLimit(MAX_PAGES_PER_ATTACHMENT + 1, "manysider.pdf")).toThrow(TooManyPagesError);
  });
});

describe("decideExtractionTier - deterministisk native→bilde-ekstraksjon-terskel", () => {
  it("K: rikelig native tekst → 'native', INGEN modellkall nødvendig", () => {
    expect(decideExtractionTier("Dette er en side med rikelig med native, ekstrahert tekst fra en PDF.")).toBe("native");
  });
  it("L: tom/nesten-tom native tekst (skannet side) → 'needs_image_extraction'", () => {
    expect(decideExtractionTier("")).toBe("needs_image_extraction");
    expect(decideExtractionTier("   ")).toBe("needs_image_extraction");
    expect(decideExtractionTier("x")).toBe("needs_image_extraction");
  });
  it("M: terskelen er en HARD grense - deterministisk, samme input gir alltid samme svar", () => {
    const borderline = "a".repeat(39);
    const enough = "a".repeat(40);
    expect(decideExtractionTier(borderline)).toBe("needs_image_extraction");
    expect(decideExtractionTier(enough)).toBe("native");
  });
});

describe("sanitizeAttachmentFilename - path-traversal-vern (§7)", () => {
  it("N: et vanlig filnavn beholdes uendret", () => {
    expect(sanitizeAttachmentFilename("faktura.pdf")).toBe("faktura.pdf");
  });
  it("O: katalogkomponenter (unix- OG windows-stil) fjernes - kun siste segment beholdes", () => {
    expect(sanitizeAttachmentFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentFilename("..\\..\\Windows\\System32\\evil.dll")).toBe("evil.dll");
    expect(sanitizeAttachmentFilename("/absolutt/sti/fil.txt")).toBe("fil.txt");
  });
  it("P: degenererte navn (tomt, '.', '..') faller trygt tilbake til 'vedlegg' - ALDRI en tom/farlig streng brukt til fil-sti", () => {
    expect(sanitizeAttachmentFilename("")).toBe("vedlegg");
    expect(sanitizeAttachmentFilename(".")).toBe("vedlegg");
    expect(sanitizeAttachmentFilename("..")).toBe("vedlegg");
    expect(sanitizeAttachmentFilename("../..")).toBe("vedlegg");
  });
  it("Q: null-bytes fjernes (klassisk fil-navn-injeksjon-vektor)", () => {
    const withNullByte = "ok.pdf" + String.fromCharCode(0) + ".exe";
    expect(sanitizeAttachmentFilename(withNullByte)).toBe("ok.pdf.exe");
  });
  it("R: ekstremt langt filnavn trunkeres (DoS-vern - ingen ubegrenset filnavn-lengde videre til filsystemet)", () => {
    const long = "a".repeat(500) + ".pdf";
    expect(sanitizeAttachmentFilename(long).length).toBeLessThanOrEqual(200);
  });
});
