// ===== BookBrief — Client-side app (Groq API) =====

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ===== DOM refs =====
const views = {
  search:  document.getElementById('search-view'),
  loading: document.getElementById('loading-view'),
  article: document.getElementById('article-view'),
  error:   document.getElementById('error-view'),
};
const form           = document.getElementById('search-form');
const bookQueryInput = document.getElementById('book-query');
const isbnInput      = document.getElementById('isbn');
const modePrefSelect = document.getElementById('mode-pref');
const focusInput     = document.getElementById('focus');
const apiKeyInput    = document.getElementById('api-key');
const generateBtn    = document.getElementById('generate-btn');
const btnText        = generateBtn.querySelector('.btn-text');
const btnLoading     = generateBtn.querySelector('.btn-loading');
const loadingStatus  = document.getElementById('loading-status');
const loadingBar     = document.getElementById('loading-bar');
const articleContent = document.getElementById('article-content');
const backBtn        = document.getElementById('back-btn');
const errorMessage   = document.getElementById('error-message');
const errorBackBtn   = document.getElementById('error-back-btn');
const logoLink       = document.getElementById('logo-link');
const historySection = document.getElementById('history-section');
const historyList    = document.getElementById('history-list');

// ===== View switching =====
function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle('active', key === name);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== Local storage helpers =====
function getApiKey() {
  return localStorage.getItem('bookbrief_api_key') || '';
}
function saveApiKey(key) {
  localStorage.setItem('bookbrief_api_key', key);
}
function getHistory() {
  try { return JSON.parse(localStorage.getItem('bookbrief_history') || '[]'); }
  catch { return []; }
}
function saveHistory(history) {
  localStorage.setItem('bookbrief_history', JSON.stringify(history));
}
function addToHistory(query, html) {
  const history = getHistory();
  history.unshift({ query, html, date: new Date().toISOString() });
  if (history.length > 20) history.pop();
  saveHistory(history);
  renderHistory();
}
function deleteFromHistory(index) {
  const history = getHistory();
  history.splice(index, 1);
  saveHistory(history);
  renderHistory();
}

// ===== Render history =====
function renderHistory() {
  const history = getHistory();
  if (history.length === 0) {
    historySection.hidden = true;
    return;
  }
  historySection.hidden = false;
  historyList.innerHTML = '';
  history.forEach((item, i) => {
    const li = document.createElement('li');
    const dateStr = new Date(item.date).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric'
    });
    li.innerHTML = `
      <span class="history-query">${escapeHtml(item.query)}</span>
      <span style="display:flex;align-items:center;gap:0.5rem;">
        <span class="history-date">${dateStr}</span>
        <button class="history-delete" data-index="${i}" title="Delete">&times;</button>
      </span>
    `;
    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('history-delete')) {
        e.stopPropagation();
        deleteFromHistory(parseInt(e.target.dataset.index));
        return;
      }
      articleContent.innerHTML = item.html;
      attachTocToggle();
      showView('article');
    });
    historyList.appendChild(li);
  });
}

// ===== Build system prompt =====
function buildSystemPrompt(config) {
  return `You are BookBrief, a book-analysis engine.

GOAL: Given a book identifier, generate an accessible, well-structured summary of the book's arguments, evidence, and intellectual context.

CONFIG:
- BOOK_QUERY: "${config.bookQuery}"
${config.isbn ? `- ISBN: "${config.isbn}"` : ''}
- MODE_PREFERENCE: "${config.mode}"
- TARGET_LANGUAGE: "English (UK)"
- MAX_QUOTE_WORDS_PER_SOURCE: 25
${config.focus ? `- OPTIONAL_FOCUS: ${JSON.stringify(config.focus)}` : ''}

MODE: You are operating in COPYRIGHT-SAFE mode (Mode B). No full text has been provided.
Target length: 1,200–2,000 words (hard cap 2,100).

You are writing an "explainer", not a replacement text:
- High-level thesis, major argumentative moves, and what kinds of evidence are claimed.
- Clear separation between (a) what the book itself states, (b) what reviewers report, and (c) your inference.
- Maximum 25 words verbatim from any single source. Paraphrase the rest.
- If something is uncertain, label it as uncertain and explain why.

OUTPUT FORMAT: You must return ONLY valid HTML (no markdown, no code fences, no wrapping).

The HTML must follow this structure exactly:

<header class="article-header">
  <div class="meta-badges">
    <span class="badge badge-mode">Copyright-Safe</span>
    <span class="badge badge-genre">[GENRE]</span>
    <span class="badge badge-length">~[WORD_COUNT] words</span>
  </div>
  <h1 class="article-title">[BOOK TITLE]</h1>
  <p class="article-subtitle">[SUBTITLE IF ANY]</p>
  <div class="author-row">
    <div class="author-info">
      <span class="author-label">by</span>
      <span class="author-name">[AUTHOR]</span>
    </div>
    <div class="pub-info">
      <span>[PUBLISHER, YEAR]</span>
      <span class="sep">&middot;</span>
      <span>[PAGE COUNT] pp</span>
      <span class="sep">&middot;</span>
      <span>ISBN [ISBN]</span>
    </div>
  </div>
</header>

<div class="toc-card">
  <button class="toc-toggle" aria-expanded="false" aria-controls="toc-list">
    <span class="toc-label">Contents</span>
    <svg class="toc-chevron" width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M6 8l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>
  <ol id="toc-list" class="toc-list" hidden>
    [LIST OF <li><a href="#section-id">Section Title</a></li> entries]
  </ol>
</div>

Then the article body as a series of <section id="..."><h2>...</h2><p>...</p>...</section> blocks.

End with a sources section:
<section id="sources" class="sources-section">
  <h2>Sources</h2>
  <p class="sources-note">This summary was produced in <strong>Copyright-Safe mode</strong>. Information was gathered from publicly available sources:</p>
  <ul class="source-list">
    <li><a href="[URL]" target="_blank" rel="noopener">[SOURCE DESCRIPTION]</a></li>
    ...
  </ul>
</section>

STYLE: English (UK). Clear, precise, non-florid. Blog-post style similar to Substack or Medium. No "book review" tone — focus on mapping the argument and evidence. Be explicit about uncertainty and evidence level.

IMPORTANT: Return ONLY the HTML content. No preamble, no code fences, no markdown. Start with <header and end with </section>.`;
}

