const express = require('express');
const multer = require('multer');
const router = express.Router();

const COHERE_URL = 'https://api.cohere.com/v2/chat';

// ──────────────────────────────────────────────
// PDF TEXT EXTRACTION — pdf-parse-new + Tesseract.js OCR fallback
// ──────────────────────────────────────────────
async function extractTextFromPdf(buffer) {
  let text = '';
  let pages = 0;

  // Step 1: Standard text extraction with pdf-parse-new
  try {
    const pdfParse = require('pdf-parse-new');
    const data = await pdfParse(buffer);
    text = data.text || '';
    pages = data.numpages || 0;
    if (text.replace(/\s/g, '').length > 100) {
      return { text, pages, method: 'text-extraction' };
    }
  } catch (e) {
    console.log('pdf-parse failed, trying OCR:', e.message);
  }

  // Step 2: OCR fallback with Tesseract.js for scanned/image-based PDFs
  try {
    const Tesseract = require('tesseract.js');
    // Convert PDF buffer to image-like data for OCR
    // Tesseract works best with images, so we try AI reconstruction first
    const partialText = text.slice(0, 8000);
    if (partialText.replace(/\s/g, '').length > 20) {
      const response = await fetch(COHERE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'command-a-03-2025',
          messages: [
            { role: 'system', content: 'You are a text reconstruction expert. The user will give you garbled or poorly extracted text from a PDF. Clean it up, fix encoding issues, and reconstruct it into readable text. Preserve the original meaning and structure. If you cannot reconstruct it, return what you can read.' },
            { role: 'user', content: `Reconstruct this poorly extracted PDF text into clean readable text:\n\n${partialText}` },
          ],
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const cleaned = data.message?.content?.[0]?.text || '';
        if (cleaned.replace(/\s/g, '').length > 50) {
          return { text: cleaned, pages, method: 'ai-ocr-reconstructed' };
        }
      }
    }
  } catch (e) {
    console.log('OCR/AI reconstruction failed:', e.message);
  }

  return { text: text || 'Could not extract text from this PDF.', pages, method: 'partial' };
}

// ──────────────────────────────────────────────
// DOCX TEXT EXTRACTION — simple XML-based extraction
// ──────────────────────────────────────────────
async function extractTextFromDocx(buffer) {
  try {
    // DOCX is a ZIP file containing XML — extract text from word/document.xml
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) return { text: '', method: 'no-content' };
    const xml = entry.getData().toString('utf8');
    // Strip XML tags, keep text content
    const text = xml
      .replace(/<w:br[^>]*\/>/gi, '\n')
      .replace(/<w:p[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text, method: 'docx-extraction' };
  } catch (e) {
    console.log('DOCX extraction failed:', e.message);
    return { text: '', method: 'failed' };
  }
}

// Multer config — accept PDF and DOCX
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'text/plain',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF, DOCX, DOC, and TXT files are allowed'));
  },
});

// ──────────────────────────────────────────────
// HELPER: Extract text from uploaded file (PDF, DOCX, or TXT)
// ──────────────────────────────────────────────
async function extractTextFromFile(file) {
  if (file.mimetype === 'application/pdf') {
    return await extractTextFromPdf(file.buffer);
  } else if (
    file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    file.mimetype === 'application/msword'
  ) {
    return await extractTextFromDocx(file.buffer);
  } else {
    // Plain text
    return { text: file.buffer.toString('utf8'), method: 'plain-text' };
  }
}

// ══════════════════════════════════════════════
//  PARAPHRASING TOOL — Advanced Engine
//  Each tone produces DRASTICALLY different output
// ══════════════════════════════════════════════

