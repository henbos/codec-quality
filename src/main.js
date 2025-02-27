const kConsole = document.getElementById('consoleId');

const kSimulcastCheckbox = document.getElementById('simulcastCheckboxId');
const kCodecSelect = document.getElementById('codecSelectId');
const kVideo = document.getElementById('video');

const kHardwareCodecs = [];
function isPowerEfficient(codec) {
  for (const hwCodec of kHardwareCodecs) {
    if (codec.mimeType == hwCodec.mimeType &&
        codec.sdpFmtpLine == hwCodec.sdpFmtpLine) {
      return true;
    }
  }
  return false;
}

const kConsoleStatusGood = true;
const kConsoleStatusBad = false;
function uxConsoleLog(message, status) {
  kConsole.innerText = message;
  if (status) {
    kConsole.classList.add('consoleStatusGood');
    kConsole.classList.remove('consoleStatusBad');
  } else {
    kConsole.classList.remove('consoleStatusGood');
    kConsole.classList.add('consoleStatusBad');
  }
}

let _pc1 = null;
let _pc2 = null;
let _track = null;
let _maxWidth = 0, _maxHeight = 0;
let _maxBitrate = undefined;
let _prevReport = new Map();

// When the page loads.
window.onload = async () => {
  // Not sure which platforms this matters on but this dummy dance is an attempt
  // to ensure HW has already been queried before the call to getCapabilities()
  // as to not exclude any HW-only profiles, it supposedly matters on Android.
  {
    const dummyPc1 = new RTCPeerConnection();
    const dummyPc2 = new RTCPeerConnection();
    dummyPc1.addTransceiver('video');
    await dummyPc1.setLocalDescription();
    await dummyPc2.setRemoteDescription(dummyPc1.localDescription);
    await dummyPc2.setLocalDescription();
    await dummyPc1.setRemoteDescription(dummyPc2.localDescription);
    dummyPc1.close();
    dummyPc2.close();
  }

  // Add codec options to the drop-down.
  let hasH265 = false;
  for (const codec of RTCRtpSender.getCapabilities('video').codecs) {
    if (codec.mimeType.endsWith('rtx') || codec.mimeType.endsWith('red') ||
        codec.mimeType.endsWith('ulpfec')) {
      continue;
    }
    const contentType =
        codec.sdpFmtpLine ? `${codec.mimeType};${codec.sdpFmtpLine}`
                          : codec.mimeType;
    const info = await navigator.mediaCapabilities.encodingInfo({
        type: 'webrtc',
        video: {
          contentType: contentType,
          width: 1280,
          height: 720,
          framerate: 30,
          bitrate: kbps_to_bps(2000),  // 2000 kbps
          scalabilityMode: 'L1T1'
        },
    });

    const option = document.createElement('option');
    option.value = JSON.stringify(codec);
    option.innerText = contentType;
    if (info.powerEfficient) {
      option.innerText += ' (powerEfficient)';
      kHardwareCodecs.push(codec);
    }
    kCodecSelect.appendChild(option);
    if (codec.mimeType == 'video/H265') {
      hasH265 = true;
    }
  }

  // Default to H265 or AV1.
  const defaultCodec = hasH265 ? 'video/H265' : 'video/AV1';
  for (const option of kCodecSelect.children) {
    if (JSON.parse(option.value).mimeType == defaultCodec) {
      kCodecSelect.value = option.value;
      break;
    }
  }

  // Periodically poll getStats()
  setInterval(doGetStats, 1000);
}

function getSelectedCodec() {
  return JSON.parse(kCodecSelect.value);
}

function stop() {
  _prevReport = new Map();
  if (_pc1 != null) {
    _pc1.close();
    _pc2.close();
    _pc1 = _pc2 = null;
  }
  _maxBitrate = undefined;
  if (_track != null) {
    _track.stop();
    _track = null;
  }
}

async function toggleSimulcast() {
  if (_pc1 == null) {
    return;
  }
  reconfigure(_maxWidth, _maxHeight, bps_to_kbps(_maxBitrate));
}

