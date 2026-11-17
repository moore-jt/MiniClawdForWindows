; Take Mini Clawd's hooks out of ~/.claude/settings.json when the app is uninstalled.
; The app handles --remove-hooks itself (src/main.ts) and exits without opening a window.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --remove-hooks'
  ${endIf}
!macroend
