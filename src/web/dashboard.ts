/** Returns a self-contained HTML dashboard for browsing and searching the knowledge base. */
export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LibScope Dashboard</title>
<style>
  :root {
    --bg: #fff; --bg2: #f5f5f5; --fg: #1a1a1a; --fg2: #555;
    --border: #ddd; --accent: #2563eb; --accent-hover: #1d4ed8;
    --card-bg: #fff; --danger: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f0f0f; --bg2: #1a1a1a; --fg: #e5e5e5; --fg2: #999;
      --border: #333; --accent: #3b82f6; --accent-hover: #60a5fa;
      --card-bg: #1a1a1a; --danger: #ef4444;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--fg); line-height: 1.5;
  }
  header {
    background: var(--bg2); border-bottom: 1px solid var(--border);
    padding: 12px 24px; display: flex; align-items: center; gap: 16px;
  }
  header h1 { font-size: 18px; font-weight: 600; }
  .stats { display: flex; gap: 16px; margin-left: auto; font-size: 13px; color: var(--fg2); }
  .stats span { background: var(--bg); padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); }
  .layout { display: flex; height: calc(100vh - 53px); }
  .sidebar {
    width: 220px; min-width: 220px; border-right: 1px solid var(--border);
    padding: 16px; overflow-y: auto; background: var(--bg2);
  }
  .sidebar h3 { font-size: 12px; text-transform: uppercase; color: var(--fg2); margin-bottom: 8px; letter-spacing: 0.5px; }
  .topic-list { list-style: none; }
  .topic-list li {
    padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 14px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .topic-list li:hover, .topic-list li.active { background: var(--accent); color: #fff; }
  .topic-list .count { font-size: 11px; opacity: 0.7; }
  .main { flex: 1; overflow-y: auto; padding: 20px 24px; }
  .search-bar {
    display: flex; gap: 8px; margin-bottom: 20px;
  }
  .search-bar input {
    flex: 1; padding: 10px 14px; border: 1px solid var(--border); border-radius: 6px;
    font-size: 15px; background: var(--bg); color: var(--fg); outline: none;
  }
  .search-bar input:focus { border-color: var(--accent); }
  .search-bar button {
    padding: 10px 20px; background: var(--accent); color: #fff; border: none;
    border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;
  }
  .search-bar button:hover { background: var(--accent-hover); }
  .card {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 14px 18px; margin-bottom: 10px; cursor: pointer; transition: border-color 0.15s;
  }
  .card:hover { border-color: var(--accent); }
  .card h4 { font-size: 15px; margin-bottom: 4px; }
  .card .meta { font-size: 12px; color: var(--fg2); display: flex; gap: 12px; flex-wrap: wrap; }
  .card .preview { font-size: 13px; color: var(--fg2); margin-top: 6px; }
  .card .score { color: var(--accent); font-weight: 600; }
  .pagination { display: flex; gap: 8px; margin-top: 16px; justify-content: center; }
  .pagination button {
    padding: 6px 14px; border: 1px solid var(--border); border-radius: 4px;
    background: var(--bg); color: var(--fg); cursor: pointer; font-size: 13px;
  }
  .pagination button:disabled { opacity: 0.4; cursor: default; }
  .pagination button:hover:not(:disabled) { border-color: var(--accent); }
  .detail { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 20px; }
  .detail h2 { font-size: 20px; margin-bottom: 12px; }
  .detail .meta { font-size: 13px; color: var(--fg2); margin-bottom: 16px; display: flex; gap: 16px; flex-wrap: wrap; }
  .detail .content { white-space: pre-wrap; font-size: 14px; line-height: 1.7; }
  .detail .actions { margin-top: 16px; display: flex; gap: 8px; }
  .btn-back {
    padding: 6px 14px; border: 1px solid var(--border); border-radius: 4px;
    background: var(--bg); color: var(--fg); cursor: pointer; font-size: 13px;
  }
  .btn-danger {
    padding: 6px 14px; border: 1px solid var(--danger); border-radius: 4px;
    background: transparent; color: var(--danger); cursor: pointer; font-size: 13px;
  }
  .empty { text-align: center; color: var(--fg2); padding: 40px; font-size: 14px; }
</style>
</head>
<body>
<header>
  <h1>📚 LibScope</h1>
  <div class="stats" id="stats"></div>
</header>
<div class="layout">
  <aside class="sidebar">
    <h3>Topics</h3>
    <ul class="topic-list" id="topic-list">
      <li class="active" data-topic="">All Documents</li>
    </ul>
  </aside>
  <main class="main" id="main">
    <div class="search-bar">
      <input type="text" id="search-input" placeholder="Search documents…">
      <button onclick="doSearch()">Search</button>
    </div>
    <div id="content"></div>
    <div class="pagination" id="pagination"></div>
  </main>
</div>
<script>
  let currentTopic = '';
  let currentOffset = 0;
  const PAGE_SIZE = 20;
  let searchTimeout;

  const $content = document.getElementById('content');
  const $pagination = document.getElementById('pagination');
  const $searchInput = document.getElementById('search-input');
  const $stats = document.getElementById('stats');
  const $topicList = document.getElementById('topic-list');

  async function api(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(res.statusText);
    return res.json();
  }

  async function loadStats() {
    try {
      const s = await api('/api/stats');
      $stats.innerHTML =
        '<span>Docs: ' + s.documentCount + '</span>' +
        '<span>Topics: ' + s.topicCount + '</span>' +
        '<span>Chunks: ' + s.chunkCount + '</span>';
    } catch { $stats.innerHTML = ''; }
  }

  async function loadTopics() {
    try {
      const topics = await api('/api/topics');
      let html = '<li class="active" data-topic="" onclick="selectTopic(this, \\'\\')">All Documents</li>';
      for (const t of topics) {
        html += '<li data-topic="' + t.id + '" onclick="selectTopic(this, \\'' + t.id + '\\')">'
          + '<span>' + esc(t.name) + '</span><span class="count">' + (t.documentCount || 0) + '</span></li>';
      }
      $topicList.innerHTML = html;
    } catch {}
  }

  function selectTopic(el, topicId) {
    currentTopic = topicId;
    currentOffset = 0;
    document.querySelectorAll('.topic-list li').forEach(li => li.classList.remove('active'));
    el.classList.add('active');
    $searchInput.value = '';
    loadDocuments();
  }

  async function loadDocuments() {
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(currentOffset) });
      if (currentTopic) params.set('topic', currentTopic);
      const docs = await api('/api/documents?' + params);
      if (!docs.length) {
        $content.innerHTML = '<div class="empty">No documents found.</div>';
        $pagination.innerHTML = '';
        return;
      }
      $content.innerHTML = docs.map(d =>
        '<div class="card" onclick="showDocument(\\'' + d.id + '\\')">' +
          '<h4>' + esc(d.title) + '</h4>' +
          '<div class="meta">' +
            '<span>' + d.sourceType + '</span>' +
            (d.library ? '<span>' + esc(d.library) + (d.version ? ' v' + esc(d.version) : '') + '</span>' : '') +
            '<span>' + d.updatedAt + '</span>' +
          '</div>' +
        '</div>'
      ).join('');
      renderPagination(docs.length);
    } catch (e) {
      $content.innerHTML = '<div class="empty">Error loading documents.</div>';
    }
  }

  function renderPagination(count) {
    const hasPrev = currentOffset > 0;
    const hasNext = count === PAGE_SIZE;
    $pagination.innerHTML =
      '<button ' + (hasPrev ? '' : 'disabled') + ' onclick="changePage(-1)">← Prev</button>' +
      '<button ' + (hasNext ? '' : 'disabled') + ' onclick="changePage(1)">Next →</button>';
  }

  function changePage(dir) {
    currentOffset += dir * PAGE_SIZE;
    if (currentOffset < 0) currentOffset = 0;
    if ($searchInput.value.trim()) doSearch(); else loadDocuments();
  }

  async function doSearch() {
    const q = $searchInput.value.trim();
    if (!q) { currentOffset = 0; loadDocuments(); return; }
    try {
      const params = new URLSearchParams({ q, limit: String(PAGE_SIZE) });
      if (currentTopic) params.set('topic', currentTopic);
      const data = await api('/api/search?' + params);
      if (!data.results || !data.results.length) {
        $content.innerHTML = '<div class="empty">No results for "' + esc(q) + '"</div>';
        $pagination.innerHTML = '';
        return;
      }
      $content.innerHTML = data.results.map(r =>
        '<div class="card" onclick="showDocument(\\'' + r.documentId + '\\')">' +
          '<h4>' + esc(r.title) + ' <span class="score">' + r.score.toFixed(2) + '</span></h4>' +
          '<div class="preview">' + esc(r.content.slice(0, 200)) + '</div>' +
          '<div class="meta">' +
            '<span>' + r.sourceType + '</span>' +
            (r.library ? '<span>' + esc(r.library) + '</span>' : '') +
          '</div>' +
        '</div>'
      ).join('');
      $pagination.innerHTML = '';
    } catch {
      $content.innerHTML = '<div class="empty">Search failed.</div>';
    }
  }

  async function showDocument(id) {
    try {
      const d = await api('/api/documents/' + id);
      $pagination.innerHTML = '';
      $content.innerHTML =
        '<div class="detail">' +
          '<div class="actions">' +
            '<button class="btn-back" onclick="goBack()">← Back</button>' +
            '<button class="btn-danger" onclick="deleteDoc(\\'' + id + '\\')">Delete</button>' +
          '</div>' +
          '<h2>' + esc(d.title) + '</h2>' +
          '<div class="meta">' +
            '<span>ID: ' + d.id + '</span>' +
            '<span>Type: ' + d.sourceType + '</span>' +
            (d.library ? '<span>Library: ' + esc(d.library) + (d.version ? ' v' + esc(d.version) : '') + '</span>' : '') +
            (d.url ? '<span>URL: <a href="' + esc(d.url) + '" target="_blank">' + esc(d.url) + '</a></span>' : '') +
            '<span>Created: ' + d.createdAt + '</span>' +
            '<span>Updated: ' + d.updatedAt + '</span>' +
          '</div>' +
          '<div class="content">' + esc(d.content) + '</div>' +
        '</div>';
    } catch {
      $content.innerHTML = '<div class="empty">Document not found.</div>';
    }
  }

  async function deleteDoc(id) {
    if (!confirm('Delete this document?')) return;
    try {
      await fetch('/api/documents/' + id, { method: 'DELETE' });
      goBack();
      loadStats();
      loadTopics();
    } catch {}
  }

  function goBack() {
    if ($searchInput.value.trim()) doSearch(); else loadDocuments();
  }

  function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  $searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      currentOffset = 0;
      if ($searchInput.value.trim()) doSearch(); else loadDocuments();
    }, 300);
  });

  $searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { currentOffset = 0; doSearch(); }
  });

  loadStats();
  loadTopics();
  loadDocuments();
</script>
</body>
</html>`;
}
