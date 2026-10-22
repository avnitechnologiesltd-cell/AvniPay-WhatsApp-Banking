import "reflect-metadata";

/**
 * **Every injected constructor parameter in this workspace carries an explicit
 * `@Inject(...)`.**
 *
 * Nest can otherwise resolve a dependency from the parameter's *type*, using
 * the metadata `emitDecoratorMetadata` writes. `tsc` emits it and the esbuild
 * transform the test runner uses does not — so type-only injection resolves in
 * a built image and fails under test, which is the worst possible direction for
 * that difference to run.
 *
 * Naming the token removes the reliance on emitted metadata entirely, and makes
 * the wiring legible at the call site. Do not "tidy" the annotations away.
 */

export { StdoutLogger, type StdoutLoggerOptions } from "./logger";
export {
  HEALTH_OPTIONS,
  HealthController,
  HealthModule,
  type HealthOptions,
  type LivenessBody,
  type ReadinessBody,
  type ReadinessCheck,
} from "./health";
export {
  runEntryPoint,
  startService,
  type RunningService,
  type StartOptions,
} from "./bootstrap";
export { databaseReadinessCheck } from "./readiness";
export { DATABASE_POOL, DatabaseModule, versionOf } from "./database";
export { CLOCK, systemClock, type Clock } from "./clock";
export {
  S3ObjectStore,
  type ObjectReader,
  type ObjectStore,
  type ObjectStoreOptions,
  type ObjectWriter,
  type StoredObject,
} from "./object-store";
