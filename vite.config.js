import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// base: './' — відносні шляхи, щоб збірка працювала і в корені домену,
// і в підпапці GitHub Pages (https://<user>.github.io/render-qa/), і в Electron.
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile()],
})
