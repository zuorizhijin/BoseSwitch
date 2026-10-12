"""在 Windows 上为 Chrome 注册 BoseSwitch 小助手（只写当前用户的注册表，不需要管理员）。

安装: python helper\\install_windows.py
卸载: python helper\\install_windows.py --uninstall
"""
import json
import os
import sys
import winreg

EXT_ID = "fnanijmlhmchfapoonnmedlmandfcoje"  # 由 extension/manifest.json 里的 key 决定
NAME = "com.boseswitch.helper"
REG_PATH = "Software\\Google\\Chrome\\NativeMessagingHosts\\" + NAME
HERE = os.path.dirname(os.path.abspath(__file__))
BAT = os.path.join(HERE, "boseswitch_host.bat")
MANIFEST = os.path.join(HERE, NAME + ".json")


def install():
    with open(BAT, "w", encoding="mbcs", newline="\r\n") as f:
        f.write('@echo off\n"%s" -I "%%~dp0host.py" %%*\n' % sys.executable)
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump({
            "name": NAME,
            "description": "BoseSwitch 小助手",
            "path": BAT,
            "type": "stdio",
            "allowed_origins": ["chrome-extension://%s/" % EXT_ID],
        }, f, ensure_ascii=False, indent=2)
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REG_PATH) as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, MANIFEST)
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_PATH) as k:
        registered = winreg.QueryValueEx(k, "")[0]
    print("已安装。注册表指向:", registered)
    print("Python:", sys.executable)
    print("请在 chrome://extensions 里刷新 BoseSwitch 扩展。")


def uninstall():
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, REG_PATH)
        print("已卸载（注册表项已删除）。")
    except FileNotFoundError:
        print("没有找到已安装的小助手。")


if __name__ == "__main__":
    uninstall() if "--uninstall" in sys.argv else install()
