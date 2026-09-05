import { useState, type CSSProperties, type ReactElement } from 'react'
import type { CardActions, CardFormState } from './form.ts'

export interface IntranetBrowserCardProps extends CardActions {
  t: (key: string) => string
  useIntranetBrowserCard: (selector: (state: CardFormState) => CardFormState) => CardFormState
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

export function IntranetBrowserCard(props: IntranetBrowserCardProps): ReactElement | null {
  const { t } = props
  const state = props.useIntranetBrowserCard((snapshot) => snapshot)
  const [open, setOpen] = useState(true)
  if (!state.available) return null
  const blocked = !state.dirty || state.invalid || state.saving || !state.writable
  const approvalMode = state.fields.approvalMode.value || 'per-call'
  const approvalScope = state.fields.approvalScope.value || 'all'
  const blockMetadata = state.fields.blockMetadata.value === '' ? true : state.fields.blockMetadata.value === 'true'
  const visibility = state.fields.windowVisibility.value || 'visible'
  const stealth = state.fields.stealth.value === '' ? true : state.fields.stealth.value === 'true'
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
                  {t('approvalMode')}
                  {state.fields.approvalMode.overridden
                    ? (
                        <button type="button" onClick={() => { props.resetField('approvalMode') }} style={{ marginLeft: 8 }}>
                          {t('reset')}
                        </button>
                      )
                    : null}
                </span>
                <select
                  style={inputStyle}
                  value={approvalMode}
                  onChange={(event) => { props.edit('approvalMode', event.target.value) }}
                >
                  <option value="per-call">{t('perCall')}</option>
                  <option value="arm">{t('arm')}</option>
                </select>
              </label>
              <label style={fieldStyle}>
                <span>
                  {t('approvalScope')}
                  {state.fields.approvalScope.overridden
                    ? (
                        <button type="button" onClick={() => { props.resetField('approvalScope') }} style={{ marginLeft: 8 }}>
                          {t('reset')}
                        </button>
                      )
                    : null}
                </span>
                <select
                  style={inputStyle}
                  value={approvalScope}
                  onChange={(event) => { props.edit('approvalScope', event.target.value) }}
                >
                  <option value="all">{t('scopeAll')}</option>
                  <option value="navigation">{t('scopeNavigation')}</option>
                </select>
              </label>
              <label style={{ ...fieldStyle, flexDirection: 'row', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={blockMetadata}
                  onChange={(event) => { props.edit('blockMetadata', event.target.checked ? 'true' : 'false') }}
                />
                <span>{t('blockMetadata')}</span>
                {state.fields.blockMetadata.overridden
                  ? (
                      <button type="button" onClick={() => { props.resetField('blockMetadata') }}>
                        {t('reset')}
                      </button>
                    )
                  : null}
              </label>
              <label style={fieldStyle}>
                <span>
                  {t('blockedHostnames')}
                  {state.fields.blockedHostnames.overridden
                    ? (
                        <button type="button" onClick={() => { props.resetField('blockedHostnames') }} style={{ marginLeft: 8 }}>
                          {t('reset')}
                        </button>
                      )
                    : null}
                </span>
                <textarea
                  style={{ ...inputStyle, minHeight: 64, resize: 'vertical', fontFamily: 'monospace' }}
                  value={state.fields.blockedHostnames.value}
                  placeholder={'10.0.0.7\ninternal.corp'}
                  onChange={(event) => { props.edit('blockedHostnames', event.target.value) }}
                />
              </label>
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
