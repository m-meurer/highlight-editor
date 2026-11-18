; Included by electron-builder's NSIS installer.
; After the .hlp association is written, tell Explorer that file associations
; changed and flush, so .hlp files show the new icon straight away, including
; when installing over an older version.
!macro customInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend
