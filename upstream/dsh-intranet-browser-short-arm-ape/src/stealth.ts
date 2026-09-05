/**
 * Lightweight, dependency-free anti-detection helpers.
 *
 * Copied verbatim from `@yeesy369/dsh-browser-playwright/src/stealth.ts` (same
 * repo, MIT). Kept in this package so the standalone intranet instance does not
 * need a runtime import from the original provider — the two browsers stay
 * fully independent.
 * @module dsh-intranet-browser/stealth
 */

/** Chromium launch args applied when `stealth` is enabled. */
export const STEALTH_LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled']

/**
 * Hidden-window launch args: park the window offscreen and minimize it, so the
 * browser stays fully real (best anti-bot posture, manual login possible) while
 * not popping up on the user's desktop. Requires a desktop session; not for
 * headless servers.
 */
export const HIDDEN_WINDOW_ARGS = [
  '--window-position=-32000,-32000',
  '--window-size=1280,800',
  '--start-minimized',
]

/**
 * Init-script payload installed via `context.addInitScript` before every page
 * script. Kept as a plain string so the provider never needs a DOM lib at
 * compile time. All patches are conditional where possible, so a real browser
 * keeps its genuine values instead of replacing them with fakes.
 */
export const STEALTH_INIT_SCRIPT = `(() => {
  // The single best-known automation marker.
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined })

  // Real browsers expose a window.chrome object; headless runs often do not.
  if (!window.chrome) {
    window.chrome = {
      runtime: {},
      loadTimes: () => ({}),
      csi: () => ({}),
      app: {},
    }
  }

  // Headless exposes zero plugins; a normal desktop browser has PDF plugins.
  if (navigator.plugins.length === 0) {
    const names = [
      'PDF Viewer',
      'Chrome PDF Viewer',
      'Chromium PDF Viewer',
      'Microsoft Edge PDF Viewer',
    ]
    const makePlugin = (name) => {
      const plugin = { name, filename: name + '.plugin', description: '' }
      plugin.item = () => null
      plugin.namedItem = () => null
      plugin.refresh = () => undefined
      return plugin
    }
    const plugins = names.map(makePlugin)
    plugins.item = (i) => plugins[i] ?? null
    plugins.namedItem = (n) => plugins.find((p) => p.name === n) ?? null
    plugins.refresh = () => undefined
    Object.defineProperty(Navigator.prototype, 'plugins', { get: () => plugins })
  }

  // Headless resolves the notifications permission to 'denied' (no UI to ask);
  // a real user profile reports 'prompt' or 'granted'.
  const query = navigator.permissions && navigator.permissions.query
  if (query) {
    navigator.permissions.query = (parameters) =>
      parameters && parameters.name === 'notifications'
        ? Promise.resolve({ state: 'prompt', onchange: null })
        : query.call(navigator.permissions, parameters)
  }

  // Headless GPU reports SwiftShader/llvmpipe through the unmasked WebGL
  // vendor strings; swap only those software renderers for a plausible GPU.
  const originalGetParameter = WebGLRenderingContext.prototype.getParameter
  WebGLRenderingContext.prototype.getParameter = function (parameter) {
    if (parameter === 0x9245 || parameter === 0x9246) {
      const real = originalGetParameter.call(this, parameter)
      if (!real || /swiftshader|llvmpipe|software/i.test(String(real))) {
        return parameter === 0x9245
          ? 'Google Inc. (Intel)'
          : 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'
      }
      return real
    }
    return originalGetParameter.call(this, parameter)
  }

  // Headless reports 0x0 outer size; a visible browser always has a window.
  Object.defineProperties(window, {
    outerWidth: { get: () => window.innerWidth || 1280 },
    outerHeight: { get: () => window.innerHeight || 800 },
  })
})()`
