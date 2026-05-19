#!/usr/bin/env bash
# release.sh — Follow the Release SOP (doc/RELEASE_SOP.md)
# Usage:
#   ./scripts/release.sh patch   # bug fix     1.0.0 → 1.0.1
#   ./scripts/release.sh minor   # new feature  1.0.0 → 1.1.0
#   ./scripts/release.sh major   # breaking     1.0.0 → 2.0.0

set -euo pipefail

BUMP=${1:-}

# ── Validate argument ──────────────────────────────────────────────────────────

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: $0 <patch|minor|major>"
  exit 1
fi

# ── Ensure clean working tree ──────────────────────────────────────────────────

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: uncommitted changes detected. Commit or stash them first."
  git status --short
  exit 1
fi

# ── Ensure on main branch ──────────────────────────────────────────────────────

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Warning: you are on branch '$BRANCH', not 'main'."
  read -r -p "Continue anyway? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || exit 1
fi

# ── Bump version ───────────────────────────────────────────────────────────────

echo ""
echo "==> Bumping $BUMP version..."
npm version "$BUMP" --no-git-tag-version   # update package.json only

NEW_VERSION=$(node -p "require('./package.json').version")
TAG="v$NEW_VERSION"

echo "    New version: $NEW_VERSION"

# ── Commit and tag ─────────────────────────────────────────────────────────────

echo ""
echo "==> Committing and tagging $TAG..."
git add package.json package-lock.json
git commit -m "chore: release $TAG"
git tag "$TAG"

# ── Push ───────────────────────────────────────────────────────────────────────

echo ""
echo "==> Pushing commit and tag to origin..."
git push
git push origin "$TAG"

# ── Done ───────────────────────────────────────────────────────────────────────

echo ""
echo "✓ Release $TAG pushed."
echo "  GitHub Actions will now build the macOS DMG and Windows installer."
echo "  Monitor progress at:"
echo "  https://github.com/syaifulazham/eptim-bridge-control/actions"
echo ""
echo "  Installers will appear at:"
echo "  https://github.com/syaifulazham/eptim-bridge-control/releases/tag/$TAG"
