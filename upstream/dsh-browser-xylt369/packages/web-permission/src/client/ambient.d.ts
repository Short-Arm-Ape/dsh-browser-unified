/** Minimal client-runtime faces. Value-imports of @deepseek-ai/* stay forbidden. */

export {}

declare global {
  interface DshSettingsScopeSnapshot<T extends object = Record<string, unknown>> {
    status?: 'loading' | 'ready' | 'unavailable' | string
    writable?: boolean
    value?: T
    base?: T
    user?: Partial<T> | null
    revision?: number
  }

  interface DshSettingsScope<T extends object = Record<string, unknown>> {
    getSnapshot(): DshSettingsScopeSnapshot<T>
    subscribe(listener: () => void): () => void
    set(field: keyof T & string, value: unknown): Promise<void> | void
    unset(field: keyof T & string): Promise<void> | void
  }

  interface DshSnapshotStore<T> {
    getSnapshot(): T
    subscribe(listener: () => void): () => void
  }

  interface DshClientContext {
    settingsScope: {
      bind(spec: { namespace: string }): DshSettingsScope
    }
    slots: {
      inject(name: string, factory: () => unknown): void
      register(options: object, component: unknown): unknown
    }
    locale: {
      register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void
    }
    effect(fn: () => (() => void) | void, label?: string): void
  }
}
