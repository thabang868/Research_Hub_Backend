# ResearchHub Backend

REST API server powering the ResearchHub platform — a research intelligence system that combines academic paper search, AI-driven analysis, live market data, and knowledge graph storage.

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express 5
- **Database:** Neo4j (knowledge graph), Supabase (auth & storage)
- **AI:** Cohere API (command-a-03-2025)
- **File Processing:** pdf-parse, Tesseract.js (OCR)
- **Authentication:** JWT + bcryptjs

## API Routes

| Route | Description |
|---|---|
| `/api/auth` | User authentication (signup, signin, password reset) |
| `/api/search` | Research paper & dataset search (OpenAlex, CrossRef, arXiv, IEEE, Zenodo, Harvard Dataverse, UCI) |
| `/api/graph` | Neo4j knowledge graph operations (save/retrieve papers, datasets, keywords) |
| `/api/ai` | AI assistant — chat, summarize, suggest, problem statements, methodology diagrams, stock analysis |
| `/api/trending` | Live trending data — news (NewsAPI), market quotes (Finnhub), categorized research (OpenAlex), BERTopic trend detection, FinBERT sentiment analysis, top companies |
| `/api/deep` | Deep research analysis — PDF extraction, cross-paper synthesis |
| `/api/health` | Health check |

## Setup

### 1. Install dependencies

```bash
cd backend
npm install
```

### 2. Configure environment variables

Create a `.env` file in the backend directory:

```env
PORT=10000
CLIENT_URL=https://researchhub-sigma.vercel.app

# Supabase
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_service_key
SUPABASE_ANON_KEY=your_anon_key

# Authentication
JWT_SECRET=your_jwt_secret

# Neo4j
NEO4J_URI=neo4j+s://your_instance.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_password

# AI
COHERE_API_KEY=your_cohere_key

# Search
SEMANTIC_SCHOLAR_KEY=your_key

# News & Market Data
NEWS_API_KEY=your_newsapi_key
FINNHUB_API_KEY=your_finnhub_key
ALPHA_VANTAGE_API_KEY=your_alpha_vantage_key

PAYSTACK_SECRET_KEY=sk_test_replace_me
PAYSTACK_PUBLIC_KEY=pk_test_replace_me
CLIENT_URL=backend_url

```

### 3. Run the server

```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

The production API is hosted at `https://research-hub-backend-wt4p.onrender.com`.

## External APIs

| API | Purpose |
|---|---|
| **OpenAlex** | 250M+ research papers, datasets, trending research |
| **CrossRef** | Research paper metadata |
| **Semantic Scholar** | Paper recommendations |
| **arXiv** | Physics, math, CS preprints |
| **IEEE Xplore** | Engineering papers |
| **Harvard Dataverse** | Research datasets |
| **Zenodo** | Open science repository |
| **UCI ML Repository** | Machine learning datasets |
| **NewsAPI** | Science & tech news |
| **Finnhub** | Live stock quotes, market news, company profiles |
| **Cohere** | LLM for AI assistant, analysis, trend detection, sentiment |

## Neo4j Schema

**Nodes:** User, Paper, Author, Keyword, Dataset, TrendingTopic

**Relationships:** SAVED, AUTHORED, TAGGED, HAS_KEYWORD
