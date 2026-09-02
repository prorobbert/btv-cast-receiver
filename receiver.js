/*
 * Budget Thuis TV — Cast receiver.
 *
 * Three jobs, in order of how badly the sender needs them:
 *
 *  1. DRM. The senders put the Axinom license url and its `X-AxDRM-Message` header in `customData.drm`;
 *     without translating that into a PlaybackConfig no protected stream plays at all. This part must
 *     stay byte-compatible with the deployed receivers, so a sender build that works here also works
 *     against test/acc/prod.
 *  2. Live edge. CAF reads a `currentTime` of 0 on a live stream as "the start of the DVR window", which
 *     is up to two hours in the past. The sender cannot express "this item's own default position", so
 *     the interceptor here resolves it instead.
 *  3. Two screens. Playback gets the HUD from the STB player designs. Everything else — launching, idle,
 *     loading, stopped, blocked, an error — gets the logo, centred, with no caption. Deliberately
 *     coarse: this is the simplified first version, and a wrong label on a television is worse than
 *     none. The finer states are drawn in Figma and can be split out later.
 *
 * No build step: CAF is a runtime SDK and this is three static files.
 */

const body = document.body;
const params = new URLSearchParams(location.search);

/** What `body[data-state]` can hold. The stylesheet keys the two screens off these. */
const State = {
  Logo: "logo",
  Playing: "playing",
  Paused: "paused",
  Seeking: "seeking",
  Buffering: "buffering",
};

/**
 * The SDK's `messages.PlayerState` values are these exact strings. Comparing strings rather than enum
 * references keeps the render path usable in preview mode, where the Cast SDK does not exist.
 */
const PlayerState = { Playing: "PLAYING", Paused: "PAUSED", Buffering: "BUFFERING" };

/** The checklist's idle disconnect, and the paused one CAF does not enforce for us. */
const IdleDisconnectSeconds = 5 * 60;
const DebugIdleDisconnectSeconds = 60 * 60;
const PausedDisconnectMs = 20 * 60 * 1000;

/* --- logging --------------------------------------------------------------------------------- */

const LogTag = "BTV";

/** Loud version of `log`, so a swallowed exception still reaches the CaC tool and the overlay. */
function logError(message, error) {
  try {
    console.error(`[btv] ${message}`, error);
    const logger = window.cast?.debug?.CastDebugLogger?.getInstance?.();
    if (logger) logger.error(LogTag, `${message}: ${error && error.message ? error.message : error}`);
  } catch (nested) {
    // See log(): there is nowhere left to report to.
  }
}

/**
 * Everything goes through the Cast Debug Logger as well as the console.
 *
 * The receiver's console output does not reach `adb logcat` — it runs in a web runtime, not in an
 * Android app's log stream — so a console-only log is invisible on a device. The debug logger is what
 * the CaC tool (casttool.appspot.com/cactool) reads remotely, and what the on-screen overlay draws.
 */
function log(message, detail) {
  /*
   * Every line of this is inside the guard on purpose. The previous version serialised `detail`
   * outside it, and `log()` is the first statement in the LOAD interceptor — CAF fails a load whose
   * interceptor throws, which is exactly what a device pass produced: LOAD_FAILED with no media
   * pipeline ever starting. Logging must never be able to break playback.
   */
  try {
    if (detail === undefined) console.log(`[btv] ${message}`);
    else console.log(`[btv] ${message}`, detail);

    const logger = window.cast?.debug?.CastDebugLogger?.getInstance?.();
    if (!logger) return;

    let text = message;
    try {
      if (detail !== undefined) text = `${message} ${JSON.stringify(detail)}`;
    } catch (error) {
      text = `${message} <undescribable detail>`;
    }
    logger.info(LogTag, text);
  } catch (error) {
    // Nothing to do: there is by definition no way to report a failure in the reporting path.
  }
}

/* --- build stamp ---------------------------------------------------------------------------- */

const build = window.BTV_BUILD || {};
const buildLine = document.getElementById("build");
if (buildLine && build.stamped) buildLine.textContent = `${build.stamped} · ${build.commit}`;

/* --- state ---------------------------------------------------------------------------------- */

let pausedDisconnectTimer = null;
let stopReceiver = () => {};

/** True from a LOAD request until the media session ends: is there a picture to protect? */
let mediaRequested = false;

/**
 * The chrome (scrim, control, HUD) shows whenever something changes and fades after five undisturbed
 * playing seconds — the STB player's behaviour. Paused, seeking and buffering keep it up: those are
 * exactly the moments a viewer is looking for confirmation.
 */
