/**
 * Inline rich text over Markdown: blocks and task titles STORE Markdown (**b**, *i*, ~~s~~,
 * plain URLs) and edit/display it as real styling. Shared by the notes editor, the week view
 * and anything else that shows a title.
 */
import type { ReactNode } from 'react';

/* ── links inside text blocks ── */
const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/g;

/** Split text into plain runs and links; null when there is no link at all. */
export function linkify(text: string): (string | { url: string; label: string })[] | null {
  URL_RE.lastIndex = 0;
  if (!URL_RE.test(text)) return null;
  URL_RE.lastIndex = 0; // test() advanced it; matchAll starts from lastIndex
  const parts: (string | { url: string; label: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let label = m[0];
    const trail = label.match(/[),.;:!?\]]+$/)?.[0] ?? ''; // sentence punctuation isn't part of the URL
    label = label.slice(0, label.length - trail.length);
    if (!label) continue;
    parts.push(text.slice(last, m.index));
    parts.push({ url: label.startsWith('www.') ? `https://${label}` : label, label });
    last = (m.index ?? 0) + label.length;
  }
  parts.push(text.slice(last));
  return parts;
}

/** Bold / italic / strike spans in the text: `**x**`, `*x*`, `~~x~~` (no space just inside the markers). */
export type Emph = { style: 'b' | 'i' | 's' | 'bi'; mark: string; text: string };
const EMPH_RE = /(\*\*\*(?!\s)[^*\n]*?(?<!\s)\*\*\*|\*\*(?!\s)[^*\n]*?(?<!\s)\*\*|~~(?!\s)[^~\n]*?(?<!\s)~~|\*(?!\s)[^*\n]*?(?<!\s)\*)/g;

/** Splits the text into plain / link / emphasis segments; null when there's nothing to decorate. */
export function decorate(text: string): (string | { url: string; label: string } | Emph)[] | null {
  const linked = linkify(text);
  let any = linked !== null;
  const out: (string | { url: string; label: string } | Emph)[] = [];
  for (const part of linked ?? [text]) {
    if (typeof part !== 'string') { out.push(part); continue; }
    EMPH_RE.lastIndex = 0;
    let last = 0;
    for (const m of part.matchAll(EMPH_RE)) {
      const tok = m[0];
      const mark = tok.startsWith('***') ? '***' : tok.startsWith('**') ? '**' : tok.startsWith('~~') ? '~~' : '*';
      out.push(part.slice(last, m.index));
      out.push({ style: mark === '***' ? 'bi' : mark === '**' ? 'b' : mark === '~~' ? 's' : 'i', mark, text: tok.slice(mark.length, tok.length - mark.length) });
      last = (m.index ?? 0) + tok.length;
      any = true;
    }
    out.push(part.slice(last));
  }
  return any ? out : null;
}

/* ── contenteditable plumbing: blocks store Markdown, the editor shows real styling ── */

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Markdown → the HTML shown in a block's editor (emphasis as real tags, links styled). */
export function mdToHtml(text: string): string {
  let out = '';
  for (const part of decorate(text) ?? [text]) {
    if (typeof part === 'string') out += escapeHtml(part);
    else if ('url' in part) out += `<a class="blk-link" href="${escapeHtml(part.url)}">${escapeHtml(part.label)}</a>`;
    else if (part.style === 'bi') out += `<b><i>${escapeHtml(part.text)}</i></b>`;
    else out += `<${part.style}>${escapeHtml(part.text)}</${part.style}>`;
  }
  return out;
}

