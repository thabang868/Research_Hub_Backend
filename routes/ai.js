const express = require('express');
const router = express.Router();
const learningEngine = require('../engine/learning');
const smartCache = require('../engine/cache');
const { enhanceQuery, FORMAT_RULES, buildTaskPrompt } = require('../engine/promptEnhancer');
const { optionalAuth, aiLimiter, sanitize } = require('../middleware/security');

const COHERE_URL = 'https://api.cohere.com/v2/chat';

// AI Chat — BMAD-enhanced research intelligence assistant
router.post('/chat', optionalAuth, aiLimiter, sanitize, async (req, res) => {
  try {
    const { message, context } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const startTime = Date.now();
    const userId = req.user?.id || 'anonymous';

    // BMAD: Record query for learning
    learningEngine.recordQuery(userId, message, 'ai_chat');

    const cacheKey = `chat:${userId}:${message.trim().toLowerCase().slice(0, 1000)}:${String(context || '').slice(0, 500)}`;
    const cached = smartCache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    // BMAD: Enhance prompt with learned context
    const { systemPrompt, metadata } = enhanceQuery(userId, message, 'ai_chat');
    const fullSystemPrompt = systemPrompt + '\n' + FORMAT_RULES;

    const messages = [
      { role: 'system', content: fullSystemPrompt },
    ];

    if (context) {
      messages.push({
        role: 'user',
        content: `Context from my saved research: ${context}`,
      });
      messages.push({
        role: 'assistant',
        content: 'I have your research context. How can I help you with your research?',
      });
    }

    messages.push({ role: 'user', content: message });

    const response = await fetch(COHERE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'command-a-03-2025',
        messages,
        max_tokens: 1200,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Cohere error:', response.status, errText);
      learningEngine.recordFailure('cohere_api_error', { status: response.status, endpoint: 'chat' });
      return res.status(502).json({ error: 'AI service unavailable' });
    }

    const data = await response.json();
    let reply = data.message?.content?.[0]?.text || 'No response generated.';

    // Strip any # headings the model may still produce
    reply = reply.replace(/^#{1,6}\s+/gm, '');

    // BMAD: Score response quality
    const responseTimeMs = Date.now() - startTime;
    const { score } = learningEngine.scoreResponse(message, reply, { responseTimeMs });

    const result = {
      reply,
      intelligence: {
        qualityScore: score,
        personalized: metadata.hasUserContext,
        responseTimeMs,
      },
    };
    smartCache.set(cacheKey, result, 'ai_response');
    res.json(result);
  } catch (err) {
    console.error('AI chat error:', err);
    learningEngine.recordFailure('ai_chat_error', { error: err.message });
    res.status(500).json({ error: 'Failed to get AI response' });
  }
});

// Summarize a paper — BMAD enhanced
router.post('/summarize', optionalAuth, aiLimiter, sanitize, async (req, res) => {
  try {
    const { title, abstract, authors } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Paper title is required' });
    }

    const startTime = Date.now();
    const userId = req.user?.id || 'anonymous';

    // BMAD: Check cache first
    const cacheKey = `summarize:${title.slice(0, 100)}`;
    const cached = smartCache.get(cacheKey);
    if (cached) return res.json(cached);

    // BMAD: Record and enhance
    learningEngine.recordQuery(userId, title, 'summarize');
    const systemPrompt = buildTaskPrompt('summarize', userId) + '\n' + FORMAT_RULES;

    const prompt = `Summarize this research paper concisely.

Title: ${title}
${authors?.length ? `Authors: ${authors.join(', ')}` : ''}
${abstract ? `Abstract: ${abstract}` : ''}

Provide a structured summary with these sections:
**Key Findings** — What did the paper discover?
**Methodology** — What methods/approaches were used?
**Main Contribution** — Why is this paper significant?
**Limitations** — What are the gaps or weaknesses?
**Suggested Keywords** — 5-8 relevant keywords for this research
**Next Steps** — 3 concrete actions a researcher should take based on this paper

${FORMAT_RULES}`;

    const response = await fetch(COHERE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'command-a-03-2025',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      learningEngine.recordFailure('cohere_summarize_error', { status: response.status });
      return res.status(502).json({ error: 'AI service unavailable' });
    }

    const data = await response.json();
    let summary = data.message?.content?.[0]?.text || 'Could not generate summary.';
    summary = summary.replace(/^#{1,6}\s+/gm, '');

    const responseTimeMs = Date.now() - startTime;
    learningEngine.scoreResponse(title, summary, { responseTimeMs });

    const result = { summary, responseTimeMs };
    smartCache.set(cacheKey, result, 'ai_response');

    res.json(result);
  } catch (err) {
    console.error('Summarize error:', err);
    learningEngine.recordFailure('summarize_error', { error: err.message });
    res.status(500).json({ error: 'Failed to summarize paper' });
  }
});

// Suggest related research — BMAD enhanced
router.post('/suggest', optionalAuth, aiLimiter, sanitize, async (req, res) => {
  try {
    const { title, keywords, field } = req.body;
    const startTime = Date.now();
    const userId = req.user?.id || 'anonymous';

    const cacheKey = `suggest:${(title || '').slice(0, 50)}:${field || ''}`;
    const cached = smartCache.get(cacheKey);
    if (cached) return res.json(cached);

    learningEngine.recordQuery(userId, title || field || 'research suggestions', 'suggest');
    const systemPrompt = buildTaskPrompt('suggest', userId) + '\n' + FORMAT_RULES;

    const prompt = `Based on this research:
Title: ${title || 'Not specified'}
Keywords: ${(keywords || []).join(', ') || 'Not specified'}
Field: ${field || 'Not specified'}

Provide:
1. **5 Related Research Topics** — closely related areas worth exploring, with brief justification
2. **5 Suggested Datasets** — specific datasets with exact source (Kaggle URL, UCI name, HuggingFace repo, etc.)
3. **Recommended Methodologies** — 3-4 methods with specific tools (name + version) and when to use each
4. **Evaluation Metrics** — specific metrics/matrices used to measure success in this field
5. **Research Gap Ideas** — 2-3 gaps with evidence for why they matter
6. **Next Steps** — 3 concrete actions to start researching this topic

${FORMAT_RULES}`;

    const response = await fetch(COHERE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'command-a-03-2025',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      learningEngine.recordFailure('cohere_suggest_error', { status: response.status });
      return res.status(502).json({ error: 'AI service unavailable' });
    }

    const data = await response.json();
    let suggestions = data.message?.content?.[0]?.text || 'Could not generate suggestions.';
    suggestions = suggestions.replace(/^#{1,6}\s+/gm, '');

    const responseTimeMs = Date.now() - startTime;
    learningEngine.scoreResponse(title || 'suggest', suggestions, { responseTimeMs });

    const result = { suggestions, responseTimeMs };
    smartCache.set(cacheKey, result, 'ai_response');

    res.json(result);
  } catch (err) {
    console.error('Suggest error:', err);
    learningEngine.recordFailure('suggest_error', { error: err.message });
    res.status(500).json({ error: 'Failed to generate suggestions' });
  }
});

// Generate a problem statement — BMAD enhanced
router.post('/problem-statement', optionalAuth, aiLimiter, sanitize, async (req, res) => {
  try {
    const { topic, context, field } = req.body;

    if (!topic) {
      return res.status(400).json({ error: 'Research topic is required' });
    }

    const startTime = Date.now();
    const userId = req.user?.id || 'anonymous';
    learningEngine.recordQuery(userId, topic, 'problem_statement');

    const prompt = `Generate a formal academic problem statement for this research topic:

Topic: ${topic}
${field ? `Field: ${field}` : ''}
${context ? `Additional Context: ${context}` : ''}

Structure the problem statement as follows:

**Background** — 2-3 sentences providing context about the broader area and why it matters.

**Problem** — 2-3 sentences clearly identifying the specific gap, challenge, or issue that needs to be addressed. Be precise about what is unknown, unresolved, or inadequate.

**Significance** — 2-3 sentences explaining why solving this problem matters (practical impact, theoretical contribution, societal benefit).

**Research Objective** — 1-2 sentences stating what this research aims to achieve.

**Research Questions** — 3-4 specific, measurable research questions.

**Proposed Approach** — 2-3 sentences briefly describing the methodology or approach that could be used.

Make the problem statement formal, specific, and suitable for a thesis proposal or research grant application. Avoid vague or generic statements.

${FORMAT_RULES}`;

    const response = await fetch(COHERE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'command-a-03-2025',
        messages: [
          { role: 'system', content: buildTaskPrompt('problem-statement', userId) + '\n' + FORMAT_RULES },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      learningEngine.recordFailure('cohere_problem_statement_error', { status: response.status });
      return res.status(502).json({ error: 'AI service unavailable' });
    }

    const data = await response.json();
    let statement = data.message?.content?.[0]?.text || 'Could not generate problem statement.';
    statement = statement.replace(/^#{1,6}\s+/gm, '');

    const responseTimeMs = Date.now() - startTime;
    learningEngine.scoreResponse(topic, statement, { responseTimeMs });

    res.json({ statement, responseTimeMs });
  } catch (err) {
    console.error('Problem statement error:', err);
    learningEngine.recordFailure('problem_statement_error', { error: err.message });
    res.status(500).json({ error: 'Failed to generate problem statement' });
  }
});

// Generate methodology flow diagram (Draw.io XML) — BMAD enhanced
router.post('/methodology-diagram', optionalAuth, aiLimiter, sanitize, async (req, res) => {
  try {
    const { query, methodology } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const prompt = `Based on this research methodology query: "${query}"
${methodology ? `Methodology details: ${methodology}` : ''}

Generate a methodology flow diagram in Draw.io/diagrams.net XML format.

The diagram should:
- Show the complete research methodology flow from start to end
- Include 6-10 clear steps
- Use rectangles for process steps, diamonds for decision points, and rounded rectangles for start/end
- Connect all steps with arrows showing the flow direction
- Use clear, concise labels for each step
- Include colors: #1a1a2e for headers, #e8f4f8 for process steps, #fff3cd for decision points, #d4edda for start/end

Return ONLY the raw Draw.io XML starting with <mxGraphModel> and ending with </mxGraphModel>. No other text, no explanation, no markdown. Just the XML.`;

    const response = await fetch(COHERE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'command-a-03-2025',
        messages: [
          { role: 'system', content: 'You are an expert at creating Draw.io/diagrams.net XML diagrams for research methodologies. Output ONLY valid Draw.io XML. No explanations, no markdown, just the XML.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'AI service unavailable' });
    }

    const data = await response.json();
    let xml = data.message?.content?.[0]?.text || '';

    // Extract XML if wrapped in markdown code blocks
    const xmlMatch = xml.match(/<mxGraphModel[\s\S]*<\/mxGraphModel>/);
    if (xmlMatch) {
      xml = xmlMatch[0];
    }

    // Generate Draw.io URL
    const encodedXml = Buffer.from(xml).toString('base64');
    const drawioUrl = `https://viewer.diagrams.net/?highlight=0000ff&edit=_blank&layers=1&nav=1#R${encodedXml}`;

    res.json({ xml, drawioUrl });
  } catch (err) {
    console.error('Diagram error:', err);
    res.status(500).json({ error: 'Failed to generate diagram' });
  }
});

module.exports = router;
