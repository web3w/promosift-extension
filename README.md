# PromoSift extension

A browser extension that detects hard ads, soft ads, and lead-generation content on X (Twitter). Fold or label ads, block content by keyword, and flag AI-generated text. Classification is provided by the PromoSift account service; this repository only contains the extension itself (`manifest.json`, background script, content script, and popup UI), not the account service, website, or admin backend source.

The extension's UI is available in English and Chinese, following the browser's language setting, and defaults to English.

## Features

- Detects hard ads, brand-partnered soft ads, and lead-generation content on X, with a choice of labeling only or folding matches.
- Blocks content by keyword, with optional meaning-based matching (e.g. "diet" also matches related phrasing).
- Flags the estimated share of AI-generated text in a post.
- Log in with an email code to use your account's credits; new accounts get a one-time free grant, plus a daily manual check-in for more.
- Right-click menu to classify selected text directly.

## Dependency on the account service

The extension itself performs no classification. Every check is sent to the account service configured in `config.json`'s `apiBase`. The default points to the official PromoSift service at `https://promosift.app`; if you're running your own backend, either implement a compatible API per the account service's contract, or use the official service.

If you're logged out, out of credits, or can't reach the service, the extension shows a clear status for that; it never fails silently or falls back to any offline classification.

## Loading locally

Requires Node.js 22 or newer.

```sh
npm install
npm run check   # static syntax check
npm test        # run unit tests
```

To load in Chrome or Edge:

1. Open `chrome://extensions` (or `edge://extensions`) and enable "Developer mode" in the top right.
2. Click "Load unpacked" and select this repository's root directory.
3. Pin the extension to the toolbar and log in with your email from the popup.
4. Refresh X (`x.com` or `twitter.com`).

After changing the source, reload the extension from the extensions page and refresh any open X tabs for the changes to take effect.

## Switching the account service address

Defaults to `https://promosift.app`. If you're running your own compatible backend (e.g. for local development), use:

```sh
npm run configure -- http://localhost:8787
```

This updates both `config.json`'s `apiBase` and `manifest.json`'s `host_permissions`. Production addresses must use HTTPS; only `localhost` / `127.0.0.1` are allowed over HTTP. Reload the extension after switching.

## Packaging

```sh
npm run package
```

The output lands in `.build/extension`, containing only the files needed to run the extension (`manifest.json`, `config.json`, scripts, styles, icons, and `_locales`) — no dev dependencies or test code. Run `npm run configure` first to make sure `config.json` points at the service address you intend to publish against.

## Localization

UI strings live in `_locales/en/messages.json` and `_locales/zh_CN/messages.json`, using the standard [Chrome extension i18n](https://developer.chrome.com/docs/extensions/reference/api/i18n) mechanism. `default_locale` is `en`; Chrome automatically serves the matching locale based on the browser's UI language and falls back to English otherwise. When adding a new user-facing string, add the key to both locale files — a test enforces that the two files define the same set of keys.

## Permissions

- `storage`: stores local settings (keywords, display mode, sensitivity) and the login session.
- `contextMenus`: provides the right-click "Check selected text with PromoSift" menu item.
- Host permissions are limited to the account service address (`apiBase` in `config.json`) and `x.com` / `twitter.com`, used for content script injection and classification requests. The extension does not request or access any other site.

## Privacy

The extension only runs on X pages. It sends the visible post text, author, quoted content, and the platform's own ad labels to the account service for classification; it does not collect or upload anything outside the page, and does not track browsing across other sites. For how the account service itself handles caching, retention, and third-party model calls, see that service's own privacy documentation.

## License

See [LICENSE](LICENSE).
