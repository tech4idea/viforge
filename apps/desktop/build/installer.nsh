!include LogicLib.nsh
!include nsDialogs.nsh

Var ViworkDataRootDialog
Var ViworkDataRootText
Var ViworkDataRoot

!macro customPageAfterChangeDir
  Page custom ViworkDataRootPageCreate ViworkDataRootPageLeave
!macroend

Function ViworkDataRootPageCreate
  nsDialogs::Create 1018
  Pop $ViworkDataRootDialog
  ${If} $ViworkDataRootDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "选择 viwork 数据路径。项目、运行配置、日志和内置 PostgreSQL 数据都会保存在这里。"
  ${NSD_CreateText} 0 34u 78% 12u ""
  Pop $ViworkDataRootText
  ${NSD_CreateBrowseButton} 82% 33u 18% 14u "浏览..."
  Pop $0
  ${NSD_OnClick} $0 ViworkDataRootBrowse

  nsDialogs::Show
FunctionEnd

Function ViworkDataRootBrowse
  nsDialogs::SelectFolderDialog "选择 viwork 数据路径" ""
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $ViworkDataRootText "$0"
  ${EndIf}
FunctionEnd

Function ViworkDataRootPageLeave
  ${NSD_GetText} $ViworkDataRootText $ViworkDataRoot
  ${If} $ViworkDataRoot == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "请选择 viwork 数据路径，否则无法继续安装。"
    Abort
  ${EndIf}

  CreateDirectory "$ViworkDataRoot"
  IfErrors 0 +3
    MessageBox MB_ICONSTOP|MB_OK "无法创建数据路径，请选择其他目录。"
    Abort
FunctionEnd

!macro customInstall
  CreateDirectory "$APPDATA\viwork"
  FileOpen $0 "$APPDATA\viwork\data-root.txt" w
  FileWrite $0 "$ViworkDataRoot$\r$\n"
  FileClose $0
!macroend
