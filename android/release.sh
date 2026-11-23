#!/usr/bin/env bash
# MPfy releases, run by hand on the PC (Git Bash).
#
#   bash android/release.sh <versionName>   bump the version, build and sign the APK, write latest.json
#   bash android/release.sh --publish        publish what the last build made as a GitHub release
#
# The two steps are apart so the version bump is committed and pushed before the tag exists.
# The keystore password is read from ~/.mpfy-sign/pass.ps1 when MPFY_KEYSTORE_PASS is not set; it
# only ever goes to the Gradle command, never to the screen or a file.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
gradle_file="$here/app/build.gradle.kts"
util_js="$repo/web/js/util.js"
out="$here/release"
release_digest=eebd3974aeb11734bac7aa96c1dead16fde3ad4887b9a54d3d973158d51ea50e
gh_repo=BaccaranciaSte/MPfy

die() {
  echo "release.sh: $*" >&2
  exit 1
}

# While a build runs: the two files as they were before the bump, put back when the build does not
# finish, and whether a Gradle daemon may hold the password in its environment.
bumped=""
built=0
daemon=0

on_exit() {
  local status=$?
  if [ -n "$bumped" ]; then
    if [ "$built" != 1 ]; then
      cp "$bumped/build.gradle.kts" "$gradle_file"
      cp "$bumped/util.js" "$util_js"
      echo "release.sh: the version bump is undone" >&2
    fi
    rm -rf "$bumped"
  fi
  if [ "$daemon" = 1 ]; then
    (cd "$here" && ./gradlew --stop >/dev/null 2>&1) || true
  fi
  exit "$status"
}
trap on_exit EXIT

sdk_dir() {
  if [ -n "${ANDROID_HOME:-}" ]; then
    cygpath -u "$ANDROID_HOME"
  else
    cygpath -u "${LOCALAPPDATA:?}/Android/Sdk"
  fi
}

clean_tree() {
  [ -z "$(git -C "$repo" status --porcelain -- android web client-core transport package.json package-lock.json)" ]
}

# The one line a pattern matches, or abort.
one_line() {
  local pattern=$1 file=$2 n
  n=$(grep -cE "$pattern" "$file" || true)
  [ "$n" = 1 ] || die "expected one line matching '$pattern' in $file, found $n"
  grep -E "$pattern" "$file"
}

