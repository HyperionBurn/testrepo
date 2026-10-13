// Bottom-right toast stack. Click a toast to dismiss it early.
import { useToasts, type ToastKind } from '../lib/toast'
import { IconAlert, IconCheck, IconInfo } from './icons'

const KIND: Record<ToastKind, { color: string; Icon: typeof IconInfo }> = {
  info: { color: '#64D2FF', Icon: IconInfo },
  success: { color: 'var(--success)', Icon: IconCheck },
  error: { color: 'var(--danger)', Icon: IconAlert }
}

export function Toasts() {
  const items = useToasts((s) => s.items)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => {
        const k = KIND[t.kind]
        return (
          <div
            key={t.id}
            className="toast glass-strong"
            role={t.kind === 'error' ? 'alert' : 'status'}
            onClick={() => dismiss(t.id)}
            title="Dismiss"
          >
            <span className="toast__icon" style={{ ['--c' as string]: k.color }}>
              <k.Icon size={13} />
            </span>
            <div className="toast__body">
              <div className="toast__title">{t.title}</div>
              {t.text && <div className="toast__text">{t.text}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
