import { readFileSync } from 'fs';

import { TableRuntime, type TableRuntimeConfig } from '@moltpoker/poker';
import type { EventRecord } from '@moltpoker/shared';

export interface ReplayOptions {
  eventsPath: string;
  verify?: boolean;
  verbose?: boolean;
}

export interface ReplayResult {
  success: boolean;
  handsReplayed: number;
  errors: string[];
  chipConservationViolations: string[];
  illegalStateTransitions: string[];
}

interface ParsedEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  handNumber?: number;
}

/**
 * Replay simulator - replays events to verify determinism
 */
export class ReplaySimulator {
  private options: ReplayOptions;

  constructor(options: ReplayOptions) {
    this.options = options;
  }

  /**
   * Run the replay
   */
  run(): ReplayResult {
    const errors: string[] = [];
    const chipViolations: string[] = [];
    const stateViolations: string[] = [];
    let handsReplayed = 0;

    // Load events
    const events = this.loadEvents();

    if (events.length === 0) {
      return {
        success: false,
        handsReplayed: 0,
        errors: ['No events found in file'],
        chipConservationViolations: [],
        illegalStateTransitions: [],
      };
    }

    // Find TABLE_STARTED event for config
    const startEvent = events.find((e) => e.type === 'TABLE_STARTED');
    if (!startEvent) {
      return {
        success: false,
        handsReplayed: 0,
        errors: ['No TABLE_STARTED event found'],
        chipConservationViolations: [],
        illegalStateTransitions: [],
      };
    }

    const config = startEvent.payload.config as {
      blinds: { small: number; big: number };
      maxSeats: number;
      initialStack: number;
      actionTimeoutMs: number;
      seed?: string;
    };

    // Create runtime
    const runtimeConfig: TableRuntimeConfig = {
      tableId: 'replay',
      blinds: config.blinds,
      maxSeats: config.maxSeats,
      initialStack: config.initialStack,
      actionTimeoutMs: config.actionTimeoutMs,
      seed: config.seed,
    };

    const runtime = new TableRuntime(runtimeConfig);
    let totalChips = 0;

    // Process events
    for (const event of events) {
      try {
        this.processEvent(runtime, event);

        // Track hand completion
        if (event.type === 'HAND_START') {
          if (this.options.verbose) {
            const payload = event.payload as { handNumber: number };
            console.log(`Replaying hand ${payload.handNumber}...`);
          }
        }

        if (event.type === 'HAND_COMPLETE') {
          handsReplayed++;

          // Verify chip conservation
          if (this.options.verify) {
            const currentTotalChips = runtime
              .getAllPlayers()
              .reduce((sum, p) => sum + p.stack, 0);

            if (totalChips === 0) {
              totalChips = currentTotalChips;
            } else if (currentTotalChips !== totalChips) {
              chipViolations.push(
                `Hand ${handsReplayed}: Chip count changed from ${totalChips} to ${currentTotalChips}`
              );
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Event ${event.seq}: ${message}`);
        stateViolations.push(`Event ${event.seq}: Illegal state transition`);
      }
    }

    const success =
      errors.length === 0 && chipViolations.length === 0 && stateViolations.length === 0;

    return {
      success,
      handsReplayed,
      errors,
      chipConservationViolations: chipViolations,
      illegalStateTransitions: stateViolations,
    };
  }

  /**
   * Load events from file
   */
  private loadEvents(): ParsedEvent[] {
    const content = readFileSync(this.options.eventsPath, 'utf-8');

    // Support both JSON and JSONL
    if (this.options.eventsPath.endsWith('.jsonl')) {
      return content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as ParsedEvent);
    }

    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  /**
   * Process a single event
   */
  private processEvent(runtime: TableRuntime, event: ParsedEvent): void {
    switch (event.type) {
      case 'TABLE_STARTED':
        // Already handled for config
        break;

      case 'PLAYER_JOINED': {
        const payload = event.payload as {
          seatId: number;
          agentId: string;
          agentName: string | null;
          stack: number;
        };
        runtime.addPlayer(payload.seatId, payload.agentId, payload.agentName, payload.stack);
        break;
      }

      case 'HAND_START': {
        runtime.startHand();
        break;
      }

      case 'PLAYER_ACTION': {
        const payload = event.payload as {
          seatId: number;
          turnToken?: string;
          actionId?: string;
          kind: 'fold' | 'check' | 'call' | 'raiseTo';
          amount?: number;
        };
        runtime.applyAction(payload.seatId, {
          turn_token: payload.turnToken ?? payload.actionId ?? crypto.randomUUID(),
          kind: payload.kind,
          amount: payload.amount,
        });
        break;
      }

      case 'STREET_DEALT':
      case 'SHOWDOWN':
      case 'HAND_COMPLETE':
      case 'POT_AWARDED':
      case 'PLAYER_TIMEOUT':
      case 'PLAYER_LEFT':
      case 'TABLE_ENDED':
        // These are informational events, no action needed
        break;

      default:
        if (this.options.verbose) {
          console.log(`Unknown event type: ${event.type}`);
        }
    }
  }
}

/**
 * Export events to JSONL file
 */
export function exportEvents(events: EventRecord[], outputPath: string): void {
  const { writeFileSync } = require('fs');
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(outputPath, lines);
}
