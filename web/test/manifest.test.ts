import { describe, expect, it } from 'vitest'
import manifestSource from '../public/manifest.webmanifest?raw'
import html from '../index.html?raw'
import icon192 from '../public/icons/icon-192.png?inline'
import icon512 from '../public/icons/icon-512.png?inline'
import iconMaskable from '../public/icons/icon-maskable-512.png?inline'

/**
 * The manifest and the head tags that make the app installable.
 *
 * Worth a test rather than a glance because every failure here is silent. The
 * server answers a missing file with `index.html` and a 200, so a renamed icon
 * does not 404 -- it comes back as HTML and fails much later, inside Chrome's
 * manifest parser, as a message nobody is looking at. And a manifest is JSON
 * with no schema: drop a field and nothing anywhere complains until the install
 * affordance quietly stops appearing.
 */

/*
 * Everything is pulled in through Vite rather than `node:fs`, which is what the
 * app's own bundler does and what `vite/client` already types. The alternative
 * was giving this package node types it has deliberately never had.
 */
const manifest = JSON.parse(manifestSource) as {
  id: string
  name: string
  start_url: string
  scope: string
  display: string
  background_color: string
  theme_color: string
  launch_handler: { client_mode: string }
  icons: { src: string; sizes: string; type: string; purpose: string }[]
}

/** The icons by the path the manifest names them at, as inlined data URIs. */
const rasters: Record<string, string> = {
  '/icons/icon-192.png': icon192,
  '/icons/icon-512.png': icon512,
  '/icons/icon-maskable-512.png': iconMaskable,
}

/** Width and height straight out of the PNG's IHDR, which starts at byte 16. */
const pngSize = (dataUri: string): { width: number; height: number } => {
  const binary = atob(dataUri.slice(dataUri.indexOf(',') + 1))
  const at = (offset: number): number =>
    [0, 1, 2, 3].reduce((n, i) => n * 256 + binary.charCodeAt(offset + i), 0)
  expect(binary.slice(1, 4), 'not a PNG').toBe('PNG')
  return { width: at(16), height: at(20) }
}

describe('manifest', () => {
  it('carries the fields Chrome needs to offer an install', () => {
    expect(manifest.name).toBe('Switchboard')
    expect(manifest.start_url).toBe('/')
    expect(manifest.display).toBe('standalone')
  })

  it('has an id, so a later start_url change updates the app rather than forking it', () => {
    // Without `id`, it defaults to `start_url`; changing that then installs a
    // second app beside the first instead of updating it.
    expect(manifest.id).toBe('/')
  })

  it('declares both icon sizes Chrome asks for', () => {
    const any = manifest.icons.filter((icon) => icon.purpose === 'any')
    expect(any.map((icon) => icon.sizes).sort()).toEqual(['192x192', '512x512'])
  })

  it('keeps the maskable icon a separate file from the plain one', () => {
    // One file marked "any maskable" would be wrong in both places at once: the
    // maskable drawing carries safe-zone padding, so it reads as a shrunken
    // icon anywhere it is not actually masked.
    const maskable = manifest.icons.filter((icon) => icon.purpose === 'maskable')
    expect(maskable).toHaveLength(1)
    expect(maskable[0]?.src).not.toBe(manifest.icons.find((i) => i.purpose === 'any')?.src)
  })

  it('every icon it names exists and really is the size it claims', () => {
    // The check that catches a stale `scripts/icons.py` run, and the one the
    // SPA fallback would otherwise hide by answering 200 with HTML.
    for (const icon of manifest.icons) {
      const [width, height] = icon.sizes.split('x').map(Number)
      const raster = rasters[icon.src]
      expect(raster, `${icon.src} is declared but not bundled here`).toBeDefined()
      expect(pngSize(raster as string), `${icon.src}`).toEqual({ width, height })
    }
  })

  it('focuses the window that is open rather than launching a rival', () => {
    // A second client competes for terminal geometry, and drifts, because `ui`
    // is adopted only on first load.
    expect(manifest.launch_handler.client_mode).toBe('focus-existing')
  })

  it('paints its splash in the page’s own ground', () => {
    // Both are --ink. Any other value is a flash of the wrong colour on every
    // cold launch, which is every launch: there is no cached app shell.
    expect(manifest.background_color).toBe('#10141a')
    expect(manifest.theme_color).toBe('#10141a')
  })
})

describe('index.html head', () => {
  it('links the manifest', () => {
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"')
  })

  it('asks for the manifest with credentials', () => {
    // A manifest is fetched with credentials omitted unless this says otherwise,
    // and the live instance is behind HTTP basic auth: without it the fetch is
    // a 401 and the app cannot be installed at all. Measured against the proxy,
    // which answers 401 for /manifest.webmanifest and 200 for everything the
    // page loads as an ordinary same-origin subresource.
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"')
  })

  it('repeats theme_color as a meta, and says the same thing', () => {
    // Safari does not read theme_color from a manifest. If these two disagree
    // the chrome changes colour depending on how the page was opened.
    const meta = /<meta name="theme-color" content="([^"]+)"/.exec(html)?.[1]
    expect(meta).toBe(manifest.theme_color)
  })

  it('declares its own icon, so nothing probes /favicon.ico', () => {
    // A probe for /favicon.ico is answered with index.html and a 200, and the
    // browser throws away a page of HTML it asked for as an image.
    expect(html).toContain('rel="icon" href="/icons/icon.svg"')
    expect(html).toContain('rel="apple-touch-icon"')
  })

  it('does not ship the obsolete apple capability meta', () => {
    // Chrome logs a deprecation for it, and the standard spelling plus the
    // manifest cover what it used to do.
    expect(html).not.toContain('apple-mobile-web-app-capable')
    expect(html).toContain('name="mobile-web-app-capable"')
  })

  it('keeps the translucent status bar, which is what creates the top inset', () => {
    // Without this, env(safe-area-inset-top) is 0 in an installed iOS app and
    // the padding on #root has nothing to do.
    expect(html).toContain('apple-mobile-web-app-status-bar-style')
  })
})
