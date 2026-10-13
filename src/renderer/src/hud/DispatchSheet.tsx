// Launch sheet: pick an agent kind, write a prompt, optionally isolate it in a git worktree.
import { useState, type KeyboardEvent } from 'react'
import type { DispatchRequest } from '@shared/types'
import { useSky } from '../state/store'
import { useUi } from '../lib/ui'
import { attempt } from '../lib/actions'
import { toast } from '../lib/toast'
import { Overlay } from './Overlay'
import { IconSend, IconX } from './icons'

type Kind = DispatchRequest['kind'];

export function DispatchSheet() {
  const repo = useSky((s) => s.repo)
  const [kind, setKind] = useState<Kind>('claude-code')
  const [prompt, setPrompt] = useState('')
  const [worktree, setWorktree] = useState(true)
  const [busy, setBusy] = useState(false)

  const close = () => useUi.getState().setDispatch(false)
  const canLaunch = Boolean(repo) && prompt.trim().length > 0 && !busy

  const submit = async () => {
    const text = prompt.trim()
    if (!canLaunch || !text) return
    setBusy(true)
    const res = await attempt('Could not deploy the drone', () =>
      window.skyline.dispatch({ kind, prompt: text, worktree })
    )
    setBusy(false)
    if (res) {
      toast.success('Drone deployed 🚀', `Agent ${res.agentId.slice(0, 8)} is on its way.`)
      close()
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <Overlay onClose={close} label="Dispatch an agent" placement="top">
      <div className="sheet glass-strong">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 34,
              height: 34,
              borderRadius: 12,
              background: 'linear-gradient(180deg,#3a94ff,#0a7cf0)',
              color: '#fff',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,.4)'
            }}
          >
            <IconSend size={16} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="t-title">Dispatch a drone</div>
            <div className="faint" style={{ fontSize: 12 }}>
              {repo ? `Launch an agent to build in ${repo.name}.` : 'Open a repository to dispatch an agent.'}
            </div>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <IconX size={14} />
          </button>
        </div>

        <div className="seg" style={{ ['--n' as string]: 2, ['--i' as string]: kind === 'claude-code' ? 0 : 1, width: '100%' }} role="tablist" aria-label="Agent">
          <span className="seg__thumb" />
          <button className="seg__btn" role="tab" aria-selected={kind === 'claude-code'} onClick={() => setKind('claude-code')}>
            Claude Code
          </button>
          <button className="seg__btn" role="tab" aria-selected={kind === 'codex'} onClick={() => setKind('codex')}>
            Codex
          </button>
        </div>

        <textarea
          className="field selectable"
          rows={5}
          autoFocus
          value={prompt}
          placeholder="What should the drone build? e.g. Add a dark mode toggle to the settings page."
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Prompt"
          style={{ minHeight: 112, fontSize: 13.5 }}
        />

        <div className="field-row">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Isolated worktree</div>
            <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
              Works in its own git worktree so it cannot collide with your edits.
            </div>
          </div>
          <button
            className="switch"
            role="switch"
            aria-checked={worktree}
            aria-label="Isolated worktree"
            onClick={() => setWorktree((v) => !v)}
          />
        </div>

        <div className="sheet__foot">
          <span className="faint" style={{ fontSize: 11 }}>
            <span className="kbd">Ctrl</span> <span className="kbd">Enter</span> to launch
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="capsule" onClick={close}>
              Cancel
            </button>
            <button className="capsule capsule--primary" disabled={!canLaunch} onClick={() => void submit()}>
              {busy ? 'Launching…' : 'Launch'}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  )
}
