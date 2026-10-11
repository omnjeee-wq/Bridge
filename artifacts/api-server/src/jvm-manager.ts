import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
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

const JVM_PORT = Number(process.env.MURPH_JVM_PORT || 8787);

const DEFAULT_CONFIG: JvmConfig = {
  enabled: process.env.MURPH_JVM_ENABLED === "true",
  sourceRepo:
    process.env.MURPH_JVM_SOURCE_REPO ||
    "https://github.com/deepu2135/CNCVerse-Bridge.git",
  sourceRef: process.env.MURPH_JVM_SOURCE_REF || "main",
  sourceDir:
    process.env.MURPH_JVM_SOURCE_DIR ||
    resolve(ROOT_DIR, ".cache", "cncverse-bridge"),
  cacheDir: process.env.MURPH_JVM_CACHE_DIR || "/data/jvm",
  port: JVM_PORT,
  workerUrl:
    process.env.MURPH_JVM_WORKER_URL ||
    `http://127.0.0.1:${JVM_PORT}`,
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
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<boolean> | null = null;

  constructor(config: Partial<JvmConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    mkdirSync(this.config.cacheDir, { recursive: true });
    mkdirSync(dirname(this.config.sourceDir), { recursive: true });

    this.state = {
      pid: null,
      status: "stopped",
      lastError: null,
      restarts: 0,
      lastStartTime: null,
      version: null,
    };
  }

  private updateState(updates: Partial<JvmState>): void {
    this.state = { ...this.state, ...updates };

    try {
      writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch {
      // State persistence is optional.
    }
  }

  private getWorkerBinary(): string {
    const configured = process.env.MURPH_JVM_BINARY;

    if (configured) return configured;

    const prebuilt = "/app/jvm-worker/bin/headlessApp";

    if (existsSync(prebuilt)) return prebuilt;

    return resolve(
      this.config.sourceDir,
      "headlessApp",
      "build",
      "install",
      "headlessApp",
      "bin",
      "headlessApp",
    );
  }

  private async prepareWorker(): Promise<string> {
    let binary = this.getWorkerBinary();

    // Prefer the binary already built into the deployment image.
    if (existsSync(binary)) {
      console.log("[JVM] Using prebuilt worker:", binary);
      return binary;
    }

    // Fallback for deployments that do not contain a prebuilt binary.
    const { execSync } = await import("node:child_process");

    if (!existsSync(resolve(this.config.sourceDir, "gradlew"))) {
      console.log("[JVM] Cloning worker source...");

      execSync(
        `git clone --depth 1 --branch "${this.config.sourceRef}" "${this.config.sourceRepo}" "${this.config.sourceDir}"`,
        { stdio: "inherit" },
      );
    }

    const workerSource = resolve(ROOT_DIR, "scripts", "jvm-worker");
    const workerDest = resolve(this.config.sourceDir, "headlessApp");

    if (!existsSync(workerSource)) {
      throw new Error(`Worker source not found: ${workerSource}`);
    }

    console.log("[JVM] Preparing worker module...");

    execSync(`rm -rf "${workerDest}" && cp -R "${workerSource}" "${workerDest}"`, {
      stdio: "inherit",
    });

    const settingsFile = resolve(this.config.sourceDir, "settings.gradle.kts");
    const settings = readFileSync(settingsFile, "utf8");

    if (!settings.includes('include(":headlessApp")')) {
      writeFileSync(
        settingsFile,
        `${settings}\ninclude(":headlessApp")\n`,
      );
    }

    console.log("[JVM] Building worker fallback...");

    execSync("./gradlew :headlessApp:installDist --no-daemon", {
      cwd: this.config.sourceDir,
      stdio: "inherit",
      env: { ...process.env, GRADLE_OPTS: "-Xmx2g" },
    });

    binary = this.getWorkerBinary();

    if (!existsSync(binary)) {
      throw new Error(`Worker binary not found: ${binary}`);
    }

    return binary;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.config.enabled || this.state.status !== "running") {
      return false;
    }

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
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.state.status === "error" || this.state.status === "stopped") {
        return false;
      }

      if (await this.isHealthy()) return true;

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return false;
  }

  async start(): Promise<boolean> {
    if (!this.config.enabled) {
      console.log("[JVM] Worker disabled");
      return false;
    }

    if (this.process && this.state.status === "running") {
      return true;
    }

    if (this.starting) return this.starting;

    this.starting = this.startInternal();

    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startInternal(): Promise<boolean> {
    this.updateState({ status: "starting", lastError: null });

    try {
      const binary = await this.prepareWorker();

      console.log("[JVM] Starting worker on port", this.config.port);

      this.process = spawn(binary, [], {
        env: {
          ...process.env,
          PORT: String(this.config.port),
          MURPH_JVM_CACHE_DIR: this.config.cacheDir,
          MURPH_CLOUDSTREAM_REPOSITORIES:
            process.env.MURPH_CLOUDSTREAM_REPOSITORIES || "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const child = this.process;

      child.stdout?.on("data", (data) => {
        const message = data.toString().trim();
        if (message) console.log("[JVM]", message);
      });

      child.stderr?.on("data", (data) => {
        const message = data.toString().trim();
        if (message) console.error("[JVM ERROR]", message);
      });

      child.on("error", (error) => {
        console.error("[JVM] Process error:", error.message);

        if (this.process === child) {
          this.process = null;
          this.updateState({
            status: "error",
            pid: null,
            lastError: error.message,
          });
        }
      });

      child.on("exit", (code, signal) => {
        console.log(`[JVM] Worker exited: code=${code}, signal=${signal}`);

        if (this.process !== child) return;

        this.process = null;
        this.stopHealthCheck();

        if (this.state.status === "stopping") {
          this.updateState({ status: "stopped", pid: null });
          return;
        }

        this.updateState({
          status: "error",
          pid: null,
          lastError: `Worker exited: ${code ?? signal ?? "unknown"}`,
        });

        this.scheduleRestart();
      });

      if (!child.pid) {
        throw new Error("Worker process did not start");
      }

      this.updateState({
        status: "running",
        pid: child.pid,
        lastStartTime: Date.now(),
        lastError: null,
      });

      this.startHealthCheck();

      const healthy = await this.waitForHealthy(this.config.timeoutMs);

      if (!healthy) {
        const error = "Worker did not pass its health check";
        console.error("[JVM]", error);

        if (this.process === child) {
          this.updateState({ lastError: error });
          child.kill("SIGTERM");
        }

        return false;
      }

      console.log("[JVM] Worker health check passed");
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

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

      if (!(await this.isHealthy())) {
        console.warn("[JVM] Health check failed");

        this.updateState({ lastError: "Worker health check failed" });
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
    if (!this.config.autoRestart || this.restartTimer) return;

    if (this.state.restarts >= this.config.maxRestarts) {
      this.updateState({
        status: "error",
        lastError: "Maximum worker restarts reached",
      });
      return;
    }

    const attempt = this.state.restarts + 1;
    const delay =
      this.config.restartDelayMs *
      Math.pow(1.5, this.state.restarts);

    console.log(`[JVM] Restart attempt ${attempt} in ${delay}ms`);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;

      if (this.state.status !== "error") return;

      this.updateState({ restarts: attempt });
      void this.start();
    }, delay);
  }

  async stop(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    this.updateState({ status: "stopping" });
    this.stopHealthCheck();

    const child = this.process;

    if (child) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10000);

        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });

        child.kill("SIGTERM");
      });
    }

    this.process = null;
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

export async function startJvmWorker(
  config?: Partial<JvmConfig>,
): Promise<boolean> {
  return getJvmManager(config).start();
}

export async function stopJvmWorker(): Promise<void> {
  if (globalManager) await globalManager.stop();
}

export async function restartJvmWorker(): Promise<boolean> {
  if (!globalManager) return false;
  return globalManager.restart();
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
                            
