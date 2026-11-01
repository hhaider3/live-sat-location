import { parseCatalogBody, type CatalogKind } from './satellites';

self.onmessage = (event: MessageEvent<{ body: ArrayBuffer; kind: CatalogKind }>) => {
  try {
    self.postMessage({ result: parseCatalogBody(event.data.body, event.data.kind) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Could not read the catalog' });
  }
};
