// "While you were away": a local digest of agent activity since a timestamp, plus local-model status.
import { useEffect, useState } from 'react'
import type { Digest, LlmStatus } from '@shared/types'
import { useUi } from '../lib/ui'
import { clockTime, duration } from '../lib/format'
import { attempt } from '../lib/actions'
import { errorText, toast } from '../lib/toast'
import { Markdown } from '../lib/markdown'
import { Overlay } from './Overlay'
import { IconDownload, IconRefresh, IconSparkle, IconX } from './icons'

type DigestState = { status: 'loading' } | { status: 'ready'; digest: Digest } | { status: 'error'; message: string };

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** Progress ring. `value` null means indeterminate: the ring spins. */
export function ProgressRing({ value, size = 18 }: { value: number | null; size?: number }) {
  const stroke = 2.2
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const v = value === null ? 0.28 : clamp01(value)
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      style={value === null ? { animation: 'spin 900ms linear infinite' } : undefined}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.14)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 300ms var(--spring)' }}
      />
    </svg>
  )
}

function modelLabel(model: string): { text: string; heuristic: boolean } {
  if (/heuristic/i.test(model)) return { text: 'Heuristic summary', heuristic: true }
  const name = model.replace(/\.gguf$/i, '').trim() || 'local model'
  return { text: `Written locally by ${name}`, heuristic: false }
}

function LlmChip({ llm }: { llm: LlmStatus | null }) {
  if (!llm) return null
  switch (llm.state) {
    case 'absent':
      return (
        <button
          className="capsule capsule--sm capsule--primary"
          onClick={async () => {
            const ok = await attempt('Model download failed to start', () => window.skyline.llmDownload())
            if (ok !== undefined) toast.info('Downloading the local model', 'Digests and explanations will use it once it is ready.')
          }}
        >
          <IconDownload size={12} />
          Download local model (1 GB)
        </button>
      )
    case 'downloading': {
      const p = llm.progress === undefined ? null : llm.progress > 1 ? llm.progress / 100 : llm.progress
      return (
        <span className="llm-chip">
          <ProgressRing value={p} />
          Downloading{p === null ? '…' : ` ${Math.round(clamp01(p) * 100)}%`}
        </span>
      )
    }
    case 'loading':
      return (
        <span className="llm-chip">
          <ProgressRing value={null} />
          Loading model…
        </span>
      )
    case 'ready':
      return (
        <span className="llm-chip" title={llm.model}>
          <span className="dot-live dot-live--still" style={{ ['--c' as string]: 'var(--success)', width: 6, height: 6 }} />
          Local model ready
        </span>
      )
    case 'error':
      return (
        <span className="llm-chip" title={llm.error} style={{ color: 'var(--warn)' }}>
          Model unavailable
        </span>
      )
  }
}

export function DigestCard() {
  const since = useUi((s) => s.digestSince)
  const [state, setState] = useState<DigestState>({ status: 'loading' })
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  const [regen, setRegen] = useState(0)

  const close = () => useUi.getState().closeDigest()

  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    window.skyline
      .digest(since)
      .then((digest) => {
        if (alive) setState({ status: 'ready', digest })
      })
      .catch((e: unknown) => {
        if (alive) setState({ status: 'error', message: errorText(e) })
      })
    return () => {
      alive = false
    }
  }, [since, regen])

  useEffect(() => {
    let alive = true
    window.skyline
      .llmStatus()
      .then((s) => {
        if (alive) setLlm(s)
      })
      .catch(() => {
        if (alive) setLlm({ state: 'error', error: 'Local model status is unavailable.' })
      })
    const off = window.skyline.on('llm', (s) => {
      if (alive) setLlm(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const windowLabel = `Since ${clockTime(since)} · ${duration(Date.now() - since)}`

  return (
    <Overlay onClose={close} label="Digest" placement="under-title" dim={false}>
      <section className="digest glass-strong">
        <header style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '18px 16px 0 20px' }}>
          <span
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 34,
              height: 34,
              flex: 'none',
              borderRadius: 12,
              background: 'linear-gradient(180deg, rgba(191,90,242,.9), rgba(120,60,220,.9))',
              color: '#fff',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,.35)'
            }}
          >
            <IconSparkle size={16} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="t-title">While you were away</div>
            <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
              {windowLabel}
            </div>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close digest">
            <IconX size={14} />
          </button>
        </header>

        <div className="digest__body selectable" style={{ marginTop: 14 }}>
          {state.status === 'loading' && (
            <div aria-label="Writing digest">
              <div className="skeleton" style={{ height: 14, width: '92%', marginBottom: 10 }} />
              <div className="skeleton" style={{ height: 14, width: '78%', marginBottom: 10 }} />
              <div className="skeleton" style={{ height: 14, width: '64%' }} />
            </div>
          )}
          {state.status === 'error' && (
            <div className="muted" style={{ fontSize: 13, paddingBottom: 6 }}>
              The digest could not be written. {state.message}
            </div>
          )}
          {state.status === 'ready' &&
            (state.digest.text.trim() ? (
              <Markdown text={state.digest.text} />
            ) : (
              <div className="muted" style={{ fontSize: 13, paddingBottom: 6 }}>
                Nothing notable happened in this window.
              </div>
            ))}
        </div>

        <footer className="digest__foot">
          {state.status === 'ready' ? (
            (() => {
              const m = modelLabel(state.digest.model)
              return (
                <span className="faint" style={{ fontSize: 11.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.text}
                </span>
              )
            })()
          ) : (
            <span className="faint" style={{ fontSize: 11.5 }}>
              Writing…
            </span>
          )}
          <span style={{ flex: 1 }} />
          <LlmChip llm={llm} />
          <button className="icon-btn" onClick={() => setRegen((n) => n + 1)} aria-label="Regenerate digest" title="Regenerate">
            <IconRefresh size={14} />
          </button>
        </footer>
      </section>
    </Overlay>
  )
}
