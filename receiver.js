'use strict';

/*
 * Budget Thuis TV — Cast receiver.
 *
 * There is no <cast-media-player> here. The page owns a plain <video> and a Shaka Player instance,
 * and the CAF SDK is kept purely as the cast protocol layer: it accepts sender connections, hands us
 * LOAD / PLAY / PAUSE / SEEK / STOP / EDIT_TRACKS_INFO as interceptable messages, and broadcasts
 * MediaStatus back to phones, Google Home and the remote. Two options make the split explicit:
 *
 *   skipPlayersLoad — the SDK does not fetch MPL or a Shaka build of its own; ours is the only one.
 *   mediaElement    — the SDK watches our <video>, so volume, mute, its idle detection and the
 *                     MediaStatus it broadcasts keep tracking real playback without us pushing them.
 *
 * Measured on a Google TV Streamer (2026-09-16): under skipPlayersLoad the SDK neither drives the
 * mediaElement nor listens to it. playerManager.play() leaves the element paused, and after a LOAD
 * its internal buffering flag is raised and never cleared, because the player whose events would
 * clear it does not exist. getPlayerState() then reports BUFFERING over a stream that is playing at
 * readyState 4 — and a media3 sender reads that as "not playing", which is the phone showing a play
 * button that does nothing. So transport is ours, and the MEDIA_STATUS interceptor below replaces
 * CAF's derived playerState with what the element is actually doing before the status goes out.
 *
 * What we now own, and therefore have to do by hand:
 *   - loading manifests, including DRM licence servers, headers and robustness (Shaka);
 *   - acting on PLAY / PAUSE / SEEK / STOP, because no SDK player is left to act for us;
 *   - the playerState every sender reads, for the same reason;
 *   - publishing duration, stream type and the track list, so senders have something to draw;
 *   - text and audio track selection, since EDIT_TRACKS_INFO now has to reach Shaka;
 *   - the whole UI. PlayerDataBinder went with the SDK player that fed it, so the overlay is driven
 *     straight off the media element and Shaka.
 *
 * On a TV the receiver takes no touch input: the remote's keys arrive as media messages, so the
 * overlay stays display-only.
 */

const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();
const { messages, events, system } = cast.framework;

const body = document.body;
const video = document.getElementById('video');
const captions = document.getElementById('captions');
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

/*
 * A debug panel we render ourselves. The SDK's CastDebugLogger overlay never painted on the Google TV
 * Streamer and its BTV tag never reached the CaC tool, so this plain <pre> in our own DOM is the only
 * reliable on-TV log. Gated behind ?debug=1 / customData.debug; never on by default.
 */
const debugLines = [];
let debugPanel = null;

function showDebugPanel() {
  if (debugPanel) return;
  debugPanel = document.createElement('pre');
  debugPanel.id = 'btv-debug';
  debugPanel.textContent = debugLines.join('\n');
  document.body.appendChild(debugPanel);
  /*
   * The ticker belongs to the panel, not to how it was raised: a LOAD carrying customData.debug is
   * the normal way in from the app — ?debug=1 needs a url the sender cannot set — and it used to get
   * the panel without the periodic probe, which is the line that says what state CAF settles in.
   */
  setInterval(() => probeState('tick'), 3000);
}

function log(message) {
  try {
    console.log(`[btv] ${message}`);
    castDebugLogger.info(LOG_TAG, message);
  } catch (error) {
    /* logging must never break playback */
  }
  try {
    debugLines.push(message);
    if (debugLines.length > 30) debugLines.shift();
    if (debugPanel) debugPanel.textContent = debugLines.join('\n');
  } catch (error) {
    /* diagnostic only */
  }
}

function showDebugOverlay() {
  showDebugPanel();
  try {
    castDebugLogger.setEnabled(true);
    castDebugLogger.showDebugLogs(true);
  } catch (error) {
    /* convenience only */
  }
}

/* --- UI state ------------------------------------------------------------------------------- */

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
  errorLine: document.getElementById('error'),
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

function showError(text) {
  if (el.errorLine) el.errorLine.textContent = text || '';
}

/* --- Shaka ---------------------------------------------------------------------------------- */

/*
 * One Shaka instance for the life of the receiver: creating it per load leaks MediaSource objects on
 * these devices, and load() already tears down whatever came before.
 */
