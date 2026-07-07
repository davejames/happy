import React, { useEffect, useRef } from 'react';
import { registerVoiceSession, getCurrentRealtimeSessionId } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    LOCAL_SAMPLE_RATE,
    LOCAL_VAD_RMS_THRESHOLD,
    LOCAL_VAD_SILENCE_MS,
    LOCAL_VAD_MIN_SPEECH_MS,
    LOCAL_MAX_UTTERANCE_MS,
} from './localVoiceConfig';
import { stripVoicePrefix } from './hooks/contextFormatters';
import { voicePrompt } from '@/sync/prompt/systemPrompt';
import type { VoiceSession, VoiceSessionConfig } from './types';

/**
 * Local voice session for web — fully self-hosted, nothing leaves the tailnet.
 *
 * STT: capture mic at 16 kHz via an AudioWorklet, buffer PCM16 until the turn
 * ends (push-to-talk, or the energy VAD), encode a WAV, and POST it to
 * whisper.cpp's `whisper-server` /inference endpoint.
 * TTS: POST Claude's reply text to the piper HTTP wrapper and play the returned
 * audio through Web Audio.
 *
 * No LLM in the voice loop — transcribed speech goes straight to Claude Code,
 * exactly like the OpenAI backend, only the transport is local REST.
 */

// Recording / VAD state
let mediaStream: MediaStream | null = null;
let recordingContext: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let pushToTalkMode = false;
let capturing = false;

let utterance: Int16Array[] = [];
let utteranceSamples = 0;
let speaking = false;
let silenceMs = 0;
let speechMs = 0;

// Playback state
let playbackContext: AudioContext | null = null;
let nextPlayTime = 0;

// TTS queue
let ttsQueue: string[] = [];
let ttsPlaying = false;
let ttsAbortController: AbortController | null = null;
let currentTtsSource: AudioBufferSourceNode | null = null;

// Endpoints resolved at session start from settings
let sttUrl = '';
let ttsUrl = '';

//
// Permission pattern matching (mirrors the OpenAI backend)
//

const ALLOW_PATTERNS = /^(yes|yeah|yep|approve|approved|allow|go ahead|do it|ok|okay|sure|go for it)[.!,]?$/i;
const DENY_PATTERNS = /^(no|nope|deny|reject|stop|cancel|don't|do not)[.!,]?$/i;

function tryHandlePermission(transcript: string): boolean {
    const sessionId = getCurrentRealtimeSessionId();
    if (!sessionId) return false;

    const session = storage.getState().sessions[sessionId];
    const requests = session?.agentState?.requests;
    if (!requests || Object.keys(requests).length === 0) return false;

    const requestId = Object.keys(requests)[0];
    const trimmed = transcript.trim();

    if (ALLOW_PATTERNS.test(trimmed)) {
        sessionAllow(sessionId, requestId);
        return true;
    }
    if (DENY_PATTERNS.test(trimmed)) {
        sessionDeny(sessionId, requestId);
        return true;
    }
    return false;
}

//
// WAV encoding (16-bit mono PCM -> minimal RIFF/WAVE)
//

function encodeWav(samples: Int16Array, sampleRate: number): ArrayBuffer {
    const dataBytes = samples.length * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);
    const writeStr = (offset: number, s: string) => {
        for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);       // fmt chunk size
    view.setUint16(20, 1, true);        // PCM
    view.setUint16(22, 1, true);        // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);        // block align
    view.setUint16(34, 16, true);       // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        view.setInt16(offset, samples[i], true);
    }
    return buffer;
}

//
// STT: send the buffered utterance to whisper-server
//

function resetUtterance() {
    utterance = [];
    utteranceSamples = 0;
    speaking = false;
    silenceMs = 0;
    speechMs = 0;
}

