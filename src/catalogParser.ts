import CatalogWorker from './catalog.worker?worker&inline';
import { parseCatalogBody, type CatalogKind, type ParsedCatalog } from './satellites';

// Starting a Worker costs more than parsing a small membership feed.
const WORKER_MIN_BYTES = 256 * 1024;

/** The body is copied, not transferred, so a failed Worker can still parse it here. */
export function parseCatalogInWorker(body: ArrayBuffer, kind: CatalogKind): Promise<ParsedCatalog> {
  return new Promise((resolve, reject) => {
    const inline = () => {
      try { resolve(parseCatalogBody(body, kind)); } catch (error) { reject(error); }
    };
    if (body.byteLength < WORKER_MIN_BYTES) return inline();
    let worker: Worker;
    try { worker = new CatalogWorker(); } catch { return inline(); }
    worker.onmessage = (event: MessageEvent<{ result?: ParsedCatalog; error?: string }>) => {
      worker.terminate();
      if (event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error));
    };
    worker.onerror = () => { worker.terminate(); inline(); };
    worker.postMessage({ body, kind });
  });
}