function mungeDependencyDescriptor(sdp) {
  const kDependencyDescriptorUri =
      'https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension';
  if (sdp.includes(kDependencyDescriptorUri)) {
    // Apparently, this is included by default when doing simulcast so this can
    // be a NO-OP.
    return sdp;
  }
  const kExtMapLine = 'a=extmap:';
  let highestExtId = 1;
  let lastExtensionEndIndex = -1;
  for (let i = 0; i < sdp.length; i = lastExtensionEndIndex) {
    let beginIndex = sdp.indexOf(kExtMapLine, i);
    if (beginIndex == -1) {
      break;
    }
    beginIndex += kExtMapLine.length;
    const endIndex = sdp.indexOf(' ', beginIndex);
    const extId = Number(sdp.slice(beginIndex, endIndex));
    lastExtensionEndIndex = sdp.indexOf('\r\n', endIndex) + 2;
    if (highestExtId < extId) {
      highestExtId = extId;
    }
  }
  if (lastExtensionEndIndex != -1) {
    sdp =
        sdp.slice(0, lastExtensionEndIndex) +
        `a=extmap:${highestExtId + 1} ${kDependencyDescriptorUri}\r\n` +
        sdp.slice(lastExtensionEndIndex);
  }
  return sdp;
}

async function reconfigure(width, height, maxBitrateKbps) {
  const doSimulcast = kSimulcastCheckbox.checked;

  let isFirstTimeNegotiation = false;
  if (_pc1 == null) {
    isFirstTimeNegotiation = true;
    _pc1 = new RTCPeerConnection();
    _pc2 = new RTCPeerConnection();
    _pc1.onicecandidate = (e) => _pc2.addIceCandidate(e.candidate);
    _pc2.onicecandidate = (e) => _pc1.addIceCandidate(e.candidate);
    // Negotiate simulcast regardless. Singlecast = single active encoding.
    if (!doSimulcast) {
      _pc1.addTransceiver('video', {direction:'sendonly', sendEncodings: [
          {scalabilityMode: 'L1T1', scaleResolutionDownBy: 1, active: true},
          {scalabilityMode: 'L1T1', active: false},
          {scalabilityMode: 'L1T1', active: false},
      ]});
    } else {
      _pc1.addTransceiver('video', {direction:'sendonly', sendEncodings: [
          {scalabilityMode: 'L1T1', scaleResolutionDownBy: 4, active: true},
          {scalabilityMode: 'L1T1', scaleResolutionDownBy: 2, active: true},
          {scalabilityMode: 'L1T1', scaleResolutionDownBy: 1, active: true},
      ]});
    }
    await negotiateWithSimulcastTweaks(
        _pc1, _pc2, null, mungeDependencyDescriptor);
  }

  _maxWidth = width;
  _maxHeight = height;
  _maxBitrate = kbps_to_bps(maxBitrateKbps);

  if (_track == null) {
    const stream = await navigator.mediaDevices.getUserMedia(
        {video: {width: 1280, height: 720}});
    _track = stream.getTracks()[0];
    await _pc1.getSenders()[0].replaceTrack(_track);
  }
  await updateParameters();
}

async function updateParameters() {
  const codec = getSelectedCodec();
  if (_pc1 == null || _pc1.getSenders().length != 1) {
    return;
  }
  const [sender] = _pc1.getSenders();
  const params = sender.getParameters();
  // Adjust codec and bitrate.
  for (let i = 0; i < params.encodings.length; ++i) {
    params.encodings[i].codec = codec;
    params.encodings[i].maxBitrate = _maxBitrate;
    params.encodings[i].scalabilityMode = 'L1T1';
  }
  // Reconfigure active+scaleResolutionDownBy based on scale factor.
  const trackSettings = _track?.getSettings();
  let trackHeight = trackSettings?.height ? trackSettings.height : 0;
  let scaleFactor = 1;
  if (trackHeight > _maxHeight) {
    scaleFactor = trackHeight / _maxHeight;
  }
  // Simulcast: Disable layers instead of applying scaling factor.
  if (kSimulcastCheckbox.checked) {
    params.encodings[0].scaleResolutionDownBy = 4;
    params.encodings[1].scaleResolutionDownBy = 2;
    params.encodings[2].scaleResolutionDownBy = 1;
    for (let i = 0; i < params.encodings.length; ++i) {
      params.encodings[i].active =
          params.encodings[i].scaleResolutionDownBy >= scaleFactor;
    }
  } else {
    params.encodings[0].active = true;
    params.encodings[0].scaleResolutionDownBy = scaleFactor;
    // (getParameters bug, active changing to true during negotiation???)
    params.encodings[1].active = false;
    params.encodings[2].active = false;
  }
  try {
    await sender.setParameters(params);
  } catch (e) {
    stop();
    uxConsoleLog(e.message, kConsoleStatusBad);
  }
}

