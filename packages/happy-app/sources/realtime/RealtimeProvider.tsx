import React from 'react';
import { ElevenLabsProvider } from '@elevenlabs/react-native';
import { ElevenLabsVoiceSession } from './ElevenLabsVoiceSession';
import { OpenAIVoiceSession } from './OpenAIVoiceSession';
import { LocalVoiceSession } from './LocalVoiceSession';
import { useVoiceSessionGeneration, useSetting } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    // Force ElevenLabsProvider to remount between sessions. The native SDK uses
    // LiveKit, whose Room instance can't be reused after disconnect — second
    // startSession silently fails. Children sit OUTSIDE the provider so the app
    // tree isn't torn down on remount.
    const generation = useVoiceSessionGeneration();
    const voiceBackend = useSetting('voiceBackend');
    return (
        <>
            <ElevenLabsProvider key={generation}>
                {voiceBackend === 'openai'
                    ? <OpenAIVoiceSession />
                    : voiceBackend === 'local'
                        ? <LocalVoiceSession />
                        : <ElevenLabsVoiceSession />}
            </ElevenLabsProvider>
            {children}
        </>
    );
};
