import { fetchOmm, fetchTle, errorResponse, refreshStoredCatalogs } from './proxy.js';

const readable = request => request.method === 'GET' || request.method === 'HEAD';

function forMethod(request, response) {
  if (request.method !== 'HEAD') return response;
  void response.body?.cancel().catch(() => {});
  return new Response(null, response);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/omm') {
      if (!readable(request)) return errorResponse('Method not allowed', 405, { Allow: 'GET, HEAD' });
      return forMethod(request, await fetchOmm(url, ctx, env));
    }
    if (url.pathname === '/api/tle') {
      if (!readable(request)) return errorResponse('Method not allowed', 405, { Allow: 'GET, HEAD' });
      return forMethod(request, await fetchTle(url, ctx));
    }
    if (url.pathname.startsWith('/api/')) return errorResponse('Unknown API endpoint', 404);
    return env.ASSETS.fetch(request);
  },
  // Awaited rather than passed to waitUntil, whose time limit is too short for every group.
  async scheduled(_event, env) {
    await refreshStoredCatalogs(env);
  },
};
