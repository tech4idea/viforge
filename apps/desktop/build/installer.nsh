!ifndef VIFORGE_INSTALLER_NSH_INCLUDED
!define VIFORGE_INSTALLER_NSH_INCLUDED

!ifndef BUILD_UNINSTALLER
!include LogicLib.nsh
!include nsDialogs.nsh

Var ViforgeDataRootDialog
Var ViforgeDataRootText
Var ViforgeDataRoot
Var ViforgeExistingDataRoot

!macro customInit
  ReadRegStr $0 HKCU "Software\ViForge" "InstallLocation"
  ${If} $0 != ""
    StrCpy $INSTDIR "$0"
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom ViforgeDataRootPageCreate ViforgeDataRootPageLeave
!macroend

Function ViforgeDataRootPageCreate
  ReadRegStr $ViforgeExistingDataRoot HKCU "Software\ViForge" "DataRoot"
  ${If} $ViforgeExistingDataRoot == ""
    StrCpy $ViforgeExistingDataRoot "$LOCALAPPDATA\ViForge\data"
  ${EndIf}

  nsDialogs::Create 1018
  Pop $ViforgeDataRootDialog
  ${If} $ViforgeDataRootDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "选择 ViForge 数据路径。项目数据、运行配置和日志都会保存在这里。"
  ${NSD_CreateText} 0 34u 78% 12u "$ViforgeExistingDataRoot"
  Pop $ViforgeDataRootText
  ${NSD_CreateBrowseButton} 82% 33u 18% 14u "浏览..."
  Pop $0
  ${NSD_OnClick} $0 ViforgeDataRootBrowse

  nsDialogs::Show
FunctionEnd

Function ViforgeDataRootBrowse
  nsDialogs::SelectFolderDialog "选择 ViForge 数据路径" ""
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $ViforgeDataRootText "$0"
  ${EndIf}
FunctionEnd

Function ViforgeDataRootPageLeave
  ${NSD_GetText} $ViforgeDataRootText $ViforgeDataRoot
  ${If} $ViforgeDataRoot == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "请选择 ViForge 数据路径，否则无法继续安装。"
    Abort
  ${EndIf}

  CreateDirectory "$ViforgeDataRoot"
  IfErrors 0 +3
    MessageBox MB_ICONSTOP|MB_OK "无法创建数据路径，请选择其他目录。"
    Abort
FunctionEnd

!macro customInstall
  CreateDirectory "$APPDATA\ViForge"
  FileOpen $0 "$APPDATA\ViForge\data-root.txt" w
  FileWrite $0 "$ViforgeDataRoot$\r$\n"
  FileClose $0
  WriteRegStr HKCU "Software\ViForge" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\ViForge" "DataRoot" "$ViforgeDataRoot"
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\ViForge" "InstallLocation"
!macroend

!endif
!endif
