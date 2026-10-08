# Kube Portal build / install.
#
#   make install     rebuild, package and install for this OS
#   make uninstall   remove what `make install` put in place
#   make run         run in development (hot reload); `make dev` is an alias
#   make macos-install / linux-install / windows-install   install for that OS
#   make build       release binary only (no packaging)
#   make package     OS installers/bundles in src-tauri/target/release/bundle
#   make test        type-check, format check, Rust tests and lints
#   make fmt         format the TypeScript and Rust sources
#   make prune       trim build files older than KEEP_DAYS days (default 14)
#   make clean       delete all build output
#
# Install locations
#   macOS    /Applications/Kube Portal.app            (APP_DIR=... to change)
#   Linux    $(PREFIX)/bin/kube-portal + .desktop + icons, PREFIX defaults to ~/.local
#            (per-user, no root; `sudo make install PREFIX=/usr/local` for system-wide)
#   Windows  runs the NSIS installer silently (per-user, %LOCALAPPDATA%\Kube Portal, Start menu entry)
#
# macOS builds are code signed with SIGN_ID (default "-" = ad-hoc); pass a Developer ID to sign for
# distribution, e.g. `make package SIGN_ID="Developer ID Application: Name (TEAMID)"`.
#
# PLATFORM is detected (macos | linux | windows) and can be overridden, e.g. `make -n install PLATFORM=macos`.

APP      := Kube Portal
BIN      := kube-portal
APP_ID   := dev.k8side.app
TAURI    := src-tauri
RELEASE  := $(TAURI)/target/release
BUNDLE   := $(RELEASE)/bundle
PNPM     ?= pnpm

ifeq ($(OS),Windows_NT)
  DETECTED := windows
else
  UNAME_S := $(shell uname -s)
  ifeq ($(UNAME_S),Darwin)
    DETECTED := macos
  else
    DETECTED := linux
  endif
endif
PLATFORM ?= $(DETECTED)

# macOS
APP_DIR ?= /Applications
SIGN_ID ?= -
export APPLE_SIGNING_IDENTITY := $(SIGN_ID)

# Linux (XDG layout)
PREFIX      ?= $(HOME)/.local
BINDIR      := $(PREFIX)/bin
DATADIR     := $(PREFIX)/share
DESKTOP_DIR := $(DATADIR)/applications
ICON_DIR    := $(DATADIR)/icons/hicolor
DESKTOP     := $(DESKTOP_DIR)/$(APP_ID).desktop

.PHONY: help deps run dev fmt build package test roadmap install uninstall clean prune \
        macos-install linux-install windows-install \
        macos-uninstall linux-uninstall windows-uninstall

help:
	@sed -n '/^#/!q; s/^# \{0,1\}//p' Makefile
	@echo "Detected platform: $(PLATFORM)"

deps:
	$(PNPM) install

run: deps
	$(PNPM) tauri dev

dev: run

build: deps
	$(PNPM) tauri build --no-bundle

package: deps
	$(PNPM) tauri build
