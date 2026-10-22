// Thin wrapper around the Anthropic SDK shared by the AI scripts.
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-5-5';

export function hasCredentials() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

// Created on first use, so scripts that never call Claude don't need credentials.
let client;

/**
 * Sends one prompt to Claude and returns the text of the reply.
 *
 * - `schema`: optional JSON Schema. When set, Claude's reply is guaranteed to be JSON
 *   that matches it (structured outputs) and this function returns the parsed object.
 * - `effort`: how hard Claude thinks (low | medium | high | xhigh | max).
 *
 * Requests opt into server-side fallbacks: if the model declines a request, the API
 * retries it on Anthropic's recommended fallback model instead of failing.
 */
export async function askClaude({ system, prompt, schema, effort = 'medium', maxTokens = 32000 }) {
  client ??= new Anthropic();
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: {
      effort,
      ...(schema ? { format: { type: 'json_schema', schema } } : {}),
    },
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new Error(`Claude declined the request (${message.stop_details?.category ?? 'no category'}).`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error(`Claude's reply hit max_tokens (${maxTokens}) and is incomplete.`);
  }

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const { input_tokens, output_tokens } = message.usage;
  console.error(`[claude] model=${message.model} input_tokens=${input_tokens} output_tokens=${output_tokens}`);

  return schema ? JSON.parse(text) : text;
}

/** Turns SDK errors into a one-line, actionable message. */
export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Authentication failed: check ANTHROPIC_API_KEY.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Claude API: try again shortly.';
  if (err instanceof Anthropic.BadRequestError) return `The Claude API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  return err.message;
}
