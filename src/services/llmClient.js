import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const llmResponseSchema = z.object({
  summary: z.string().min(1).max(1500),
  findings: z
    .array(
      z.object({
        severity: z.enum(['critical', 'high', 'medium', 'low']).catch('medium'),
        title: z.string().min(3).max(120),
        detail: z.string().min(3).max(900),
        recommendation: z.string().max(900).optional().default(''),
        nodeIds: z.array(z.string().max(64)).max(20).optional().default([]),
      }),
    )
    .max(10)
    .default([]),
});

export function getProviderInfo() {
  if (env.AI_PROVIDER === 'none') return { provider: 'none', model: null, configured: false };

  const wantsGemini = env.AI_PROVIDER === 'auto' || env.AI_PROVIDER === 'gemini';
  const wantsOpenAI = env.AI_PROVIDER === 'auto' || env.AI_PROVIDER === 'openai';

  if (wantsGemini && env.GEMINI_API_KEY) {
    return { provider: 'gemini', model: env.GEMINI_MODEL, configured: true };
  }
  if (wantsOpenAI && env.OPENAI_API_KEY) {
    return { provider: 'openai', model: env.OPENAI_MODEL, configured: true };
  }
  return { provider: 'none', model: null, configured: false };
}

function buildPrompt(graph) {
  const compactGraph = {
    components: (graph.nodes ?? []).map((node) => ({
      id: node.id,
      type: node.type,
      name: node.label,
      description: node.description || undefined,
      entities: node.entities?.length ? node.entities : undefined,
    })),
    connections: (graph.edges ?? []).map((edge) => ({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      label: edge.label || undefined,
    })),
  };

  return [
    'You are a principal software architect reviewing a system design whiteboard for a product team.',
    'Return ONLY valid JSON with this exact shape:',
    '{"summary": "2-4 sentence review", "findings": [{"severity": "critical|high|medium|low", "title": "short title", "detail": "why it matters", "recommendation": "concrete fix", "nodeIds": ["id of related component"]}]}',
    'Rules:',
    '- Reference only component ids that appear in the diagram.',
    '- At most 6 findings, ordered by severity.',
    '- Focus on reliability, security, data ownership, scaling and missing infrastructure.',
    '- Do not invent components that are not on the board; suggest them in the recommendation text instead.',
    '- Be specific to this diagram, never generic.',
    '',
    'Diagram JSON:',
    JSON.stringify(compactGraph),
  ].join('\n');
}

function extractJson(text) {
  if (!text) throw new Error('Empty model response');
  const fenced = text.replace(/```json/gi, '```');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('Model response contained no JSON object');
  return JSON.parse(fenced.slice(start, end + 1));
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'You review software architecture diagrams and reply with strict JSON.' }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1600, responseMimeType: 'application/json' },
    }),
    signal: AbortSignal.timeout(env.AI_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Gemini API ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text).join('') ?? '';
  return extractJson(text);
}

async function callOpenAICompatible(prompt) {
  const baseUrl = env.OPENAI_BASE_URL.replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      temperature: 0.2,
      max_tokens: 1600,
      messages: [
        { role: 'system', content: 'You review software architecture diagrams and reply with strict JSON.' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(env.AI_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`AI provider ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  return extractJson(data?.choices?.[0]?.message?.content ?? '');
}

/**
 * Calls the configured LLM. Returns null when no provider is configured.
 * Throws on provider failure so the caller can fall back to heuristics.
 */
export async function requestLLMReview(graph) {
  const info = getProviderInfo();
  if (!info.configured) return null;

  const prompt = buildPrompt(graph);
  const raw = info.provider === 'gemini' ? await callGemini(prompt) : await callOpenAICompatible(prompt);
  const parsed = llmResponseSchema.parse(raw);
  logger.debug({ provider: info.provider, findings: parsed.findings.length }, 'LLM architecture review completed');
  return parsed;
}
