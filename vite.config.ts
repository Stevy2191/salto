/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // In dev, the Express API runs separately via `npm start`.
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'node',
  },
})
