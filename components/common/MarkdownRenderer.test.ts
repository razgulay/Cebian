import { describe, expect, it } from 'vitest';
import * as renderer from './MarkdownRenderer';
import { parseVfsLocation } from '@/entrypoints/vfs/lib/path-utils';

type ResolveMarkdownHref = (href: string, currentVfsPath?: string) => string | undefined;

const resolveMarkdownHref = (
  renderer as unknown as { resolveMarkdownHref?: ResolveMarkdownHref }
).resolveMarkdownHref;
const markdownHeadingId = (
  renderer as unknown as { markdownHeadingId?: (text: string) => string }
).markdownHeadingId;
const markdownLinkTarget = (
  renderer as unknown as { markdownLinkTarget?: (href: string, currentVfsPath?: string) => '_self' | '_blank' }
).markdownLinkTarget;
const extractVfsPath = (
  renderer as unknown as { extractVfsPath?: (src: string) => string | null }
).extractVfsPath;

describe('resolveMarkdownHref', () => {
  const source = '/workspaces/session/docs/readme.md';

  it('resolves sibling and parent links from the source VFS directory', () => {
    expect(resolveMarkdownHref).toBeTypeOf('function');
    expect(resolveMarkdownHref?.('guide.md', source)).toMatch(/vfs\.html#\/workspaces\/session\/docs\/guide\.md$/);
    expect(resolveMarkdownHref?.('../assets/paper.pdf', source)).toMatch(/vfs\.html#\/workspaces\/session\/assets\/paper\.pdf$/);
  });

  it('resolves absolute VFS links and preserves document fragments', () => {
    expect(resolveMarkdownHref?.('/home/reports/final.md', source)).toMatch(/vfs\.html#\/home\/reports\/final\.md$/);
    expect(resolveMarkdownHref?.('#/workspaces/session/report.md', source)).toMatch(/vfs\.html#\/workspaces\/session\/report\.md$/);
    expect(resolveMarkdownHref?.('#/tmp/export.csv', source)).toMatch(/vfs\.html#\/tmp\/export\.csv$/);
    expect(resolveMarkdownHref?.('#results', source)).toMatch(/vfs\.html\?anchor=results#\/workspaces\/session\/docs\/readme\.md$/);
    expect(resolveMarkdownHref?.('guide.md#install', source)).toMatch(/vfs\.html\?anchor=install#\/workspaces\/session\/docs\/guide\.md$/);
  });

  it('keeps cross-document fragments out of the routed VFS path', () => {
    const resolved = resolveMarkdownHref?.('guide.md#install', source);
    const url = new URL(resolved!);
    expect(parseVfsLocation(url.hash, url.search)).toEqual({
      path: '/workspaces/session/docs/guide.md',
      anchor: 'install',
    });
  });

  it('preserves a current-document anchor when the rendered URL is normalized again', () => {
    const first = resolveMarkdownHref?.('#results', source);
    expect(first).toContain('?anchor=results');
    expect(resolveMarkdownHref?.(first!, source)).toBe(first);
  });

  it('leaves safe external links alone and removes dangerous protocols', () => {
    expect(resolveMarkdownHref?.('https://example.com/a', source)).toBe('https://example.com/a');
    expect(resolveMarkdownHref?.('mailto:reader@example.com', source)).toBe('mailto:reader@example.com');
    expect(resolveMarkdownHref?.('javascript:alert(1)', source)).toBeUndefined();
    expect(resolveMarkdownHref?.('data:text/html,pwned', source)).toBeUndefined();
    expect(resolveMarkdownHref?.('vbscript:msgbox(1)', source)).toBeUndefined();
    expect(resolveMarkdownHref?.('file:///tmp/secret.pdf', source)).toBeUndefined();
    expect(resolveMarkdownHref?.('blob:https://example.com/id', source)).toBeUndefined();
    expect(resolveMarkdownHref?.('chrome-extension://other-id/private.html', source)).toBeUndefined();
    expect(resolveMarkdownHref?.('custom:payload', source)).toBeUndefined();
    expect(resolveMarkdownHref?.('//example.com/path', source)).toBeUndefined();
    expect(resolveMarkdownHref?.('/docs/getting-started')).toBe('/docs/getting-started');
  });

  it('does not throw on malformed percent encoding', () => {
    expect(() => resolveMarkdownHref?.('bad%name.md', source)).not.toThrow();
    expect(resolveMarkdownHref?.('bad%name.md', source)).toMatch(/vfs\.html#\/workspaces\/session\/docs\/bad%25name\.md$/);
  });
});

describe('rendered VFS targets', () => {
  it('keeps current-document anchors in the same tab', () => {
    const anchorUrl = resolveMarkdownHref?.('#results', '/tmp/readme.md');
    expect(markdownLinkTarget).toBeTypeOf('function');
    expect(markdownLinkTarget?.(anchorUrl!, '/tmp/readme.md')).toBe('_self');
    expect(markdownLinkTarget?.('https://example.com', '/tmp/readme.md')).toBe('_blank');
  });

  it('opens cross-document anchors in a new tab', () => {
    const crossDocumentUrl = resolveMarkdownHref?.('guide.md#install', '/tmp/readme.md');
    expect(markdownLinkTarget?.(crossDocumentUrl!, '/tmp/readme.md')).toBe('_blank');
  });

  it('extracts VFS image paths outside home and workspaces', () => {
    const src = resolveMarkdownHref?.('images/chart.png', '/tmp/readme.md');
    expect(extractVfsPath).toBeTypeOf('function');
    expect(extractVfsPath?.(src!)).toBe('/tmp/images/chart.png');
  });
});

describe('markdownHeadingId', () => {
  it('creates stable ids for in-document heading links', () => {
    expect(markdownHeadingId).toBeTypeOf('function');
    expect(markdownHeadingId?.('Install & Run')).toBe('install-run');
    expect(markdownHeadingId?.('中文 标题')).toBe('中文-标题');
  });
});
