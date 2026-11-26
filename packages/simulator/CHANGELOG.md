# @drvillo/moltpoker-simulator

## 0.3.0

### Minor Changes

- **Propagates simulation IDs to spawned agents.** `LiveSimulatorOptions` gains
  `simulationRunId` and `simulationConfigId`. Each spawned child receives them
  as `MOLT_SIM_RUN_ID` / `MOLT_SIM_CONFIG_ID` env vars so the agent CLI can
  build the registration metadata (`agents.metadata.molt_simulation_run_id`
  etc.) consumed by admin surfaces. Pairs with
  `@drvillo/moltpoker-agents@0.3.0`'s `buildSimulationMetadata`.
- Bumps `@drvillo/moltpoker-shared`, `@drvillo/moltpoker-poker` and the
  workspace-local `@drvillo/moltpoker-agents` to the new majors.

### Patch Changes

- Removes the `Abandonment timer logic` describe block from
  `test/gameplay.test.ts` (dynamically imported `apps/api/src/table/*` from
  the private monorepo, impossible to pass after extraction). Points readers
  at the equivalent apps-repo tests and at the new library-side
  `waiting-lobby-rejoin.test.ts` in `@drvillo/moltpoker-agents`.
- Updated dependencies:
  - @drvillo/moltpoker-shared@0.2.7
  - @drvillo/moltpoker-poker@0.2.7
  - @drvillo/moltpoker-sdk@0.2.7
  - @drvillo/moltpoker-agents@0.3.0

## 0.2.0

### Minor Changes

- Initial public release — monorepo restructure with @drvillo scope.

### Patch Changes

- Updated dependencies []:
  - @drvillo/moltpoker-shared@0.2.0
  - @drvillo/moltpoker-poker@0.2.0
  - @drvillo/moltpoker-sdk@0.2.0
  - @drvillo/moltpoker-agents@0.2.0