let uiHideTimer = null;

function showChrome() {
  body.dataset.ui = "shown";
  clearTimeout(uiHideTimer);
  uiHideTimer = null;
}

/**
 * Arms the fade once and leaves it armed: rendering runs on every PlayerData tick — a second at most
 * between them — and a timer that any tick can reset never fires. The timer checks the state again
 * when it lands, so a pause during the five seconds keeps the chrome up.
 */
function armChromeFade() {
  if (uiHideTimer) return;
  uiHideTimer = setTimeout(() => {
    uiHideTimer = null;
    if (body.dataset.state === State.Playing) {
      body.dataset.ui = "hidden";
      log("chrome hidden after undisturbed playback");
    }
  }, 5000);
}

function setState(state) {
  if (body.dataset.state === state) {
    if (state === State.Playing) armChromeFade();
    else if (body.dataset.ui !== "shown") showChrome();
    return;
  }

  log(`state ${body.dataset.state} → ${state}`);
  body.dataset.state = state;
  showChrome();
  if (state === State.Playing) armChromeFade();
  if (state === State.Paused) dumpOverlayDiagnostics("paused");

  clearTimeout(pausedDisconnectTimer);
  if (state === State.Paused) {
    pausedDisconnectTimer = setTimeout(() => {
      log("paused for 20 minutes, stopping the receiver");
      stopReceiver();
    }, PausedDisconnectMs);
  }
}

/* --- the screens ---------------------------------------------------------------------------- */

const ui = {
  title: document.getElementById("title"),
  subtitle: document.getElementById("subtitle"),
  artwork: document.getElementById("artwork"),
  position: document.getElementById("position"),
  duration: document.getElementById("duration"),
  progress: document.getElementById("progress"),
  buffer: document.getElementById("buffer"),
  handle: document.getElementById("handle"),
};

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = value => String(value).padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/**
 * Maps PlayerData onto the two screens. `state` alone is not enough: seeking is a flag on top of
 * playing or buffering and it has to win, because a viewer who just moved the scrubber needs to see
 * that the receiver took it.
 */
function renderPlayerData(data) {
  if (!data) return;

  const state = resolveState(data);
  if (state === State.Logo) {
    setState(State.Logo);
    return;
  }

  ui.title.textContent = data.title ?? "";
  ui.subtitle.textContent = data.subtitle ?? "";

  const artwork = data.thumbnailUrl ?? "";
  body.dataset.hasArtwork = String(Boolean(artwork));
  if (artwork && ui.artwork.getAttribute("src") !== artwork) ui.artwork.setAttribute("src", artwork);

  renderProgress(data);
  setState(state);
}

/**
 * A live channel has no duration to measure against — `duration` comes back as infinite or absent, so
 * dividing by it pinned the handle at zero while the clock read 2:10:23. What a live stream does have
 * is the seekable range the receiver reports, which is also the coordinate system the phone's scrubber
 * works in: positions measured from the start of the DVR window.
 */
function renderProgress(data) {
  const position = Number(data.currentTime);
  const live = Boolean(data.isLive);

  /*
   * What the bar measures, in order of preference (the design's comment: "progress from start time of
   * the broadcast to the end time of it"):
   *
   *  1. The broadcast section the sender attaches to live items (sectionStartTimeInMedia +
   *     sectionDuration) — the programme, not the stream.
   *  2. The receiver's live seekable range — a live stream with no section metadata; at least the DVR
   *     window is honest.
   *  3. The item's duration — recordings and VOD.
   */
  const sectionStart = Number(data.sectionStartTimeInMedia);
  const sectionDuration = Number(data.sectionDuration);
  const range = data.liveSeekableRange;

  let start = 0;
  let end = Number(data.duration);
  if (live && Number.isFinite(sectionStart) && sectionDuration > 0) {
    start = sectionStart;
    end = sectionStart + sectionDuration;
  } else if (live && range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
    start = Number(range.start);
    end = Number(range.end);
  }
  const span = end - start;

  ui.position.textContent = formatTime(position - start);
  ui.duration.textContent = Number.isFinite(span) && span > 0 ? formatTime(span) : "--:--";

  const clamp = value => Math.min(1, Math.max(0, value));
  const fraction = Number.isFinite(span) && span > 0 ? clamp((position - start) / span) : 0;
  const percent = `${fraction * 100}%`;
  ui.progress.style.width = percent;
  ui.handle.style.left = percent;

  /*
   * The buffered region comes off the SDK's own <video>, reachable because the shadow root is open.
   * PlayerData does not carry it, and the design distinguishes played (green), buffered (dark) and
   * unbuffered (light) — three bands, not two.
   */
  const bufferedEnd = bufferedEndFor(position);
  const bufferFraction = Number.isFinite(span) && span > 0 && bufferedEnd !== null
    ? clamp((bufferedEnd - start) / span)
    : fraction;
  ui.buffer.style.width = `${Math.max(bufferFraction, fraction) * 100}%`;
}

