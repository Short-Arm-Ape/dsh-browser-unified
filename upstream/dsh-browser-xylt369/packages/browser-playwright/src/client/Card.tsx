import { useState, type CSSProperties, type ReactElement } from 'react'
import type { CardActions, CardFormState } from './form.ts'

export interface BrowserPlaywrightCardProps extends CardActions {
  t: (key: string) => string
  useBrowserPlaywrightCard: (selector: (state: CardFormState) => CardFormState) => CardFormState
}

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginBottom: 12,
  fontSize: 13,
}

const inputStyle: CSSProperties = {
  font: 'inherit',
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l1, #d0d0d0)',
  background: 'var(--dsw-alias-bg-layer-1, transparent)',
  color: 'inherit',
}

export function BrowserPlaywrightCard(props: BrowserPlaywrightCardProps): ReactElement | null {
  const { t } = props
  const state = props.useBrowserPlaywrightCard((snapshot) => snapshot)
  const [open, setOpen] = useState(true)
  if (!state.available) return null
  const blocked = !state.dirty || state.invalid || state.saving || !state.writable
  const visibility = state.fields.windowVisibility.value || 'visible'
  const stealth = state.fields.stealth.value === '' ? true : state.fields.stealth.value === 'true'
  const allowFakeIp = state.fields.allowFakeIp.value === '' ? true : state.fields.allowFakeIp.value === 'true'
  return (
    <section
      style={{
        border: '1px solid var(--dsw-alias-border-l1, #d0d0d0)',
        borderRadius: 10,
        padding: 12,
        marginBottom: 12,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
      }}
    >
      <button
        type="button"
        onClick={() => { setOpen(!open) }}
        style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
      >
        <strong>{t('title')}</strong>
        {state.dirty ? <span style={{ marginLeft: 8 }}>{t('unsaved')}</span> : null}
        <div style={{ opacity: 0.75, marginTop: 4 }}>{t('description')}</div>
      </button>
      {open
        ? (
            <div style={{ marginTop: 12 }}>
              {!state.writable ? <p>{t('readOnly')}</p> : null}
              <p style={{ fontSize: 12, opacity: 0.8 }}>{t('restart')}</p>
              <label style={fieldStyle}>
                <span>
                  {t('windowVisibility')}
                  {state.fields.windowVisibility.overridden
                    ? (
                        <button type="button" onClick={() => { props.resetField('windowVisibility') }} style={{ marginLeft: 8 }}>
                          {t('reset')}
                        </button>
                      )
                    : null}
                </span>
                <select
                  style={inputStyle}
                  value={visibility}
                  onChange={(event) => { props.edit('windowVisibility', event.target.value) }}
                >
                  <option value="visible">{t('visible')}</option>
                  <option value="hidden">{t('hidden')}</option>
                  <option value="headless">{t('headless')}</option>
                </select>
              </label>
              <label style={{ ...fieldStyle, flexDirection: 'row', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={stealth}
                  onChange={(event) => { props.edit('stealth', event.target.checked ? 'true' : 'false') }}
                />
                <span>{t('stealth')}</span>
                {state.fields.stealth.overridden
                  ? (
                      <button type="button" onClick={() => { props.resetField('stealth') }}>
                        {t('reset')}
                      </button>
                    )
                  : null}
              </label>
              <label style={{ ...fieldStyle, flexDirection: 'row', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={allowFakeIp}
                  onChange={(event) => { props.edit('allowFakeIp', event.target.checked ? 'true' : 'false') }}
                />
                <span>{t('allowFakeIp')}</span>
                {state.fields.allowFakeIp.overridden
                  ? (
                      <button type="button" onClick={() => { props.resetField('allowFakeIp') }}>
                        {t('reset')}
                      </button>
                    )
                  : null}
              </label>
              {state.failed ? <p>{t('saveFailed')}</p> : null}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" disabled={!state.dirty || state.saving} onClick={() => { props.discard() }}>
                  {t('discard')}
                </button>
                <button type="button" disabled={blocked} onClick={() => { props.save() }}>
                  {t(state.saving ? 'saving' : 'save')}
                </button>
              </div>
            </div>
          )
        : null}
    </section>
  )
}
