<!-- megalens:review:v1:standard -->
<!-- megalens:meta head=4ef0a27e237a5146de038c3f79b7955009d7da1d tier=standard status=complete ts=1790208000000 -->
### MegaLens static review of `4ef0a27`

Tier: `standard` · Review: `rv_fixture00000000000001`

> Note: no OS-level isolation was used (isolation: none)

0 inline strong findings; 1 other finding below.

<details>
<summary>1 summary finding</summary>

- **P1** <code>src/a.ts:1</code>: Null deref in a. Missing null check before dereferencing value.

  <details>
  <summary>Fix prompt</summary>

  ```
  Verify this finding against the code before editing.

  File: src/a.ts
  Lines: 1
  Finding: Null deref in a.
  Why: Missing null check before dereferencing value. Empty input throws TypeError.
  Expected behavior: Handle the case described above without the reported failure.

  Change only what is needed. Keep the tests passing. Add a test that reproduces the issue before the fix and passes after it.
  ```

  </details>

</details>

<sub>Static review only: no code was run. Findings are a second opinion for you to check, not a verdict.</sub>
