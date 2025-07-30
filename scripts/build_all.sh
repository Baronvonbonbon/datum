#!/usr/bin/env bash
set -euo pipefail

for pkg in contracts/*; do
  if [[ -f "$pkg/Cargo.toml" ]]; then
    echo "Building $pkg"
    (cd "$pkg" && cargo +stable contract build --release)
  fi
done
