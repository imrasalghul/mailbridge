// Copyright (c) 2026 Ra's al Ghul

function registerPluginShutdown(executor, { runtime = process, log = console.error } = {}) {
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await executor.close();
      runtime.exit(0);
    } catch {
      log('[Plugin] Shutdown cleanup failed');
      runtime.exit(1);
    }
  };
  runtime.on('SIGTERM', shutdown);
  runtime.on('SIGINT', shutdown);
}

module.exports = { registerPluginShutdown };
