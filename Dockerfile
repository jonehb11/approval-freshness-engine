# =============================================================================
# approval-freshness-engine — production image
#
# Three stages: (1) build TypeScript + prune to production node_modules,
# (2) fetch + checksum-verify the difftastic binary stage1_difftastic.ts shells
# out to, (3) assemble the minimal distroless runtime image. Only stage 3's
# output is shipped; stages 1-2 exist purely to produce inputs for it.
#
# Base images are pinned by digest, not by mutable tag: a tag (even a
# version-specific one like `22-bookworm-slim`) can be repointed upstream —
# accidentally or via supply-chain compromise — to different bytes than what
# was reviewed. Digests below were resolved live against the registries
# (Docker Hub / gcr.io) — re-verify and re-pin at each deliberate base-image
# bump; do not let these silently go stale.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: builder — compile TypeScript, then prune devDependencies out.
# node:22-bookworm-slim (glibc, not alpine/musl) so this base matches the
# difftastic gnu-target binaries fetched in stage 2 and the distroless
# nodejs22-debian12 runtime in stage 3 (same libc family throughout).
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS builder
# ^ resolved 2026-07-17 via `docker.io/v2` (Docker Hub API) for tag
# `22-bookworm-slim`, which at resolution time was itself `22.23.1-bookworm-slim`.
# Re-check before relying on this long-term:
#   curl -s https://hub.docker.com/v2/repositories/library/node/tags/22-bookworm-slim | jq -r .digest

WORKDIR /app

# Install with devDependencies first (needed for `tsc`), --ignore-scripts on
# EVERY npm ci in this file: a compromised transitive dependency's
# preinstall/postinstall script is a standard supply-chain attack vector
# (arbitrary code execution during `npm install`, with access to the build
# environment). This project has no dependency that legitimately needs an
# install-time build script, so disabling them is free.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Only what the build needs (.dockerignore keeps the rest — test/, eval/,
# scripts/, deploy/, docs/, etc. — out of the build context entirely).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Re-run npm ci --omit=dev against the SAME package-lock.json to get a clean,
# minimal production node_modules (no devDependencies, e.g. typescript/vitest/
# tsx never ship). --ignore-scripts for the same reason as above.
RUN npm ci --omit=dev --ignore-scripts

# -----------------------------------------------------------------------------
# Stage 2: difftastic — fetch + verify the prebuilt binary stage1_difftastic.ts
# execFile()s. Deliberately a FRESH stage off the same pinned base (not
# `FROM builder`): these layers depend only on TARGETARCH, never on app
# source, so basing them on `builder` would needlessly invalidate this
# stage's cache on every source change. Downloaded over HTTPS and verified
# against a hardcoded sha256 before anything touches it — no unverified bytes
# ever reach /usr/local/bin in the final image.
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS difftastic
ARG TARGETARCH
# difftastic 0.69.0 (latest release as of 2026-07-17: github.com/Wilfred/difftastic/releases/tag/0.69.0).
# sha256 sums below were NOT copied from a maintainer-published checksums file
# (difftastic's releases don't ship one) — they were obtained by downloading
# both release tarballs directly and hashing them locally (`shasum -a 256`),
# and cross-checked against the `digest` field GitHub's Releases API now
# reports per asset. Both matched exactly. Re-verify on every version bump:
#   curl -sL -o difft.tar.gz https://github.com/Wilfred/difftastic/releases/download/<version>/difft-<arch>.tar.gz && sha256sum difft.tar.gz
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    DIFFT_VERSION=0.69.0; \
    # TARGETARCH is auto-populated by BuildKit/buildx per target platform (see the `docker` job
    # in .github/workflows/ci.yaml, which uses docker/setup-buildx-action). Fall back to the
    # container's own architecture for a plain `docker build` without buildx, where BuildKit
    # never sets it at all — dpkg's arch name already uses the same amd64/arm64 vocabulary as
    # TARGETARCH, so this is a correct same-arch default, not a guess.
    TARGETARCH="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${TARGETARCH}" in \
      amd64) DIFFT_ARCH=x86_64-unknown-linux-gnu; DIFFT_SHA256=038db96a0e8fce69f2554e33e04ff75fbf6f96ea45cb4edb9ed6203a2c4750ff ;; \
      arm64) DIFFT_ARCH=aarch64-unknown-linux-gnu; DIFFT_SHA256=abd2f42d2afd424312b4862aa7c7bb0320447670ae22fabcc5159db03e2dccbd ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/difft.tar.gz \
      "https://github.com/Wilfred/difftastic/releases/download/${DIFFT_VERSION}/difft-${DIFFT_ARCH}.tar.gz"; \
    echo "${DIFFT_SHA256}  /tmp/difft.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/difft.tar.gz -C /tmp difft; \
    install -m 0755 /tmp/difft /difft; \
    rm -rf /tmp/difft.tar.gz /tmp/difft

# -----------------------------------------------------------------------------
# Stage 3: runtime — distroless, non-root, no shell.
# -----------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
# ^ resolved 2026-07-17 directly against gcr.io's registry v2 API for
# `distroless/nodejs22-debian12:nonroot` (multi-arch index: amd64 + arm64).
# Re-check before relying on this long-term:
#   curl -s -H "Authorization: Bearer $(curl -s 'https://gcr.io/v2/token?service=gcr.io&scope=repository:distroless/nodejs22-debian12:pull' | jq -r .token)" \
#     -H 'Accept: application/vnd.oci.image.index.v1+json' \
#     -D - -o /dev/null https://gcr.io/v2/distroless/nodejs22-debian12/manifests/nonroot | grep -i docker-content-digest

ENV NODE_ENV=production
# stage1_difftastic.ts execFile()s cfg.difftasticBin; wiring loadConfig to
# default it from DIFFT_BIN is noted (not implemented — loadConfig stays a
# stub) in src/config/schema.ts.
ENV DIFFT_BIN=/usr/local/bin/difft

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=difftastic /difft /usr/local/bin/difft

# distroless `nonroot` image user (uid/gid 65532); set explicitly rather than
# relying on the base image's default USER so it survives if a future base
# swap ever changes that default.
USER nonroot

EXPOSE 3000

# No init/tini: Node is PID 1 here (no shell wrapping CMD) and reaps its own
# execFile() children — stage1_difftastic.ts's difft subprocess is always a
# DIRECT child (never daemonized/double-forked), and Node's child_process
# implementation handles SIGCHLD/waitpid for its own direct children via
# libuv regardless of whether Node is PID 1. Tini exists to reap ORPHANED
# grandchildren and forward signals to a wrapped shell — neither applies
# here. SIGTERM from Kubernetes lands directly on this PID 1 process and is
# handled by the explicit graceful-shutdown path in src/index.ts.
#
# No HEALTHCHECK: distroless has no shell, so a CMD-form HEALTHCHECK has
# nothing to exec, and Kubernetes' kubelet doesn't consult Docker
# HEALTHCHECK at all — GET /healthz and /readyz (see deploy/helm probes) are
# the actual, and only, health mechanism for this image.

# distroless nodejs entrypoint is `node`; this is its argv (D1 fix — build
# output is dist/src/index.js, not dist/index.js, because tsconfig's rootDir
# is "." and mirrors the src/ prefix into dist/).
CMD ["dist/src/index.js"]
