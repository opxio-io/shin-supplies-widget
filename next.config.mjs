/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: '/dashboard.html',
        headers: [
          { key: 'X-Frame-Options', value: 'ALLOWALL' },
          { key: 'Content-Security-Policy', value: 'frame-ancestors *' },
          { key: 'Cache-Control', value: 'public, s-maxage=300, stale-while-revalidate=86400' },
        ],
      },
    ]
  },
}
export default nextConfig