/** End of the buffered range containing the playhead, in media time; null when unknowable. */
function bufferedEndFor(position) {
  try {
    const video = document.querySelector("cast-media-player")?.shadowRoot?.getElementById("castMediaElement");
    const ranges = video && video.buffered;
    if (!ranges || !ranges.length) return null;
    for (let i = 0; i < ranges.length; i += 1) {
      if (position >= ranges.start(i) && position <= ranges.end(i)) return ranges.end(i);
    }
    return ranges.end(ranges.length - 1);
  } catch (error) {
    return null;
  }
}

let seekingTicks = 0;
let bufferingSince = 0;

function resolveState(data) {
  /*
   * isSeeking can flicker for a single PlayerData tick during live playback (the SDK's own live-edge
   * corrections). One tick must not re-show the chrome, or it never fades; a viewer-initiated seek
   * holds the flag across ticks and still reads as seeking.
   */
  seekingTicks = data.isSeeking ? seekingTicks + 1 : 0;
  if (data.state !== PlayerState.Buffering) bufferingSince = 0;
  if (seekingTicks >= 2) return State.Seeking;
  if (data.state === PlayerState.Playing) return State.Playing;
  if (data.state === PlayerState.Paused) return State.Paused;
  if (data.state === PlayerState.Buffering) {
    /*
     * Live playback flaps PLAYING<->BUFFERING around the edge. Surfacing every flap re-showed the
     * chrome each time, so it never reached its five quiet seconds — and the checklist wants a
     * buffering indicator only after a few seconds anyway. A rebuffer straight from playing stays
     * invisible for 1.5s; the very first buffer (nothing played yet) still shows immediately.
     */
    if (!bufferingSince) bufferingSince = Date.now();
    const previous = body.dataset.state;
    const briefly = Date.now() - bufferingSince < 1500;
    if (briefly && (previous === State.Playing || previous === State.Paused)) return previous;
    return State.Buffering;
  }
  bufferingSince = 0;

  /*
   * Anything else — IDLE, LOADING, a value this build does not know — means the receiver is not
   * telling us what it is doing, which is not the same as buffering. Reporting it as buffering parked
   * a spinner on screen permanently during a device pass. So: before any media, the logo; once an item
   * is on its way, a spinner *until something plays*; after that, hold the last real state rather than
   * flashing a spinner over a picture that is fine.
   *
   * The logo screen is opaque, which is why it must not be the answer here: painting it over a media
   * element that has already decoded a frame shows the picture and then hides it again.
   */
  if (!mediaRequested) return State.Logo;
  return body.dataset.state === State.Logo ? State.Buffering : body.dataset.state;
}

/* --- load interception ---------------------------------------------------------------------- */

/**
 * Ports the deployed receivers' contract verbatim: `media.customData.drm` first, request-level
 * `customData.drm` as the fallback, `{ licenseUrl, headers }` inside. Widevine is implied — there is no
 * `protectionSystem` field, so this is deliberately *not* Google's `exoPlayerConfig` convention, and the
 * `customData.exoPlayerConfig` media3's converter also emits is ignored here exactly as it is there.
 */
function applyDrmConfiguration(playerManager, request) {
  const drm = request?.media?.customData?.drm ?? request?.customData?.drm;

  if (!drm?.licenseUrl) {
    log("no DRM config in customData — treating this as a clear stream");
    return;
  }

  const playbackConfig = new cast.framework.PlaybackConfig();
  playbackConfig.licenseUrl = drm.licenseUrl;
  playbackConfig.licenseRequestHandler = requestInfo => {
    requestInfo.headers = requestInfo.headers || {};
    Object.entries(drm.headers ?? {}).forEach(([key, value]) => {
      requestInfo.headers[key] = value;
    });
    log("license request", { url: requestInfo.url, headers: Object.keys(requestInfo.headers) });
  };

  playerManager.setPlaybackConfig(playbackConfig);
  log("DRM configured", { licenseUrl: drm.licenseUrl, headers: Object.keys(drm.headers ?? {}) });
}

