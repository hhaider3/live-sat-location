import { predictPasses, type Observer } from './passes';
import type { Sat } from './satellites';
self.onmessage = (event: MessageEvent<{ sat: Sat; observer: Observer; start: number }>) => {
  try {
    const { sat, observer, start } = event.data;
    self.postMessage({ result: predictPasses(sat, observer, start) });
  } catch { self.postMessage({ error: 'Could not calculate passes for these coordinates.' }); }
};
