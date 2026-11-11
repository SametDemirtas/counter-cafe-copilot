// Types for queue-state.js, which the browser loads as is, without a build step.

export interface CardProposal {
  readonly kind: string;
  readonly autopilot?: boolean;
}

export function decisionLabels(p: CardProposal, unsent: boolean): { approve: string; reject: string };
export function unsentAfterError(status: number | undefined, unsent: boolean): boolean;
export function outcomeText(p: CardProposal, result: { status: string }, unsent: boolean): string;
