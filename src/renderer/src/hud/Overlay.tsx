// Shared shell for centred overlays (palette, dispatch sheet, digest). Scrim click closes.
import type { ReactNode } from 'react'

export function Overlay({
  onClose,
  placement = 'top',
  label,
  dim = true,
  children
}: {
  onClose: () => void;
  placement?: 'top' | 'center' | 'under-title';
  label: string;
  dim?: boolean;
  children: ReactNode;
}) {
  const cls = placement === 'top' ? 'overlay--top' : placement === 'center' ? 'overlay--center' : 'overlay--under-title'
  return (
    <>
      {dim && <div className="scrim" onMouseDown={onClose} aria-hidden="true" />}
      <div className={`overlay ${cls}`} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </>
  )
}