let player = null;
let shakaBuffering = false;

/*
 * Applied at startup and again after every resetConfiguration() — which wipes it, so re-applying it
 * per load is not belt and braces, it is the only thing keeping cues on screen after the second item.
 *
 * Cues go into our own container instead of the element's native track list, so the design's type
 * applies and the platform's caption settings cannot override it.
 */
function baseConfiguration() {
  return {
    textDisplayFactory: () => new shaka.text.UITextDisplayer(video, captions),
  };
}

const shakaReady = (async () => {
  if (!window.shaka || !shaka.Player || !shaka.Player.isBrowserSupported()) {
    log('shaka missing or unsupported on this device');
    showError('Player kon niet starten');
    return null;
  }
  shaka.polyfill.installAll();
  const instance = new shaka.Player();
  instance.configure(baseConfiguration());

  instance.addEventListener('error', event => {
    const detail = event && event.detail;
    log(`shaka error ${detail && detail.code} ${detail && detail.data}`);
  });

  /*
   * Shaka's own buffering signal is more honest than the element's `waiting`, which on live edges
   * fires for a single frame and would otherwise flash the spinner.
   */
  instance.addEventListener('buffering', event => {
    shakaBuffering = Boolean(event && event.buffering);
    renderState();
  });

  await instance.attach(video);
  log(`shaka ${shaka.Player.version} attached`);
  return instance;
})();

const KEY_SYSTEMS = {
  widevine: 'com.widevine.alpha',
  playready: 'com.microsoft.playready',
  fairplay: 'com.apple.fps',
  clearkey: 'org.w3.clearkey',
};

/*
 * DRM comes off the load request, in the shape the senders already send:
 *
 *   media.customData.drm = {
 *     protectionSystem: "widevine" | "playready" | "fairplay" | "clearkey",   // default widevine
 *     licenseUrl: "https://…",
 *     headers: { "X-AxDRM-Message": "…" },      // sent on licence requests only
 *     servers: { "com.widevine.alpha": "…" },   // optional, for multi-key-system manifests
 *     videoRobustness: "HW_SECURE_ALL",         // optional; empty means "let EME negotiate"
 *     audioRobustness: "HW_SECURE_CRYPTO",
 *     persistentState: false,
 *     withCredentials: false
 *   }
 *
 * Chromecast hardware is Widevine, and Widevine L1 on anything current; PlayReady is only there on
 * Android TV boxes that ship it. Naming a robustness level is worth doing when the licence server
 * refuses L3 — without it EME may negotiate a session the server then rejects, which surfaces as a
 * licence error rather than as a capability error and is miserable to diagnose.
 */
function drmConfiguration(drm) {
  const servers = {};
  const advanced = {};
  if (drm) {
    if (drm.servers && typeof drm.servers === 'object') Object.assign(servers, drm.servers);
    if (drm.licenseUrl) {
      const named = String(drm.protectionSystem || drm.keySystem || 'widevine').toLowerCase();
      servers[KEY_SYSTEMS[named] || drm.keySystem || KEY_SYSTEMS.widevine] = drm.licenseUrl;
    }
    Object.keys(servers).forEach(keySystem => {
      advanced[keySystem] = {
        videoRobustness: drm.videoRobustness || '',
        audioRobustness: drm.audioRobustness || '',
        persistentStateRequired: Boolean(drm.persistentState),
      };
    });
  }
  return { drm: { servers, advanced } };
}

/*
 * Headers are per-request-type on purpose. A licence token does not belong on segment requests (it
 * would be logged by every CDN edge on the path), and a CDN token does not belong on licence
 * requests. media.customData.headers covers manifest and segments; drm.headers covers licences.
 */
function installNetworkFilters(custom) {
  const engine = player && player.getNetworkingEngine();
  if (!engine) return;
  engine.clearAllRequestFilters();

  const drm = custom.drm || {};
  const licenceHeaders = drm.headers || {};
  const contentHeaders = custom.headers || {};
  const RequestType = shaka.net.NetworkingEngine.RequestType;

  engine.registerRequestFilter((type, request) => {
    if (type === RequestType.LICENSE) {
      Object.assign(request.headers, licenceHeaders);
      if (drm.withCredentials) request.allowCrossSiteCredentials = true;
      return;
    }
    if (type === RequestType.MANIFEST || type === RequestType.SEGMENT) {
      Object.assign(request.headers, contentHeaders);
      if (custom.withCredentials) request.allowCrossSiteCredentials = true;
    }
  });
}

