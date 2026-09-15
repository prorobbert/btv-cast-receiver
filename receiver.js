'use strict';

/*
 * Budget Thuis TV — Cast receiver.
 *
 * <cast-media-player> stays the engine: it loads and plays the media, answers PLAY/PAUSE/SEEK from the
 * remote and from senders, and broadcasts MediaStatus back to those senders — all automatically, the
 * same machinery Google's own receivers use. This file adds two things on top:
 *
 *   1. A LOAD interceptor for our DRM and live-edge handling.
 *   2. A custom skin. The player's built-in chrome is hidden inside its (open) shadow root, and a
 *      PlayerDataBinder drives our own DOM overlay — the STB player design. The engine still owns
 *      playback and sender messaging; we only draw.
 *
 * On a TV the receiver takes no touch input: the remote drives PlayerManager directly, so our overlay
 * is display-only. "User pauses on the receiver" means the remote's pause reaches PlayerManager, which
 * pauses and notifies senders itself — nothing for us to send by hand.
 */

const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();
const { messages, events, system, ui } = cast.framework;

const body = document.body;
const build = window.BTV_BUILD || {};

/* --- debug logger --------------------------------------------------------------------------- */

const castDebugLogger = cast.debug.CastDebugLogger.getInstance();
const LOG_TAG = 'BTV';
const debugRequested = new URLSearchParams(location.search).get('debug') === '1';

castDebugLogger.loggerLevelByEvents = {
  'cast.framework.events.category.CORE': cast.framework.LoggerLevel.INFO,
  'cast.framework.events.EventType.MEDIA_STATUS': cast.framework.LoggerLevel.DEBUG,
};
castDebugLogger.loggerLevelByTags = { [LOG_TAG]: cast.framework.LoggerLevel.DEBUG };

function log(message) {
  try {
    console.log(`[btv] ${message}`);
    castDebugLogger.info(LOG_TAG, message);
  } catch (error) {
    /* logging must never break playback */
  }
}

function showDebugOverlay() {
  try {
    castDebugLogger.setEnabled(true);
    castDebugLogger.showDebugLogs(true);
  } catch (error) {
    /* convenience only */
  }
}

/* --- hide the player's built-in chrome ------------------------------------------------------ */

/*
 * <cast-media-player> opens its shadow root (attachShadow({mode:"open"})), so a stylesheet appended
 * to it can hide the SDK's launch/idle chrome and leave only the <video>. Our overlay is drawn on top
 * in the light DOM. The platform's own system pause overlay is drawn by the OS above the WebView and
 * is not reachable from here — that is a Google TV behaviour, the same one every casting app gets.
 */
const SHADOW_STYLES = `
  .background, .logo, .spinner, .splash, .slideshow, tv-overlay-placeholder, tv-overlay {
    display: none !important;
  }
  #castPlayer, .foreground { background: #0e0e0e !important; }
  .mediaElement { object-fit: contain !important; }
`;

function styleCastPlayer() {
  const player = document.querySelector('cast-media-player');
  const root = player && player.shadowRoot;
  if (!root) return false;
  if (root.getElementById('btv-shadow-styles')) return true;
  const style = document.createElement('style');
  style.id = 'btv-shadow-styles';
  style.textContent = SHADOW_STYLES;
  root.appendChild(style);
  return true;
}

function styleCastPlayerWhenReady(attemptsLeft = 40) {
  if (styleCastPlayer() || attemptsLeft <= 0) return;
  setTimeout(() => styleCastPlayerWhenReady(attemptsLeft - 1), 50);
}

/* --- the custom UI -------------------------------------------------------------------------- */

const State = {
  Logo: 'logo',
  Playing: 'playing',
  Paused: 'paused',
  Seeking: 'seeking',
  Buffering: 'buffering',
};

const el = {
  title: document.getElementById('title'),
  subtitle: document.getElementById('subtitle'),
  artwork: document.getElementById('artwork'),
  position: document.getElementById('position'),
  duration: document.getElementById('duration'),
  progress: document.getElementById('progress'),
  buffer: document.getElementById('buffer'),
  handle: document.getElementById('handle'),
  buildLine: document.getElementById('build'),
};

if (el.buildLine && build.stamped) el.buildLine.textContent = `${build.stamped} · ${build.commit}`;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = v => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

let uiHideTimer = null;
function showChrome() {
  body.dataset.ui = 'shown';
  clearTimeout(uiHideTimer);
  uiHideTimer = null;
}
function armChromeFade() {
  if (uiHideTimer) return;
  uiHideTimer = setTimeout(() => {
    uiHideTimer = null;
    if (body.dataset.state === State.Playing) body.dataset.ui = 'hidden';
  }, 5000);
}

function setState(state) {
  if (body.dataset.state === state) {
    if (state === State.Playing) armChromeFade();
    else if (body.dataset.ui !== 'shown') showChrome();
    return;
  }
  log(`state ${body.dataset.state} → ${state}`);
  body.dataset.state = state;
  showChrome();
  if (state === State.Playing) armChromeFade();
}

let seekingTicks = 0;
let bufferingSince = 0;

function resolveState(data) {
  seekingTicks = data.isSeeking ? seekingTicks + 1 : 0;
  if (data.state !== 'BUFFERING') bufferingSince = 0;

  // A live pause reports PAUSED with isSeeking flickering true; paused must win over the seek heuristic.
  if (data.state === 'PAUSED') return State.Paused;
  if (seekingTicks >= 2) return State.Seeking;
  if (data.state === 'PLAYING') return State.Playing;
  if (data.state === 'BUFFERING') {
    // Live playback flaps PLAYING<->BUFFERING at the edge; a brief flap keeps the last visible state.
    if (!bufferingSince) bufferingSince = Date.now();
    const brief = Date.now() - bufferingSince < 1500;
    const prev = body.dataset.state;
    if (brief && (prev === State.Playing || prev === State.Paused)) return prev;
    return State.Buffering;
  }
  // IDLE / LOADING / unknown: logo only when nothing is on its way, else hold the last state.
  return body.dataset.state && body.dataset.state !== State.Logo ? body.dataset.state : State.Logo;
}

