/**
 * Event log — every actor action gets logged, not just checkpoint hits.
 * Raw timestamps only; derived metrics (time-to-first-action, time-stuck)
 * are computed after the fact by the analyst tier, never stored as columns.
 */

export interface ActionEvent {
  sessionId: string;
  /** Raw epoch milliseconds. */
  timestamp: number;
  actionType: string;
  target: string;
  /** One-sentence "why I did this" annotation — not chain-of-thought. */
  reasoning: string;
  checkpointId?: string;
}
