// Quit sequencing. The first 'before-quit' is held while native LLM objects are freed (node-llama-cpp aborts the
// process if it exits mid-teardown). Once cleanup finishes, or its timeout passes, the app quits again and the
// second 'before-quit' is let through.

export interface QuitEvent {
  preventDefault(): void;
}

export interface QuitGateOptions {
  /** Frees native resources. Resolves when done. */
  dispose: () => Promise<void>;
  /** Quits the app again. The gate lets that second quit through. */
  quit: () => void;
  /** Longest wait for dispose before quitting anyway. */
  timeoutMs: number;
  onTimeout?: () => void;
  onError?: (err: unknown) => void;
}

export type QuitPhase = 'idle' | 'disposing' | 'done';

/** Resolves true when `work` settles within `ms`, false on timeout. Rejects if `work` rejects. */
export function settleWithin(work: () => Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), ms)
    work().then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * Returns the 'before-quit' handler. Phases: 'idle' (first quit: hold it and start cleanup), 'disposing' (a quit
 * arrived during cleanup: hold it, cleanup is already running), 'done' (cleanup finished: let quit proceed).
 */
export function createQuitGate(opts: QuitGateOptions): { onBeforeQuit: (event: QuitEvent) => void; phase: () => QuitPhase } {
  let phase: QuitPhase = 'idle'
  return {
    phase: () => phase,
    onBeforeQuit(event: QuitEvent): void {
      if (phase === 'done') return
      event.preventDefault()
      if (phase === 'disposing') return
      phase = 'disposing'
      void settleWithin(opts.dispose, opts.timeoutMs)
        .then(
          (finished) => {
            if (!finished) opts.onTimeout?.()
          },
          (err: unknown) => opts.onError?.(err)
        )
        .finally(() => {
          phase = 'done'
          opts.quit()
        })
    }
  }
}
