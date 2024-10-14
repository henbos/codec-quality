const kConsole = document.getElementById('consoleId');
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

let pc1 = null;
let pc2 = null;
let track = null;
let prevReport = new Map();

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
          bitrate: 2000000,  // 2000 kbps
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
  }

  // Periodically poll getStats()
  setInterval(doGetStats, 1000);
}

// Open camera and negotiate.
async function onOpen(width, height) {
  prevReport = new Map();
  if (pc1 != null) {
    pc1.close();
    pc2.close();
    pc1 = pc2 = null;
  }

  pc1 = new RTCPeerConnection();
  pc2 = new RTCPeerConnection();
  pc1.onicecandidate = (e) => pc2.addIceCandidate(e.candidate);
  pc2.onicecandidate = (e) => pc1.addIceCandidate(e.candidate);
  pc2.ontrack = (e) => {
    kVideo.srcObject = new MediaStream();
    kVideo.srcObject.addTrack(e.track);
  };

  if (track != null) {
    track.stop();
    track = null;
  }
  const stream = await navigator.mediaDevices.getUserMedia(
      {video: {width, height}});
  track = stream.getTracks()[0];

  pc1.addTransceiver(track, {direction:'sendonly'});
  await onChangeCodec();

  await pc1.setLocalDescription();
  await pc2.setRemoteDescription(pc1.localDescription);
  await pc2.setLocalDescription();
  await pc1.setRemoteDescription(pc2.localDescription);
}

async function onChangeCodec() {
  const codec = JSON.parse(kCodecSelect.value);
  if (pc1 == null || pc1.getSenders().length != 1) {
    return;
  }
  const [sender] = pc1.getSenders();
  const params = sender.getParameters();
  params.encodings[0].codec = codec;
  await sender.setParameters(params);
}

async function doGetStats() {
  if (pc1 == null) {
    return;
  }
  const reportAsMap = new Map();
  const report = await pc1.getStats();
  for (const stats of report.values()) {
    reportAsMap.set(stats.id, stats);
    if (stats.type != 'outbound-rtp') {
      continue;
    }
    let codec = report.get(stats.codecId);
    if (codec) {
      codec = codec.mimeType.substring(6);
    } else {
      codec = '';
    }
    let width = stats.frameWidth;
    let height = stats.frameHeight;
    if (!width || !height) {
      width = height = 0;
    }
    let actualKbps = Math.round(Bps_to_kbps(delta(stats, 'bytesSent')));
    actualKbps = Math.max(0, actualKbps);
    const targetKbps = Math.round(bps_to_kbps(stats.targetBitrate));
    let adapt =
        stats.qualityLimitationReason ? stats.qualityLimitationReason : 'none';
    adapt = (adapt != 'none') ? `${adapt} limited` : '';

    let trackSettings = track?.getSettings();
    let trackWidth = trackSettings?.width ? trackSettings.width : -1;
    let trackHeight = trackSettings?.height ? trackSettings.height : -1;
    uxConsoleLog(
        `${codec} ${width}x${height} ${actualKbps} (${targetKbps}) ${adapt}`,
        width == trackWidth && height == trackHeight ? kConsoleStatusGood
                                                     : kConsoleStatusBad);
  }
  prevReport = reportAsMap;
}

function delta(stats, metricName) {
  const currMetric = stats[metricName];
  if (currMetric == undefined) {
    return undefined;
  }
  const prevStats = prevReport.get(stats.id);
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
