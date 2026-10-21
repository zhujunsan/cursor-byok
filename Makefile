.PHONY: check dev-web dev-server dev-desktop build-web build-server build-desktop build-docker

check:
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets -- -D warnings
	cargo test --workspace --all-targets
	npm --prefix apps/desktop run check

dev-web:
	npm --prefix apps/desktop run dev:web

dev-server:
	CURSOR_CONSOLE_DIR=apps/desktop/dist cargo run --package cursor-server --bin cursor-server

dev-desktop:
	npm --prefix apps/desktop run tauri:dev

build-web:
	npm --prefix apps/desktop run build

build-server:
	cargo build --release --package cursor-server --bin cursor-server

# Updater artifacts are signed with the key whose public half is in
# tauri.conf.json. Without that key, local builds skip updater artifacts.
UPDATER_KEY ?= $(HOME)/.tauri/cursor-byok-updater.key
NO_UPDATER_CONFIG := {"bundle":{"createUpdaterArtifacts":false}}

ifeq ($(OS),Windows_NT)
build-desktop:
	@node -e "const fs = require('node:fs'); const { spawnSync } = require('node:child_process'); const key = process.argv[1]; const signed = fs.existsSync(key); const args = ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--bundles', 'nsis']; if (!signed) args.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } })); const env = signed ? { ...process.env, TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(key, 'utf8'), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: fs.readFileSync(key + '.password', 'utf8') } : process.env; const result = spawnSync(process.execPath, args, { cwd: 'apps/desktop', stdio: 'inherit', env }); process.exit(result.status ?? 1)" "$(UPDATER_KEY)"
else
build-desktop:
	@if [ -f "$(UPDATER_KEY)" ]; then \
		TAURI_SIGNING_PRIVATE_KEY="$$(cat "$(UPDATER_KEY)")" \
		TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$$(cat "$(UPDATER_KEY).password")" \
		npm --prefix apps/desktop run tauri:build; \
	else \
		echo "$(UPDATER_KEY) not found; building without updater artifacts"; \
		npm --prefix apps/desktop run tauri:build -- --config '$(NO_UPDATER_CONFIG)'; \
	fi
endif

build-docker:
	docker build --tag cursor-byok:local .
