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
  <a href="/graph" style="color:var(--accent);text-decoration:none;font-size:14px;">📊 Knowledge Graph</a>
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
    } catch (e) { $stats.innerHTML = ''; console.error('loadStats failed', e); }
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
    } catch (e) { console.error('loadTopics failed', e); }
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
        '<div class="card" data-doc-id="' + escAttr(d.id) + '">' +
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
        '<div class="card" data-doc-id="' + escAttr(r.documentId) + '">' +
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
            '<button class="btn-danger" data-delete-id="' + escAttr(id) + '">Delete</button>' +
          '</div>' +
          '<h2>' + esc(d.title) + '</h2>' +
          '<div class="meta">' +
            '<span>ID: ' + esc(d.id) + '</span>' +
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
    } catch (e) { console.error('deleteDoc failed', e); }
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

  function escAttr(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Event delegation for cards and delete buttons
  document.addEventListener('click', function(e) {
    const card = e.target.closest('.card[data-doc-id]');
    if (card) { showDocument(card.getAttribute('data-doc-id')); return; }
    const delBtn = e.target.closest('[data-delete-id]');
    if (delBtn) { deleteDoc(delBtn.getAttribute('data-delete-id')); return; }
  });

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

/** Returns a self-contained HTML page for the knowledge graph visualization. */
export function getGraphPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LibScope — Knowledge Graph</title>
<script src="https://d3js.org/d3.v7.min.js"><\/script>
<style>
  :root {
    --bg: #fff; --bg2: #f5f5f5; --fg: #1a1a1a; --fg2: #555;
    --border: #ddd; --accent: #2563eb;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f0f0f; --bg2: #1a1a1a; --fg: #e5e5e5; --fg2: #999;
      --border: #333; --accent: #3b82f6;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--fg);
  }
  header {
    background: var(--bg2); border-bottom: 1px solid var(--border);
    padding: 12px 24px; display: flex; align-items: center; gap: 16px;
  }
  header h1 { font-size: 18px; font-weight: 600; }
  header a { color: var(--accent); text-decoration: none; font-size: 14px; }
  .controls {
    padding: 12px 24px; background: var(--bg2); border-bottom: 1px solid var(--border);
    display: flex; gap: 16px; align-items: center; flex-wrap: wrap; font-size: 14px;
  }
  .controls label { color: var(--fg2); }
  .controls select, .controls input[type="range"] { font-size: 13px; }
  .controls .slider-val { min-width: 36px; text-align: center; }
  #graph-container { width: 100%; height: calc(100vh - 105px); }
  svg { width: 100%; height: 100%; }
  .tooltip {
    position: absolute; background: var(--bg2); border: 1px solid var(--border);
    border-radius: 4px; padding: 6px 10px; font-size: 13px; pointer-events: none;
    display: none; z-index: 10;
  }
  .legend { position: absolute; bottom: 20px; left: 20px; font-size: 12px; }
  .legend span {
    display: inline-flex; align-items: center; gap: 4px; margin-right: 12px;
  }
  .legend .dot {
    width: 10px; height: 10px; border-radius: 50%; display: inline-block;
  }
</style>
</head>
<body>
<header>
  <h1>📊 Knowledge Graph</h1>
  <a href="/">← Dashboard</a>
</header>
<div class="controls">
  <label>Topic:
    <select id="topic-filter"><option value="">All</option></select>
  </label>
  <label>Similarity threshold:
    <input type="range" id="threshold-slider" min="0.5" max="1.0" step="0.05" value="0.85">
    <span class="slider-val" id="threshold-val">0.85</span>
  </label>
  <button id="refresh-btn" style="padding:4px 12px;cursor:pointer;">Refresh</button>
</div>
<div id="graph-container">
  <svg id="graph-svg"></svg>
</div>
<div class="tooltip" id="tooltip"></div>
<div class="legend">
  <span><span class="dot" style="background:#3b82f6"></span> Document</span>
  <span><span class="dot" style="background:#22c55e"></span> Topic</span>
  <span><span class="dot" style="background:#f97316"></span> Tag</span>
</div>
<script>
  const colorMap = { document: '#3b82f6', topic: '#22c55e', tag: '#f97316' };
  const $tooltip = document.getElementById('tooltip');
  const $topicFilter = document.getElementById('topic-filter');
  const $thresholdSlider = document.getElementById('threshold-slider');
  const $thresholdVal = document.getElementById('threshold-val');
  const svg = d3.select('#graph-svg');
  let simulation;

  $thresholdSlider.addEventListener('input', () => {
    $thresholdVal.textContent = $thresholdSlider.value;
  });

  document.getElementById('refresh-btn').addEventListener('click', loadGraph);

  async function loadTopics() {
    try {
      const res = await fetch('/api/topics');
      const topics = await res.json();
      for (const t of topics) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        $topicFilter.appendChild(opt);
      }
    } catch (e) { console.error('loadTopics failed', e); }
  }

  function connectionCount(nodeId, edges) {
    let count = 0;
    for (const e of edges) {
      if (e.source === nodeId || e.target === nodeId ||
          (e.source && e.source.id === nodeId) || (e.target && e.target.id === nodeId)) {
        count++;
      }
    }
    return count;
  }

  async function loadGraph() {
    const params = new URLSearchParams();
    params.set('threshold', $thresholdSlider.value);
    params.set('maxNodes', '200');
    const topic = $topicFilter.value;
    if (topic) params.set('topic', topic);

    let data;
    try {
      const res = await fetch('/api/graph?' + params);
      data = await res.json();
    } catch { return; }

    svg.selectAll('*').remove();
    if (simulation) simulation.stop();

    const width = document.getElementById('graph-container').clientWidth;
    const height = document.getElementById('graph-container').clientHeight;

    const g = svg.append('g');

    svg.call(d3.zoom().on('zoom', (event) => {
      g.attr('transform', event.transform);
    }));

    const link = g.append('g')
      .selectAll('line')
      .data(data.edges)
      .join('line')
      .attr('stroke', '#666')
      .attr('stroke-opacity', d => d.type === 'similar_to' ? d.weight * 0.6 : 0.3)
      .attr('stroke-width', d => d.type === 'similar_to' ? d.weight * 2 : 1);

    const node = g.append('g')
      .selectAll('circle')
      .data(data.nodes)
      .join('circle')
      .attr('r', d => {
        if (d.type !== 'document') return 6;
        return Math.max(5, Math.min(16, 4 + connectionCount(d.id, data.edges) * 2));
      })
      .attr('fill', d => colorMap[d.type] || '#999')
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)
      .style('cursor', 'pointer')
      .call(d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended))
      .on('mouseover', (event, d) => {
        $tooltip.style.display = 'block';
        $tooltip.textContent = d.label;
        $tooltip.style.left = (event.pageX + 12) + 'px';
        $tooltip.style.top = (event.pageY - 12) + 'px';
      })
      .on('mousemove', (event) => {
        $tooltip.style.left = (event.pageX + 12) + 'px';
        $tooltip.style.top = (event.pageY - 12) + 'px';
      })
      .on('mouseout', () => { $tooltip.style.display = 'none'; })
      .on('click', (_event, d) => {
        if (d.type === 'document') {
          window.location.href = '/?doc=' + encodeURIComponent(d.id);
        }
      });

    simulation = d3.forceSimulation(data.nodes)
      .force('link', d3.forceLink(data.edges).id(d => d.id).distance(60))
      .force('charge', d3.forceManyBody().strength(-120))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(12))
      .on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);
        node
          .attr('cx', d => d.x)
          .attr('cy', d => d.y);
      });

    function dragstarted(event) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
    }
    function dragged(event) {
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }
    function dragended(event) {
      if (!event.active) simulation.alphaTarget(0);
      event.subject.fx = null;
      event.subject.fy = null;
    }
  }

  loadTopics();
  loadGraph();
<\/script>
</body>
</html>`;
}