/* --- tracks --------------------------------------------------------------------------------- */

/*
 * Senders can only offer a track picker for tracks they have been told about, and EDIT_TRACKS_INFO
 * comes back as a list of the ids we published — so the ids here are Shaka's own, unmodified, and
 * the mapping back is a straight lookup.
 */
const AUDIO_TRACK_ID_BASE = 100000;
const audioTrackIds = new Map();

function describeTracks() {
  if (!player) return [];
  const tracks = [];

  player.getTextTracks().forEach(track => {
    const description = new messages.Track(track.id, messages.TrackType.TEXT);
    description.trackContentType = track.mimeType || 'text/vtt';
    description.language = track.language && track.language !== 'und' ? track.language : undefined;
    description.name = track.label || track.language || 'Ondertiteling';
    description.subtype =
      track.kind === 'caption' ? messages.TextTrackType.CAPTIONS : messages.TextTrackType.SUBTITLES;
    if (track.roles && track.roles.length) description.roles = track.roles;
    tracks.push(description);
  });

  /*
   * Audio is offered per language rather than per variant: a sender showing "Nederlands" twice
   * because the manifest carries two bitrates of it is a bug report waiting to happen. The id is
   * synthesised above Shaka's range, and audioTrackIds maps it back to a language.
   */
  audioTrackIds.clear();
  const languages = player.getAudioLanguagesAndRoles();
  if (languages.length > 1) {
    languages.forEach((entry, index) => {
      const id = AUDIO_TRACK_ID_BASE + index;
      audioTrackIds.set(id, entry);
      const description = new messages.Track(id, messages.TrackType.AUDIO);
      description.language = entry.language;
      description.name = entry.label || entry.language;
      if (entry.role) description.roles = [entry.role];
      tracks.push(description);
    });
  }

  return tracks;
}

function applyActiveTracks(activeTrackIds, enableTextTracks) {
  if (!player) return;
  const ids = Array.isArray(activeTrackIds) ? activeTrackIds : [];

  const audio = ids.map(id => audioTrackIds.get(id)).find(Boolean);
  if (audio) player.selectAudioLanguage(audio.language, audio.role || undefined);

  const text = player.getTextTracks().find(track => ids.indexOf(track.id) !== -1);
  if (text) {
    player.selectTextTrack(text);
    player.setTextTrackVisibility(true);
  } else if (enableTextTracks !== true) {
    player.setTextTrackVisibility(false);
  }
  log(`tracks: ${ids.join(',') || 'none'} active`);
}

/* --- what is on screen ---------------------------------------------------------------------- */

/*
 * Everything the overlay needs that the media element cannot tell us: the metadata off the load
 * request, and the window the seek bar measures.
 */
let current = {
  title: '',
  subtitle: '',
  artwork: '',
  live: false,
  sectionStart: NaN,
  sectionDuration: NaN,
};

function timeline() {
  /*
   * The bar measures the broadcast, per the design. Preference order: the section the sender attaches
   * (customData.section), then Shaka's seekable range — which for a live DASH stream is the DVR
   * window and for VOD is simply 0..duration.
   */
  if (Number.isFinite(current.sectionStart) && current.sectionDuration > 0) {
    return { start: current.sectionStart, end: current.sectionStart + current.sectionDuration };
  }
  if (player) {
    const range = player.seekRange();
    if (range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start) {
      return { start: range.start, end: range.end };
    }
  }
  const duration = Number(video.duration);
  return Number.isFinite(duration) && duration > 0 ? { start: 0, end: duration } : null;
}