/**
 * Resolves a live stream's start position receiver-side.
 *
 * media3's RemoteCastPlayer turns "no position" into `currentTime = 0`, and CAF reads 0 on a live stream
 * as the start of the DVR window — so a channel switch lands however far back that window reaches
 * instead of at the live edge, which is where local playback starts. Deleting `currentTime` lets CAF
 * apply its own live default. A position the viewer actually chose (a time-shifted broadcast they were
 * watching on the phone) is left alone; `customData.startAtLiveEdge` lets the sender say outright that
 * the position it sent carries no intent, so this never has to infer that from a bare 0.
 */
function resolveLiveStartPosition(request) {
  if (request?.media?.streamType !== "LIVE") return;

  const requestedLiveEdge = request.media.customData?.startAtLiveEdge === true;
  const carriesPosition = Number.isFinite(request.currentTime) && request.currentTime > 0;

  if (requestedLiveEdge || !carriesPosition) {
    log("live item without a chosen position — letting CAF start at the live edge", {
      currentTime: request.currentTime,
      startAtLiveEdge: requestedLiveEdge,
    });
    delete request.currentTime;
  } else {
    log("live item with a chosen position, passing it through", { currentTime: request.currentTime });
  }
}

/* --- the player element's shadow root ------------------------------------------------------- */

/**
 * Hides CAF's own chrome from inside its shadow root.
 *
 * `<cast-media-player>` opens its shadow root with `attachShadow({mode: "open"})`, so a stylesheet can
 * be appended to it from here — the one way to restyle those parts, since page CSS cannot cross a
 * shadow boundary and only a handful of custom properties are exposed. The root holds:
 *
 *   .background  .mediaElement (the video)  .logo  .spinner  .splash  .slideshow
 *   <tv-overlay-placeholder>   <- the platform draws its own media UI in here
 *
 * Everything but the video goes, so this page owns every pixel while the SDK keeps owning playback.
 * The placeholder is included deliberately: that is the surface that appeared as a stock casting
 * screen on pause.
 */
const ShadowStyles = `
  /*
   * tv-overlay is included alongside its placeholder deliberately: the platform *replaces* the
   * placeholder with a live <tv-overlay> element when it wants to draw its media controls, so hiding
   * only the placeholder stops mattering the moment the overlay actually appears. A stylesheet in the
   * shadow root matches elements created later, which is what makes this hold.
   */
  .background, .logo, .spinner, .splash, .slideshow, tv-overlay-placeholder, tv-overlay {
    display: none !important;
  }
  #castPlayer, .foreground { background: #0e0e0e !important; }
  .mediaElement { object-fit: contain !important; }
`;

/**
 * Asks the platform outright not to draw its media-controls overlay. `ui.Controls` carries the levers
 * for the Google TV overlay (`setDcVisibility`, `setScrubberVisibility`); hiding <tv-overlay> in the
 * shadow root is the belt, this is the braces. All guarded — the API surface varies per device
 * generation and none of it may break playback.
 */
function suppressPlatformControls() {
  try {
    const controls = cast.framework.ui.Controls.getInstance();
    if (typeof controls.setDcVisibility === "function") controls.setDcVisibility(false);
    if (typeof controls.setScrubberVisibility === "function") controls.setScrubberVisibility(false);
    log("platform controls suppressed", {
      hasOverlay: typeof controls.hasMediaControlsOverlay === "function" ? controls.hasMediaControlsOverlay() : "?",
    });
  } catch (error) {
    logError("could not suppress platform controls", error);
  }
}

/**
 * One log line that settles where the pause overlay comes from. If `shadowTvOverlay` exists with
 * display none while the overlay is still visible on screen, the platform draws it natively outside
 * the page — no receiver CSS can touch it, and suppression has to come from the platform APIs or be
 * accepted. If it exists with any other display, our stylesheet lost.
 */
function dumpOverlayDiagnostics(reason) {
  try {
    const context = cast.framework.CastReceiverContext.getInstance();
    const controls = cast.framework.ui.Controls.getInstance();
    const root = document.querySelector("cast-media-player")?.shadowRoot;
    const overlay = root && root.querySelector("tv-overlay");
    log(`overlay diagnostics (${reason})`, {
      mediaControlsState: typeof context.getMediaControlsState === "function" ? context.getMediaControlsState() : "?",
      hasMediaControlsOverlay:
        typeof controls.hasMediaControlsOverlay === "function" ? controls.hasMediaControlsOverlay() : "?",
      shadowTvOverlay: overlay ? getComputedStyle(overlay).display : "absent",
      ourStyleTag: Boolean(root && root.getElementById("btv-shadow-styles")),
    });
  } catch (error) {
    logError("overlay diagnostics failed", error);
  }
}

