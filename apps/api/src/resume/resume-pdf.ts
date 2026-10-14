/**
 * Lays out a saved résumé version as an A4 PDF (RESUME-GEN). Synchronous rendering of text the student
 * already reviewed — no model, no network, no stored file. pdfkit embeds subsets of Inter (Latin) and Noto
 * Sans Telugu (Telugu), both SIL OFL 1.1, bundled in apps/api/assets/fonts; each run of text is drawn in the
 * font that has its glyphs, so Telugu is shaped rather than drawn as empty boxes.
 *
 * Everything drawn goes through `draw`, which reports each string to an optional sink: the contract test
 * reads exactly what reaches the page. Design: docs/architecture/student-resumes-table-design.md.
 */
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import type { ResumeContentV1, ResumeTemplate } from './resume-content.js';

const FONT_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const FONTS = {
  regular: 'Inter-Regular.ttf', semibold: 'Inter-SemiBold.ttf', bold: 'Inter-Bold.ttf',
  teluguRegular: 'NotoSansTelugu-Regular.ttf', teluguBold: 'NotoSansTelugu-Bold.ttf',
} as const;

/** Fixed words ONE adds around the student's content. */
export const RESUME_HEADINGS = {
  summary: 'Summary', objective: 'Career objective', education: 'Education', skills: 'Skills', projects: 'Projects',
  certificates: 'Certificates', languages: 'Languages', declaredSkills: 'Self-declared skills', selfDeclared: 'self-declared',
  generated: 'Generated',
} as const;

type Weight = 'regular' | 'semibold' | 'bold';

interface Style {
  readonly margin: number;
  readonly name: number;
  readonly heading: number;
  readonly body: number;
  readonly small: number;
  readonly gap: number;
  readonly ink: string;
  readonly muted: string;
  readonly accent: string;
  readonly verified: string;
  readonly centreHeader: boolean;
  readonly band: string | null;
  readonly bandInk: string;
  readonly ruleUnderHeading: boolean;
}

const STYLES: Readonly<Record<ResumeTemplate, Style>> = {
  CLASSIC: { margin: 52, name: 22, heading: 11, body: 10, small: 8.5, gap: 14, ink: '#111827', muted: '#4b5563', accent: '#111827', verified: '#047857', centreHeader: true, band: null, bandInk: '#111827', ruleUnderHeading: true },
  MODERN: { margin: 46, name: 24, heading: 12, body: 10, small: 8.5, gap: 14, ink: '#0f172a', muted: '#475569', accent: '#1d4ed8', verified: '#047857', centreHeader: false, band: '#1e3a8a', bandInk: '#ffffff', ruleUnderHeading: false },
  COMPACT: { margin: 36, name: 18, heading: 10, body: 9, small: 7.5, gap: 9, ink: '#111827', muted: '#4b5563', accent: '#0f766e', verified: '#047857', centreHeader: false, band: null, bandInk: '#111827', ruleUnderHeading: true },
};

const TELUGU = /[ఀ-౿]/;
const SCRIPT_BEARING = /[\p{L}\p{M}]/u;

/** Splits text into runs by script; spaces, digits and punctuation stay with the run they sit in. */
export function scriptRuns(text: string): { readonly telugu: boolean; readonly text: string }[] {
  const runs: { telugu: boolean; text: string }[] = [];
  for (const character of text) {
    const bearing = SCRIPT_BEARING.test(character);
    const telugu = TELUGU.test(character);
    const current = runs[runs.length - 1];
    if (!current) runs.push({ telugu: bearing && telugu, text: character });
    else if (!bearing || current.telugu === telugu) current.text += character;
    else runs.push({ telugu, text: character });
  }
  return runs;
}

export interface RenderOptions {
  /** Receives every string drawn on the page, in order. */
  readonly onText?: (text: string) => void;
}

type Doc = PDFKit.PDFDocument;
interface DrawOptions { readonly x?: number; readonly y?: number; readonly width?: number; readonly align?: 'left' | 'center' | 'right'; readonly lineGap?: number }

