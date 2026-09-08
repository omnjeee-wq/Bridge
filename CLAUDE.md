# Murph Stream Bridge - Project Documentation

## Overview
A free, self-hosted Stremio bridge for native addons and optional CloudStream JVM plugins. Provides a unified manifest that aggregates multiple Stremio addons and CloudStream providers into a single endpoint for Stremio clients.

## Architecture

### Components
1. **Frontend** (`artifacts/murph-stream-bridge/`) - React + TypeScript + Vite + Tailwind CSS
   - Dashboard for managing repositories, plugins, and monitoring
   - Real-time activity feed and bridge statistics
   - JVM runtime status monitoring

2. **API Server** (`artifacts/api-server/`) - Express.js + TypeScript
   - REST API for bridge management
   - Stremio protocol endpoints (/manifest.json, /catalog, /meta, /stream)
   - JVM runtime proxy for CloudStream plugins

3. **JVM Worker** (`scripts/jvm-worker/`) - Kotlin/Gradle
   - CloudStream runtime (CNCVerse-Bridge)
   - Headless Stremio server on port 8787
   - Auto-managed by JVM Manager

4. **Shared Libraries** (`lib/`)
   - `api-zod` - Zod schemas for API validation
   - `api-client-react` - React Query hooks
   - `api-spec` - OpenAPI spec
   - `db` - Drizzle ORM schema

### Data Flow
```
Stremio Client → /api/manifest.json → API Server
    ├── Manifest addons → Direct to source addons
    └── CloudStream plugins → JVM Worker (port 8787) → API Server → Client
```

## Key Features

### JVM CloudStream Runtime (Auto-managed)
- **One-time setup**: Enable via `MURPH_JVM_ENABLED=true`
- **Auto-download**: Clones CNCVerse-Bridge from GitHub on first run
- **Auto-build**: Compiles with Gradle (cached after first build)
- **Auto-start**: Launches headless Stremio server
- **Health monitoring**: 30s interval health checks
- **Auto-restart**: Exponential backoff (max 5 restarts)
- **State persistence**: Survives container restarts

### Configuration (Environment Variables)
```bash
# JVM Runtime
MURPH_JVM_ENABLED=true              # Enable JVM worker
MURPH_JVM_SOURCE_REPO=...           # CNCVerse-Bridge repo
MURPH_JVM_SOURCE_REF=main           # Git branch/tag
MURPH_JVM_PORT=8787                 # JVM worker port
MURPH_JVM_WORKER_URL=http://...     # Worker URL (auto-set)
MURPH_JVM_CACHE_DIR=/data/jvm       # Plugin cache directory
MURPH_JVM_AUTO_RESTART=true         # Auto-restart on failure
MURPH_JVM_MAX_RESTARTS=5            # Max restart attempts
MURPH_JVM_RESTART_DELAY_MS=5000     # Base restart delay

# Bridge
MURPH_DATA_DIR=/data                # Data directory
MURPH_API_PORT=10000                # API port
MURPH_CLOUDSTREAM_REPOSITORIES=...  # Comma-separated repo URLs
```

### API Endpoints
- `GET /api/healthz` - Health check
- `GET /api/bridge/status` - Bridge status
- `GET /api/bridge/settings` - Get settings
- `PATCH /api/bridge/settings` - Update settings
- `GET /api/repositories` - List repositories
- `POST /api/repositories` - Add repository
- `GET /api/plugins` - List plugins
- `GET /api/activity` - Recent activity
- `GET /api/stats` - Dashboard metrics
- `GET /api/jvm/info` - **NEW** JVM runtime info
- `GET /api/manifest.json` - Stremio manifest
- `GET /api/catalog/:type/:id.json` - Catalog
- `GET /api/meta/:type/:id.json` - Metadata
- `GET /api/stream/:type/:id.json` - Stream links

### Frontend Pages
- `/` - Overview (status, metrics, recent activity, manifest)
- `/plugins` - Plugin catalog with search/filter
- `/repositories` - Addon repository management
- `/activity` - Full activity log with filters
- `/settings` - Bridge configuration
- **JVM Info tab** - Real-time JVM status, memory, CPU, health

## Deployment

### Docker (Recommended)
```bash
docker build -t murph-stream-bridge .
docker run -d \
  -p 10000:10000 \
  -e MURPH_JVM_ENABLED=true \
  -v /host/data:/data \
  murph-stream-bridge
```

### Render.com
- Uses `render.yaml` for configuration
- Set `MURPH_JVM_ENABLED=true` in env vars

### Vercel
```bash
# Requires vercel.json (see below)
vercel deploy
```

### Manual
```bash
pnpm install
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/murph-stream-bridge run build
MURPH_JVM_ENABLED=true node artifacts/api-server/dist/index.mjs
```

## Development

### Prerequisites
- Node.js 22+
- pnpm 9+
- Java 17+ (for JVM worker)
- Git

### Commands
```bash
pnpm install                    # Install all dependencies
pnpm --filter @workspace/api-server run dev  # API dev server
pnpm --filter @workspace/murph-stream-bridge run dev  # Frontend dev
pnpm --filter @workspace/api-spec run codegen  # Regenerate API types
```

### Project Structure
```
murph-stream-bridge/
├── .config/murph-stream-bridge/src/   # Frontend source (main)
├── artifacts/
│   ├── api-server/                    # Express API server
│   └── murph-stream-bridge/           # Built frontend output
├── lib/                               # Shared packages
├── scripts/
│   ├── jvm-worker/                    # Kotlin JVM worker source
│   ├── run-jvm-worker.sh              # Legacy JVM runner
│   └── start-all.sh                   # Production startup
├── Dockerfile                         # Multi-stage build
├── render.yaml                        # Render.com config
├── vercel.json                        # Vercel config
└── CLAUDE.md                          # This file
```

## Recent Changes
- ✅ Updated project logo (favicon, sidebar, mobile header)
- ✅ Fixed mobile UI overflow on Recent Activities & Manifest panels
- ✅ Created JVM Manager with auto-run, health checks, auto-restart
- ✅ Added `/api/jvm/info` endpoint with real-time metrics
- ✅ Added JVM Info tab in web UI
- ✅ Vercel deployment support

## Troubleshooting

### JVM Worker Won't Start
1. Check `MURPH_JVM_ENABLED=true`
2. Verify Java 17+ installed
3. Check logs: `docker logs <container> | grep -i jvm`
4. Ensure port 8787 not in use

### High Memory Usage
- JVM worker uses ~500MB-1GB RAM
- Adjust `GRADLE_OPTS=-Xmx2g` in Dockerfile if needed
- Monitor via `/api/jvm/info` memoryUsage.rss

### Build Failures
- Clear cache: `rm -rf .cache/cncverse-bridge`
- Rebuild: `docker build --no-cache`

## Links
- Repository: https://github.com/uixmurph/Murph-Streams-Bridge
- CNCVerse-Bridge: https://github.com/deepu2135/CNCVerse-Bridge
- Stremio Addon Protocol: https://github.com/Stremio/stremio-addon-sdk