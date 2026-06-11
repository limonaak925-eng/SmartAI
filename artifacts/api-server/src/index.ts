import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot/index.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  startKeepalive(port);
});

startBot();

// ─── Keepalive ping for Render free tier ─────────────────────────────────────
// Render spins down free Web Services after 15 min of inactivity.
// We ping our own /api/healthz every 14 min to stay awake.
function startKeepalive(p: number) {
  const url = `http://localhost:${p}/api/healthz`;
  const INTERVAL_MS = 14 * 60 * 1000;

  setInterval(async () => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(5000) });
      logger.info("Keepalive ping OK");
    } catch (err) {
      logger.warn({ err }, "Keepalive ping failed");
    }
  }, INTERVAL_MS);

  logger.info({ interval: "14min" }, "Keepalive started");
}
