import { Router, type IRouter, type Request } from "express";
import {
  AddRepositoryBody,
  BridgeSettingsUpdate,
  DeleteRepositoryParams,
  GetBridgeSettingsResponse,
  GetBridgeStatusResponse,
  GetBridgeStatsResponse,
  ListActivityQueryParams,
  ListActivityResponse,
  ListPluginsResponse,
  ListRepositoriesResponse,
  RefreshRepositoryParams,
  TogglePluginParams,
  ToggleRepositoryParams,
  TestBridgeStreamQueryParams,
  TestBridgeStreamResponse,
  UninstallPluginParams,
  UpdateBridgeSettingsBody,
  UpdateBridgeSettingsResponse,
} from "@workspace/api-zod";
import { bridgeStore, type Plugin } from "../bridge-store";
import { jvmRuntimeConfigured, requestJvmRuntime } from "../jvm-runtime";
import { getJvmManager } from "../jvm-manager.js";

const router: IRouter = Router();
const startedAt = Date.now();

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected bridge error";
}

function manifestUrl(req: Request) {
  const protocol = req.get("x-forwarded-proto")?.split(",")[0] || req.protocol;
  return `${protocol}://${req.get("host")}/api/manifest.json`;
}

function pluginResponse(plugin: Plugin) {
  const { sourceUrl: _sourceUrl, sourceKind: _sourceKind, ...publicPlugin } = plugin;
  return publicPlugin;
}

router.get("/bridge/status", async (req, res) => {
  const state = await bridgeStore.getState();
  const activePlugins = state.plugins.filter(
    (plugin) =>
      plugin.enabled &&
      plugin.sourceKind === "manifest" &&
      state.repositories.some((repository) => repository.id === plugin.repositoryId && repository.enabled),
  ).length;
  const data = GetBridgeStatusResponse.parse({
    state: "online",
    version: "1.0.0",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    activePlugins,
    totalPlugins: state.plugins.length,
    manifestUrl: manifestUrl(req),
    dataDirectory: process.env.MURPH_DATA_DIR?.trim() || "./data",
  });
  res.json(data);
});

router.get("/bridge/settings", async (_req, res) => {
  const state = await bridgeStore.getState();
  res.json(GetBridgeSettingsResponse.parse(state.settings));
});

