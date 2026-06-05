import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message, ToolCall } from '@earendil-works/pi-ai';

export function convertChatMessagesToLlm(messages: AgentMessage[]): Message[] {
  const pendingToolCallIds = new Set<string>();
  const converted: Message[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      converted.push(message);
      continue;
    }

    if (message.role === 'assistant') {
      if (shouldHideAssistantFromLlm(message)) {
        continue;
      }

      const assistant = normalizeAssistantContent(message);
      for (const toolCall of assistantToolCalls(assistant)) {
        pendingToolCallIds.add(toolCall.id);
      }
      converted.push(assistant);
      continue;
    }

    if (message.role === 'toolResult') {
      if (!pendingToolCallIds.has(message.toolCallId)) {
        continue;
      }

      pendingToolCallIds.delete(message.toolCallId);
      converted.push(message);
    }
  }

  return converted;
}

export function hasPersistableMessages(messages: AgentMessage[]) {
  return messages.some((message) => message.role === 'user' || message.role === 'assistant');
}

function shouldHideAssistantFromLlm(message: AssistantMessage) {
  return message.stopReason === 'aborted' || message.stopReason === 'error';
}

function normalizeAssistantContent(message: AssistantMessage): AssistantMessage {
  const content = (message as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return message;
  }
  if (typeof content === 'string') {
    return {
      ...message,
      content: [{ type: 'text', text: content }],
    };
  }

  return {
    ...message,
    content: [],
  };
}

function assistantToolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === 'toolCall');
}
