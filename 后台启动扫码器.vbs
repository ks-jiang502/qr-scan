' 不弹黑窗口启动扫码器（服务在你关闭扫码器窗口后自动退出）
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c node server.js", 0, False
