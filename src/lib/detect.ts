import { detector } from './ai';

export type EntityType =
  | 'PERSON' | 'ADDRESS' | 'ORGANIZATION' | 'ID_NUMBER' | 'DATE_OF_BIRTH' | 'OTHER'
  | 'EMAIL' | 'PHONE' | 'CARD' | 'SSN' | 'ACCOUNT' | 'CUSTOM';

export interface Entity {
  text: string;
  type: EntityType;
  source: 'pattern' | 'device' | 'you';
  hidden: boolean;
}

const PATTERNS: [EntityType, RegExp][] = [
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['CARD', /\b(?:\d[ -]?){13,19}\b/g],
  ['SSN', /\b\d{3}-\d{2}-\d{4}\b/g],
  ['PHONE', /(?:\+?\d{1,2}[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}\b/g],
  ['ACCOUNT', /\b\d{8,17}\b/g],
  // A title followed by a capitalised name is a person even when the model overlooks it.
  ['PERSON', /\b(?:Dr|Mr|Mrs|Ms|Prof)\.? [A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+)?/g],
  // "Manager: Jane Poe" style labels. The name is the first capture group.
  ['PERSON', /\b(?:Manager|Supervisor|Employee|Patient|Physician|Doctor|Landlord|Tenant|Name|Contact|Attn|Attention|From|To|Cc)\s*:[ \t]*([A-Z][a-z'-]+(?: [A-Z][a-zA-Z'-]+){1,2})\b/g],
];

/** Structured identifiers. Needs no model, so it works on every device. */
export function patternDetect(text: string): Entity[] {
  const out: Entity[] = [];
  for (const [type, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const t = (m[1] ?? m[0]).trim();
      if (!out.some((e) => e.text === t || e.text.includes(t))) out.push({ text: t, type, source: 'pattern', hidden: true });
    }
  }
  return out;
}

export function chunk(text: string, max = 900): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const p of text.split(/\n{2,}/)) {
    if (cur && (cur + '\n\n' + p).length > max) { chunks.push(cur); cur = p; }
    else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) chunks.push(cur);
  // A single very long paragraph is split on line breaks, then hard-split.
  return chunks.flatMap((c) => {
    if (c.length <= max * 1.5) return [c];
    const parts: string[] = [];
    let buf = '';
    for (const line of c.split('\n')) {
      if (buf && (buf + '\n' + line).length > max) { parts.push(buf); buf = line; }
      else buf = buf ? buf + '\n' + line : line;
    }
    if (buf) parts.push(buf);
    return parts.flatMap((p) => (p.length <= max * 1.5 ? [p] : p.match(new RegExp(`[\\s\\S]{1,${max}}`, 'g')) ?? [p]));
  });
}

const MONEY = /^[-+]?\$?\s?\d[\d,]*(\.\d+)?\s?(%|USD|dollars?)?$/i;
const DATE = /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(, ?\d{4})?)$/i;

/** Small models over-report. Money and ordinary dates are what the user wants analysed, so they stay visible. */
function keep(t: string, type: EntityType, context: string): boolean {
  if (MONEY.test(t)) return false;
  if (DATE.test(t) || type === 'DATE_OF_BIRTH') {
    const before = context.slice(Math.max(0, context.indexOf(t) - 40), context.indexOf(t)).toLowerCase();
    return /birth|dob|born/.test(before);
  }
  return true;
}

const TYPES = new Set(['PERSON', 'ADDRESS', 'ORGANIZATION', 'ID_NUMBER', 'DATE_OF_BIRTH', 'OTHER']);

/** Names, addresses, organisations and free-form IDs. Runs only on this device. */
export async function deviceDetect(text: string, onChunk?: (done: number, total: number) => void): Promise<Entity[]> {
  const found: Entity[] = [];
  const chunks = chunk(text);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const result = await detector.generateContent(`Document:\n"""\n${c}\n"""\nList the identifying spans.`);
    let parsed: { entities?: { text?: unknown; type?: unknown }[] } = {};
    try { parsed = JSON.parse(result.response.text()); } catch { /* skip an unparsable chunk */ }
    for (const e of parsed.entities ?? []) {
      const t = String(e.text ?? '').trim();
      const type = TYPES.has(String(e.type)) ? (String(e.type) as EntityType) : 'OTHER';
      if (t.length >= 2 && c.includes(t) && keep(t, type, c) && !found.some((f) => f.text === t)) found.push({ text: t, type, source: 'device', hidden: true });
    }
    onChunk?.(i + 1, chunks.length);
  }
  return found;
}

/** Merge detections, dropping any span already covered by a longer one. */
export function mergeEntities(...lists: Entity[][]): Entity[] {
  const all = lists.flat().sort((a, b) => b.text.length - a.text.length);
  const out: Entity[] = [];
  for (const e of all) if (!out.some((o) => o.text.includes(e.text))) out.push(e);
  return out;
}
