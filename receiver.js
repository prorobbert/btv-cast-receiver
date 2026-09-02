'use strict';

/*
 * Budget Thuis TV — Cast receiver.
 *
 * Modelled on Google's CastReceiver sample: the built-in <cast-media-player> owns playback and its UI,
 * and this file only wires up the debug logger, the LOAD interceptor (where our DRM and live-edge
 * handling live), the supported commands, and context.start(). No custom UI, no queue. The look is
 * themed with CSS custom properties in styles.css. Get the behaviour right first; style second.
 */

const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();

/* --- debug logger --------------------------------------------------------------------------- */

const castDebugLogger = cast.debug.CastDebugLogger.getInstance();
const LOG_TAG = 'BTV';
const build = window.BTV_BUILD || {};

/*
 * Turn the on-screen debug overlay on for a session with ?debug=1 on the receiver url or
 * customData.debug on a load request. Off by default — Google warns the logger can expose app detail,
 * so it must never ship enabled.
 */
const debugRequested = new URLSearchParams(location.search).get('debug') === '1';

castDebugLogger.loggerLevelByEvents = {
  'cast.framework.events.category.CORE': cast.framework.LoggerLevel.INFO,
  'cast.framework.events.EventType.MEDIA_STATUS': cast.framework.LoggerLevel.DEBUG,
};
if (!castDebugLogger.loggerLevelByTags) {
  castDebugLogger.loggerLevelByTags = {};
}
castDebugLogger.loggerLevelByTags[LOG_TAG] = cast.framework.LoggerLevel.DEBUG;

function showDebugOverlay() {
  try {
    castDebugLogger.setEnabled(true);
    castDebugLogger.showDebugLogs(true);
  } catch (error) {
    // The overlay is a convenience, never a requirement.
  }
}

context.addEventListener(cast.framework.system.EventType.READY, () => {
  castDebugLogger.info(LOG_TAG, `receiver ready — build ${build.stamped || 'unstamped'} (${build.commit || '-'})`);
  if (debugRequested) showDebugOverlay();
});

playerManager.addEventListener(cast.framework.events.EventType.ERROR, event => {
  castDebugLogger.error(LOG_TAG, `error ${event && event.detailedErrorCode}`);
  if (event && event.detailedErrorCode === 905) {
    castDebugLogger.error(LOG_TAG, 'LOAD_FAILED: verify the load request and that the media can play.');
  }
});

/* --- LOAD interceptor: DRM + live edge ------------------------------------------------------ */

/**
 * Translate the sender's Widevine configuration into the receiver's PlaybackConfig. The senders put
 * the Axinom license url and its X-AxDRM-Message header in customData.drm; without this no protected
 * stream plays. Widevine is implied — no protectionSystem field — so this is deliberately not Google's
 * exoPlayerConfig convention, and the exoPlayerConfig the media3 converter also emits is ignored.
 */
function applyDrm(loadRequestData) {
  const drm = loadRequestData.media.customData &&
    (loadRequestData.media.customData.drm || (loadRequestData.customData && loadRequestData.customData.drm));
  if (!drm || !drm.licenseUrl) {
    castDebugLogger.debug(LOG_TAG, 'no DRM in customData — clear stream');
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
  castDebugLogger.info(LOG_TAG, 'DRM configured');
}

/**
 * media3's RemoteCastPlayer turns "no position" into currentTime = 0, and CAF reads 0 on a live stream
 * as the start of the DVR window — so a channel switch lands however far back that window reaches
 * rather than at the live edge. Delete currentTime for a live item that carries no chosen position;
 * a position the viewer actually picked passes through.
 */
function resolveLiveStartPosition(loadRequestData) {
  if (loadRequestData.media.streamType !== cast.framework.messages.StreamType.LIVE) {
    return;
  }
  const requestedLiveEdge = loadRequestData.media.customData &&
    loadRequestData.media.customData.startAtLiveEdge === true;
  const carriesPosition = Number.isFinite(loadRequestData.currentTime) && loadRequestData.currentTime > 0;
  if (requestedLiveEdge || !carriesPosition) {
    castDebugLogger.info(LOG_TAG, 'live item, no chosen position — starting at the live edge');
    delete loadRequestData.currentTime;
  }
}

playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, loadRequestData => {
  castDebugLogger.debug(LOG_TAG, `LOAD ${JSON.stringify(loadRequestData && loadRequestData.media && {
    contentId: loadRequestData.media.contentId,
    streamType: loadRequestData.media.streamType,
    currentTime: loadRequestData.currentTime,
  })}`);

  if (!loadRequestData || !loadRequestData.media) {
    const error = new cast.framework.messages.ErrorData(cast.framework.messages.ErrorType.LOAD_FAILED);
    error.reason = cast.framework.messages.ErrorReason.INVALID_REQUEST;
    return error;
  }

  if (loadRequestData.media.customData && loadRequestData.media.customData.debug === true) {
    showDebugOverlay();
  }

  applyDrm(loadRequestData);
  resolveLiveStartPosition(loadRequestData);
  return loadRequestData;
});

/* --- options + start ------------------------------------------------------------------------ */

const castReceiverOptions = new cast.framework.CastReceiverOptions();

/*
 * Our live streams have a DVR window, so pausing and seeking one is legitimate; without saying so the
 * receiver advertises neither and the phone's scrubber has nothing to talk to. No queue commands — a
 * single item plays at a time.
 */
castReceiverOptions.supportedCommands =
  cast.framework.messages.Command.PAUSE |
  cast.framework.messages.Command.SEEK |
  cast.framework.messages.Command.STREAM_VOLUME |
  cast.framework.messages.Command.STREAM_MUTE |
  cast.framework.messages.Command.EDIT_TRACKS;

context.start(castReceiverOptions);
