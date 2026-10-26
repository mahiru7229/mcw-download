/**
 * Cloudflare Pages Function: /releases/*
 * High-Speed Edge Cache Proxy & Dynamic Release Manifest Sync for MCW Launcher
 */

const GITHUB_REPO = 'mahiru7229/mcw-launcher';
const CORE_GITHUB_REPO = 'mahiru7229/mcw-launcher-core';
const GITHUB_RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=15`;
const USER_AGENT = 'MCW-Launcher-CDN-Proxy/1.8.4 (+https://mcwlauncher.pages.dev)';

function isNewer(tagA, tagB) {
  if (!tagA) return false;
  if (!tagB) return true;
  const cleanA = String(tagA).replace(/^v/i, '');
  const cleanB = String(tagB).replace(/^v/i, '');
  const parse = (v) => {
    const [main, ...preParts] = v.split('-');
    const parts = (main || '').split('.').map((n) => parseInt(n, 10) || 0);
    return { parts, pre: preParts.join('-') || '' };
  };
  const pa = parse(cleanA);
  const pb = parse(cleanB);
  for (let i = 0; i < Math.max(pa.parts.length, pb.parts.length); i++) {
    const na = pa.parts[i] || 0;
    const nb = pb.parts[i] || 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  if (!pa.pre && pb.pre) return true;
  if (pa.pre && !pb.pre) return false;
  return pa.pre.localeCompare(pb.pre, undefined, { numeric: true }) > 0;
}

function extractSha256(asset, fallbackSha256) {
  const raw = String(asset?.sha256 || asset?.digest || fallbackSha256 || '').trim().toLowerCase();
  if (raw.startsWith('sha256:') && raw.length === 71) {
    return raw.slice(7);
  }
  if (/^[0-9a-f]{64}$/.test(raw)) {
    return raw;
  }
  return undefined;
}

function normalizeGitHubRelease(release, origin, staticByTag) {
  const tag = String(release?.tag_name || '').trim();
  const staticEntry = staticByTag.get(tag);
  const staticAssetSha = new Map();
  if (staticEntry && Array.isArray(staticEntry.assets)) {
    for (const a of staticEntry.assets) {
      if (a?.name && a?.sha256) {
        staticAssetSha.set(a.name, a.sha256);
      }
    }
  }

  const assets = Array.isArray(release?.assets)
    ? release.assets
        .filter((a) => a && a.name)
        .map((a) => {
          const cdnUrl = `${origin}/releases/${tag}/${a.name}`;
          const ghUrl = a.browser_download_url || `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${encodeURIComponent(a.name)}`;
          const sha256 = extractSha256(a, staticAssetSha.get(a.name));
          const normalizedAsset = {
            name: a.name,
            size: Number(a.size || 0),
            browser_download_url: cdnUrl,
            mirror_urls: ghUrl && ghUrl !== cdnUrl ? [ghUrl] : [],
          };
          if (sha256) {
            normalizedAsset.sha256 = sha256;
          }
          return normalizedAsset;
        })
    : [];

  const bodyText = String(release?.body || release?.notes || staticEntry?.notes || '').trim();
  return {
    tag_name: tag,
    name: release?.name || staticEntry?.name || `MCW Launcher ${tag}`,
    notes: bodyText,
    body: bodyText,
    html_url: release?.html_url || `https://github.com/${GITHUB_REPO}/releases/tag/${tag}`,
    published_at: release?.published_at || staticEntry?.published_at || new Date().toISOString(),
    prerelease: Boolean(release?.prerelease),
    draft: Boolean(release?.draft),
    assets,
  };
}

async function handleManifestRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const origin = url.origin;
  const forceRefresh = url.searchParams.get('refresh') === '1';

  const cache = caches.default;
  const cacheKeyUrl = new URL('/releases/manifest.json', origin);
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET' });

  if (!forceRefresh && request.method === 'GET') {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const hit = new Response(cached.body, cached);
      hit.headers.set('X-MCW-CDN-Cache', 'HIT');
      hit.headers.set('X-MCW-Edge-Colo', request.cf?.colo || 'UNKNOWN');
      return hit;
    }
  }

  // Load static manifest.json as baseline / fallback
  let staticData = null;
  try {
    const staticRes = await next();
    if (staticRes && staticRes.status === 200) {
      staticData = await staticRes.clone().json();
    }
  } catch (_) {
    staticData = null;
  }

  const staticReleases = Array.isArray(staticData?.releases)
    ? staticData.releases.filter((r) => r && r.tag_name && !r.draft)
    : [];
  const staticByTag = new Map(staticReleases.map((r) => [r.tag_name, r]));

  let mergedByTag = new Map(staticByTag);
  let manifestSource = 'static-fallback';

  // Fetch live releases from GitHub API
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4500);
    const ghRes = await fetch(GITHUB_RELEASES_API, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (ghRes.ok) {
      const ghList = await ghRes.json();
      if (Array.isArray(ghList) && ghList.length > 0) {
        for (const ghRelease of ghList) {
          if (!ghRelease || ghRelease.draft || !ghRelease.tag_name) continue;
          const normalized = normalizeGitHubRelease(ghRelease, origin, staticByTag);
          if (normalized.assets.length > 0) {
            mergedByTag.set(normalized.tag_name, normalized);
          }
        }
        manifestSource = 'github-edge-sync';
      }
    }
  } catch (_) {
    // Keep staticReleases fallback when GitHub API is unreachable or rate-limited
  }

  const sortedReleases = Array.from(mergedByTag.values())
    .filter((r) => r && r.tag_name && !r.draft)
    .sort((a, b) => (isNewer(a.tag_name, b.tag_name) ? -1 : isNewer(b.tag_name, a.tag_name) ? 1 : 0));

  const payload = {
    schema_version: 1,
    service: 'mcw-releases-network',
    updated_at: sortedReleases[0]?.published_at || staticData?.updated_at || new Date().toISOString(),
    releases: sortedReleases,
  };

  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Cache-Control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=60',
    'X-MCW-CDN-Cache': 'MISS',
    'X-MCW-Manifest-Source': manifestSource,
    'X-MCW-Edge-Colo': request.cf?.colo || 'UNKNOWN',
  });

  const response = new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers,
  });

  if (request.method === 'GET' && sortedReleases.length > 0) {
    context.waitUntil(cache.put(cacheKey, response.clone()));
  }

  return response;
}

export async function onRequest(context) {
  const { request, params, next } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Accept, Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const pathSegments = params.path || [];

  // Normalize path segments (strip leading 'download' if present)
  let cleanSegments = [...pathSegments];
  if (cleanSegments[0]?.toLowerCase() === 'download') {
    cleanSegments.shift();
  }

  // Dynamic Edge-Synced Manifest for /releases/manifest.json
  if (cleanSegments.length === 1 && cleanSegments[0].toLowerCase() === 'manifest.json') {
    return handleManifestRequest(context);
  }

  // Other static JSON files in public/releases/
  if (cleanSegments.length === 1 && cleanSegments[0].endsWith('.json')) {
    const response = await next();
    if (response.status === 200) {
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Access-Control-Allow-Origin', '*');
      newHeaders.set('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=30');
      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
    }
  }

  if (cleanSegments.length < 2) {
    return new Response(
      JSON.stringify(
        {
          error: 'Invalid release path format',
          expected: '/releases/<tag>/<filename>',
          example: '/releases/v1.8.4/MCW-Launcher-v1.8.4-windows-x64.zip',
        },
        null,
        2
      ),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }

  const tag = cleanSegments[0];
  const filenameSegments = cleanSegments.slice(1);
  const filename = filenameSegments.join('/');
  const safeBasename = filenameSegments[filenameSegments.length - 1].replace(/["\r\n]/g, '_');

  // Route to the appropriate GitHub repository
  let repo = GITHUB_REPO;
  if (filename.toLowerCase().includes('mcw_core') || filename.toLowerCase().includes('mcw-core')) {
    repo = CORE_GITHUB_REPO;
  }

  const encodedPath = filenameSegments.map((s) => encodeURIComponent(s)).join('/');
  const upstreamUrl = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodedPath}`;

  // Cache configuration
  const cache = caches.default;
  const cacheKeyUrl = new URL(request.url);
  cacheKeyUrl.search = '';
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET' });

  const isRangeRequest = request.headers.has('range');
  const isGetRequest = request.method === 'GET';

  // Try serving from edge cache for non-range GET requests first
  if (!isRangeRequest && isGetRequest) {
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      const response = new Response(cachedResponse.body, cachedResponse);
      response.headers.set('X-MCW-CDN-Cache', 'HIT');
      response.headers.set('X-MCW-Edge-Colo', request.cf?.colo || 'UNKNOWN');
      return response;
    }
  }

  // Forward request upstream to GitHub Releases
  const upstreamHeaders = {
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
  };

  if (isRangeRequest) {
    upstreamHeaders['Range'] = request.headers.get('range');
  }

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      redirect: 'follow',
    });

    if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
      return new Response(
        JSON.stringify(
          {
            error: 'Release asset not found on upstream GitHub',
            status: upstreamResponse.status,
            tag,
            filename,
            upstream_repo: repo,
            upstream_url: upstreamUrl,
          },
          null,
          2
        ),
        {
          status: upstreamResponse.status,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // Build optimized headers for client
    const headers = new Headers(upstreamResponse.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Disposition', `attachment; filename="${safeBasename}"`);
    headers.set('X-MCW-CDN-Cache', 'MISS');
    headers.set('X-MCW-Edge-Colo', request.cf?.colo || 'UNKNOWN');
    headers.set('X-MCW-Upstream-Repo', repo);

    // Releases are immutable once published -> Cache for 30 days
    headers.set('Cache-Control', 'public, max-age=2592000, s-maxage=2592000, immutable');

    const clientResponse = new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });

    // Cache complete 200 GET responses asynchronously in edge cache
    if (!isRangeRequest && isGetRequest && upstreamResponse.status === 200) {
      context.waitUntil(cache.put(cacheKey, clientResponse.clone()));
    }

    return clientResponse;
  } catch (err) {
    return new Response(
      JSON.stringify(
        {
          error: 'Upstream gateway error fetching release asset',
          message: err.message,
          target: upstreamUrl,
        },
        null,
        2
      ),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}
