import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const webDist = process.env.MURPH_WEB_DIST?.trim();
if (webDist) {
  const absoluteWebDist = path.resolve(webDist);
  app.use(express.static(absoluteWebDist, { maxAge: "1h", index: "index.html" }));
  app.use((req, res, next) => {
    if (
      req.method !== "GET" ||
      req.path.startsWith("/api/") ||
      req.path === "/api" ||
      path.extname(req.path)
    ) {
      next();
      return;
    }
    res.sendFile(path.join(absoluteWebDist, "index.html"));
  });
}

export default app;
