import { BrowserPlaywrightCard } from './Card.tsx'
import { createCardForm } from './form.ts'
import { en, NS, zh } from './locales.ts'

export const inject = ['slots', 'locale', 'settingsScope']

const FIELDS = ['windowVisibility', 'stealth', 'allowFakeIp'] as const

export function apply(ctx: DshClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'browser-playwright: settings card copy')
  const form = createCardForm(ctx.settingsScope.bind({ namespace: 'browser-playwright' }), FIELDS)
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'browser-playwright',
    locale: NS,
    inject: () => ({
      hooks: { browserPlaywrightCard: form.store },
      ...form.actions,
    }),
  }, BrowserPlaywrightCard))
}
