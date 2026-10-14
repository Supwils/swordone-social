/**
 * Markdown renderer pipeline.
 *
 *   marked → HTML → DOMPurify → render
 *
 * Then, post-render, a React walker linkifies plain `#tag` and `@username`
 * occurrences inside text nodes (not inside existing anchors or code blocks).
 *
 * XSS stance: DOMPurify with an explicit ALLOWED_TAGS list. No inline styles,
 * no event handlers, no raw HTML. Links get `rel="noopener noreferrer nofollow"`
 * and `target="_self"`.
 */
import { type ReactElement, type ReactNode, createElement, Fragment } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Link } from 'react-router-dom';

// Configure marked once.
marked.setOptions({
  gfm: true,
  breaks: true,
});

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'hr',
];

const ALLOWED_ATTR = ['href', 'title'];

/** Same-origin path (`/u/x`) or in-page hash, plus http(s)/mailto. */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  // `//host` is scheme-relative and leaves the origin; `/path` does not.
  if (trimmed.startsWith('//')) return false;
  return /^(https?:|mailto:|\/|#)/i.test(trimmed);
}

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    // Harden links — see afterSanitize hook below.
  });
}

// Harden link hrefs — reject `javascript:` and friends, force http(s)/mailto, add rel.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    if (!isSafeHref(href)) {
      node.removeAttribute('href');
    } else if (/^https?:/i.test(href.trim())) {
      node.setAttribute('rel', 'noopener noreferrer nofollow');
      node.setAttribute('target', '_self');
    }
  }
});

/**
 * Parse + sanitize Markdown. Returns HTML string safe to set as innerHTML, but
 * we prefer the React walker below which turns it into a virtual DOM and
 * linkifies mentions/tags on text nodes.
 */
export function renderMarkdown(source: string): string {
  const rendered = marked.parse(source) as string;
  return sanitize(rendered);
}

/**
 * Parse HTML string → React nodes with #tag and @mention linkification.
 * Uses DOMParser (browser-native) to walk a sanitized tree.
 */
export function MarkdownBody({ source }: { source: string }): ReactElement {
  const html = renderMarkdown(source);
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstChild as HTMLElement;
  return <Fragment>{nodeToReact(root, { inAnchor: false, key: 'r' })}</Fragment>;
}

interface WalkCtx {
  inAnchor: boolean;
  key: string;
}

function nodeToReact(node: Node, ctx: WalkCtx): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    if (ctx.inAnchor || !text) return text;
    return linkifyText(text, ctx.key);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  if (tag === 'script' || tag === 'style') return null;

  const children: ReactNode[] = [];
  const nextCtx: WalkCtx = {
    inAnchor: ctx.inAnchor || tag === 'a' || tag === 'code' || tag === 'pre',
    key: ctx.key,
  };
  el.childNodes.forEach((child, i) => {
    children.push(nodeToReact(child, { ...nextCtx, key: `${ctx.key}.${i}` }));
  });

  const props: Record<string, unknown> = { key: ctx.key };
  // Preserve href/title on anchors
  if (tag === 'a') {
    const href = el.getAttribute('href');
    if (href && isSafeHref(href)) props.href = href;
    const rel = el.getAttribute('rel');
    if (rel) props.rel = rel;
    const target = el.getAttribute('target');
    if (target) props.target = target;
  }
  if (tag === 'root' || tag === 'div') {
    // Top-level wrapper — render as Fragment to avoid an extra div.
    return <Fragment key={ctx.key}>{children}</Fragment>;
  }
  return createElement(tag, props, ...children);
}

const MENTION_OR_TAG_RE = /([#@])([\p{L}\p{N}_][\p{L}\p{N}_-]{0,63})/gu;

function linkifyText(text: string, keyPrefix: string): ReactNode {
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  const re = new RegExp(MENTION_OR_TAG_RE.source, MENTION_OR_TAG_RE.flags);

  while ((match = re.exec(text)) !== null) {
    const [full, sigil, name] = match;
    const start = match.index;
    if (start > lastIndex) out.push(text.slice(lastIndex, start));
    const slug = name.toLowerCase();
    const to = sigil === '#' ? `/tag/${slug}` : `/u/${slug}`;
    out.push(
      <Link key={`${keyPrefix}.m${i++}`} to={to}>
        {full}
      </Link>,
    );
    lastIndex = start + full.length;
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out.length === 1 ? out[0] : out;
}
