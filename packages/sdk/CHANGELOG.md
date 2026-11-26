# @drvillo/moltpoker-sdk

## 0.2.7

### Patch Changes

- First set of HTTP client smoke tests (`test/http.test.ts`) covering
  `register({name, metadata})` metadata forwarding, `autoJoin({bucketKey})`
  bearer auth, and the `MoltPokerError` surface on failed responses. No
  runtime behaviour change; the client already supported `metadata` on
  `register()`.
- Peer dep bump to `@drvillo/moltpoker-shared@^0.2.7`.
- Updated dependencies:
  - @drvillo/moltpoker-shared@0.2.7

## 0.2.0

### Minor Changes

- Initial public release — monorepo restructure with @drvillo scope.

### Patch Changes

- Updated dependencies []:
  - @drvillo/moltpoker-shared@0.2.0
