#!/bin/sh
# 在 macOS 上为 Chrome 安装 BoseSwitch 小助手（只写当前用户目录，不需要管理员）
# 安装: sh install_mac.sh
# 卸载: sh install_mac.sh --uninstall
set -e
EXT_ID=fnanijmlhmchfapoonnmedlmandfcoje   # 由 extension/manifest.json 里的 key 决定
NAME=com.boseswitch.helper
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Library/Application Support/BoseSwitch"
HOSTS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

if [ "$1" = "--uninstall" ]; then
  rm -f "$HOSTS/$NAME.json"
  rm -rf "$APP"
  echo "已卸载。"
  exit 0
fi

PY=""
for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [ -x "$c" ] && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
    PY="$c"
    break
  fi
done
if [ -z "$PY" ]; then
  echo "没找到 Python 3.9 以上版本。请先运行 xcode-select --install 安装命令行工具，再重新运行本脚本。"
  exit 1
fi
echo "使用 Python: $PY ($("$PY" --version 2>&1))"

mkdir -p "$APP" "$HOSTS"
echo "创建独立环境并安装 PyObjC（蓝牙接口），首次约需 1 分钟……"
"$PY" -m venv "$APP/venv"
# PyObjC 12 不再支持 Python 3.9（macOS 自带的版本），锁定 11.1；
# 只装预编译包，避免在没有编译器的机器上从源码编译
PKGS="pyobjc-core==11.1 pyobjc-framework-Cocoa==11.1 pyobjc-framework-IOBluetooth==11.1"
pip_install() {
  "$APP/venv/bin/python" -m pip install --quiet --disable-pip-version-check --only-binary=:all: "$@"
}
if ! pip_install $PKGS; then
  echo "默认源安装失败，改用清华镜像重试……"
  pip_install -i https://pypi.tuna.tsinghua.edu.cn/simple $PKGS
fi

cp "$HERE/host.py" "$HERE/mac_bt.py" "$APP/"
cat > "$APP/boseswitch_host" <<EOF
#!/bin/sh
exec "$APP/venv/bin/python" -I "$APP/host.py" "\$@"
EOF
chmod +x "$APP/boseswitch_host"

cat > "$HOSTS/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "BoseSwitch 小助手",
  "path": "$APP/boseswitch_host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
echo "已安装。Chrome 配置: $HOSTS/$NAME.json"
echo
echo "===== 自检（如果系统询问「终端」是否可以使用蓝牙，请点允许）====="
"$APP/venv/bin/python" -I "$APP/host.py" --selftest || true