async function transcribeUtterance() {
    if (utteranceSamples === 0) {
        resetUtterance();
        return;
    }

    // Flatten the buffered PCM16 chunks into one WAV.
    const merged = new Int16Array(utteranceSamples);
    let off = 0;
    for (const chunk of utterance) {
        merged.set(chunk, off);
        off += chunk.length;
    }
    const enoughSpeech = speechMs >= LOCAL_VAD_MIN_SPEECH_MS;
    resetUtterance();
    if (!enoughSpeech) return;

    const wav = encodeWav(merged, LOCAL_SAMPLE_RATE);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'json');

    const response = await fetch(sttUrl, { method: 'POST', body: form });
    if (!response.ok) {
        console.error('[LocalVoice] STT request failed:', response.status, await response.text());
        return;
    }
    const data = await response.json();
    const transcript = (data.text ?? '').trim();
    if (!transcript) return;

    console.log('[LocalVoice] Transcription:', transcript);
    storage.getState().setRealtimeMode('idle');

    if (tryHandlePermission(transcript)) return;

    const sessionId = getCurrentRealtimeSessionId();
    if (sessionId) {
        sync.sendMessage(sessionId, transcript, { systemPrompt: voicePrompt });
    }
}

//
// TTS: piper HTTP wrapper -> WAV -> Web Audio
//

async function processTtsQueue() {
    if (ttsPlaying || ttsQueue.length === 0) return;
    ttsPlaying = true;

    while (ttsQueue.length > 0) {
        const text = ttsQueue.shift()!;
        try {
            await speakText(text);
        } catch (error) {
            if ((error as Error).name !== 'AbortError') {
                console.error('[LocalVoice] TTS error:', error);
            }
        }
    }

    ttsPlaying = false;
    storage.getState().setRealtimeMode('idle');
}

async function speakText(text: string) {
    if (!playbackContext) return;

    storage.getState().setRealtimeMode('agent-speaking');
    ttsAbortController = new AbortController();

    const response = await fetch(ttsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text }),
        signal: ttsAbortController.signal,
    });
    if (!response.ok) {
        console.error('[LocalVoice] TTS request failed:', response.status, await response.text());
        ttsAbortController = null;
        return;
    }

    // The server returns a complete WAV; the browser decodes + resamples it to
    // the playback context rate for us. (Streaming is a later optimisation.)
    const arrayBuffer = await response.arrayBuffer();
    ttsAbortController = null;
    const audioBuffer = await playbackContext.decodeAudioData(arrayBuffer);

    await new Promise<void>((resolve) => {
        const source = playbackContext!.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(playbackContext!.destination);
        currentTtsSource = source;
        const startTime = Math.max(playbackContext!.currentTime, nextPlayTime);
        source.onended = () => {
            if (currentTtsSource === source) currentTtsSource = null;
            resolve();
        };
        source.start(startTime);
        nextPlayTime = startTime + audioBuffer.duration;
    });
}

function cancelTts() {
    ttsQueue = [];
    if (ttsAbortController) {
        ttsAbortController.abort();
        ttsAbortController = null;
    }
    if (currentTtsSource) {
        try { currentTtsSource.stop(); } catch { /* already stopped */ }
        currentTtsSource = null;
    }
    ttsPlaying = false;
    nextPlayTime = 0;
}

//
// Recording
//

async function startRecording() {
    resetUtterance();
    capturing = true;
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingContext = new AudioContext({ sampleRate: LOCAL_SAMPLE_RATE });
    const source = recordingContext.createMediaStreamSource(mediaStream);

    const workletCode = `
        class PCMProcessor extends AudioWorkletProcessor {
            process(inputs) {
                const input = inputs[0];
                if (input.length > 0) {
                    const channelData = input[0];
                    let sumSq = 0;
                    const pcm16 = new Int16Array(channelData.length);
                    for (let i = 0; i < channelData.length; i++) {
                        const s = Math.max(-1, Math.min(1, channelData[i]));
                        sumSq += s * s;
                        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }
                    const rms = Math.sqrt(sumSq / channelData.length);
                    this.port.postMessage({ pcm16, rms, frames: channelData.length });
                }
                return true;
            }
        }
        registerProcessor('pcm-processor', PCMProcessor);
    `;
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await recordingContext.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    workletNode = new AudioWorkletNode(recordingContext, 'pcm-processor');
    workletNode.port.onmessage = (event) => {
        if (!capturing) return;
        const { pcm16, rms, frames } = event.data as { pcm16: Int16Array; rms: number; frames: number };
        const frameMs = (frames / LOCAL_SAMPLE_RATE) * 1000;

        // In push-to-talk mode we buffer everything between start/stopTalking and
        // let stopTalking flush it. In always-on mode the energy VAD segments turns.
        if (pushToTalkMode) {
            utterance.push(pcm16);
            utteranceSamples += pcm16.length;
            speechMs += frameMs;
            return;
        }

        const isSpeech = rms >= LOCAL_VAD_RMS_THRESHOLD;
        if (isSpeech) {
            if (!speaking) {
                speaking = true;
                storage.getState().setRealtimeMode('user-speaking');
                cancelTts(); // barge-in
            }
            speechMs += frameMs;
            silenceMs = 0;
            utterance.push(pcm16);
            utteranceSamples += pcm16.length;
        } else if (speaking) {
            // Keep a little trailing audio so word tails aren't clipped.
            utterance.push(pcm16);
            utteranceSamples += pcm16.length;
            silenceMs += frameMs;
            if (silenceMs >= LOCAL_VAD_SILENCE_MS) {
                transcribeUtterance();
            }
        }

        if (utteranceSamples >= (LOCAL_MAX_UTTERANCE_MS / 1000) * LOCAL_SAMPLE_RATE) {
            transcribeUtterance();
        }
    };

    source.connect(workletNode);
}

