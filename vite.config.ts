import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import {
  decodeEnvFileBuffer,
  parseEnvContent,
  resolveSupabaseClientEnvFromSources,
} from './src/services/cloud/envParser.ts'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))

function loadRootSupabaseDefines(mode: string): Record<string, string> {
  const envFiles = [
    '.env',
    '.env.local',
    ...(mode !== 'local' ? [`.env.${mode}`, `.env.${mode}.local`] : []),
  ]

  const parsedSources: Array<Record<string, string | undefined>> = []
  for (const relativeFile of envFiles) {
    const fullPath = path.join(projectRoot, relativeFile)
    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const bytes = fs.readFileSync(fullPath)
        parsedSources.push(parseEnvContent(decodeEnvFileBuffer(bytes)))
      }
    } catch {
      // Ignore unreadable optional env files
    }
  }

  const viteLoaded = loadEnv(mode, projectRoot, ['VITE_', 'TAURI_ENV_'])
  const resolved = resolveSupabaseClientEnvFromSources([
    ...parsedSources,
    viteLoaded,
    process.env,
  ])

  const defines: Record<string, string> = {}
  if (resolved.VITE_SUPABASE_URL !== undefined) {
    defines['import.meta.env.VITE_SUPABASE_URL'] = JSON.stringify(resolved.VITE_SUPABASE_URL)
  }
  if (resolved.VITE_SUPABASE_PUBLISHABLE_KEY !== undefined) {
    defines['import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY'] = JSON.stringify(
      resolved.VITE_SUPABASE_PUBLISHABLE_KEY
    )
  }
  if (resolved.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY !== undefined) {
    defines['import.meta.env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY'] = JSON.stringify(
      resolved.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY
    )
  }
  if (resolved.VITE_SUPABASE_ANON_KEY !== undefined) {
    defines['import.meta.env.VITE_SUPABASE_ANON_KEY'] = JSON.stringify(
      resolved.VITE_SUPABASE_ANON_KEY
    )
  }
  return defines
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  clearScreen: false,
  envDir: projectRoot,
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  define: loadRootSupabaseDefines(mode),
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    allowedHosts: true,
  },
}))
