#!/usr/bin/env bash
# Build the whole Pages site: the default branch at the root, every other
# branch under /<branch>/ (slashes become dashes), and an index of them all
# at /branches/. A branch that fails to build is left out, not fatal.
#
#     tools/build_site.sh [out-dir]     # default: site/
#
# Needs the remote branches fetched (the workflow checks out with full history).
set -euo pipefail

out="$(realpath -m "${1:-site}")"
default="${DEFAULT_BRANCH:-main}"
root="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"; git -C "$root" worktree prune' EXIT

git -C "$root" fetch --quiet --prune origin '+refs/heads/*:refs/remotes/origin/*'
rm -rf "$out"
mkdir -p "$out"

slug() { printf '%s' "$1" | tr '/' '-' | tr -cd 'A-Za-z0-9._-'; }

rows=""
build() {
  local branch="$1" dest="$2" ns="$3" wt="$tmp/$(slug "$1")"
  git -C "$root" worktree add --quiet --detach "$wt" "origin/$branch"
  if [ ! -f "$wt/package.json" ]; then
    echo "skip $branch: no package.json"
    return 1
  fi
  if ! (cd "$wt" && npm ci --no-audit --no-fund --silent \
        && SAVE_NAMESPACE="$ns" BRANCH_LABEL="$ns" npx vite build --logLevel warn --outDir "$tmp/out-$ns" --emptyOutDir); then
    echo "skip $branch: build failed"
    return 1
  fi
  mkdir -p "$dest"
  cp -r "$tmp/out-$ns/." "$dest/"
  echo "built $branch -> ${dest#"$out"}/"
}

# Default branch first, at the root (its build has no namespace or label).
build "$default" "$out" "" || { echo "default branch $default failed to build"; exit 1; }

for branch in $(git -C "$root" for-each-ref --format='%(refname:strip=3)' refs/remotes/origin); do
  [ "$branch" = "HEAD" ] || [ "$branch" = "$default" ] && continue
  s="$(slug "$branch")"
  [ "$s" = "branches" ] || [ "$s" = "assets" ] || [ "$s" = "textures" ] && { echo "skip $branch: reserved path"; continue; }
  if build "$branch" "$out/$s" "$s"; then
    when="$(git -C "$root" log -1 --format='%cs' "origin/$branch")"
    subject="$(git -C "$root" log -1 --format='%s' "origin/$branch" | sed 's/&/\&amp;/g; s/</\&lt;/g')"
    rows+="<li><a href=\"../$s/\">$branch</a><span>$when · $subject</span></li>"
  fi
done

mkdir -p "$out/branches"
cat > "$out/branches/index.html" <<EOF
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Labyrinth branches</title>
<style>
  body { margin: 0; padding: 24px 16px; background: #f2ede6; color: #3b2a1a; font: 16px/1.4 Georgia, serif; }
  main { max-width: 560px; margin: 0 auto; }
  h1 { color: #8a5a2b; font-size: 24px; margin: 0 0 16px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { background: #fbf5ea; border: 1px solid rgba(138, 90, 43, 0.25); border-radius: 12px; margin-bottom: 10px; }
  a { display: block; padding: 14px 16px 2px; color: #8a5a2b; font-weight: bold; text-decoration: none; word-break: break-all; }
  span { display: block; padding: 0 16px 14px; font-size: 14px; opacity: 0.75; }
</style>
</head>
<body>
<main>
<h1>Labyrinth branches</h1>
<ul>
<li><a href="../">$default</a><span>the main game</span></li>
$rows
</ul>
</main>
</body>
</html>
EOF
echo "wrote $out/branches/index.html"
