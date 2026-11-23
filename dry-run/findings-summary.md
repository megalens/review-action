<!-- megalens:review:v1:standard -->
<!-- megalens:meta head=4ef0a27e237a5146de038c3f79b7955009d7da1d tier=standard status=complete ts=1790208000000 -->
### MegaLens static review of `4ef0a27`

Tier: `standard` · Review: `rv_fixture00000000000001`

> Note: no OS-level isolation was used (isolation: none)

0 inline strong findings; 1 other finding below.

<details>
<summary>1 summary finding</summary>

- **P1** <code>src/a.ts:1</code>: Null deref in a. Missing null check before dereferencing value. Empty input throws TypeError.

  <details>
  <summary>Copy fix prompt</summary>

  Check the finding in the code and fill in the template in your own words before sending it to a coding tool.

  ```
  Check [file and lines] to confirm that [describe what happens and when].
  The code should [describe the expected behavior].

  Ask for any missing details before editing.
  Keep the fix small. Add a regression test and run the relevant tests.
  ```

  </details>

</details>

<sub>Static review only: no code was run. Findings are a second opinion for you to check, not a verdict.</sub>
