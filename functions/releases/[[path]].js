/**
 * Cloudflare Pages Function: /releases/*
 * High-Speed Edge Cache Proxy for MCW Launcher Releases
 */

export async function onRequest(context) {
  const { request, params } = context;
  const pathSegments = params.path || [];

  // Normalize path segments (strip leading 'download' if present)
  let cleanSegments = [...pathSegments];
  if (cleanSegments[0]?.toLowerCase() === 'download') {
    cleanSegments.shift();
  }

  if (cleanSegments.length < 2) {
    return new Response(JSON.stringify({
      error: 'Invalid release path format',
      expected: '/releases/<tag>/<filename>',
      example: '/releases/v1.6.1/MCW-Launcher-Setup-1.6.1.exe'
    }, null, 2), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  const tag = cleanSegments[0];
  const filename = cleanSegments.slice(1).join('/');

  // Route to the appropriate GitHub repository
  let repo = 'mahiru7229/mcw-launcher';
  if (filename.toLowerCase().includes('mcw_core') || filename.toLowerCase().includes('mcw-core')) {
    repo = 'mahiru7229/mcw-launcher-core';
  }

  const upstreamUrl = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(filename)}`;

  // Cache configuration
  const cache = caches.default;
  const cacheKey = new URL(request.url);
  // Normalize cacheKey query to avoid cache busting
  cacheKey.search = '';

  const isRangeRequest = request.headers.has('range');

  // Try serving from edge cache for non-range requests first
  if (!isRangeRequest) {
    const cachedResponse = await cache.match(cacheKey.toString());
    if (cachedResponse) {
      const response = new Response(cachedResponse.body, cachedResponse);
      response.headers.set('X-MCW-CDN-Cache', 'HIT');
      response.headers.set('X-MCW-Edge-Colo', request.cf?.colo || 'UNKNOWN');
      return response;
    }
  }

  // Forward request upstream to GitHub Releases
  const upstreamHeaders = {
    'User-Agent': 'MCW-Launcher-CDN-Proxy/1.0 (+https://mcwlauncher.pages.dev)',
    'Accept': '*/*'
  };

  if (isRangeRequest) {
    upstreamHeaders['Range'] = request.headers.get('range');
  }

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      redirect: 'follow'
    });

    if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
      return new Response(JSON.stringify({
        error: 'Release asset not found on upstream GitHub',
        status: upstreamResponse.status,
        tag,
        filename,
        upstream_repo: repo,
        upstream_url: upstreamUrl
      }, null, 2), {
        status: upstreamResponse.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Build optimized headers for client
    const headers = new Headers(upstreamResponse.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    headers.set('X-MCW-CDN-Cache', 'MISS');
    headers.set('X-MCW-Edge-Colo', request.cf?.colo || 'UNKNOWN');
    headers.set('X-MCW-Upstream-Repo', repo);

    // Releases are immutable once published -> Cache for 30 days
    headers.set('Cache-Control', 'public, max-age=2592000, s-maxage=2592000, immutable');

    const clientResponse = new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers
    });

    // Cache complete 200 responses asynchronously in edge cache
    if (!isRangeRequest && upstreamResponse.status === 200) {
      context.waitUntil(cache.put(cacheKey.toString(), clientResponse.clone()));
    }

    return clientResponse;

  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Upstream gateway error fetching release asset',
      message: err.message,
      target: upstreamUrl
    }, null, 2), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}
