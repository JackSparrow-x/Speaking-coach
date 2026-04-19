// ========================================
// 音频格式转换工具
// Azure STT 要求输入是 WAV PCM 16kHz 16-bit 单声道
// 浏览器 MediaRecorder 默认录的是 WebM/Opus
// 这个文件就是在前端把 WebM Blob 转成 Azure 能吃的 WAV Blob
// ========================================

/**
 * 把 WebM 的音频 Blob 转成 WAV Blob（16kHz, 16-bit, mono）
 * 流程：WebM Blob → AudioBuffer → 降采样/合并声道 → WAV Blob
 */
export async function webmToWav(webmBlob: Blob): Promise<Blob> {
  // 1. WebM → AudioBuffer（浏览器原生解码）
  const arrayBuffer = await webmBlob.arrayBuffer();
  // AudioContext 是 Web Audio API 的入口
  const audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  audioContext.close(); // 用完就关，省资源

  // 2. AudioBuffer → Float32Array（16kHz, 单声道的原始采样）
  const targetSampleRate = 16000;
  const monoData = toMonoAndResample(audioBuffer, targetSampleRate);

  // 3. Float32Array → WAV Blob（加上 WAV header + 16-bit PCM 编码）
  return encodeWav(monoData, targetSampleRate);
}

/**
 * 把多声道 AudioBuffer 合并成单声道，并降采样到指定 sampleRate
 * （Azure STT 只要 mono，且 16kHz 最省带宽）
 */
function toMonoAndResample(
  buffer: AudioBuffer,
  targetSampleRate: number,
): Float32Array {
  // 先合并成单声道：把所有通道平均一下
  const length = buffer.length;
  const numChannels = buffer.numberOfChannels;
  const monoData = new Float32Array(length);
  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      monoData[i] += channelData[i] / numChannels;
    }
  }

  // 如果采样率一致，不用降采样
  if (buffer.sampleRate === targetSampleRate) return monoData;

  // 降采样：用线性插值（简化版，对语音识别够用）
  const ratio = buffer.sampleRate / targetSampleRate;
  const newLength = Math.floor(monoData.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, monoData.length - 1);
    const frac = srcIndex - low;
    result[i] = monoData[low] * (1 - frac) + monoData[high] * frac;
  }
  return result;
}

/**
 * 把 Float32Array（每个样本是 -1.0 到 1.0 的浮点）编码成 WAV 文件
 * WAV 文件结构：44 字节 header + 16-bit PCM 数据
 */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1; // mono
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataLength = samples.length * bytesPerSample;

  // 44 字节 WAV header + PCM 数据
  const arrayBuffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(arrayBuffer);

  // WAV header 格式（这是行业标准，抄过来就行）
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk 大小
  view.setUint16(20, 1, true); // 1 = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true); // block align
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  // 写入 PCM 数据：float [-1, 1] → int16 [-32768, 32767]
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i])); // 防溢出
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
