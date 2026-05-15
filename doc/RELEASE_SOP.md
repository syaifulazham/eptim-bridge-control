# Release SOP — Eptim Bridge Control

Follow these steps every time you ship an update.

---

## 1. Make your changes

Edit source files as needed. Test locally with:

```bash
npm start
```

---

## 2. Bump the version

Choose the appropriate version bump:

```bash
npm version patch   # bug fix          1.0.0 → 1.0.1
npm version minor   # new feature      1.0.0 → 1.1.0
npm version major   # breaking change  1.0.0 → 2.0.0
```

This automatically:
- Updates `version` in `package.json`
- Creates a local git commit (`chore: bump version to vX.X.X`)
- Creates a local git tag (`vX.X.X`)

---

## 3. Push the code and the tag

```bash
git push                  # push the version bump commit
git push origin vX.X.X   # push the tag (replace with actual version)
```

Or push both in one command:

```bash
git push --follow-tags
```

---

## 4. Wait for GitHub Actions

Go to `github.com/syaifulazham/eptim-bridge-control/actions`

Two jobs will run automatically:
- **build-mac** — produces a `.dmg` installer for macOS (arm64 + x64)
- **build-win** — produces a `.exe` NSIS installer for Windows

Total time: ~10 minutes. Both must turn green.

---

## 5. Verify the release

Go to `github.com/syaifulazham/eptim-bridge-control/releases`

A new release named `vX.X.X` will appear with these assets attached:
- `Eptim Bridge Control-X.X.X.dmg` (macOS)
- `Eptim Bridge Control Setup X.X.X.exe` (Windows)
- `latest-mac.yml` and `latest.yml` (auto-updater manifests)

---

## 6. Existing users get the update automatically

Users who already have the app installed will be notified via the in-app update banner within ~12 seconds of launching the app. They click **Download** then **Restart & Install** — no manual download needed.

---

## If the Actions build fails

1. Click the failed job on the Actions page to read the error log
2. Fix the issue in your local code
3. Delete the broken tag:
   ```bash
   git push origin --delete vX.X.X
   git tag -d vX.X.X
   ```
4. Start again from Step 1 (no need to re-bump the version)

Alternatively, trigger a re-run manually from the Actions tab without touching tags:  
**Actions → Release → Run workflow → Run workflow**

---

## Quick reference

| Task | Command |
|---|---|
| Patch release | `npm version patch && git push --follow-tags` |
| Minor release | `npm version minor && git push --follow-tags` |
| Major release | `npm version major && git push --follow-tags` |
| Manual workflow trigger | GitHub → Actions → Release → Run workflow |
| Delete a bad tag | `git push origin --delete vX.X.X && git tag -d vX.X.X` |
