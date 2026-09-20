// Pure helpers for the panel self-update card (no react-query imports here so
// the logic stays unit-testable in the isolated vitest env).
export interface PanelUpdateStatus {
  phase: string
  error?: string
}

// Manual rollback success carries no error; auto-rollback after a failure
// keeps the cause in `error`. The UI uses this to pick banner/toast tone.
export const isFailedRollback = (status?: PanelUpdateStatus | null) =>
  status?.phase === 'rolled_back' && !!status?.error
