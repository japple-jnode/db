# `@jnode/db`

> This package is still in development, may contain many bugs.

## DBLE Format Specification

```
---- File Head
[4 Byte] "JDBD"
[UInt8 ] Version, 1
[3 Byte] RSV
[4 Byte] DB Type, "DBLE"
[UInt8 ] DB Version, 1
[3 Byte] RSV
---- DB Head
[Array ] Definition
  [16 Bit] Flag (isLast, isKey, RSV...)
  [UInt16] Field Length
  [UInt8 ] Type Name Length
  [String] Type Name
  [UInt8 ] Field Name Length
  [String] Field Name
[UInt16] Extend Field Base Length (making each line 2 ** N bytes)
[UInt32] Last Empty Line (0xFFFFFFFF for null)
[n Byte] Padding (making 'File Head' + 'DB Head' N * Line Length)
---- DB Body
[Array ] Lines
  [2 Bit ] Type (Normal Start, Extended, Empty, Deleted Start)
  [14 Bit] Flag
  [UInt32] Extended Line At/Last Empty Line (if type is 'Empty', 0xFFFFFFFF for null)
  [Array ] Line Data
    [n Byte] Field Data
```
