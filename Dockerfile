FROM gradle:8.13-jdk21 AS jvm-build

ARG MURPH_JVM_SOURCE_REPO=https://github.com/NivinCNC/CNCVerse-Bridge.git
ARG MURPH_JVM_SOURCE_REF=main

WORKDIR /opt

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "$MURPH_JVM_SOURCE_REF" "$MURPH_JVM_SOURCE_REPO" cncverse-bridge

COPY scripts/jvm-worker /opt/headlessApp

RUN sed -i 's/jvmToolchain(19)/jvmToolchain(21)/' /opt/headlessApp/build.gradle.kts && rm -rf /opt/cncverse-bridge/headlessApp && cp -R /opt/headlessApp /opt/cncverse-bridge/headlessApp && printf '\ninclude(":headlessApp")\n' >> /opt/cncverse-bridge/settings.gradle.kts && cd /opt/cncverse-bridge && ./gradlew :headlessApp:installDist --no-daemon

FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./

COPY artifacts ./artifacts
COPY lib ./lib
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @workspace/api-spec exec orval --config ./orval.config.ts

RUN sed -i 's/zod.int()/zod.number().int()/g' lib/api-zod/src/generated/api.ts && ! grep -n 'zod.int()' lib/api-zod/src/generated/api.ts

RUN pnpm -w run typecheck:libs

RUN PORT=10000 BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/mockup-sandbox run build

RUN pnpm --filter @workspace/api-server run build

FROM eclipse-temurin:21-jre AS java-runtime

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV MURPH_WEB_DIST=/app/artifacts/mockup-sandbox/dist
ENV MURPH_DATA_DIR=/data
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:$PATH

RUN corepack enable

COPY --from=java-runtime /opt/java/openjdk /opt/java/openjdk

COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=build /app/artifacts/mockup-sandbox/dist ./artifacts/mockup-sandbox/dist
COPY --from=jvm-build /opt/cncverse-bridge/headlessApp/build/install/headlessApp ./jvm-worker
COPY scripts/start-all.sh ./scripts/start-all.sh

EXPOSE 10000

CMD ["sh", "scripts/start-all.sh"]
