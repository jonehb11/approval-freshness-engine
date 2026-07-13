# Stage 1: Build environment
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency definitions
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies) required for building
RUN npm ci

# Copy the rest of the application source code
COPY . .

# Build the TypeScript code
RUN npm run build

# Remove devDependencies to prepare a minimal node_modules for production
RUN npm ci --omit=dev

# Stage 2: Production environment
FROM gcr.io/distroless/nodejs20-debian11

# Set standard production environment variables
ENV NODE_ENV=production

WORKDIR /app

# Copy over production node_modules and built code from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Use the non-root user provided by the distroless image for better security
USER nonroot:nonroot

# Expose typical webhook port (optional, adjust if engine uses a different port)
EXPOSE 3000

# Default command to run the engine.
# Adjust the entrypoint file to match the actual built artifact if different.
CMD ["dist/index.js"]