// ===== Call Groq API =====
async function callGroq(apiKey, systemPrompt, userMessage) {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 8192,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    let detail = '';
    try {
      const parsed = JSON.parse(errBody);
      detail = parsed.error?.message || errBody;
    } catch {
      detail = errBody;
    }
    throw new Error(`Groq API error (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    const reason = data.choices?.[0]?.finish_reason;
    throw new Error(`Empty response from Groq${reason ? ' (reason: ' + reason + ')' : ''}`);
  }
  return text;
}

// ===== Clean HTML response =====
function cleanHtml(raw) {
  let html = raw.trim();
  // Strip code fences if present
  html = html.replace(/^```html?\s*/i, '').replace(/\s*```$/i, '');
  // Strip any leading text before <header
  const headerIdx = html.indexOf('<header');
  if (headerIdx > 0) html = html.substring(headerIdx);
  return html;
}

// ===== Loading progress simulation =====
function simulateProgress() {
  let progress = 0;
  const interval = setInterval(() => {
    progress += Math.random() * 12;
    if (progress > 92) progress = 92;
    loadingBar.style.width = progress + '%';
  }, 300);
  return () => {
    clearInterval(interval);
    loadingBar.style.width = '100%';
  };
}

// ===== TOC toggle =====
function attachTocToggle() {
  const toggle = articleContent.querySelector('.toc-toggle');
  const list = articleContent.querySelector('#toc-list');
  if (toggle && list) {
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', !expanded);
      list.hidden = expanded;
    });
  }
}

// ===== Escape HTML =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== Main generate flow =====
async function generate(config) {
  showView('loading');
  loadingBar.style.width = '0%';
  loadingStatus.textContent = 'Sending request to Groq\u2026';

  const stopProgress = simulateProgress();

  try {
    const systemPrompt = buildSystemPrompt(config);
    const userMessage = `Generate a BookBrief summary for: ${config.bookQuery}${config.isbn ? ' (ISBN: ' + config.isbn + ')' : ''}${config.focus ? '. Focus on: ' + config.focus.join(', ') : ''}`;

    loadingStatus.textContent = 'Groq is analysing the book\u2026';

    const rawHtml = await callGroq(config.apiKey, systemPrompt, userMessage);
    const html = cleanHtml(rawHtml);

    stopProgress();

    articleContent.innerHTML = html;
    attachTocToggle();
    addToHistory(config.bookQuery, html);
    showView('article');
  } catch (err) {
    stopProgress();
    errorMessage.textContent = err.message;
    showView('error');
  }
}

// ===== Event listeners =====
form.addEventListener('submit', (e) => {
  e.preventDefault();

  const apiKey = apiKeyInput.value.trim() || getApiKey();
  if (!apiKey) {
    apiKeyInput.focus();
    apiKeyInput.setCustomValidity('API key is required');
    apiKeyInput.reportValidity();
    return;
  }
  saveApiKey(apiKey);

  const bookQuery = bookQueryInput.value.trim();
  if (!bookQuery) return;

  const config = {
    bookQuery,
    isbn: isbnInput.value.trim() || null,
    mode: modePrefSelect.value,
    focus: focusInput.value.trim()
      ? focusInput.value.split(',').map(s => s.trim()).filter(Boolean)
      : null,
    apiKey,
  };

  generate(config);
});

backBtn.addEventListener('click', () => showView('search'));
errorBackBtn.addEventListener('click', () => showView('search'));
logoLink.addEventListener('click', (e) => {
  e.preventDefault();
  showView('search');
});

// ===== Init =====
(function init() {
  const saved = getApiKey();
  if (saved) apiKeyInput.value = saved;
  renderHistory();
})();
