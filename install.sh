#!/bin/bash

# Veridex Stellar Facilitator - Installation Script
# License: Apache-2.0

set -e

echo "=========================================="
echo "Veridex Stellar Facilitator Installation"
echo "=========================================="
echo ""

# Check if running from correct directory
if [ ! -f "docker-compose.yml" ]; then
    echo "Error: Please run this script from the stellar-facilitator directory"
    exit 1
fi

# Clean lockfiles
echo "Cleaning old lockfiles..."
find . -name "bun.lockb" -delete
find . -name "package-lock.json" -delete

# Install Bazaar Service
echo ""
echo "Installing Bazaar Service..."
cd bazaar-service
npm install
cd ..

# Install Facilitator Service
echo ""
echo "Installing Facilitator Service..."
cd facilitator-service
npm install
cd ..

# Install MCP Server
echo ""
echo "Installing MCP Server..."
cd mcp-server
npm install
cd ..

# Install TypeScript SDK
echo ""
echo "Installing TypeScript SDK..."
cd sdk-typescript
npm install
cd ..

# Install Python SDK
echo ""
echo "Installing Python SDK..."
cd sdk-python
pip install -e . 2>/dev/null || echo "Python SDK installation skipped (pip not available)"
cd ..

# Build Soroban Contract
echo ""
echo "Building Soroban Contract..."
cd contracts/upto_escrow
if command -v cargo &> /dev/null; then
    cargo build --target wasm32-unknown-unknown --release 2>/dev/null || echo "Soroban build skipped (rust not available)"
else
    echo "Cargo not found, skipping Soroban build"
fi
cd ../..

echo ""
echo "=========================================="
echo "Installation Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Copy .env.example to .env and configure your settings"
echo "2. Run 'docker-compose up -d' to start services"
echo "3. Check health: curl http://localhost:3001/health"
echo ""
