; Remove the UniDesk Secure Desktop service and its files on uninstall.
; Not during an update: the old version's uninstaller also runs then, and the service,
; the start-up task and their settings must stay.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec 'sc.exe stop UniDeskService'
    Sleep 1500
    nsExec::Exec 'sc.exe delete UniDeskService'
    nsExec::Exec 'schtasks.exe /delete /f /tn UniDesk'
    RMDir /r "$PROGRAMFILES64\UniDesk Service"
    ExpandEnvStrings $0 "%ProgramData%"
    RMDir /r "$0\UniDesk"
  ${endIf}
!macroend
