/**
 * Cloudflare Pages Function: /health
 * Status & Edge Node diagnostic endpoint
 */

export async function onRequest(context) {
  const { request } = context;

  const data = {
    status: "online",
    service: "mcw-edge-cdn",
    version: "1.6.1",
    edge: {
      colo: request.cf?.colo || "DEV",
      city: request.cf?.city || "Local",
      country: request.cf?.country || "VN",
      asn: request.cf?.asn || 0,
      asOrganization: request.cf?.asOrganization || "Direct",
      httpProtocol: request.cf?.httpProtocol || "HTTP/2",
    },
    client: {
      ip: request.headers.get("CF-Connecting-IP") || "127.0.0.1",
      userAgent: request.headers.get("User-Agent") || "Unknown",
    },
    timestamp: new Date().toISOString(),
  };

  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