function renderProgress() {
  const span = timeline();
  const position = Number(video.currentTime);
  const clamp = v => Math.min(1, Math.max(0, v));

  if (!span) {
    el.position.textContent = formatTime(position);
    el.duration.textContent = '--:--';
    return;
  }

  const length = span.end - span.start;
  const fraction = length > 0 ? clamp((position - span.start) / length) : 0;
  const percent = `${fraction * 100}%`;

  /* Real buffered-ahead now that we hold the element: the design draws it behind the progress fill. */
  let buffered = fraction;
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (position >= video.buffered.start(i) && position <= video.buffered.end(i)) {
      buffered = length > 0 ? clamp((video.buffered.end(i) - span.start) / length) : fraction;
      break;
    }
  }

  el.position.textContent = formatTime(position - span.start);
  el.duration.textContent = formatTime(length);
  el.progress.style.width = percent;
  el.handle.style.left = percent;
  el.buffer.style.width = `${buffered * 100}%`;
}

function renderMetadata() {
  el.title.textContent = current.title;
  el.subtitle.textContent = current.subtitle;
  body.dataset.live = String(Boolean(current.live));
  body.dataset.hasArtwork = String(Boolean(current.artwork));
  if (current.artwork && el.artwork.getAttribute('src') !== current.artwork) {
    el.artwork.setAttribute('src', current.artwork);
  }
}

let seeking = false;

/*
 * Between the manifest being parsed and the first frame arriving the element is still `paused`, so
 * without this the pause glyph flashes on screen at the start of every item. It is cleared by the
 * first `playing`, or immediately when the load asked us not to autoplay.
 */
let starting = false;

function renderState() {
  if (!player || !player.getAssetUri()) {
    setState(State.Logo);
    return;
  }
  if (seeking) setState(State.Seeking);
  else if (starting) setState(State.Buffering);
  else if (video.paused) setState(State.Paused);
  else if (shakaBuffering || video.readyState < 3) setState(State.Buffering);
  else setState(State.Playing);
}

function render() {
  renderState();
  renderProgress();
}

['timeupdate', 'progress', 'durationchange'].forEach(type => video.addEventListener(type, renderProgress));
['play', 'pause', 'waiting', 'ended', 'loadedmetadata', 'emptied'].forEach(type =>
  video.addEventListener(type, render)
);
/* `playing` is handled apart from the list above because the flag has to be down before we draw. */
video.addEventListener('playing', () => {
  starting = false;
  render();
});
video.addEventListener('seeking', () => {
  seeking = true;
  render();
});
video.addEventListener('seeked', () => {
  seeking = false;
  render();
});

/*
 * The SDK broadcasts MediaStatus on a timer and on its own view of the element, but a sender that
 * pressed pause wants the confirmation now, not in a second. These are the moments worth a push.
 */
['play', 'pause', 'seeked', 'ended', 'ratechange', 'volumechange', 'loadedmetadata'].forEach(type =>
  video.addEventListener(type, () => {
    try {
      playerManager.broadcastStatus(true);
    } catch (error) {
      /* a status push must never break playback */
    }
  })
);

/*
 * Safety net, not a fix. With skipPlayersLoad the SDK has no player to hand a LOAD to and in practice
 * it leaves the element alone — but "in practice" is not a contract. If anything ever assigned
 * media.contentUrl to video.src it would tear down Shaka's MediaSource and the screen would go black
 * with no obvious cause. `emptied` is exactly that moment. We only shout: reassigning the source here
 * would re-run the resource selection algorithm and make the mess worse.
 */
video.addEventListener('emptied', () => {
  if (player && player.getAssetUri()) log('WARNING: media element emptied while an asset was loaded');
});

/* --- LOAD ----------------------------------------------------------------------------------- */

function loadError(reason) {
  const error = new messages.ErrorData(messages.ErrorType.LOAD_FAILED);
  error.reason = reason;
  return error;
}

function metadataOf(media) {
  const metadata = media.metadata || {};
  const images = metadata.images || [];
  return {
    title: metadata.title || metadata.seriesTitle || '',
    subtitle: metadata.subtitle || metadata.artist || metadata.studio || '',
    artwork: (images[0] && images[0].url) || '',
  };
}

/* A newer LOAD must always win; an older one that finishes late has to leave the screen alone. */
let loadToken = 0;

