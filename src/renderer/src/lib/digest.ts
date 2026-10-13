// Digest request bookkeeping for the renderer. Pure, no React.
import type { Digest } from '@shared/types'

/**
 * A digest pushed later on the 'digest' channel replaces the one on screen only when it answers the
 * latest digest request. An older request's late answer, or one with no id, is dropped.
 */
export function isCurrentDigest(pushed: Pick<Digest, 'requestId'>, latestRequestId: string | undefined): boolean {
  return latestRequestId !== undefined && pushed.requestId === latestRequestId
}
