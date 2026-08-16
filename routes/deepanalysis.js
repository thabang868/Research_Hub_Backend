const express = require('express');
const neo4j = require('neo4j-driver');
const multer = require('multer');
const router = express.Router();
const neo4jDriver = require('../config/neo4j');
const learningEngine = require('../engine/learning');
const smartCache = require('../engine/cache');
const { buildTaskPrompt } = require('../engine/promptEnhancer');
const { optionalAuth, aiLimiter, sanitize } = require('../middleware/security');

const COHERE_URL = 'https://api.cohere.com/v2/chat';

// Extract text from PDF — tries text extraction first, falls back to LLM-based OCR
async function extractPdfText(buffer) {
  let text = '';
  let pages = 0;

  // Step 1: Try standard text extraction with pdf-parse-new
  try {
    const pdfParse = require('pdf-parse-new');
    const data = await pdfParse(buffer);
    text = data.text || '';
    pages = data.numpages || 0;

    // If we got meaningful text (not just whitespace/headers), return it
    if (text.replace(/\s/g, '').length > 100) {
      return { text, pages, method: 'text-extraction' };
    }
  } catch (e) {
    console.log('pdf-parse failed, trying OCR:', e.message);
  }

  // Step 2: Scanned PDF — use Cohere to extract text from the raw content
  // Send whatever partial text we have + ask Cohere to clean/reconstruct it
  try {
    const partialText = text.slice(0, 5000);
    if (partialText.replace(/\s/g, '').length > 20) {
      // We have some garbled text — ask AI to reconstruct
      const response = await fetch(COHERE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'command-a-03-2025',
          messages: [
            { role: 'system', content: 'You are a text reconstruction expert. The user will give you garbled or poorly extracted text from a PDF. Clean it up, fix encoding issues, and reconstruct it into readable text. Preserve the original meaning. If you cannot reconstruct it, return what you can read.' },
            { role: 'user', content: `Reconstruct this poorly extracted PDF text into clean readable text:\n\n${partialText}` },
          ],
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const cleaned = data.message?.content?.[0]?.text || '';
        if (cleaned.replace(/\s/g, '').length > 50) {
          return { text: cleaned, pages, method: 'ai-reconstructed' };
        }
      }
    }
  } catch (e) {
    console.log('AI reconstruction failed:', e.message);
  }

  // Step 3: If both fail, return whatever we have
  return { text: text || 'Could not extract text from this PDF. Please try the manual input option.', pages, method: 'none' };
}

// Multer config — store PDFs in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  },
});

// Upload and extract text from a single PDF
router.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'PDF file is required' });
    }

    const { text, pages, method } = await extractPdfText(req.file.buffer);
    const lines = text.split('\n').filter((l) => l.trim());

    // Try to extract title (first non-empty line that looks like a title)
    let title = lines[0] || 'Untitled';
    if (title.length > 200) title = title.slice(0, 200);

    // Extract abstract if present
    let abstract = '';
    const abstractIdx = lines.findIndex((l) => /^abstract/i.test(l.trim()));
    if (abstractIdx >= 0) {
      abstract = lines.slice(abstractIdx + 1, abstractIdx + 10).join(' ').slice(0, 2000);
    }

    // Full text (truncated for AI)
    const fullText = text.slice(0, 8000);

    res.json({
      title: title.trim(),
      abstract: abstract.trim(),
      fullText,
      pages,
      method,
      fileName: req.file.originalname,
    });
  } catch (err) {
    console.error('PDF upload error:', err);
    res.status(500).json({ error: 'Failed to process PDF' });
  }
});

// Upload multiple PDFs for cross-analysis
router.post('/upload-pdfs', upload.array('pdfs', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: 'At least 2 PDF files are required' });
    }

    const papers = await Promise.all(
      req.files.map(async (file) => {
        try {
          const { text, pages, method } = await extractPdfText(file.buffer);
          const lines = text.split('\n').filter((l) => l.trim());
          let title = lines[0] || file.originalname.replace('.pdf', '');
          if (title.length > 200) title = title.slice(0, 200);

          let abstract = '';
          const abstractIdx = lines.findIndex((l) => /^abstract/i.test(l.trim()));
          if (abstractIdx >= 0) {
            abstract = lines.slice(abstractIdx + 1, abstractIdx + 10).join(' ').slice(0, 2000);
          }

          return {
            title: title.trim(),
            abstract: abstract.trim() || text.slice(0, 2000),
            fileName: file.originalname,
            pages,
            method,
          };
        } catch {
          return {
            title: file.originalname.replace('.pdf', ''),
            abstract: '',
            fileName: file.originalname,
            pages: 0,
            method: 'none',
          };
        }
      })
    );

    res.json({ papers });
  } catch (err) {
    console.error('PDFs upload error:', err);
    res.status(500).json({ error: 'Failed to process PDFs' });
  }
});

