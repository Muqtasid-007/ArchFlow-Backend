import crypto from 'node:crypto';
import { logger } from '../config/logger.js';
import { analyzeGraph } from './architectureAnalyzer.js';
import { getProviderInfo, requestLLMReview } from './llmClient.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 60;
const reviewCache = new Map();

const cacheKey = (graph, provider) =>
  crypto
    .createHash('sha1')
    .update(provider ?? 'heuristic')
    .update(JSON.stringify(graph ?? {}))
    .digest('hex');

function readCache(key) {
  const hit = reviewCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    reviewCache.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache(key, value) {
  if (reviewCache.size >= CACHE_LIMIT) {
    const oldestKey = reviewCache.keys().next().value;
    reviewCache.delete(oldestKey);
  }
  reviewCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

const normalizeTitle = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Combines deterministic heuristics with an optional LLM review.
 *
 * The heuristic pass is authoritative for scoring, so a flaky or unavailable
 * model never produces an empty analysis. LLM findings are merged on top and
 * de-duplicated by title.
 */
export async function analyzeArchitecture(graph) {
  const providerInfo = getProviderInfo();
  const key = cacheKey(graph, providerInfo.provider);
  const cached = readCache(key);
  if (cached) return { ...cached, cached: true };

  const heuristic = analyzeGraph(graph);
  const response = {
    ...heuristic,
    provider: 'heuristic',
    model: null,
    degraded: false,
    warning: undefined,
    analyzedAt: new Date().toISOString(),
    cached: false,
  };

  if (providerInfo.configured && heuristic.score !== null) {
    try {
      const llm = await requestLLMReview(graph);
      if (llm) {
        const existingTitles = new Set(heuristic.findings.map((finding) => normalizeTitle(finding.title)));
        const validNodeIds = new Set((graph.nodes ?? []).map((node) => node.id));
        const aiFindings = llm.findings
          .filter((finding) => !existingTitles.has(normalizeTitle(finding.title)))
          .map((finding, index) => ({
            id: `ai-${index + 1}`,
            severity: finding.severity,
            title: finding.title,
            detail: finding.detail,
            recommendation: finding.recommendation,
            nodeIds: (finding.nodeIds ?? []).filter((id) => validNodeIds.has(id)),
            edgeIds: [],
            source: 'ai',
          }));

        const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
        response.findings = [...aiFindings, ...heuristic.findings]
          .sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
          .slice(0, 10);
        response.summary = `${llm.summary} ${heuristic.summary}`;
        response.provider = providerInfo.provider;
        response.model = providerInfo.model;
      }
    } catch (error) {
      logger.warn({ err: error }, 'LLM review failed, falling back to heuristics');
      response.degraded = true;
      response.warning = 'The AI provider could not be reached, so this review uses the built-in architecture rules.';
    }
  } else if (heuristic.score !== null) {
    response.warning =
      'Add GEMINI_API_KEY or OPENAI_API_KEY to the backend environment for model-generated commentary. The built-in rules ran regardless.';
  }

  writeCache(key, response);
  return response;
}

export function clearAnalysisCache() {
  reviewCache.clear();
}