function renderProgress(data) {
  const position = Number(data.currentTime);

  /*
   * The bar measures the broadcast, per the design: prefer the section the sender attaches
   * (sectionStartTimeInMedia + sectionDuration), then the live seekable range, then item duration.
   */
  const sectionStart = Number(data.sectionStartTimeInMedia);
  const sectionDuration = Number(data.sectionDuration);
  const range = data.liveSeekableRange;

  let start = 0;
  let end = Number(data.duration);
  if (data.isLive && Number.isFinite(sectionStart) && sectionDuration > 0) {
    start = sectionStart;
    end = sectionStart + sectionDuration;
  } else if (data.isLive && range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
    start = Number(range.start);
    end = Number(range.end);
  }
  const span = end - start;
  const clamp = v => Math.min(1, Math.max(0, v));
  const fraction = Number.isFinite(span) && span > 0 ? clamp((position - start) / span) : 0;
  const percent = `${fraction * 100}%`;

  el.position.textContent = formatTime(position - start);
  el.duration.textContent = Number.isFinite(span) && span > 0 ? formatTime(span) : '--:--';
  el.progress.style.width = percent;
  el.handle.style.left = percent;
  el.buffer.style.width = percent;
}

function renderPlayerData(data) {
  if (!data) return;
  try {
    const state = resolveState(data);
    if (state === State.Logo) {
      setState(State.Logo);
      return;
    }
    body.dataset.live = String(Boolean(data.isLive));
    el.title.textContent = data.title || '';
    el.subtitle.textContent = data.subtitle || '';
    const artwork = data.thumbnailUrl || '';
    body.dataset.hasArtwork = String(Boolean(artwork));
    if (artwork && el.artwork.getAttribute('src') !== artwork) el.artwork.setAttribute('src', artwork);
    renderProgress(data);
    setState(state);
  } catch (error) {
    log(`render failed: ${error && error.message ? error.message : error}`);
  }
}

const binder = new ui.PlayerDataBinder(new ui.PlayerData());
binder.addEventListener(ui.PlayerDataEventType.ANY_CHANGE, () => renderPlayerData(binder.getPlayerData()));

/* --- LOAD interceptor: DRM + live edge ------------------------------------------------------ */

function applyDrm(loadRequestData) {
  const custom = loadRequestData.media.customData || {};
  const drm = custom.drm || (loadRequestData.customData && loadRequestData.customData.drm);
  if (!drm || !drm.licenseUrl) {
    log('no DRM in customData — clear stream');
    return;
  }
  const playbackConfig = new cast.framework.PlaybackConfig();
  playbackConfig.licenseUrl = drm.licenseUrl;
  playbackConfig.licenseRequestHandler = requestInfo => {
    requestInfo.headers = requestInfo.headers || {};
    Object.entries(drm.headers || {}).forEach(([key, value]) => {
      requestInfo.headers[key] = value;
    });
  };
  playerManager.setPlaybackConfig(playbackConfig);
  log('DRM configured');
}

function resolveLiveStartPosition(loadRequestData) {
  if (loadRequestData.media.streamType !== messages.StreamType.LIVE) return;
  const requestedLiveEdge = loadRequestData.media.customData &&
    loadRequestData.media.customData.startAtLiveEdge === true;
  const carriesPosition = Number.isFinite(loadRequestData.currentTime) && loadRequestData.currentTime > 0;
  if (requestedLiveEdge || !carriesPosition) {
    log('live item, no chosen position — starting at the live edge');
    delete loadRequestData.currentTime;
  }
}

playerManager.setMessageInterceptor(messages.MessageType.LOAD, loadRequestData => {
  if (!loadRequestData || !loadRequestData.media) {
    const error = new messages.ErrorData(messages.ErrorType.LOAD_FAILED);
    error.reason = messages.ErrorReason.INVALID_REQUEST;
    return error;
  }
  log(`LOAD ${loadRequestData.media.contentId} (${loadRequestData.media.streamType})`);
  if (loadRequestData.media.customData && loadRequestData.media.customData.debug === true) showDebugOverlay();
  applyDrm(loadRequestData);
  resolveLiveStartPosition(loadRequestData);
  return loadRequestData;
});

/* --- events, options, start ----------------------------------------------------------------- */

playerManager.addEventListener(events.EventType.ERROR, event => {
  log(`error ${event && event.detailedErrorCode}`);
});

context.addEventListener(system.EventType.READY, () => {
  log(`receiver ready — build ${build.stamped || 'unstamped'} (${build.commit || '-'})`);
  styleCastPlayer();
  if (debugRequested) showDebugOverlay();
  setState(State.Logo);
});

const castReceiverOptions = new cast.framework.CastReceiverOptions();

/*
 * Our live streams have a DVR window, so pausing and seeking one is legitimate; without saying so the
 * receiver advertises neither and the phone's scrubber has nothing to talk to. No queue.
 */
castReceiverOptions.supportedCommands =
  messages.Command.PAUSE |
  messages.Command.SEEK |
  messages.Command.STREAM_VOLUME |
  messages.Command.STREAM_MUTE |
  messages.Command.EDIT_TRACKS;

styleCastPlayerWhenReady();
context.start(castReceiverOptions);
