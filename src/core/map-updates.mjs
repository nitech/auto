/**
 * Translate ACP `session/update` payloads into transcript records.
 *
 * Unrecognised update kinds are stored verbatim rather than dropped: the
 * protocol is still moving, and a record we cannot render today is strictly
 * better than one we threw away.
 */
import { KIND } from './transcript.mjs';

/** Flatten an ACP content block to plain text where possible. */
function textOf(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textOf).join('');
  if (content.type === 'text') return content.text || '';
  if (content.content) return textOf(content.content);
  return '';
}

/**
 * @param {object} update the `params.update` object from a session/update
 * @returns {{ kind: string, payload: object } | null}
 */
export function mapUpdate(update) {
  if (!update || typeof update !== 'object') return null;
  const t = update.sessionUpdate;

  switch (t) {
    case 'agent_message_chunk':
      return { kind: KIND.agentDelta, payload: { text: textOf(update.content) } };

    case 'agent_thought_chunk':
      return { kind: KIND.agentThought, payload: { text: textOf(update.content) } };

    case 'user_message_chunk':
      return { kind: KIND.userMessage, payload: { text: textOf(update.content), echoed: true } };

    case 'tool_call':
      return {
        kind: KIND.toolCall,
        payload: {
          toolCallId: update.toolCallId,
          title: update.title,
          toolKind: update.kind,
          status: update.status,
          rawInput: update.rawInput,
          content: update.content,
          locations: update.locations,
        },
      };

    case 'tool_call_update':
      return {
        kind: KIND.toolUpdate,
        payload: {
          toolCallId: update.toolCallId,
          status: update.status,
          rawOutput: update.rawOutput,
          content: update.content,
          title: update.title,
        },
      };

    case 'plan':
      return { kind: KIND.plan, payload: { entries: update.entries } };

    case 'session_info_update':
      return { kind: KIND.sessionInfo, payload: { title: update.title } };

    case 'available_commands_update':
      return { kind: KIND.commands, payload: { availableCommands: update.availableCommands } };

    case 'current_mode_update':
      return { kind: KIND.sessionInfo, payload: { modeId: update.currentModeId } };

    default:
      return { kind: `acp:${t || 'unknown'}`, payload: { raw: update } };
  }
}
