import type { Entity } from './detect';

export interface Redaction {
  /** The text that is allowed to leave the device. */
  redacted: string;
  /** placeholder -> original */
  map: Record<string, string>;
}

const PLACEHOLDER = /\[[A-Z_]+_\d+\]/g;

export function redact(text: string, entities: Entity[]): Redaction {
  const hidden = entities.filter((e) => e.hidden && e.text).sort((a, b) => b.text.length - a.text.length);
  const counters: Record<string, number> = {};
  const map: Record<string, string> = {};
  // Assign numbers in order of first appearance so the result reads naturally.
  const ordered = [...hidden].sort((a, b) => text.indexOf(a.text) - text.indexOf(b.text));
  const label = new Map<string, string>();
  for (const e of ordered) {
    if (label.has(e.text) || !text.includes(e.text)) continue;
    counters[e.type] = (counters[e.type] ?? 0) + 1;
    const ph = `[${e.type}_${counters[e.type]}]`;
    label.set(e.text, ph);
    map[ph] = e.text;
  }
  // Replace longest spans first, on a mask so placeholders are never re-matched.
  const owner: (string | null)[] = new Array(text.length).fill(null);
  for (const e of hidden) {
    const ph = label.get(e.text);
    if (!ph) continue;
    let i = -1;
    while ((i = text.indexOf(e.text, i + 1)) !== -1) {
      let free = true;
      for (let k = i; k < i + e.text.length; k++) if (owner[k] !== null) { free = false; break; }
      if (free) for (let k = i; k < i + e.text.length; k++) owner[k] = k === i ? ph : '';
    }
  }
  let redacted = '';
  for (let i = 0; i < text.length; i++) {
    if (owner[i] === null) redacted += text[i];
    else if (owner[i] !== '') redacted += owner[i];
  }
  return { redacted, map };
}

export type Piece = { kind: 'text'; value: string } | { kind: 'placeholder'; value: string; original?: string };

/** Split text into plain runs and placeholders, for display. */
export function pieces(text: string, map: Record<string, string>): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    if (m.index > last) out.push({ kind: 'text', value: text.slice(last, m.index) });
    out.push({ kind: 'placeholder', value: m[0], original: map[m[0]] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}
