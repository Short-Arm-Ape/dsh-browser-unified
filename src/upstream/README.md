# upstream/

Here we keep only what cannot be regenerated:

- `*/LICENSE` (plus `THIRD_PARTY_NOTICES` / `THIRD-PARTY-LICENSES` where the upstream ships one) —
  required for attribution when this repository contains code derived from them.
- the commit each snapshot was taken from: `../upstream-baseline.json`.

Source snapshots are **not** stored here. Every entry in the baseline pins a public repository and a
commit SHA, so the code can be fetched again:

```bash
git clone https://github.com/<repo> /tmp/up && git -C /tmp/up checkout <sha>
```

Why: the vendored sources were 90% of this repository's size, they are reproducible from the pins, and
nothing in the build reads them. `NOTICE.md` carries the attribution matrix; the license texts sit next
to it here.
