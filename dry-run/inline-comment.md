**P1 (strong): Null deref in a**

Missing null check before dereferencing value.

Failure scenario: Empty input throws TypeError.

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

<sub>MegaLens static review. A second opinion on the diff, not a verdict.</sub>
<!-- megalens-review:v1 file=src%2Fa.ts lines=1-1 title=7eb6ee45f59cc83f -->
