/** Model-facing browser tools over the `ctx.browser` seam. @module dsh-tool-browser */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { BrowserPage, BrowserPageOptions } from '@yeesy369/dsh-browser'
import Schema from '@deepseek-ai/schemastery'
import { screenshotBlocks } from './screenshot.js'

export const name = 'tool-browser'
export const inject = ['tools', 'browser', 'attachments']

export interface Config {
  /** Expose the high-risk `browser_evaluate` tool (arbitrary page JS). Off by default. */
  evaluate: boolean
  /** Upper bound for `browser_wait` in milliseconds. */
  maxWaitMs: number
}

export const Config = Schema.object({
  evaluate: Schema.boolean().default(false),
  maxWaitMs: Schema.number().default(60_000),
})

/** Pull a stable session key from the tool execution context. */
export function sessionKeyOf(exec: { session?: unknown; agent?: unknown }): string {
  const session = exec.session
  if (typeof session === 'object' && session !== null && 'id' in session) {
    const id = (session as { id: unknown }).id
    if (typeof id === 'string' && id) return id
  }
  const agent = exec.agent
  if (typeof agent === 'object' && agent !== null && 'id' in agent) {
    const id = (agent as { id: unknown }).id
    if (typeof id === 'string' && id) return `agent:${id}`
  }
  return 'default'
}

function pageOptions(exec: { session?: unknown; agent?: unknown }): BrowserPageOptions {
  return { sessionKey: sessionKeyOf(exec) }
}

function attachmentFields(ref: ImageAttachmentRef, fallback: { width: number; height: number; bytes: number; mediaType: string }) {
  const r = ref as ImageAttachmentRef & { id?: string; size?: number }
  return {
    attachmentId: r.attachmentId ?? r.id ?? '',
    mediaType: r.mediaType ?? fallback.mediaType,
    bytes: r.bytes ?? r.size ?? fallback.bytes,
    width: r.width ?? fallback.width,
    height: r.height ?? fallback.height,
  }
}

const actionOutput = {
  schema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string' as const, required: true as const },
      ok: { type: 'boolean' as const, required: true as const },
    },
    additionalProperties: false,
  },
}

const navigateOutput = {
  schema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string' as const, required: true as const },
      title: { type: 'string' as const, required: true as const },
    },
    additionalProperties: false,
  },
}