playerManager.setMessageInterceptor(messages.MessageType.LOAD, async loadRequestData => {
  if (!loadRequestData || !loadRequestData.media) return loadError(messages.ErrorReason.INVALID_REQUEST);

  const media = loadRequestData.media;
  const url = media.contentUrl || media.contentId;
  const custom = media.customData || loadRequestData.customData || {};
  if (custom.debug === true || debugRequested) showDebugOverlay();
  if (!url) return loadError(messages.ErrorReason.INVALID_REQUEST);

  log(`LOAD ${url} (${media.streamType})`);
  showError('');
  starting = true;
  render();

  player = await shakaReady;
  if (!player) return loadError(messages.ErrorReason.GENERIC_LOAD_ERROR);

  const token = (loadToken += 1);

  player.resetConfiguration();
  player.configure(baseConfiguration());
  player.configure(drmConfiguration(custom.drm));
  if (custom.shaka && typeof custom.shaka === 'object') player.configure(custom.shaka);
  installNetworkFilters(custom);
  log(custom.drm && custom.drm.licenseUrl ? 'DRM configured' : 'no DRM in customData — clear stream');

  /*
   * A live item with no position the user chose starts at the live edge; passing undefined lets Shaka
   * pick it, which is more accurate than any number we could compute before the manifest is parsed.
   */
  const isLiveRequest = media.streamType === messages.StreamType.LIVE;
  const chosePosition = Number.isFinite(loadRequestData.currentTime) && loadRequestData.currentTime > 0;
  const startTime = isLiveRequest && (custom.startAtLiveEdge === true || !chosePosition)
    ? undefined
    : loadRequestData.currentTime;
  if (startTime === undefined && isLiveRequest) log('live item, no chosen position — starting at the live edge');

  try {
    await player.load(url, startTime, media.contentType || undefined);
  } catch (error) {
    const code = error && error.code;
    log(`shaka load failed: ${code} ${error && error.message}`);
    showError('Deze uitzending kan nu niet worden afgespeeld');
    starting = false;
    setState(State.Logo);
    return loadError(messages.ErrorReason.GENERIC_LOAD_ERROR);
  }

  if (token !== loadToken) {
    log('a newer LOAD overtook this one — dropping it');
    return loadRequestData;
  }

  /*
   * Tell the senders what we ended up with. Without this they have a null duration and an empty track
   * list, and the phone's scrubber has nothing to talk to — the SDK would normally fill these in from
   * its own player, which no longer exists here.
   */
  const live = player.isLive();
  const range = player.seekRange();
  media.streamType = live ? messages.StreamType.LIVE : messages.StreamType.BUFFERED;
  if (live) {
    /* null is how a sender is told "this has no end"; a stale number from the request would be worse. */
    media.duration = null;
  } else {
    const duration = Number.isFinite(video.duration) ? video.duration : range.end - range.start;
    if (Number.isFinite(duration) && duration > 0) media.duration = duration;
  }
  media.tracks = describeTracks();

  /*
   * entity is the field that means "the app knows what this string is". Setting it keeps contentId
   * from being read as a URL for the SDK to open behind our back.
   */
  if (!media.entity) media.entity = url;

  const section = custom.section || {};
  current = Object.assign(metadataOf(media), {
    live,
    sectionStart: Number(section.startTimeInMedia),
    sectionDuration: Number(section.duration),
  });
  renderMetadata();

  applyActiveTracks(loadRequestData.activeTrackIds);

  if (loadRequestData.autoplay !== false) {
    video.play().catch(error => log(`play() rejected: ${error && error.message}`));
  } else {
    starting = false;
  }
  render();
  log(`loaded — ${live ? 'live' : 'vod'}, ${media.tracks.length} track(s)`);
  setTimeout(() => probeState('after LOAD+1s'), 1000);
  return loadRequestData;
});

/*
 * The receiver's own overlay reads the element and is correct; what a sender sees is CAF's MediaStatus,
 * derived from CAF's internal flags. When the two disagree — sender shows paused while the element
 * plays — this line is how we see which side is lying. Logged on every transport command and, under
 * debug, on a slow timer.
 */
function probeState(where) {
  try {
    log(`probe ${where}: caf=${playerManager.getPlayerState()} paused=${video.paused} ` +
        `ready=${video.readyState} seeking=${video.seeking} t=${video.currentTime.toFixed(1)}`);
  } catch (error) {
    /* diagnostic only */
  }
}
if (debugRequested) showDebugPanel();

/* --- transport: the messages the SDK used to act on itself ---------------------------------- */

playerManager.setMessageInterceptor(messages.MessageType.PLAY, request => {
  video.play().catch(error => log(`play() rejected: ${error && error.message}`));
  probeState('after PLAY');
  return request;
});

playerManager.setMessageInterceptor(messages.MessageType.PAUSE, request => {
  video.pause();
  probeState('after PAUSE');
  return request;
});

playerManager.setMessageInterceptor(messages.MessageType.SEEK, request => {
  /*
   * Senders send either an absolute currentTime or, for live, a relativeTime against the live edge.
   * Both get clamped into the seekable window: seeking past the edge of a DVR window strands playback
   * in a gap that only a reload recovers from. The clamped value is written back into the request so
   * CAF seeks to it — the request is the only way to reach CAF's own seek handling.
   */
  const span = player ? player.seekRange() : null;
  let target = Number(request.currentTime);
  if (!Number.isFinite(target) && Number.isFinite(request.relativeTime) && span) {
    target = span.end + Number(request.relativeTime);
  }
  if (!Number.isFinite(target)) return request;
  if (span && Number.isFinite(span.start) && Number.isFinite(span.end)) {
    target = Math.min(Math.max(target, span.start), span.end);
  }
  log(`SEEK → ${target.toFixed(1)}s`);
  video.currentTime = target;
  return request;
});

playerManager.setMessageInterceptor(messages.MessageType.STOP, request => {
  starting = false;
  if (player) player.unload().catch(() => {});
  current = { title: '', subtitle: '', artwork: '', live: false, sectionStart: NaN, sectionDuration: NaN };
  renderMetadata();
  setState(State.Logo);
  return request;
});

playerManager.setMessageInterceptor(messages.MessageType.SET_PLAYBACK_RATE, request => {
  const rate = Number(request.playbackRate);
  if (Number.isFinite(rate) && rate > 0) video.playbackRate = rate;
  return request;
});

playerManager.setMessageInterceptor(messages.MessageType.EDIT_TRACKS_INFO, request => {
  applyActiveTracks(request.activeTrackIds, request.enableTextTracks);
  if (request.language && player) player.selectAudioLanguage(request.language);
  return request;
});

/*
 * The one that makes a sender believe us.
 *
 * CAF derives MediaStatus.playerState from flags its own player maintains — a paused-intent flag and
 * a buffering flag. Under skipPlayersLoad that player does not exist, so the buffering flag raised by
 * the LOAD is never lowered and every status says BUFFERING for as long as the session lasts. A
 * media3 sender turns that into STATE_BUFFERING with nothing playing: the play button on the phone
 * does nothing, because as far as it knows it already asked.
 *
 * MEDIA_STATUS is the outgoing status message, and it is interceptable, so the state we already
 * compute for our own overlay is written over CAF's guess on the way out. Only playerState — the
 * rest of the status (volume, mute, media, seekable range) is either right already or the sender's
 * only source for it.
 */
playerManager.setMessageInterceptor(messages.MessageType.MEDIA_STATUS, status => {
  if (!status) return status;
  /* Nothing loaded is CAF's own business: its IDLE, with its idle reason, is the honest answer. */
  if (!player || !player.getAssetUri()) return status;

  if (video.paused) status.playerState = messages.PlayerState.PAUSED;
  else if (starting || shakaBuffering || video.readyState < 3) status.playerState = messages.PlayerState.BUFFERING;
  else status.playerState = messages.PlayerState.PLAYING;

  return status;
});

/* --- events, options, start ----------------------------------------------------------------- */

playerManager.addEventListener(events.EventType.ERROR, event => {
  log(`error ${event && event.detailedErrorCode}`);
});

context.addEventListener(system.EventType.READY, () => {
  log(`receiver ready — build ${build.stamped || 'unstamped'} (${build.commit || '-'})`);
  if (debugRequested) showDebugOverlay();
  setState(State.Logo);
});

const castReceiverOptions = new cast.framework.CastReceiverOptions();

/*
 * The two options that make this a custom-player receiver rather than a skinned one. mediaElement is
 * what keeps the SDK useful: volume, mute, its idle detection and the MediaStatus it broadcasts are
 * all read off this element, so none of that has to be reimplemented here.
 */
castReceiverOptions.skipPlayersLoad = true;
castReceiverOptions.mediaElement = video;

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

context.start(castReceiverOptions);
