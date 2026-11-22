**P1 (strong): Null deref in a**

Missing null check before dereferencing value.

Failure scenario: Empty input throws TypeError.

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

<sub>MegaLens static review. A second opinion on the diff, not a verdict.</sub>
<!-- megalens-review:v1 file=src%2Fa.ts lines=1-1 title=7eb6ee45f59cc83f -->
