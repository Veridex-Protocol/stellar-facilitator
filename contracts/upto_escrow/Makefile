# Veridex upto_escrow Soroban Contract - Build Automation
# License: Apache-2.0

.PHONY: build test clean optimize deploy

# Build contract
build:
	@echo "Building upto_escrow contract..."
	cargo build --target wasm32-unknown-unknown --release
	@echo "✓ Build complete: target/wasm32-unknown-unknown/release/upto_escrow.wasm"

# Run tests
test:
	@echo "Running tests..."
	cargo test
	@echo "✓ Tests passed"

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	cargo clean
	@echo "✓ Clean complete"

# Optimize WASM
optimize: build
	@echo "Optimizing WASM..."
	soroban contract optimize \
		--wasm target/wasm32-unknown-unknown/release/upto_escrow.wasm
	@echo "✓ Optimized WASM: target/wasm32-unknown-unknown/release/upto_escrow.optimized.wasm"

# Deploy to testnet
deploy: optimize
	@echo "Deploying to Stellar testnet..."
	@if [ -z "$$STELLAR_SECRET_KEY" ]; then \
		echo "Error: STELLAR_SECRET_KEY environment variable not set"; \
		exit 1; \
	fi
	soroban contract deploy \
		--wasm target/wasm32-unknown-unknown/release/upto_escrow.optimized.wasm \
		--source $$STELLAR_SECRET_KEY \
		--network testnet
	@echo "✓ Deployed to testnet"

# Install contract with specific ID
install: optimize
	@echo "Installing contract..."
	@if [ -z "$$STELLAR_SECRET_KEY" ]; then \
		echo "Error: STELLAR_SECRET_KEY environment variable not set"; \
		exit 1; \
	fi
	soroban contract install \
		--wasm target/wasm32-unknown-unknown/release/upto_escrow.optimized.wasm \
		--source $$STELLAR_SECRET_KEY \
		--network testnet
	@echo "✓ Contract installed"

# Build + test
all: build test

# Help
help:
	@echo "Veridex upto_escrow Makefile"
	@echo ""
	@echo "Targets:"
	@echo "  build     - Build contract WASM"
	@echo "  test      - Run unit tests"
	@echo "  clean     - Remove build artifacts"
	@echo "  optimize  - Optimize WASM size"
	@echo "  deploy    - Deploy to Stellar testnet (requires STELLAR_SECRET_KEY)"
	@echo "  install   - Install contract (requires STELLAR_SECRET_KEY)"
	@echo "  all       - Build and test"
	@echo ""
	@echo "Environment variables:"
	@echo "  STELLAR_SECRET_KEY - Secret key for deployment (S...)"