function stopRecording() {
    capturing = false;
    if (workletNode) {
        workletNode.disconnect();
        workletNode = null;
    }
    if (recordingContext) {
        recordingContext.close();
        recordingContext = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }
}

//
// Voice session implementation
//

class LocalVoiceSessionImpl implements VoiceSession {

    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        if (capturing || playbackContext) {
            console.warn('[LocalVoice] Session already active');
            return null;
        }

        const settings = storage.getState().settings;
        sttUrl = settings.localVoiceSttUrl;
        ttsUrl = settings.localVoiceTtsUrl;
        if (!sttUrl || !ttsUrl) {
            storage.getState().setRealtimeStatus('error');
            Modal.alert(t('common.error'), 'Local voice endpoints are not configured. Set them in Voice settings.');
            return null;
        }

        storage.getState().setRealtimeStatus('connecting');
        pushToTalkMode = config.pushToTalk ?? false;

        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (error) {
            console.error('[LocalVoice] Microphone permission denied:', error);
            storage.getState().setRealtimeStatus('error');
            return null;
        }

        playbackContext = new AudioContext();
        nextPlayTime = 0;

        // Always-on mode starts listening immediately; push-to-talk waits for
        // startTalking().
        if (!pushToTalkMode) {
            await startRecording();
        }

        storage.getState().setRealtimeStatus('connected');
        storage.getState().setRealtimeMode('idle');
        return null;
    }

    async endSession(): Promise<void> {
        stopRecording();
        cancelTts();
        resetUtterance();
        if (playbackContext) {
            playbackContext.close();
            playbackContext = null;
        }
        storage.getState().setRealtimeStatus('disconnected');
        storage.getState().setRealtimeMode('idle', true);
        storage.getState().clearRealtimeModeDebounce();
    }

    startTalking(): void {
        if (!pushToTalkMode) return;
        cancelTts();
        storage.getState().setRealtimeMode('user-speaking');
        startRecording();
    }

    stopTalking(): void {
        if (!pushToTalkMode) return;
        capturing = false;
        stopRecording();
        transcribeUtterance();
    }

    sendTextMessage(message: string): void {
        let text = stripVoicePrefix(message);
        if (!text) return;
        text = text.replace(/<options>[\s\S]*?<\/options>/g, '').trim();
        if (!text) return;
        ttsQueue.push(text);
        processTtsQueue();
    }

    sendContextualUpdate(_update: string): void {
        // whisper-server has no per-session prompt/glossary channel like the
        // OpenAI Realtime API, so contextual updates are a no-op locally.
    }
}

export const LocalVoiceSession: React.FC = () => {
    const hasRegistered = useRef(false);

    useEffect(() => {
        if (!hasRegistered.current) {
            registerVoiceSession(new LocalVoiceSessionImpl());
            hasRegistered.current = true;
            console.log('[LocalVoice] Web local voice session registered');
        }
    }, []);

    return null;
};
