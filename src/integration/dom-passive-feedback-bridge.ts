export const PASSIVE_FEEDBACK_EVENT = 'forgeax:passive-feedback';
export const PASSIVE_FEEDBACK_RECOVERED_EVENT = 'forgeax:passive-feedback-recovered';

export interface PassiveFeedbackScope {
  sid?: string;
  agentId?: string;
}

export interface PassiveFeedbackSignal {
  code: string;
  message: string;
  source?: string;
  ts?: number;
  scope?: PassiveFeedbackScope;
}

export interface PassiveFeedbackResolution {
  exceptionKey: string;
  scope?: PassiveFeedbackScope;
}

/**
 * Emits Chat's passive feedback signal into the existing product host.
 * Classification, recovery and presentation remain owned by that host.
 */
export function reportPassiveFeedbackSignal(signal: PassiveFeedbackSignal): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<PassiveFeedbackSignal>(PASSIVE_FEEDBACK_EVENT, {
    detail: signal,
  }));
}

/** Resolves the matching product incident without moving classification into Chat. */
export function reportPassiveFeedbackRecovery(resolution: PassiveFeedbackResolution): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<PassiveFeedbackResolution>(PASSIVE_FEEDBACK_RECOVERED_EVENT, {
    detail: resolution,
  }));
}