// Deep analyze a paper — BMAD enhanced with learning
router.post('/analyze', optionalAuth, aiLimiter, sanitize, async (req, res) => {
  try {
    const { title, abstract, authors, userId } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Paper title is required' });
    }

    const startTime = Date.now();
    const authUserId = req.user?.id || userId || 'anonymous';
    learningEngine.recordQuery(authUserId, title, 'deep_analysis');

    // Step 1: AI analysis — BMAD enhanced with research-grade prompt
    const analysisPrompt = `You are a senior research analyst performing peer-review level analysis. Analyze this paper deeply.

Title: ${title}
${authors?.length ? `Authors: ${authors.join(', ')}` : ''}
${abstract ? `Abstract: ${abstract}` : ''}

Provide a thorough analysis with these sections:

**Summary** — A clear, concise summary of the paper in 3-4 sentences.

**Key Contributions** — What are the main contributions of this paper? List 3-5 specific contributions.

**What is Truly New** — What makes this paper novel or innovative compared to existing work? Be specific about what hasn't been done before.

**Methodology** — What research methods, tools, or frameworks were used?

**Key Concepts** — List 5-8 core concepts, techniques, or terms from this paper.

**Potential Connections** — Suggest 3-5 related research areas, papers, or fields that this work connects to. Explain how they relate.

**Research Gaps Identified** — What limitations or open questions does this paper reveal?

**Practical Implications** — How could this research be applied in practice?

FORMATTING: NEVER use # headings. Use **bold** for section titles. Use numbered/bullet lists. Do NOT include references.`;

    const aiResponse = await fetch(COHERE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'command-a-03-2025',
        messages: [
          { role: 'system', content: 'You are a world-class research analyst who deeply understands academic papers. Provide thorough, insightful analysis. NEVER use # headings. Use **bold** for titles. Do NOT include references.' },
          { role: 'user', content: analysisPrompt },
        ],
      }),
    });

    let analysis = '';
    if (aiResponse.ok) {
      const aiData = await aiResponse.json();
      analysis = aiData.message?.content?.[0]?.text || '';
      analysis = analysis.replace(/^#{1,6}\s+/gm, '');
    }

    // Step 2: Extract keywords from AI analysis for graph connections
    const keywordsPrompt = `From this research paper analysis, extract exactly 8 keywords or key concepts as a JSON array of strings. Return ONLY the JSON array, nothing else.

Title: ${title}
${abstract ? `Abstract: ${abstract}` : ''}`;

    let keywords = [];
    try {
      const kwResponse = await fetch(COHERE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'command-a-03-2025',
          messages: [
            { role: 'system', content: 'Extract keywords. Return ONLY a JSON array of strings. Example: ["machine learning", "NLP"]' },
            { role: 'user', content: keywordsPrompt },
          ],
        }),
      });

      if (kwResponse.ok) {
        const kwData = await kwResponse.json();
        const kwText = kwData.message?.content?.[0]?.text || '[]';
        const match = kwText.match(/\[[\s\S]*\]/);
        if (match) keywords = JSON.parse(match[0]);
      }
    } catch (e) {
      console.error('Keyword extraction error:', e.message);
    }

    // Step 3: Save to Neo4j knowledge graph
    let graphResult = { saved: false };
    if (userId) {
      const session = neo4jDriver.session();
      try {
        await session.run(
          `MERGE (p:Paper {title: $title})
           SET p.abstract = $abstract,
               p.analyzed = true,
               p.analyzedAt = datetime()
           WITH p
           MERGE (u:User {id: $userId})
           MERGE (u)-[:ANALYZED]->(p)
           WITH p
           UNWIND $authors AS authorName
             MERGE (a:Author {name: authorName})
             MERGE (a)-[:AUTHORED]->(p)
           WITH p
           UNWIND $keywords AS kw
             MERGE (k:Keyword {name: kw})
             MERGE (p)-[:TAGGED]->(k)
           RETURN p`,
          {
            title,
            abstract: abstract || '',
            authors: authors || [],
            keywords,
            userId,
          }
        );
        graphResult = { saved: true };
      } catch (e) {
        console.error('Neo4j save error:', e.message);
      } finally {
        await session.close();
      }
    }

    // Step 4: Find connected papers in the graph
    let connections = [];
    if (keywords.length > 0) {
      const session = neo4jDriver.session();
      try {
        const result = await session.run(
          `UNWIND $keywords AS kw
           MATCH (k:Keyword {name: kw})<-[:TAGGED]-(p:Paper)
           WHERE p.title <> $title
           WITH p, COLLECT(DISTINCT kw) AS sharedKeywords, COUNT(DISTINCT kw) AS relevance
           ORDER BY relevance DESC
           LIMIT 5
           RETURN p.title AS title, p.abstract AS abstract, sharedKeywords, relevance`,
          { keywords, title }
        );

        connections = result.records.map((r) => ({
          title: r.get('title'),
          abstract: r.get('abstract'),
          sharedKeywords: r.get('sharedKeywords'),
          relevance: r.get('relevance').toNumber(),
        }));
      } catch (e) {
        console.error('Neo4j connections error:', e.message);
      } finally {
        await session.close();
      }
    }

    // BMAD: Score response quality
    const responseTimeMs = Date.now() - startTime;
    if (analysis) {
      learningEngine.scoreResponse(title, analysis, { responseTimeMs });
    }

    res.json({
      analysis,
      keywords,
      connections,
      graph: graphResult,
      intelligence: { responseTimeMs, qualityTracked: true },
    });
  } catch (err) {
    console.error('Deep analysis error:', err);
    learningEngine.recordFailure('deep_analysis_error', { error: err.message });
    res.status(500).json({ error: 'Failed to analyze paper' });
  }
});

