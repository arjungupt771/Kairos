/**
 * Splitting notes into retrievable chunks.
 *
 * - Chunks never cross a page or a heading, so a citation can name an exact page and a section
 *   ("Chapter 4") can be found by label.
 * - Packing is sentence-aware with a small overlap so an idea split at a boundary is still retrievable.
 */

export const CHUNK_SIZE = 1000;
export const CHUNK_OVERLAP = 150;
export const MIN_CHUNK = 200;

export interface PageText {
  /** 1-based page number; null for pasted text / plain files. */
  page: number | null;
  text: string;
}

export interface Chunk {
  id: string;
  /** Order within the document. */
  index: number;
  page: number | null;
  text: string;
  /** Normalised section key such as "chapter 4", when the chunk sits under such a heading. */
  section?: string;
  sectionTitle?: string;
}

// "Chapter 4", "Unit 2: Forces", "Section IV - Waves". Must be a short line of its own.
const HEADING_RE = /^\s*(chapter|unit|section|lesson)\s+(\d{1,3}|[ivxlc]{1,6})\b\s*[:.\-–—]?\s*(.{0,80})$/i;

export interface SectionRef { key: string }

/** Find a section reference inside a user query: "summarize chapter 4" -> { key: "chapter 4" }. */
export function parseSectionRef(query: string): SectionRef | null {
  const m = /\b(chapter|unit|section|lesson)\s+(\d{1,3}|[ivxlc]{1,6})\b/i.exec(query);
  return m ? { key: `${m[1].toLowerCase()} ${m[2].toLowerCase()}` } : null;
}

/** Matches a mention of the section anywhere in running text: key "chapter 4" -> /\bchapter\s+4\b/i */
export function sectionRefRegex(ref: SectionRef): RegExp {
  const [kind, num] = ref.key.split(' ');
  return new RegExp(`\\b${kind}\\s+${num}\\b`, 'i');
}

function parseHeading(line: string): { key: string; title: string } | null {
  if (line.length > 100) return null;
  const m = HEADING_RE.exec(line);
  if (!m) return null;
  const title = m[3].trim();
  // A sentence that merely starts with "Chapter 4 explains ..." is not a heading
  if (/[.!?]$/.test(title) && title.split(/\s+/).length > 4) return null;
  return { key: `${m[1].toLowerCase()} ${m[2].toLowerCase()}`, title };
}

export function cleanRaw(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/([a-z])-\n([a-z])/g, '$1$2'); // re-join words hyphenated across lines
}

interface Segment { section?: string; sectionTitle?: string; paragraphs: string[] }

/** Split one page into segments at heading lines; each segment holds paragraphs (blank-line separated). */
function segmentPage(raw: string, carry: { key?: string; title?: string }): Segment[] {
  const segments: Segment[] = [];
  let current: Segment = { section: carry.key, sectionTitle: carry.title, paragraphs: [] };
  let para: string[] = [];
  const endPara = () => {
    if (para.length) current.paragraphs.push(para.join(' ').replace(/\s+/g, ' ').trim());
    para = [];
  };
  const endSegment = () => {
    endPara();
    if (current.paragraphs.some(p => p.length > 0)) segments.push(current);
  };

  for (const line of cleanRaw(raw).split('\n')) {
    const t = line.trim();
    if (!t) { endPara(); continue; }
    const h = parseHeading(t);
    if (h) {
      endSegment();
      carry.key = h.key; carry.title = h.title;
      current = { section: h.key, sectionTitle: h.title, paragraphs: [t] }; // keep the heading text in the chunk
      continue;
    }
    para.push(t);
  }
  endSegment();
  return segments;
}

const SENTENCE_RE = /(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/;

function hardSplit(s: string, size: number): string[] {
  const out: string[] = [];
  let rest = s.trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function overlapTail(s: string): string {
  if (s.length <= CHUNK_OVERLAP) return '';
  const tail = s.slice(-CHUNK_OVERLAP);
  const space = tail.indexOf(' ');
  const t = space === -1 ? tail : tail.slice(space + 1);
  return t.length >= 20 ? t : '';
}

export function packUnits(paragraphs: string[]): string[] {
  const units = paragraphs.flatMap(p => p.split(SENTENCE_RE)).map(u => u.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const u of units) {
    if (u.length > CHUNK_SIZE) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(...hardSplit(u, CHUNK_SIZE));
      continue;
    }
    if (cur && cur.length + 1 + u.length > CHUNK_SIZE) {
      out.push(cur);
      cur = overlapTail(cur);
    }
    cur = cur ? `${cur} ${u}` : u;
  }
  if (cur.trim()) out.push(cur.trim());

  // A tiny trailing chunk is not worth retrieving on its own
  if (out.length > 1 && out[out.length - 1].length < MIN_CHUNK) {
    const last = out.pop() as string;
    out[out.length - 1] = `${out[out.length - 1]} ${last}`;
  }
  return out;
}

const hasContent = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length >= 20;

export function chunkPages(pages: PageText[], docId: string): Chunk[] {
  const chunks: Chunk[] = [];
  const carry: { key?: string; title?: string } = {};
  for (const p of pages) {
    for (const seg of segmentPage(p.text, carry)) {
      for (const text of packUnits(seg.paragraphs)) {
        if (!hasContent(text)) continue; // page numbers, stray symbols
        const index = chunks.length;
        chunks.push({
          id: `${docId}:${index}`, index, page: p.page, text,
          ...(seg.section ? { section: seg.section, sectionTitle: seg.sectionTitle } : {}),
        });
      }
    }
  }
  return chunks;
}

/** All chunks of a section in reading order, or [] when the document has no such heading. */
export function findSection(chunks: Chunk[], ref: SectionRef): Chunk[] {
  return chunks.filter(c => c.section === ref.key);
}
