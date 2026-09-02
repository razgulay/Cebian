import { describe, expect, it } from 'vitest';
import * as pathUtils from './path-utils';

describe('classifyFile', () => {
  it('classifies PDF separately from generic binary files', () => {
    expect(pathUtils.classifyFile('report.PDF')).toBe('pdf');
    expect(pathUtils.classifyFile('archive.zip')).toBe('binary');
  });

  it('only treats explicitly supported extensions as text', () => {
    expect(pathUtils.classifyFile('notes.txt')).toBe('text');
    expect(pathUtils.classifyFile('script.py')).toBe('text');
    expect(pathUtils.classifyFile('payload.bin')).toBe('unknown');
    expect(pathUtils.classifyFile('README')).toBe('text');
    expect(pathUtils.classifyFile('mystery')).toBe('unknown');
  });

  it('recognizes common source, config, dotfiles, and extensionless text files', () => {
    for (const name of [
      'Component.vue',
      'Widget.svelte',
      'guide.mdx',
      '.npmrc',
      '.editorconfig',
      '.prettierrc',
      'Package.swift',
      'main.tf',
      'yarn.lock',
      'Gemfile',
      'Procfile',
    ]) {
      expect(pathUtils.classifyFile(name), name).toBe('text');
    }
    expect(pathUtils.classifyFile('unknown.payload')).toBe('unknown');
    expect(pathUtils.classifyFile('program.exe')).toBe('unknown');
    expect(pathUtils.classifyFile('mystery')).toBe('unknown');
  });

  it('routes .html / .htm to the dedicated html bucket, not the generic text bucket', () => {
    expect(pathUtils.classifyFile('page.html')).toBe('html');
    expect(pathUtils.classifyFile('page.htm')).toBe('html');
    expect(pathUtils.classifyFile('PAGE.HTML')).toBe('html');
    // Regression guard: html/htm were previously in TEXT_EXTS, which routed
    // them to the raw-<pre> branch. If anyone re-adds them to TEXT_EXTS
    // without removing HTML_EXTS, the text branch wins by ordering and this
    // test catches it.
  });
});

describe('decodePreviewText', () => {
  const decodePreviewText = (
    pathUtils as unknown as { decodePreviewText?: (bytes: Uint8Array) => string | null }
  ).decodePreviewText;

  it('decodes valid UTF-8 bytes without changing their contents', () => {
    expect(decodePreviewText).toBeTypeOf('function');
    expect(decodePreviewText?.(new TextEncoder().encode('hello, 世界'))).toBe('hello, 世界');
  });

  it('rejects malformed UTF-8 instead of producing replacement characters', () => {
    expect(decodePreviewText).toBeTypeOf('function');
    expect(decodePreviewText?.(new Uint8Array([0x66, 0x80, 0x6f]))).toBeNull();
  });
});

describe('resolvePreviewOpenMode', () => {
  const resolvePreviewOpenMode = (
    pathUtils as unknown as {
      resolvePreviewOpenMode?: (preference: string) => string;
    }
  ).resolvePreviewOpenMode;

  it('maps versioned preferences to a preview/source opening mode', () => {
    expect(resolvePreviewOpenMode).toBeTypeOf('function');
    expect(resolvePreviewOpenMode?.('smart')).toBe('preview');
    expect(resolvePreviewOpenMode?.('preview')).toBe('preview');
    expect(resolvePreviewOpenMode?.('source')).toBe('source');
  });
});

describe('parseVfsLocation', () => {
  it('keeps the VFS path separate from a requested markdown anchor', () => {
    expect(pathUtils.parseVfsLocation('#%2Fworkspaces%2Fs%2Freadme.md', '?anchor=install%20run')).toEqual({
      path: '/workspaces/s/readme.md',
      anchor: 'install run',
    });
  });

  it('keeps malformed percent escapes as literal path text', () => {
    expect(pathUtils.parseVfsLocation('#/workspaces/s/bad%name.md', '?anchor=bad%value')).toEqual({
      path: '/workspaces/s/bad%name.md',
      anchor: 'bad%value',
    });
  });
});

describe('vfsNavigationUrl', () => {
  it('builds ordinary navigation without carrying an anchor query', () => {
    const navigationUrl = (
      pathUtils as unknown as { vfsNavigationUrl?: (path: string, pathname: string) => string }
    ).vfsNavigationUrl;
    expect(navigationUrl).toBeTypeOf('function');
    expect(navigationUrl?.('/workspaces/s/next.md', '/vfs.html')).toBe('/vfs.html#%2Fworkspaces%2Fs%2Fnext.md');
  });
});
