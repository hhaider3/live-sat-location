import { buildSnapshot, type PropagationRequest } from './propagation';
import type { Sat } from './satellites';

const groups = new Map<string, Sat[]>();
self.onmessage = (event: MessageEvent<PropagationRequest>) => {
  const request = event.data;
  if (request.type === 'upsert') groups.set(request.key, request.sats);
  else if (request.type === 'remove') groups.delete(request.key);
  else {
    const snapshot = buildSnapshot(groups, request);
    self.postMessage(snapshot, { transfer: snapshot.groups.flatMap(g => [g.a.buffer, g.b.buffer]) });
  }
};
