
import app from "./app";
import { logger } from "./lib/logger";
import { startJvmWorker } from "./jvm-manager";

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

  if (process.env.MURPH_JVM_ENABLED === "true") {
    void startJvmWorker().then((ok) => {
      logger.info({ ok }, "JVM worker startup finished");
    }).catch((error) => {
      logger.error({ error }, "JVM worker startup failed");
    });
  }
});
