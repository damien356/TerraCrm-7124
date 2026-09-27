# Terra mobile: how changes reach the crew

Three ways a change can land. Before any mobile change, it gets classified as one
of these, and the category is stated before anything is published.

| # | Category | How it ships | Crew action | Store review |
|---|----------|--------------|-------------|--------------|
| 1 | Backend only | Deploy the web app | None, next refresh | No |
| 2 | OTA update | `eas update` | Reopen the app | No |
| 3 | Native rebuild | `eas build` then store | Install new version | Yes |

## 1. Backend only

Lives entirely in `packages/web`. The phone already knows how to ask for it.

- API logic, pricing rules, quote maths, validation
- Database columns and tables, migrations
- Who can see what (roles and permissions, server side)
- Push notification wording and when one fires
- Emails, SMS, supplier price imports
- Anything the app only ever displays from a server response

Nothing is sent to the phone. No app update of any kind. This is the cheapest
category and the one to prefer when there is a choice.

## 2. OTA update

JavaScript and React Native code inside `packages/mobile`. Shipped straight to
phones already running Terra, no store involvement.

- Screens, layouts, colours, fonts already bundled, copy, icons from a bundled set
- New screens and new routes
- New API calls to endpoints that already exist
- Bug fixes in app logic
- Images and assets added to `assets/`
- Anything in `app/`, `components/`, `lib/`, `queries/`, `constants/`

The phone downloads it in the background and applies it the next time the app is
opened cold. Nobody is interrupted mid job.

## 3. Native rebuild and store release

Anything that changes the compiled part of the app. These cannot go OTA, and the
tooling enforces it: the runtime version is a fingerprint of the native project,
so a native change produces a new fingerprint and old binaries are simply never
offered the update. A mismatched OTA cannot reach a phone that would crash on it.

- Installing a library with native code (`npx expo install` on anything with an
  iOS or Android module: camera, bluetooth, maps, biometrics, background tasks)
- Removing or upgrading such a library, including Expo SDK upgrades
- New permissions, or changing permission wording in `app.json`
- App name, icon, splash screen, bundle ID, package name, URL scheme
- Push notification setup changes at the native level
- Anything under `plugins` in `app.json`
- Bumping `expo.version`

Needs a new build, then a store submission and review. Assume days, not minutes,
for iOS.

## Channels

Three lanes. A build listens to exactly one, set by its build profile in
`eas.json`, so an update published to `preview` can never land on a crew phone
running the production build.

| Channel | Profile | Android output | Who has it |
|---------|---------|----------------|------------|
| `development` | `development` | APK, dev client | Dev machine only |
| `preview` | `preview` | APK, sideloadable | Testing, before crew |
| `production` | `production` | AAB, store | Crew and office |

## Publishing an update

Always test on `preview` first. It is the same code path production will take.

```bash
cd packages/mobile
eas update --branch preview     --message "what changed"
eas update --branch production  --message "what changed"
```

The message is not decoration. It is what shows in the update list when
something has gone wrong and the right version has to be identified fast.

**Anything risky goes out to a few phones first.** Everyone else keeps running
the previous update until the rollout is widened:

```bash
eas update --branch production --rollout-percentage 10 --message "what changed"
```

Widen it to everyone, or pull it back to nobody, without a republish:

```bash
eas update:edit               # raise the percentage
eas update:revert-update-rollout   # take the rollout back off
```

## Rolling back a bad production update

Fastest first. Check `eas update:list --branch production` to see what is live.

**Option A, back to the last good update.** Republishes a known good update so it
becomes the newest one:

```bash
eas update:republish --branch production --group <group-id-of-last-good>
```

**Option B, back to the store build.** Drops every OTA update and returns phones
to the JavaScript baked into the installed binary. Use when unsure which update
broke things, because the store build is known to work:

```bash
eas update:roll-back-to-embedded --branch production
```

Either way phones pick up the rollback on their next cold start, so tell the
crew to fully close and reopen Terra rather than waiting.

**Automatic safety net.** If an update is broken enough that the app cannot
start, `expo-updates` falls back to the previous working copy by itself. The Me
screen then reports it, and `currentUpdate().isEmergencyLaunch` is true.

## Which build is this phone on

Bottom of the Me tab shows version, channel and the update id, for example
`Terra 1.0.0 · production · update a1b2c3d4`. It reads `store build` when running
the binary's own JavaScript. Ask for that line first on any bug report, and use
it to confirm an update or a rollback actually landed.

## Ground rules

- Updates are staged in the background and applied on next cold start. The app is
  never reloaded under someone mid job, because a half-written note or an
  uploading photo is worth more than shipping an hour sooner.
- `fallbackToCacheTimeout` is 0, so the app never waits on the network at
  startup. Crew on a bad connection at a site open the app as fast as always.
- Production updates are not published without stating the category first.
- The upload keystore lives on Expo's servers and is the only key that can sign
  this package. Do not delete it.
