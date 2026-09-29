/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@deriv/core'],
}

module.exports = nextConfig