// Cross-paper analysis — BMAD enhanced with learning
router.post('/cross-analyze', optionalAuth, aiLimiter, sanitize, async (req, res) => {
  try {
    const { papers } = req.body;

    if (!papers || papers.length < 2) {
      return res.status(400).json({ error: 'At least 2 papers are required' });
    }

    const papersText = papers.map((p, i) =>
      `Paper ${i + 1}: "${p.title}"${p.abstract ? `\nAbstract: ${p.abstract}` : ''}`
    ).join('\n\n');

    const prompt = `You are a research synthesis expert. Analyze these ${papers.length} papers together to uncover hidden connections and relationships that researchers might miss.

${papersText}

Provide:

**Common Themes** — What themes, concepts, or problems do these papers share?

**Hidden Connections** — What non-obvious relationships exist between these papers? Look for shared methodologies, complementary findings, or conceptual bridges.

**Contradictions** — Do any papers contradict or challenge each other? How?

**Knowledge Gaps** — What gaps become visible when looking at these papers together?

**Synthesis** — If you were to combine the insights from all these papers, what new research direction or hypothesis would emerge?

**Suggested Next Steps** — What should a researcher do next based on this combined knowledge?

FORMATTING: NEVER use # headings. Use **bold** for section titles. Do NOT include references.`;

    const response = await fetch(COHERE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'command-a-03-2025',
        messages: [
          { role: 'system', content: 'You are a research synthesis expert who finds hidden connections across papers. NEVER use # headings. Use **bold** for titles. Do NOT include references.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'AI service unavailable' });
    }

    const data = await response.json();
    let synthesis = data.message?.content?.[0]?.text || '';
    synthesis = synthesis.replace(/^#{1,6}\s+/gm, '');

    // BMAD: Track cross-analysis quality
    const userId = req.user?.id || 'anonymous';
    learningEngine.recordQuery(userId, papers.map(p => p.title).join(' + '), 'cross_analysis');
    if (synthesis) {
      learningEngine.scoreResponse('cross-analyze', synthesis, {});
    }

    res.json({ synthesis });
  } catch (err) {
    console.error('Cross analysis error:', err);
    learningEngine.recordFailure('cross_analysis_error', { error: err.message });
    res.status(500).json({ error: 'Failed to cross-analyze papers' });
  }
});

module.exports = router;
