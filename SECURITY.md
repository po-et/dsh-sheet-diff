# Security and data boundaries

This plugin reads local CSV/XLSX files and writes new review artifacts. It does not run macros, evaluate formulas, fetch URLs found in cells, or automatically apply review comments. The Harness adapter uses the host filesystem and sandbox policy, and restricts paths to the session workspace. The CLI uses the paths you explicitly pass to it.

XLSX ZIP parts are checked before ExcelJS loads them: count, declared and actual expanded size, filenames, duplicate entries, encrypted/active content and XML entity declarations. These checks reduce parser exposure; they are not a promise that arbitrary hostile spreadsheets are safe. Use small, trusted or sanitized inputs.

The HTML report treats workbook strings as data, uses a restrictive Content Security Policy, and has no external resources. Imported comments are validated and remain data. Reports can contain confidential values, filenames and hashes. Do not publish real reports as examples.

## Dependency audit

The development YAML parser is pinned to 2.9.1, which contains the fix for [GHSA-48c2-rrv3-qjmp](https://github.com/advisories/GHSA-48c2-rrv3-qjmp).

ExcelJS 4.4.0 depends on uuid 8.3.2. The npm audit warning [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) concerns uuid's v3/v5/v6 output-buffer handling. Inspection of ExcelJS's use shows a v4 call in conditional-format writing, not those affected functions. SheetDiff's runtime reads workbooks and does not expose uuid APIs. The transitive advisory remains visible: the dependency tree is **not audit-clean**. We have not hidden it with an unrelated major-version downgrade or an override that would not carry into consumers' installations.

## Reporting

Until a private security-reporting channel is published for the repository, do not post secrets or sensitive exploit data in a public issue. An anonymized input and a concise description of the boundary that failed are sufficient for ordinary parser or comparison bugs.