async function doGetStats() {
  if (_pc1 == null) {
    return;
  }
  const reportAsMap = new Map();
  const report = await _pc1.getStats();
  let maxSendRid = undefined, maxSendWidth = 0, maxSendHeight = 0;
  let message = '';
  const outboundRtpsByRid = new Map();
  for (const stats of report.values()) {
    reportAsMap.set(stats.id, stats);
    if (stats.type !== 'outbound-rtp') {
      continue;
    }
    outboundRtpsByRid.set(
        stats.rid != undefined ? Number(stats.rid) : 0, stats);
  }
  for (let i = 0; i < 3; ++i) {
    const stats = outboundRtpsByRid.get(i);
    if (!stats) {
      continue;
    }
    // Codec
    let codec = report.get(stats.codecId);
    if (codec) {
      codec = codec.mimeType.substring(6);
      if (stats.encoderImplementation) {
        const impl = simplifyEncoderString(stats.rid,
                                           stats.encoderImplementation);
        codec = `${impl}:${codec}`;
      }
    } else {
      codec = '';
    }
    // RID (optional)
    if (stats.rid) {
      codec = `${stats.rid} ${codec}`;
    }
    // Resolution and frame rate
    let width = stats.frameWidth;
    let height = stats.frameHeight;
    if (!width || !height) {
      width = height = 0;
    }
    let fps = stats.framesPerSecond;
    if (fps && height > maxSendHeight) {
      maxSendRid = stats.rid;
      maxSendWidth = width;
      maxSendHeight = height;
    }
    // Bitrates
    let actualKbps = Math.round(Bps_to_kbps(delta(stats, 'bytesSent')));
    actualKbps = Math.max(0, actualKbps);
    const targetKbps = Math.round(bps_to_kbps(stats.targetBitrate));
    // QP
    const deltaQp = delta(stats, 'qpSum');
    const deltaFramesEncoded = delta(stats, 'framesEncoded');
    const avgQp =
        (deltaQp && deltaFramesEncoded)
            ? Math.round(deltaQp / deltaFramesEncoded) : 'N/A';
    // Adaptation status
    let adaptationReason =
        stats.qualityLimitationReason ? stats.qualityLimitationReason : 'none';
    adaptationReason =
        (adaptationReason != 'none') ? `, ${adaptationReason} limited` : '';
    if (message.length > 0) {
      message += '\n';
    }
    if (fps) {
      message += `${codec} ${width}x${height} @ ${fps}, ${actualKbps}/` +
                 `${targetKbps} kbps [QP: ${avgQp}]${adaptationReason}`;
    } else {
      message += `-`;
    }
  }
  uxConsoleLog(message,
               maxSendHeight == _maxHeight ? kConsoleStatusGood
                                           : kConsoleStatusBad);

  // Maybe change which remote track to display.
  if (maxSendRid != undefined) {
    maxSendRid = Number(maxSendRid);
  }
  const recvTransceivers = _pc2?.getTransceivers();
  if (recvTransceivers && Number.isInteger(maxSendRid) &&
      maxSendRid < recvTransceivers.length) {
    let prevTrack = kVideo.srcObject ? kVideo.srcObject.getTracks()[0] : null;
    let currTrack = recvTransceivers[maxSendRid].receiver.track;
    if (currTrack != prevTrack) {
      kVideo.srcObject = new MediaStream();
      kVideo.srcObject.addTrack(currTrack);
    }
  }

  _prevReport = reportAsMap;
}

// utils.js

function delta(stats, metricName) {
  const currMetric = stats[metricName];
  if (currMetric == undefined) {
    return undefined;
  }
  const prevStats = _prevReport.get(stats.id);
  if (!prevStats) {
    return currMetric;
  }
  const prevMetric = prevStats[metricName];
  if (prevMetric == undefined) {
    return currMetric;
  }
  const deltaTimestampS = (stats.timestamp - prevStats.timestamp) / 1000;
  return (currMetric - prevMetric) / deltaTimestampS;
}

function convert(x, fn) {
  if (x == undefined) {
    return undefined;
  }
  return fn(x);
}

function Bps_to_kbps(x) {
  return convert(x, x => x * 8 / 1000);
}
function bps_to_kbps(x) {
  return convert(x, x => x / 1000);
}
function kbps_to_bps(x) {
  return convert(x, x => x * 1000);
}

function simplifyEncoderString(rid, encoderImplementation) {
  if (!encoderImplementation) {
    return null;
  }
  if (encoderImplementation.startsWith('SimulcastEncoderAdapter') &&
      rid != undefined) {
    let simplified = encoderImplementation.substring(
        encoderImplementation.indexOf('(') + 1,
        encoderImplementation.length - 1);
    simplified = simplified.split(', ');
    if (simplified.length > 1 && Number(rid) < simplified.length) {
      // We only know how to simplify the string if we have three encoders
      // otherwise the RID might not map 1:1 to the index here.
      return `[${simplified[rid]}]`;
    }
  }
  return encoderImplementation;
}
