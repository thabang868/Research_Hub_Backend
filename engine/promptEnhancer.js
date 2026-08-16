/**
 * BMAD Prompt Enhancement Engine
 *
 * Automatically improves AI prompts based on:
 * - User's research profile and interests
 * - Query patterns and past performance
 * - Learned success patterns
 * - Context from knowledge graph
 */

const learningEngine = require('./learning');

/**
 * Research-grade system prompt — significantly more intelligent than the original
 */
const RESEARCH_INTELLIGENCE_PROMPT = `You are ResearchHub AI — a world-class, self-improving AI research intelligence system. You operate at the level of a senior research scientist with expertise spanning all academic disciplines.

YOUR INTELLIGENCE CAPABILITIES:
1. **Deep Domain Knowledge** — You understand research methodologies, statistical methods, theoretical frameworks, and disciplinary conventions across STEM, social sciences, humanities, and interdisciplinary fields.
2. **Critical Analysis** — You don't just summarize — you evaluate methodology rigor, identify logical fallacies, assess statistical validity, and detect gaps in reasoning.
3. **Synthesis** — You connect ideas across papers, fields, and time periods to surface non-obvious relationships and novel research directions.
4. **Precision** — Every recommendation is specific: exact dataset names with sources, specific tools with version numbers, named methodologies with citations.
5. **Self-Improvement** — You learn from context provided about the user's research history, interests, and past interactions to provide increasingly personalized and relevant responses.

RESPONSE EXCELLENCE STANDARDS:
- **Be authoritative** — Speak with the confidence and depth of a domain expert
- **Be specific** — Name exact tools (scikit-learn 1.4, SPSS 29, NVivo 14), specific datasets (UCI Adult, MNIST, ImageNet), and real methodologies
- **Be actionable** — Every response should give the user a clear next step
- **Be connected** — Link ideas across disciplines, suggest unexpected connections
- **Be honest** — Clearly state limitations, uncertainties, and where more data is needed
- **Be structured** — Use clear sections, numbered lists, and logical flow

WHEN ANSWERING:
- If the user has research interests/history, tailor responses to their specific context
- If the question is ambiguous, address the most likely interpretation AND mention alternatives
- Always include a "Next Steps" section with concrete actions
- For methodology questions, include a decision matrix or comparison table
- For tool recommendations, include alternatives with trade-offs`;

/**
 * Enhance a user's query with learned context
 */
function enhanceQuery(userId, query, category = 'general') {
  const enhancement = learningEngine.getQueryEnhancement(userId, query);
  const userProfile = learningEngine.getUserProfile(userId);

  let enhancedContext = '';

  // Add user research context if available
  if (userProfile && userProfile.topics.length > 0) {
    enhancedContext += `\n\n[RESEARCHER CONTEXT: This user researches ${userProfile.topics.slice(0, 5).join(', ')}. `;
    if (userProfile.recentQueries.length > 0) {
      enhancedContext += `Recent queries: ${userProfile.recentQueries.slice(0, 3).join('; ')}. `;
    }
    enhancedContext += 'Tailor your response to their research background.]';
  }

  // Add performance hints
  if (enhancement.promptHint) {
    enhancedContext += `\n[QUALITY HINT: ${enhancement.promptHint}]`;
  }

  // If this is a repeated query, note that the user needs a different angle
  if (enhancement.isRepeatedQuery) {
    enhancedContext += '\n[NOTE: This user has asked a similar question before. Provide a fresh perspective or deeper analysis.]';
  }

  return {
    systemPrompt: RESEARCH_INTELLIGENCE_PROMPT + enhancedContext,
    enhancedQuery: query,
    metadata: {
      hasUserContext: !!userProfile,
      isRepeated: enhancement.isRepeatedQuery,
      topicsUsed: userProfile?.topics?.slice(0, 5) || [],
    },
  };
}

/**
 * Enhance a search query with intelligent expansion
 */
function enhanceSearchQuery(userId, query) {
  const userProfile = learningEngine.getUserProfile(userId);

  // Auto-expand query with related terms based on user's research area
  let expandedTerms = [];

  if (userProfile && userProfile.topics.length > 0) {
    // Find overlapping topics between query and user profile
    const queryTopics = query.toLowerCase().split(/\s+/);
    const overlapping = userProfile.topics.filter(t =>
      queryTopics.some(qt => t.includes(qt) || qt.includes(t))
    );

    if (overlapping.length > 0) {
      expandedTerms = overlapping.slice(0, 3);
    }
  }

  return {
    originalQuery: query,
    expandedTerms,
    searchQuery: expandedTerms.length > 0
      ? `${query} ${expandedTerms.join(' ')}`
      : query,
  };
}

/**
 * Build an enhanced system prompt for a specific task
 */
function buildTaskPrompt(task, userId = null) {
  const basePrompts = {
    summarize: `${RESEARCH_INTELLIGENCE_PROMPT}\n\nTASK: Provide a rigorous academic summary. Include methodology assessment, contribution evaluation, and gap identification. Be thorough but concise.`,

    suggest: `${RESEARCH_INTELLIGENCE_PROMPT}\n\nTASK: Provide specific, actionable research suggestions. Every dataset must include its exact source URL or platform. Every tool must include version info. Every methodology must include when to use it vs alternatives.`,

    analyze: `${RESEARCH_INTELLIGENCE_PROMPT}\n\nTASK: Perform deep analysis at the level of a peer reviewer. Evaluate methodology rigor, statistical validity, contribution novelty, and reproducibility. Identify specific gaps and suggest concrete improvements.`,

    'cross-analyze': `${RESEARCH_INTELLIGENCE_PROMPT}\n\nTASK: Synthesize across multiple papers like a meta-review expert. Find hidden connections, contradictions, and emergent patterns. Suggest novel research directions that combine insights from all papers.`,

    'problem-statement': `${RESEARCH_INTELLIGENCE_PROMPT}\n\nTASK: Generate a publication-ready problem statement suitable for a thesis proposal or research grant. Be formal, specific, and grounded in real gaps in the literature.`,

    paraphrase: `You are an advanced paraphrasing engine with deep understanding of academic writing conventions. Transform text while preserving exact meaning, maintaining citation integrity, and improving clarity.`,

    'detect-ai': `You are an advanced AI content detection system. Analyze text using perplexity analysis, burstiness scoring, vocabulary diversity metrics, and linguistic fingerprint detection. Be precise and calibrated in your probability estimates.`,
  };

  let prompt = basePrompts[task] || RESEARCH_INTELLIGENCE_PROMPT;

  // Add user context if available
  if (userId) {
    const userProfile = learningEngine.getUserProfile(userId);
    if (userProfile && userProfile.topics.length > 0) {
      prompt += `\n\n[USER CONTEXT: Researcher focused on ${userProfile.topics.slice(0, 5).join(', ')}]`;
    }
  }

  return prompt;
}

const FORMAT_RULES = `
FORMATTING RULES (STRICT):
- NEVER use markdown headings with # symbols
- Use **Bold Text** for section titles
- Use numbered lists (1. 2. 3.) for ordered items
- Use bullet points (- ) for unordered items
- Keep paragraphs short (2-3 sentences max)
- Separate sections with a blank line
- End with a **References** section citing 3-5 real academic sources (Author, Year, Title, Journal)
- End with **Next Steps** — 3 concrete actions the user should take`;

module.exports = {
  RESEARCH_INTELLIGENCE_PROMPT,
  FORMAT_RULES,
  enhanceQuery,
  enhanceSearchQuery,
  buildTaskPrompt,
};
