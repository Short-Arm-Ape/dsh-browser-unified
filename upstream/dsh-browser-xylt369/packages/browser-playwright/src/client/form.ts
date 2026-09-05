/** Staged settings form. Owns revision fencing; does not import official CardForm. */

export interface CardShell {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}

export interface CardFieldState {
  value: string
  overridden: boolean
}

export interface CardActions {
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
}

export interface CardFormState extends CardShell {
  fields: Record<string, CardFieldState>
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
  return {}
}

function encodeValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join('\n')
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value == null) return ''
  return String(value)
}

function decodeValue(text: string, current: unknown): unknown {
  if (Array.isArray(current)) {
    return text.split(/[\n,]+/u).map((item) => item.trim()).filter(Boolean)
  }
  if (typeof current === 'boolean' || text === 'true' || text === 'false') return text === 'true'
  return text
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function createCardForm(scope: DshSettingsScope, fieldNames: readonly string[]) {
  const draft = new Map<string, string>()
  const listeners = new Set<() => void>()
  let saving = false
  let failed = false
  let snapshot: CardFormState = project()

  const notify = (): void => {
    snapshot = project()
    for (const listener of listeners) listener()
  }

  scope.subscribe(() => {
    if (saving) return
    notify()
  })

  function host(): DshSettingsScopeSnapshot {
    return scope.getSnapshot()
  }

  function project(): CardFormState {
    const snap = host()
    const available = snap.status === 'ready' || (snap.status === undefined && snap.value !== undefined)
    const writable = available && snap.writable !== false
    const value = asRecord(snap.value)
    const user = asRecord(snap.user)
    const fields: Record<string, CardFieldState> = {}
    let dirty = false
    for (const name of fieldNames) {
      const encoded = encodeValue(value[name])
      const text = draft.has(name) ? draft.get(name)! : encoded
      if (draft.has(name) && text !== encoded) dirty = true
      fields[name] = {
        value: text,
        overridden: Object.prototype.hasOwnProperty.call(user, name),
      }
    }
    return {
      available,
      writable,
      dirty,
      invalid: false,
      saving,
      failed,
      fields,
    }
  }

  const store: DshSnapshotStore<CardFormState> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  const actions: CardActions = {
    edit(field, text) {
      if (!snapshot.writable) return
      draft.set(field, text)
      failed = false
      notify()
    },
    resetField(field) {
      draft.delete(field)
      void Promise.resolve(scope.unset(field)).catch(() => {
        failed = true
        notify()
      })
      notify()
    },
    discard() {
      draft.clear()
      failed = false
      notify()
    },
    save() {
      if (!snapshot.writable || !snapshot.dirty || saving) return
      saving = true
      failed = false
      notify()
      const snap = host()
      const value = asRecord(snap.value)
      const base = asRecord(snap.base)
      const writes: Promise<unknown>[] = []
      for (const name of fieldNames) {
        if (!draft.has(name)) continue
        const current = value[name] ?? base[name]
        const next = decodeValue(draft.get(name)!, current)
        writes.push(Promise.resolve(
          same(next, base[name]) ? scope.unset(name) : scope.set(name, next),
        ))
      }
      void Promise.all(writes).then(() => {
        draft.clear()
        saving = false
        failed = false
        notify()
      }, () => {
        saving = false
        failed = true
        notify()
      })
    },
  }

  return { store, actions }
}
