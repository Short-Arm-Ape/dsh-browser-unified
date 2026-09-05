import { IntranetBrowserCard } from './Card.tsx'
import { createCardForm } from './form.ts'
import { en, NS, zh } from './locales.ts'

export const inject = ['slots', 'locale', 'settingsScope']

const FIELDS = ['approvalMode', 'approvalScope', 'blockMetadata', 'blockedHostnames', 'windowVisibility', 'stealth'] as const

export function apply(ctx: DshClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'intranet-browser: settings card copy')
  const form = createCardForm(ctx.settingsScope.bind({ namespace: 'intranet-browser' }), FIELDS)
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'intranet-browser',
    locale: NS,
    inject: () => ({
      hooks: { intranetBrowserCard: form.store },
      ...form.actions,
    }),
  }, IntranetBrowserCard))
}