/** The editor's DOM → Markdown. Marker whitespace is pushed outside so the result re-parses. */
export function htmlToMd(node: Node): string {
  const wrap = (mark: string, t: string) => {
    const m = t.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : t;
  };
  let out = '';
  node.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) { out += n.textContent ?? ''; return; }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    const inner = htmlToMd(el);
    switch (el.tagName) {
      case 'B': case 'STRONG': out += wrap('**', inner); break;
      case 'I': case 'EM': out += wrap('*', inner); break;
      case 'S': case 'STRIKE': case 'DEL': out += wrap('~~', inner); break;
      case 'A': out += inner; break;
      case 'BR': out += '\n'; break;
      case 'DIV': case 'P': out += (out ? '\n' : '') + inner; break;
      case 'SPAN': { // execCommand occasionally styles via spans
        let t = inner;
        if (el.style.textDecorationLine?.includes('line-through')) t = wrap('~~', t);
        if (el.style.fontStyle === 'italic') t = wrap('*', t);
        if (el.style.fontWeight === 'bold' || +el.style.fontWeight >= 600) t = wrap('**', t);
        out += t; break;
      }
      default: out += inner;
    }
  });
  return out;
}

/** Visible caret offset → offset into the Markdown source (markers are invisible). */
export function mdOffsetOf(md: string, vis: number): number {
  let v = 0, m = 0;
  for (const part of decorate(md) ?? [md]) {
    const plain = typeof part === 'string' ? part : 'url' in part ? part.label : null;
    if (plain !== null) {
      if (v + plain.length >= vis) return m + (vis - v);
      v += plain.length; m += plain.length;
    } else {
      const e = part as Emph;
      if (v + e.text.length >= vis) return m + e.mark.length + (vis - v);
      v += e.text.length; m += e.text.length + 2 * e.mark.length;
    }
  }
  return md.length;
}

/** Markdown offset → visible offset (for restoring a caret stored against the source). */
export function mdToVis(md: string, mdOff: number): number {
  let v = 0, m = 0;
  for (const part of decorate(md) ?? [md]) {
    const plain = typeof part === 'string' ? part : 'url' in part ? part.label : null;
    if (plain !== null) {
      if (m + plain.length >= mdOff) return v + Math.max(0, mdOff - m);
      v += plain.length; m += plain.length;
    } else {
      const e = part as Emph;
      const span = e.text.length + 2 * e.mark.length;
      if (m + span >= mdOff) return v + Math.min(e.text.length, Math.max(0, mdOff - m - e.mark.length));
      v += e.text.length; m += span;
    }
  }
  return v;
}

/** Selection start/end as visible-text offsets inside the editor. */
export function caretOffsets(el: HTMLElement): { start: number; end: number } {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return { start: 0, end: 0 };
  const r = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length;
  pre.setEnd(r.endContainer, r.endOffset);
  return { start, end: pre.toString().length };
}

export function setCaretAt(el: HTMLElement, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  let rem = offset;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (rem <= node.length) { sel.removeAllRanges(); const r = document.createRange(); r.setStart(node, rem); r.collapse(true); sel.addRange(r); return; }
    rem -= node.length;
  }
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}


/** Selection spanning two visible offsets. */
export function setSelRange(el: HTMLElement, start: number, end: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const find = (offset: number): [Node, number] => {
    let rem = offset;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (rem <= node.length) return [node, rem];
      rem -= node.length;
    }
    return [el, el.childNodes.length];
  };
  const [sn, so] = find(start);
  const [en, eo] = find(end);
  const r = document.createRange();
  r.setStart(sn, so);
  r.setEnd(en, eo);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** The visible text alone — markers stripped (notification bodies, plain contexts). */
export function stripInlineMd(text: string): string {
  let out = '';
  for (const part of decorate(text) ?? [text]) {
    out += typeof part === 'string' ? part : 'url' in part ? part.label : part.text;
  }
  return out;
}

/** Markdown rendered as styled React spans (read-only contexts like week rows). */
export function renderInlineMd(text: string): ReactNode {
  const parts = decorate(text);
  if (!parts) return text;
  return parts.map((p, k) => {
    if (typeof p === 'string') return p;
    if ('url' in p) return <span key={k} className="md-linkish">{p.label}</span>;
    if (p.style === 'b') return <b key={k}>{p.text}</b>;
    if (p.style === 'i') return <i key={k}>{p.text}</i>;
    if (p.style === 's') return <s key={k}>{p.text}</s>;
    return <b key={k}><i>{p.text}</i></b>;
  });
}
