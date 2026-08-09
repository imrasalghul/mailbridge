#!/bin/bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
output_dir="${1:-${repo_dir}/dist/debian}"
node_version="${NODE_VERSION:-22.23.2}"
package_version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "${repo_dir}/package.json" | head -n 1)"
architecture="$(dpkg --print-architecture)"

if [[ ! "$package_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+~.-][0-9A-Za-z.+~-]+)?$ ]]; then
  echo "Invalid or missing package version: ${package_version:-<empty>}" >&2
  exit 2
fi

case "$architecture" in
  amd64) node_arch="x64" ;;
  arm64) node_arch="arm64" ;;
  *) echo "Unsupported Debian architecture: $architecture" >&2; exit 2 ;;
esac

build_dir="$(mktemp -d /tmp/mailbridge-deb.XXXXXX)"
case "$build_dir" in
  /tmp/mailbridge-deb.*) ;;
  *) echo "Unexpected temporary directory: $build_dir" >&2; exit 1 ;;
esac
cleanup() {
  case "${build_dir:-}" in
    /tmp/mailbridge-deb.*) rm -rf -- "${build_dir:?}" ;;
  esac
}
trap cleanup EXIT

stage_dir="${build_dir}/stage"
app_dir="${stage_dir}/opt/mailbridge/app"
node_dir="${stage_dir}/opt/mailbridge/node"
mkdir -p "$app_dir" "${node_dir}/bin" "${stage_dir}/DEBIAN" \
  "${stage_dir}/usr/bin" "${stage_dir}/usr/sbin" \
  "${stage_dir}/usr/lib/systemd/system" \
  "${stage_dir}/usr/share/doc/mailbridge" "$output_dir"

node_archive="node-v${node_version}-linux-${node_arch}.tar.xz"
node_base_url="https://nodejs.org/dist/v${node_version}"
curl -fsSLo "${build_dir}/${node_archive}" "${node_base_url}/${node_archive}"
curl -fsSLo "${build_dir}/SHASUMS256.txt" "${node_base_url}/SHASUMS256.txt"
(
  cd "$build_dir"
  grep "  ${node_archive}$" SHASUMS256.txt | sha256sum -c -
)
tar -xJf "${build_dir}/${node_archive}" -C "$build_dir"
cp -a "${build_dir}/node-v${node_version}-linux-${node_arch}/." "$node_dir/"
rm -rf -- "${node_dir}/include" "${node_dir}/share"
install -m 0644 "${build_dir}/node-v${node_version}-linux-${node_arch}/LICENSE" "${stage_dir}/usr/share/doc/mailbridge/nodejs-LICENSE"

install -m 0644 "$repo_dir/package.json" "$repo_dir/package-lock.json" "$app_dir/"
cp -a "$repo_dir/lib" "$repo_dir/scripts" "$app_dir/"
install -m 0644 "$repo_dir/server.js" "$repo_dir/worker.js" "$app_dir/"
(
  cd "$app_dir"
  PATH="${node_dir}/bin:$PATH" npm ci --omit=dev --ignore-scripts=false
  npm cache clean --force >/dev/null 2>&1 || true
)

install -m 0755 "$repo_dir/packaging/debian/mailbridge-wrapper" "${stage_dir}/usr/bin/mailbridge"
install -m 0755 "$repo_dir/packaging/debian/mailbridge-setup" "${stage_dir}/usr/sbin/mailbridge-setup"
install -m 0644 "$repo_dir/packaging/debian/mailbridge.service" "${stage_dir}/usr/lib/systemd/system/mailbridge.service"
install -m 0644 "$repo_dir/.env.example" "${stage_dir}/usr/share/doc/mailbridge/mailbridge.env.example"
install -m 0644 "$repo_dir/wrangler.example.toml" "${stage_dir}/usr/share/doc/mailbridge/wrangler.example.toml"
install -m 0644 "$repo_dir/README.md" "${stage_dir}/usr/share/doc/mailbridge/README.md"
install -m 0644 "$repo_dir/LICENSE" "${stage_dir}/usr/share/doc/mailbridge/copyright"
gzip -9n "${stage_dir}/usr/share/doc/mailbridge/README.md"

install -m 0755 "$repo_dir/packaging/debian/postinst" "${stage_dir}/DEBIAN/postinst"
install -m 0755 "$repo_dir/packaging/debian/prerm" "${stage_dir}/DEBIAN/prerm"
install -m 0755 "$repo_dir/packaging/debian/postrm" "${stage_dir}/DEBIAN/postrm"

installed_size="$(du -sk "$stage_dir" | awk '{print $1}')"
sed \
  -e "s/@VERSION@/${package_version}/g" \
  -e "s/@ARCH@/${architecture}/g" \
  -e "s/@INSTALLED_SIZE@/${installed_size}/g" \
  "$repo_dir/packaging/debian/control.in" > "${stage_dir}/DEBIAN/control"

find "$stage_dir" -type d -exec chmod 0755 {} +
dpkg-deb --root-owner-group --build "$stage_dir" "${output_dir}/mailbridge_${package_version}_${architecture}.deb"
dpkg-deb --info "${output_dir}/mailbridge_${package_version}_${architecture}.deb"
echo "Built ${output_dir}/mailbridge_${package_version}_${architecture}.deb"
