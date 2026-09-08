import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type RepositoryStatus = "ready" | "syncing" | "error";
export type PluginStatus = "active" | "disabled" | "available" | "error";
export type ActivityLevel = "info" | "success" | "warning" | "error";

export interface BridgeSettings {
  displayName: string;
  description: string;
  autoRefresh: boolean;
  refreshIntervalMinutes: number;
  allowRemoteControl: boolean;
}

export interface Repository {
  id: string;
  url: string;
  name: string;
  description: string;
  pluginCount: number;
  status: RepositoryStatus;
  lastSyncedAt: string | null;
  error: string | null;
  enabled: boolean;
  logoUrl: string | null;
}

export interface Plugin {
  id: string;
  name: string;
  description: string;
  version: string;
  repositoryId: string;
  category: string;
  supportedTypes: string[];
  enabled: boolean;
  installed: boolean;
  status: PluginStatus;
  logoUrl: string | null;
  sourceUrl?: string;
  sourceKind?: "manifest" | "cloudstream";
}

export interface ActivityEntry {
  id: string;
  level: ActivityLevel;
  message: string;
  createdAt: string;
}

interface PersistedState {
  settings: BridgeSettings;
  repositories: Repository[];
  plugins: Plugin[];
  activity: ActivityEntry[];
  requestsToday: number;
  requestsDay: string;
  startedAt: string;
}

const defaultSettings: BridgeSettings = {
  displayName: "Murph Stream Bridge",
  description: "A small, free bridge for self-hosted Stremio sources.",
  autoRefresh: true,
  refreshIntervalMinutes: 60,
  allowRemoteControl: true,
};

const defaultManifestSource = "https://v3-cinemeta.strem.io/manifest.json";

function dataDirectory() {
  return process.env.MURPH_DATA_DIR?.trim() || path.resolve(process.cwd(), "data");
}

function stateFile() {
  return path.join(dataDirectory(), "murph-state.json");
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (
    process.env.ALLOW_PRIVATE_SOURCES === "true" ||
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local")
  ) {
    return process.env.ALLOW_PRIVATE_SOURCES !== "true";
  }

  if (host === "127.0.0.1" || host.startsWith("10.") || host.startsWith("192.168.")) {
    return true;
  }

  const private172 = host.match(/^172\.(\d+)\./);
  return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
}

