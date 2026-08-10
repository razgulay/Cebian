import { describe, expect, it, vi } from 'vitest';
import * as pdfLoader from './pdf-loader';

type PreviewController = {
  load(onPassword: (updatePassword: (password: string) => void, reason: number) => void): Promise<number>;
  renderPage(pageNumber: number, canvas: unknown, scale: number): Promise<{ width: number; height: number }>;
  destroy(): Promise<void>;
};

type CreateController = (
  data: Uint8Array,
  loadEngine: () => Promise<{ getDocument: (options: unknown) => unknown }>,
) => PreviewController;

const createPdfPreviewController = (
  pdfLoader as unknown as { createPdfPreviewController?: CreateController }
).createPdfPreviewController;
const resolvePdfRenderScale = (
  pdfLoader as unknown as {
    resolvePdfRenderScale?: (
      fitWidth: boolean,
      containerWidth: number,
      zoom: number,
      current: { document: object; page: number },
      measurement: { document: object; page: number; width: number } | null,
    ) => number;
  }
).resolvePdfRenderScale;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createPdfPreviewController', () => {
  it('loads bytes lazily and forwards password requests', async () => {
    expect(createPdfPreviewController).toBeTypeOf('function');
    const updatePassword = vi.fn();
    const document = { numPages: 4, destroy: vi.fn(async () => undefined) };
    const loadingTask = { promise: Promise.resolve(document), destroy: vi.fn(async () => undefined), onPassword: undefined as unknown };
    const getDocument = vi.fn(() => loadingTask);
    const controller = createPdfPreviewController!(new Uint8Array([1, 2]), async () => ({ getDocument }));
    const onPassword = vi.fn();

    const loadPromise = controller.load(onPassword);
    await Promise.resolve();
    (loadingTask.onPassword as (update: typeof updatePassword, reason: number) => void)(updatePassword, 1);

    expect(await loadPromise).toBe(4);
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ data: expect.any(Uint8Array) }));
    expect(onPassword).toHaveBeenCalledWith(updatePassword, 1);
  });

  it('cancels an in-flight render before rendering another page', async () => {
    expect(createPdfPreviewController).toBeTypeOf('function');
    const first = deferred<void>();
    const firstTask = { promise: first.promise, cancel: vi.fn() };
    const secondTask = { promise: Promise.resolve(), cancel: vi.fn() };
    const firstPage = {
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
      render: vi.fn(() => firstTask),
      cleanup: vi.fn(),
    };
    const secondPage = {
      getViewport: vi.fn(() => ({ width: 300, height: 400 })),
      render: vi.fn(() => secondTask),
      cleanup: vi.fn(),
    };
    const document = {
      numPages: 2,
      getPage: vi.fn((page: number) => Promise.resolve(page === 1 ? firstPage : secondPage)),
      destroy: vi.fn(async () => undefined),
    };
    const loadingTask = { promise: Promise.resolve(document), destroy: vi.fn(async () => undefined) };
    const controller = createPdfPreviewController!(new Uint8Array([1]), async () => ({
      getDocument: () => loadingTask,
    }));
    await controller.load(() => undefined);
    const canvas = { width: 0, height: 0, getContext: () => ({}) };

    const firstRender = controller.renderPage(1, canvas, 1);
    await Promise.resolve();
    const secondRender = controller.renderPage(2, canvas, 1);
    first.resolve();

    await Promise.all([firstRender, secondRender]);
    expect(firstTask.cancel).toHaveBeenCalledOnce();
    expect(firstPage.cleanup).toHaveBeenCalledOnce();
    expect(secondPage.cleanup).not.toHaveBeenCalled();
    expect(canvas).toMatchObject({ width: 300, height: 400 });
  });

  it('ignores a stale page when concurrent getPage calls resolve out of order', async () => {
    expect(createPdfPreviewController).toBeTypeOf('function');
    const firstPageDeferred = deferred<any>();
    const renderTask = () => ({ promise: Promise.resolve(), cancel: vi.fn() });
    const firstPage = {
      getViewport: () => ({ width: 600, height: 800 }),
      render: vi.fn(renderTask),
      cleanup: vi.fn(),
    };
    const secondPage = {
      getViewport: () => ({ width: 300, height: 400 }),
      render: vi.fn(renderTask),
      cleanup: vi.fn(),
    };
    const document = {
      numPages: 2,
      getPage: vi.fn((page: number) => page === 1 ? firstPageDeferred.promise : Promise.resolve(secondPage)),
      destroy: vi.fn(async () => undefined),
    };
    const controller = createPdfPreviewController!(new Uint8Array([1]), async () => ({
      getDocument: () => ({ promise: Promise.resolve(document), destroy: vi.fn() }),
    }));
    await controller.load(() => undefined);
    const canvas = { width: 0, height: 0, getContext: () => ({}) };

    const stale = controller.renderPage(1, canvas, 1);
    const latest = controller.renderPage(2, canvas, 1);
    await latest;
    firstPageDeferred.resolve(firstPage);
    await stale;

    expect(firstPage.render).not.toHaveBeenCalled();
    expect(firstPage.cleanup).toHaveBeenCalledOnce();
    expect(secondPage.render).toHaveBeenCalledOnce();
    expect(canvas).toMatchObject({ width: 300, height: 400 });
  });

  it('cancels rendering and destroys loaded resources during cleanup', async () => {
    expect(createPdfPreviewController).toBeTypeOf('function');
    const render = deferred<void>();
    const renderTask = { promise: render.promise, cancel: vi.fn(() => render.resolve()) };
    const page = {
      getViewport: () => ({ width: 10, height: 20 }),
      render: () => renderTask,
      cleanup: vi.fn(),
    };
    const document = {
      numPages: 1,
      getPage: () => Promise.resolve(page),
      destroy: vi.fn(async () => undefined),
    };
    const loadingTask = { promise: Promise.resolve(document), destroy: vi.fn(async () => undefined) };
    const controller = createPdfPreviewController!(new Uint8Array([1]), async () => ({
      getDocument: () => loadingTask,
    }));
    await controller.load(() => undefined);
    const rendering = controller.renderPage(1, { width: 0, height: 0, getContext: () => ({}) }, 1);
    await Promise.resolve();

    await controller.destroy();
    await rendering;

    expect(renderTask.cancel).toHaveBeenCalledOnce();
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
  });
});

describe('resolvePdfRenderScale', () => {
  it('uses an intrinsic width only for the document and page that measured it', () => {
    expect(resolvePdfRenderScale).toBeTypeOf('function');
    const firstDocument = {};
    const secondDocument = {};
    const measurement = { document: firstDocument, page: 1, width: 1000 };

    expect(resolvePdfRenderScale?.(true, 524, 1, { document: firstDocument, page: 1 }, measurement)).toBe(0.5);
    expect(resolvePdfRenderScale?.(true, 524, 1, { document: firstDocument, page: 2 }, measurement)).toBe(1);
    expect(resolvePdfRenderScale?.(true, 524, 1, { document: secondDocument, page: 1 }, measurement)).toBe(1);
    expect(resolvePdfRenderScale?.(
      true,
      524,
      1,
      { document: firstDocument, page: 2 },
      { document: firstDocument, page: 2, width: 500 },
    )).toBe(1);
  });
});
