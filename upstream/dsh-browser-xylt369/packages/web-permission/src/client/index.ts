import { WebPermissionCard } from './Card.tsx'
import { createCardForm } from './form.ts'
import { en, NS, zh } from './locales.ts'

export const inject = ['slots', 'locale', 'settingsScope']

const FIELDS = ['allowHosts', 'denyHosts', 'gatedTools', 'defaultAction', 'remember'] as const

export function apply(ctx: DshClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'web-permission: settings card copy')
  const form = createCardForm(ctx.settingsScope.bind({ namespace: 'web-permission' }), FIELDS)
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'web-permission',
    locale: NS,
    inject: () => ({
      hooks: { webPermissionCard: form.store },
      ...form.actions,
    }),
  }, WebPermissionCard))
}
