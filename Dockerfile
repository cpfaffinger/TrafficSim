# syntax=docker/dockerfile:1.7
# Multi-stage build (ADR-0012): Rust → WASM, Node → SPA, .NET publish, slim runtime.

ARG RUST_VERSION=1
ARG NODE_VERSION=24
ARG DOTNET_VERSION=10.0
# Must match the wasm-bindgen version pinned in sim-core/Cargo.toml.
ARG WASM_BINDGEN_VERSION=0.2.130

# ---------- Simulation core: Rust → WebAssembly ----------
FROM rust:${RUST_VERSION}-slim AS rust-base
ARG WASM_BINDGEN_VERSION
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked \
 && rm -rf /usr/local/cargo/registry
WORKDIR /src/sim-core

FROM rust-base AS sim-core
COPY sim-core/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/sim-core/target \
    cargo build --release --target wasm32-unknown-unknown \
 && wasm-bindgen --target web --out-dir /out target/wasm32-unknown-unknown/release/trafficsim_sim_core.wasm

# ---------- Frontend: Vite build ----------
FROM node:${NODE_VERSION}-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY frontend/ ./
COPY --from=sim-core /out ./src/generated/sim-core
RUN npm run build

# ---------- Backend: dotnet publish ----------
FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_VERSION} AS backend
ARG SOURCE_COMMIT=dev
WORKDIR /src/backend
COPY backend/global.json backend/Directory.Build.props backend/Directory.Packages.props ./
COPY backend/src/TrafficSim.Domain/TrafficSim.Domain.csproj src/TrafficSim.Domain/
COPY backend/src/TrafficSim.Application/TrafficSim.Application.csproj src/TrafficSim.Application/
COPY backend/src/TrafficSim.Providers/TrafficSim.Providers.csproj src/TrafficSim.Providers/
COPY backend/src/TrafficSim.Infrastructure/TrafficSim.Infrastructure.csproj src/TrafficSim.Infrastructure/
COPY backend/src/TrafficSim.Api/TrafficSim.Api.csproj src/TrafficSim.Api/
RUN --mount=type=cache,target=/root/.nuget/packages dotnet restore src/TrafficSim.Api/TrafficSim.Api.csproj
COPY backend/src/ src/
RUN --mount=type=cache,target=/root/.nuget/packages \
    dotnet publish src/TrafficSim.Api/TrafficSim.Api.csproj -c Release -o /app --no-restore \
      -p:UseAppHost=false -p:SourceRevisionId=${SOURCE_COMMIT}

# ---------- Runtime ----------
FROM mcr.microsoft.com/dotnet/aspnet:${DOTNET_VERSION} AS runtime
ARG SOURCE_COMMIT=dev
LABEL org.opencontainers.image.source="https://github.com/cpfaffinger/TrafficSim" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}"
WORKDIR /app
COPY --from=backend /app ./
COPY --from=frontend /src/frontend/dist ./wwwroot
ENV ASPNETCORE_HTTP_PORTS=8080 \
    DOTNET_gcServer=0
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "TrafficSim.Api.dll"]