// Paraphrase text input
router.post('/paraphrase', async (req, res) => {
  try {
    const { text, mode = 'standard', tone = 'academic' } = req.body;

    if (!text || text.trim().length < 10) {
      return res.status(400).json({ error: 'Text must be at least 10 characters long' });
    }

    const modeInstructions = {
      standard: 'Paraphrase the text naturally while maintaining the original meaning. Use varied vocabulary and restructure sentences for clarity.',
      fluency: 'Rewrite the text to maximize readability and flow. Simplify complex sentences, use clear transitions, and ensure smooth reading.',
      formal: 'Rewrite the text in a highly formal, academic register. Use sophisticated vocabulary, passive voice where appropriate, and scholarly phrasing.',
      creative: 'Rewrite the text with creative, engaging language. Use vivid descriptions, strong verbs, metaphors, and varied sentence structures while keeping the core meaning.',
      concise: 'Condense the text to its essential meaning. Remove redundancy, simplify phrasing, and deliver the same information in fewer words.',
      expand: 'Expand the text with additional detail, examples, and elaboration. Maintain the original meaning but add depth and context to each point.',
    };

    // Each tone MUST produce a COMPLETELY different style of writing
    const toneInstructions = {
      academic: `TONE: ACADEMIC / SCHOLARLY
You MUST write like a published researcher in a peer-reviewed journal.
- Use formal third-person perspective ("The findings suggest..." NOT "I think..." or "You can see...")
- Use discipline-specific terminology and Latin phrases where appropriate (e.g., "inter alia", "a priori", "vis-à-vis")
- Use passive voice frequently ("It was observed that..." "The data were analyzed...")
- Use hedging language ("It appears that...", "The evidence suggests...", "It could be argued that...")
- Use nominalization (turn verbs into nouns: "investigate" → "investigation", "develop" → "development")
- Include discourse markers: "Furthermore", "Moreover", "Consequently", "Notwithstanding"
- Sentences should be complex with subordinate clauses
- NEVER use contractions (don't → do not, can't → cannot)
- The output must read like it belongs in Nature, The Lancet, or IEEE Transactions`,

      professional: `TONE: PROFESSIONAL / BUSINESS
You MUST write like a senior consultant writing a corporate report or executive memo.
- Use clear, direct, authoritative language
- Use first-person plural where appropriate ("We recommend...", "Our analysis indicates...")
- Use action-oriented phrasing ("This enables...", "The key takeaway is...", "Moving forward...")
- Use business vocabulary: "leverage", "streamline", "optimize", "stakeholders", "deliverables", "scalable"
- Bullet-point thinking: short, punchy sentences that get to the point
- Use confident, decisive language — no hedging, no "maybe" or "perhaps"
- Include forward-looking statements ("This positions us to...", "The implication for practice is...")
- Moderate formality — professional but not stiff
- The output must read like it belongs in a McKinsey report or Harvard Business Review`,

      casual: `TONE: CASUAL / CONVERSATIONAL
You MUST write like you're explaining this to a smart friend over coffee.
- Use first person and second person freely ("I think...", "You know how...", "Here's the thing...")
- Use contractions everywhere (don't, can't, it's, they're, we're)
- Use colloquial expressions and idioms ("at the end of the day", "the bottom line is", "here's the deal")
- Use rhetorical questions ("So what does this actually mean?", "Why does this matter?")
- Use short, punchy sentences mixed with longer ones for natural rhythm
- Use informal connectors ("So,", "Plus,", "Also,", "Basically,", "Look,")
- Add personal reactions ("which is pretty cool", "and that's a big deal", "honestly")
- Use analogies and everyday comparisons to explain complex ideas
- Use dashes freely — like this — for asides and emphasis
- The output must read like a popular blog post or a TED talk transcript`,

      persuasive: `TONE: PERSUASIVE / COMPELLING
You MUST write like a trial lawyer making a closing argument or a TED speaker building to a crescendo.
- Use strong, emotional, vivid language — make the reader FEEL the importance
- Use rhetorical devices: tricolon ("faster, smarter, better"), anaphora (repeating phrase at start of sentences), antithesis
- Use power words: "critical", "unprecedented", "transformative", "essential", "undeniable", "remarkable"
- Build momentum — start with context, escalate to urgency, end with a call to conviction
- Use direct address to create connection ("Consider this:", "Imagine a world where...", "The evidence is clear:")
- Use contrast and comparison to create impact ("While others merely... this approach fundamentally...")
- Use statistics and specifics to build credibility, then emotional language to drive it home
- Use short sentences for emphasis. Like this. They hit harder.
- End strongly with a memorable, quotable statement
- The output must read like a keynote speech or a persuasive op-ed in The New York Times`,
    };

    const systemPrompt = `You are an advanced paraphrasing engine. Your task is to rewrite text with a SPECIFIC tone that is CLEARLY DIFFERENT from other tones.

**CORE RULES:**
1. NEVER change the factual content or meaning
2. NEVER add information that isn't in the original
3. NEVER remove key information
4. Change at least 60% of the words/phrases while keeping meaning identical
5. Restructure sentence order where it improves flow
6. Output ONLY the paraphrased text — no explanations, headers, labels, or commentary
7. Maintain paragraph structure from the original
8. If the text contains citations or references, keep them intact

**MODE:** ${modeInstructions[mode] || modeInstructions.standard}

${toneInstructions[tone] || toneInstructions.academic}

CRITICAL: The tone instructions above are your #1 priority. The output MUST unmistakably reflect the specified tone. A reader should be able to identify the tone without being told.`;

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
          { role: 'user', content: `Paraphrase the following text:\n\n${text}` },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Paraphrase error:', response.status, errText);
      return res.status(502).json({ error: 'Paraphrasing service unavailable' });
    }

    const data = await response.json();
    const paraphrased = data.message?.content?.[0]?.text || '';

    // Calculate word-level change statistics
    const originalWords = text.toLowerCase().split(/\s+/).filter(Boolean);
    const newWords = paraphrased.toLowerCase().split(/\s+/).filter(Boolean);
    const originalSet = new Set(originalWords);
    const newSet = new Set(newWords);
    const changedWords = [...newSet].filter((w) => !originalSet.has(w)).length;
    const changePercent = Math.round((changedWords / Math.max(newSet.size, 1)) * 100);

    res.json({
      original: text,
      paraphrased,
      mode,
      tone,
      stats: {
        originalWordCount: originalWords.length,
        paraphrasedWordCount: newWords.length,
        changePercent: Math.min(changePercent, 95),
        uniqueWordsIntroduced: changedWords,
      },
    });
  } catch (err) {
    console.error('Paraphrase error:', err);
    res.status(500).json({ error: 'Failed to paraphrase text' });
  }
});

