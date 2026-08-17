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

describe('resolveMarkdownOpenMode', () => {
  const resolveMarkdownOpenMode = (
    pathUtils as unknown as {
      resolveMarkdownOpenMode?: (preference: string) => string;
    }
  ).resolveMarkdownOpenMode;

  it('maps versioned preferences to a markdown opening mode', () => {
    expect(resolveMarkdownOpenMode).toBeTypeOf('function');
    expect(resolveMarkdownOpenMode?.('smart')).toBe('preview');
    expect(resolveMarkdownOpenMode?.('preview')).toBe('preview');
    expect(resolveMarkdownOpenMode?.('source')).toBe('source');
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