export function validateSourceUrl(rawUrl: string) {
  const parsed = new URL(rawUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Source URL must use http or https");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error("Private and local source URLs are disabled by default");
  }
  return parsed.toString();
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Source returned HTTP ${response.status}`);
  }
  return response.json();
}

function emptyState(): PersistedState {
  const repository: Repository = {
    id: "cinemeta",
    url: defaultManifestSource,
    name: "Cinemeta",
    description: "A ready-to-use movie and series catalog source.",
    pluginCount: 1,
    status: "ready",
    lastSyncedAt: new Date().toISOString(),
    error: null,
    enabled: true,
    logoUrl: null,
  };
  return {
    settings: defaultSettings,
    repositories: [repository],
    plugins: [
      {
        id: "cinemeta-source",
        name: "Cinemeta",
        description: repository.description,
        version: "1.0.0",
        repositoryId: repository.id,
        category: "Movie and series catalog",
        supportedTypes: ["movie", "series"],
        enabled: true,
        installed: true,
        status: "active",
        sourceUrl: defaultManifestSource,
        sourceKind: "manifest",
        logoUrl: null,
      },
    ],
    activity: [
      {
        id: randomUUID(),
        level: "success",
        message: "Murph Stream Bridge is ready",
        createdAt: new Date().toISOString(),
      },
    ],
    requestsToday: 0,
    requestsDay: todayKey(),
    startedAt: new Date().toISOString(),
  };
}

class BridgeStore {
  private state: PersistedState | null = null;
  private writeQueue = Promise.resolve();

  async getState() {
    if (this.state) return this.state;
    try {
      const raw = await readFile(stateFile(), "utf8");
      this.state = JSON.parse(raw) as PersistedState;
      this.state.repositories = this.state.repositories.map((repository) => ({
        ...repository,
        enabled: repository.enabled ?? true,
        logoUrl: repository.logoUrl ?? null,
      }));
      this.state.plugins = this.state.plugins.map((plugin) => ({
        ...plugin,
        logoUrl: plugin.logoUrl ?? null,
      }));
      await this.persist();
    } catch {
      this.state = emptyState();
      await this.persist();
    }
    return this.state;
  }

  private async persist() {
    const state = this.state;
    if (!state) return;
    await mkdir(dataDirectory(), { recursive: true });
    const temporaryFile = `${stateFile()}.tmp`;
    this.writeQueue = this.writeQueue.then(async () => {
      await writeFile(temporaryFile, JSON.stringify(state, null, 2), "utf8");
      await rename(temporaryFile, stateFile());
    });
    await this.writeQueue;
  }

  async update(mutator: (state: PersistedState) => void) {
    const state = await this.getState();
    mutator(state);
    await this.persist();
    return state;
  }

  async addActivity(level: ActivityLevel, message: string) {
    await this.update((state) => {
      state.activity = [
        ...state.activity,
        { id: randomUUID(), level, message, createdAt: new Date().toISOString() },
      ].slice(-100);
    });
  }

  async recordRequest() {
    await this.update((state) => {
      const today = todayKey();
      if (state.requestsDay !== today) {
        state.requestsDay = today;
        state.requestsToday = 0;
      }
      state.requestsToday += 1;
    });
  }

  async syncRepository(repositoryId: string) {
    const state = await this.getState();
    const repository = state.repositories.find((entry) => entry.id === repositoryId);
    if (!repository) throw new Error("Repository not found");

    await this.update((current) => {
      const entry = current.repositories.find((item) => item.id === repositoryId);
      if (entry) {
        entry.status = "syncing";
        entry.error = null;
      }
    });

    try {
      const payload = await fetchJson(repository.url);
      const payloadRecord =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {};
      const isManifest =
        Array.isArray(payloadRecord.resources) || typeof payloadRecord.id === "string";
      const cloudStreamPlugins = Array.isArray(payloadRecord.pluginLists)
        ? (
            await Promise.all(
              payloadRecord.pluginLists
                .filter((value): value is string => typeof value === "string")
                .map(async (listUrl) => {
                  try {
                    const listPayload = await fetchJson(validateSourceUrl(listUrl));
                    if (Array.isArray(listPayload)) return listPayload;
                    if (
                      listPayload &&
                      typeof listPayload === "object" &&
                      Array.isArray((listPayload as Record<string, unknown>).plugins)
                    ) {
                      return (listPayload as Record<string, unknown>).plugins as unknown[];
                    }
                  } catch {
                    return [];
                  }
                  return [];
                }),
            )
          ).flat()
        : [];
      const discoveredPlugins: Plugin[] = isManifest
        ? [
            {
              id: `${repositoryId}-manifest`,
              name: typeof payloadRecord.name === "string" ? payloadRecord.name : repository.name,
              description:
                typeof payloadRecord.description === "string"
                  ? payloadRecord.description
                  : "Remote Stremio source",
              version: typeof payloadRecord.version === "string" ? payloadRecord.version : "1.0.0",
              repositoryId,
              category: "Stremio source",
              supportedTypes: Array.isArray(payloadRecord.types)
                ? payloadRecord.types.filter((value): value is string => typeof value === "string")
                : ["movie", "series"],
              enabled: true,
              installed: true,
              status: "active",
              sourceUrl: repository.url,
              sourceKind: "manifest",
              logoUrl: typeof payloadRecord.logo === "string" ? payloadRecord.logo : null,
            },
          ]
        : cloudStreamPlugins.length
          ? cloudStreamPlugins.flatMap((item, index) => {
              if (!item || typeof item !== "object") return [];
              const plugin = item as Record<string, unknown>;
              return [
                {
                  id: `${repositoryId}-${typeof plugin.internalName === "string" ? plugin.internalName : index}`,
                  name: typeof plugin.name === "string" ? plugin.name : `Plugin ${index + 1}`,
                  description: typeof plugin.description === "string" ? plugin.description : "CloudStream plugin",
                  version: String(plugin.version ?? "1"),
                  repositoryId,
                  category: "CloudStream extension",
                  supportedTypes: Array.isArray(plugin.tvTypes)
                    ? plugin.tvTypes.filter((value): value is string => typeof value === "string")
                    : ["movie", "series"],
                  enabled: false,
                  installed: false,
                  status: "available" as const,
                  sourceUrl: typeof plugin.url === "string" ? plugin.url : undefined,
                  sourceKind: "cloudstream" as const,
                  logoUrl: typeof plugin.iconUrl === "string" ? plugin.iconUrl : null,
                },
              ];
            })
          : [];

      await this.update((current) => {
        current.repositories = current.repositories.map((entry) =>
          entry.id === repositoryId
            ? {
                ...entry,
                name:
                  isManifest && typeof payloadRecord.name === "string"
                    ? payloadRecord.name
                    : typeof payloadRecord.name === "string"
                      ? payloadRecord.name
                      : entry.name,
                description:
                  typeof payloadRecord.description === "string"
                    ? payloadRecord.description
                    : entry.description,
                enabled: entry.enabled ?? true,
                logoUrl:
                  typeof payloadRecord.logo === "string"
                    ? payloadRecord.logo
                    : typeof payloadRecord.iconUrl === "string"
                      ? payloadRecord.iconUrl
                      : entry.logoUrl ?? null,
                pluginCount: discoveredPlugins.length,
                status: "ready",
                lastSyncedAt: new Date().toISOString(),
                error: null,
              }
            : entry,
        );
        current.plugins = [
          ...current.plugins.filter((plugin) => plugin.repositoryId !== repositoryId),
          ...discoveredPlugins,
        ];
      });
      await this.addActivity("success", `Synced ${repository.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read source";
      await this.update((current) => {
        const entry = current.repositories.find((item) => item.id === repositoryId);
        if (entry) {
          entry.status = "error";
          entry.error = message;
        }
      });
      await this.addActivity("error", `Sync failed for ${repository.name}: ${message}`);
    }

    const finalState = await this.getState();
    return finalState.repositories.find((entry) => entry.id === repositoryId)!;
  }

  async addRepository(url: string) {
    const normalizedUrl = validateSourceUrl(url);
    const state = await this.getState();
    if (state.repositories.some((repository) => repository.url === normalizedUrl)) {
      throw new Error("That source is already configured");
    }
    const repository: Repository = {
      id: randomUUID(),
      url: normalizedUrl,
      name: new URL(normalizedUrl).hostname,
      description: "Waiting for first sync",
      pluginCount: 0,
      status: "syncing",
      lastSyncedAt: null,
      error: null,
      enabled: true,
      logoUrl: null,
    };
    await this.update((current) => {
      current.repositories.push(repository);
    });
    await this.addActivity("info", `Added ${repository.name}`);
    return this.syncRepository(repository.id);
  }

  async removeRepository(repositoryId: string) {
    const state = await this.getState();
    if (!state.repositories.some((repository) => repository.id === repositoryId)) {
      throw new Error("Repository not found");
    }
    await this.update((current) => {
      current.repositories = current.repositories.filter((repository) => repository.id !== repositoryId);
      current.plugins = current.plugins.filter((plugin) => plugin.repositoryId !== repositoryId);
    });
    await this.addActivity("warning", "Removed a source and its plugins");
  }

  async toggleRepository(repositoryId: string) {
    const state = await this.getState();
    const repository = state.repositories.find((entry) => entry.id === repositoryId);
    if (!repository) throw new Error("Repository not found");
    await this.update((current) => {
      const currentRepository = current.repositories.find((entry) => entry.id === repositoryId);
      if (currentRepository) currentRepository.enabled = !currentRepository.enabled;
    });
    const updated = (await this.getState()).repositories.find((entry) => entry.id === repositoryId)!;
    await this.addActivity("info", `${updated.enabled ? "Enabled" : "Disabled"} ${updated.name}`);
    return updated;
  }

  async togglePlugin(pluginId: string) {
    const state = await this.getState();
    const plugin = state.plugins.find((entry) => entry.id === pluginId);
    if (!plugin) throw new Error("Plugin not found");
    await this.update((current) => {
      const currentPlugin = current.plugins.find((entry) => entry.id === pluginId);
      if (currentPlugin) {
        currentPlugin.enabled = !currentPlugin.enabled;
        currentPlugin.status = currentPlugin.enabled ? "active" : "disabled";
      }
    });
    const updated = (await this.getState()).plugins.find((entry) => entry.id === pluginId)!;
    await this.addActivity("info", `${updated.enabled ? "Enabled" : "Disabled"} ${updated.name}`);
    return updated;
  }

  async uninstallPlugin(pluginId: string) {
    const state = await this.getState();
    if (!state.plugins.some((plugin) => plugin.id === pluginId)) {
      throw new Error("Plugin not found");
    }
    await this.update((current) => {
      current.plugins = current.plugins.filter((plugin) => plugin.id !== pluginId);
    });
    await this.addActivity("warning", "Removed a plugin");
  }
}

export const bridgeStore = new BridgeStore();
export { defaultManifestSource };