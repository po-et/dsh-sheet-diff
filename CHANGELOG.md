# SheetDiff v0.2.1

- Fix first-run CLI examples such as `--out reviews/round-1`: missing parent directories are now created for comparisons and handoffs. The output directory itself must still be new, and invalid inputs are rejected before output directories are created.
- Add an install-free, offline sample ZIP to the release. Extract it and open `index.html` to review a synthetic order-table edit, export a decision, and import it again. The sample includes both source workbooks and the report JSON, so its exported review can be checked by the CLI.
- Keep the source-checkout instructions consistent from comparison through handoff; cloning and installing dependencies does not install a global `sheet-diff` command.

Harness compatibility remains `0.2.1-rc.2` and `0.2.1-rc.3`. The sample uses the same comparator and renderer as the plugin. SHA256SUMS covers both the plugin bundle and sample ZIP.

# SheetDiff v0.2.0

Review changes all the way through to a new revision:

- Mark individual differences accepted, needs change, or pending. Export and import decisions to resume a review. Existing v0.1 comments import as pending.
- Generate a JSON and Markdown handoff with `sheet_diff_handoff` or `sheet-diff handoff`. Both source files must still match the report hashes. Feedback includes the original differences; no spreadsheet is modified.
- Use the bundled `sheet-diff-review` skill in Harness or another agent with the CLI installed. Keep the baseline, make authorized corrections in a new file, then compare again.
- Target Harness 0.2.1-rc.2 and 0.2.1-rc.3 with explicit peer ranges and a reproducible isolated-profile smoke command. Node.js 24.9+ is required.
- Include the existing header-row, ISO-date storage and formula-literal parsing fixes in the release bundle. Unsupported ISO date cells fail with an actionable error instead of producing lossy comparisons.

The HTML report runs offline. Review data includes workbook contents; share it with the same care as the original files. Hash verification identifies current bytes, not authenticity or fresh formula calculation. Pending changes are never implied approval.

Install the attached tarball using `dsh plugin --profile YOUR_PROFILE add <release asset URL>`, then restart that profile. See README for supported inputs and limits. SHA256SUMS covers the release bundle.
