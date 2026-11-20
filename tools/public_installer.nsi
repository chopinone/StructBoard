Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"
Name "构境 StructBoard"
OutFile "${INSTALLER_OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\StructBoard"
RequestExecutionLevel user
ShowInstDetails show
!define MUI_ABORTWARNING
!define MUI_ICON "${SOURCE_DIR}\app_icon.ico"
!define MUI_UNICON "${SOURCE_DIR}\app_icon.ico"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${SOURCE_DIR}\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "此安装包适用于 64 位 Windows。"
    Abort
  ${EndIf}
FunctionEnd

Function CheckWebView
  SetRegView 32
  ReadRegStr $0 HKLM "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  SetRegView 64
  ${If} $0 == ""
    ReadRegStr $0 HKLM "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 == ""
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=WebView2Setup.exe "${WEBVIEW_BOOTSTRAPPER}"
    DetailPrint "正在安装 Microsoft WebView2，首次安装需要联网…"
    ExecWait '"$PLUGINSDIR\WebView2Setup.exe" /silent /install' $1
    ${If} $1 != 0
    ${AndIf} $1 != 3010
      MessageBox MB_ICONSTOP "WebView2 安装未完成。请联网后重试，或先安装 Microsoft WebView2 Runtime。"
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "构境 StructBoard" Main
  Call CheckWebView
  # Refuse an update while this installation's native/backend binaries are in
  # use. Paths go through an environment variable, never interpolated as code.
  System::Call 'Kernel32::SetEnvironmentVariableW(w "STRUCTBOARD_INSTALL_TARGET", w "$INSTDIR")'
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -Command "$$target=[IO.Path]::GetFullPath($$env:STRUCTBOARD_INSTALL_TARGET).TrimEnd([char]92)+[char]92; $$busy=Get-CimInstance Win32_Process | Where-Object {$$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$target,[StringComparison]::OrdinalIgnoreCase)}; if($$busy){exit 23}"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "请先关闭此安装目录中的构境，以及 AI 客户端里的 StructBoard MCP 连接，再重新安装。"
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR"
  File /r "${RELEASE_DIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StructBoard" "DisplayName" "构境 StructBoard"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StructBoard" "DisplayVersion" "0.3.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StructBoard" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StructBoard" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StructBoard" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StructBoard" "NoRepair" 1
  IfSilent shortcuts_done
  CreateShortcut "$DESKTOP\构境 StructBoard.lnk" "$INSTDIR\StructBoard.exe"
  CreateDirectory "$SMPROGRAMS\构境 StructBoard"
  CreateShortcut "$SMPROGRAMS\构境 StructBoard\构境.lnk" "$INSTDIR\StructBoard.exe"
  shortcuts_done:
SectionEnd

Section "Uninstall"
  # User pipelines, structures and MCP authorizations live in AppData and are
  # deliberately retained when uninstalling the application.
  Delete "$INSTDIR\StructBoard.exe"
  Delete "$INSTDIR\manifest.json"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
  RMDir /r "$INSTDIR\licenses"
  RMDir /r "$INSTDIR\bootstrap"
  RMDir /r "$INSTDIR\backend"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StructBoard"
SectionEnd
