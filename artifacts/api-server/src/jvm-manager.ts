import { spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..", "..");

interface JvmConfig {
  enabled: boolean;
  sourceRepo: string;
  sourceRef: string;
  sourceDir: string;
  cacheDir: string;
  port: number;
  workerUrl: string;
  timeoutMs: number;
  autoRestart: boolean;
  maxRestarts: number;
  restartDelayMs: number;
}

interface JvmState {
  pid: number | null;
  status: "stopped" | "starting" | "running" | "error" | "stopping";
  lastError: string | null;
  restarts: number;
  lastStartTime: number | null;
  version: string | null;
}

const DEFAULT_CONFIG: JvmConfig = {
  enabled: process.env.MURPH_JVM_ENABLED === "true",
  sourceRepo: process.env.MURPH_JVM_SOURCE_REPO || "https://github.com/deepu2135/CNCVerse-Bridge.git",
  sourceRef: process.env.MURPH_JVM_SOURCE_REF || "main",
  sourceDir: process.env.MURPH_JVM_SOURCE_DIR || resolve(ROOT_DIR, ".cache", "cncverse-bridge"),
  cacheDir: process.env.MURPH_JVM_CACHE_DIR || resolve(ROOT_DIR, "data", "jvm"),
  port: Number(process.env.PORT || process.env.MURPH_JVM_PORT || 8787),
  workerUrl: process.env.MURPH_JVM_WORKER_URL || `http://127.0.0.1:${process.env.PORT || 8787}`,
  timeoutMs: Number(process.env.MURPH_JVM_TIMEOUT_MS || 30000),
  autoRestart: process.env.MURPH_JVM_AUTO_RESTART !== "false",
  maxRestarts: Number(process.env.MURPH_JVM_MAX_RESTARTS || 5),
  restartDelayMs: Number(process.env.MURPH_JVM_RESTART_DELAY_MS || 5000),
};

const STATE_FILE = resolve(DEFAULT_CONFIG.cacheDir, "jvm-state.json");

class JvmManager {
  private config: JvmConfig;
  private state: JvmState;
  private process: ChildProcess | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config: Partial<JvmConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.loadState();
    this.ensureDirs();
  }

  private ensureDirs(): void {
    mkdirSync(this.config.cacheDir, { recursive: true });
    mkdirSync(dirname(this.config.sourceDir), { recursive: true });
  }

  private loadState(): JvmState {
    try {
      if (existsSync(STATE_FILE)) {
        return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      }
    } catch {
      // ignore
    }
    return {
      pid: null,
      status: "stopped",
      lastError: null,
      restarts: 0,
      lastStartTime: null,
      version: null,
    };
  }

  private saveState(): void {
    try {
      writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch {
      // ignore
    }
  }

  private updateState(updates: Partial<JvmState>): void {
    this.state = { ...this.state, ...updates };
    this.saveState();
  }

  async isHealthy(): Promise<boolean> {
    if (!this.config.enabled || this.state.status !== "running") return false;

    try {
      const response = await fetch(`${this.config.workerUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async waitForHealthy(timeoutMs = 60000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isHealthy()) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  private async downloadSource(): Promise<void> {
    const { execSync } = await import("node:child_process");
    if (!existsSync(resolve(this.config.sourceDir, "gradlew"))) {
      console.log("[JVM] Cloning CNCVerse-Bridge source...");
      execSync(`git clone --depth 1 --branch "${this.config.sourceRef}" "${this.config.sourceRepo}" "${this.config.sourceDir}"`, {
        stdio: "inherit",
      });
    } else {
      console.log("[JVM] Source already exists, pulling latest...");
      try {
        execSync(`git -C "${this.config.sourceDir}" fetch --depth 1 origin "${this.config.sourceRef}" && git -C "${this.config.sourceDir}" reset --hard FETCH_HEAD`, {
          stdio: "inherit",
        });
      } catch {
        console.warn("[JVM] Failed to update source, using cached version");
      }
    }
  }

  private async setupWorker(): Promise<void> {
    const { execSync } = await import("node:child_process");
    const workerSource = resolve(ROOT_DIR, "scripts", "jvm-worker");
    const workerDest = resolve(this.config.sourceDir, "headlessApp");

    console.log("[JVM] Setting up headlessApp module...");
    execSync(`rm -rf "${workerDest}" && cp -R "${workerSource}" "${workerDest}"`, { stdio: "inherit" });

    const settingsFile = resolve(this.config.sourceDir, "settings.gradle.kts");
    if (!readFileSync(settingsFile, "utf-8").includes('include(":headlessApp")')) {
      writeFileSync(settingsFile, readFileSync(settingsFile, "utf-8") + '\ninclude(":headlessApp")\n');
    }
  }

  private async buildWorker(): Promise<void> {
    const { execSync } = await import("node:child_process");
    console.log("[JVM] Building JVM worker (this may take a few minutes on first run)...");
    execSync(`./gradlew :headlessApp:installDist --no-daemon`, {
      cwd: this.config.sourceDir,
      stdio: "inherit",
      env: { ...process.env, GRADLE_OPTS: "-Xmx2g" },
    });
    console.log("[JVM] Build complete!");
  }

  private getWorkerBinary(): string {
    return resolve(this.config.sourceDir, "headlessApp", "build", "install", "headlessApp", "bin", "headlessApp");
  }

  async start(): Promise<boolean> {
    if (!this.config.enabled) {
      console.log("[JVM] JVM worker is disabled (set MURPH_JVM_ENABLED=true to enable)");
      return false;
    }

    if (this.state.status === "running" && this.process) {
      console.log("[JVM] Worker already running");
      return true;
    }

    this.updateState({ status: "starting", lastError: null });

    try {
      await this.downloadSource();
      await this.setupWorker();
      await this.buildWorker();

      const binary = this.getWorkerBinary();
      if (!existsSync(binary)) {
        throw new Error(`Worker binary not found at ${binary}`);
      }

      console.log("[JVM] Starting JVM worker on port", this.config.port);

      const env = {
        ...process.env,
        PORT: String(this.config.port),
        MURPH_JVM_CACHE_DIR: this.config.cacheDir,
        MURPH_CLOUDSTREAM_REPOSITORIES: process.env.MURPH_CLOUDSTREAM_REPOSITORIES || "",
      };

      this.process = spawn(binary, [], {
        env,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.process.stdout?.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) console.log("[JVM]", msg);
        if (msg.includes("listening on")) {
          this.updateState({ status: "running", pid: this.process?.pid || null, lastStartTime: Date.now(), restarts: 0 });
          this.startHealthCheck();
        }
      });

      this.process.stderr?.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) console.error("[JVM ERROR]", msg);
      });

      this.process.on("exit", (code, signal) => {
        console.log(`[JVM] Worker exited with code ${code}, signal ${signal}`);
        this.process = null;
        this.stopHealthCheck();
        if (this.state.status !== "stopping") {
          this.updateState({ status: "error", lastError: `Process exited: ${code ?? signal}` });
          this.scheduleRestart();
        } else {
          this.updateState({ status: "stopped", pid: null });
        }
      });

      this.startupTimeout = setTimeout(() => {
        if (this.state.status === "starting") {
          console.error("[JVM] Startup timeout");
          this.process?.kill("SIGKILL");
        }
      }, 120000);

      return await this.waitForHealthy(120000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[JVM] Failed to start:", message);
      this.updateState({ status: "error", lastError: message });
      this.scheduleRestart();
      return false;
    }
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(async () => {
      if (this.state.status !== "running") return;
      const healthy = await this.isHealthy();
      if (!healthy) {
        console.warn("[JVM] Health check failed, scheduling restart");
        this.process?.kill("SIGTERM");
      }
    }, 30000);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
  }

  private scheduleRestart(): void {
    if (!this.config.autoRestart) return;
    if (this.state.restarts >= this.config.maxRestarts) {
      console.error(`[JVM] Max restarts (${this.config.maxRestarts}) reached, giving up`);
      this.updateState({ status: "error", lastError: "Max restarts reached" });
      return;
    }

    const delay = this.config.restartDelayMs * Math.pow(1.5, this.state.restarts);
    console.log(`[JVM] Scheduling restart in ${delay}ms (attempt ${this.state.restarts + 1}/${this.config.maxRestarts})`);

    setTimeout(() => {
      if (this.state.status === "error") {
        this.updateState({ restarts: this.state.restarts + 1 });
        this.start();
      }
    }, delay);
  }

  async stop(): Promise<void> {
    this.updateState({ status: "stopping" });
    this.stopHealthCheck();

    if (this.process) {
      this.process.kill("SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill("SIGKILL");
          resolve(void 0);
        }, 10000);
        this.process?.on("exit", () => {
          clearTimeout(timeout);
          resolve(void 0);
        });
      });
      this.process = null;
    }

    this.updateState({ status: "stopped", pid: null });
  }

  async restart(): Promise<boolean> {
    await this.stop();
    return this.start();
  }

  getState(): JvmState {
    return { ...this.state };
  }

  getConfig(): JvmConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<JvmConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

let globalManager: JvmManager | null = null;

export function getJvmManager(config?: Partial<JvmConfig>): JvmManager {
  if (!globalManager) {
    globalManager = new JvmManager(config);
  }
  return globalManager;
}

export async function startJvmWorker(config?: Partial<JvmConfig>): Promise<boolean> {
  const manager = getJvmManager(config);
  return manager.start();
}

export async function stopJvmWorker(): Promise<void> {
  if (globalManager) {
    await globalManager.stop();
  }
}

export async function restartJvmWorker(): Promise<boolean> {
  if (globalManager) {
    return globalManager.restart();
  }
  return false;
}

export function getJvmState(): JvmState | null {
  return globalManager?.getState() || null;
}

export function isJvmEnabled(): boolean {
  return DEFAULT_CONFIG.enabled;
}

export function getJvmWorkerUrl(): string {
  return DEFAULT_CONFIG.workerUrl;
}

export function isJvmRuntimeConfigured(): boolean {
  return DEFAULT_CONFIG.enabled;
}