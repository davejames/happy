export interface VoiceSessionConfig {
    sessionId: string;
    initialContext?: string;
    // ElevenLabs backend (upstream)
    systemPrompt?: string;
    firstMessage?: string;
    conversationToken?: string;
    token?: string;
    // OpenAI backend (#1002)
    pushToTalk?: boolean;
    apiKey?: string;
    agentId?: string;
    userId?: string;
}

export interface VoiceSession {
    startSession(config: VoiceSessionConfig): Promise<string | null>;
    endSession(): Promise<void>;
    sendTextMessage(message: string): void;
    sendContextualUpdate(update: string): void;
    startTalking(): void;
    stopTalking(): void;
}

export type ConversationStatus = 'disconnected' | 'connecting' | 'connected';
export type ConversationMode = 'idle' | 'agent-speaking' | 'user-speaking';
