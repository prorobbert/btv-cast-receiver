# Budget Thuis TV — Cast receiver

A **fully custom** CAF web receiver: no `<cast-media-player>`, no SDK-supplied player. The page owns a
plain `<video>` and a [Shaka Player](https://github.com/shaka-project/shaka-player) instance; the Cast
SDK is kept only as the protocol layer.

```
sender (phone / Google Home / remote)
        │  LOAD, PLAY, PAUSE, SEEK, STOP, EDIT_TRACKS_INFO, SET_PLAYBACK_RATE
        ▼
CAF SDK ── message interceptors ──▶ receiver.js ──▶ shaka.Player ──▶ <video>
        ◀── MediaStatus ─────────────────────────────────────────────┘
```

Two `CastReceiverOptions` make the split:

| option | effect |
| --- | --- |
| `skipPlayersLoad = true` | the SDK loads neither MPL nor a Shaka build of its own |
| `mediaElement = video` | the SDK still reads volume, mute, playback state and idle detection off our element, so MediaStatus keeps working |

Everything else the SDK's player used to do is done here by hand: manifest loading and DRM, acting on
transport messages, publishing duration / stream type / track list, track selection, and the UI.

## Files

| file | what it is |
| --- | --- |
| `index.html` | SDK + Shaka script tags, the `<video>`, and the overlay markup |
| `receiver.js` | the whole receiver |
| `styles.css` | the STB player design (Figma node `14027:9824`, 960×540 board) |
| `version.js` | build stamp, rewritten by `deploy.sh` |
| `deploy.sh` | stamps the build and runs `netlify deploy --prod` |

Both the CAF SDK and Shaka load from a CDN, never from this origin: a self-hosted copy served as
`text/plain` is what killed an earlier build (Chromium refuses it under `nosniff`, `cast` stays
undefined, and the session dies on the ~60 s `CastInitTimeout` watchdog).

Shaka is pinned to the **4.15** line on purpose — that is the line Google ships inside CAF itself
(`4.15.56` is the SDK default, and it accepts `>=4.15.56 <5.0.0`), so it is the line actually exercised
on Cast hardware.

## The load request

Everything receiver-specific rides on `media.customData`.

```jsonc
{
  "media": {
    "contentId": "https://cdn.example/stream.mpd",
    "contentType": "application/dash+xml",
    "streamType": "LIVE",
    "metadata": {
      "metadataType": 0,
      "title": "Het perfecte plaatje",
      "subtitle": "NPO2 • Amusement • Realitieserie",
      "images": [{ "url": "https://cdn.example/npo2.png" }]
    },
    "customData": {
      "drm": {
        "protectionSystem": "widevine",
        "licenseUrl": "https://licence.example/widevine",
        "headers": { "X-AxDRM-Message": "…" }
      },
      "headers": { "X-Cdn-Token": "…" },
      "startAtLiveEdge": true,
      "section": { "startTimeInMedia": 0, "duration": 6840 },
      "debug": false
    }
  },
  "autoplay": true,
  "currentTime": 0,
  "activeTrackIds": []
}
```

### `customData.drm`

| field | meaning |
| --- | --- |
| `protectionSystem` | `widevine` (default), `playready`, `fairplay`, `clearkey` |
| `licenseUrl` | licence server for that system |
| `servers` | `{ keySystem: url }`, for manifests carrying more than one system |
| `headers` | sent on **licence** requests only |
| `videoRobustness` / `audioRobustness` | e.g. `HW_SECURE_ALL` / `HW_SECURE_CRYPTO`; empty lets EME negotiate |
| `persistentState` | `persistentStateRequired` on the EME session |
| `withCredentials` | send cookies with the licence request |

Cast hardware is Widevine (L1 on anything current). PlayReady only exists on Android TV boxes that
ship it. Omit `drm` entirely for a clear stream.

Naming a robustness level is worth doing when the licence server refuses L3: without it EME may
negotiate a session the server then rejects, which surfaces as a licence error rather than a
capability error and is miserable to diagnose.

### The rest

- `customData.headers` — added to **manifest and segment** requests (deliberately not the same bucket
  as the licence headers: a licence token should not end up in every CDN edge log).
- `customData.shaka` — an object merged straight into `player.configure()`, for per-stream tuning.
- `customData.startAtLiveEdge` — force the live edge even when the request carries a `currentTime`.
- `customData.section` — `{ startTimeInMedia, duration }`. The seek bar measures the broadcast rather
  than the DVR window when this is set; otherwise it falls back to Shaka's seekable range.
- `customData.debug: true` — shows the SDK debug overlay. `?debug=1` on the receiver URL does the same.

## Tracks

Text tracks are published with Shaka's own ids. Audio is published **per language** (id `100000 + n`)
rather than per variant, so a sender does not list "Nederlands" three times because the manifest
carries three bitrates of it. `EDIT_TRACKS_INFO` maps straight back.

Cues render into `#captions` via Shaka's `UITextDisplayer`, not into the element's native track list,
so the design's type applies instead of the platform's caption settings.

## Testing on a device

The receiver only fully starts on real Cast hardware — `context.start()` waits for the cast platform,
so a desktop browser will not get past the logo screen. Load with `?debug=1`, or send
`customData.debug: true`, and watch the overlay for:

1. `shaka <version> attached` — the CDN build loaded and `isBrowserSupported()` passed.
2. `LOAD <url>` then `DRM configured` / `no DRM in customData`.
3. `loaded — live|vod, N track(s)`.
4. `WARNING: media element emptied while an asset was loaded` — this should **never** appear. It is the
   canary for the SDK taking the element back from Shaka; if it shows up, that is the first thing to
   chase.
