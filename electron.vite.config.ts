import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import JavaScriptObfuscator from 'javascript-obfuscator'

/**
 * Obfuscates every emitted JS chunk of a production build so the packaged
 * app.asar ships unreadable code (the repo source itself stays clear).
 *
 * Runs only when mode === 'production' — `electron-vite build` (used by CI
 * and `npm run dist` before electron-builder). `npm run dev` builds with
 * mode 'development' and is never obfuscated.
 *
 * Transform choices are deliberately conservative: local identifiers and
 * string literals are mangled, but nothing is injected that could change
 * the semantics of import/require calls or ESM export clauses across
 * chunks (renameGlobals and transformObjectKeys stay off;
 * controlFlowFlattening / deadCodeInjection are skipped for build size and
 * runtime performance). External module specifiers survive the string
 * array untouched because the decoder still produces the exact original
 * string at runtime.
 */
function obfuscatePlugin(): Plugin {
  let enabled = false
  return {
    name: 'obfuscate-output',
    apply: 'build',
    configResolved(config) {
      enabled = config.mode === 'production'
    },
    generateBundle(_options, bundle) {
      if (!enabled) return
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk' || !/\.[cm]?js$/.test(file.fileName)) continue
        // Performance carve-out (spec 12.1): the net worker chunk carries
        // the hot-path protocol/crypto code (frame parsing, chunk hashing).
        // Base64 string-array decoding costs measurable per-chunk overhead
        // there, so it gets the light profile; everything else is fully
        // obfuscated.
        const lightProfile = file.fileName === 'net.js'
        const result = lightProfile
          ? JavaScriptObfuscator.obfuscate(file.code, { compact: true, simplify: true })
          : JavaScriptObfuscator.obfuscate(file.code, {
              compact: true,
              simplify: true,
              numbersToExpressions: true,
              stringArray: true,
              stringArrayEncoding: ['base64'],
              stringArrayThreshold: 1,
              splitStrings: true,
              splitStringsChunkLength: 8,
              identifierNamesGenerator: 'mangled',
              // Must stay off — see the comment above the factory.
              renameGlobals: false,
              transformObjectKeys: false,
              controlFlowFlattening: false,
              deadCodeInjection: false,
              selfDefending: false,
              unicodeEscapeSequence: false
            })
        file.code = result.getObfuscatedCode()
      }
    }
  }
}

/**
 * Content-Security-Policy, injected per mode (spec 3/11).
 *
 * Production is strict: no inline styles, no inline scripts, everything
 * same-origin. Dev additionally allows inline <style> tags because Vite's
 * dev server injects CSS that way (without this the dev renderer comes up
 * unstyled) and ws: for the HMR websocket. script-src stays 'self' in both
 * modes — no inline scripts ever.
 */
function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    transformIndexHtml(html, ctx) {
      const dev = ctx.server !== undefined
      const csp = dev
        ? [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            "font-src 'self'",
            "connect-src 'self' ws: http://127.0.0.1:5211"
          ].join('; ')
        : [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            "font-src 'self'",
            "connect-src 'self'"
          ].join('; ')
      const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`
      // Both HTML entries (index.html, integrity.html) get the policy.
      return html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/g, '').replace(
        '<head>',
        `<head>\n    ${meta}`
      )
    }
  }
}

export default defineConfig({
  main: {
    // Baked in at build time and printed with the boot identity log — a
    // running instance is then always identifiable as "this build at
    // HH:MM", which is the only reliable way to spot stale ones.
    define: {
      __BUILD_STAMP__: JSON.stringify(new Date().toISOString().replace('T', ' ').slice(0, 19))
    },
    plugins: [externalizeDepsPlugin(), obfuscatePlugin()],
    build: {
      minify: 'esbuild',
      rollupOptions: {
        external: ['original-fs'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          net: resolve(__dirname, 'src/net/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), obfuscatePlugin()],
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          integrity: resolve(__dirname, 'src/preload/integrity.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    esbuild: { jsx: 'automatic' },
    server: {
      host: '127.0.0.1',
      port: 5211
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          integrity: resolve(__dirname, 'src/renderer/integrity.html')
        }
      }
    },
    plugins: [cspPlugin(), obfuscatePlugin()]
  }
})
