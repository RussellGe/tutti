export interface DaemonRestartLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface DaemonRestartConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  healthyResetMs: number;
}

export interface DaemonRestartControllerDeps {
  restart: () => Promise<void>;
  isStopRequested: () => boolean;
  delay: (ms: number) => Promise<void>;
  now: () => number;
  logger: DaemonRestartLogger;
  config?: DaemonRestartConfig;
}

export interface DaemonRestartController {
  notifyExited(): Promise<void>;
}

const defaultConfig: DaemonRestartConfig = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 5,
  healthyResetMs: 30_000
};

export function createDaemonRestartController(
  deps: DaemonRestartControllerDeps
): DaemonRestartController {
  const config = deps.config ?? defaultConfig;

  let attempts = 0;
  let lastHealthyAt: number | null = null;
  let inFlight: Promise<void> | null = null;

  function backoffDelayMs(attempt: number): number {
    return Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs);
  }

  async function runRestartLoop(): Promise<void> {
    while (!deps.isStopRequested()) {
      if (
        lastHealthyAt !== null &&
        deps.now() - lastHealthyAt >= config.healthyResetMs
      ) {
        attempts = 0;
      }

      if (attempts >= config.maxAttempts) {
        deps.logger.error("managed tuttid restart giving up", {
          attempts
        });
        return;
      }

      const waitMs = backoffDelayMs(attempts);
      attempts += 1;
      await deps.delay(waitMs);

      if (deps.isStopRequested()) {
        return;
      }

      try {
        await deps.restart();
        lastHealthyAt = deps.now();
        deps.logger.info("managed tuttid restarted", { attempts });
        return;
      } catch (error: unknown) {
        deps.logger.error("managed tuttid restart failed", {
          attempts,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  return {
    notifyExited() {
      if (deps.isStopRequested()) {
        return Promise.resolve();
      }

      if (inFlight) {
        return inFlight;
      }

      inFlight = runRestartLoop().finally(() => {
        inFlight = null;
      });
      return inFlight;
    }
  };
}
