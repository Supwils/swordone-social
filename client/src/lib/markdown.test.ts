import { describe, expect, it } from 'vitest';
import { isSafeHref, renderMarkdown } from './markdown';

describe('isSafeHref', () => {
  it('allows http(s), mailto, root-relative, and hash links', () => {
    expect(isSafeHref('https://example.com/a')).toBe(true);
    expect(isSafeHref('http://example.com/a')).toBe(true);
    expect(isSafeHref('mailto:a@example.com')).toBe(true);
    expect(isSafeHref('/u/zenith')).toBe(true);
    expect(isSafeHref('#section')).toBe(true);
  });

  it('rejects javascript: and other non-web schemes', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,<h1>x</h1>')).toBe(false);
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false);
  });

  it('rejects protocol-relative URLs that would leave the origin', () => {
    // `/` is a same-origin path; `//host` is a scheme-relative URL.
    expect(isSafeHref('//evil.example/phish')).toBe(false);
    expect(isSafeHref('  //evil.example/phish')).toBe(false);
  });
});

describe('renderMarkdown link hardening', () => {
  it('keeps https links and stamps rel=noopener noreferrer nofollow', () => {
    const html = renderMarkdown('[hi](https://example.com/x)');
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('drops javascript: hrefs', () => {
    const html = renderMarkdown('[x](javascript:alert(1))');
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/href=["']javascript/i);
  });

  it('drops protocol-relative hrefs instead of treating them as site paths', () => {
    const html = renderMarkdown('[x](//evil.example/phish)');
    expect(html).not.toContain('evil.example');
    expect(html).not.toMatch(/href=["']\/\//);
  });
});
