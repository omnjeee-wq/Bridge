# Murph Stream Bridge

Murph Stream Bridge is a free, self-hosted Stremio addon bridge with a
responsive control panel. It aggregates native Stremio manifests and can
optionally execute CloudStream `.cs3` plugins through an isolated JVM worker.

It is designed for small servers, Docker hosts, Render-style deployments, and
phone-friendly administration.

## Features

- Stremio manifest at `/api/manifest.json`
- Catalog, metadata, and stream aggregation
- CNC CloudStream repository support through `CNC.json`
- Optional JVM execution for `.cs3` plugins
- Addon and provider enable/disable controls
- JSON file persistence instead of a required database
- Dark mode and responsive mobile navigation
- Stream testing and source diagnostics
- Health endpoint at `/api/healthz`

## Fastest deployment

The complete deployment process is in [`deploy.txt`](deploy.txt). The shortest
Docker path is:

```sh
git clone https://github.com/YOUR_USERNAME/murph-stream-bridge.git
cd murph-stream-bridge
docker build -t murph-stream-bridge .
docker run -d --name murph-stream-bridge --restart unless-stopped \
  -p 10000:10000 \
  -e MURPH_JVM_ENABLED=true \
  -v murph-data:/data \
  murph-stream-bridge
```

Open `http://YOUR_SERVER_IP:10000`, then add
`http://YOUR_SERVER_IP:10000/api/manifest.json` to Stremio.

Use `MURPH_JVM_ENABLED=false` when you only need native Stremio addons and want
the lowest memory usage.

## GitHub and Render

1. Push this repository to GitHub.
2. Create a new Render Web Service from the repository.
3. Select Docker and deploy using the included `render.yaml`.
4. Set `MURPH_JVM_ENABLED=true` if the service has enough memory for the JVM
   worker and CloudStream plugins.
5. Add the deployed URL followed by `/api/manifest.json` to Stremio.

Render free instances may sleep and their local filesystem may be ephemeral.
Use a persistent disk or another backup strategy if bridge settings must survive
restarts. For the full JVM runtime and predictable cold-start performance, a
small VPS or Docker host is recommended.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | provided by host | HTTP port used by the API |
| `MURPH_DATA_DIR` | `./data` | JSON persistence directory |
| `MURPH_WEB_DIST` | unset | Built frontend directory served by the API |
| `MURPH_JVM_ENABLED` | `false` | Start the bundled CloudStream JVM worker in Docker |
| `MURPH_JVM_WORKER_URL` | unset | Use an externally managed JVM worker |
| `MURPH_JVM_CACHE_DIR` | `/data/jvm` in Docker | JVM plugin and converted JAR cache |
| `MURPH_CLOUDSTREAM_REPOSITORIES` | CNC repository | Comma-separated CloudStream repository URLs |
| `ALLOW_PRIVATE_SOURCES` | unset | Allow trusted private source URLs when set to `true` |
| `LOG_LEVEL` | `info` | API log verbosity |

## Local development

```sh
pnpm install
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/murph-stream-bridge run dev
pnpm run typecheck
```

To run the JVM worker separately:

```sh
MURPH_CLOUDSTREAM_REPOSITORIES="https://raw.githubusercontent.com/NivinCNC/CNCVerse-Cloud-Stream-Extension/refs/heads/builds/CNC.json" \
./scripts/run-jvm-worker.sh
```

Then start the API with:

```sh
MURPH_JVM_WORKER_URL=http://127.0.0.1:8787 \
pnpm --filter @workspace/api-server run dev
```

## Architecture and safety

Native Stremio sources run in the Node API. `.cs3` plugins run in a separate
JVM process because they are DEX binaries and require the upstream CloudStream
runtime plus dex2jar compatibility support. The worker is opt-in because it
downloads and executes third-party plugin code.

Only connect repositories and addons you trust. If the control panel is exposed
to the public internet, put it behind your own reverse proxy, access control,
or private network.

## Credits

This project was vibe coded and refined for self-hosted use.

**Developer:** `@SXNCH1T` on Telegram

## License

Review the licenses of the upstream runtime, remote repositories, plugins, and
media sources you connect before redistributing or operating this project.