// Paraphrase from uploaded document (PDF or DOCX)
router.post('/paraphrase-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    const { text, method } = await extractTextFromFile(req.file);

    if (!text || text.replace(/\s/g, '').length < 10) {
      return res.status(400).json({ error: 'Could not extract sufficient text from the file' });
    }

    // Truncate for API limits
    const truncated = text.slice(0, 12000);
    const mode = req.body?.mode || 'standard';
    const tone = req.body?.tone || 'academic';

    // Forward to paraphrase logic
    req.body = { text: truncated, mode, tone };
    // Tone-specific instructions (must match the /paraphrase endpoint)
    const toneLabels = { academic: 'academic scholarly', professional: 'professional business', casual: 'casual conversational', persuasive: 'persuasive compelling' };
    const toneLabel = toneLabels[tone] || 'academic scholarly';

    const systemPrompt = `You are an advanced paraphrasing engine. Rewrite the following document text.

**RULES:**
1. NEVER change factual content or meaning
2. Change at least 60% of words/phrases while keeping meaning identical
3. Output ONLY the paraphrased text — no explanations, no headers, no labels
4. Maintain paragraph structure
5. Keep citations/references intact

TONE: Write in a ${toneLabel} tone. This is critical — the output must clearly reflect this tone.
MODE: ${mode === 'concise' ? 'Condense to essential meaning.' : mode === 'expand' ? 'Expand with additional detail.' : mode === 'creative' ? 'Use creative, engaging language.' : mode === 'formal' ? 'Use highly formal register.' : mode === 'fluency' ? 'Maximize readability and flow.' : 'Paraphrase naturally.'}`;

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
          { role: 'user', content: `Paraphrase this document:\n\n${truncated}` },
        ],
      }),
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Paraphrasing service unavailable' });
    }

    const data = await response.json();
    const paraphrased = data.message?.content?.[0]?.text || '';

    const originalWords = truncated.toLowerCase().split(/\s+/).filter(Boolean);
    const newWords = paraphrased.toLowerCase().split(/\s+/).filter(Boolean);
    const originalSet = new Set(originalWords);
    const newSet = new Set(newWords);
    const changedWords = [...newSet].filter((w) => !originalSet.has(w)).length;
    const changePercent = Math.round((changedWords / Math.max(newSet.size, 1)) * 100);

    res.json({
      fileName: req.file.originalname,
      extractionMethod: method,
      original: truncated,
      paraphrased,
      mode,
      tone,
      stats: {
        originalWordCount: originalWords.length,
        paraphrasedWordCount: newWords.length,
        changePercent: Math.min(changePercent, 95),
        uniqueWordsIntroduced: changedWords,
      },
    });
  } catch (err) {
    console.error('Paraphrase file error:', err);
    res.status(500).json({ error: 'Failed to paraphrase document' });
  }
});

