const imageCacheKey = async value => {
  const bytes = new TextEncoder().encode(value);
  const digest = await window.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const requestJson = async url => {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { throw new Error(body.error || 'Wikipedia could not complete that request.'); }
  return { ...body, _cacheStatus: response.headers.get('X-Wikipedia-Cache') };
};

function initializeWikipediaReader () {
  const form = document.getElementById('wikipedia-search-form');
  const input = document.getElementById('wikipedia-search-input');
  const status = document.getElementById('wikipedia-status');
  const results = document.getElementById('wikipedia-results');
  const article = document.getElementById('wikipedia-article');
  const articleBody = document.getElementById('wikipedia-article-body');
  const backButton = document.getElementById('wikipedia-back');
  const forwardButton = document.getElementById('wikipedia-forward');
  const sourceLink = document.getElementById('wikipedia-source-link');
  let history = [];
  let historyIndex = -1;
  let searchRequest = 0;

  function setStatus (message, isError = false) {
    status.textContent = message;
    status.classList.toggle('text-danger', isError);
  }

  function syncHistoryButtons () {
    backButton.disabled = historyIndex <= 0;
    forwardButton.disabled = historyIndex >= history.length - 1;
  }

  function renderSearchResults (pages) {
    results.replaceChildren();
    if (!pages.length) {
      setStatus('No matching articles found.');
      return;
    }
    setStatus(`${pages.length} articles found`);
    for (const page of pages) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wikipedia-result w-100 text-start';
      button.addEventListener('click', () => openArticle(page.title));
      if (page.thumbnail?.url) {
        const image = document.createElement('img');
        image.src = page.thumbnail.url;
        image.alt = '';
        image.loading = 'lazy';
        button.append(image);
      }
      const text = document.createElement('span');
      const title = document.createElement('span');
      title.className = 'wikipedia-result-title d-block';
      title.textContent = page.title;
      const excerpt = document.createElement('span');
      excerpt.className = 'small text-body-secondary';
      excerpt.textContent = page.description || page.excerpt?.replace(/<[^>]*>/g, '') || '';
      text.append(title, excerpt);
      button.append(text);
      results.append(button);
    }
  }

  function prepareContents (container) {
    const headings = [...container.querySelectorAll('h2, h3')];
    if (headings.length < 3) { return; }
    const contents = document.createElement('details');
    contents.className = 'wikipedia-contents';
    const summary = document.createElement('summary');
    summary.textContent = 'On this page';
    const list = document.createElement('ul');
    for (const [index, heading] of headings.entries()) {
      if (!heading.id) { heading.id = `wikipedia-section-${index + 1}`; }
      const item = document.createElement('li');
      if (heading.tagName === 'H3') { item.className = 'ms-3'; }
      const link = document.createElement('a');
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent;
      link.addEventListener('click', event => {
        event.preventDefault();
        heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      item.append(link);
      list.append(item);
    }
    contents.append(summary, list);
    headings[0].before(contents);
  }

  function prepareDenseSections (container) {
    for (const table of container.querySelectorAll('table.infobox, table.sidebar, .infobox table')) {
      const details = document.createElement('details');
      details.className = 'wikipedia-infobox';
      const summary = document.createElement('summary');
      summary.textContent = 'Article overview';
      table.before(details);
      details.append(summary, table);
    }
    for (const heading of container.querySelectorAll('h2, h3')) {
      if (!/^(references|notes|further reading|external links|bibliography)$/i.test(heading.textContent.trim())) { continue; }
      const details = document.createElement('details');
      details.className = 'wikipedia-references';
      const summary = document.createElement('summary');
      summary.textContent = heading.textContent;
      heading.before(details);
      heading.remove();
      details.append(summary);
      let next = details.nextElementSibling;
      while (next && !/^H[1-3]$/.test(next.tagName)) {
        const current = next;
        next = next.nextElementSibling;
        details.append(current);
      }
    }
  }

  async function prepareImages (container) {
    for (const image of container.querySelectorAll('img')) {
      const source = new URL(image.getAttribute('src') || '', 'https://en.wikipedia.org');
      if (!['upload.wikimedia.org', 'commons.wikimedia.org'].includes(source.hostname)) { image.remove(); continue; }
      const originalUrl = source.href;
      const key = await imageCacheKey(originalUrl);
      const cachedPath = `/api/wikipedia/image-cache/${key}`;
      try {
        const cached = await fetch(cachedPath);
        if (cached.ok) { image.src = cachedPath; continue; }
      } catch {}
      image.src = `/api/wikipedia/image?url=${encodeURIComponent(originalUrl)}`;
      image.loading = 'lazy';
      image.addEventListener('load', async () => {
        try {
          const scale = Math.min(1, 1600 / image.naturalWidth, 1200 / image.naturalHeight);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .82));
          if (!blob) { return; }
          const response = await fetch(`/api/wikipedia/image-cache/${key}`, { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: blob });
          if (response.ok) { image.src = cachedPath; }
        } catch {}
      }, { once: true });
    }
  }

  function wireArticleLinks (container) {
    for (const link of container.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href');
      if (href.startsWith('#')) {
        link.addEventListener('click', event => {
          event.preventDefault();
          const id = decodeURIComponent(href.slice(1));
          const destination = [...articleBody.querySelectorAll('[id]')].find(node => node.id === id);
          destination?.closest('details')?.setAttribute('open', '');
          destination?.scrollIntoView({ block: 'start' });
        });
        continue;
      }
      let target;
      try { target = new URL(href, 'https://en.wikipedia.org/wiki/'); } catch { link.removeAttribute('href'); continue; }
      if (target.hostname === 'en.wikipedia.org' && target.pathname.startsWith('/wiki/')) {
        const title = decodeURIComponent(target.pathname.slice('/wiki/'.length)).replaceAll('_', ' ');
        link.href = `/wiki/${encodeURIComponent(title)}`;
        link.addEventListener('click', event => {
          event.preventDefault();
          openArticle(title, true, target.hash);
        });
      } else if (target.protocol === 'https:' && target.hostname !== window.location.hostname) {
        link.href = target.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else if (target.hash) {
        link.href = target.hash;
      } else {
        link.removeAttribute('href');
      }
    }
  }

  async function showArticle (title, updateHistory = true, fragment = '') {
    setStatus(`Loading ${title}…`);
    results.classList.add('d-none');
    article.classList.remove('d-none');
    articleBody.replaceChildren();
    try {
      const data = await requestJson(`/api/wikipedia/article?title=${encodeURIComponent(title)}`);
      const cleanHtml = window.DOMPurify.sanitize(data.html, {
        FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'input', 'button', 'video', 'audio'],
        FORBID_ATTR: ['style', 'onerror', 'onclick'],
        ADD_ATTR: ['target', 'rel']
      });
      const parsed = document.createElement('div');
      parsed.innerHTML = cleanHtml;
      const content = parsed.querySelector('.mw-content-ltr, .mw-parser-output') || parsed;
      document.getElementById('wikipedia-header-title').textContent = data.title || title;
      prepareDenseSections(content);
      prepareContents(content);
      wireArticleLinks(content);
      articleBody.replaceChildren(...content.childNodes);
      await prepareImages(articleBody);
      document.getElementById('wikipedia-article-scroll').scrollTop = 0;
      if (fragment) {
        const id = decodeURIComponent(fragment.slice(1));
        const destination = [...articleBody.querySelectorAll('[id]')].find(node => node.id === id);
        destination?.closest('details')?.setAttribute('open', '');
        destination?.scrollIntoView({ block: 'start' });
      }
      sourceLink.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(data.title || title).replaceAll('%20', '_')}`;
      sourceLink.textContent = `English Wikipedia: ${data.title || title}`;
      const historyLink = document.getElementById('wikipedia-history-link');
      historyLink.href = `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(data.title || title).replaceAll('%20', '_')}&action=history`;
      setStatus('');
      if (updateHistory) {
        history = history.slice(0, historyIndex + 1);
        history.push(data.title || title);
        historyIndex = history.length - 1;
      }
      syncHistoryButtons();
    } catch (error) {
      article.classList.add('d-none');
      results.classList.remove('d-none');
      setStatus(error.message, true);
    }
  }

  function openArticle (title, updateHistory = true, fragment = '') {
    return showArticle(title, updateHistory, fragment);
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) { input.focus(); setStatus('Enter a topic to search.'); return; }
    const requestId = ++searchRequest;
    results.replaceChildren();
    article.classList.add('d-none');
    results.classList.remove('d-none');
    setStatus('Searching English Wikipedia…');
    try {
      const data = await requestJson(`/api/wikipedia/search?q=${encodeURIComponent(query)}`);
      if (requestId !== searchRequest) { return; }
      renderSearchResults(data.pages || []);
    } catch (error) {
      if (requestId === searchRequest) { setStatus(error.message, true); }
    }
  });

  backButton.addEventListener('click', () => {
    if (historyIndex <= 0) { return; }
    historyIndex--;
    showArticle(history[historyIndex], false);
  });
  forwardButton.addEventListener('click', () => {
    if (historyIndex >= history.length - 1) { return; }
    historyIndex++;
    showArticle(history[historyIndex], false);
  });

  return { openArticle };
}

export default initializeWikipediaReader;
