/**
 * Local (self-hosted) voice configuration.
 *
 * STT: whisper.cpp `whisper-server` — POST a 16 kHz mono WAV as multipart
 * `file` to its `/inference` endpoint, receive `{ text }`. Unlike OpenAI's
 * Realtime API this is turn-based REST, so the client must detect end-of-turn
 * itself (push-to-talk, or the energy VAD below).
 *
 * TTS: a small HTTP wrapper around piper (or any server that accepts
 * `{ input }` JSON and returns audio bytes the browser can decode).
 *
 * Endpoints are user-configurable (`localVoiceSttUrl` / `localVoiceTtsUrl` in
 * settings) so the servers can live anywhere on the tailnet.
 */

// whisper.cpp is trained on 16 kHz mono audio — capture at that rate directly.
export const LOCAL_SAMPLE_RATE = 16000;

// Energy-based VAD (always-on mode). RMS over a worklet frame; speech is any
// frame above the threshold, and an utterance ends after SILENCE_MS of frames
// back under it. MIN_SPEECH_MS suppresses coughs/clicks.
export const LOCAL_VAD_RMS_THRESHOLD = 0.015;
export const LOCAL_VAD_SILENCE_MS = 800;
export const LOCAL_VAD_MIN_SPEECH_MS = 300;

// Cap a single utterance so a stuck-open mic can't POST an unbounded WAV.
export const LOCAL_MAX_UTTERANCE_MS = 30000;