function styleCastPlayer() {
  const player = document.querySelector("cast-media-player");
  const root = player && player.shadowRoot;
  if (!root) return false;
  if (root.getElementById("btv-shadow-styles")) return true;

  const style = document.createElement("style");
  style.id = "btv-shadow-styles";
  style.textContent = ShadowStyles;
  root.appendChild(style);
  log("player chrome hidden inside the shadow root");
  return true;
}

/**
 * The element upgrades asynchronously, so the shadow root may not exist yet on first paint. Retry
 * briefly rather than assume, and stop as soon as it takes.
 */
function styleCastPlayerWhenReady(attemptsLeft = 40) {
  try {
    if (styleCastPlayer() || attemptsLeft <= 0) return;
  } catch (error) {
    logError("could not style the player's shadow root", error);
    return;
  }
  setTimeout(() => styleCastPlayerWhenReady(attemptsLeft - 1), 50);
}

/* --- receiver ------------------------------------------------------------------------------- */

/**
 * Debug logging, in two halves.
 *
 * The logger itself is always on, because it is the only way to read this receiver: its console output
 * does not reach `adb logcat` (it runs in a web runtime, not an Android app), and the Google TV
 * Streamer exposes no DevTools, so `chrome://inspect` never lists the page. What the logger *does*
 * reach is the CaC tool — casttool.appspot.com/cactool — which attaches over the network and shows
 * these messages live, filtered by tag.
 *
 * The on-screen overlay is the other half, and stays off unless asked for with `?debug=1` or
 * `customData.debug`: it covers the UI it is meant to help evaluate.
 */
function startDebugLogger(overlayRequested) {
  const logger = window.cast?.debug?.CastDebugLogger?.getInstance?.();
  if (!logger) return;

  logger.setEnabled(true);
  logger.loggerLevelByEvents = {
    "cast.framework.events.category.CORE": cast.framework.LoggerLevel.INFO,
    "cast.framework.events.EventType.MEDIA_STATUS": cast.framework.LoggerLevel.DEBUG,
  };
  logger.loggerLevelByTags = { [LogTag]: cast.framework.LoggerLevel.DEBUG };

  if (overlayRequested) showDebugOverlay();
}

/** Draws the log on the television. Only on request — it covers the picture. */
function showDebugOverlay() {
  const logger = window.cast?.debug?.CastDebugLogger?.getInstance?.();
  if (!logger || body.dataset.debug === "true") return;

  logger.setEnabled(true);
  logger.showDebugLogs(true);
  body.dataset.debug = "true";
  log("debug overlay enabled");
}

