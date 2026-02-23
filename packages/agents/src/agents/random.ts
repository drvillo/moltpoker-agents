import type { GameStatePayload, LegalAction, PlayerAction } from '@moltpoker/shared';

import { createAction } from './types.js';
import { DeterministicAgentBase } from './base.js';

/**
 * Random agent - randomly selects from legal actions
 * Good for testing basic functionality
 */
export class RandomAgent extends DeterministicAgentBase {
  constructor() {
    super({ name: 'RandomAgent', agentType: 'random' });
  }

  getAction(state: GameStatePayload, legalActions: LegalAction[]): PlayerAction {
    if (legalActions.length === 0) {
      throw new Error('No legal actions available');
    }

    // Randomly select an action
    const randomIndex = Math.floor(Math.random() * legalActions.length);
    const selectedAction = legalActions[randomIndex]!;

    // If it's a raise, pick a random amount within the legal range
    let amount: number | undefined;
    if (selectedAction.kind === 'raiseTo' && selectedAction.minAmount && selectedAction.maxAmount) {
      const minAmount = selectedAction.minAmount;
      const maxAmount = selectedAction.maxAmount;
      amount = Math.floor(Math.random() * (maxAmount - minAmount + 1)) + minAmount;
    }

    return createAction(selectedAction.kind, state, amount);
  }

}
