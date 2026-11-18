/** @type {import('next').NextConfig} */
const API = process.env.API_URL || "http://localhost:4000";
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  // Socket.IO polls "/ws/?EIO=…" — keep the trailing slash so the API sees its own path.
  skipTrailingSlashRedirect: true,
  // Same-origin API in the browser (cookies, no CORS); Caddy does the same in production.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API}/api/:path*` },
      { source: "/files/:path*", destination: `${API}/files/:path*` },
      // Socket.IO long-polling through the same origin (WebSocket upgrade goes direct via NEXT_PUBLIC_WS_URL or the reverse proxy).
      { source: "/ws/", destination: `${API}/ws/` },
    ];
  },
};
