import React, { useEffect, useRef } from 'react';
import { registerVoiceSession } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { VoiceSession, VoiceSessionConfig } from './types';

/**
 * Local voice on native is not implemented — the self-hosted whisper + piper
 * backend targets the web client served over the tailnet. Register a stub so
 * selecting the 'local' backend on a native build fails loudly instead of
 * silently doing nothing.
 */

class LocalVoiceSessionStub implements VoiceSession {
    async startSession(_config: VoiceSessionConfig): Promise<string | null> {
        storage.getState().setRealtimeStatus('error');
        Modal.alert(t('common.error'), 'Local voice is only available on the web client for now.');
        return null;
    }
    async endSession(): Promise<void> {
        storage.getState().setRealtimeStatus('disconnected');
    }
    sendTextMessage(_message: string): void {}
    sendContextualUpdate(_update: string): void {}
    startTalking(): void {}
    stopTalking(): void {}
}

export const LocalVoiceSession: React.FC = () => {
    const hasRegistered = useRef(false);

    useEffect(() => {
        if (!hasRegistered.current) {
            registerVoiceSession(new LocalVoiceSessionStub());
            hasRegistered.current = true;
        }
    }, []);

    return null;
};