export async function renderResumePdf(content: ResumeContentV1, options: RenderOptions = {}): Promise<Buffer> {
  const style = STYLES[content.template] ?? STYLES.CLASSIC;
  const title = content.header.fullName ? `${content.header.fullName} — Résumé` : 'Résumé';
  const doc = new PDFDocument({
    size: 'A4', margin: style.margin, bufferPages: false,
    info: { Title: title, Author: content.header.fullName ?? '', Creator: 'ONE', Subject: 'Résumé' },
  });
  doc.registerFont('regular', FONT_DIR + FONTS.regular);
  doc.registerFont('semibold', FONT_DIR + FONTS.semibold);
  doc.registerFont('bold', FONT_DIR + FONTS.bold);
  doc.registerFont('telugu-regular', FONT_DIR + FONTS.teluguRegular);
  doc.registerFont('telugu-bold', FONT_DIR + FONTS.teluguBold);

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = style.margin;
  const width = doc.page.width - style.margin * 2;
  const bottom = () => doc.page.height - style.margin;
  const ensure = (space: number) => { if (doc.y + space > bottom()) doc.addPage(); };

  const draw = (text: string, weight: Weight, size: number, color: string, opts: DrawOptions = {}) => {
    options.onText?.(text);
    const runs = scriptRuns(text);
    doc.fillColor(color).fontSize(size);
    const fontOf = (run: { telugu: boolean }) => (run.telugu ? (weight === 'regular' ? 'telugu-regular' : 'telugu-bold') : weight);
    const boxWidth = opts.width ?? width;
    if (runs.length > 1 && opts.align && opts.align !== 'left') {
      // pdfkit aligns each run of a continued line on its own, so mixed-script centred or right-aligned
      // text is placed by hand when it fits on one line; a longer line falls back to left-aligned flow.
      const widths = runs.map((run) => doc.font(fontOf(run)).widthOfString(run.text));
      const total = widths.reduce((sum, value) => sum + value, 0);
      if (total <= boxWidth) {
        const top = opts.y ?? doc.y;
        let x = (opts.x ?? left) + (opts.align === 'center' ? (boxWidth - total) / 2 : boxWidth - total);
        let height = 0;
        runs.forEach((run, index) => {
          doc.font(fontOf(run));
          height = Math.max(height, doc.currentLineHeight(true));
          doc.text(run.text, x, top, { lineBreak: false });
          x += widths[index] ?? 0;
        });
        doc.x = opts.x ?? left;
        doc.y = top + height + (opts.lineGap ?? 1.5);
        return;
      }
    }
    runs.forEach((run, index) => {
      doc.font(fontOf(run));
      const textOptions = { width: boxWidth, align: runs.length > 1 ? 'left' : (opts.align ?? 'left'), lineGap: opts.lineGap ?? 1.5, continued: index < runs.length - 1 };
      if (index === 0 && opts.x !== undefined) doc.text(run.text, opts.x, opts.y ?? doc.y, textOptions);
      else doc.text(run.text, textOptions);
    });
  };

  const rule = (color: string) => {
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.6).strokeColor(color).stroke();
  };

  const heading = (text: string) => {
    ensure(style.heading * 4);
    doc.y += style.gap * 0.6;
    draw(style.centreHeader ? text.toUpperCase() : text, 'bold', style.heading, style.accent, { x: left });
    if (style.ruleUnderHeading) { doc.y += 2; rule('#d1d5db'); }
    doc.y += style.gap * 0.35;
  };

  /** A title on the left with a period on the right, on one line. */
  const entryLine = (titleText: string, right: string | null) => {
    ensure(style.body * 4);
    const top = doc.y;
    let rightWidth = 0;
    if (right) {
      doc.font('regular').fontSize(style.small + 0.5);
      rightWidth = Math.min(doc.widthOfString(right) + 2, width / 3);
      draw(right, 'regular', style.small + 0.5, style.muted, { x: left + width - rightWidth, y: top + 1, width: rightWidth, align: 'right' });
    }
    const afterRight = doc.y;
    draw(titleText, 'semibold', style.body + 0.5, style.ink, { x: left, y: top, width: width - rightWidth - (right ? 8 : 0) });
    doc.y = Math.max(doc.y, afterRight);
  };

  const label = (text: string, verified: boolean) => draw(text, verified ? 'semibold' : 'regular', style.small, verified ? style.verified : style.muted, { x: left });

  // --- Header ---------------------------------------------------------------
  const contact = [content.header.email, content.header.phone, content.header.location,
    ...content.header.links.map((link) => (link.label ? `${link.label}: ${link.url}` : link.url))].filter((part): part is string => Boolean(part));
  if (style.band) {
    const bandHeight = style.margin + style.name * 1.4 + (content.header.headline ? style.body * 1.8 : 0) + (contact.length ? style.small * 2.4 * Math.ceil(contact.join('   ·   ').length / 110) : 0) + 10;
    doc.rect(0, 0, doc.page.width, bandHeight).fill(style.band);
    doc.y = style.margin * 0.8;
    if (content.header.fullName) draw(content.header.fullName, 'bold', style.name, style.bandInk, { x: left });
    if (content.header.headline) draw(content.header.headline, 'regular', style.body + 1, style.bandInk, { x: left });
    if (contact.length) { doc.y += 3; draw(contact.join('   ·   '), 'regular', style.small + 0.5, '#dbeafe', { x: left }); }
    doc.y = Math.max(doc.y, bandHeight) + style.gap * 0.5;
  } else {
    const align = style.centreHeader ? 'center' : 'left';
    if (content.header.fullName) draw(content.header.fullName, 'bold', style.name, style.ink, { x: left, align });
    if (content.header.headline) draw(content.header.headline, 'regular', style.body + 1, style.muted, { x: left, align });
    if (contact.length) { doc.y += 2; draw(contact.join('   ·   '), 'regular', style.small + 0.5, style.muted, { x: left, align }); }
    doc.y += style.gap * 0.4;
    if (style.centreHeader) rule('#9ca3af');
  }

  // --- Sections -------------------------------------------------------------
  if (content.summary) {
    heading(RESUME_HEADINGS.summary);
    draw(content.summary, 'regular', style.body, style.ink, { x: left, lineGap: 2.5 });
  }
  if (content.objective.length) {
    heading(RESUME_HEADINGS.objective);
    draw(content.objective.join('  ·  '), 'regular', style.body, style.ink, { x: left });
  }
  if (content.education.length) {
    heading(RESUME_HEADINGS.education);
    content.education.forEach((entry, index) => {
      if (index > 0) doc.y += style.gap * 0.5;
      entryLine(entry.title, entry.period);
      if (entry.institution) draw(entry.institution, 'regular', style.body, style.muted, { x: left });
      label([entry.status, entry.verification].filter(Boolean).join('  ·  '), entry.verified);
      entry.results.forEach((line) => {
        ensure(style.body * 2);
        draw(`${line.label} — ${line.result}  ·  ${line.verification}`, 'regular', style.small + 0.5, line.verified ? style.verified : style.muted, { x: left + 10, width: width - 10 });
      });
    });
  }
  if (content.skills.shown.length || content.skills.declared.length) {
    heading(RESUME_HEADINGS.skills);
    content.skills.shown.forEach((skill) => {
      ensure(style.body * 2);
      draw(skill.name, 'semibold', style.body, style.ink, { x: left });
      draw(skill.basis, 'regular', style.small, style.muted, { x: left + 10, width: width - 10 });
    });
    if (content.skills.declared.length) {
      if (content.skills.shown.length) doc.y += style.gap * 0.3;
      draw(`${RESUME_HEADINGS.declaredSkills}: ${content.skills.declared.join(', ')}`, 'regular', style.body, style.ink, { x: left });
    }
  }
  if (content.projects.length) {
    heading(`${RESUME_HEADINGS.projects} (${RESUME_HEADINGS.selfDeclared})`);
    content.projects.forEach((project, index) => {
      if (index > 0) doc.y += style.gap * 0.4;
      entryLine(project.title, null);
      if (project.url) draw(project.url, 'regular', style.small, style.accent, { x: left });
      if (project.description) draw(project.description, 'regular', style.body, style.ink, { x: left, lineGap: 2 });
    });
  }
  if (content.certificates.length) {
    heading(`${RESUME_HEADINGS.certificates} (${RESUME_HEADINGS.selfDeclared})`);
    content.certificates.forEach((certificate) => {
      entryLine(certificate.title, null);
      if (certificate.description) draw(certificate.description, 'regular', style.small + 0.5, style.muted, { x: left });
    });
  }
  if (content.languages.length) {
    heading(`${RESUME_HEADINGS.languages} (${RESUME_HEADINGS.selfDeclared})`);
    draw(content.languages.join(', '), 'regular', style.body, style.ink, { x: left });
  }

  // --- Legend ---------------------------------------------------------------
  ensure(style.small * 5);
  doc.y += style.gap;
  rule('#e5e7eb');
  doc.y += 4;
  draw(`${content.legend} ${RESUME_HEADINGS.generated} ${content.generatedOn}.`, 'regular', style.small - 0.5, '#6b7280', { x: left });

  doc.end();
  return finished;
}
