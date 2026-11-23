; Remove the UniDesk Secure Desktop service and its files on uninstall.
!macro customUnInstall
  nsExec::Exec 'sc.exe stop UniDeskService'
  Sleep 1500
  nsExec::Exec 'sc.exe delete UniDeskService'
  nsExec::Exec 'schtasks.exe /delete /f /tn UniDesk'
  RMDir /r "$PROGRAMFILES64\UniDesk Service"
  ExpandEnvStrings $0 "%ProgramData%"
  RMDir /r "$0\UniDesk"
!macroend