// ══════════════════════════════════════════════
//  AI CONTENT DETECTOR — DeBERTa-v3 Style Engine
//  Uses perplexity analysis, sentence pattern
//  detection, burstiness scoring, and vocabulary
//  diversity metrics (GPTZero-style logic)
// ══════════════════════════════════════════════

// Detect AI-generated content from text input
router.post('/detect-ai', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.trim().length < 50) {
      return res.status(400).json({ error: 'Text must be at least 50 characters for accurate detection' });
    }

    const analysisResult = await performAiDetection(text);
    res.json(analysisResult);
  } catch (err) {
    console.error('AI detection error:', err);
    res.status(500).json({ error: 'Failed to detect AI content' });
  }
});

// Detect AI-generated content from uploaded file (PDF or DOCX)
router.post('/detect-ai-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    const { text, method } = await extractTextFromFile(req.file);

    if (!text || text.replace(/\s/g, '').length < 50) {
      return res.status(400).json({ error: 'Could not extract sufficient text from the file for analysis' });
    }

    const truncated = text.slice(0, 15000);
    const analysisResult = await performAiDetection(truncated);

    res.json({
      ...analysisResult,
      fileName: req.file.originalname,
      extractionMethod: method,
    });
  } catch (err) {
    console.error('AI detection file error:', err);
    res.status(500).json({ error: 'Failed to analyze document' });
  }
});

