import type { Card, GameStatePayload, LegalAction, PlayerAction } from '@moltpoker/shared';

import { createAction } from './types.js';
import { DeterministicAgentBase } from './base.js';

/**
 * Tight agent - plays conservatively
 * - Folds most hands preflop
 * - Calls with strong hands
 * - Rarely raises
 */
export class TightAgent extends DeterministicAgentBase {
  constructor() {
    super({ name: 'TightAgent', agentType: 'tight' });
  }

  getAction(state: GameStatePayload, legalActions: LegalAction[]): PlayerAction {
    if (legalActions.length === 0) {
      throw new Error('No legal actions available');
    }

    // Find our hole cards
    const mySeat = state.players.find((p) => p.holeCards && p.holeCards.length > 0);
    const holeCards = mySeat?.holeCards || [];

    // Check if we can check (free action)
    const canCheck = legalActions.some((a) => a.kind === 'check');
    if (canCheck) {
      return createAction('check', state);
    }

    // Evaluate hand strength
    const handStrength = this.evaluatePreflop(holeCards);

    // Find call action
    const callAction = legalActions.find((a) => a.kind === 'call');
    const raiseAction = legalActions.find((a) => a.kind === 'raiseTo');

    // Preflop strategy
    if (state.phase === 'preflop') {
      if (handStrength >= 0.8 && raiseAction) {
        // Premium hand - raise
        return createAction('raiseTo', state, raiseAction.minAmount);
      }

      if (handStrength >= 0.5 && callAction) {
        // Decent hand - call
        return createAction('call', state);
      }

      // Weak hand - fold
      return createAction('fold', state);
    }

    // Post-flop: be more conservative
    const potOdds = this.calculatePotOdds(state);

    if (potOdds < 0.2 && callAction) {
      // Good pot odds - call
      return createAction('call', state);
    }

    // Default to fold
    return createAction('fold', state);
  }

  /**
   * Evaluate preflop hand strength (0-1)
   */
  private evaluatePreflop(holeCards: Card[]): number {
    if (holeCards.length < 2) return 0;

    const [card1, card2] = holeCards;
    if (!card1 || !card2) return 0;

    const rank1 = this.rankValue(card1.rank);
    const rank2 = this.rankValue(card2.rank);
    const suited = card1.suit === card2.suit;
    const paired = card1.rank === card2.rank;

    // Premium pairs
    if (paired && rank1 >= 10) return 0.95; // TT+
    if (paired && rank1 >= 7) return 0.7; // 77-99
    if (paired) return 0.5; // 22-66

    // High cards
    const highCard = Math.max(rank1, rank2);
    const lowCard = Math.min(rank1, rank2);

    // AK, AQ, AJ
    if (highCard === 14 && lowCard >= 11) return suited ? 0.85 : 0.75;
    // KQ
    if (highCard === 13 && lowCard === 12) return suited ? 0.7 : 0.6;
    // Suited connectors
    if (suited && Math.abs(rank1 - rank2) === 1 && lowCard >= 8) return 0.55;
    // Any ace
    if (highCard === 14) return suited ? 0.5 : 0.4;
    // High suited
    if (suited && highCard >= 10) return 0.4;

    return 0.2;
  }

  /**
   * Calculate pot odds
   */
  private calculatePotOdds(state: GameStatePayload): number {
    const totalPot = state.pots.reduce((sum, p) => sum + p.amount, 0);
    const toCall = state.toCall || 0;

    if (totalPot === 0) return 1;
    return toCall / (totalPot + toCall);
  }

  /**
   * Convert rank to numeric value
   */
  private rankValue(rank: string): number {
    const values: Record<string, number> = {
      '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
      'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
    };
    return values[rank] || 0;
  }

}
