import { useState, type CSSProperties, type ReactElement } from 'react'
import type { CardActions, CardFormState } from './form.ts'

export interface WebPermissionCardProps extends CardActions {
  t: (key: string) => string
  useWebPermissionCard: (selector: (state: CardFormState) => CardFormState) => CardFormState
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

function Field(props: {
  label: string
  overridden: boolean
  onReset: () => void
  resetLabel: string
  children: ReactElement
}): ReactElement {
  return (
    <label style={fieldStyle}>
      <span>
        {props.label}
        {props.overridden
          ? (
              <button type="button" onClick={props.onReset} style={{ marginLeft: 8 }}>
                {props.resetLabel}
              </button>
            )
          : null}
      </span>
      {props.children}
    </label>
  )
}

export function WebPermissionCard(props: WebPermissionCardProps): ReactElement | null {
  const { t } = props
  const state = props.useWebPermissionCard((snapshot) => snapshot)
  const [open, setOpen] = useState(true)
  if (!state.available) return null
  const blocked = !state.dirty || state.invalid || state.saving || !state.writable
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
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'block',
          width: '100%',
        }}
      >
        <strong>{t('title')}</strong>
        {state.dirty ? <span style={{ marginLeft: 8 }}>{t('unsaved')}</span> : null}
        <div style={{ opacity: 0.75, marginTop: 4 }}>{t('description')}</div>
      </button>
      {open
        ? (
            <div style={{ marginTop: 12 }}>
              {!state.writable ? <p>{t('readOnly')}</p> : null}
              <Field
                label={t('allowHosts')}
                overridden={state.fields.allowHosts.overridden}
                resetLabel={t('reset')}
                onReset={() => { props.resetField('allowHosts') }}
              >
                <textarea
                  rows={4}
                  style={inputStyle}
                  value={state.fields.allowHosts.value}
                  onChange={(event) => { props.edit('allowHosts', event.target.value) }}
                />
              </Field>
              <Field
                label={t('denyHosts')}
                overridden={state.fields.denyHosts.overridden}
                resetLabel={t('reset')}
                onReset={() => { props.resetField('denyHosts') }}
              >
                <textarea
                  rows={3}
                  style={inputStyle}
                  value={state.fields.denyHosts.value}
                  onChange={(event) => { props.edit('denyHosts', event.target.value) }}
                />
              </Field>
              <Field
                label={t('gatedTools')}
                overridden={state.fields.gatedTools.overridden}
                resetLabel={t('reset')}
                onReset={() => { props.resetField('gatedTools') }}
              >
                <textarea
                  rows={4}
                  style={inputStyle}
                  value={state.fields.gatedTools.value}
                  onChange={(event) => { props.edit('gatedTools', event.target.value) }}
                />
              </Field>
              <Field
                label={t('defaultAction')}
                overridden={state.fields.defaultAction.overridden}
                resetLabel={t('reset')}
                onReset={() => { props.resetField('defaultAction') }}
              >
                <select
                  style={inputStyle}
                  value={state.fields.defaultAction.value || 'allow'}
                  onChange={(event) => { props.edit('defaultAction', event.target.value) }}
                >
                  <option value="allow">{t('allow')}</option>
                  <option value="ask">{t('ask')}</option>
                </select>
              </Field>
              <Field
                label={t('remember')}
                overridden={state.fields.remember.overridden}
                resetLabel={t('reset')}
                onReset={() => { props.resetField('remember') }}
              >
                <input
                  type="checkbox"
                  checked={state.fields.remember.value === 'true'}
                  onChange={(event) => { props.edit('remember', event.target.checked ? 'true' : 'false') }}
                />
              </Field>
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
