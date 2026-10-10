import { PageText } from './chunk';

/**
 * PDF text extraction (text-based PDFs only; scanned pages need OCR, which is not supported).
 * The deep import avoids pdf-parse's index.js, which tries to read a test file when it has no parent module.
 */

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 300;

export class PdfError extends Error {
  constructor(message: string) { super(message); this.name = 'PdfError'; }
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse: (buf: Buffer, opts?: any) => Promise<{ numpages: number }> = require('pdf-parse/lib/pdf-parse.js');

// pdf-parse bundles several pdf.js builds. Try the newest first (it reads more real-world files).
const ENGINES = ['v2.0.550', 'v1.10.100'];

export async function extractPdfPages(buf: Buffer): Promise<PageText[]> {
  if (buf.length === 0 || buf.slice(0, 5).toString('latin1') !== '%PDF-') throw new PdfError('Not a PDF file');

  let lastError = 'unknown error';
  for (const version of ENGINES) {
    const pages: PageText[] = [];

    // Same line-joining as pdf-parse's default renderer, but keeping each page separate for citations
    const pagerender = (pageData: any) =>
      pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then((tc: any) => {
        let lastY: number | undefined;
        let text = '';
        for (const item of tc.items) {
          if (lastY === item.transform[5] || lastY === undefined) text += item.str;
          else text += '\n' + item.str;
          lastY = item.transform[5];
        }
        const number = typeof pageData.pageNumber === 'number' ? pageData.pageNumber : (pageData.pageIndex ?? pages.length) + 1;
        pages.push({ page: number, text });
        return text;
      });

    try {
      await pdfParse(buf, { pagerender, max: MAX_PDF_PAGES, version });
      return pages.sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
    } catch (e: any) {
      lastError = String(e?.message ?? 'unknown error').slice(0, 120);
    }
  }
  throw new PdfError(`Could not read this PDF (${lastError})`);
}
