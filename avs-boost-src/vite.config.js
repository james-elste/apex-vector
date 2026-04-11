import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/avs-boost/',     // serves from apex-vector.com/avs-boost/
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  }
})