function startReceiver(debugRequested) {
  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();
  const { messages, events, system, ui: castUi } = cast.framework;

  stopReceiver = () => context.stop();

  /*
   * ANY_CHANGE hands the handler the *changed field's* value — a number, a string — not the whole
   * PlayerData. Passing that straight to the renderer meant `state` was never a player state, so the
   * receiver sat on the logo screen while audio played. The binder's own accessor is the whole object.
   */
  const binder = new castUi.PlayerDataBinder(new castUi.PlayerData());
  binder.addEventListener(castUi.PlayerDataEventType.ANY_CHANGE, () => {
    try {
      renderPlayerData(binder.getPlayerData());
    } catch (error) {
      logError("rendering player data failed", error);
    }
  });

  /*
   * CAF turns an exception here into LOAD_FAILED and never starts the pipeline, so the whole body is
   * guarded and the request is handed back either way. A load that plays without our DRM or live-edge
   * handling is a visible, diagnosable problem; a load that never happens looks like a dead receiver.
   */
  playerManager.setMessageInterceptor(messages.MessageType.LOAD, request => {
    try {
      log("LOAD", {
        contentId: request?.media?.contentId,
        contentType: request?.media?.contentType,
        streamType: request?.media?.streamType,
        currentTime: request?.currentTime,
        drm: Boolean(request?.media?.customData?.drm?.licenseUrl),
        startAtLiveEdge: request?.media?.customData?.startAtLiveEdge === true,
      });

      if (request?.media?.customData?.debug === true) showDebugOverlay();

      applyDrmConfiguration(playerManager, request);
      resolveLiveStartPosition(request);
      suppressPlatformControls();

      mediaRequested = true;
      setState(State.Buffering); // a picture is on its way, so do not cover it with the logo
    } catch (error) {
      logError("the load interceptor failed — passing the request through untouched", error);
      mediaRequested = true;
    }
    return request;
  });

  playerManager.addEventListener(events.EventType.ERROR, event => {
    // detailedErrorCode is the number worth quoting in a bug report; 905 is a failed load, 201/203 are
    // license failures. See developers.google.com/cast/docs/web_receiver/error_codes.
    logError(`player error code=${event?.detailedErrorCode} reason=${event?.reason}`, event?.error);
    mediaRequested = false;
    setState(State.Logo);
  });

  playerManager.addEventListener(events.EventType.MEDIA_FINISHED, () => {
    mediaRequested = false;
    setState(State.Logo);
  });

  context.addEventListener(system.EventType.READY, () => {
    log("receiver ready", { build: build.stamped || "unstamped", commit: build.commit || "-" });
    startDebugLogger(debugRequested);
    styleCastPlayer();
    suppressPlatformControls();
    setState(State.Logo);
  });

  // The platform announces its overlay too; log it so a stray overlay is attributable.
  context.addEventListener("showmediacontrols", event => {
    log("platform requested media controls", { state: event && event.mediaControlsState });
    dumpOverlayDiagnostics("showmediacontrols");
  });

  context.addEventListener(system.EventType.SENDER_CONNECTED, event => log("sender connected", event.senderId));
  context.addEventListener(system.EventType.SENDER_DISCONNECTED, event =>
    log("sender disconnected", event.senderId)
  );

  context.addEventListener(system.EventType.SHUTDOWN, () => {
    log("shutting down");
    mediaRequested = false;
    setState(State.Logo);
  });

  /*
   * Our live streams have a DVR window, so pausing and seeking one is legitimate; without saying so the
   * receiver advertises neither command and the phone's scrubber has nothing to talk to.
   */
  playerManager.setSupportedMediaCommands(
    messages.Command.PAUSE |
      messages.Command.SEEK |
      messages.Command.STREAM_VOLUME |
      messages.Command.STREAM_MUTE |
      messages.Command.EDIT_TRACKS
  );

  if (debugRequested) context.setLoggerLevel(cast.framework.LoggerLevel.DEBUG);

  context.start({
    // The checklist's five-minute idle disconnect. A debug session gets to sit still while being read.
    maxInactivity: debugRequested ? DebugIdleDisconnectSeconds : IdleDisconnectSeconds,
  });
}

/* --- preview -------------------------------------------------------------------------------- */

/**
 * `?preview=<state>` renders a screen in a normal browser, no Cast device involved. The device we
 * develop against has no DevTools, so iterating on these locally is the difference between a design
 * pass and a deploy-and-squint loop.
 */
const PreviewData = {
  [State.Playing]: {
    state: PlayerState.Playing,
    title: "NOS Journaal",
    subtitle: "NPO 2 • 20:00 - 20:25",
    currentTime: 620,
    duration: 1500,
  },
  [State.Paused]: {
    state: PlayerState.Paused,
    title: "Zomergasten",
    subtitle: "NPO 2 • Opname",
    currentTime: 2400,
    duration: 10800,
  },
  [State.Seeking]: {
    state: PlayerState.Playing,
    isSeeking: true,
    title: "Zomergasten",
    subtitle: "NPO 2 • Opname",
    currentTime: 5400,
    duration: 10800,
  },
  [State.Buffering]: {
    state: PlayerState.Buffering,
    title: "NOS Journaal",
    subtitle: "NPO 2 • 20:00 - 20:25",
    currentTime: 620,
    duration: 1500,
  },
};

function startPreview(state) {
  log(`preview mode: ${state}`);
  body.dataset.preview = "true";

  const data = PreviewData[state];
  if (data) renderPlayerData(data);
  else setState(State.Logo);
}

/* --- entry point ---------------------------------------------------------------------------- */

const previewState = params.get("preview");
const debugRequested = params.get("debug") === "1";

styleCastPlayerWhenReady();

if (previewState) {
  startPreview(previewState);
} else if (window.cast?.framework?.CastReceiverContext) {
  startReceiver(debugRequested);
} else {
  // Opened outside a Cast environment without asking for a preview: the logo screen is honest here.
  log("the Cast SDK is unavailable — append ?preview=<state> to render a screen locally");
  setState(State.Logo);
}
