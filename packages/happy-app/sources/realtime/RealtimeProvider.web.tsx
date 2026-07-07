import React from 'react';
import { ElevenLabsVoiceSession } from './ElevenLabsVoiceSession';
import { OpenAIVoiceSession } from './OpenAIVoiceSession';
import { useVoiceSessionGeneration, useSetting } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    // Web SDK (@elevenlabs/react) uses a plain WebSocket — no LiveKit Room to
    // go stale — so this re-key is mostly defensive. Kept symmetric with native.
    const generation = useVoiceSessionGeneration();
    const voiceBackend = useSetting('voiceBackend');
    return (
        <>
            {voiceBackend === 'openai'
                ? <OpenAIVoiceSession />
                : <ElevenLabsVoiceSession key={generation} />}
            {children}
        </>
    );
};
