import { fetchOmm, fetchTle, errorResponse } from './proxy.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/omm') {
      if (request.method !== 'GET') return errorResponse('Method not allowed', 405, { Allow: 'GET' });
      return fetchOmm(url, ctx);
    }
    if (url.pathname === '/api/tle') {
      if (request.method !== 'GET') return errorResponse('Method not allowed', 405, { Allow: 'GET' });
      return fetchTle(url, ctx);
    }
    if (url.pathname.startsWith('/api/')) return errorResponse('Unknown API endpoint', 404);
    return env.ASSETS.fetch(request);
  },
};
