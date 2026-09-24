/**
 * Cloudflare Pages Function: /hotfixes/*
 * Serves Hotfix Manifest and Patch Packages with smart caching
 */

export async function onRequest(context) {
  const { request, params, next } = context;
  const pathSegments = params.path || [];
  const filename = pathSegments.join('/');

  // If path is empty or root of hotfixes, list channel status
  if (!filename || filename === '') {
    return new Response(JSON.stringify({
      service: "MCW Hotfix Channel",
      channel: "stable",
      manifest_url: "/hotfixes/manifest.json",
      docs: "https://github.com/mahiru7229/mcw-launcher/blob/main/docs/HOTFIX_SYSTEM.md"
    }, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  // Pass through to static file if available in public/hotfixes/
  const response = await next();
  if (response.status === 200) {
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.set('X-MCW-Hotfix-Channel', 'active');
    
    // Manifest changes frequently -> cache for 60 seconds
    if (filename.endsWith('.json')) {
      newHeaders.set('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=30');
    } else {
      // Patch zip files are immutable -> cache for 7 days
      newHeaders.set('Cache-Control', 'public, max-age=604800, immutable');
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }

  return response;
}