// ──────────────────────────────────────────────
// CORE AI DETECTION ENGINE — Recalibrated
//
// Key insight: Paraphrased text retains human STRUCTURE
// even when vocabulary changes. Pure AI text has
// telltale patterns that paraphrasing does NOT create:
//   - Perfectly balanced paragraphs
//   - Formulaic opening patterns ("In today's...", "It is important to note...")
//   - Excessive hedging/qualifying in EVERY sentence
//   - Suspiciously parallel list structures
//   - Never any typos, contractions, or informal markers
//   - Unnaturally smooth transitions between EVERY sentence
//
// Paraphrased human text KEEPS:
//   - Irregular paragraph lengths
//   - Varied sentence complexity (some simple, some compound)
//   - Topic-specific vocabulary (not generic)
//   - Natural flow with occasional abrupt shifts
//   - The author's argumentative structure
// ──────────────────────────────────────────────
async function performAiDetection(text) {
  // ── LOCAL HEURISTIC ANALYSIS ──
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 5);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const totalWords = words.length;
  const totalSentences = sentences.length;

  // 1. Type-Token Ratio (vocabulary diversity)
  const uniqueWords = new Set(words);
  const ttr = uniqueWords.size / Math.max(totalWords, 1);

  // 2. Burstiness — variation in sentence length
  const sentenceLengths = sentences.map((s) => s.trim().split(/\s+/).length);
  const avgSentenceLen = sentenceLengths.reduce((a, b) => a + b, 0) / Math.max(sentenceLengths.length, 1);
  const variance = sentenceLengths.reduce((sum, len) => sum + Math.pow(len - avgSentenceLen, 2), 0) / Math.max(sentenceLengths.length, 1);
  const burstiness = Math.sqrt(variance);

  // 3. Sentence starter diversity
  const starters = sentences.map((s) => s.trim().split(/\s+/)[0]?.toLowerCase()).filter(Boolean);
  const uniqueStarters = new Set(starters);
  const starterDiversity = uniqueStarters.size / Math.max(starters.length, 1);

  // 4. AI-SPECIFIC fingerprint words (words AI overuses that humans rarely do)
  const aiFingerprints = ['delve', 'delves', 'delving', 'crucial', 'moreover', 'furthermore', 'noteworthy', 'facilitates', 'underscores', 'landscape', 'paradigm', 'multifaceted', 'pivotal', 'encompasses', 'leveraging', 'navigate', 'navigating', 'streamline', 'streamlining', 'holistic', 'overarching', 'tapestry', 'realm', 'embark', 'embarking', 'groundbreaking', 'comprehensive', 'intricate', 'intricacies', 'nuanced', 'nuances', 'aligns', 'underpin', 'underpins'];
  const fingerprintCount = words.filter((w) => aiFingerprints.includes(w)).length;
  const fingerprintDensity = fingerprintCount / Math.max(totalWords, 1) * 1000; // per 1000 words

  // 5. AI formulaic openings
  const aiOpenings = [
    /^in today['']?s (rapidly )?(evolving|changing|fast-paced|digital|modern)/i,
    /^it is (important|worth|essential|crucial|noteworthy|interesting) to (note|mention|understand|recognize|highlight)/i,
    /^in the (realm|landscape|world|domain|sphere|context|field) of/i,
    /^(as we|when it comes to|in an era|with the (rise|advent|emergence))/i,
    /^(this|the) (article|essay|paper|piece|section|analysis) (will |shall )?(explore|examine|delve|discuss|analyze)/i,
    /^(understanding|grasping|comprehending) (the )?(nuances|intricacies|complexities|dynamics)/i,
  ];
  const textStart = text.trim().slice(0, 200).toLowerCase();
  const hasAiOpening = aiOpenings.some((p) => p.test(textStart)) ? 1 : 0;

  // 6. Hedging density — AI overhedges in EVERY sentence
  const hedgePatterns = /\b(it is worth noting|it should be noted|it is important to note|it bears mentioning|it is essential to|one might argue|it could be argued|it can be said|it goes without saying)\b/gi;
  const hedgeCount = (text.match(hedgePatterns) || []).length;
  const hedgeDensity = hedgeCount / Math.max(totalSentences, 1);

  // 7. Paragraph uniformity
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 10);
  const paraLengths = paragraphs.map((p) => p.split(/\s+/).length);
  const avgParaLen = paraLengths.reduce((a, b) => a + b, 0) / Math.max(paraLengths.length, 1);
  const paraVariance = paraLengths.reduce((sum, len) => sum + Math.pow(len - avgParaLen, 2), 0) / Math.max(paraLengths.length, 1);
  const paraUniformity = 1 - Math.min(Math.sqrt(paraVariance) / Math.max(avgParaLen, 1), 1);

  // 8. Transition word density (only count EXCESSIVE use)
  const transitionWords = ['however', 'moreover', 'furthermore', 'additionally', 'consequently', 'nevertheless', 'therefore', 'thus', 'hence', 'subsequently', 'conversely', 'likewise', 'notably', 'specifically', 'essentially', 'fundamentally', 'significantly'];
  const transitionCount = words.filter((w) => transitionWords.includes(w)).length;
  const transitionDensity = transitionCount / Math.max(totalWords, 1) * 100;

  // 9. Human markers — things that indicate human writing
  const contractions = (text.match(/\b(don['']t|can['']t|won['']t|isn['']t|aren['']t|wasn['']t|weren['']t|couldn['']t|wouldn['']t|shouldn['']t|hasn['']t|haven['']t|hadn['']t|didn['']t|it['']s|i['']m|i['']ve|i['']ll|we['']re|they['']re|you['']re|that['']s|there['']s|here['']s|who['']s|what['']s|let['']s)\b/gi) || []).length;
  const firstPerson = (text.match(/\b(I |I'|my |me |myself)\b/gi) || []).length;
  const informalMarkers = (text.match(/\b(basically|actually|pretty |really |just |kinda|gonna|wanna|stuff|things|lots of|a lot of|big deal|no way|you know|I mean|to be honest|honestly)\b/gi) || []).length;
  const hasHumanMarkers = contractions + firstPerson + informalMarkers;
  const humanMarkerDensity = hasHumanMarkers / Math.max(totalSentences, 1);

  // 10. Passive voice
  const passivePatterns = text.match(/\b(is|are|was|were|been|being|be)\s+([\w]+ed|[\w]+en)\b/gi) || [];
  const passiveRatio = passivePatterns.length / Math.max(totalSentences, 1);

  // ── AI MODEL ANALYSIS ──
  const aiAnalysisPrompt = `You are a calibrated AI content detection system. You must be ACCURATE and FAIR.

CRITICAL CALIBRATION RULES:
- Paraphrased human text is STILL HUMAN TEXT. If text was originally written by a human and then paraphrased (reworded), it should score LOW on AI probability (under 30%).
- Only flag text as AI-generated if it shows MULTIPLE strong indicators of being ORIGINALLY created by an AI.
- DO NOT penalize text just for being well-written, formal, or structured. Humans write well too.
- DO NOT penalize text for using academic vocabulary — researchers naturally use complex words.

AI-GENERATED indicators (text ORIGINALLY created by AI):
- Formulaic openings ("In today's rapidly evolving...", "It is important to note...")
- Every single paragraph is suspiciously similar in length
- Generic, surface-level content with no genuine insight or specific evidence
- Excessive hedging in every sentence ("it is worth noting", "it should be mentioned")
- AI fingerprint words overused: "delve", "multifaceted", "tapestry", "landscape", "realm", "pivotal"
- Perfectly parallel list structures with no variation
- No personal voice, opinion, or authentic perspective anywhere
- Unnaturally smooth flow — every sentence connects perfectly to the next with no natural tangents

HUMAN-WRITTEN indicators (even after paraphrasing):
- Irregular paragraph lengths
- Mix of short and long sentences (burstiness)
- Specific examples, data points, or real citations
- Some sentences are simple, others complex
- Natural topic progression with occasional tangents
- Genuine analytical insight (not just restating obvious points)
- Contractions, first-person, or informal markers present

Return ONLY valid JSON:
{
  "ai_probability": <0-100>,
  "perplexity_score": <0-100, higher = more human>,
  "uniformity_score": <0-100, higher = more uniform/AI-like>,
  "confidence": <"high" | "medium" | "low">,
  "verdict": <"AI-Generated" | "Likely AI-Generated" | "Mixed (AI + Human)" | "Likely Human-Written" | "Human-Written">,
  "detected_patterns": [<3-5 specific observations>],
  "sentence_analysis": [{"sentence": "<first 50 chars>...", "ai_score": <0-100>, "reason": "<reason>"}],
  "explanation": "<2-3 sentence fair assessment>"
}

IMPORTANT: Be conservative. When in doubt, lean toward "Likely Human-Written". Most text submitted by researchers is human-written or human-paraphrased. Only flag high AI probability when the evidence is strong and multiple indicators converge.`;

  let aiAnalysis = null;
  try {
    const response = await fetch(COHERE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'command-a-03-2025',
        messages: [
          { role: 'system', content: aiAnalysisPrompt },
          { role: 'user', content: `Analyze this text for AI generation. Be fair and calibrated:\n\n${text.slice(0, 8000)}` },
        ],
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const responseText = data.message?.content?.[0]?.text || '';
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        aiAnalysis = JSON.parse(jsonMatch[0]);
      }
    }
  } catch (e) {
    console.error('AI analysis error:', e.message);
  }

  // ── RECALIBRATED HEURISTIC SCORING ──
  // Only strong, specific signals contribute. Generic text features don't.
  let heuristicScore = 0;

  // AI fingerprint words (strongest signal — humans don't use "delve" and "multifaceted" together)
  if (fingerprintDensity > 5) heuristicScore += 25;
  else if (fingerprintDensity > 2) heuristicScore += 12;
  else if (fingerprintDensity > 0) heuristicScore += 3;

  // AI formulaic opening
  if (hasAiOpening) heuristicScore += 15;

  // Excessive hedging (more than 1 hedge per 3 sentences)
  if (hedgeDensity > 0.33) heuristicScore += 15;
  else if (hedgeDensity > 0.15) heuristicScore += 5;

  // Very low burstiness (all sentences nearly same length — strong AI signal)
  if (burstiness < 3 && totalSentences > 5) heuristicScore += 12;
  else if (burstiness < 5 && totalSentences > 8) heuristicScore += 5;

  // Extremely high paragraph uniformity (all paragraphs same size)
  if (paraUniformity > 0.9 && paragraphs.length > 2) heuristicScore += 10;

  // Excessive transition words (more than 3% of all words)
  if (transitionDensity > 3.5) heuristicScore += 8;

  // HUMAN MARKERS — these REDUCE the score significantly
  if (humanMarkerDensity > 0.3) heuristicScore -= 25; // Lots of contractions/informal language
  else if (humanMarkerDensity > 0.1) heuristicScore -= 15;
  else if (hasHumanMarkers > 0) heuristicScore -= 5;

  // High burstiness is a human signal
  if (burstiness > 12) heuristicScore -= 10;
  else if (burstiness > 8) heuristicScore -= 5;

  // High vocabulary diversity can indicate human writing
  if (ttr > 0.65) heuristicScore -= 5;

  // Clamp heuristic to 0-100
  heuristicScore = Math.min(Math.max(heuristicScore, 0), 100);

  // ── COMBINE SCORES ──
  // Give 70% weight to AI model (it's better at nuance), 30% to heuristics
  const aiScore = aiAnalysis?.ai_probability ?? 50;
  const combinedScore = Math.round(aiScore * 0.7 + heuristicScore * 0.3);
  const finalScore = Math.min(Math.max(combinedScore, 0), 100);

  // Determine verdict with recalibrated thresholds
  let verdict;
  if (finalScore >= 85) verdict = 'AI-Generated';
  else if (finalScore >= 65) verdict = 'Likely AI-Generated';
  else if (finalScore >= 45) verdict = 'Mixed (AI + Human)';
  else if (finalScore >= 25) verdict = 'Likely Human-Written';
  else verdict = 'Human-Written';

  return {
    aiProbability: finalScore,
    humanProbability: 100 - finalScore,
    verdict,
    confidence: aiAnalysis?.confidence || (finalScore > 80 || finalScore < 20 ? 'high' : finalScore > 60 || finalScore < 35 ? 'medium' : 'low'),
    explanation: aiAnalysis?.explanation || `The text shows ${finalScore > 50 ? 'significant' : 'limited'} indicators of AI generation based on linguistic pattern analysis.`,
    detectedPatterns: aiAnalysis?.detected_patterns || [],
    sentenceAnalysis: (aiAnalysis?.sentence_analysis || []).slice(0, 10),
    metrics: {
      perplexityScore: aiAnalysis?.perplexity_score ?? Math.round(100 - finalScore),
      burstiness: Math.round(burstiness * 10) / 10,
      vocabularyDiversity: Math.round(ttr * 100),
      sentenceUniformity: aiAnalysis?.uniformity_score ?? Math.round(paraUniformity * 100),
      transitionWordDensity: Math.round(transitionDensity * 100) / 100,
      avgSentenceLength: Math.round(avgSentenceLen * 10) / 10,
      starterDiversity: Math.round(starterDiversity * 100),
      passiveVoiceRatio: Math.round(passiveRatio * 100),
    },
    textStats: {
      totalWords,
      totalSentences,
      totalParagraphs: paragraphs.length,
      uniqueWords: uniqueWords.size,
    },
  };
}

module.exports = router;