export function apply(ctx: Context, config: Config): void {
  const { tools, browser, attachments } = ctx

  const currentPage = async (exec: { signal?: AbortSignal; session?: unknown; agent?: unknown }): Promise<BrowserPage> =>
    browser.newPage(pageOptions(exec), exec.signal)

  tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Open an HTTP(S) URL in the browser and report the resulting page title.',
    parameters: {
      url: { type: 'string', required: true, description: 'The HTTP(S) URL to open.' },
    },
    output: {
      ...navigateOutput,
      render: (_args, value) => [{
        type: 'text',
        text: `Opened ${value.url}${value.title ? ` — ${value.title}` : ''}`,
      }],
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const page = await currentPage(exec)
      const result = await page.navigate(args.url, exec.signal)
      return { url: result.url, title: result.title ?? '' }
    },
  }))

  tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Return a compact accessibility snapshot of the current page.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', required: true },
          text: { type: 'string', required: true },
          refs: { type: 'array', items: { type: 'string' }, required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(_args, exec) {
      const page = await currentPage(exec)
      const snap = await page.snapshot(exec.signal)
      return { url: snap.url, text: snap.text, refs: [...snap.refs] }
    },
  }))

  tools.register(defineTool({
    name: 'browser_click',
    description: 'Click an element in the current page by accessibility ref (from browser_snapshot) or CSS selector.',
    parameters: {
      ref: { type: 'string', required: true, description: 'An accessibility ref (e.g. e1 from browser_snapshot) or CSS selector.' },
    },
    output: {
      ...actionOutput,
      render: (_args, value) => [{ type: 'text', text: `Clicked (ok=${value.ok}) at ${value.url}` }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const page = await currentPage(exec)
      const result = await page.click(args.ref, exec.signal)
      return { url: result.url, ok: result.ok }
    },
  }))

  if (config.evaluate) {
    tools.register(defineTool({
      name: 'browser_evaluate',
      description: 'Run a raw JavaScript expression in the current page and return the JSON-serializable result. HIGH RISK: enable only when you trust the page and gate it behind approval.',
      parameters: {
        script: { type: 'string', required: true, description: 'The JavaScript expression to evaluate. Must return a JSON-serializable value.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      },
      timeoutMs: 30_000,
      async execute(args, exec) {
        const page = await currentPage(exec)
        return (await page.evaluate(args.script, exec.signal)) as JsonValue
      },
    }))
  }

  tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into the currently focused element of the page.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to type.' },
    },
    output: {
      ...actionOutput,
      render: (_args, value) => [{ type: 'text', text: `Typed (ok=${value.ok}) at ${value.url}` }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const page = await currentPage(exec)
      const result = await page.type(args.text, exec.signal)
      return { url: result.url, ok: result.ok }
    },
  }))

  tools.register(defineTool({
    name: 'browser_fill',
    description: 'Replace the value of an input or textarea identified by accessibility ref (from browser_snapshot) or CSS selector.',
    parameters: {
      ref: { type: 'string', required: true, description: 'An accessibility ref or CSS selector.' },
      value: { type: 'string', required: true, description: 'The value to fill.' },
    },
    output: {
      ...actionOutput,
      render: (_args, value) => [{ type: 'text', text: `Filled (ok=${value.ok}) at ${value.url}` }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const page = await currentPage(exec)
      const result = await page.fill(args.ref, args.value, exec.signal)
      return { url: result.url, ok: result.ok }
    },
  }))

  tools.register(defineTool({
    name: 'browser_press',
    description: 'Press a key (Enter, Tab, Escape, ArrowDown, …), optionally on an element identified by ref or CSS selector.',
    parameters: {
      key: { type: 'string', required: true, description: 'Playwright key name, e.g. Enter, Tab, Control+a.' },
      ref: { type: 'string', description: 'Optional accessibility ref or CSS selector.' },
    },
    output: {
      ...actionOutput,
      render: (_args, value) => [{ type: 'text', text: `Pressed (ok=${value.ok}) at ${value.url}` }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const page = await currentPage(exec)
      const result = await page.press(args.key, args.ref, exec.signal)
      return { url: result.url, ok: result.ok }
    },
  }))

  tools.register(defineTool({
    name: 'browser_scroll',
    description: 'Scroll the current page by a pixel amount in a direction (default: 800px down). Use browser_snapshot or browser_screenshot to see the new viewport.',
    parameters: {
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Direction to scroll. Defaults to down.',
      },
      amount: {
        type: 'number',
        description: 'Distance in CSS pixels. Defaults to 800.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', required: true },
          scrollX: { type: 'number', required: true },
          scrollY: { type: 'number', required: true },
          atBoundary: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Scrolled to (${value.scrollX}, ${value.scrollY}) at ${value.url}${value.atBoundary ? ' — reached the edge of the page' : ''}`,
      }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const page = await currentPage(exec)
      const result = await page.scroll({ direction: args.direction, amount: args.amount }, exec.signal)
      return { url: result.url, scrollX: result.scrollX, scrollY: result.scrollY, atBoundary: result.atBoundary }
    },
  }))

  tools.register(defineTool({
    name: 'browser_wait',
    description: 'Wait a bounded duration for lazy content. Optionally also wait until the next domcontentloaded.',
    parameters: {
      ms: { type: 'number', description: `Milliseconds to wait (capped at ${config.maxWaitMs}). Defaults to 1000.` },
      load: { type: 'boolean', description: 'If true, also wait for domcontentloaded after the timer.' },
    },
    output: {
      ...actionOutput,
      render: (_args, value) => [{ type: 'text', text: `Waited (ok=${value.ok}) at ${value.url}` }],
    },
    timeoutMs: Math.max(config.maxWaitMs, 60_000) + 5_000,
    async execute(args, exec) {
      const page = await currentPage(exec)
      const ms = Math.max(0, Math.min(args.ms ?? 1000, config.maxWaitMs))
      const result = await page.wait({ ms, load: args.load }, exec.signal)
      return { url: result.url, ok: result.ok }
    },
  }))

  tools.register(defineTool({
    name: 'browser_back',
    description: 'Navigate the current page back in history.',
    parameters: {},
    output: {
      ...navigateOutput,
      render: (_args, value) => [{
        type: 'text',
        text: `Went back to ${value.url}${value.title ? ` — ${value.title}` : ''}`,
      }],
    },
    timeoutMs: 60_000,
    async execute(_args, exec) {
      const page = await currentPage(exec)
      const result = await page.back(exec.signal)
      return { url: result.url, title: result.title ?? '' }
    },
  }))

  tools.register(defineTool({
    name: 'browser_forward',
    description: 'Navigate the current page forward in history.',
    parameters: {},
    output: {
      ...navigateOutput,
      render: (_args, value) => [{
        type: 'text',
        text: `Went forward to ${value.url}${value.title ? ` — ${value.title}` : ''}`,
      }],
    },
    timeoutMs: 60_000,
    async execute(_args, exec) {
      const page = await currentPage(exec)
      const result = await page.forward(exec.signal)
      return { url: result.url, title: result.title ?? '' }
    },
  }))

  tools.register(defineTool({
    name: 'browser_tabs',
    description: 'List tabs in the current harness session.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          tabs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                url: { type: 'string' },
                title: { type: 'string' },
                active: { type: 'boolean', required: true },
              },
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.tabs.map((tab) => `${tab.active ? '*' : ' '} ${tab.id} ${tab.url ?? ''} ${tab.title ?? ''}`.trim()).join('\n') || '(no tabs)',
      }],
    },
    async execute(_args, exec) {
      const tabs = await browser.listTabs(sessionKeyOf(exec), exec.signal)
      return {
        tabs: tabs.map((tab) => ({
          id: tab.id,
          url: tab.url ?? undefined,
          title: tab.title ?? undefined,
          active: tab.active,
        })),
      }
    },
  }))

  tools.register(defineTool({
    name: 'browser_open_tab',
    description: 'Open a new tab in the current harness session and optionally navigate it.',
    parameters: {
      url: { type: 'string', description: 'Optional HTTP(S) URL to open in the new tab.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `Opened tab ${value.id} at ${value.url}` }],
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const page = await browser.openTab(pageOptions(exec), exec.signal)
      if (args.url) {
        const result = await page.navigate(args.url, exec.signal)
        return { id: page.id, url: result.url, title: result.title ?? '' }
      }
      return { id: page.id, url: page.url() ?? '', title: (await page.title()) ?? '' }
    },
  }))

  tools.register(defineTool({
    name: 'browser_switch_tab',
    description: 'Switch to a tab listed by browser_tabs.',
    parameters: {
      id: { type: 'string', required: true, description: 'Tab id from browser_tabs.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', required: true },
          url: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `Switched to ${value.id} at ${value.url}` }],
    },
    async execute(args, exec) {
      const page = await browser.switchTab(args.id, sessionKeyOf(exec), exec.signal)
      return { id: page.id, url: page.url() ?? '' }
    },
  }))

  tools.register(defineTool({
    name: 'browser_close_tab',
    description: 'Close a tab listed by browser_tabs.',
    parameters: {
      id: { type: 'string', required: true, description: 'Tab id from browser_tabs.' },
    },
    output: {
      ...actionOutput,
      render: (_args, value) => [{ type: 'text', text: `Closed tab (ok=${value.ok})` }],
    },
    async execute(args, exec) {
      await browser.closeTab(args.id, sessionKeyOf(exec), exec.signal)
      return { url: '', ok: true }
    },
  }))

  tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Capture a screenshot of the current page and store it as a durable image attachment. The host can send that attachment to vision models (DeepSeek Files API on dsh 0.1.1+).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => screenshotBlocks(value),
    },
    async execute(_args, exec) {
      const page = await currentPage(exec)
      const shot = await page.screenshot(exec.signal)
      const ref: ImageAttachmentRef = await attachments.saveImage({
        data: shot.data,
        mediaType: shot.mediaType,
        name: `browser-${Date.now()}.png`,
      })
      return attachmentFields(ref, {
        width: shot.width,
        height: shot.height,
        bytes: shot.data.byteLength,
        mediaType: shot.mediaType,
      })
    },
  }))
}
