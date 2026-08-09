#!/bin/bash
set -Eeuo pipefail
umask 077

command -v gpg >/dev/null || { echo "gpg is required" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
output_dir="${1:-${repo_dir}/secrets/apt-repo}"

if [[ -e "$output_dir" ]]; then
  echo "Refusing to overwrite existing key directory: $output_dir" >&2
  exit 1
fi

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
gnupg_home="$(mktemp -d)"
cleanup() { rm -rf -- "${gnupg_home:?}"; }
trap cleanup EXIT
chmod 700 "$gnupg_home"

passphrase="${GPG_PASSPHRASE:-$(openssl rand -base64 48 | tr -d '\n')}"
uid="${APT_REPO_GPG_UID:-Alghul Debian Repository <packages@alghul.com>}"

GNUPGHOME="$gnupg_home" gpg --batch --pinentry-mode loopback \
  --passphrase "$passphrase" --quick-generate-key "$uid" rsa4096 sign 3y
fingerprint="$(GNUPGHOME="$gnupg_home" gpg --batch --with-colons --list-secret-keys "$uid" | awk -F: '$1 == "fpr" { print $10; exit }')"
[[ -n "$fingerprint" ]] || { echo "Could not determine key fingerprint" >&2; exit 1; }

GNUPGHOME="$gnupg_home" gpg --batch --armor --export "$fingerprint" > "$output_dir/gpg.key"
GNUPGHOME="$gnupg_home" gpg --batch --pinentry-mode loopback --passphrase "$passphrase" \
  --armor --export-secret-keys "$fingerprint" > "$output_dir/private-key.asc"
printf '%s\n' "$passphrase" > "$output_dir/passphrase.txt"
printf '%s\n' "$fingerprint" > "$output_dir/fingerprint.txt"
chmod 600 "$output_dir/private-key.asc" "$output_dir/passphrase.txt"
chmod 644 "$output_dir/gpg.key" "$output_dir/fingerprint.txt"

echo "Created a three-year repository signing key in $output_dir"
echo "Store private-key.asc and passphrase.txt in a password manager, then add them as GitHub Actions secrets."