ifeq ($(PLATFORM),macos)
	@for dmg in "$(BUNDLE)"/dmg/*.dmg; do \
	  mnt=$$(hdiutil attach -nobrowse -readonly "$$dmg" | tail -1 | cut -f3) && \
	  codesign --verify --deep --strict "$$mnt/$(APP).app"; rc=$$?; hdiutil detach -quiet "$$mnt"; \
	  [ $$rc -eq 0 ] || { echo "error: $$dmg: app signature invalid"; exit 1; }; \
	  echo "Signature OK: $$dmg"; \
	done
endif

fmt: deps
	$(PNPM) exec prettier --write .
	cd $(TAURI) && cargo fmt

test: deps
	npx tsc --noEmit
	$(PNPM) exec prettier --check .
	cd $(TAURI) && cargo fmt --check
	cd $(TAURI) && cargo test --lib && cargo clippy -- -D warnings

roadmap:
	$(PNPM) -s roadmap --todo

install: $(PLATFORM)-install

uninstall: $(PLATFORM)-uninstall

# ---------------------------------------------------------------- macOS

macos-install: deps
	$(PNPM) tauri build --bundles app
	@test -d "$(BUNDLE)/macos/$(APP).app" || { echo "error: $(BUNDLE)/macos/$(APP).app was not built"; exit 1; }
	codesign --verify --deep --strict "$(BUNDLE)/macos/$(APP).app"
	@if pgrep -xq "$(BIN)"; then echo "Quitting running $(APP)…"; osascript -e 'quit app "$(APP)"' || true; sleep 1; fi
	rm -rf "$(APP_DIR)/$(APP).app"
	cp -R "$(BUNDLE)/macos/$(APP).app" "$(APP_DIR)/"
	@echo "Installed $(APP_DIR)/$(APP).app"

macos-uninstall:
	rm -rf "$(APP_DIR)/$(APP).app"
	@echo "Removed $(APP_DIR)/$(APP).app (settings stay in ~/Library/Application Support/$(APP_ID))"

# ---------------------------------------------------------------- Linux

linux-install: build
	install -Dm755 "$(RELEASE)/$(BIN)" "$(BINDIR)/$(BIN)"
	install -Dm644 "$(TAURI)/icons/32x32.png"       "$(ICON_DIR)/32x32/apps/$(BIN).png"
	install -Dm644 "$(TAURI)/icons/128x128.png"     "$(ICON_DIR)/128x128/apps/$(BIN).png"
	install -Dm644 "$(TAURI)/icons/128x128@2x.png"  "$(ICON_DIR)/256x256/apps/$(BIN).png"
	install -Dm644 "$(TAURI)/icons/icon.png"        "$(ICON_DIR)/512x512/apps/$(BIN).png"
	install -d "$(DESKTOP_DIR)"
	printf '%s\n' \
		'[Desktop Entry]' \
		'Type=Application' \
		'Name=$(APP)' \
		'GenericName=Kubernetes IDE' \
		'Comment=Tabbed Kubernetes IDE' \
		'Exec=$(BINDIR)/$(BIN)' \
		'Icon=$(BIN)' \
		'Terminal=false' \
		'Categories=Development;IDE;' \
		'Keywords=kubernetes;k8s;kubectl;helm;cluster;' \
		'StartupWMClass=$(BIN)' \
		> "$(DESKTOP)"
	-command -v update-desktop-database >/dev/null && update-desktop-database -q "$(DESKTOP_DIR)"
	-command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -qtf "$(ICON_DIR)" 2>/dev/null
	@echo "Installed $(BINDIR)/$(BIN) and $(DESKTOP)"
	@case ":$$PATH:" in *":$(BINDIR):"*) ;; *) echo "note: $(BINDIR) is not on your PATH (the app menu entry still works)";; esac

linux-uninstall:
	rm -f "$(BINDIR)/$(BIN)" "$(DESKTOP)"
	rm -f "$(ICON_DIR)/32x32/apps/$(BIN).png" "$(ICON_DIR)/128x128/apps/$(BIN).png" "$(ICON_DIR)/256x256/apps/$(BIN).png" "$(ICON_DIR)/512x512/apps/$(BIN).png"
	-command -v update-desktop-database >/dev/null && update-desktop-database -q "$(DESKTOP_DIR)"
	@echo "Removed $(APP) (settings stay in ~/.config/$(APP_ID))"

# ---------------------------------------------------------------- Windows (Git Bash / MSYS make)

windows-install: deps
	$(PNPM) tauri build --bundles nsis
	@installer=$$(ls -t "$(BUNDLE)"/nsis/*-setup.exe 2>/dev/null | head -n1); \
	 test -n "$$installer" || { echo "error: no NSIS installer in $(BUNDLE)/nsis"; exit 1; }; \
	 echo "Running $$installer /S"; \
	 "$$installer" /S
	@echo "Installed $(APP) (Start menu → $(APP))"

windows-uninstall:
	@uninstaller="$$LOCALAPPDATA/$(APP)/uninstall.exe"; \
	 if [ -f "$$uninstaller" ]; then "$$uninstaller" /S && echo "Removed $(APP)"; \
	 else echo "Not installed at $$uninstaller (use Add/Remove Programs)"; fi

# ----------------------------------------------------------------

clean:
	cd $(TAURI) && cargo clean
	rm -rf dist

# target/ keeps every dependency version ever built and grows without bound. cargo-reclaim
# (cargo install cargo-reclaim) trims stale dependency builds and incremental caches older than
# KEEP_DAYS days, keeping the current build, final binaries and anything unrecognised.
KEEP_DAYS ?= 14
prune:
	cargo reclaim $(TAURI) --all --yes --keep-days $(KEEP_DAYS)