# 0 when $1 is greater than $2, part by part.
version_gt() {
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<<"$1"
  IFS=. read -r b1 b2 b3 <<<"$2"
  if [ $((10#$a1)) -ne $((10#$b1)) ]; then [ $((10#$a1)) -gt $((10#$b1)) ]; return; fi
  if [ $((10#$a2)) -ne $((10#$b2)) ]; then [ $((10#$a2)) -gt $((10#$b2)) ]; return; fi
  [ $((10#$a3)) -gt $((10#$b3)) ]
}

sha256_of() {
  sha256sum "$1" | cut -d' ' -f1
}

json_field() {
  node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(j[process.argv[2]]))' "$(cygpath -w "$1")" "$2"
}

build() {
  local new=$1
  clean_tree || die "Commit or stash first"
  [[ $new =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the version must look like 2.1.0"

  local code_line name_line app_line cur_code cur_name
  code_line=$(one_line '^[[:space:]]*versionCode = [0-9]+$' "$gradle_file")
  name_line=$(one_line '^[[:space:]]*versionName = "[0-9]+\.[0-9]+\.[0-9]+"$' "$gradle_file")
  app_line=$(one_line "^export const APP_VERSION = '[0-9]+\.[0-9]+\.[0-9]+';$" "$util_js")
  cur_code=$(sed -E 's/.*= ([0-9]+)$/\1/' <<<"$code_line")
  cur_name=$(sed -E 's/.*"([^"]*)"$/\1/' <<<"$name_line")
  [ -n "$app_line" ] || die "APP_VERSION not found"
  # A new version line (1.0.0 after the development builds) is allowed with MPFY_NEW_LINE=1: the
  # name may go down, the versionCode Android and the updater compare still grows by one.
  version_gt "$new" "$cur_name" || [ "${MPFY_NEW_LINE:-}" = 1 ] || die "$new is not greater than $cur_name"
  local code=$((cur_code + 1))
  local min_sdk
  min_sdk=$(sed -nE 's/^[[:space:]]*minSdk = ([0-9]+)$/\1/p' "$gradle_file")
  [ -n "$min_sdk" ] || die "minSdk not found"

  bumped=$(mktemp -d)
  cp "$gradle_file" "$bumped/build.gradle.kts"
  cp "$util_js" "$bumped/util.js"
  sed -i -E "s/^([[:space:]]*versionCode = )[0-9]+$/\1$code/" "$gradle_file"
  sed -i -E "s/^([[:space:]]*versionName = )\"[0-9.]+\"$/\1\"$new\"/" "$gradle_file"
  sed -i -E "s/^export const APP_VERSION = '[0-9.]+';$/export const APP_VERSION = '$new';/" "$util_js"
  echo "versionCode $cur_code -> $code, versionName $cur_name -> $new"

  local keystore="${MPFY_KEYSTORE:-$HOME/.mpfy-sign/mpfy-release.jks}"
  [ -f "$keystore" ] || die "no keystore at $keystore"
  local pass="${MPFY_KEYSTORE_PASS:-}"
  if [ -z "$pass" ]; then
    pass=$(powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(cygpath -w "$HOME/.mpfy-sign/pass.ps1")" | tr -d '\r\n')
    [ -n "$pass" ] || die "the keystore password could not be read"
  fi

  export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
  daemon=1
  (
    cd "$here"
    MPFY_KEYSTORE="$(cygpath -w "$keystore")" MPFY_KEYSTORE_PASS="$pass" ./gradlew assembleRelease --console=plain
  )
  pass=""
  (cd "$here" && ./gradlew --stop >/dev/null)
  daemon=0

  mkdir -p "$out"
  local apk="$out/MPfy-$new.apk"
  cp "$here/app/build/outputs/apk/release/app-release.apk" "$apk"

  local tools
  tools="$(sdk_dir)/build-tools/36.1.0"
  local certs
  certs=$("$tools/apksigner.bat" verify --print-certs "$(cygpath -w "$apk")" | tr -d '\r') || { rm -f "$apk"; die "apksigner verify failed"; }
  if ! grep -qx "Signer #1 certificate SHA-256 digest: $release_digest" <<<"$certs"; then
    rm -f "$apk"
    die "the APK is not signed with the release key"
  fi
  local badging
  badging=$("$tools/aapt2.exe" dump badging "$(cygpath -w "$apk")" | tr -d '\r') || { rm -f "$apk"; die "aapt2 dump badging failed"; }
  if ! grep -q "versionCode='$code'" <<<"$badging"; then
    rm -f "$apk"
    die "the APK does not say versionCode $code"
  fi

  local size sha
  size=$(stat -c %s "$apk")
  sha=$(sha256_of "$apk")
  printf '{ "format": "mpfy-update", "v": 1, "versionCode": %s, "versionName": "%s",\n  "url": "https://github.com/%s/releases/download/v%s/MPfy-%s.apk",\n  "size": %s, "sha256": "%s", "signer": "%s", "minSdk": %s }\n' \
    "$code" "$new" "$gh_repo" "$new" "$new" "$size" "$sha" "$release_digest" "$min_sdk" >"$out/latest.json"

  built=1
  echo "versionCode $code"
  echo "versionName $new"
  echo "size $size"
  echo "sha256 $sha"
  echo "Now commit, push, then: bash android/release.sh --publish"
}

publish() {
  [ -t 0 ] || die "only by hand"
  command -v gh >/dev/null || die "gh is not installed"
  clean_tree || die "Commit or stash first"
  [ -z "$(git -C "$repo" status --porcelain --untracked-files=no)" ] || die "Commit or stash first"
  local head upstream
  head=$(git -C "$repo" rev-parse HEAD)
  upstream=$(git -C "$repo" rev-parse '@{u}' 2>/dev/null) || die "the branch has no upstream"
  [ "$head" = "$upstream" ] || die "push first: HEAD is not its upstream"
  [ -f "$out/latest.json" ] || die "no build: run bash android/release.sh <versionName> first"

  local v name_line apk
  v=$(json_field "$out/latest.json" versionName)
  name_line=$(one_line '^[[:space:]]*versionName = "[0-9]+\.[0-9]+\.[0-9]+"$' "$gradle_file")
  [ "$(sed -E 's/.*"([^"]*)"$/\1/' <<<"$name_line")" = "$v" ] || die "build.gradle.kts and latest.json name different versions"
  apk="$out/MPfy-$v.apk"
  [ -f "$apk" ] || die "missing $apk"
  [ "$(sha256_of "$apk")" = "$(json_field "$out/latest.json" sha256)" ] || die "the APK changed since the build"

  local answer
  read -r -p "Pubblicare MPfy $v? [s/N] " answer
  [ "$answer" = "s" ] || [ "$answer" = "S" ] || die "nothing published"
  gh release create "v$v" "$apk" "$out/latest.json" --repo "$gh_repo" --title "MPfy $v" --notes "MPfy $v" --target "$head"
}

case "${1:-}" in
  --publish) publish ;;
  "") die "usage: bash android/release.sh <versionName> | --publish" ;;
  *) build "$1" ;;
esac
