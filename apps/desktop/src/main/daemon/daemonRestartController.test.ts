import assert from "node:assert/strict";
import test from "node:test";
import {
  createDaemonRestartController,
  type DaemonRestartLogger
} from "./daemonRestartController.ts";

function silentLogger(): DaemonRestartLogger {
  return { info() {}, warn() {}, error() {} };
}

const config = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 5,
  healthyResetMs: 30_000
};

test("restarts the daemon once after an unexpected exit", async () => {
  let restartCount = 0;
  const delays: number[] = [];
  const controller = createDaemonRestartController({
    restart: async () => {
      restartCount += 1;
    },
    isStopRequested: () => false,
    delay: async (ms) => {
      delays.push(ms);
    },
    now: () => 0,
    logger: silentLogger(),
    config
  });

  await controller.notifyExited();

  assert.equal(restartCount, 1);
  assert.deepEqual(delays, [500]);
});

test("does not restart when stop was requested", async () => {
  let restartCount = 0;
  const controller = createDaemonRestartController({
    restart: async () => {
      restartCount += 1;
    },
    isStopRequested: () => true,
    delay: async () => {},
    now: () => 0,
    logger: silentLogger(),
    config
  });

  await controller.notifyExited();

  assert.equal(restartCount, 0);
});

test("uses exponential backoff and gives up after max attempts", async () => {
  let restartCount = 0;
  const delays: number[] = [];
  const errors: string[] = [];
  const controller = createDaemonRestartController({
    restart: async () => {
      restartCount += 1;
      throw new Error("boom");
    },
    isStopRequested: () => false,
    delay: async (ms) => {
      delays.push(ms);
    },
    now: () => 0,
    logger: {
      info() {},
      warn() {},
      error: (message: string) => {
        errors.push(message);
      }
    },
    config: {
      baseDelayMs: 500,
      maxDelayMs: 4_000,
      maxAttempts: 4,
      healthyResetMs: 30_000
    }
  });

  await controller.notifyExited();

  assert.equal(restartCount, 4);
  assert.deepEqual(delays, [500, 1_000, 2_000, 4_000]);
  assert.ok(errors.some((message) => message.includes("giving up")));
});

test("resets backoff after the daemon stays healthy", async () => {
  let restartCount = 0;
  let clock = 0;
  const delays: number[] = [];
  const controller = createDaemonRestartController({
    restart: async () => {
      restartCount += 1;
    },
    isStopRequested: () => false,
    delay: async (ms) => {
      delays.push(ms);
    },
    now: () => clock,
    logger: silentLogger(),
    config
  });

  await controller.notifyExited();
  clock = 60_000;
  await controller.notifyExited();

  assert.equal(restartCount, 2);
  assert.deepEqual(delays, [500, 500]);
});

test("keeps escalating backoff when the daemon dies again quickly", async () => {
  let clock = 0;
  const delays: number[] = [];
  const controller = createDaemonRestartController({
    restart: async () => {},
    isStopRequested: () => false,
    delay: async (ms) => {
      delays.push(ms);
    },
    now: () => clock,
    logger: silentLogger(),
    config
  });

  await controller.notifyExited();
  clock = 5_000;
  await controller.notifyExited();
  clock = 10_000;
  await controller.notifyExited();

  assert.deepEqual(delays, [500, 1_000, 2_000]);
});

test("ignores a second exit notification while restarting", async () => {
  let restartCount = 0;
  let delayCount = 0;
  let releaseDelay!: () => void;
  const delayGate = new Promise<void>((resolve) => {
    releaseDelay = resolve;
  });
  const controller = createDaemonRestartController({
    restart: async () => {
      restartCount += 1;
    },
    isStopRequested: () => false,
    delay: async () => {
      delayCount += 1;
      await delayGate;
    },
    now: () => 0,
    logger: silentLogger(),
    config
  });

  // First exit enters the restart loop and parks on the (held) delay.
  const first = controller.notifyExited();
  // Second exit while the first restart cycle is in flight must be a no-op.
  const second = controller.notifyExited();
  releaseDelay();
  await Promise.all([first, second]);

  assert.equal(restartCount, 1);
  assert.equal(delayCount, 1);
});