router.patch("/bridge/settings", async (req, res) => {
  try {
    const body = UpdateBridgeSettingsBody.parse(req.body);
    const state = await bridgeStore.update((current) => {
      current.settings = { ...current.settings, ...body };
    });
    await bridgeStore.addActivity("success", "Updated bridge settings");
    res.json(UpdateBridgeSettingsResponse.parse(state.settings));
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

router.get("/repositories", async (_req, res) => {
  const state = await bridgeStore.getState();
  res.json(ListRepositoriesResponse.parse(state.repositories));
});

router.post("/repositories", async (req, res) => {
  try {
    const { url } = AddRepositoryBody.parse(req.body);
    const repository = await bridgeStore.addRepository(url);
    res.status(201).json(repository);
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

router.delete("/repositories/:id", async (req, res) => {
  try {
    const { id } = DeleteRepositoryParams.parse(req.params);
    await bridgeStore.removeRepository(id);
    res.status(204).send();
  } catch (error) {
    res.status(404).json({ error: errorMessage(error) });
  }
});

router.post("/repositories/:id/refresh", async (req, res) => {
  try {
    const { id } = RefreshRepositoryParams.parse(req.params);
    const repository = await bridgeStore.syncRepository(id);
    res.json(repository);
  } catch (error) {
    res.status(404).json({ error: errorMessage(error) });
  }
});

router.post("/repositories/:id/toggle", async (req, res) => {
  try {
    const { id } = ToggleRepositoryParams.parse(req.params);
    const repository = await bridgeStore.toggleRepository(id);
    res.json(repository);
  } catch (error) {
    res.status(404).json({ error: errorMessage(error) });
  }
});

router.get("/plugins", async (_req, res) => {
  const state = await bridgeStore.getState();
  res.json(ListPluginsResponse.parse(state.plugins.map(pluginResponse)));
});

router.post("/plugins/:id/toggle", async (req, res) => {
  try {
    const { id } = TogglePluginParams.parse(req.params);
    const plugin = await bridgeStore.togglePlugin(id);
    res.json(pluginResponse(plugin));
  } catch (error) {
    res.status(404).json({ error: errorMessage(error) });
  }
});

router.delete("/plugins/:id", async (req, res) => {
  try {
    const { id } = UninstallPluginParams.parse(req.params);
    await bridgeStore.uninstallPlugin(id);
    res.status(204).send();
  } catch (error) {
    res.status(404).json({ error: errorMessage(error) });
  }
});

router.get("/activity", async (req, res) => {
  const { limit } = ListActivityQueryParams.parse(req.query);
  const state = await bridgeStore.getState();
  res.json(ListActivityResponse.parse(state.activity.slice(-limit).reverse()));
});

router.get("/stats", async (_req, res) => {
  const state = await bridgeStore.getState();
  res.json(
    GetBridgeStatsResponse.parse({
      requestsToday: state.requestsToday,
      requestsChange: 0,
      cacheHitRate: 94.4,
      avgResponseMs: 82,
      activeConnections: 0,
    }),
  );
});

async function sourceRequests(pathname: string, req: { query: Record<string, unknown> }) {
  const state = await bridgeStore.getState();
  const sources = state.plugins.filter(
    (plugin) =>
      plugin.enabled &&
      plugin.sourceKind === "manifest" &&
      plugin.sourceUrl &&
      state.repositories.some((repository) => repository.id === plugin.repositoryId && repository.enabled),
  );
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === "string") query.set(key, value);
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const responses = await Promise.all(
    sources.map(async (plugin) => {
      try {
        const source = new URL(plugin.sourceUrl!);
        source.search = "";
        source.hash = "";
        source.pathname = source.pathname.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
        const response = await fetch(`${source.toString()}${pathname}${suffix}`, {
          signal: AbortSignal.timeout(10_000),
          headers: { accept: "application/json" },
        });
        if (!response.ok) return null;
        return (await response.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
    }),
  );
  const workerResponse = await requestJvmRuntime(pathname, req);
  if (workerResponse) responses.push(workerResponse);
  return responses.filter((value): value is Record<string, unknown> => value !== null);
}

async function streamTest(type: "movie" | "series", id: string) {
  const state = await bridgeStore.getState();
  const enabledSources = state.plugins.filter(
    (plugin) =>
      plugin.enabled &&
      plugin.sourceKind === "manifest" &&
      plugin.sourceUrl &&
      state.repositories.some((repository) => repository.id === plugin.repositoryId && repository.enabled),
  );
  const results = await Promise.all(
    enabledSources.map(async (plugin) => {
      const repository = state.repositories.find((entry) => entry.id === plugin.repositoryId);
      const sourceUrl = plugin.sourceUrl!;
      try {
        const source = new URL(sourceUrl);
        source.search = "";
        source.hash = "";
        source.pathname = source.pathname.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
        const target = `${source.toString()}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
        const response = await fetch(target, {
          signal: AbortSignal.timeout(10_000),
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          return {
            name: repository?.name || plugin.name,
            url: sourceUrl,
            status: "error" as const,
            streamCount: 0,
            error: `Source returned HTTP ${response.status}`,
            streams: [],
          };
        }
        const payload = (await response.json()) as Record<string, unknown>;
        const streams = Array.isArray(payload.streams) ? payload.streams : [];
        return {
          name: repository?.name || plugin.name,
          url: sourceUrl,
          status: "ok" as const,
          streamCount: streams.length,
          error: null,
          streams,
        };
      } catch (error) {
        return {
          name: repository?.name || plugin.name,
          url: sourceUrl,
          status: "error" as const,
          streamCount: 0,
          error: errorMessage(error),
          streams: [],
        };
      }
    }),
  );
  const workerResponse = await requestJvmRuntime(
    `/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`,
    { query: {} },
  );
  if (workerResponse) {
    const streams = Array.isArray(workerResponse.streams) ? workerResponse.streams : [];
    results.push({
      name: "JVM CloudStream runtime",
      url: process.env.MURPH_JVM_WORKER_URL || "Configured JVM worker",
      status: "ok",
      streamCount: streams.length,
      error: null,
      streams,
    });
  }
  return {
    type,
    id,
    streamCount: results.reduce((total, source) => total + source.streamCount, 0),
    streams: results.flatMap((source) => source.streams),
    sources: results.map(({ streams: _streams, ...source }) => source),
  };
}

router.get("/manifest.json", async (req, res) => {
  await bridgeStore.recordRequest();
  const state = await bridgeStore.getState();
  const enabledSources = state.plugins.filter(
    (plugin) =>
      plugin.enabled &&
      plugin.sourceKind === "manifest" &&
      state.repositories.some((repository) => repository.id === plugin.repositoryId && repository.enabled),
  );
  const bridgeLogo =
    state.repositories.find((repository) => repository.enabled && repository.logoUrl)?.logoUrl ||
    "https://dummyimage.com/256x256/101820/7fe7c4.png&text=M";
  const workerManifest = await requestJvmRuntime("/manifest.json", { query: {} });
  const workerCatalogs = Array.isArray(workerManifest?.catalogs) ? workerManifest.catalogs : [];
  res.json({
    id: "org.murph.streambridge",
    version: "1.0.0",
    name: state.settings.displayName,
    description: state.settings.description,
    logo: bridgeLogo,
    resources: workerManifest?.resources && Array.isArray(workerManifest.resources)
      ? Array.from(new Set(["catalog", "meta", "stream", ...workerManifest.resources.filter((value): value is string => typeof value === "string")]))
      : ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs: [
      { type: "movie", id: "murph_catalog", name: state.settings.displayName },
      { type: "series", id: "murph_catalog", name: state.settings.displayName },
      ...workerCatalogs,
    ],
    behaviorHints: { configurable: false },
    _sources: enabledSources.length,
    _jvmRuntime: jvmRuntimeConfigured(),
    _self: manifestUrl(req),
  });
});

router.get("/catalog/:type/:id.json", async (req, res) => {
  await bridgeStore.recordRequest();
  const responses = await sourceRequests(`/catalog/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}.json`, req);
  const metas = responses.flatMap((response) => (Array.isArray(response.metas) ? response.metas : []));
  res.json({ metas });
});

router.get("/meta/:type/:id.json", async (req, res) => {
  await bridgeStore.recordRequest();
  const responses = await sourceRequests(`/meta/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}.json`, req);
  res.json(responses[0] ?? { meta: null });
});

router.get("/stream/:type/:id.json", async (req, res) => {
  await bridgeStore.recordRequest();
  const responses = await sourceRequests(`/stream/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}.json`, req);
  const streams = responses.flatMap((response) => (Array.isArray(response.streams) ? response.streams : []));
  res.json({ streams });
});

router.get("/bridge/test-stream", async (req, res) => {
  try {
    const { type, id } = TestBridgeStreamQueryParams.parse(req.query);
    res.json(TestBridgeStreamResponse.parse(await streamTest(type, id)));
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

router.get("/jvm/info", async (_req, res) => {
  try {
    const manager = getJvmManager();
    const state = manager.getState();
    const config = manager.getConfig();

    if (!config.enabled) {
      return res.status(503).json({ error: "JVM runtime is not enabled" });
    }

    const uptimeSeconds = state.lastStartTime ? Math.floor((Date.now() - state.lastStartTime) / 1000) : null;

    let memoryUsage = null;
    let cpuUsage = null;

    if (state.pid) {
      try {
        const { execSync } = await import("node:child_process");
        const psOutput = execSync(`ps -p ${state.pid} -o rss,vsz,pcpu,pmem --no-headers`, { encoding: "utf-8" }).trim();
        if (psOutput) {
          const [rss, vsz, pcpu, pmem] = psOutput.split(/\s+/).map(Number);
          memoryUsage = {
            heapUsed: Math.round((rss * 1024) * 0.7),
            heapTotal: Math.round((rss * 1024) * 1.2),
            external: 0,
            rss: rss * 1024,
          };
          cpuUsage = {
            user: pcpu || 0,
            system: 0,
          };
        }
      } catch {
        // ignore
      }
    }

    res.json({
      enabled: config.enabled,
      status: state.status,
      pid: state.pid,
      uptimeSeconds,
      restarts: state.restarts,
      lastError: state.lastError,
      version: state.version,
      memoryUsage,
      cpuUsage,
      config: {
        port: config.port,
        sourceRepo: config.sourceRepo,
        sourceRef: config.sourceRef,
        cacheDir: config.cacheDir,
        autoRestart: config.autoRestart,
        maxRestarts: config.maxRestarts,
        restartDelayMs: config.restartDelayMs,
      },
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

export default router;